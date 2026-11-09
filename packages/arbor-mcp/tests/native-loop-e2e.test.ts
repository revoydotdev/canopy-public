/**
 * Proof that the native execution loop actually closes: a deterministic,
 * network-free fake `NativeModelPort` drives `NativeHarnessWorker` across
 * four turns against the REAL `NativeRepositoryToolHost` (file.read,
 * file.write, verification.run), pointed at a real temp workspace on disk.
 *
 * This is the seam the harness has unit coverage for in isolation
 * (`native-worker.test.ts` fakes every tool port; `native-agent-executor.test.ts`
 * exercises the production composition but hardcodes `network_allowed: false`,
 * which makes `verification.run`/`shell.execute` refuse unconditionally — see
 * `executionPolicy()` in `native-agent-executor.ts`). Neither proves the loop
 * completing a real read -> write -> verify -> final-message cycle with real
 * filesystem effects. This test constructs the lower `NativeHarnessWorker`
 * seam directly (the same composition `NativeAgentExecutor` performs
 * internally: `NativeSessionEngine` + `nativeRepositoryToolPorts`), but with
 * an `ExecutionPolicy` that permits network so `verification.run` can run.
 *
 * The fake model is keyed off the conversation history it actually receives:
 * each turn parses the previous tool's redacted `model_output` out of
 * `request.history` and throws if the expected fact is missing, so a broken
 * feedback loop fails loudly here rather than silently passing.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeHarnessWorker,
  NativeSessionEngine,
  type CapabilitySupport,
  type ExecutionPolicy,
  type NativeApprovalPort,
  type NativeApprovalRequest,
  type NativeGovernedCompletionPort,
  type NativeModelPort,
  type NativeModelRequest,
  type NativeModelResponse,
  type SessionStartRequest,
} from "@arbor/harness";
import { nativeRepositoryToolPorts, type NativeHighRiskToolScope, type NativeToolAuditRecord } from "../src/native-tool-host.js";

const SEED_CONTENT = "revoy2 native loop e2e seed fixture\n";
const OUTPUT_PATH = "output.txt";

const tempDirs: string[] = [];
afterAll(() => { while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true }); });

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "arbor-native-loop-e2e-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "seed.txt"), SEED_CONTENT, "utf8");
  return dir;
}

function capabilities(): readonly CapabilitySupport[] { return []; }

function policy(root: string): ExecutionPolicy {
  return {
    filesystem: "workspace_write",
    approvals: "on_risk",
    tool_allow: ["file.read", "file.write", "verification.run"],
    tool_deny: [],
    workspace_roots: [root],
    max_wall_clock_ms: 30_000,
    max_events: 64,
    // verification.run/shell.execute refuse unconditionally when this is
    // false (see native-tool-host.ts `command()`); this is the one field
    // NativeAgentExecutor's composition hardcodes to false, so this test
    // constructs its own policy rather than going through that seam.
    network_allowed: true,
    ambient_plugins_allowed: false,
    user_configuration_allowed: false,
    inherited_credentials_allowed: false,
  };
}

function start(sessionId: string, root: string): SessionStartRequest {
  return { session_id: sessionId, policy: policy(root), required_capabilities: [], lineage: { kind: "new" }, ephemeral: false };
}

/** Parses the redacted `model_output` JSON a tool result left in history. */
function toolResultPayload(history: NativeModelRequest["history"], tool: string): Record<string, unknown> {
  const entry = [...history].reverse().find((candidate) => candidate.kind === "tool_result" && candidate.tool === tool);
  if (entry === undefined) throw new Error(`scripted model expected a "${tool}" tool_result in history but found none`);
  return JSON.parse(entry.text) as Record<string, unknown>;
}

/**
 * A deterministic fake provider scripted to a realistic four-turn session.
 * It never inspects wall-clock time or randomness, and every branch after
 * turn 1 asserts on the exact fact the worker fed back rather than assuming
 * a fixed turn count blindly produced the right effect.
 */
function scriptedModel(input: { readonly verificationArgv: readonly string[]; readonly requests: NativeModelRequest[] }): NativeModelPort {
  return {
    identity: { provider_id: "fixture-deterministic", model_id: "native-loop-e2e-v1", revision: null, capabilities: [] },
    async run(request): Promise<NativeModelResponse> {
      input.requests.push(request);
      if (request.turn === 1) {
        if (request.history.length !== 0) throw new Error("scripted model expected empty history at turn 1");
        return {
          // Commentary text AND a tool call in the same response: proves the
          // worker (not merely a provider adapter) accepts this combined
          // shape, since only final_message + tool_calls is mutually exclusive.
          text: [{ text: "Reading the seed file before deriving output from it.", phase: "commentary" }],
          tool_calls: [{ call_id: "turn1-read", tool: "file.read", input: { path: "seed.txt" }, input_summary: "read seed.txt", risk: "low" }],
          final_message: null,
        };
      }
      if (request.turn === 2) {
        const read = toolResultPayload(request.history, "file.read");
        if (read.content !== SEED_CONTENT) throw new Error(`scripted model: fed-back file.read content did not match the seed file (got ${JSON.stringify(read.content)})`);
        return {
          text: [],
          tool_calls: [{
            call_id: "turn2-write", tool: "file.write",
            input: { path: OUTPUT_PATH, content: `derived from: ${(read.content as string).trim()}`, create: true },
            input_summary: "write output.txt derived from the seed content", risk: "high",
          }],
          final_message: null,
        };
      }
      if (request.turn === 3) {
        const write = toolResultPayload(request.history, "file.write");
        if (write.path !== OUTPUT_PATH) throw new Error(`scripted model: fed-back file.write result had unexpected path ${JSON.stringify(write.path)}`);
        return {
          text: [],
          tool_calls: [{ call_id: "turn3-verify", tool: "verification.run", input: { argv: input.verificationArgv }, input_summary: "run verification against the workspace", risk: "high" }],
          final_message: null,
        };
      }
      // turn 4: always produces a final message, even when verification
      // failed — the negative-path test proves that claim is never
      // laundered into a "verified" session result.
      const verification = toolResultPayload(request.history, "verification.run");
      return {
        text: [{ text: "Seed read, output derived and written, verification attempted.", phase: "final" }],
        tool_calls: [],
        final_message: `native loop finished: verification outcome was "${String(verification.outcome)}"`,
      };
    },
  };
}

/** Fixed scope binding write_paths/command_argv, mirroring how a composition root derives one from a durable action. */
function highRiskScope(root: string, sessionId: string, verificationArgv: readonly string[]): NativeHighRiskToolScope {
  return {
    scope_id: "native-loop-e2e-scope", campaign_id: "native-loop-e2e", node_id: "proof", session_id: sessionId,
    worktree_root: root, provenance: { tag: "generated", generator: "native-loop-e2e-test", input_hash: "fixture" },
    write_paths: [OUTPUT_PATH], command_argv: [[...verificationArgv]],
  };
}

/** A governed-completion boundary that only certifies success from the tool evidence actually observed in history — never from the model's own claim. */
function verificationBackedCompletion(): NativeGovernedCompletionPort {
  return {
    async verify({ history }) {
      const entry = [...history].reverse().find((candidate) => candidate.kind === "tool_result" && candidate.tool === "verification.run");
      if (entry === undefined) return null;
      const payload = JSON.parse(entry.text) as { outcome?: string };
      if (payload.outcome !== "succeeded") return null;
      return { message: "verification.run exited 0 against the real workspace", provenance: { tag: "verified", cmd: "verification.run", exit: 0, stdout_hash: `sha256:${entry.text.length}` } };
    },
  };
}

function buildSession(options: { readonly root: string; readonly sessionId: string; readonly verificationArgv: readonly string[] }) {
  const requests: NativeModelRequest[] = [];
  const approvalRequests: NativeApprovalRequest[] = [];
  const auditRecords: NativeToolAuditRecord[] = [];
  const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities: capabilities() });
  const approvals: NativeApprovalPort = { async decide(request) { approvalRequests.push(request); return { approved: true, rationale: "test fixture grants every high-risk action" }; } };
  const tools = nativeRepositoryToolPorts({
    filesystem: "workspace_write",
    workspace_roots: [options.root],
    allowed_commands: [process.execPath],
    resolve_intent: () => ({ purpose: "native loop e2e proof", provenance: { tag: "generated", generator: "native-loop-e2e-test", input_hash: "fixture" } }),
    resolve_high_risk_scope: () => highRiskScope(options.root, options.sessionId, options.verificationArgv),
    on_audit: (record) => auditRecords.push(record),
  }).filter((tool) => ["file.read", "file.write", "verification.run"].includes(tool.tool));
  const worker = new NativeHarnessWorker({
    session_engine: engine,
    model: scriptedModel({ verificationArgv: options.verificationArgv, requests }),
    tools,
    approvals,
    governed_completion: verificationBackedCompletion(),
  });
  return { engine, worker, requests, approvalRequests, auditRecords };
}

describe("native execution loop end-to-end", () => {
  it("drives the tool host across four turns to a verified result with real filesystem effects", async () => {
    const root = workspace();
    const sessionId = "native-loop-e2e-positive";
    const { engine, worker, requests, approvalRequests, auditRecords } = buildSession({
      root, sessionId, verificationArgv: [process.execPath, "-e", "process.exit(0)"],
    });

    const result = await worker.run({ start: start(sessionId, root), prompt: "prove the native loop closes end to end", max_turns: 4 });

    // 1. Tool calls had real effects: the file the model asked to write
    // actually exists on disk with the expected derived content.
    expect(readFileSync(join(root, OUTPUT_PATH), "utf8")).toBe(`derived from: ${SEED_CONTENT.trim()}`);

    // 2. The worker fed each tool's model_output back into the NEXT turn's
    // request history — inspected directly on the fake provider's received
    // requests, not merely inferred from the final result.
    expect(requests).toHaveLength(4);
    expect(JSON.parse(requests[1]!.history.find((e) => e.kind === "tool_result" && e.tool === "file.read")!.text)).toMatchObject({ outcome: "succeeded", content: SEED_CONTENT });
    expect(JSON.parse(requests[2]!.history.find((e) => e.kind === "tool_result" && e.tool === "file.write")!.text)).toMatchObject({ outcome: "succeeded", path: OUTPUT_PATH });
    expect(JSON.parse(requests[3]!.history.find((e) => e.kind === "tool_result" && e.tool === "verification.run")!.text)).toMatchObject({ outcome: "succeeded" });

    // 3. The session terminates VERIFIED (not claimed, not failed), and the
    // final message is surfaced.
    expect(result.turns_started).toBe(4);
    expect(result.session.state).toBe("completed");
    expect(result.session.terminal).toMatchObject({
      state: "completed", result: "verified",
      message: "verification.run exited 0 against the real workspace",
      provenance: { tag: "verified", cmd: "verification.run", exit: 0 },
    });

    // 4. Turn 1 combined commentary text with a tool call in one response;
    // the worker accepted it (only final_message + tool_calls is exclusive).
    const kinds = engine.observe(sessionId).map((event) => event.kind);
    expect(kinds.slice(0, 3)).toEqual(["lifecycle", "model_text", "tool_intent"]);
    expect(kinds).toContain("terminal");

    // High-risk tools (file.write, verification.run) required approval; the
    // low-risk file.read did not.
    expect(approvalRequests.map((request) => request.tool)).toEqual(["file.write", "verification.run"]);
    expect(auditRecords.filter((record) => record.outcome === "succeeded").map((record) => record.tool)).toEqual(["file.read", "file.write", "verification.run"]);
  });

  it("never launders a failed verification.run into a verified result", async () => {
    const root = workspace();
    const sessionId = "native-loop-e2e-negative";
    const { worker, requests } = buildSession({
      root, sessionId, verificationArgv: [process.execPath, "-e", "process.exit(1)"],
    });

    const result = await worker.run({ start: start(sessionId, root), prompt: "prove a failed check cannot be laundered into success", max_turns: 4 });

    // The write still happened (turns 1-2 are independent of verification),
    // but the verification tool genuinely failed and the model's turn-4
    // final message optimistically claims completion anyway.
    expect(readFileSync(join(root, OUTPUT_PATH), "utf8")).toBe(`derived from: ${SEED_CONTENT.trim()}`);
    expect(JSON.parse(requests[3]!.history.find((e) => e.kind === "tool_result" && e.tool === "verification.run")!.text)).toMatchObject({ outcome: "failed", code: "command_exit_nonzero" });
    expect(result.session.terminal?.message).toContain('verification outcome was "failed"');

    // The governed-completion boundary refused to certify it, so the session
    // settles as an honest claimed result, never "verified".
    expect(result.session.state).toBe("completed");
    expect(result.session.terminal?.result).toBe("claimed");
    expect(result.session.terminal?.result).not.toBe("verified");
    expect(result.session.terminal?.provenance).toMatchObject({ tag: "claimed" });
  });
});
