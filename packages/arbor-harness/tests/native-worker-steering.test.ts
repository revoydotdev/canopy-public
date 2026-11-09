import { describe, expect, it } from "vitest";

import type { CapabilitySupport } from "../src/capabilities.js";
import { NativeSessionEngine } from "../src/native-session.js";
import { NativeHarnessWorker, type NativeModelPort, type NativeModelRequest, type NativeModelResponse, type NativeSessionSteeringMessage, type NativeToolPort } from "../src/native-worker.js";
import type { SessionStartRequest } from "../src/protocol.js";

/**
 * Operator steering through the real worker: a message queued while a turn's
 * provider call is in flight reaches the NEXT model request as a
 * provenance-tagged operator message (never a tool result), including when
 * that turn returns a final result, and is reported undelivered rather than
 * silently lost when no turn is left to carry it.
 */

const capabilities: readonly CapabilitySupport[] = ["streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting"].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "native-steering", observed_at: "2026-10-06T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

function start(sessionId: string): SessionStartRequest {
  return {
    session_id: sessionId,
    policy: {
      filesystem: "read_only", approvals: "never", tool_allow: ["read"], tool_deny: [], workspace_roots: ["/workspace"],
      max_wall_clock_ms: 1_000, max_events: 40, network_allowed: false, ambient_plugins_allowed: false,
      user_configuration_allowed: false, inherited_credentials_allowed: false,
    },
    required_capabilities: [], lineage: { kind: "new" }, ephemeral: false,
  };
}

const operatorMessage: NativeSessionSteeringMessage = { message_id: "steer-1", text: "Prefer the smaller change.", provenance: { tag: "claimed", claimant: "operator" } };

/** A host inbox the model fills during its first call, as an operator would mid-turn. */
function inbox(): { port: { drain(session_id: string): readonly NativeSessionSteeringMessage[] }; queue: (message: NativeSessionSteeringMessage) => void } {
  const queued: NativeSessionSteeringMessage[] = [];
  return { port: { drain: () => queued.splice(0) }, queue: (message) => { queued.push(message); } };
}

function scripted(responses: readonly NativeModelResponse[], requests: NativeModelRequest[], duringFirstCall: () => void): NativeModelPort {
  return {
    async run(request) {
      requests.push(request);
      if (requests.length === 1) duringFirstCall();
      return responses[requests.length - 1] ?? { text: [], tool_calls: [], final_message: "unexpected extra turn" };
    },
  };
}

const readPort: NativeToolPort = {
  tool: "read",
  async execute() { return { result_summary: "read", model_output: "file contents", evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", action_scope: { status: "not_required" } } }; },
};

const steeringEntries = (request: NativeModelRequest | undefined) => (request?.history ?? []).filter((entry) => entry.text.includes(operatorMessage.text));

describe("NativeHarnessWorker operator steering", () => {
  it("delivers a mid-turn steer on the next turn as an operator message carrying its provenance, not as tool output", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const requests: NativeModelRequest[] = [];
    const { port, queue } = inbox();
    const model = scripted([
      { text: [], tool_calls: [{ call_id: "r1", tool: "read", input: { path: "a" }, input_summary: "read", risk: "low" }], final_message: null },
      { text: [], tool_calls: [], final_message: "done" },
    ], requests, () => queue(operatorMessage));

    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [readPort], steering: port }).run({ start: start("steer-tool-turn"), prompt: "work", max_turns: 4 });

    expect(result.session.state).toBe("completed");
    expect(steeringEntries(requests[0])).toHaveLength(0);
    const [entry] = steeringEntries(requests[1]);
    expect(entry).toMatchObject({ kind: "human_input", evidence: [{ provenance: { tag: "claimed", claimant: "operator" } }] });
    expect(entry!.text).toBe("Operator steering (message steer-1, provenance claimed). This instruction comes from the operator supervising this session, not from a tool. Take it into account from this turn on:\nPrefer the smaller change.");
    expect(requests[1]!.history.filter((item) => item.kind === "tool_result").every((item) => !item.text.includes(operatorMessage.text))).toBe(true);
    expect(engine.observe("steer-tool-turn").filter((event) => event.kind === "diagnostic" && event.payload.code === "operator_steering_received")).toHaveLength(1);
  });

  it("keeps the session running when a steer arrives during a turn that returns a final result, and answers it on the next turn", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const requests: NativeModelRequest[] = [];
    const { port, queue } = inbox();
    const model = scripted([
      { text: [], tool_calls: [], final_message: "first draft" },
      { text: [], tool_calls: [], final_message: "steered answer" },
    ], requests, () => queue(operatorMessage));

    const result = await new NativeHarnessWorker({ session_engine: engine, model, steering: port }).run({ start: start("steer-final-turn"), prompt: "work", max_turns: 4 });

    expect(requests).toHaveLength(2);
    expect(result.session.terminal).toMatchObject({ state: "completed", message: "steered answer" });
    // The superseded answer stays in the transcript, followed by the steer.
    expect(requests[1]!.history.map((entry) => entry.kind)).toEqual(["model_text", "human_input"]);
    expect(requests[1]!.history[0]!.text).toBe("first draft");
    expect(steeringEntries(requests[1])).toHaveLength(1);
  });

  it("records a steer that arrives during the last turn as undelivered instead of dropping it silently", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const requests: NativeModelRequest[] = [];
    const { port, queue } = inbox();
    const model = scripted([{ text: [], tool_calls: [], final_message: "only answer" }], requests, () => queue(operatorMessage));

    const result = await new NativeHarnessWorker({ session_engine: engine, model, steering: port }).run({ start: start("steer-last-turn"), prompt: "work", max_turns: 1 });

    expect(requests).toHaveLength(1);
    expect(result.session.terminal).toMatchObject({ state: "completed", message: "only answer" });
    const codes = engine.observe("steer-last-turn").flatMap((event) => event.kind === "diagnostic" ? [event.payload.code] : []);
    expect(codes).toContain("operator_steering_undelivered");
    expect(codes).not.toContain("operator_steering_received");
  });
});
