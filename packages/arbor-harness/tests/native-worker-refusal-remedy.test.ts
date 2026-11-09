import { describe, expect, it } from "vitest";

import type { CapabilitySupport } from "../src/capabilities.js";
import { NativeSessionEngine } from "../src/native-session.js";
import { NativeHarnessWorker, type NativeModelPort, type NativeModelRequest, type NativeToolPort, type NativeToolPreflightResult, type NativeToolResponse } from "../src/native-worker.js";
import type { ExecutionPolicy, SessionStartRequest } from "../src/protocol.js";

/** The v2 refusal contract as the worker's own preflight result declares it (harness tests may not import core). */
type RuntimeGateRefusalV2 = NonNullable<Extract<NativeToolPreflightResult, { allowed: false }>["remedy"]>;

/**
 * A refusal's typed remedy (the v2 refusal contract) through the real worker
 * dispatch: a governed hook's policy veto reaches the model as a recoverable
 * tool result carrying the remedy it names; a failed veto authority stays
 * terminal; a remedy owned by another actor is never rendered to the model;
 * and a malformed remedy is an invalid admission rather than silently dropped.
 */

const capabilities: readonly CapabilitySupport[] = ["streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting"].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "native-refusal-remedy", observed_at: "2026-10-06T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

function start(sessionId: string, overrides: Partial<ExecutionPolicy> = {}): SessionStartRequest {
  return {
    session_id: sessionId,
    policy: {
      filesystem: "read_only", approvals: "never", tool_allow: ["write"], tool_deny: [], workspace_roots: ["/workspace"],
      max_wall_clock_ms: 100, max_events: 20, network_allowed: false, ambient_plugins_allowed: false,
      user_configuration_allowed: false, inherited_credentials_allowed: false, ...overrides,
    },
    required_capabilities: [], lineage: { kind: "new" }, ephemeral: false,
  };
}

const refused = (code: string): NativeToolResponse["evidence"] => ({ outcome: "refused", stage: "audit", code, effect: "none", action_scope: { status: "not_required" } });

const vetoRemedy: RuntimeGateRefusalV2 = {
  schema_version: 2, kind: "gate.refusal", state: "refused", gate: "tool_veto", code: "hook_denied",
  summary: "denied by hook deny-write@1.0.0: writes are frozen", evidence_deficit: null,
  remediation: "Do not repeat this call. Choose a different action the vetoing policy permits.",
  correcting_actor: "specialist", corrective_action: "revise_tool_call",
};

function twoTurnModel(requests: NativeModelRequest[]): NativeModelPort {
  return {
    async run(request) {
      requests.push(request);
      return requests.length === 1
        ? { text: [], tool_calls: [{ call_id: "w1", tool: "write", input: { path: "a.md" }, input_summary: "write", risk: "high" }], final_message: null }
        : { text: [{ text: "done", phase: "final" }], tool_calls: [], final_message: "done" };
    },
  };
}

function vetoingPort(preflight: NativeToolPort["preflight"], onExecute: () => void): NativeToolPort {
  return { tool: "write", preflight, async execute() { onExecute(); return { result_summary: "unexpected", model_output: "unexpected", evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "applied", action_scope: { status: "not_required" } } }; } };
}

describe("NativeHarnessWorker refusal remedies", () => {
  it("delivers a policy veto and its specialist remedy to the model, and the session continues without executing the call", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const requests: NativeModelRequest[] = [];
    let executed = false;
    const port = vetoingPort(() => ({ allowed: false, code: "hook_denied", reason: vetoRemedy.summary, evidence: refused("hook_denied"), remedy: vetoRemedy }), () => { executed = true; });

    const result = await new NativeHarnessWorker({ session_engine: engine, model: twoTurnModel(requests), tools: [port] }).run({ start: start("veto-recover"), prompt: "write", max_turns: 2 });

    expect(executed).toBe(false);
    expect(result.session.state).toBe("completed");
    const delivered = requests[1]?.history.find((entry) => entry.kind === "tool_result" && entry.call_id === "w1");
    expect(delivered?.kind === "tool_result" && delivered.text).toBe(
      "denied by hook deny-write@1.0.0: writes are frozen\nCorrecting actor: specialist. Corrective action: revise_tool_call. Remedy: Do not repeat this call. Choose a different action the vetoing policy permits.",
    );
    // The audit trail still records the refusal itself.
    expect(engine.observe("veto-recover").find((event) => event.kind === "tool_result")).toMatchObject({ payload: { success: false, evidence: { outcome: "refused", code: "hook_denied" } } });
  });

  it("keeps a failed veto authority terminal; its runtime-host remedy is never offered to the model", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const requests: NativeModelRequest[] = [];
    const unavailable: RuntimeGateRefusalV2 = { ...vetoRemedy, state: "unavailable", code: "hook_veto_failed", summary: "denied by hook deny-write@1.0.0: handler threw", correcting_actor: "runtime_host", corrective_action: "compose_gate_authority", remediation: "Repair or remove the failing veto hook." };
    const port = vetoingPort(() => ({ allowed: false, code: "hook_veto_failed", reason: unavailable.summary, evidence: refused("hook_veto_failed"), remedy: unavailable }), () => undefined);

    const result = await new NativeHarnessWorker({ session_engine: engine, model: twoTurnModel(requests), tools: [port] }).run({ start: start("veto-failed"), prompt: "write", max_turns: 2 });

    expect(requests).toHaveLength(1);
    expect(result.session.terminal).toEqual({ state: "failed", cause: "failed", message: "denied by hook deny-write@1.0.0: handler threw" });
  });

  it("does not render a remedy owned by another actor into a recoverable refusal", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const requests: NativeModelRequest[] = [];
    const operatorOwned: RuntimeGateRefusalV2 = { ...vetoRemedy, gate: "budget", code: "usage_budget", correcting_actor: "operator", corrective_action: "raise_budget", remediation: "Raise the ceiling." };
    const port = vetoingPort(() => ({ allowed: false, code: "hook_denied", reason: "denied by hook deny-write@1.0.0: frozen", evidence: refused("hook_denied"), remedy: operatorOwned }), () => undefined);

    await new NativeHarnessWorker({ session_engine: engine, model: twoTurnModel(requests), tools: [port] }).run({ start: start("veto-operator-remedy"), prompt: "write", max_turns: 2 });

    const delivered = requests[1]?.history.find((entry) => entry.kind === "tool_result");
    expect(delivered?.kind === "tool_result" && delivered.text).toBe("denied by hook deny-write@1.0.0: frozen");
  });

  it("treats a malformed remedy as an invalid admission and ends the session", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const requests: NativeModelRequest[] = [];
    // A valid action key handed to an actor who cannot perform it is not a remedy.
    const forged = { ...vetoRemedy, correcting_actor: "operator" } as RuntimeGateRefusalV2;
    const port = vetoingPort(() => ({ allowed: false, code: "hook_denied", reason: "denied", evidence: refused("hook_denied"), remedy: forged }), () => undefined);

    const result = await new NativeHarnessWorker({ session_engine: engine, model: twoTurnModel(requests), tools: [port] }).run({ start: start("veto-forged"), prompt: "write", max_turns: 2 });

    expect(requests).toHaveLength(1);
    expect(result.session.terminal).toMatchObject({ state: "failed", message: "tool host returned an invalid action-specific admission" });
  });
});
