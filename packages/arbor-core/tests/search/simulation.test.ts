// Seeded simulation lane for the search policies (UCT plan Stage 2).
//
// NOT EFFICACY EVIDENCE (ADR-131). The tasks are synthetic, with known latent
// success probabilities; this lane only shows each policy behaves as specified
// and pins that behaviour against regressions. Whether search beats best-of-N
// on real work is Stage 0's measurement.

import { describe, expect, it } from "vitest";
import { SEARCH_POLICY_KINDS } from "../../src/search/types.js";
import type { SearchPolicyKind } from "../../src/search/types.js";
import { POLICIES, config, runStep, syntheticOracle, syntheticTasks } from "./harness.js";

interface Summary {
  readonly solveRate: number;
  readonly refineShare: number;
}

function simulate(kind: SearchPolicyKind, regime: string, p: [number, number], delta: number, budget: number): Summary {
  const tasks = syntheticTasks(regime, 400, p, delta);
  let solved = 0;
  let refines = 0;
  let attempts = 0;
  for (const task of tasks) {
    const run = runStep(task.id, config(POLICIES[kind], { budget: { max_usd: 100, max_attempts: budget } }), syntheticOracle(task));
    if (run.stop === "verified") solved++;
    refines += run.actions.filter((action) => action.kind === "refine").length;
    attempts += run.actions.length;
  }
  return { solveRate: solved / tasks.length, refineShare: refines / attempts };
}

function table(regime: string, p: [number, number], delta: number, budget: number): Record<SearchPolicyKind, Summary> {
  return Object.fromEntries(SEARCH_POLICY_KINDS.map((kind) => [kind, simulate(kind, regime, p, delta, budget)])) as Record<SearchPolicyKind, Summary>;
}

describe("seeded policy simulation (correctness lane, not efficacy evidence)", () => {
  const neutral = table("neutral", [0.05, 0.3], 0, 16);
  const helpful = table("helpful", [0.05, 0.3], 0.15, 16);
  const harmful = table("harmful", [0.1, 0.4], -0.15, 16);

  it("best_of_n never refines and refine_chain refines most", () => {
    for (const regime of [neutral, helpful, harmful]) {
      expect(regime.best_of_n.refineShare).toBe(0);
      expect(regime.refine_chain.refineShare).toBeGreaterThan(0.6);
    }
  });

  it("abmcts_beta matches best_of_n when refining neither helps nor hurts", () => {
    expect(Math.abs(neutral.abmcts_beta.solveRate - neutral.best_of_n.solveRate)).toBeLessThanOrEqual(0.05);
  });

  it("abmcts_beta beats best_of_n when refining helps", () => {
    expect(helpful.abmcts_beta.solveRate).toBeGreaterThan(helpful.best_of_n.solveRate + 0.04);
  });

  it("abmcts_beta goes deeper when refining helps than when it hurts", () => {
    expect(helpful.abmcts_beta.refineShare).toBeGreaterThan(harmful.abmcts_beta.refineShare + 0.05);
  });

  it("abmcts_beta avoids most of refine_chain's loss when refining hurts", () => {
    expect(harmful.abmcts_beta.solveRate).toBeGreaterThan(harmful.refine_chain.solveRate + 0.1);
    expect(harmful.abmcts_beta.solveRate).toBeLessThanOrEqual(harmful.best_of_n.solveRate);
  });

  it("puct and arbor_eq1 both widen and deepen", () => {
    for (const regime of [neutral, helpful, harmful]) {
      for (const kind of ["puct", "arbor_eq1"] as const) {
        expect(regime[kind].refineShare).toBeGreaterThan(0.2);
        expect(regime[kind].refineShare).toBeLessThan(0.8);
      }
    }
  });

  it("solve rate is monotone in the attempt budget for every policy", () => {
    for (const kind of SEARCH_POLICY_KINDS) {
      const rates = [4, 8, 16].map((budget) => simulate(kind, "budget", [0.05, 0.3], 0.05, budget).solveRate);
      expect(rates[1]).toBeGreaterThanOrEqual(rates[0]);
      expect(rates[2]).toBeGreaterThanOrEqual(rates[1]);
    }
  });
});
