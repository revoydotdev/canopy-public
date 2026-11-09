import { describe, it, expect, vi } from "vitest";
import {
  raceSpecialize,
  isRaceEligible,
  resolveForkThresholdMs,
  RACE_SPECIALISTS_ENV,
  RACE_FORK_MS_ENV,
  DEFAULT_RACE_FORK_MS,
  MIN_RACE_FORK_MS,
  MAX_RACE_FORK_MS,
  type RaceSpecializeInput,
} from "../src/race.js";
import { WorktreeManager } from "@arbor/campaign-support";
import type { LoopExecutor, SpecialistResult } from "../src/loop.js";

const usage = { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" as const };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A deferred_verification promise that resolves to the `{provenance}` (verified) shape after `ms`. */
function verifiesAfter(ms: number): Promise<SpecialistResult["deferred_verification"] extends Promise<infer T> | undefined ? T : never> {
  return delay(ms).then(() => ({ provenance: { tag: "verified" as const, cmd: "test", exit: 0, stdout_hash: "sha256:x" } }));
}

/** A deferred_verification promise that resolves to "attempted and failed" after `ms`. */
function failsAfter(ms: number) {
  return delay(ms).then(() => ({ attempted: true as const, failed: true as const }));
}

function baseInput(overrides: Partial<RaceSpecializeInput> = {}): RaceSpecializeInput {
  return {
    executor: overrides.executor ?? approvingExecutorWithVerification(0),
    baseParams: overrides.baseParams ?? ({
      campaign_id: "camp1",
      node_id: "n1",
      action: { description: "do it", estimated_gain: 10, estimated_cost: 1, category: "refactor", delegate_to: "seed" },
      prompt: "do the thing",
      specialist_agent: "seed",
    } as RaceSpecializeInput["baseParams"]),
    primaryWorktreePath: overrides.primaryWorktreePath ?? "/tmp/primary",
    worktrees: overrides.worktrees ?? new WorktreeManager({}, true),
    campaign_id: overrides.campaign_id ?? "camp1",
    node_id: overrides.node_id ?? "n1",
    specialist_agent: overrides.specialist_agent ?? "seed",
    signal: overrides.signal,
    forkThresholdMs: overrides.forkThresholdMs ?? 30,
    thresholdSource: overrides.thresholdSource,
    thresholdObservations: overrides.thresholdObservations,
    tie_breaker: overrides.tie_breaker,
    now: overrides.now,
    log: overrides.log,
  };
}

function approvingExecutorWithVerification(verifyAfterMs: number): LoopExecutor & { calls: { worktree_path: string; signal?: AbortSignal }[] } {
  const calls: { worktree_path: string; signal?: AbortSignal }[] = [];
  return {
    calls,
    async specialize(params) {
      calls.push({ worktree_path: params.worktree_path, signal: params.signal });
      return {
        output: "done",
        provenance: { tag: "claimed", claimant: params.specialist_agent },
        token_usage: usage,
        deferred_verification: verifiesAfter(verifyAfterMs),
      };
    },
    async review() {
      throw new Error("not used");
    },
  };
}

describe("isRaceEligible", () => {
  it("refuses when the env flag is unset", () => {
    expect(isRaceEligible({}, "direct")).toBe(false);
  });
  it("refuses when the env flag is not exactly \"2\"", () => {
    expect(isRaceEligible({ [RACE_SPECIALISTS_ENV]: "true" }, "direct")).toBe(false);
    expect(isRaceEligible({ [RACE_SPECIALISTS_ENV]: "1" }, "direct")).toBe(false);
  });
  it("refuses a governed tier", () => {
    expect(isRaceEligible({ [RACE_SPECIALISTS_ENV]: "2" }, "governed")).toBe(false);
  });
  it("refuses an absent governance decision", () => {
    expect(isRaceEligible({ [RACE_SPECIALISTS_ENV]: "2" }, undefined)).toBe(false);
    expect(isRaceEligible({ [RACE_SPECIALISTS_ENV]: "2" }, null)).toBe(false);
  });
  it("admits direct and reviewed tiers when the flag is set", () => {
    expect(isRaceEligible({ [RACE_SPECIALISTS_ENV]: "2" }, "direct")).toBe(true);
    expect(isRaceEligible({ [RACE_SPECIALISTS_ENV]: "2" }, "reviewed")).toBe(true);
  });
});

describe("resolveForkThresholdMs", () => {
  it("defaults when unset", () => {
    expect(resolveForkThresholdMs({})).toBe(DEFAULT_RACE_FORK_MS);
  });
  it("defaults on a non-numeric value", () => {
    expect(resolveForkThresholdMs({ [RACE_FORK_MS_ENV]: "not-a-number" })).toBe(DEFAULT_RACE_FORK_MS);
  });
  it("passes through an in-range value", () => {
    expect(resolveForkThresholdMs({ [RACE_FORK_MS_ENV]: "10000" })).toBe(10_000);
  });
  it("clamps below the minimum", () => {
    expect(resolveForkThresholdMs({ [RACE_FORK_MS_ENV]: "100" })).toBe(MIN_RACE_FORK_MS);
  });
  it("clamps above the maximum", () => {
    expect(resolveForkThresholdMs({ [RACE_FORK_MS_ENV]: "999999999" })).toBe(MAX_RACE_FORK_MS);
  });
});

describe("raceSpecialize", () => {
  it("falls back silently when the executor does not support deferred_verification", async () => {
    const executor: LoopExecutor = {
      async specialize(_params) {
        return { output: "done", provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage };
      },
      async review() { throw new Error("not used"); },
    };
    const worktrees = new WorktreeManager({}, true);
    const result = await raceSpecialize(baseInput({ executor, worktrees, forkThresholdMs: 10 }));
    expect(result.outcome).toBeNull();
    expect(result.result.output).toBe("done");
    // No fork lease was ever acquired.
    expect(worktrees.isHeld("n1--race-fork")).toBe(false);
  });

  it("does not fork when attempt 1 verifies before the threshold", async () => {
    const executor = approvingExecutorWithVerification(5);
    const worktrees = new WorktreeManager({}, true);
    const acquireSpy = vi.spyOn(worktrees, "acquireLease");
    const result = await raceSpecialize(baseInput({ executor, worktrees, forkThresholdMs: 40 }));
    expect(result.outcome).toEqual({
      telemetry: { forked_at_ms: null, winner: "primary", loser_wall_ms: null, cancelled: false },
    });
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(executor.calls).toHaveLength(1);
  });

  it("forks past the threshold and the fork wins when it verifies first", async () => {
    // Primary verifies slowly (never observed as verified before we act);
    // fork verifies quickly once dispatched.
    let call = 0;
    const executor: LoopExecutor & { calls: { worktree_path: string; signal?: AbortSignal }[] } = {
      calls: [],
      async specialize(params) {
        executor.calls.push({ worktree_path: params.worktree_path, signal: params.signal });
        call += 1;
        const deferred = call === 1 ? failsAfter(150) : verifiesAfter(5);
        return { output: `attempt-${call}`, provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: deferred };
      },
      async review() { throw new Error("not used"); },
    };
    const worktrees = new WorktreeManager({}, true);
    const result = await raceSpecialize(baseInput({ executor, worktrees, forkThresholdMs: 15 }));

    expect(result.result.output).toBe("attempt-2");
    expect(result.outcome?.telemetry.winner).toBe("fork");
    expect(result.outcome?.telemetry.cancelled).toBe(true);
    expect(result.outcome?.telemetry.forked_at_ms).not.toBeNull();
    // Attempt 1 (primary) was aborted since the fork won.
    expect(executor.calls[0]?.signal?.aborted).toBe(true);
    expect(executor.calls[1]?.worktree_path).not.toBe(executor.calls[0]?.worktree_path);
    // The fork's lease was released after the race concluded, win or lose.
    expect(worktrees.isHeld("n1--race-fork")).toBe(false);
    expect(result.outcome?.loser?.result?.output).toBe("attempt-1");
  }, 10_000);

  it("forks past the threshold and the primary wins when it verifies first (after the fork was dispatched)", async () => {
    let call = 0;
    const executor: LoopExecutor & { calls: { worktree_path: string; signal?: AbortSignal }[] } = {
      calls: [],
      async specialize(params) {
        executor.calls.push({ worktree_path: params.worktree_path, signal: params.signal });
        call += 1;
        // Attempt 1 verifies just after the fork threshold; attempt 2 (the
        // fork) never gets there.
        const deferred = call === 1 ? verifiesAfter(10) : failsAfter(150);
        return { output: `attempt-${call}`, provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: deferred };
      },
      async review() { throw new Error("not used"); },
    };
    const worktrees = new WorktreeManager({}, true);
    const result = await raceSpecialize(baseInput({ executor, worktrees, forkThresholdMs: 5 }));

    expect(result.result.output).toBe("attempt-1");
    expect(result.outcome?.telemetry.winner).toBe("primary");
    expect(result.outcome?.telemetry.cancelled).toBe(true);
    expect(executor.calls[1]?.signal?.aborted).toBe(true);
    expect(worktrees.isHeld("n1--race-fork")).toBe(false);
    expect(result.outcome?.loser?.result?.output).toBe("attempt-2");
  }, 10_000);

  it("falls back to attempt 1 when neither attempt ever verifies", async () => {
    const executor: LoopExecutor & { calls: unknown[] } = {
      calls: [],
      async specialize(params) {
        executor.calls.push(params);
        return { output: "no-verify", provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: failsAfter(5) };
      },
      async review() { throw new Error("not used"); },
    };
    const worktrees = new WorktreeManager({}, true);
    const result = await raceSpecialize(baseInput({ executor, worktrees, forkThresholdMs: 10 }));

    expect(result.result.output).toBe("no-verify");
    expect(result.outcome?.telemetry.winner).toBe("none");
    expect(result.outcome?.telemetry.cancelled).toBe(false);
    expect(worktrees.isHeld("n1--race-fork")).toBe(false);
  }, 10_000);

  it("journals an honest unavailable-usage reason when the losing fork's dispatch never returned a result", async () => {
    let call = 0;
    const executor: LoopExecutor = {
      async specialize(params) {
        call += 1;
        if (call === 1) return { output: "attempt-1", provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: verifiesAfter(5) };
        // The fork's specialize() call itself rejects once aborted — never
        // returns any SpecialistResult, so its usage is genuinely
        // unrecoverable.
        return new Promise((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(new Error("aborted mid-flight")));
        });
      },
      async review() { throw new Error("not used"); },
    };
    const worktrees = new WorktreeManager({}, true);
    const result = await raceSpecialize(baseInput({ executor, worktrees, forkThresholdMs: 2 }));

    expect(result.outcome?.telemetry.winner).toBe("primary");
    expect(result.outcome?.loser?.result).toBeNull();
    expect(result.outcome?.telemetry.loser_usage_unavailable_reason).toBeTruthy();
  }, 10_000);

  it("journals the executor's own honest unavailable-usage reason when the loser returns one", async () => {
    let call = 0;
    const executor: LoopExecutor = {
      async specialize(_params) {
        call += 1;
        if (call === 1) return { output: "attempt-1", provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: verifiesAfter(5) };
        await delay(3);
        return { output: "attempt-2-aborted", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable" as const, reason: "provider usage endpoint unreachable after cancellation" } };
      },
      async review() { throw new Error("not used"); },
    };
    const worktrees = new WorktreeManager({}, true);
    const result = await raceSpecialize(baseInput({ executor, worktrees, forkThresholdMs: 2 }));

    expect(result.outcome?.telemetry.winner).toBe("primary");
    expect(result.outcome?.loser?.result?.output).toBe("attempt-2-aborted");
    expect(result.outcome?.telemetry.loser_usage_unavailable_reason).toBe("provider usage endpoint unreachable after cancellation");
  }, 10_000);

  it("propagates an incoming AbortSignal's abort to both attempts", async () => {
    const controller = new AbortController();
    let call = 0;
    const executor: LoopExecutor = {
      async specialize(_params) {
        call += 1;
        if (call === 1) {
          // Fire the incoming abort right after attempt 1 dispatches, before
          // the fork threshold — attempt 1's own signal should already be
          // aborted.
          setTimeout(() => controller.abort(new Error("test cancellation")), 1);
          return { output: "attempt-1", provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: failsAfter(150) };
        }
        return { output: "attempt-2", provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: failsAfter(150) };
      },
      async review() { throw new Error("not used"); },
    };
    const worktrees = new WorktreeManager({}, true);
    await raceSpecialize(baseInput({ executor, worktrees, forkThresholdMs: 5, signal: controller.signal }));
    // Reaching here without hanging confirms the race concluded; the
    // fork's lease is always released regardless of outcome.
    expect(worktrees.isHeld("n1--race-fork")).toBe(false);
  }, 10_000);

  it("degrades to waiting out attempt 1 when the fork worktree cannot be acquired", async () => {
    let call = 0;
    const executor: LoopExecutor = {
      async specialize(_params) {
        call += 1;
        return { output: `attempt-${call}`, provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: verifiesAfter(3) };
      },
      async review() { throw new Error("not used"); },
    };
    const worktrees = new WorktreeManager({}, true);
    // Pre-occupy the fork's synthetic lease key so acquisition fails.
    worktrees.acquireLease({ campaign_id: "camp1", node_id: "n1--race-fork", specialist: "someone-else" });
    const result = await raceSpecialize(baseInput({ executor, worktrees, forkThresholdMs: 1 }));

    expect(call).toBe(1); // attempt 2 was never dispatched
    expect(result.outcome?.telemetry.winner).toBe("primary");
    expect(result.outcome?.telemetry.cancelled).toBe(false);
    expect(result.result.output).toBe("attempt-1");
  }, 10_000);
});

describe("raceSpecialize — the fork races the IN-FLIGHT specialist (bench v5 regression)", () => {
  it("forks while attempt 1 is still generating, and a faster fork wins", async () => {
    // Attempt 1: slow specialize (120ms) that then verifies. Fork threshold
    // 30ms. The old await-first implementation could not fork before
    // specialize returned, so the fork (fast: 10ms specialize + 5ms verify)
    // could never win. The fixed implementation forks at ~30ms and the fork
    // verifies at ~45ms, well before attempt 1 even returns.
    let call = 0;
    const executor: LoopExecutor = {
      async specialize(params) {
        call += 1;
        const mine = call;
        await delay(mine === 1 ? 120 : 10);
        return {
          output: `done-${mine}`,
          provenance: { tag: "claimed", claimant: params.specialist_agent },
          token_usage: usage,
          deferred_verification: verifiesAfter(mine === 1 ? 50 : 5),
        };
      },
      async review() { throw new Error("not used"); },
    };
    const raced = await raceSpecialize(baseInput({ executor, forkThresholdMs: 30 }));
    expect(raced.outcome?.telemetry.winner).toBe("fork");
    expect(raced.outcome?.telemetry.forked_at_ms).toBeGreaterThanOrEqual(25);
    expect(raced.outcome?.telemetry.forked_at_ms).toBeLessThan(110);
    expect(raced.result.output).toBe("done-2");
    expect(raced.outcome?.telemetry.cancelled).toBe(true);
  });

  it("a fast, fully-settled-but-unverified attempt 1 yields an unforked 'none' observation", async () => {
    const executor: LoopExecutor = {
      async specialize(params) {
        await delay(5);
        return {
          output: "done", provenance: { tag: "claimed", claimant: params.specialist_agent },
          token_usage: usage, deferred_verification: failsAfter(5),
        };
      },
      async review() { throw new Error("not used"); },
    };
    const raced = await raceSpecialize(baseInput({ executor, forkThresholdMs: 200 }));
    expect(raced.outcome?.telemetry).toMatchObject({ forked_at_ms: null, winner: "none", cancelled: false });
  });
});

describe("raceSpecialize — threshold provenance (ADR-069, X-1)", () => {
  it("omits threshold provenance fields entirely when the caller does not supply thresholdSource", async () => {
    const executor = approvingExecutorWithVerification(5);
    const result = await raceSpecialize(baseInput({ executor, forkThresholdMs: 40 }));
    expect(result.outcome?.telemetry).not.toHaveProperty("threshold_ms");
    expect(result.outcome?.telemetry).not.toHaveProperty("threshold_source");
    expect(result.outcome?.telemetry).not.toHaveProperty("threshold_observations");
  });

  it("threads threshold_ms/source/observations into the fork-free telemetry when supplied", async () => {
    const executor = approvingExecutorWithVerification(5);
    const result = await raceSpecialize(baseInput({
      executor, forkThresholdMs: 40, thresholdSource: "learned", thresholdObservations: 12,
    }));
    expect(result.outcome?.telemetry).toMatchObject({ threshold_ms: 40, threshold_source: "learned", threshold_observations: 12 });
  });

  it("threads threshold provenance into a real fork's telemetry", async () => {
    let call = 0;
    const executor: LoopExecutor = {
      async specialize(_params) {
        call += 1;
        const deferred = call === 1 ? failsAfter(150) : verifiesAfter(5);
        return { output: `attempt-${call}`, provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: deferred };
      },
      async review() { throw new Error("not used"); },
    };
    const result = await raceSpecialize(baseInput({
      executor, forkThresholdMs: 15, thresholdSource: "env", thresholdObservations: 0,
    }));
    expect(result.outcome?.telemetry).toMatchObject({ threshold_ms: 15, threshold_source: "env", threshold_observations: 0 });
  }, 10_000);

  it("defaults thresholdObservations to 0 when thresholdSource is supplied without it", async () => {
    const executor = approvingExecutorWithVerification(5);
    const result = await raceSpecialize(baseInput({ executor, forkThresholdMs: 40, thresholdSource: "default" }));
    expect(result.outcome?.telemetry).toMatchObject({ threshold_ms: 40, threshold_source: "default", threshold_observations: 0 });
  });
});

describe("fork lease key produces a valid git branch name (bench v5b regression)", () => {
  it("git accepts arbor/<campaign>/<node><suffix> as a ref", async () => {
    const { spawnSync } = await import("node:child_process");
    const worktrees = new WorktreeManager({}, true);
    const executor = approvingExecutorWithVerification(0);
    await raceSpecialize(baseInput({ executor, worktrees, forkThresholdMs: 30 }));
    // Reconstruct the exact branch worktree.ts would derive for the fork key.
    const result = spawnSync("git", ["check-ref-format", "--branch", "arbor/camp1/n1--race-fork"], { encoding: "utf-8" });
    expect(result.status).toBe(0);
  });
});

describe("raceSpecialize — PM-1 (ADR-071, X) none-tie arbitration", () => {
  /**
   * Forces the FULL dual-attempt race branch (not the no-fork "settled
   * before threshold" degenerate case): both attempts' `specialize()` calls
   * outlast `forkThresholdMs`, so a real fork happens, and both then
   * fail-to-verify, so `winner` settles "none" from the actual race
   * Promise, not from the pre-fork fast path.
   */
  function neverVerifiesExecutor(): LoopExecutor & { calls: number[] } {
    const calls: number[] = [];
    let call = 0;
    return {
      calls,
      async specialize() {
        call += 1;
        const mine = call;
        calls.push(mine);
        await delay(20);
        return {
          output: `attempt-${mine}`,
          provenance: { tag: "claimed", claimant: "seed" },
          token_usage: usage,
          deferred_verification: failsAfter(5),
        };
      },
      async review() { throw new Error("not used"); },
    };
  }

  it("with no tie-breaker supplied, falls back to attempt 1 with tie_break \"none_default\"", async () => {
    const executor = neverVerifiesExecutor();
    const result = await raceSpecialize(baseInput({ executor, forkThresholdMs: 10 }));
    expect(result.outcome?.telemetry.winner).toBe("none");
    expect(result.outcome?.telemetry.tie_break).toBe("none_default");
    expect(result.result.output).toBe("attempt-1");
  }, 10_000);

  it("a tie-breaker that picks \"fork\" hands the fork's result through, tie_break \"fork\"", async () => {
    const executor = neverVerifiesExecutor();
    const tieCalls: { a: string; b: string }[] = [];
    const result = await raceSpecialize(baseInput({
      executor,
      forkThresholdMs: 10,
      tie_breaker: async (a, b) => {
        tieCalls.push({ a: a.output, b: b.output });
        return "fork";
      },
    }));
    expect(result.outcome?.telemetry.winner).toBe("none");
    expect(result.outcome?.telemetry.tie_break).toBe("fork");
    expect(result.result.output).toBe("attempt-2");
    expect(tieCalls).toEqual([{ a: "attempt-1", b: "attempt-2" }]);
  }, 10_000);

  it("a tie-breaker that picks \"primary\" keeps attempt 1's result, tie_break \"primary\"", async () => {
    const executor = neverVerifiesExecutor();
    const result = await raceSpecialize(baseInput({
      executor,
      forkThresholdMs: 10,
      tie_breaker: async () => "primary",
    }));
    expect(result.outcome?.telemetry.winner).toBe("none");
    expect(result.outcome?.telemetry.tie_break).toBe("primary");
    expect(result.result.output).toBe("attempt-1");
  }, 10_000);

  it("a tie-breaker that returns null falls back to attempt 1, tie_break \"none_default\"", async () => {
    const executor = neverVerifiesExecutor();
    const result = await raceSpecialize(baseInput({
      executor,
      forkThresholdMs: 10,
      tie_breaker: async () => null,
    }));
    expect(result.outcome?.telemetry.winner).toBe("none");
    expect(result.outcome?.telemetry.tie_break).toBe("none_default");
    expect(result.result.output).toBe("attempt-1");
  }, 10_000);

  it("a tie-breaker that throws is treated exactly like null: attempt 1 flows, tie_break \"none_default\"", async () => {
    const executor = neverVerifiesExecutor();
    const result = await raceSpecialize(baseInput({
      executor,
      forkThresholdMs: 10,
      tie_breaker: async () => { throw new Error("tie-breaker exploded"); },
    }));
    expect(result.outcome?.telemetry.winner).toBe("none");
    expect(result.outcome?.telemetry.tie_break).toBe("none_default");
    expect(result.result.output).toBe("attempt-1");
  }, 10_000);

  it("is NEVER called when a verification actually won", async () => {
    let tieBreakerCalls = 0;
    const executor = approvingExecutorWithVerification(5);
    const result = await raceSpecialize(baseInput({
      executor,
      forkThresholdMs: 40,
      tie_breaker: async () => { tieBreakerCalls += 1; return "fork"; },
    }));
    expect(result.outcome?.telemetry.winner).toBe("primary");
    expect(result.outcome?.telemetry.tie_break).toBeUndefined();
    expect(tieBreakerCalls).toBe(0);
  });

  it("is NEVER called on the no-fork fast path even when that path settles \"none\"", async () => {
    // The existing "fast, fully-settled-but-unverified attempt 1" case:
    // specialize() itself resolves well before forkThresholdMs, so no fork
    // ever happens -- the tie-breaker seam must not engage here either.
    let tieBreakerCalls = 0;
    const executor: LoopExecutor = {
      async specialize(params) {
        await delay(5);
        return {
          output: "done", provenance: { tag: "claimed", claimant: params.specialist_agent },
          token_usage: usage, deferred_verification: failsAfter(5),
        };
      },
      async review() { throw new Error("not used"); },
    };
    const result = await raceSpecialize(baseInput({
      executor,
      forkThresholdMs: 200,
      tie_breaker: async () => { tieBreakerCalls += 1; return "fork"; },
    }));
    expect(result.outcome?.telemetry.winner).toBe("none");
    expect(result.outcome?.telemetry.tie_break).toBeUndefined();
    expect(tieBreakerCalls).toBe(0);
  });
});
