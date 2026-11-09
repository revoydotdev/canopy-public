import { describe, expect, it } from "vitest";
import type { LoopExecutor } from "@arbor/opencode";
import { createNativeLoopExecutor, NATIVE_LOOP_DEFAULT_MAX_WALL_CLOCK_MS, type NativeLoopSessionRecord } from "../src/native-loop-executor.js";

describe("native campaign loop adapter", () => {
  it("keeps the outer supervision envelope larger than the specialist and verifier budgets it contains", () => {
    expect(NATIVE_LOOP_DEFAULT_MAX_WALL_CLOCK_MS).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it("supervises connector dispatch and preserves its provenance and usage", async () => {
    const sessions: NativeLoopSessionRecord[] = [];
    const downstream: LoopExecutor = {
      async specialize() {
        return {
          output: "changed files",
          provenance: { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "sha256:test" },
          token_usage: { kind: "unavailable", reason: "fixture" },
        };
      },
      async review() {
        return { approved: true, rationale: "sound", token_usage: { kind: "unavailable", reason: "fixture" } };
      },
    };
    const executor = createNativeLoopExecutor({ downstream, on_session: (record) => sessions.push(record) });
    const specialist = await executor.specialize({
      campaign_id: "campaign", node_id: "node", action: { description: "task", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
      prompt: "implement", worktree_path: "/workspace", specialist_agent: "seed",
    });

    expect(specialist.provenance.tag).toBe("verified");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ operation: "specialize", inspection: { state: "completed", terminal: { result: "verified" } } });
    expect(sessions[0]!.inspection.capabilities.map((entry) => entry.capability)).not.toContain("tool_policy");
    expect(sessions[0]!.inspection.capabilities.map((entry) => entry.capability)).not.toContain("approval_mediation");
    expect(sessions[0]!.events.map((event) => event.kind)).toEqual(["lifecycle", "model_text", "terminal"]);
    expect(sessions[0]!.events[1]).toMatchObject({ kind: "model_text", payload: { text: "changed files", phase: "final" } });
  });

  it("settles cancellation without manufacturing a connector result", async () => {
    const controller = new AbortController();
    const downstream: LoopExecutor = {
      async specialize() { controller.abort(); throw new Error("cancelled downstream"); },
      async review() { throw new Error("unused"); },
    };
    const executor = createNativeLoopExecutor({ downstream });

    await expect(executor.specialize({
      campaign_id: "campaign", node_id: "node", action: { description: "task", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
      prompt: "implement", worktree_path: "/workspace", specialist_agent: "seed", signal: controller.signal,
    })).rejects.toThrow("ended before connector returned");
  });

  it("converts a terminal wall-clock race into one durable typed timeout without accepting late output", async () => {
    const sessions: NativeLoopSessionRecord[] = [];
    let downstreamAborted = false;
    let verificationCalls = 0;
    let resolveLate: ((value: Awaited<ReturnType<LoopExecutor["specialize"]>>) => void) | undefined;
    const lateResult = new Promise<Awaited<ReturnType<LoopExecutor["specialize"]>>>((resolve) => { resolveLate = resolve; });
    const downstream: LoopExecutor = {
      async specialize(params) {
        params.signal?.addEventListener("abort", () => { downstreamAborted = true; }, { once: true });
        return lateResult;
      },
      async review() { throw new Error("unused"); },
    };
    const executor = createNativeLoopExecutor({
      downstream,
      max_wall_clock_ms: 5,
      on_session: (record) => sessions.push(record),
      specialist_verification: {
        async verify() {
          verificationCalls += 1;
          return { message: "must not verify late output", provenance: { tag: "verified", cmd: "late", exit: 0, stdout_hash: "sha256:late" }, command_argv: ["late"] };
        },
      },
    });

    const startedAt = Date.now();
    const result = await executor.specialize({
      campaign_id: "campaign", node_id: "node", action: { description: "task", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
      prompt: "implement", worktree_path: "/workspace", specialist_agent: "seed",
    });

    expect(downstreamAborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.inspection.terminal?.cause).toBe("wall_clock_limit");
    expect(result).toMatchObject({
      output: "",
      error: { kind: "timeout", provenance: { tag: "claimed", claimant: "native-loop-executor" } },
    });
    expect(result.verification_evidence).toBeUndefined();
    expect(verificationCalls).toBe(0);
    resolveLate?.({
      output: "late implementation that must be discarded",
      provenance: { tag: "verified", cmd: "late check", exit: 0, stdout_hash: "sha256:late" },
      token_usage: { kind: "unavailable", reason: "fixture" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions).toHaveLength(1);
    expect(verificationCalls).toBe(0);
  });

  it("binds independent verification to the actual supervised specialist session", async () => {
    const observed: string[] = [];
    const downstream: LoopExecutor = {
      async specialize() {
        return { output: "changed", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "fixture" } };
      },
      async review() { throw new Error("unused"); },
    };
    const executor = createNativeLoopExecutor({
      downstream,
      specialist_verification: {
        async verify(input) {
          observed.push(input.session_id);
          return { message: "machine check passed", provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test" }, command_argv: ["test"] };
        },
      },
    });

    const result = await executor.specialize({
      campaign_id: "campaign", node_id: "node", action: { description: "task", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
      prompt: "implement", worktree_path: "/workspace", specialist_agent: "seed",
    });

    expect(result).toMatchObject({ provenance: { tag: "verified" }, verification_evidence: "machine check passed" });
    expect(observed).toEqual([expect.stringMatching(/^campaign:node:specialize:/)]);
  });
});
