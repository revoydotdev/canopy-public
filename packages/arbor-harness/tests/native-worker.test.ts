import { describe, expect, it } from "vitest";

import type { CapabilitySupport } from "../src/capabilities.js";
import { NativeSessionEngine } from "../src/native-session.js";
import { NativeContextManager } from "../src/context-manager.js";
import { NativeUsageBudgetController } from "../src/usage-budget.js";
import {
  NativeHarnessWorker,
  readMemoKey,
  withTurnBudgetNote,
  type NativeApprovalPort,
  type NativeCredentialLeasePort,
  type NativeModelPort,
  type NativeToolPort,
  type NativeToolResponse,
} from "../src/native-worker.js";
import type { ExecutionPolicy, SessionStartRequest } from "../src/protocol.js";

class TestClock {
  constructor(private current = 1_700_000_000_000) {}
  now(): number { return this.current; }
  advance(milliseconds: number): void { this.current += milliseconds; }
}

const capabilities: readonly CapabilitySupport[] = [
  "streaming", "interruption", "resumption", "forking", "ephemeral_sessions", "structured_output", "tool_policy", "workspace_isolation", "approval_mediation", "usage_reporting", "artifact_capture", "remote_transport",
].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "native-reference", observed_at: "2026-08-09T00:00:00.000Z", detail: "native conformance" },
})) as readonly CapabilitySupport[];

function policy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    filesystem: "read_only",
    approvals: "always",
    tool_allow: ["read"],
    tool_deny: [],
    workspace_roots: ["/workspace"],
    max_wall_clock_ms: 100,
    max_events: 20,
    network_allowed: false,
    ambient_plugins_allowed: false,
    user_configuration_allowed: false,
    inherited_credentials_allowed: false,
    ...overrides,
  };
}

function start(sessionId: string, overrides: Partial<ExecutionPolicy> = {}): SessionStartRequest {
  return {
    session_id: sessionId,
    policy: policy(overrides),
    required_capabilities: [],
    lineage: { kind: "new" },
    ephemeral: false,
  };
}

function harness(clock = new TestClock()): NativeSessionEngine {
  return new NativeSessionEngine({ clock, capabilities });
}

const finalModel = (message = "finished"): NativeModelPort => ({
  async run() {
    return {
      text: [{ text: "working", phase: "commentary" }],
      tool_calls: [],
      usage: { input_tokens: 3, output_tokens: 2 },
      final_message: message,
    };
  },
});

describe("read memo fingerprints", () => {
  it("treats workspace roots as an authorization set, independent of order", () => {
    expect(readMemoKey("read", { path: "a.ts" }, ["/workspace", "/repo"]))
      .toBe(readMemoKey("read", { path: "a.ts" }, ["/repo", "/workspace"]));
    expect(readMemoKey("read", { path: "a.ts" }, ["/workspace"]))
      .not.toBe(readMemoKey("read", { path: "a.ts" }, ["/other"]));
  });

  it("binds reuse to session, exact path/revision input, purpose, and read operation class", () => {
    const base = { session_id: "session-a", purpose: "inspect declaration", operation_class: "read_only" as const };
    const key = readMemoKey("read", { path: "a.ts", revision: "rev-1" }, ["/repo"], base);
    expect(key).not.toBe(readMemoKey("read", { path: "a.ts", revision: "rev-1" }, ["/repo"], { ...base, session_id: "session-b" }));
    expect(key).not.toBe(readMemoKey("read", { path: "a.ts", revision: "rev-2" }, ["/repo"], base));
    expect(key).not.toBe(readMemoKey("read", { path: "a.ts", revision: "rev-1" }, ["/repo"], { ...base, purpose: "inspect tests" }));
    expect(key).not.toBe(readMemoKey("read", { path: "a.ts", revision: "rev-1" }, ["/repo"], { ...base, intent_evidence: [{ entry_id: "intent-1", provenance: { tag: "verified", cmd: "check", exit: 0, stdout_hash: "sha256:evidence" } }] }));
  });
});

const succeeded = (result_summary: string, model_output: string): NativeToolResponse => ({
  result_summary, model_output,
  evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", action_scope: { status: "not_required" } },
});
const refused = (code: string): NativeToolResponse["evidence"] => ({
  outcome: "refused", stage: "audit", code, effect: "none", action_scope: { status: "not_required" },
});

describe("NativeHarnessWorker", () => {
  it("stops at the post-response budget boundary before a model-requested tool can execute", async () => {
    const engine = harness();
    let toolExecuted = false;
    const model: NativeModelPort = {
      async run() { return {
        text: [], usage_and_cost: { tokens: { kind: "measured", input_tokens: 3, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0 }, cost: { kind: "unpriced", reason: "provider has no configured schedule" } },
        tool_calls: [{ call_id: "blocked", tool: "read", input: {}, input_summary: "read", risk: "low" }], final_message: null,
      }; },
    };
    const tool: NativeToolPort = { tool: "read", async execute() { toolExecuted = true; return succeeded("unexpected", "unexpected"); } };
    const usage_budget = new NativeUsageBudgetController({
      provider_id: "fixture", model_id: "model", limits: { max_total_tokens: 5 },
      token_estimator: { estimate: () => ({ kind: "estimated", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, authority: "test" }) },
    });
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool], usage_budget }).run({ start: start("budget"), prompt: "inspect", max_turns: 2 });
    expect(result.session.state).toBe("failed");
    expect(toolExecuted).toBe(false);
    expect(engine.observe("budget").at(-2)).toMatchObject({ kind: "diagnostic", payload: { code: "usage_budget" } });
  });

  it("rejects a host action-scope preflight before requesting approval or dispatching a high-risk tool", async () => {
    const engine = harness();
    let approvals = 0;
    let executed = false;
    const model: NativeModelPort = { async run() { return { text: [], tool_calls: [{ call_id: "scope", tool: "write", input: { path: "other" }, input_summary: "write", risk: "high" }], final_message: null }; } };
    const tool: NativeToolPort = {
      tool: "write",
      preflight: () => ({ allowed: false, code: "action_scope_path_denied", reason: "path is outside the durable action scope", evidence: refused("action_scope_path_denied") }),
      async execute() { executed = true; return succeeded("unexpected", "unexpected"); },
    };
    const approval: NativeApprovalPort = { async decide() { approvals += 1; return { approved: true, rationale: "unexpected" }; } };
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool], approvals: approval }).run({ start: start("scope", { tool_allow: ["write"] }), prompt: "write", max_turns: 1 });
    expect(result.session.state).toBe("failed");
    expect(approvals).toBe(0);
    expect(executed).toBe(false);
    expect(engine.observe("scope").map((event) => event.kind)).toEqual(["lifecycle", "tool_intent", "tool_result", "diagnostic", "terminal"]);
    expect(engine.observe("scope").find((event) => event.kind === "tool_result")).toMatchObject({ payload: { success: false, evidence: { outcome: "refused", code: "action_scope_path_denied", effect: "none" } } });
  });

  it("recovers from a host action-scope preflight denial instead of ending the session, and the refusal reaches the model's transcript", async () => {
    const engine = harness();
    const modelRequests: unknown[] = [];
    let turns = 0;
    let approvals = 0;
    let executed = false;
    const model: NativeModelPort = {
      async run(request) {
        modelRequests.push(request);
        turns += 1;
        return turns === 1
          ? { text: [], tool_calls: [{ call_id: "scope1", tool: "write", input: { path: "other" }, input_summary: "write", risk: "high" }], final_message: null }
          : { text: [{ text: "done", phase: "final" }], tool_calls: [], final_message: "done" };
      },
    };
    const tool: NativeToolPort = {
      tool: "write",
      preflight: () => ({ allowed: false, code: "action_scope_path_denied", reason: "path is outside the durable action scope", evidence: refused("action_scope_path_denied") }),
      async execute() { executed = true; return succeeded("unexpected", "unexpected"); },
    };
    const approval: NativeApprovalPort = { async decide() { approvals += 1; return { approved: true, rationale: "unexpected" }; } };

    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool], approvals: approval })
      .run({ start: start("scope-recover", { tool_allow: ["write"] }), prompt: "write", max_turns: 2 });

    expect(approvals).toBe(0);
    expect(executed).toBe(false);
    expect(result.session.state).toBe("completed");
    expect(engine.observe("scope-recover").map((event) => event.kind)).toEqual([
      "lifecycle", "tool_intent", "tool_result", "model_text", "terminal",
    ]);
    const toolResultEvent = engine.observe("scope-recover").find((event) => event.kind === "tool_result");
    expect(toolResultEvent).toMatchObject({ payload: { tool: "write", success: false, evidence: { outcome: "refused", code: "action_scope_path_denied", effect: "none" } } });
    // The defect ADR-117 closes: the specialist model must actually see the
    // refusal in its own next-turn transcript, not merely have it recorded
    // to the audit-only event stream.
    expect(modelRequests[1]).toMatchObject({
      history: [{ kind: "tool_result", tool: "write", call_id: "scope1", text: "path is outside the durable action scope" }],
    });
  });

  it("keeps a host-integrity preflight failure terminal (does not route it to history)", async () => {
    const engine = harness();
    const model: NativeModelPort = { async run() { return { text: [], tool_calls: [{ call_id: "c", tool: "write", input: { path: "other" }, input_summary: "write", risk: "high" }], final_message: null }; } };
    const tool: NativeToolPort = {
      tool: "write",
      preflight: () => ({ allowed: false, code: "missing_trusted_intent", reason: "execution refused: no trusted provenance-backed intent", evidence: refused("missing_trusted_intent") }),
      async execute() { return succeeded("unexpected", "unexpected"); },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool] })
      .run({ start: start("host-integrity", { tool_allow: ["write"], approvals: "never" }), prompt: "write", max_turns: 2 });

    expect(result.session.terminal).toEqual({ state: "failed", cause: "failed", message: "execution refused: no trusted provenance-backed intent" });
    expect(engine.observe("host-integrity").map((event) => event.kind)).toEqual(["lifecycle", "tool_intent", "tool_result", "diagnostic", "terminal"]);
  });

  it("returns an invalid path refusal to the model and dispatches only a corrected relative path", async () => {
    const engine = harness();
    let turns = 0;
    const executed: string[] = [];
    const model: NativeModelPort = { async run(request) {
      turns += 1;
      if (turns === 2) expect(request.history).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "tool_result", call_id: "bad-path", text: "path must be a non-empty relative path" }),
      ]));
      if (turns <= 2) return { text: [], tool_calls: [{ call_id: turns === 1 ? "bad-path" : "fixed-path", tool: "write",
        input: { path: turns === 1 ? "/tmp/package.json" : "package.json" }, input_summary: "write package", risk: "high" as const }], final_message: null };
      return { text: [{ text: "done", phase: "final" as const }], tool_calls: [], final_message: "done" };
    } };
    const tool: NativeToolPort = {
      tool: "write",
      preflight: (request) => (request.input as { path: string }).path === "package.json" ? { allowed: true }
        : { allowed: false, code: "path_invalid", reason: "path must be a non-empty relative path", evidence: refused("path_invalid") },
      async execute(request) { executed.push((request.input as { path: string }).path); return succeeded("written", "written"); },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool] })
      .run({ start: start("path-correction", { tool_allow: ["write"], approvals: "never" }), prompt: "write package", max_turns: 3 });
    expect(result.session.state).toBe("completed");
    expect(executed).toEqual(["package.json"]);
    expect(engine.observe("path-correction").find((event) => event.kind === "tool_result"))
      .toMatchObject({ payload: { success: false, evidence: { code: "path_invalid", effect: "none" } } });
  });

  it("returns an invalid argv refusal to the model and dispatches only the corrected command", async () => {
    const engine = harness();
    let turns = 0;
    const executed: unknown[] = [];
    const model: NativeModelPort = { async run(request) {
      turns += 1;
      if (turns === 2) expect(request.history).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "tool_result", call_id: "bad-argv", text: "argv must be a non-empty array of strings" }),
      ]));
      if (turns <= 2) return { text: [], tool_calls: [{ call_id: turns === 1 ? "bad-argv" : "fixed-argv", tool: "shell.execute",
        input: { argv: turns === 1 ? "npm test" : ["npm", "test"] }, input_summary: "run tests", risk: "high" as const }], final_message: null };
      return { text: [{ text: "done", phase: "final" as const }], tool_calls: [], final_message: "done" };
    } };
    const tool: NativeToolPort = {
      tool: "shell.execute",
      preflight: (request) => Array.isArray((request.input as { argv: unknown }).argv) ? { allowed: true }
        : { allowed: false, code: "argv_invalid", reason: "argv must be a non-empty array of strings", evidence: refused("argv_invalid") },
      async execute(request) { executed.push((request.input as { argv: unknown }).argv); return succeeded("ran", "ran"); },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool] })
      .run({ start: start("argv-correction", { tool_allow: ["shell.execute"], approvals: "never" }), prompt: "run tests", max_turns: 3 });
    expect(result.session.state).toBe("completed");
    expect(executed).toEqual([["npm", "test"]]);
    expect(engine.observe("argv-correction").find((event) => event.kind === "tool_result"))
      .toMatchObject({ payload: { success: false, evidence: { code: "argv_invalid", effect: "none" } } });
  });

  it("retries an invalid structured output in-session, feeding the reason back, and completes when the model corrects it", async () => {
    const engine = harness();
    let calls = 0;
    const model: NativeModelPort = {
      async run(request) {
        calls += 1;
        // On the retry turn the correction directive is in the prompt; produce a valid object then.
        const corrected = request.prompt.includes("structured output was rejected");
        return { text: [], tool_calls: [], final_message: "result", structured_output: corrected ? { ok: true } : { ok: false } };
      },
    };
    const contract = { schema_id: "test.v1", validate: (value: unknown) => (value as { ok?: boolean })?.ok === true ? { valid: true as const } : { valid: false as const, reason: "ok must be true" } };
    const result = await new NativeHarnessWorker({ session_engine: engine, model })
      .run({ start: start("structured"), prompt: "produce", max_turns: 4, structured_output: contract });

    expect(result.session.state).toBe("completed");
    expect(calls).toBe(2); // one rejected, one corrected
    expect(engine.observe("structured").some((event) => event.kind === "diagnostic")).toBe(true);
  });

  it("fails with structured_output_invalid only after exhausting the bounded correction retries", async () => {
    const engine = harness();
    let calls = 0;
    const model: NativeModelPort = { async run() { calls += 1; return { text: [], tool_calls: [], final_message: "x", structured_output: { ok: false } }; } };
    const contract = { schema_id: "t", validate: () => ({ valid: false as const, reason: "always bad" }) };
    const result = await new NativeHarnessWorker({ session_engine: engine, model })
      .run({ start: start("doomed-structured"), prompt: "p", max_turns: 6, structured_output: contract });

    expect(result.session.state).toBe("failed");
    expect(result.session.terminal?.message).toContain("always bad");
    expect(calls).toBe(3); // initial attempt + 2 bounded retries
  });

  it("runs a bounded model turn, records canonical events, and makes an honest claimed completion", async () => {
    const engine = harness();
    const result = await new NativeHarnessWorker({ session_engine: engine, model: finalModel() })
      .run({ start: start("success"), prompt: "solve the task", max_turns: 2 });

    expect(result).toMatchObject({ turns_started: 1, session: { state: "completed", terminal: { result: "claimed", provenance: { tag: "claimed", claimant: "native-harness-worker" } } } });
    expect(engine.observe("success").map((event) => event.kind)).toEqual(["lifecycle", "model_text", "usage", "terminal"]);
  });

  it("skips a whitespace-only commentary chunk instead of failing the session on empty context text", async () => {
    // Providers interleave whitespace-only commentary (e.g. "\n\n") with real
    // output; the context manager rejects empty text, so recording it would
    // fail the whole session. The worker must skip it and still complete.
    const model: NativeModelPort = {
      async run() {
        return {
          text: [{ text: "\n\n", phase: "commentary" }, { text: "real answer", phase: "final" }],
          tool_calls: [],
          final_message: "real answer",
        };
      },
    };
    const engine = harness();
    const result = await new NativeHarnessWorker({ session_engine: engine, model })
      .run({ start: start("ws"), prompt: "go", max_turns: 2 });

    expect(result.session.state).toBe("completed");
    // Only the non-empty "real answer" text was recorded; the "\n\n" chunk was skipped, not failed on.
    expect(engine.observe("ws").filter((event) => event.kind === "model_text")).toHaveLength(1);
  });

  it("dispatches approved tools sequentially and returns their output only to the next model request", async () => {
    const engine = harness();
    const modelRequests: unknown[] = [];
    let turns = 0;
    const model: NativeModelPort = {
      async run(request) {
        modelRequests.push(request);
        turns += 1;
        return turns === 1
          ? { text: [], tool_calls: [{ call_id: "c1", tool: "read", input: { file: "a.txt" }, input_summary: "read a file", risk: "low" }], final_message: null }
          : { text: [{ text: "done", phase: "final" }], tool_calls: [], final_message: "done" };
      },
    };
    const approvals: NativeApprovalPort = { async decide() { return { approved: true, rationale: "safe read" }; } };
    const tool: NativeToolPort = {
      tool: "read",
      async execute(request) {
        expect(request.input).toEqual({ file: "a.txt" });
        expect(request.filesystem).toBe("read_only");
        expect(request.intent_evidence).toEqual([]);
        return succeeded("read one file", "file contents");
      },
    };

    const result = await new NativeHarnessWorker({ session_engine: engine, model, approvals, tools: [tool] })
      .run({ start: start("tool"), prompt: "inspect", max_turns: 2 });

    expect(result.session.state).toBe("completed");
    expect(engine.observe("tool").map((event) => event.kind)).toEqual([
      "lifecycle", "tool_intent", "approval_requested", "approval_resolved", "tool_result", "model_text", "terminal",
    ]);
    expect(JSON.stringify(engine.observe("tool"))).not.toContain("file contents");
    expect(modelRequests[1]).toMatchObject({ history: [{ kind: "tool_result", text: "file contents", tool: "read", call_id: "c1" }] });
  });

  it("recovers from a model-requested tool outside the composed set instead of failing the session", async () => {
    const engine = harness();
    const modelRequests: unknown[] = [];
    let turns = 0;
    const model: NativeModelPort = {
      async run(request) {
        modelRequests.push(request);
        turns += 1;
        return turns === 1
          ? { text: [], tool_calls: [{ call_id: "c1", tool: "grep.search", input: null, input_summary: "provider requested uncomposed tool grep.search", risk: "low", context_refs: [], uncomposed: { available_tools: ["read"] } }], final_message: null }
          : { text: [{ text: "done", phase: "final" }], tool_calls: [], final_message: "done" };
      },
    };
    const tool: NativeToolPort = { tool: "read", async execute() { throw new Error("must never dispatch an uncomposed tool"); } };

    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool] })
      .run({ start: start("uncomposed-tool", { approvals: "never" }), prompt: "inspect", max_turns: 2 });

    expect(result.session.state).toBe("completed");
    expect(engine.observe("uncomposed-tool").map((event) => event.kind)).toEqual([
      "lifecycle", "tool_result", "model_text", "terminal",
    ]);
    const toolResultEvent = engine.observe("uncomposed-tool").find((event) => event.kind === "tool_result");
    expect(toolResultEvent).toMatchObject({ payload: { tool: "grep.search", success: false, evidence: { outcome: "refused", code: "tool_not_composed" } } });
    expect(modelRequests[1]).toMatchObject({
      history: [{ kind: "tool_result", tool: "grep.search", call_id: "c1", text: "Tool 'grep.search' is not available for this session. Available tools: read. Call a tool only through the tool-calling interface, by one of those exact names; never write tool-call syntax as text." }],
    });
  });

  it("suppresses an identical repeatable read with a compact content-addressed pointer", async () => {
    const engine = harness();
    const requests: Parameters<NativeModelPort["run"]>[0][] = [];
    let turn = 0;
    let executions = 0;
    const model: NativeModelPort = {
      async run(request) {
        requests.push(request);
        turn += 1;
        if (turn <= 2) return {
          text: [], tool_calls: [{ call_id: `read-${turn}`, tool: "read", input: turn === 1 ? { path: "a.ts", line: 1 } : { line: 1, path: "a.ts" }, input_summary: "read a.ts", risk: "low" }], final_message: null,
        };
        return { text: [], tool_calls: [], final_message: "done" };
      },
    };
    const tool: NativeToolPort = {
      tool: "read",
      recovery_protection: () => ({ effect_kind: "read_only", repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      async execute() { executions += 1; return succeeded("read", "large source text that should not be duplicated"); },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool] })
      .run({ start: start("memo-read", { approvals: "never", max_events: 30 }), prompt: "inspect", max_turns: 3 });

    expect(result.session.state).toBe("completed");
    expect(executions).toBe(1);
    expect(result.tool_economy).toEqual({ offered_calls: 2, host_executions: 1, reused_reads: 1, avoided_output_bytes: 47 });
    expect(requests[2]?.history.at(-1)?.text).toMatch(/^Unchanged duplicate read suppressed\. Reuse .*sha256:/);
    expect(requests[2]?.history.at(-1)?.text).not.toContain("large source text");
    expect(engine.observe("memo-read")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "diagnostic", payload: expect.objectContaining({ code: "tool_read_reused" }) }),
      expect.objectContaining({ kind: "tool_result", payload: expect.objectContaining({ evidence: expect.objectContaining({ code: "memoized_read" }), operation_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), reused_from_operation_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }) }),
    ]));
    const results = engine.observe("memo-read").filter((event) => event.kind === "tool_result");
    const [original, reused] = results;
    expect(original?.kind).toBe("tool_result");
    expect(reused?.kind).toBe("tool_result");
    if (original?.kind === "tool_result" && reused?.kind === "tool_result") {
      expect(original.payload.operation_id).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(reused.payload.reused_from_operation_id).toBe(original.payload.operation_id);
      expect(reused.payload.operation_id).not.toBe(original.payload.operation_id);
    }
  });

  it("keeps the original tool-output evidence on the compact pointer and the next model result", async () => {
    const engine = harness();
    const context = new NativeContextManager({ budget: { max_tokens: 4_000, reserve_output_tokens: 100 }, count_tokens: (text) => text.length });
    const source = context.evidence({ entry_id: "task-evidence", text: "inspect the fixture", provenance: { tag: "verified", cmd: "fixture-check", exit: 0, stdout_hash: "sha256:task" } });
    const requests: Parameters<NativeModelPort["run"]>[0][] = [];
    let turn = 0;
    const model: NativeModelPort = { async run(request) {
      requests.push(request);
      turn += 1;
      if (turn <= 2) return { text: [], tool_calls: [{ call_id: `read-${turn}`, tool: "read", input: { path: "a.ts", revision: "r1" }, input_summary: "inspect a.ts", risk: "low", context_refs: [{ entry_id: source.entry_id, provenance: source.provenance }] }], final_message: null };
      return { text: [], tool_calls: [], final_message: "done" };
    } };
    const tool: NativeToolPort = {
      tool: "read",
      recovery_protection: () => ({ effect_kind: "read_only", repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      async execute() { return succeeded("read", "source contents"); },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model, context, tools: [tool] })
      .run({ start: start("memo-evidence", { approvals: "never", tool_allow: ["read"], max_events: 30 }), prompt: "inspect", max_turns: 3 });

    const sourceOutput = context.snapshot().entries.find((entry) => entry.entry_id === "memo-evidence:tool:1:read-1");
    const reusedPointer = context.snapshot().entries.find((entry) => entry.entry_id === "memo-evidence:tool:2:read-2");
    expect(result.session.state).toBe("completed");
    expect(sourceOutput).toBeDefined();
    expect(reusedPointer?.evidence).toContainEqual({ entry_id: sourceOutput!.entry_id, provenance: sourceOutput!.provenance });
    expect(requests[2]?.history.at(-1)?.evidence).toEqual(expect.arrayContaining([
      { entry_id: sourceOutput!.entry_id, provenance: sourceOutput!.provenance },
      { entry_id: reusedPointer!.entry_id, provenance: reusedPointer!.provenance },
    ]));
    expect(sourceOutput?.provenance.tag).toBe("generated");
  });

  it("does not reuse a result across calls with different authority evidence", async () => {
    const engine = harness();
    const context = new NativeContextManager({ budget: { max_tokens: 4_000, reserve_output_tokens: 100 }, count_tokens: (text) => text.length });
    const firstIntent = context.evidence({ entry_id: "intent-a", text: "inspect under approved scope A", provenance: { tag: "verified", cmd: "scope-a", exit: 0, stdout_hash: "sha256:scope-a" } });
    const secondIntent = context.evidence({ entry_id: "intent-b", text: "inspect under approved scope B", provenance: { tag: "verified", cmd: "scope-b", exit: 0, stdout_hash: "sha256:scope-b" } });
    let turn = 0;
    let executions = 0;
    const model: NativeModelPort = { async run() {
      turn += 1;
      if (turn <= 2) return { text: [], tool_calls: [{ call_id: `read-${turn}`, tool: "read", input: { path: "a.ts", revision: "r1" }, input_summary: "inspect a.ts", risk: "low", context_refs: [turn === 1 ? { entry_id: firstIntent.entry_id, provenance: firstIntent.provenance } : { entry_id: secondIntent.entry_id, provenance: secondIntent.provenance }] }], final_message: null };
      return { text: [], tool_calls: [], final_message: "done" };
    } };
    const tool: NativeToolPort = {
      tool: "read",
      recovery_protection: () => ({ effect_kind: "read_only", repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      async execute() { executions += 1; return succeeded("read", `scope-specific result ${executions}`); },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model, context, tools: [tool] })
      .run({ start: start("memo-authority", { approvals: "never", tool_allow: ["read"], max_events: 30 }), prompt: "inspect", max_turns: 3 });

    expect(result.session.state).toBe("completed");
    expect(executions).toBe(2);
    expect(result.tool_economy).toMatchObject({ offered_calls: 2, host_executions: 2, reused_reads: 0 });
  });

  it("does not reuse one session's read result in another session on the same worker", async () => {
    const engine = harness();
    let turn = 0;
    let executions = 0;
    const model: NativeModelPort = { async run() {
      turn += 1;
      if (turn % 2 === 1) return { text: [], tool_calls: [{ call_id: `read-${turn}`, tool: "read", input: { path: "a.ts", revision: "same" }, input_summary: "inspect a.ts", risk: "low" }], final_message: null };
      return { text: [], tool_calls: [], final_message: "done" };
    } };
    const tool: NativeToolPort = {
      tool: "read",
      recovery_protection: () => ({ effect_kind: "read_only", repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      async execute() { executions += 1; return succeeded("read", `session result ${executions}`); },
    };
    const worker = new NativeHarnessWorker({ session_engine: engine, model, tools: [tool] });
    await worker.run({ start: start("memo-session-a", { approvals: "never", tool_allow: ["read"], max_events: 30 }), prompt: "inspect", max_turns: 2 });
    await worker.run({ start: start("memo-session-b", { approvals: "never", tool_allow: ["read"], max_events: 30 }), prompt: "inspect", max_turns: 2 });

    expect(executions).toBe(2);
    expect(engine.observe("memo-session-a").some((event) => event.kind === "diagnostic" && event.payload.code === "tool_read_reused")).toBe(false);
    expect(engine.observe("memo-session-b").some((event) => event.kind === "diagnostic" && event.payload.code === "tool_read_reused")).toBe(false);
  });

  it("invalidates read memoization before any potentially mutating operation", async () => {
    const engine = harness();
    let turn = 0;
    let reads = 0;
    const model: NativeModelPort = { async run() {
      turn += 1;
      if (turn === 1 || turn === 3) return { text: [], tool_calls: [{ call_id: `r-${turn}`, tool: "read", input: { path: "a.ts" }, input_summary: "read", risk: "low" }], final_message: null };
      if (turn === 2) return { text: [], tool_calls: [{ call_id: "w", tool: "write", input: { path: "a.ts" }, input_summary: "write", risk: "low" }], final_message: null };
      return { text: [], tool_calls: [], final_message: "done" };
    } };
    const tools: NativeToolPort[] = [
      { tool: "read", recovery_protection: () => ({ effect_kind: "read_only", repeatable: true, idempotency_key_hash: null, acknowledged_by: null }), async execute() { reads += 1; return succeeded("read", `version ${reads}`); } },
      { tool: "write", recovery_protection: () => ({ effect_kind: "file_write", repeatable: true, idempotency_key_hash: "sha256:write", acknowledged_by: null }), async execute() { return { ...succeeded("write", "written"), evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "applied", action_scope: { status: "not_required" } } }; } },
    ];
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools })
      .run({ start: start("memo-invalidate", { approvals: "never", tool_allow: ["read", "write"], max_events: 30 }), prompt: "edit", max_turns: 4 });

    expect(result.session.state).toBe("completed");
    expect(reads).toBe(2);
    expect(engine.observe("memo-invalidate").filter((event) => event.kind === "diagnostic" && event.payload.code === "tool_read_reused")).toHaveLength(0);
  });

  it("invalidates a prior result reference before observing a volatile read", async () => {
    const engine = harness();
    let turn = 0;
    let reads = 0;
    let polls = 0;
    const model: NativeModelPort = { async run() {
      turn += 1;
      if (turn === 1 || turn === 3) return { text: [], tool_calls: [{ call_id: `r-${turn}`, tool: "read", input: { path: "a.ts", revision: "r1" }, input_summary: "read", risk: "low" }], final_message: null };
      if (turn === 2) return { text: [], tool_calls: [{ call_id: "poll", tool: "poll", input: { job_id: "job-1" }, input_summary: "observe process", risk: "low" }], final_message: null };
      return { text: [], tool_calls: [], final_message: "done" };
    } };
    const tools: NativeToolPort[] = [
      { tool: "read", recovery_protection: () => ({ effect_kind: "read_only", repeatable: true, idempotency_key_hash: null, acknowledged_by: null }), async execute() { reads += 1; return succeeded("read", `read ${reads}`); } },
      { tool: "poll", recovery_protection: () => ({ effect_kind: "read_only", repeatable: false, idempotency_key_hash: null, acknowledged_by: null }), async execute() { polls += 1; return succeeded("poll", `poll ${polls}`); } },
    ];
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools })
      .run({ start: start("memo-volatile-read", { approvals: "never", tool_allow: ["read", "poll"], max_events: 30 }), prompt: "inspect", max_turns: 4 });

    expect(result.session.state).toBe("completed");
    expect(reads).toBe(2);
    expect(polls).toBe(1);
    expect(result.tool_economy).toMatchObject({ offered_calls: 3, host_executions: 3, reused_reads: 0 });
  });

  it.each([
    ["file_write", "write"],
    ["file_patch", "patch"],
    ["shell", "shell"],
    ["external", "external"],
  ] as const)("invalidates repeatable reads before a %s operation", async (effectKind, toolName) => {
    const engine = harness();
    let turn = 0;
    let reads = 0;
    const model: NativeModelPort = { async run() {
      turn += 1;
      if (turn === 1 || turn === 3) return { text: [], tool_calls: [{ call_id: `r-${turn}`, tool: "read", input: { path: "a.ts" }, input_summary: "read a.ts", risk: "low" }], final_message: null };
      if (turn === 2) return { text: [], tool_calls: [{ call_id: "mutation", tool: toolName, input: { path: "a.ts" }, input_summary: `${toolName} a.ts`, risk: "low" }], final_message: null };
      return { text: [], tool_calls: [], final_message: "done" };
    } };
    const tool: NativeToolPort = {
      tool: toolName,
      recovery_protection: () => ({ effect_kind: effectKind, repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      async execute() { return { ...succeeded(toolName, "changed"), evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "applied", action_scope: { status: "not_required" } } }; },
    };
    const read: NativeToolPort = {
      tool: "read",
      recovery_protection: () => ({ effect_kind: "read_only", repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      async execute() { reads += 1; return succeeded("read", `version ${reads}`); },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [read, tool] })
      .run({ start: start(`memo-invalidate-${toolName}`, { approvals: "never", tool_allow: ["read", toolName], max_events: 40 }), prompt: "inspect and change", max_turns: 4 });

    expect(result.session.state).toBe("completed");
    expect(reads).toBe(2);
    expect(engine.observe(`memo-invalidate-${toolName}`).some((event) => event.kind === "diagnostic" && event.payload.code === "tool_read_reused")).toBe(false);
  });

  it.each([
    [{ effect_kind: "read_only", repeatable: true }, { read_only: true, repeatable: true, mutating: false, destructive: false, open_world: false }],
    [{ effect_kind: "read_only", repeatable: false }, { read_only: true, repeatable: false, mutating: false, destructive: false, open_world: false }],
    [{ effect_kind: "file_write", repeatable: true }, { read_only: false, repeatable: true, mutating: true, destructive: true, open_world: false }],
    [{ effect_kind: "file_patch", repeatable: false }, { read_only: false, repeatable: false, mutating: true, destructive: true, open_world: false }],
    [{ effect_kind: "shell", repeatable: false }, { read_only: false, repeatable: false, mutating: true, destructive: true, open_world: true }],
    [{ effect_kind: "external", repeatable: false }, { read_only: false, repeatable: false, mutating: true, destructive: true, open_world: true }],
  ] as const)("annotates a %j tool intent from the host declaration", async (declared, expected) => {
    const engine = harness();
    let turn = 0;
    const model: NativeModelPort = { async run() {
      turn += 1;
      if (turn === 1) return { text: [], tool_calls: [{ call_id: "c", tool: "t", input: { path: "a.ts" }, input_summary: "t a.ts", risk: "low" }], final_message: null };
      return { text: [], tool_calls: [], final_message: "done" };
    } };
    const tool: NativeToolPort = {
      tool: "t",
      recovery_protection: () => ({ ...declared, idempotency_key_hash: null, acknowledged_by: null }),
      async execute() { return succeeded("t", "ok"); },
    };
    await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool] })
      .run({ start: start("annotate", { approvals: "never", tool_allow: ["t"], max_events: 30 }), prompt: "go", max_turns: 2 });

    const intent = engine.observe("annotate").find((event) => event.kind === "tool_intent");
    expect(intent?.kind === "tool_intent" ? intent.payload.annotations : undefined).toEqual({ effect_kind: declared.effect_kind, ...expected, ownership: "session" });
  });

  it("annotates a tool with no recovery declaration as unknown, mutating, destructive, and open-world", async () => {
    const engine = harness();
    let turn = 0;
    const model: NativeModelPort = { async run() {
      turn += 1;
      if (turn === 1) return { text: [], tool_calls: [{ call_id: "c", tool: "t", input: null, input_summary: "t", risk: "low" }], final_message: null };
      return { text: [], tool_calls: [], final_message: "done" };
    } };
    const tool: NativeToolPort = { tool: "t", async execute() { return succeeded("t", "ok"); } };
    await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool] })
      .run({ start: start("annotate-unknown", { approvals: "never", tool_allow: ["t"], max_events: 30 }), prompt: "go", max_turns: 2 });

    const intent = engine.observe("annotate-unknown").find((event) => event.kind === "tool_intent");
    expect(intent?.kind === "tool_intent" ? intent.payload.annotations : undefined).toEqual({
      effect_kind: "unknown", read_only: false, repeatable: false, mutating: true, destructive: true, open_world: true, ownership: "session",
    });
  });

  it("links a reused read to the prior context entry and never links a host execution", async () => {
    const engine = harness();
    const requests: Parameters<NativeModelPort["run"]>[0][] = [];
    let turn = 0;
    const model: NativeModelPort = { async run(request) {
      requests.push(request);
      turn += 1;
      if (turn <= 2) return { text: [], tool_calls: [{ call_id: `read-${turn}`, tool: "read", input: { path: "a.ts" }, input_summary: "read a.ts", risk: "low" }], final_message: null };
      return { text: [], tool_calls: [], final_message: "done" };
    } };
    const tool: NativeToolPort = {
      tool: "read",
      recovery_protection: () => ({ effect_kind: "read_only", repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      async execute() { return succeeded("read", "source text"); },
    };
    await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool] })
      .run({ start: start("reuse-link", { approvals: "never", max_events: 30 }), prompt: "inspect", max_turns: 3 });

    const results = engine.observe("reuse-link").filter((event) => event.kind === "tool_result");
    expect(results).toHaveLength(2);
    const [original, reused] = results;
    if (original?.kind !== "tool_result" || reused?.kind !== "tool_result") throw new Error("expected two tool results");
    expect(original.payload).not.toHaveProperty("reused_context_entry_id");
    expect(original.payload).not.toHaveProperty("reused_from_operation_id");
    expect(reused.payload.reused_from_operation_id).toBe(original.payload.operation_id);
    const entryId = reused.payload.reused_context_entry_id;
    expect(typeof entryId).toBe("string");
    expect(entryId).not.toBe("");
    // The id is content-free but is the very reference the model was handed.
    expect(requests[2]?.history.at(-1)?.text).toContain(`Reuse ${entryId}`);
    expect(JSON.stringify(reused.payload)).not.toContain("source text");
  });

  it("enforces immutable denial before a tool port or approval port can run", async () => {
    const engine = harness();
    let executed = false;
    const model: NativeModelPort = { async run() { return { text: [], tool_calls: [{ call_id: "c", tool: "read", input: null, input_summary: "read", risk: "low" }], final_message: null }; } };
    const tool: NativeToolPort = { tool: "read", async execute() { executed = true; return succeeded("unexpected", "unexpected"); } };

    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool] })
      .run({ start: start("denied", { tool_deny: ["read"] }), prompt: "inspect", max_turns: 1 });

    expect(executed).toBe(false);
    expect(result.session.terminal).toEqual({ state: "failed", cause: "failed", message: "requested tool is denied by immutable policy" });
    expect(engine.observe("denied").map((event) => event.kind)).toEqual(["lifecycle", "tool_result", "diagnostic", "terminal"]);
  });

  it("records a denied approval and does not dispatch the tool", async () => {
    const engine = harness();
    let executed = false;
    const model: NativeModelPort = { async run() { return { text: [], tool_calls: [{ call_id: "c", tool: "read", input: null, input_summary: "read", risk: "high" }], final_message: null }; } };
    const tool: NativeToolPort = { tool: "read", async execute() { executed = true; return succeeded("unexpected", "unexpected"); } };
    const approvals: NativeApprovalPort = { async decide() { return { approved: false, rationale: "human declined" }; } };

    // ADR-117 §1: approval denial no longer ends the session on this turn.
    // With max_turns: 1 the worker still has nowhere to go after the
    // recoverable refusal (no further turn budget), so it hits the
    // pre-existing turn-limit boundary rather than the removed
    // `this.failed(..., "approval_denied", ...)` call.
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool], approvals })
      .run({ start: start("approval"), prompt: "inspect", max_turns: 1 });

    expect(executed).toBe(false);
    expect(result.session.terminal).toEqual({ state: "failed", cause: "failed", message: "native worker turn limit exceeded" });
    expect(engine.observe("approval").map((event) => event.kind)).toEqual(["lifecycle", "tool_intent", "approval_requested", "approval_resolved", "tool_result", "diagnostic", "terminal"]);
    const toolResultEvent = engine.observe("approval").find((event) => event.kind === "tool_result");
    expect(toolResultEvent).toMatchObject({ payload: { tool: "read", success: false, evidence: { outcome: "refused", code: "approval_denied" } } });
  });

  it("recovers from a denied approval instead of ending the session, and the refusal reaches the model's transcript", async () => {
    const engine = harness();
    const modelRequests: unknown[] = [];
    let turns = 0;
    let executed = false;
    const model: NativeModelPort = {
      async run(request) {
        modelRequests.push(request);
        turns += 1;
        return turns === 1
          ? { text: [], tool_calls: [{ call_id: "c1", tool: "read", input: null, input_summary: "read", risk: "high" }], final_message: null }
          : { text: [{ text: "done", phase: "final" }], tool_calls: [], final_message: "done" };
      },
    };
    const tool: NativeToolPort = { tool: "read", async execute() { executed = true; return succeeded("unexpected", "unexpected"); } };
    const approvals: NativeApprovalPort = { async decide() { return { approved: false, rationale: "human declined" }; } };

    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool], approvals })
      .run({ start: start("approval-recover"), prompt: "inspect", max_turns: 2 });

    expect(executed).toBe(false);
    expect(result.session.state).toBe("completed");
    expect(engine.observe("approval-recover").map((event) => event.kind)).toEqual([
      "lifecycle", "tool_intent", "approval_requested", "approval_resolved", "tool_result", "model_text", "terminal",
    ]);
    const toolResultEvent = engine.observe("approval-recover").find((event) => event.kind === "tool_result");
    expect(toolResultEvent).toMatchObject({ payload: { tool: "read", success: false, evidence: { outcome: "refused", code: "approval_denied" } } });
    // The operator's own rationale rides along: a model told only "not approved"
    // has nothing to adapt toward and re-proposes the same action.
    expect(modelRequests[1]).toMatchObject({
      history: [{ kind: "tool_result", tool: "read", call_id: "c1", text: "tool action was not approved: human declined" }],
    });
  });

  it("does not re-ask the operator for an approval they already denied", async () => {
    const engine = harness();
    const approvalCalls: string[] = [];
    let turns = 0;
    let executed = false;
    // A model that never adapts: it re-proposes the identical denied call every
    // turn. Before the denial was recorded, each turn put the same settled
    // question to the operator again.
    const model: NativeModelPort = {
      async run() {
        turns += 1;
        return { text: [], tool_calls: [{ call_id: `c${turns}`, tool: "read", input: null, input_summary: "read", risk: "high" }], final_message: null };
      },
    };
    const tool: NativeToolPort = { tool: "read", async execute() { executed = true; return succeeded("unexpected", "unexpected"); } };
    const approvals: NativeApprovalPort = { async decide(request) { approvalCalls.push(request.request_id); return { approved: false, rationale: "human declined" }; } };

    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool], approvals })
      .run({ start: start("approval-memo"), prompt: "inspect", max_turns: 4 });

    // Asked exactly once across four turns; every later turn is refused from the
    // recorded decision, and the session still terminates on the turn budget.
    expect(approvalCalls).toHaveLength(1);
    expect(turns).toBe(4);
    expect(executed).toBe(false);
    expect(result.session.terminal).toMatchObject({ state: "failed" });
    expect(engine.observe("approval-memo").filter((event) => event.kind === "approval_requested")).toHaveLength(1);
    // One fewer than `turns`: the last turn trips the turn limit before it
    // records a result, the same boundary the denied-approval test above hits.
    expect(engine.observe("approval-memo").filter((event) => event.kind === "tool_result")).toHaveLength(3);
  });

  it("rejects malformed host evidence instead of manufacturing a successful tool result", async () => {
    const engine = harness();
    const model: NativeModelPort = { async run() { return { text: [], tool_calls: [{ call_id: "malformed", tool: "read", input: {}, input_summary: "read", risk: "low" }], final_message: null }; } };
    const tool: NativeToolPort = {
      tool: "read",
      async execute() {
        return { result_summary: "claimed success", model_output: "ignored", evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "none", action_scope: { status: "bound", scope_id_hash: "sha256:not-a-real-hash", provenance_tag: "forged" } } } as never;
      },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool], approvals: { async decide() { return { approved: true, rationale: "fixture" }; } } }).run({ start: start("malformed"), prompt: "inspect", max_turns: 1 });
    expect(result.session.terminal).toMatchObject({ cause: "failed", message: "tool port returned an invalid response" });
    expect(engine.observe("malformed").find((event) => event.kind === "tool_result")).toMatchObject({ payload: { success: false, evidence: { outcome: "failed", code: "invalid_tool_response", effect: "unknown" } } });
  });

  it("applies always, on_risk, and never approval policy without a mutable escape hatch", async () => {
    const call = (risk: "low" | "high"): NativeModelPort => ({
      async run() { return { text: [], tool_calls: [{ call_id: "c", tool: "read", input: null, input_summary: "read", risk }], final_message: null }; },
    });
    const tool: NativeToolPort = { tool: "read", async execute() { return succeeded("read", "contents"); } };

    const lowEngine = harness();
    const low = await new NativeHarnessWorker({ session_engine: lowEngine, model: call("low"), tools: [tool] })
      .run({ start: start("low", { approvals: "on_risk" }), prompt: "go", max_turns: 1 });
    expect(low.session.terminal).toMatchObject({ cause: "failed", message: "native worker turn limit exceeded" });
    expect(lowEngine.observe("low").map((event) => event.kind)).not.toContain("approval_requested");

    const highEngine = harness();
    const high = await new NativeHarnessWorker({ session_engine: highEngine, model: call("high"), tools: [tool] })
      .run({ start: start("high", { approvals: "on_risk" }), prompt: "go", max_turns: 1 });
    expect(high.session.terminal).toMatchObject({ cause: "failed", message: "tool action requires an approval port" });
    expect(highEngine.observe("high").map((event) => event.kind)).toContain("approval_requested");

    const neverEngine = harness();
    const never = await new NativeHarnessWorker({ session_engine: neverEngine, model: call("high"), tools: [tool] })
      .run({ start: start("never", { approvals: "never" }), prompt: "go", max_turns: 1 });
    expect(never.session.terminal).toMatchObject({ cause: "failed", message: "native worker turn limit exceeded" });
    expect(neverEngine.observe("never").map((event) => event.kind)).not.toContain("approval_requested");
  });

  it("cooperatively settles cancellation without recording a late model result", async () => {
    const engine = harness();
    const controller = new AbortController();
    const model: NativeModelPort = {
      async run() {
        controller.abort();
        return { text: [{ text: "late", phase: "final" }], tool_calls: [], final_message: "late" };
      },
    };

    const result = await new NativeHarnessWorker({ session_engine: engine, model })
      .run({ start: start("cancel"), prompt: "stop", max_turns: 1, signal: controller.signal });

    expect(result.session.terminal).toEqual({ state: "interrupted", cause: "interrupted", message: "execution aborted" });
    expect(engine.observe("cancel").map((event) => event.kind)).toEqual(["lifecycle", "interrupt_requested", "terminal"]);
  });

  it("turns provider and tool exceptions into secret-free operational failures, while preserving a bounded, redacted description of the real error", async () => {
    const providerEngine = harness();
    const providerFailure = await new NativeHarnessWorker({ session_engine: providerEngine, model: { async run() { throw new Error("provider rejected request: secret=sk-live-abc123"); } } })
      .run({ start: start("provider"), prompt: "go", max_turns: 1 });
    // The failure evidence now names the real error's class and a redacted
    // copy of its message, rather than the opaque "model port failed" that
    // previously discarded every provider exception.
    expect(providerFailure.session.terminal).toEqual({ state: "failed", cause: "failed", message: "model port failed: Error: provider rejected request: secret=[REDACTED]" });
    expect(JSON.stringify(providerEngine.observe("provider"))).not.toContain("sk-live-abc123");

    const toolEngine = harness();
    const toolFailure = await new NativeHarnessWorker({
      session_engine: toolEngine,
      model: { async run() { return { text: [], tool_calls: [{ call_id: "c", tool: "read", input: null, input_summary: "read", risk: "low" }], final_message: null }; } },
      approvals: { async decide() { return { approved: true, rationale: "ok" }; } },
      tools: [{ tool: "read", async execute() { throw new Error("tool secret"); } }],
    }).run({ start: start("tool-failure"), prompt: "go", max_turns: 1 });
    expect(toolFailure.session.terminal).toEqual({ state: "failed", cause: "failed", message: "tool port failed" });
    expect(JSON.stringify(toolEngine.observe("tool-failure"))).not.toContain("tool secret");
  });

  it("bounds an oversized model error message and still redacts it, while keeping the adapter-declared error kind", async () => {
    const engine = harness();
    const overlong = "x".repeat(300);
    const model: NativeModelPort = {
      async run() { throw Object.assign(new Error(`upstream failure token=${overlong}`), { name: "FakeAdapterError", kind: "protocol" }); },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model }).run({ start: start("model-error-detail"), prompt: "go", max_turns: 1 });
    expect(result.session.terminal).toEqual({ state: "failed", cause: "failed", message: "model port failed: FakeAdapterError (protocol): upstream failure token=[REDACTED]" });
    expect(JSON.stringify(engine.observe("model-error-detail"))).not.toContain(overlong);
  });

  it("still refuses a model response that combines tool calls with a genuine final answer, even though commentary text may now accompany tool calls", async () => {
    const engine = harness();
    const model: NativeModelPort = {
      async run() { return { text: [{ text: "note", phase: "commentary" }], tool_calls: [{ call_id: "c", tool: "read", input: {}, input_summary: "read", risk: "low" }], final_message: "done" }; },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model }).run({ start: start("final-and-tools"), prompt: "go", max_turns: 1 });
    expect(result.session.terminal).toMatchObject({ cause: "failed", message: "model response combined final output and tool calls" });
  });

  it("honors event and wall-clock limits before another external action", async () => {
    const eventEngine = harness();
    const limited = await new NativeHarnessWorker({ session_engine: eventEngine, model: finalModel() })
      .run({ start: start("events", { max_events: 3 }), prompt: "go", max_turns: 1 });
    expect(limited.session.terminal).toMatchObject({ cause: "event_limit" });
    expect(eventEngine.observe("events").map((event) => event.kind)).toEqual(["lifecycle", "model_text", "terminal"]);

    const clock = new TestClock();
    const wallEngine = harness(clock);
    const wallLimited = await new NativeHarnessWorker({
      session_engine: wallEngine,
      model: { async run() { clock.advance(101); return { text: [{ text: "late", phase: "final" }], tool_calls: [], final_message: "late" }; } },
    }).run({ start: start("wall"), prompt: "go", max_turns: 1 });
    expect(wallLimited.session.terminal).toMatchObject({ cause: "wall_clock_limit" });
  });

  it("keeps an observer-terminalized session failed when finalization arrives late", async () => {
    const clock = new TestClock();
    const engine = harness(clock);
    let verificationCalls = 0;
    const result = await new NativeHarnessWorker({
      session_engine: engine,
      model: { async run() { return { text: [], tool_calls: [], final_message: "late connector result" }; } },
      governed_completion: {
        async verify() {
          verificationCalls += 1;
          clock.advance(101);
          // Mirrors a concurrent live-session poll enforcing the deadline
          // while governed finalization is in progress.
          expect(engine.inspect("late-finalization").terminal).toMatchObject({ cause: "wall_clock_limit" });
          return { message: "must not promote", provenance: { tag: "verified", cmd: "synthetic", exit: 0, stdout_hash: "sha256:test" } };
        },
      },
    }).run({ start: start("late-finalization"), prompt: "go", max_turns: 1 });

    expect(verificationCalls).toBe(1);
    expect(result.session.terminal).toEqual({ state: "failed", cause: "wall_clock_limit", message: "session wall-clock limit exceeded" });
    expect(result.session.terminal).not.toHaveProperty("result");
    expect(engine.observe("late-finalization").map((event) => event.kind)).toEqual(["lifecycle", "terminal"]);
  });

  it("uses opaque credential injection without exposing the lease or secret to protocol data", async () => {
    const secret = "not-for-events";
    const credential: NativeCredentialLeasePort = {
      lease_id: "lease-1",
      async inject(recipient) { return recipient(secret); },
    };
    const engine = harness();
    const model: NativeModelPort = {
      async run(_request, injected) {
        expect(injected).toBe(secret);
        return { text: [], tool_calls: [], final_message: "done" };
      },
    };

    const result = await new NativeHarnessWorker({ session_engine: engine, model, credential })
      .run({ start: start("credential"), prompt: "go", max_turns: 1 });

    const visible = JSON.stringify({ result, events: engine.observe("credential") });
    expect(visible).not.toContain(secret);
    expect(visible).not.toContain("lease-1");
  });

  it("uses declarative execution profiles to restrict tools while passing caller-owned governed context", async () => {
    const engine = harness();
    const model: NativeModelPort = {
      async run(request) {
        expect(request.profile).toEqual({ role_id: "documentation-writer" });
        expect(request.governed_context).toMatchObject({
          instructions: [{ instruction_id: "style", text: "write concise reference docs", provenance: { tag: "critic_approved" } }],
          artifacts: [{ artifact_id: "adr-1", content: "decision record", provenance: { tag: "verified" } }],
        });
        return { text: [], tool_calls: [], final_message: "documented" };
      },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model }).run({
      start: start("profile", { tool_allow: ["read", "build"] }),
      prompt: "write docs",
      max_turns: 1,
      profile: {
        role_id: "documentation-writer",
        allowed_tools: ["read"],
        allowed_capabilities: [],
      },
      governed_context: {
        instructions: [{ instruction_id: "style", text: "write concise reference docs", provenance: { tag: "critic_approved", critic: "lenticel", rationale: "approved" } }],
        artifacts: [{ artifact_id: "adr-1", media_type: "text/markdown", content: "decision record", provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test" } }],
      },
    });

    expect(result.session.policy.tool_allow).toEqual(["read"]);
    expect(JSON.stringify(engine.observe("profile"))).not.toContain("write concise reference docs");
    expect(JSON.stringify(engine.observe("profile"))).not.toContain("decision record");
  });

  it("rejects a profile that asks for a capability outside its own governed boundary", async () => {
    await expect(new NativeHarnessWorker({ session_engine: harness(), model: finalModel() }).run({
      start: start("bad-profile"),
      prompt: "go",
      max_turns: 1,
      profile: {
        role_id: "architect",
        allowed_tools: [],
        allowed_capabilities: [],
        required_capabilities: [{ capability: "structured_output", minimum_grade: "native" }],
      },
    })).rejects.toThrow("profile does not allow required capability");
  });

  it("accepts verified completion only through the injected governed boundary", async () => {
    const engine = harness();
    const result = await new NativeHarnessWorker({
      session_engine: engine,
      model: finalModel("candidate"),
      governed_completion: {
        async verify() {
          return { message: "verified candidate", provenance: { tag: "verified", cmd: "synthetic check", exit: 0, stdout_hash: "sha256:test" } };
        },
      },
    }).run({ start: start("verified"), prompt: "go", max_turns: 1 });
    expect(result.session.terminal).toMatchObject({ result: "verified", message: "verified candidate", provenance: { tag: "verified" } });
  });

  it("consumes provider-neutral stream deltas, validates caller-owned structured output, and preserves context-to-intent evidence", async () => {
    const engine = harness();
    const context = new NativeContextManager({ budget: { max_tokens: 80, reserve_output_tokens: 10 }, count_tokens: (text) => text.length });
    const source = context.evidence({ entry_id: "source", text: "verified repository evidence", provenance: { tag: "verified", cmd: "check", exit: 0, stdout_hash: "sha256:source" } });
    let toolRan = false;
    const worker = new NativeHarnessWorker({
      session_engine: engine,
      context,
      model: {
        identity: { provider_id: "synthetic", model_id: "stream-test", revision: null, capabilities: [{ capability: "streaming", available: true, observed_at: "2026-08-09T00:00:00.000Z", detail: "test stream" }] },
        async run() { throw new Error("stream must be preferred"); },
        async *stream(request) {
          if (request.turn === 1) {
            yield { kind: "tool_call", call_id: "tool-1", tool: "read", input: {}, input_summary: "read evidence", risk: "low", context_refs: [{ entry_id: source.entry_id, provenance: source.provenance }] } as const;
          } else {
            yield { kind: "final", message: "done", structured_output: { status: "ok" } } as const;
          }
        },
      },
      tools: [{ tool: "read", async execute() { toolRan = true; return succeeded("read", "contents"); } }],
      approvals: { async decide() { return { approved: true, rationale: "safe" }; } },
    });
    const result = await worker.run({
      start: start("stream", { max_events: 20 }), prompt: "go", max_turns: 2,
      structured_output: { schema_id: "result-v1", validate: (value) => (value as { status?: string }).status === "ok" ? { valid: true } : { valid: false, reason: "status missing" } },
    });

    expect(toolRan).toBe(true);
    expect(result.session.state).toBe("completed");
    expect(result.structured_output).toEqual({ status: "ok" });
    expect(result.model_identity).toMatchObject({ provider_id: "synthetic", capabilities: [{ capability: "streaming", available: true }] });
    expect(engine.observe("stream").find((event) => event.kind === "tool_intent")).toMatchObject({ payload: { context_refs: [{ entry_id: "source", provenance: { tag: "verified" } }] } });
  });

  it("passes immutable filesystem isolation and content-free intent evidence to tool hosts", async () => {
    const engine = harness();
    const context = new NativeContextManager({ budget: { max_tokens: 80, reserve_output_tokens: 10 }, count_tokens: (text) => text.length });
    const source = context.evidence({ entry_id: "source", text: "fact", provenance: { tag: "verified", cmd: "check", exit: 0, stdout_hash: "sha256:fact" } });
    const result = await new NativeHarnessWorker({
      session_engine: engine,
      context,
      model: { async run() { return { text: [], tool_calls: [{ call_id: "call", tool: "read", input: {}, input_summary: "read", risk: "low", context_refs: [{ entry_id: source.entry_id, provenance: source.provenance }] }], final_message: null }; } },
      tools: [{ tool: "read", async execute(request) {
        expect(request.filesystem).toBe("isolated");
        expect(request.intent_evidence).toEqual([{ entry_id: "source", provenance: source.provenance }]);
        return succeeded("read", "result");
      } }],
      approvals: { async decide() { return { approved: true, rationale: "ok" }; } },
    }).run({ start: start("tool-policy", { filesystem: "isolated" }), prompt: "go", max_turns: 1 });
    expect(result.session.terminal).toMatchObject({ cause: "failed", message: "native worker turn limit exceeded" });
  });

  it("turns typed human handoff into context without exposing its answer in canonical events", async () => {
    const engine = harness();
    let turn = 0;
    const worker = new NativeHarnessWorker({
      session_engine: engine,
      context: new NativeContextManager({ budget: { max_tokens: 80, reserve_output_tokens: 10 }, count_tokens: (text) => text.length }),
      model: { async run() { turn += 1; return turn === 1
        ? { text: [], tool_calls: [], final_message: null, human_input_request: { request_id: "question", question: "Which target?", reason: "ambiguous scope", evidence: [] } }
        : { text: [], tool_calls: [], final_message: "finished" }; } },
      human_input: { async request() { return { kind: "submitted", response: "use the internal target", provenance: { tag: "claimed", claimant: "operator" } }; } },
    });
    const result = await worker.run({ start: start("human"), prompt: "go", max_turns: 2 });
    expect(result.session.state).toBe("completed");
    expect(JSON.stringify(engine.observe("human"))).not.toContain("internal target");
  });

  it("settles a deferred governed human handoff without inventing an answer or retaining a hidden wait", async () => {
    const engine = harness();
    const worker = new NativeHarnessWorker({
      session_engine: engine,
      model: { async run() { return { text: [], tool_calls: [], final_message: null, human_input_request: { request_id: "scope", question: "Which scope should run?", reason: "scope is ambiguous", evidence: [] } }; } },
      human_input: { async request() { return { kind: "handoff", reason: "campaign governor will record the interview" }; } },
    });

    const result = await worker.run({ start: start("governed-human"), prompt: "go", max_turns: 2 });

    expect(result.session).toMatchObject({ state: "completed", terminal: { result: "claimed", message: "human input handoff pending campaign governance" } });
    expect(engine.observe("governed-human")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "diagnostic", payload: expect.objectContaining({ code: "human_input_requested" }) }),
      expect.objectContaining({ kind: "diagnostic", payload: expect.objectContaining({ code: "human_input_handed_off" }) }),
    ]));
  });

  it("compacts context once the configured mid-session threshold is crossed, surfacing real evidence in the result and event stream", async () => {
    const engine = harness();
    const context = new NativeContextManager({
      budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length,
      compaction: { threshold_fraction: 0.5, preview_chars: 8 },
    });
    const gen = (id: string) => ({ tag: "generated" as const, generator: "t", input_hash: id });
    const big = (c: string) => c.repeat(100);
    // Seeded well past the 180-char threshold before the worker's first turn even runs.
    context.generate({ entry_id: "old-1", text: big("A"), provenance: gen("old-1") });
    context.generate({ entry_id: "old-2", text: big("B"), provenance: gen("old-2") });
    context.generate({ entry_id: "old-3", text: big("C"), provenance: gen("old-3") });
    context.generate({ entry_id: "old-4", text: big("D"), provenance: gen("old-4") });
    context.generate({ entry_id: "recent-1", text: big("E"), provenance: gen("recent-1") });

    const result = await new NativeHarnessWorker({ session_engine: engine, context, model: finalModel() }).run({ start: start("compact-turn"), prompt: "go", max_turns: 1 });

    expect(result.session.state).toBe("completed");
    expect(result.context_compactions).toHaveLength(1);
    expect(result.context_compactions[0]).toMatchObject({ method: "structural_fold", anchor_entry_id: "compact-turn:compact:1" });
    expect(result.context_compactions[0]!.post_tokens).toBeLessThan(result.context_compactions[0]!.pre_tokens);
    expect(engine.observe("compact-turn")).toContainEqual(expect.objectContaining({ kind: "diagnostic", payload: expect.objectContaining({ code: "context_compacted" }) }));
    // Raw folded entries remain durable even though the projection shrank.
    expect(context.has("old-1")).toBe(true);
  });

  it("emits an honest typed skip event — never a fabricated compaction — when the anchor cannot actually be captured", async () => {
    const engine = harness();
    const context = new NativeContextManager({
      budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length,
      compaction: { threshold_fraction: 0.5 },
    });
    const gen = (id: string) => ({ tag: "generated" as const, generator: "t", input_hash: id });
    const big = (c: string) => c.repeat(100);
    context.generate({ entry_id: "old-1", text: big("A"), provenance: gen("old-1") });
    context.generate({ entry_id: "old-2", text: big("B"), provenance: gen("old-2") });
    context.generate({ entry_id: "recent-1", text: big("C"), provenance: gen("recent-1") });
    // Collides with the exact compaction_id the worker will attempt on turn 1.
    context.generate({ entry_id: "compact-skip:compact:1", text: "collides", provenance: gen("collision") });

    const result = await new NativeHarnessWorker({ session_engine: engine, context, model: finalModel() }).run({ start: start("compact-skip"), prompt: "go", max_turns: 1 });

    expect(result.session.state).toBe("completed");
    expect(result.context_compactions).toHaveLength(0);
    expect(engine.observe("compact-skip")).toContainEqual(expect.objectContaining({ kind: "diagnostic", payload: expect.objectContaining({ code: "context_compaction_skipped" }) }));
  });

  it("uses bounded, abort-aware deterministic backoff for retryable inference failures", async () => {
    const engine = harness();
    const waits: number[] = [];
    let attempts = 0;
    const worker = new NativeHarnessWorker({
      session_engine: engine,
      model: {
        async run() {
          attempts += 1;
          if (attempts < 3) throw new Error("retryable fixture");
          return { text: [], tool_calls: [], final_message: "recovered" };
        },
        classify_failure: () => ({ kind: "retryable", reason: "fixture", retry_after_ms: attempts === 1 ? 50 : null }),
      },
      retry_delay: { async wait(delayMs) { waits.push(delayMs); return "elapsed"; } },
    });

    const result = await worker.run({
      start: start("retry"), prompt: "go", max_turns: 1,
      retry_policy: { max_model_attempts_per_turn: 3, initial_delay_ms: 20, max_delay_ms: 50 },
    });

    expect(result.session.terminal).toMatchObject({ result: "claimed", message: "recovered" });
    expect(waits).toEqual([50, 40]);
    expect(engine.observe("retry").filter((event) => event.kind === "diagnostic")).toHaveLength(2);
    expect(engine.observe("retry").filter((event) => event.kind === "diagnostic").map((event) => event.payload))
      .toEqual([
        expect.objectContaining({ retry: { attempt: 1, max_attempts: 3, delay_ms: 50, failure_kind: "unknown" } }),
        expect.objectContaining({ retry: { attempt: 2, max_attempts: 3, delay_ms: 40, failure_kind: "unknown" } }),
      ]);
  });

  it("settles interruption instead of issuing a retry after an abort-aware delay", async () => {
    const engine = harness();
    const controller = new AbortController();
    const worker = new NativeHarnessWorker({
      session_engine: engine,
      model: {
        async run() { throw new Error("retryable fixture"); },
        classify_failure: () => ({ kind: "retryable", reason: "fixture", retry_after_ms: null }),
      },
      retry_delay: { async wait() { controller.abort(); return "aborted"; } },
    });

    const result = await worker.run({
      start: start("retry-interrupt"), prompt: "go", max_turns: 1, signal: controller.signal,
      retry_policy: { max_model_attempts_per_turn: 2, initial_delay_ms: 1, max_delay_ms: 1 },
    });

    expect(result.session.terminal).toMatchObject({ state: "interrupted", cause: "interrupted" });
  });

  it("does not issue a retry after the retry diagnostic has exhausted the event budget", async () => {
    const engine = harness();
    let attempts = 0;
    const worker = new NativeHarnessWorker({
      session_engine: engine,
      model: {
        async run() { attempts += 1; throw new Error("retryable fixture"); },
        classify_failure: () => ({ kind: "retryable", reason: "fixture", retry_after_ms: null }),
      },
      retry_delay: { async wait() { throw new Error("wait must not run after terminal event limit"); } },
    });

    const result = await worker.run({
      start: start("retry-event-limit", { max_events: 2 }), prompt: "go", max_turns: 1,
      retry_policy: { max_model_attempts_per_turn: 2, initial_delay_ms: 1, max_delay_ms: 1 },
    });

    expect(attempts).toBe(1);
    expect(result.session.terminal).toMatchObject({ cause: "event_limit" });
  });

  it("mechanically reserves the final multi-turn exchange for a no-tools response", async () => {
    const engine = harness();
    const advertised: Array<boolean | undefined> = [];
    let executions = 0;
    const result = await new NativeHarnessWorker({
      session_engine: engine,
      model: { async run(request) {
        advertised.push(request.tools_allowed);
        return { text: [], tool_calls: [{ call_id: `call-${request.turn}`, tool: "read", input: {}, input_summary: "read", risk: "low" }], final_message: null };
      } },
      tools: [{ tool: "read", async execute() { executions += 1; return succeeded("read", "contents"); } }],
    }).run({ start: start("reserved-finalization", { approvals: "never" }), prompt: "finish", max_turns: 2 });

    expect(advertised).toEqual([true, false]);
    expect(executions).toBe(1);
    expect(result.session.terminal).toMatchObject({ cause: "failed", message: "model adapter returned a tool call during the reserved final response turn" });
    expect(engine.observe("reserved-finalization").find((event) => event.kind === "diagnostic")).toMatchObject({ payload: { code: "finalization_protocol_violation" } });
  });

  it("keeps every turn no-tools when the session capability forbids model tools", async () => {
    const engine = harness();
    const advertised: Array<boolean | undefined> = [];
    const result = await new NativeHarnessWorker({
      session_engine: engine,
      model_tools_allowed: false,
      model: { async run(request) {
        advertised.push(request.tools_allowed);
        return { text: [], tool_calls: [{ call_id: "forbidden", tool: "read", input: {}, input_summary: "read", risk: "low" }], final_message: null };
      } },
      tools: [{ tool: "read", async execute() { throw new Error("a no-tools request must fail before host dispatch"); } }],
    }).run({ start: start("session-no-tools", { approvals: "never" }), prompt: "inspect", max_turns: 2 });

    expect(advertised).toEqual([false]);
    expect(result.session.terminal).toMatchObject({ cause: "failed", message: "model adapter returned a tool call while the session capability was no-tools" });
    expect(engine.observe("session-no-tools").find((event) => event.kind === "diagnostic")).toMatchObject({ payload: { code: "tool_capability_violation" } });
  });

  // ADR-109 O1/O3: the serial `for` loop at native-worker.ts's old
  // 594-599 (now `dispatchToolCalls`/`dispatchWaves`) awaited every tool
  // call in a turn one at a time. These cases prove real concurrent
  // dispatch, that a high-risk call is serialized relative to its
  // wave-mates, and that `tool_result` order in `history` still matches
  // `response.tool_calls`' original order regardless of completion order.
  function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it("dispatches independent low-risk tool calls in one turn concurrently, not serially", async () => {
    const engine = harness();
    const aStarted = deferred();
    const bStarted = deferred();
    const model: NativeModelPort = {
      async run(request) {
        if (request.turn === 1) {
          return {
            text: [], final_message: null,
            tool_calls: [
              { call_id: "a", tool: "read", input: {}, input_summary: "read a", risk: "low" },
              { call_id: "b", tool: "read", input: {}, input_summary: "read b", risk: "low" },
            ],
          };
        }
        return { text: [], tool_calls: [], final_message: "done" };
      },
    };
    const tool: NativeToolPort = {
      tool: "read",
      async execute(request) {
        // Each call signals its own start and then waits for the *other*
        // call to have started before finishing. Under the old strictly
        // serial loop this deadlocks (B never starts until A returns), so
        // a regression here fails by timeout rather than a silent pass.
        if (request.call_id === "a") { aStarted.resolve(); await bStarted.promise; }
        else { bStarted.resolve(); await aStarted.promise; }
        return succeeded(`${request.call_id} done`, `${request.call_id} contents`);
      },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool] })
      .run({ start: start("parallel-dispatch", { approvals: "never", tool_allow: ["read"], max_events: 40 }), prompt: "go", max_turns: 2 });

    expect(result.session.state).toBe("completed");
  });

  it("serializes a high-risk call relative to its wave-mates and preserves original tool_result order regardless of completion order", async () => {
    const engine = harness();
    const log: string[] = [];
    const aStarted = deferred();
    const bStarted = deferred();
    const dStarted = deferred();
    const eStarted = deferred();
    let capturedHistory: readonly { readonly kind: string; readonly call_id?: string }[] | null = null;
    const model: NativeModelPort = {
      async run(request) {
        if (request.turn === 1) {
          return {
            text: [], final_message: null,
            tool_calls: [
              { call_id: "a", tool: "read", input: {}, input_summary: "a", risk: "low" },
              { call_id: "b", tool: "read", input: {}, input_summary: "b", risk: "low" },
              { call_id: "c", tool: "write", input: {}, input_summary: "c", risk: "high" },
              { call_id: "d", tool: "read", input: {}, input_summary: "d", risk: "low" },
              { call_id: "e", tool: "read", input: {}, input_summary: "e", risk: "low" },
            ],
          };
        }
        capturedHistory = request.history;
        return { text: [], tool_calls: [], final_message: "done" };
      },
    };
    const read: NativeToolPort = {
      tool: "read",
      async execute(request) {
        const id = request.call_id;
        log.push(`${id}:start`);
        if (id === "a") { aStarted.resolve(); await bStarted.promise; }
        else if (id === "b") { bStarted.resolve(); await aStarted.promise; }
        else if (id === "d") { dStarted.resolve(); await eStarted.promise; }
        else { eStarted.resolve(); await dStarted.promise; }
        log.push(`${id}:done`);
        return succeeded(`${id} done`, `${id} contents`);
      },
    };
    const write: NativeToolPort = {
      tool: "write",
      async execute(request) {
        const id = request.call_id;
        log.push(`${id}:start`);
        // By the time the solo high-risk wave runs, both prior low-risk
        // calls must have already fully completed (wave boundary), and
        // neither of the next wave's calls may have started yet.
        expect(log).toContain("a:done");
        expect(log).toContain("b:done");
        expect(log).not.toContain("d:start");
        expect(log).not.toContain("e:start");
        log.push(`${id}:done`);
        return succeeded(`${id} done`, `${id} contents`);
      },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [read, write] })
      .run({ start: start("write-serialization", { approvals: "never", tool_allow: ["read", "write"], max_events: 60 }), prompt: "go", max_turns: 2 });

    expect(result.session.state).toBe("completed");
    expect(capturedHistory).not.toBeNull();
    const toolResultCallIds = capturedHistory!.filter((entry) => entry.kind === "tool_result").map((entry) => entry.call_id);
    // Original response.tool_calls order, independent of completion order.
    expect(toolResultCallIds).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not cancel a wave-mate when one call in the same wave fails", async () => {
    const engine = harness();
    const model: NativeModelPort = {
      async run(request) {
        if (request.turn === 1) {
          return {
            text: [], final_message: null,
            tool_calls: [
              { call_id: "ok", tool: "read", input: {}, input_summary: "ok", risk: "low" },
              { call_id: "boom", tool: "read", input: {}, input_summary: "boom", risk: "low" },
            ],
          };
        }
        return { text: [], tool_calls: [], final_message: "done" };
      },
    };
    let okCompleted = false;
    const tool: NativeToolPort = {
      tool: "read",
      async execute(request) {
        if (request.call_id === "boom") throw new Error("tool crashed");
        // A brief real delay so "boom" (dispatched in the same wave) has a
        // chance to throw first if it will; "ok" must still run to
        // completion rather than being cancelled by boom's failure.
        await new Promise((resolve) => setTimeout(resolve, 5));
        okCompleted = true;
        return succeeded("ok done", "ok contents");
      },
    };
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [tool] })
      .run({ start: start("failure-isolation", { approvals: "never", tool_allow: ["read"], max_events: 40 }), prompt: "go", max_turns: 2 });

    // The regression this guards: a serial loop (or a wave that cancels
    // siblings on the first rejection) would never let "ok" reach its
    // setTimeout callback. `boom`'s failure is still terminal for the
    // session -- ADR-109 does not change that -- but it must not race
    // "ok" out of running to completion first.
    expect(okCompleted).toBe(true);
    expect(result.session.state).toBe("failed");
  });

  it("withTurnBudgetNote stays silent early and escalates as the turn budget depletes", () => {
    const task = "do the task";
    // First two-thirds: no note.
    expect(withTurnBudgetNote(task, 1, 24)).toBe(task);
    expect(withTurnBudgetNote(task, 16, 24)).toBe(task);
    // Final third: a closure note appears and reserves the terminal exchange.
    const midLate = withTurnBudgetNote(task, 20, 24);
    expect(midLate).not.toBe(task);
    expect(midLate).toContain("Enter closure");
    expect(midLate).toContain("5 of 24");
    // Penultimate turn permits one bounded last action, but explicitly reserves
    // the final model turn for closure.
    const penultimate = withTurnBudgetNote(task, 23, 24);
    expect(penultimate).toContain("LAST TOOL-USE OPPORTUNITY");
    expect(penultimate).toContain("no-tools final response");
    // The final turn forbids the tool call that previously consumed the last
    // exchange and stranded an otherwise-complete worktree.
    const last = withTurnBudgetNote(task, 24, 24);
    expect(last).toContain("FINAL RESPONSE ONLY");
    expect(last).toContain("Do not call any tool");
    expect(last).toContain("task unfinished");
    // Degenerate budgets are left untouched.
    expect(withTurnBudgetNote(task, 1, 1)).toBe(task);
  });
});
