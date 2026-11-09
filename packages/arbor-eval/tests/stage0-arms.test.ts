import { describe, expect, it } from "vitest";
import { replaySearchStep } from "@arbor/core";
import { bestOfNConfig, deriveBestOfN, deriveCurrent, deriveKWide, nextWaveToRun, Stage0IncompleteUnitError } from "../src/stage0/arms.js";
import { attempt } from "./stage0-fixtures.js";

const T = "task-a";

describe("Stage 0 arm derivation", () => {
  it("current is exactly the unit's first attempt", () => {
    const attempts = [attempt({ task_id: T, seed: 0, attempt_index: 0 }), attempt({ task_id: T, seed: 0, attempt_index: 1, verified: true })];
    const current = deriveCurrent(attempts, T, 0);
    expect(current.dispatched).toEqual([0]);
    expect(current.verified_and_adopted).toBe(false);
    expect(current.selected).toBeNull();
  });

  it("best_of_n stops at the first !verified attempt and is scored on that attempt's independent outcome", () => {
    const attempts = [0, 1, 2, 3].map((i) => attempt({ task_id: T, seed: 0, attempt_index: i, verified: i === 2 }));
    const outcome = deriveBestOfN(attempts, T, 0, 4, 1);
    expect(outcome.dispatched).toEqual([0, 1, 2]);
    expect(outcome.selected).toBe(2);
    expect(outcome.verified_and_adopted).toBe(true);
    expect(outcome.stop_reason).toBe("verified");
    expect(outcome.cost_usd).toBeCloseTo(0.3, 10);
    expect(outcome.wall_ms).toBe(180_000);
  });

  it("a harness false acceptance ends the step and costs the arm its result", () => {
    const attempts = [0, 1, 2, 3].map((i) => attempt({ task_id: T, seed: 0, attempt_index: i, verified: i >= 1, adopted_ok: i !== 1 }));
    const outcome = deriveBestOfN(attempts, T, 0, 4, 1);
    expect(outcome.selected).toBe(1);
    expect(outcome.verified_and_adopted).toBe(false);
    expect(outcome.false_acceptance).toBe(true);
  });

  it("the USD budget stops dispatch once provider-measured spend reaches B x unit", () => {
    const attempts = [0, 1, 2, 3].map((i) => attempt({ task_id: T, seed: 0, attempt_index: i, cost_usd: 0.25 }));
    const outcome = deriveBestOfN(attempts, T, 0, 4, 0.1);
    expect(outcome.dispatched).toEqual([0, 1]);
    expect(outcome.stop_reason).toBe("usd_exhausted");
  });

  it("records replayable core decisions under the best_of_n policy", () => {
    const attempts = [0, 1, 2].map((i) => attempt({ task_id: T, seed: 3, attempt_index: i, verified: i === 2 }));
    const outcome = deriveBestOfN(attempts, T, 3, 4, 1);
    const events = outcome.decisions.flatMap((record, index) => [
      { kind: "decision" as const, record },
      { kind: "observation" as const, observation: { attempt_id: record.attempt_id, reward: index === 2 ? 1 : 0, verification: index === 2 ? attempts[2].verification : null, cost_usd: 0.1 } },
    ]);
    const replay = replaySearchStep(`${T}#3`, bestOfNConfig(T, 3, 4, 1), events);
    expect(replay.ok).toBe(true);
    expect(outcome.decisions.every((record) => record.policy === "best_of_n")).toBe(true);
  });

  it("kwide runs whole waves, pays for every member, and keeps the first verified to finish", () => {
    const attempts = [0, 1, 2, 3].map((i) => attempt({ task_id: T, seed: 0, attempt_index: i, verified: i === 1 || i === 3, wall_ms: i === 3 ? 10_000 : 60_000 }));
    const outcome = deriveKWide(attempts, T, 0, 4, 1, 4);
    expect(outcome.dispatched).toEqual([0, 1, 2, 3]);
    expect(outcome.cost_usd).toBeCloseTo(0.4, 10);
    // a3 started 2 s after a1 but finished first.
    expect(outcome.selected).toBe(3);
    expect(outcome.wall_ms).toBe(60_000);
  });

  it("kwide uses the measured wave span when one is supplied", () => {
    const attempts = [0, 1, 2, 3].map((i) => attempt({ task_id: T, seed: 0, attempt_index: i, verified: i === 0 }));
    const outcome = deriveKWide(attempts, T, 0, 4, 1, 4, () => 75_000);
    expect(outcome.wall_ms).toBe(75_000);
  });

  it("a missing attempt makes the unit incomplete, never a failure", () => {
    const attempts = [attempt({ task_id: T, seed: 0, attempt_index: 0 })];
    expect(() => deriveBestOfN(attempts, T, 0, 4, 1)).toThrow(Stage0IncompleteUnitError);
  });

  it("nextWaveToRun schedules whole K-wide waves until every arm is derivable", () => {
    expect(nextWaveToRun([], T, 0, 8, 1, 4)).toEqual([0, 1, 2, 3]);
    const failedWave = [0, 1, 2, 3].map((i) => attempt({ task_id: T, seed: 0, attempt_index: i }));
    expect(nextWaveToRun(failedWave, T, 0, 8, 1, 4)).toEqual([4, 5, 6, 7]);
    const solvedWave = [0, 1, 2, 3].map((i) => attempt({ task_id: T, seed: 0, attempt_index: i, verified: i === 2 }));
    expect(nextWaveToRun(solvedWave, T, 0, 8, 1, 4)).toEqual([]);
    const all = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => attempt({ task_id: T, seed: 0, attempt_index: i }));
    expect(nextWaveToRun(all, T, 0, 8, 1, 4)).toEqual([]);
  });

  it("every budget's best_of_n and kwide dispatch a subset of kwide at the largest budget", () => {
    for (let solvedAt = 0; solvedAt <= 8; solvedAt++) {
      const attempts = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => attempt({ task_id: T, seed: 0, attempt_index: i, verified: i === solvedAt }));
      const largest = new Set(deriveKWide(attempts, T, 0, 8, 1, 4).dispatched);
      for (const budget of [4, 8]) {
        for (const index of deriveBestOfN(attempts, T, 0, budget, 1).dispatched) expect(largest.has(index)).toBe(true);
        for (const index of deriveKWide(attempts, T, 0, budget, 1, 4).dispatched) expect(largest.has(index)).toBe(true);
      }
    }
  });
});
