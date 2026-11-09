import { describe, expect, it } from "vitest";
import { NativeHarnessWorker, NativeSessionEngine, type ExecutionPolicy, type NativeConversationCheckpoint, type NativeModelRequest } from "../src/index.js";

const policy: ExecutionPolicy = {
  filesystem: "read_only", approvals: "never", tool_allow: [], tool_deny: [], workspace_roots: ["/workspace"],
  max_wall_clock_ms: 10_000, max_events: 20, network_allowed: false, ambient_plugins_allowed: false,
  user_configuration_allowed: false, inherited_credentials_allowed: false,
};

describe("protected native conversation checkpoints", () => {
  it("imports bounded history and checkpoints before dispatch plus the final response", async () => {
    const checkpoints: NativeConversationCheckpoint[] = [];
    const observed: NativeModelRequest[] = [];
    const engine = new NativeSessionEngine({ capabilities: [], clock: { now: () => 1 } });
    const worker = new NativeHarnessWorker({
      session_engine: engine,
      model: { async run(request) { observed.push(request); return { text: [], tool_calls: [], final_message: "completed result" }; } },
      on_checkpoint: (checkpoint) => checkpoints.push(checkpoint),
    });
    const result = await worker.run({
      start: { session_id: "resumed", policy, required_capabilities: [], lineage: { kind: "new" }, ephemeral: false },
      prompt: "continue the task", max_turns: 2,
      initial_history: [{ kind: "model_text", text: "prior bounded context" }],
    });
    expect(observed[0]?.history).toEqual([{ kind: "model_text", text: "prior bounded context" }]);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toMatchObject({ session_id: "resumed", next_turn: 1, captured_sequence: 1 });
    expect(checkpoints[1]?.history.at(-1)).toEqual({ kind: "model_text", text: "completed result" });
    expect(result.session.state).toBe("completed");
  });

  it("fails before provider dispatch when the protected checkpoint cannot be written", async () => {
    let calls = 0;
    const engine = new NativeSessionEngine({ capabilities: [], clock: { now: () => 1 } });
    const worker = new NativeHarnessWorker({
      session_engine: engine,
      model: { async run() { calls += 1; return { text: [], tool_calls: [], final_message: "must not run" }; } },
      on_checkpoint: () => { throw new Error("disk unavailable"); },
    });
    const result = await worker.run({ start: { session_id: "blocked", policy, required_capabilities: [], lineage: { kind: "new" }, ephemeral: false }, prompt: "task", max_turns: 1 });
    expect(calls).toBe(0);
    expect(result.session).toMatchObject({ state: "failed", terminal: { cause: "failed", message: "protected conversation checkpoint could not be persisted" } });
  });
});
