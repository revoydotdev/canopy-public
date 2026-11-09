import { describe, it, expect } from "vitest";
import { deriveDecayingLambda, scoreAction, scoreActionWithPolicy, scoreAgentUct, haltCheck } from "../src/scoring.js";
import type { Action, ScoreContext, ScoreConfig, ScorePolicy } from "../src/types.js";

describe("scoreAction", () => {
  const baseAction: Action = {
    description: "refactor auth module",
    estimated_gain: 10,
    estimated_cost: 5,
    category: "refactor",
    delegate_to: "seed",
  };

  const baseCtx: ScoreContext = {
    accuracy_regression_rate: 0,
    crash_regression_rate: 0,
    best_known: 20,
    total_visits: 10,
  };

  const baseConfig: ScoreConfig = { exploration_constant: 1.414 };

  it("produces a positive score for a high-gain, low-cost action", () => {
    const score = scoreAction(baseAction, baseCtx, 0, baseConfig);
    expect(score).toBeGreaterThan(0);
  });

  it("increases score with higher gain-per-cost ratio", () => {
    const lowGainPerCost = { ...baseAction, estimated_gain: 1, estimated_cost: 100 };
    const highGainPerCost = { ...baseAction, estimated_gain: 80, estimated_cost: 2 };
    const wideGapCtx = { ...baseCtx, best_known: 1000 };
    const lowScore = scoreAction(lowGainPerCost, wideGapCtx, 0, baseConfig);
    const highScore = scoreAction(highGainPerCost, wideGapCtx, 0, baseConfig);
    expect(highScore).toBeGreaterThan(lowScore);
  });

  it("reduces score when accuracy regression rate is high", () => {
    const noRegression = scoreAction(baseAction, baseCtx, 0, baseConfig);
    const highRegression = scoreAction(
      baseAction,
      { ...baseCtx, accuracy_regression_rate: 0.9 },
      0,
      baseConfig,
    );
    expect(highRegression).toBeLessThan(noRegression);
  });

  it("reduces to near-exploration-only score when both regression rates are 1.0", () => {
    const wideGapCtx = { ...baseCtx, best_known: 1000 };
    const score = scoreAction(
      baseAction,
      { ...wideGapCtx, accuracy_regression_rate: 1.0, crash_regression_rate: 1.0 },
      0,
      baseConfig,
    );
    const pureExploration = baseConfig.exploration_constant *
      Math.sqrt(Math.log(wideGapCtx.total_visits) / 1);
    expect(score).toBeCloseTo(pureExploration, 5);
  });

  it("gives exploration bonus to underexplored categories", () => {
    const explored = scoreAction(baseAction, baseCtx, 10, baseConfig);
    const unexplored = scoreAction(baseAction, baseCtx, 0, baseConfig);
    expect(unexplored).toBeGreaterThan(explored);
  });

  it("rewards an action that surpasses the best-known frontier (m_gap not inverted)", () => {
    // best_known = 20. An action promising gain 25 (above frontier) must score
    // higher than one promising gain 5 (below frontier), all else equal. The
    // prior `best_known − gain` form zeroed the exploitation term for the
    // above-frontier action — the bug this locks.
    const aboveFrontier = { ...baseAction, estimated_gain: 25, estimated_cost: 5 };
    const belowFrontier = { ...baseAction, estimated_gain: 5, estimated_cost: 5 };
    const above = scoreAction(aboveFrontier, baseCtx, 0, baseConfig);
    const below = scoreAction(belowFrontier, baseCtx, 0, baseConfig);
    expect(above).toBeGreaterThan(below);
    // The surpassing action must carry a real exploitation contribution (>1× best).
    expect(above).toBeGreaterThan(baseConfig.exploration_constant * Math.sqrt(Math.log(baseCtx.total_visits) / 1));
  });

  it("does not divide by zero when cost is zero", () => {
    const freeAction = { ...baseAction, estimated_cost: 0 };
    const score = scoreAction(freeAction, baseCtx, 0, baseConfig);
    expect(Number.isFinite(score)).toBe(true);
  });

  it("keeps scores in a comparable, non-blown-up range before anything has verified (best_known near zero)", () => {
    // Before fix: dividing estimated_gain by a 1e-6 floor produced
    // million-scale scores for an early/premature claim, dwarfing a normal
    // post-verification score (~0.8-ish order of magnitude for this action).
    const noBaselineCtx = { ...baseCtx, best_known: 0 };
    const score = scoreAction(baseAction, noBaselineCtx, 0, baseConfig);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeLessThan(100);

    const normalBaselineCtx = { ...baseCtx, best_known: baseAction.estimated_gain };
    const normalScore = scoreAction(baseAction, normalBaselineCtx, 0, baseConfig);
    // Same order of magnitude as a genuine baseline comparison at the frontier.
    expect(score).toBeCloseTo(normalScore, 5);
  });

  it("treats a tiny best_known the same as zero (no real frontier yet)", () => {
    const tinyBaselineCtx = { ...baseCtx, best_known: 1e-9 };
    const zeroBaselineCtx = { ...baseCtx, best_known: 0 };
    expect(scoreAction(baseAction, tinyBaselineCtx, 0, baseConfig)).toBeCloseTo(
      scoreAction(baseAction, zeroBaselineCtx, 0, baseConfig),
      12,
    );
  });
});

describe("scoreActionWithPolicy", () => {
  const action: Action = {
    description: "tighten planner",
    estimated_gain: 18,
    estimated_cost: 6,
    category: "planner",
    delegate_to: "seed",
  };

  const ctx: ScoreContext = {
    accuracy_regression_rate: 0.1,
    crash_regression_rate: 0.05,
    best_known: 12,
    total_visits: 16,
  };

  const config: ScoreConfig = { exploration_constant: Math.SQRT2 };

  it("matches classic scoring by default", () => {
    expect(scoreActionWithPolicy(action, ctx, 3, config)).toBeCloseTo(
      scoreAction(action, ctx, 3, config),
      12,
    );
  });

  it("matches classic scoring when explicitly set to classic mode", () => {
    const policy: ScorePolicy = { mode: "classic" };
    expect(scoreActionWithPolicy(action, ctx, 2, config, policy)).toBeCloseTo(
      scoreAction(action, ctx, 2, config),
      12,
    );
  });

  it("uses the Agent-UCT path when explicitly selected", () => {
    const policy: ScorePolicy = {
      mode: "agent_uct",
      evidence: {
        source: "measured_prefix_reuse",
        reward_estimate: 0.7,
        state_visit_count: 10,
        edge_visit_count: 2,
        marginal_cost_estimate: 0.25,
        iteration: 4,
      },
      agent_uct_config: {
        lambda_0: 0.8,
        cost_scale: 1,
      },
    };
    expect(scoreActionWithPolicy(action, ctx, 1, config, policy)).toBeCloseTo(
      scoreAgentUct(policy.evidence, config, policy.agent_uct_config),
      12,
    );
  });
});

describe("scoreAgentUct", () => {
  const config: ScoreConfig = { exploration_constant: Math.SQRT2 };

  it("penalizes higher marginal cost when reward and visits are equal", () => {
    const lowCost = {
      source: "measured_prefix_reuse" as const,
      reward_estimate: 0.6,
      state_visit_count: 12,
      edge_visit_count: 3,
      marginal_cost_estimate: 0.1,
      iteration: 4,
    };
    const highCost = {
      ...lowCost,
      marginal_cost_estimate: 0.8,
    };

    expect(scoreAgentUct(lowCost, config)).toBeGreaterThan(
      scoreAgentUct(highCost, config),
    );
  });

  it("decays the cost penalty over later iterations", () => {
    const early = {
      source: "measured_prefix_reuse" as const,
      reward_estimate: 0.6,
      state_visit_count: 12,
      edge_visit_count: 3,
      marginal_cost_estimate: 0.8,
      iteration: 1,
    };
    const late = {
      ...early,
      iteration: 16,
    };

    expect(scoreAgentUct(late, config)).toBeGreaterThan(
      scoreAgentUct(early, config),
    );
  });

  it("reduces exploration as an edge becomes well explored", () => {
    const underExplored = {
      source: "measured_prefix_reuse" as const,
      reward_estimate: 0.4,
      state_visit_count: 32,
      edge_visit_count: 1,
      marginal_cost_estimate: 0,
      iteration: 5,
    };
    const overExplored = {
      ...underExplored,
      edge_visit_count: 20,
    };

    expect(scoreAgentUct(underExplored, config)).toBeGreaterThan(
      scoreAgentUct(overExplored, config),
    );
  });

  it("treats negative cost and lambda inputs as zeroed rather than rewarding pathology", () => {
    const evidence = {
      source: "measured_prefix_reuse" as const,
      reward_estimate: 0.4,
      state_visit_count: 8,
      edge_visit_count: 1,
      marginal_cost_estimate: -50,
      iteration: 0,
    };
    const score = scoreAgentUct(evidence, config, { lambda_0: -3, cost_scale: -10 });
    const expectedExploration = config.exploration_constant * Math.sqrt(Math.log(9) / 2);
    expect(score).toBeCloseTo(0.4 + expectedExploration, 12);
  });

  it("keeps pathological numeric inputs finite instead of propagating NaN", () => {
    const evidence = {
      source: "measured_prefix_reuse" as const,
      reward_estimate: 0.4,
      state_visit_count: Number.NaN,
      edge_visit_count: Number.POSITIVE_INFINITY,
      marginal_cost_estimate: Number.NEGATIVE_INFINITY,
      iteration: Number.NaN,
    };
    expect(Number.isFinite(
      scoreAgentUct(evidence, config, { lambda_0: Number.NaN, cost_scale: Number.POSITIVE_INFINITY }),
    )).toBe(true);
  });
});

describe("deriveDecayingLambda", () => {
  it("uses lambda_0 at iteration 1 and decays by sqrt(t)", () => {
    expect(deriveDecayingLambda(1, 2)).toBeCloseTo(2, 12);
    expect(deriveDecayingLambda(4, 2)).toBeCloseTo(1, 12);
    expect(deriveDecayingLambda(16, 2)).toBeCloseTo(0.5, 12);
  });

  it("clamps invalid iteration and lambda values safely", () => {
    expect(deriveDecayingLambda(0, -4)).toBe(0);
    expect(deriveDecayingLambda(-10, 3)).toBeCloseTo(3, 12);
    expect(deriveDecayingLambda(Number.NaN, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("haltCheck", () => {
  const baseConfig = { max_seconds: 600, min_score: 0.1, convergence_iterations: 2 };

  it("does not halt when budget remains and score is above threshold", () => {
    const result = haltCheck(Date.now() - 1000, 5.0, 1, 0, baseConfig);
    expect(result.halted).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("halts with budget_exhausted when time exceeds max_seconds", () => {
    const result = haltCheck(Date.now() - 601_000, 5.0, 1, 0, baseConfig);
    expect(result.halted).toBe(true);
    expect(result.reason).toBe("budget_exhausted");
  });

  it("does not impose a wall-clock budget when max_seconds is zero", () => {
    const result = haltCheck(Date.now() - 86_400_000, 5.0, 1, 0, { ...baseConfig, max_seconds: 0 });
    expect(result.halted).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("halts with below_threshold when score is too low after at least one iteration", () => {
    const result = haltCheck(Date.now() - 1000, 0.01, 1, 0, baseConfig);
    expect(result.halted).toBe(true);
    expect(result.reason).toBe("below_threshold");
  });

  // The defect this guards, observed on two real campaigns 2026-08-08:
  // `campaign.best_score` is only written when a node VERIFIES, so a campaign
  // whose first specialist failed review still carried its initial 0. That 0
  // was compared against min_score and halted the campaign after one
  // expansion, leaving every other candidate unexplored — backtracking, the
  // whole point of the tree search, could never happen. Passing `null` says
  // "nothing has scored", which is a different fact from "the best score is
  // low" and must not end the campaign.
  it("does not halt below_threshold when nothing has scored yet, however many iterations ran", () => {
    for (const iterations of [1, 5, 50]) {
      const result = haltCheck(Date.now() - 1000, null, iterations, 0, baseConfig);
      expect(result.halted, `halted after ${iterations} iteration(s) with no score recorded`).toBe(false);
      expect(result.reason).toBeNull();
    }
  });

  it("still halts below_threshold once something HAS scored and scored badly", () => {
    // The absence check must not become a blanket mute: a real measured score
    // below the floor is exactly what this condition is for.
    const result = haltCheck(Date.now() - 1000, 0.01, 1, 0, baseConfig);
    expect(result.halted).toBe(true);
    expect(result.reason).toBe("below_threshold");
  });

  it("does not halt below_threshold on iteration 0 (before any work)", () => {
    const result = haltCheck(Date.now() - 1000, 0.01, 0, 0, baseConfig);
    expect(result.halted).toBe(false);
  });

  it("halts with converged after N iterations without KB entry", () => {
    const result = haltCheck(Date.now() - 1000, 5.0, 5, 2, baseConfig);
    expect(result.halted).toBe(true);
    expect(result.reason).toBe("converged");
  });

  it("does not halt with convergence if iterations_without_kb_entry < convergence_iterations", () => {
    const result = haltCheck(Date.now() - 1000, 5.0, 5, 1, baseConfig);
    expect(result.halted).toBe(false);
  });
});
