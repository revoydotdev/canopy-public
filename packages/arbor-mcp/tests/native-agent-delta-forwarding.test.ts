import { describe, expect, it } from "vitest";
import type { CapabilitySupport, NativeInferenceDelta, NativeModelPort } from "@arbor/harness";
import { NativeAgentExecutor, type NativeAgentExecutorModelDeltaRecord } from "../src/native-agent-executor.js";

const capabilities: readonly CapabilitySupport[] = [
  "streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting",
].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "native-agent-delta-forwarding-test", observed_at: "2026-08-26T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("ADR-104 O3: interactive delta-forwarding sink", () => {
  it("forwards each NativeInferenceDelta to on_model_delta the instant it is yielded, strictly ahead of the batched final result", async () => {
    // A model port whose `.stream()` deliberately blocks between its first
    // and second delta, controlled entirely by this test via `secondGate`.
    // If `native-agent-executor.ts` buffered deltas before forwarding any of
    // them to the sink (the exact defect ADR-104 O3 fixes), `firstArrived`
    // below could never resolve: the model's async generator is paused mid
    // -stream, so no batch collection could have completed yet. Only a sink
    // that is invoked synchronously inside the consuming `for await` loop,
    // ahead of `collectNativeStream`'s accumulation, can make this test pass.
    const secondGate = deferred<void>();

    const model: NativeModelPort = {
      async run() {
        throw new Error("run() must not be used when the port exposes stream()");
      },
      async *stream(): AsyncIterable<NativeInferenceDelta> {
        yield { kind: "text", text: "chunk-one", phase: "commentary" };
        await secondGate.promise;
        yield { kind: "text", text: "chunk-two", phase: "commentary" };
        yield { kind: "final", message: "chunk-onechunk-two" };
      },
    };

    const observed: NativeAgentExecutorModelDeltaRecord[] = [];
    const firstArrived = deferred<void>();
    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace",
      capabilities,
      model_for_role: () => model,
      on_model_delta: (record) => {
        observed.push(record);
        if (record.delta.kind === "text" && record.delta.text === "chunk-one") firstArrived.resolve();
      },
    });

    const specializePromise = executor.specialize({
      campaign_id: "c", node_id: "n", action: {}, prompt: "stream this turn incrementally",
      worktree_path: "", specialist_agent: "seed", session_id: "stream-session",
    });

    // Wait for the real event -- the sink actually being invoked with the
    // first delta -- rather than polling or sleeping. This can only resolve
    // while the model's generator is still parked on `secondGate`, proving
    // the forward happened before the second delta (let alone the finished
    // message) existed at all.
    await firstArrived.promise;

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      session_id: "stream-session", campaign_id: "c", node_id: "n",
      delta: { kind: "text", text: "chunk-one", phase: "commentary" },
    });

    // Release the model's generator and let the turn actually finish.
    secondGate.resolve();
    const result = await specializePromise;

    expect(result.output).toBe("chunk-onechunk-two");
    expect(observed).toHaveLength(3);
    expect(observed.map((record) => record.delta)).toEqual([
      { kind: "text", text: "chunk-one", phase: "commentary" },
      { kind: "text", text: "chunk-two", phase: "commentary" },
      { kind: "final", message: "chunk-onechunk-two" },
    ]);
    expect(observed.every((record) => record.session_id === "stream-session" && record.campaign_id === "c" && record.node_id === "n")).toBe(true);
  });

  it("never attaches the sink to a model port with no stream(), and the batch path is unaffected", async () => {
    const observed: NativeAgentExecutorModelDeltaRecord[] = [];
    const model: NativeModelPort = {
      async run() {
        return { text: [{ text: "done", phase: "final" }], tool_calls: [], final_message: "done" };
      },
    };
    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace",
      capabilities,
      model_for_role: () => model,
      on_model_delta: (record) => observed.push(record),
    });

    const result = await executor.specialize({
      campaign_id: "c", node_id: "n2", action: {}, prompt: "no streaming transport here",
      worktree_path: "", specialist_agent: "seed", session_id: "no-stream-session",
    });

    expect(result.output).toBe("done");
    expect(observed).toHaveLength(0);
  });
});
