import { describe, expect, it } from "vitest";

import type { CapabilitySupport } from "../src/capabilities.js";
import { NativeSessionEngine } from "../src/native-session.js";
import { NATIVE_WORKER_REFUSAL_LOOP_CODE, NATIVE_WORKER_REFUSAL_LOOP_LIMIT, NativeHarnessWorker, nativeWorkerRefusalLoopRemedy, type NativeApprovalPort, type NativeModelPort, type NativeToolCall, type NativeToolPort, type NativeToolResponse } from "../src/native-worker.js";
import type { ExecutionPolicy, SessionStartRequest } from "../src/protocol.js";

/**
 * The worker's no-progress breaker: refusals the worker itself issues (a
 * governed hook's veto, an approver's denial, a tool outside the composed set)
 * never reach the repository tool host, so the host's breaker cannot count
 * them. A model that re-proposes the identical refused call is stopped after
 * the same limit, with the remedy that refusal kind's correcting actor owns.
 */

const capabilities: readonly CapabilitySupport[] = ["streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting"].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "native-worker-refusal-loop", observed_at: "2026-10-06T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

function start(sessionId: string, overrides: Partial<ExecutionPolicy> = {}): SessionStartRequest {
  return {
    session_id: sessionId,
    policy: {
      filesystem: "read_only", approvals: "never", tool_allow: ["write"], tool_deny: [], workspace_roots: ["/workspace"],
      max_wall_clock_ms: 1_000, max_events: 200, network_allowed: false, ambient_plugins_allowed: false,
      user_configuration_allowed: false, inherited_credentials_allowed: false, ...overrides,
    },
    required_capabilities: [], lineage: { kind: "new" }, ephemeral: false,
  };
}

/** A model that never adapts: it proposes `calls[turn]`, then the last one forever. */
function stubborn(calls: readonly NativeToolCall[]): { model: NativeModelPort; turns: () => number } {
  let turn = 0;
  return {
    turns: () => turn,
    model: { async run() { turn += 1; return { text: [], tool_calls: [calls[Math.min(turn, calls.length) - 1]!], final_message: null }; } },
  };
}

const write = (path: string, turn = 0, risk: "low" | "high" = "low"): NativeToolCall => ({ call_id: `w-${path}-${turn}`, tool: "write", input: { path }, input_summary: "write", risk });
const refusedEvidence = (code: string): NativeToolResponse["evidence"] => ({ outcome: "refused", stage: "audit", code, effect: "none", action_scope: { status: "not_required" } });

function vetoedPort(onExecute: () => void): NativeToolPort {
  return {
    tool: "write",
    preflight: () => ({ allowed: false, code: "hook_denied", reason: "denied by hook freeze@1.0.0: writes are frozen", evidence: refusedEvidence("hook_denied") }),
    async execute() { onExecute(); return { result_summary: "unexpected", model_output: "unexpected", evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "applied", action_scope: { status: "not_required" } } }; },
  };
}

function terminal(engine: NativeSessionEngine, sessionId: string) {
  const events = engine.observe(sessionId);
  return {
    diagnostic: events.flatMap((event) => event.kind === "diagnostic" ? [event.payload] : []).at(-1),
    lastToolResult: events.flatMap((event) => event.kind === "tool_result" ? [event.payload] : []).at(-1),
  };
}

describe("NativeHarnessWorker refusal loop breaker", () => {
  it("stops a model re-proposing a vetoed call, after the limit, with the specialist's revise_tool_call remedy", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    let executed = false;
    const { model, turns } = stubborn([write("a.md")]);

    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [vetoedPort(() => { executed = true; })] }).run({ start: start("veto-loop"), prompt: "write", max_turns: 30 });

    expect(executed).toBe(false);
    // LIMIT vetoes reach the model; the next identical proposal ends the session.
    expect(turns()).toBe(NATIVE_WORKER_REFUSAL_LOOP_LIMIT + 1);
    expect(result.session.state).toBe("failed");
    const { diagnostic, lastToolResult } = terminal(engine, "veto-loop");
    expect(diagnostic?.code).toBe(NATIVE_WORKER_REFUSAL_LOOP_CODE);
    // The stopped call is recorded under the refusal it repeats; that code is
    // what lets the node outcome name the right correcting actor.
    expect(lastToolResult).toMatchObject({ tool: "write", success: false, evidence: { outcome: "refused", code: "hook_denied" } });
    const remedy = nativeWorkerRefusalLoopRemedy("hook_denied", "write");
    expect(remedy).toMatchObject({ schema_version: 2, kind: "gate.refusal", state: "refused", gate: "tool_veto", correcting_actor: "specialist", corrective_action: "revise_tool_call", code: NATIVE_WORKER_REFUSAL_LOOP_CODE });
    expect(diagnostic?.message).toBe(`${remedy.summary} ${remedy.remediation}`);
  });

  it("stops a model re-proposing a call the approver denied, asking the approver only once", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    let asked = 0;
    const approvals: NativeApprovalPort = { async decide() { asked += 1; return { approved: false, rationale: "not this file" }; } };
    let executed = false;
    const port: NativeToolPort = { tool: "write", async execute() { executed = true; return { result_summary: "unexpected", model_output: "unexpected", evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "applied", action_scope: { status: "not_required" } } }; } };
    const { model, turns } = stubborn([write("b.md", 0, "high")]);

    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [port], approvals }).run({ start: start("approval-loop", { approvals: "on_risk" }), prompt: "write", max_turns: 30 });

    expect(executed).toBe(false);
    expect(asked).toBe(1);
    expect(turns()).toBe(NATIVE_WORKER_REFUSAL_LOOP_LIMIT + 1);
    expect(result.session.state).toBe("failed");
    const { diagnostic, lastToolResult } = terminal(engine, "approval-loop");
    expect(diagnostic?.code).toBe(NATIVE_WORKER_REFUSAL_LOOP_CODE);
    expect(lastToolResult).toMatchObject({ evidence: { code: "approval_denied" } });
    expect(nativeWorkerRefusalLoopRemedy("approval_denied", "write")).toMatchObject({ gate: "tool_veto", correcting_actor: "specialist", corrective_action: "revise_tool_call" });
  });

  it("stops a model re-calling a tool outside its composed set, with the operator's grant_capability remedy", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const { model, turns } = stubborn([{ call_id: "u", tool: "bash", input: { cmd: "ls" }, input_summary: "bash", risk: "low", uncomposed: { available_tools: ["write"] } }]);

    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [vetoedPort(() => undefined)] }).run({ start: start("uncomposed-loop"), prompt: "list", max_turns: 30 });

    expect(turns()).toBe(NATIVE_WORKER_REFUSAL_LOOP_LIMIT + 1);
    expect(result.session.state).toBe("failed");
    const { diagnostic, lastToolResult } = terminal(engine, "uncomposed-loop");
    expect(diagnostic?.code).toBe(NATIVE_WORKER_REFUSAL_LOOP_CODE);
    expect(lastToolResult).toMatchObject({ tool: "bash", evidence: { code: "tool_not_composed" } });
    expect(nativeWorkerRefusalLoopRemedy("tool_not_composed", "bash")).toMatchObject({ gate: "capability", correcting_actor: "operator", corrective_action: "grant_capability" });
  });

  it("does not trip on distinct refused calls, however many: only an identical re-proposal is no progress", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    let turn = 0;
    const distinct = NATIVE_WORKER_REFUSAL_LOOP_LIMIT + 2;
    const model: NativeModelPort = { async run() {
      turn += 1;
      return turn <= distinct
        ? { text: [], tool_calls: [write(`file-${turn}.md`, turn)], final_message: null }
        : { text: [], tool_calls: [], final_message: "gave up on writing" };
    } };

    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [vetoedPort(() => undefined)] }).run({ start: start("distinct-vetoes"), prompt: "write", max_turns: 30 });

    expect(result.session.terminal).toMatchObject({ state: "completed", message: "gave up on writing" });
    expect(engine.observe("distinct-vetoes").some((event) => event.kind === "diagnostic" && event.payload.code === NATIVE_WORKER_REFUSAL_LOOP_CODE)).toBe(false);
  });
});
