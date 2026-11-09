/**
 * The worker-level refusal-loop breaker through the production composition:
 * a governed hook veto composed by `HookBus.wrapToolPort`, and a tool outside
 * the session's composed set, re-proposed identically by a model that never
 * adapts. Neither refusal reaches the repository tool host, so only the
 * worker's breaker can stop them, and the node outcome must carry the remedy
 * of that refusal's own correcting actor (ADR-179), not the host breaker's
 * campaign-planner remedy.
 */
import { describe, expect, it } from "vitest";
import { isAuthorizedRefusalRemedy, isRuntimeGateRefusal } from "@arbor/core";
import { NATIVE_WORKER_REFUSAL_KINDS, NATIVE_WORKER_REFUSAL_LOOP_CODE, NATIVE_WORKER_REFUSAL_LOOP_LIMIT, nativeWorkerRefusalLoopRemedy, type CapabilitySupport, type NativeModelPort, type NativeToolCall } from "@arbor/harness";
import { NativeAgentExecutor } from "../src/native-agent-executor.js";
import { HookBus } from "../src/hooks/bus.js";
import { HookCatalog } from "../src/hooks/catalog.js";
import type { HookHandlerRegistry } from "../src/hooks/contracts.js";
import { NATIVE_TOOL_REFUSAL_LOOP_CODE, NATIVE_TOOL_REFUSAL_LOOP_LIMIT } from "../src/native-tool-host.js";

const capabilities = ["streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting"].map((capability) => ({
  capability, grade: "native",
  evidence: { implementation_id: "native-worker-refusal-loop-remedy", observed_at: "2026-10-06T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

function stubborn(call: NativeToolCall): { model: NativeModelPort; turns: () => number } {
  let turn = 0;
  return { turns: () => turn, model: { async run() { turn += 1; return { text: [], tool_calls: [{ ...call, call_id: `${call.call_id}-${turn}` }], final_message: null }; } } };
}

function vetoedWritePort(onExecute: () => void) {
  const handlers: HookHandlerRegistry = { "veto.freeze-writes": { kind: "veto", handler: (context) => context.tool === "extension.write" ? { allow: false, reason: "writes are frozen for this campaign" } : { allow: true } } };
  const catalog = new HookCatalog({ handlers });
  catalog.register(JSON.stringify({ schema_version: 1, hook_id: "freeze-writes", version: "1.0.0", kind: "veto", event: "tool_preflight", handler_ref: "veto.freeze-writes", why: "freeze writes" }));
  const bus = new HookBus({ catalog, handlers });
  const rawPort = Object.freeze({
    tool: "extension.write",
    model_definition: Object.freeze({ name: "extension.write", description: "write a note", parameters: { type: "object" as const }, risk: "low" as const }),
    async execute() {
      onExecute();
      return { result_summary: "wrote", model_output: "ok", evidence: { outcome: "succeeded" as const, stage: "execution" as const, code: "ok", effect: "applied" as const, action_scope: { status: "not_required" as const } } };
    },
  });
  return Object.freeze({ ...rawPort, ...bus.wrapToolPort(rawPort) });
}

describe("worker-level refusal loop breaker, through NativeAgentExecutor", () => {
  it("shares the host breaker's limit and terminal code, and every remedy it projects is one ADR-179's table authorizes", () => {
    expect(NATIVE_WORKER_REFUSAL_LOOP_LIMIT).toBe(NATIVE_TOOL_REFUSAL_LOOP_LIMIT);
    expect(NATIVE_WORKER_REFUSAL_LOOP_CODE).toBe(NATIVE_TOOL_REFUSAL_LOOP_CODE);
    for (const kind of NATIVE_WORKER_REFUSAL_KINDS) {
      const remedy = nativeWorkerRefusalLoopRemedy(kind, "extension.write");
      expect(isRuntimeGateRefusal(remedy)).toBe(true);
      expect(isAuthorizedRefusalRemedy(remedy.state, remedy.gate, remedy.correcting_actor, remedy.corrective_action)).toBe(true);
      // The host breaker's corrector is the planner; none of these is.
      expect(remedy.correcting_actor).not.toBe("campaign_planner");
    }
  });

  it("stops a model looping on a hook veto with the specialist's remedy, never executing the call", async () => {
    let executed = false;
    const { model, turns } = stubborn({ call_id: "veto", tool: "extension.write", input: { path: "note.md", content: "hi" }, input_summary: "write a note", risk: "low" });
    const executor = new NativeAgentExecutor({ workspace_root: "/workspace", capabilities, specialist_tools: () => [vetoedWritePort(() => { executed = true; })], model_for_role: () => model });

    const result = await executor.specialize({ campaign_id: "c", node_id: "veto-loop", action: {}, prompt: "write a note", worktree_path: "", specialist_agent: "seed" });

    expect(executed).toBe(false);
    expect(turns()).toBe(NATIVE_WORKER_REFUSAL_LOOP_LIMIT + 1);
    expect(result.error).toMatchObject({
      kind: "policy_refused", code: NATIVE_TOOL_REFUSAL_LOOP_CODE, recoverable: false,
      remedy: { schema_version: 2, kind: "gate.refusal", state: "refused", gate: "tool_veto", correcting_actor: "specialist", corrective_action: "revise_tool_call", code: NATIVE_TOOL_REFUSAL_LOOP_CODE },
    });
  });

  it("stops a model looping on an uncomposed tool with the operator's grant_capability remedy", async () => {
    const { model, turns } = stubborn({ call_id: "bash", tool: "bash", input: { cmd: "ls" }, input_summary: "list files", risk: "low", uncomposed: { available_tools: ["extension.write"] } });
    const executor = new NativeAgentExecutor({ workspace_root: "/workspace", capabilities, specialist_tools: () => [vetoedWritePort(() => undefined)], model_for_role: () => model });

    const result = await executor.specialize({ campaign_id: "c", node_id: "uncomposed-loop", action: {}, prompt: "list files", worktree_path: "", specialist_agent: "seed" });

    expect(turns()).toBe(NATIVE_WORKER_REFUSAL_LOOP_LIMIT + 1);
    expect(result.error).toMatchObject({
      kind: "policy_refused", code: NATIVE_TOOL_REFUSAL_LOOP_CODE, recoverable: false,
      remedy: { gate: "capability", correcting_actor: "operator", corrective_action: "grant_capability" },
    });
  });
});
