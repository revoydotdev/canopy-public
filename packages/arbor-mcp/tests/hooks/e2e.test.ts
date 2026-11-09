import type { CapabilitySupport, NativeContextManager, NativeModelPort, NativeModelRequest, NativeToolPort, NativeToolPreflightResult, NativeToolRequest, NativeToolResponse } from "@arbor/harness";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeAgentExecutor, createNativeSessionContext } from "../../src/native-agent-executor.js";
import { HookBus } from "../../src/hooks/bus.js";
import { DEFAULT_HOOK_DESCRIPTORS, HookCatalog } from "../../src/hooks/catalog.js";
import type { HookHandlerRegistry, HookVetoContext } from "../../src/hooks/contracts.js";
import { tropismPromptBlock, type Tropism } from "@arbor/prompts";

const capabilities: readonly CapabilitySupport[] = [
  "streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting",
].map((capability) => ({
  capability, grade: "native",
  evidence: { implementation_id: "hook-bus-e2e-test", observed_at: "2026-08-12T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

const toolCallModel = (tool: string): NativeModelPort => {
  let turn = 0;
  return {
    async run() {
      turn += 1;
      if (turn === 1) {
        return {
          text: [], final_message: null,
          tool_calls: [{ call_id: "call-1", tool, input: { path: "note.md", content: "hi" }, input_summary: `call ${tool}`, risk: "low" as const }],
        };
      }
      return { text: [], tool_calls: [], final_message: "done after tool call" };
    },
  };
};

describe("HookBus e2e: real tool calls through NativeAgentExecutor + NativeHarnessWorker", () => {
  it("a session-start lifecycle veto refuses before the model boundary", async () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify({ schema_version: 1, hook_id: "deployment-kill-switch", version: "1.0.0", kind: "lifecycle", event: "session_start", handler_ref: "lifecycle.deny-session-start", why: "pause all newly admitted native sessions" }));
    const bus = new HookBus({ catalog });
    let modelCalls = 0;
    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities, hook_bus: bus,
      model_for_role: () => ({ async run() { modelCalls += 1; return { text: [], tool_calls: [], final_message: "should not run" }; } }),
    });

    const result = await executor.specialize({ campaign_id: "c-1", node_id: "n-1", action: {}, prompt: "do work", worktree_path: "", specialist_agent: "seed" });

    expect(modelCalls).toBe(0);
    expect(result.error).toBeDefined();
    expect(result.output).toContain("denied by hook deployment-kill-switch@1.0.0");
    expect(bus.ledger()).toMatchObject([{ hook_id: "deployment-kill-switch", event: "session_start", decision: "deny" }]);
  });

  it("a denying veto hook refuses a real tool call in the loop; the base port never executes, and the typed remedy reaches the model", async () => {
    const handlers: HookHandlerRegistry = {
      "veto.deny-extension-write": { kind: "veto", handler: (context) => context.tool === "extension.write" ? { allow: false, reason: "extension.write is denied for this campaign" } : { allow: true } },
    };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify({ schema_version: 1, hook_id: "deny-extension-write", version: "1.0.0", kind: "veto", event: "tool_preflight", handler_ref: "veto.deny-extension-write", why: "block the extension write tool for this session" }));
    const bus = new HookBus({ catalog, handlers });

    let executed = false;
    const rawPort = Object.freeze({
      tool: "extension.write",
      model_definition: Object.freeze({ name: "extension.write", description: "write a note", parameters: { type: "object" as const }, risk: "high" as const }),
      async execute() {
        executed = true;
        return { result_summary: "wrote note.md", model_output: "ok", evidence: { outcome: "succeeded" as const, stage: "execution" as const, code: "ok", effect: "applied" as const, action_scope: { status: "not_required" as const } } };
      },
    });
    const wrapped = Object.freeze({ ...rawPort, ...bus.wrapToolPort(rawPort) });

    const requests: NativeModelRequest[] = [];
    const model = toolCallModel("extension.write");
    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities,
      specialist_tools: () => [wrapped],
      model_for_role: () => ({ run(request, secret, signal) { requests.push(request); return model.run(request, secret, signal); } }),
    });

    const result = await executor.specialize({ campaign_id: "c-1", node_id: "n-1", action: {}, prompt: "write a note", worktree_path: "", specialist_agent: "seed" });

    expect(executed).toBe(false);
    expect(result.provenance).toEqual({ tag: "claimed", claimant: "seed" });
    // A policy veto is the model's to route around (ADR-117's recoverable
    // shape): the session continues instead of ending on the refusal turn.
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("done after tool call");
    const refusal = requests[1]?.history.find((entry) => entry.kind === "tool_result" && entry.call_id === "call-1");
    expect(refusal?.kind === "tool_result" && refusal.text).toContain("denied by hook deny-extension-write@1.0.0");
    expect(refusal?.kind === "tool_result" && refusal.text).toContain("Correcting actor: specialist. Corrective action: revise_tool_call.");
    expect(bus.ledger()).toMatchObject([{ hook_id: "deny-extension-write", event: "tool_preflight", decision: "deny" }]);
  });

  it("an allowing veto hook lets the base port execute and the specialist completes", async () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify({ schema_version: 1, hook_id: "deny-shell", version: "1.0.0", kind: "veto", event: "tool_preflight", handler_ref: "veto.deny-shell-execute", why: "shell is not needed for this campaign" }));
    const bus = new HookBus({ catalog });

    let executed = false;
    const rawPort = Object.freeze({
      tool: "extension.write",
      model_definition: Object.freeze({ name: "extension.write", description: "write a note", parameters: { type: "object" as const }, risk: "high" as const }),
      async execute() {
        executed = true;
        return { result_summary: "wrote note.md", model_output: "ok", evidence: { outcome: "succeeded" as const, stage: "execution" as const, code: "ok", effect: "applied" as const, action_scope: { status: "not_required" as const } } };
      },
    });
    const wrapped = Object.freeze({ ...rawPort, ...bus.wrapToolPort(rawPort) });

    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities,
      specialist_tools: () => [wrapped],
      model_for_role: () => toolCallModel("extension.write"),
      on_session_event: (record) => {
        if (record.event.kind === "tool_result") {
          bus.observeToolAudit({
            session_id: record.inspection.session_id, call_id: "call-1", tool: "extension.write", risk: "high",
            intent: null, action_scope: record.event.payload.evidence.action_scope,
            outcome: record.event.payload.evidence.outcome, stage: record.event.payload.evidence.stage,
            code: record.event.payload.evidence.code, effect: record.event.payload.evidence.effect,
            confinement: record.event.payload.evidence.confinement ?? "application_validated",
            summary: record.event.payload.result_summary,
          });
        }
      },
    });

    const result = await executor.specialize({ campaign_id: "c-1", node_id: "n-1", action: {}, prompt: "write a note", worktree_path: "", specialist_agent: "seed" });

    expect(executed).toBe(true);
    expect(result.error).toBeUndefined();
    // No observe hooks are declared in this bus at all, so nothing is
    // ledgered by observeToolAudit -- proving the veto hook (which allowed)
    // did not silently start observing/gating anything beyond its own kind.
    expect(bus.ledger().filter((entry) => entry.event === "tool_audit")).toEqual([]);
  });

  it("an observe hook subscribed to on_audit receives a real, bounded record for a real tool call", async () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify({ schema_version: 1, hook_id: "audit-tally", version: "1.0.0", kind: "observe", event: "tool_audit", handler_ref: "observe.tool-audit-notes", why: "tally every tool audit record for this campaign" }));
    const bus = new HookBus({ catalog });

    const rawPort = Object.freeze({
      tool: "extension.write",
      model_definition: Object.freeze({ name: "extension.write", description: "write a note", parameters: { type: "object" as const }, risk: "high" as const }),
      async execute() {
        return { result_summary: "wrote note.md (real)", model_output: "ok", evidence: { outcome: "succeeded" as const, stage: "execution" as const, code: "ok", effect: "applied" as const, action_scope: { status: "not_required" as const } } };
      },
    });

    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities,
      specialist_tools: () => [rawPort],
      model_for_role: () => toolCallModel("extension.write"),
      on_session_event: (record) => {
        if (record.event.kind !== "tool_result") return;
        bus.observeToolAudit({
          session_id: record.inspection.session_id, call_id: "call-1", tool: "extension.write", risk: "high",
          intent: null, action_scope: record.event.payload.evidence.action_scope,
          outcome: record.event.payload.evidence.outcome, stage: record.event.payload.evidence.stage,
          code: record.event.payload.evidence.code, effect: record.event.payload.evidence.effect,
          confinement: record.event.payload.evidence.confinement ?? "application_validated",
          summary: record.event.payload.result_summary,
        });
      },
    });

    await executor.specialize({ campaign_id: "c-1", node_id: "n-1", action: {}, prompt: "write a note", worktree_path: "", specialist_agent: "seed" });

    expect(bus.ledger()).toMatchObject([{ hook_id: "audit-tally", event: "tool_audit", decision: "observed" }]);
    expect(bus.ledger()[0]!.evidence_ref).toContain("wrote note.md");
    expect(bus.neverFired()).toEqual([]);
  });

  it("ADR-087: a specialist_tools-composed port with no repository on_audit path still fires tool_audit, automatically, from the composition wrap alone", async () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify({ schema_version: 1, hook_id: "subagent-audit", version: "1.0.0", kind: "observe", event: "tool_audit", handler_ref: "observe.tool-audit-notes", why: "audit every non-repository native tool call" }));
    const bus = new HookBus({ catalog });

    let executed = false;
    const busThreadLikePort = Object.freeze({
      tool: "bus.thread.send",
      async execute() {
        executed = true;
        return { result_summary: "sent", model_output: "ok", evidence: { outcome: "succeeded" as const, stage: "execution" as const, code: "ok", effect: "applied" as const, action_scope: { status: "not_required" as const } } };
      },
    });

    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities, hook_bus: bus,
      specialist_tools: () => [busThreadLikePort],
      model_for_role: () => toolCallModel("bus.thread.send"),
      // No on_session_event/on_audit wiring at all -- proves the firing
      // comes from `wrapToolPortWithAudit` inside `specialistTools()`, the
      // one place ADR-087 extends, not a test-authored second mechanism.
    });

    const result = await executor.specialize({ campaign_id: "c-1", node_id: "n-1", action: {}, prompt: "send a message", worktree_path: "", specialist_agent: "seed" });

    expect(executed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(bus.ledger().filter((entry) => entry.event === "tool_audit")).toMatchObject([{ hook_id: "subagent-audit", decision: "observed" }]);
    expect(bus.ledger().find((entry) => entry.event === "tool_audit")!.evidence_ref).toContain("bus.thread.send");
  });

  it("ADR-087: session_start/session_end observe the dispatched role and the real terminal outcome kind, never a forged one", async () => {
    const handlers: HookHandlerRegistry = {
      "lifecycle.records": {
        kind: "lifecycle_observe",
        handler: (context) => ({ note: `${context.event} role=${context.role ?? "-"} outcome=${context.outcome ?? "-"}` }),
      },
    };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify({ schema_version: 1, hook_id: "start-notes", version: "1.0.0", kind: "lifecycle", event: "session_start", handler_ref: "lifecycle.records", why: "observe dispatched role at admission" }));
    catalog.register(JSON.stringify({ schema_version: 1, hook_id: "end-notes", version: "1.0.0", kind: "lifecycle", event: "session_end", handler_ref: "lifecycle.records", why: "observe the terminal outcome kind" }));
    const bus = new HookBus({ catalog, handlers });

    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities, hook_bus: bus,
      model_for_role: () => ({ async run() { return { text: [], tool_calls: [], final_message: "done" }; } }),
    });

    const result = await executor.specialize({ campaign_id: "c-1", node_id: "n-1", action: {}, prompt: "do work", worktree_path: "", specialist_agent: "documentation-writer" });

    expect(result.error).toBeUndefined();
    const start = bus.ledger().find((entry) => entry.hook_id === "start-notes")!;
    const end = bus.ledger().find((entry) => entry.hook_id === "end-notes")!;
    expect(start.evidence_ref).toContain("role=documentation-writer");
    expect(end.evidence_ref).toContain("role=documentation-writer");
    expect(end.evidence_ref).toContain("outcome=completed");
  });
});

describe("HookBus veto context origin through the real executor", () => {
  // The signal under test is `nodeId.startsWith("subagent-")` — the repo's own
  // orchestrator-vs-dispatched-child discriminator. Nothing here parses a
  // session id: the assertion is on what the handler is told, driven through
  // the executor's own composition sites.
  const originProbe = (seen: string[]) => {
    const handlers: HookHandlerRegistry = {
      "veto.origin-probe": {
        kind: "veto",
        handler: (context: HookVetoContext) => {
          seen.push(`${context.tool}:${context.subagent}`);
          return { allow: true };
        },
      },
    };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify({ schema_version: 1, hook_id: "origin-probe", version: "1.0.0", kind: "veto", event: "tool_preflight", handler_ref: "veto.origin-probe", why: "observe the origin the composition site threaded" }));
    return { bus: new HookBus({ catalog, handlers }), handlers };
  };

  const writableExtensionPort = () => Object.freeze({
    tool: "extension.write",
    model_definition: Object.freeze({ name: "extension.write", description: "write a note", parameters: { type: "object" as const }, risk: "high" as const }),
    async execute() {
      return { result_summary: "ok", model_output: "ok", evidence: { outcome: "succeeded" as const, stage: "execution" as const, code: "ok", effect: "applied" as const, action_scope: { status: "not_required" as const } } };
    },
  });

  it("a dispatched subagent node reaches the veto handler as subagent:true", async () => {
    const seen: string[] = [];
    const { bus } = originProbe(seen);
    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities, hook_bus: bus,
      specialist_tools: (_input) => [writableExtensionPort()],
      model_for_role: () => toolCallModel("extension.write"),
    });

    await executor.specialize({ campaign_id: "c-1", node_id: "subagent-call-1", action: {}, prompt: "write", worktree_path: "", specialist_agent: "seed" });

    expect(seen).toContain("extension.write:true");
  });

  it("an orchestrator node reaches the same hook as subagent:false", async () => {
    const seen: string[] = [];
    const { bus } = originProbe(seen);
    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities, hook_bus: bus,
      specialist_tools: (_input) => [writableExtensionPort()],
      model_for_role: () => toolCallModel("extension.write"),
    });

    await executor.specialize({ campaign_id: "c-1", node_id: "n-1", action: {}, prompt: "write", worktree_path: "", specialist_agent: "seed" });

    expect(seen).toContain("extension.write:false");
  });

  it("the planning site, which has no node_id in scope, keeps subagent:false", async () => {
    const seen: string[] = [];
    const { bus } = originProbe(seen);
    let turn = 0;
    const executor = new NativeAgentExecutor({
      workspace_root: process.cwd(), capabilities, hook_bus: bus, repository_tools: {},
      model_for_role: () => ({
        async run() {
          turn += 1;
          if (turn === 1) return { text: [], final_message: null, tool_calls: [{ call_id: "call-1", tool: "git.status", input: {}, input_summary: "status", risk: "low" as const }] };
          return { text: [], tool_calls: [], final_message: '{"summary":"plan"}' };
        },
      }),
    });

    await executor.planTask({ draft_id: "draft-1", prompt: "plan" });

    expect(seen.some((entry) => entry.endsWith(":false"))).toBe(true);
    expect(seen.some((entry) => entry.endsWith(":true"))).toBe(false);
  });
});

/**
 * Proposal §5: proof that the `inject` lane reaches the *model*, not the
 * ledger.
 *
 * Every assertion in this block is on the `NativeModelRequest` a real
 * `NativeAgentExecutor` actually built and handed to a real
 * `NativeModelPort`. A ledger-row assertion would pass here even with the
 * `boundedHistory` drop fully intact, because the bus records a firing
 * whether or not the text can ever reach the model — so a ledger assertion
 * proves the plumbing and not the feature, which is precisely the bug class
 * this lane exists to avoid.
 *
 * The last test in the block is the negative control: it demonstrates that
 * the same body routed through `NativeContextManager` — the design this one
 * deliberately rejected — is state the model never reads. Without it, the
 * positive assertion could be satisfied by a bus that writes its text to
 * any old place the test happened to check.
 */
describe("inject lane e2e: a tropism reaches the model-facing system prompt", () => {
  const TROPISM: Tropism = {
    id: "orient",
    trigger: "session_start",
    lane: "ADVISORY",
    provenance: "generated",
    derived_from: ["ring:e2e1"],
    body: "Leased node n-1; write-set is packages/arbor-mcp/src/hooks/**.",
    expires_after_turns: 3,
    enforcing_ref: null,
  };

  const wiring = () => {
    const handlers: HookHandlerRegistry = { "inject.orient": { kind: "inject", handler: () => TROPISM } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify({ schema_version: 1, hook_id: "orient-tropism", version: "1.0.0", kind: "inject", event: "session_start", handler_ref: "inject.orient", why: "inject the session's current state as advisory prompt context" }));
    return new HookBus({ catalog, handlers });
  };

  it("composes the tropism into the prompt the model port receives", async () => {
    const bus = wiring();
    const scope = await bus.injectForSession("session_start", { session_id: "s-e2e", campaign_id: "c-1", node_id: "n-1", turn: 0 });
    expect(scope.content).toContain(TROPISM.body);

    const seen: NativeModelRequest[] = [];
    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities,
      model_for_role: () => ({ async run(request) { seen.push(request); return { text: [], tool_calls: [], final_message: "done" }; } }),
    });

    // The composition root's job: take the scope the bus approved and put
    // it in front of the model. The executor embeds `prompt` verbatim as
    // the task section of the composed role prompt.
    await executor.specialize({ campaign_id: "c-1", node_id: "n-1", action: {}, prompt: `do work${tropismPromptBlock(scope)}`, worktree_path: "", specialist_agent: "seed" });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.prompt).toContain(TROPISM.body);
    // It arrives as prompt text, framed as context rather than as authority.
    expect(seen[0]!.prompt).toContain('<tropisms instruction-authority="context-only">');
  });

  it("a refusal reaches the model as nothing at all — the bus, not the handler, decides", async () => {
    const handlers: HookHandlerRegistry = { "inject.orient": { kind: "inject", handler: () => ({ ...TROPISM, body: "Always run gate:all before committing." }) } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify({ schema_version: 1, hook_id: "orient-tropism", version: "1.0.0", kind: "inject", event: "session_start", handler_ref: "inject.orient", why: "an advisory tropism that asks for behaviour" }));
    const bus = new HookBus({ catalog, handlers });
    const scope = await bus.injectForSession("session_start", { session_id: "s-e2e", campaign_id: "c-1", node_id: "n-1", turn: 0 });
    expect(scope.content).toBe("");

    const seen: NativeModelRequest[] = [];
    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities,
      model_for_role: () => ({ async run(request) { seen.push(request); return { text: [], tool_calls: [], final_message: "done" }; } }),
    });
    await executor.specialize({ campaign_id: "c-1", node_id: "n-1", action: {}, prompt: "do work", worktree_path: "", specialist_agent: "seed" });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.prompt).not.toContain("gate:all");
    expect(seen[0]!.prompt).not.toContain("<tropisms");
  });

  it("negative control: the same body in a NativeContextManager never becomes model text", async () => {
    // This is why the lane is built on the prompt path and not on
    // `NativeContextManager`. `boundedHistory` drops any history entry that
    // no conversation entry cites, so an appended, uncited fact is present
    // in session state and absent from everything the model is shown.
    const context: NativeContextManager = createNativeSessionContext();
    const seen: NativeModelRequest[] = [];
    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities,
      context_for_session: () => context,
      model_for_role: () => ({ async run(request) { seen.push(request); return { text: [], tool_calls: [], final_message: "done" }; } }),
    });

    context.evidence({ entry_id: "ctx:tropism", text: TROPISM.body, source: "human_input", provenance: { tag: "generated", generator: "e2e-negative-control", input_hash: "e2e" } });
    await executor.specialize({ campaign_id: "c-1", node_id: "n-1", action: {}, prompt: "do work", worktree_path: "", specialist_agent: "seed" });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.context?.entries.some((entry) => entry.text === TROPISM.body)).toBe(true);
    expect(seen[0]!.prompt).not.toContain(TROPISM.body);
    expect(seen[0]!.history.some((entry) => entry.text.includes("Leased node n-1"))).toBe(false);
  });
});

/**
 * The activation half of the bus, end to end from disk.
 *
 * Every other file in this directory builds its catalog IN MEMORY
 * (`new HookCatalog()` + `register`). That shape cannot catch the defect this
 * file exists for: a handler that is a key in `HOOK_HANDLERS` but that no
 * descriptor anywhere activates, so `HookBus.wrapToolPort` finds zero veto
 * hooks and returns the port unwrapped. Four host hooks were deleted in
 * favour of exactly such handlers and shipped inert — every test green,
 * `arbor hook validate` green over zero descriptors.
 *
 * So this block does the only thing that can fail on it: it materializes
 * `DEFAULT_HOOK_DESCRIPTORS` into a real `.arbor/hooks` directory, loads them
 * through `HookCatalog.fromDirectory` — the exact call
 * `native-executor-composition.ts` makes at runtime — and dispatches. The
 * veto assertion reads a `NativeToolPreflightResult` off the wrapped port;
 * the inject assertions read the bus's own ledger rows. Neither calls a
 * handler function directly, because calling the handler is what the
 * in-memory suites already do and what made this invisible.
 */
describe("activation e2e: DEFAULT_HOOK_DESCRIPTORS on real disk fire through HookBus", () => {
  let root = "";
  let catalog: HookCatalog;

  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };

  /** A real git repository, because the three inject handlers read live posture through `GitAdapter`. */
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arbor-hooks-activation-"));
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "T");
    mkdirSync(join(root, "decisions"), { recursive: true });
    mkdirSync(join(root, ".arbor", "hooks"), { recursive: true });
    writeFileSync(join(root, "decisions", "ADR-999-test.md"), "# A proposed record\n\n**Status:** Proposed\n**Date:** 2026-09-01\n\nRationale.\n");
    git("add", "-A");
    git("commit", "-q", "-m", "root");
    for (const descriptor of DEFAULT_HOOK_DESCRIPTORS) writeFileSync(join(root, ".arbor", "hooks", descriptor.filename), descriptor.contents);
    catalog = HookCatalog.fromDirectory(join(root, ".arbor", "hooks"));
    // The inject handlers resolve the governed root per firing through
    // `currentGovernedRoot()`; vitest runs in a worker thread where
    // `process.chdir` does not exist, so the cwd seam is stubbed instead.
    vi.spyOn(process, "cwd").mockReturnValue(root);
  });

  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  /** A shell port whose own preflight allows, so any refusal below can only be a hook's. */
  const shellPort = (): NativeToolPort => Object.freeze({
    tool: "shell.execute",
    preflight: (): NativeToolPreflightResult => ({ allowed: true }),
    execute: (): Promise<NativeToolResponse> => Promise.reject(new Error("preflight should have refused this call")),
  });
  const resetRequest = (): NativeToolRequest => Object.freeze({
    session_id: "s-1", turn: 1, call_id: "c-1", input: { command: "git reset --hard HEAD~1" },
    workspace_roots: [root], filesystem: "workspace_write", network_allowed: false, intent_evidence: [],
  });

  /**
   * The written-payload half of the veto context, captured off a real
   * dispatch. `COMMAND_CARRYING_TOOLS` is `{shell.execute, verification.run}`,
   * so before the widening every `file.write`/`file.patch` reached its handler
   * as the empty sentinel and a file-writing guard had no path and no text to
   * reason about. The capture is a handler that records its context and
   * allows; the dispatch is still `wrapToolPort(...).preflight(...)`, so the
   * assertion is on what the bus built, not on a unit of the builder.
   */
  const captureBus = (): { bus: HookBus; seen: HookVetoContext[] } => {
    const seen: HookVetoContext[] = [];
    const handlers: HookHandlerRegistry = { "veto.capture-write": { kind: "veto", handler: (context) => { seen.push(context); return { allow: true }; } } };
    const captureCatalog = new HookCatalog({ handlers });
    captureCatalog.register(JSON.stringify({ schema_version: 1, hook_id: "capture-write", version: "1.0.0", kind: "veto", event: "tool_preflight", handler_ref: "veto.capture-write", why: "capture the widened veto context" }));
    return { bus: new HookBus({ catalog: captureCatalog, handlers }), seen };
  };
  const filePort = (tool: string): NativeToolPort => Object.freeze({
    tool,
    preflight: (): NativeToolPreflightResult => ({ allowed: true }),
    execute: (): Promise<NativeToolResponse> => Promise.reject(new Error("execute should not be reached")),
  });
  const writeRequest = (input: Record<string, unknown>): NativeToolRequest => Object.freeze({
    session_id: "s-1", turn: 1, call_id: "c-1", input,
    workspace_roots: [root], filesystem: "workspace_write", network_allowed: false, intent_evidence: [],
  });

  it("carries a file.write's path and content, with no invented removed text", () => {
    const { bus, seen } = captureBus();

    expect(bus.wrapToolPort(filePort("file.write")).preflight?.(writeRequest({ path: "decisions/ADR-999-test.md", content: "**Status:** Accepted\n" }))?.allowed).toBe(true);

    // `file.write` is a full-file write: `content` is all of it, and it
    // replaces the file rather than displacing a located span, so
    // `removed_text` is structurally empty and NOT a copy of `added_text`.
    expect(seen.at(-1)?.tool_input).toEqual({ command: "", path: "decisions/ADR-999-test.md", added_text: "**Status:** Accepted\n", removed_text: "" });
  });

  it("carries a file.patch's expected text as removed and its replacement as added", () => {
    const { bus, seen } = captureBus();

    expect(bus.wrapToolPort(filePort("file.patch")).preflight?.(writeRequest({ path: "decisions/ADR-999-test.md", expected: "**Status:** Proposed", replacement: "**Status:** Accepted" }))?.allowed).toBe(true);

    // The two halves are what let a claim-guard discharge an edit that did
    // not INTRODUCE the marker: without `removed_text` a pre-existing marker
    // and an introduced one are indistinguishable, and the guard's single
    // most important behaviour is unrepresentable.
    expect(seen.at(-1)?.tool_input).toEqual({ command: "", path: "decisions/ADR-999-test.md", added_text: "**Status:** Accepted", removed_text: "**Status:** Proposed" });
  });

  it("redacts and bounds the carried text rather than passing the payload through", () => {
    const { bus, seen } = captureBus();
    const payload = `token=${"s3cret".repeat(40)} ${"padding ".repeat(4_000)}`;

    bus.wrapToolPort(filePort("file.write")).preflight?.(writeRequest({ path: "notes/secret.md", content: payload }));

    const carried = seen.at(-1)?.tool_input;
    expect(carried?.path).toBe("notes/secret.md");
    expect(carried?.added_text).toContain("[REDACTED]");
    expect(carried?.added_text).not.toContain("s3crets3cret");
    // Bounded: strictly shorter than the payload it was built from, and a
    // plain head slice — never the raw caller's string.
    expect(carried?.added_text?.length).toBeLessThan(payload.length);
    expect(carried?.added_text).not.toBe(payload);
  });

  it("gives a tool that neither runs a command nor writes a file the empty sentinel", () => {
    const { bus, seen } = captureBus();

    // The payload deliberately carries `path` and `content`: only the tool
    // name decides, so a `file.write` is never judged by a git-write rule
    // and an `extension.write` is never judged by a file-write rule.
    bus.wrapToolPort(filePort("extension.write")).preflight?.(writeRequest({ command: "git push", path: "decisions/ADR-999-test.md", content: "**Status:** Accepted\n" }));

    expect(seen.at(-1)?.tool_input).toEqual({ command: "", path: "", added_text: "", removed_text: "" });
  });

  it("loads the shipped default set from disk with no diagnostic", () => {
    expect(catalog.diagnostics()).toEqual([]);
    expect(catalog.list().map((hook) => hook.handler_ref)).toEqual(expect.arrayContaining([
      "veto.git-write-guard", "inject.governance-orient", "inject.session-isolation", "inject.owed-decisions",
    ]));
  });

  it("refuses a subagent `git reset --hard` through wrapToolPort, and only from subagent context", () => {
    const bus = new HookBus({ catalog });

    const denied = bus.wrapToolPort(shellPort(), { subagent: true }).preflight?.(resetRequest());

    expect(denied?.allowed).toBe(false);
    expect(denied?.allowed === false && denied.code).toBe("hook_denied");
    expect(denied?.allowed === false && denied.reason).toContain("git-write-guard");
    // The chain is the AND of every veto, so the ledger records each guard it
    // reached — the file-writing guards that allow a shell call, and this one
    // that refuses it. Asserting the decision PER HOOK rather than the ledger's
    // exact length is what this test means: the single-row shape was an
    // accident of there having been exactly one veto descriptor, and adding
    // the claim guard made it two without changing what happened here.
    const fired = bus.ledger().map((entry) => `${entry.hook_id}=${entry.decision}`);
    expect(fired).toContain("subagent-git-write-guard=deny");
    expect(fired.filter((row) => row.endsWith("=deny"))).toEqual(["subagent-git-write-guard=deny"]);

    // The orchestrator is the only party allowed to commit; the handler must
    // not extend the shell hook's own guarantee by blocking it too.
    const bus2 = new HookBus({ catalog });
    expect(bus2.wrapToolPort(shellPort(), { subagent: false }).preflight?.(resetRequest())).toEqual({ allowed: true });
  });

  it("fires all three session_start inject handlers and renders their tropisms", async () => {
    const bus = new HookBus({ catalog });

    const scope = await bus.injectForSession("session_start", { session_id: "s-1", campaign_id: "c-1", node_id: "n-1", turn: 0 });

    // The ledger's `injected=<id>` is the structural token the bus itself
    // emits per firing (and dedupes on), so this asserts on dispatch rather
    // than on the prose a tropism body happens to be worded with.
    const injected = bus.ledger().filter((entry) => entry.kind === "inject").map((entry) => entry.evidence_ref);
    expect(injected).toEqual(expect.arrayContaining([
      expect.stringContaining("injected=governance-orient"),
      expect.stringContaining("injected=session-isolation"),
      expect.stringContaining("injected=owed-decisions"),
    ]));
    expect(injected.filter((entry) => entry.includes("refused="))).toEqual([]);
    expect(scope.content).not.toBe("");
    expect(scope.truncated).toBe(false);
  });
});
