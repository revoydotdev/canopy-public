import { describe, expect, it } from "vitest";
import { budgetAnnealedScore, clippedResidualValue, runAgentUctExperiment, type AgentUctFixture } from "../src/agent-uct.js";

const equalRewardFixture: AgentUctFixture = Object.freeze({
  fixture_id: "equal-reward-root-choice",
  dimensions: [
    Object.freeze({
      dimension_id: "provider",
      options: Object.freeze(["alpha-expensive", "beta-cheap"]),
    }),
  ],
  clusters: [
    Object.freeze({
      cluster_id: "core",
      weight: 1,
      item_ids: Object.freeze(["q1"]),
    }),
  ],
  prefix_cost_units: Object.freeze({
    "alpha-expensive": 9,
    "beta-cheap": 2,
  }),
  rewards: Object.freeze({
    "alpha-expensive": Object.freeze({
      core: Object.freeze({
        q1: 0.85,
      }),
    }),
    "beta-cheap": Object.freeze({
      core: Object.freeze({
        q1: 0.85,
      }),
    }),
  }),
});

describe("runAgentUctExperiment", () => {
  it("is deterministic under identical fixture and budget", () => {
    const first = runAgentUctExperiment(
      equalRewardFixture,
      { mode: "agent_uct", exploration_constant: Math.SQRT2, lambda_0: 1, cost_scale: 1 },
      1,
    );
    const second = runAgentUctExperiment(
      equalRewardFixture,
      { mode: "agent_uct", exploration_constant: Math.SQRT2, lambda_0: 1, cost_scale: 1 },
      1,
    );

    expect(second).toEqual(first);
    expect(second.replay_hash).toBe(first.replay_hash);
  });

  it("chooses the cheaper equal-reward branch under Agent-UCT while classic follows stable order", () => {
    const classic = runAgentUctExperiment(
      equalRewardFixture,
      { mode: "classic", exploration_constant: Math.SQRT2 },
      1,
    );
    const agentUct = runAgentUctExperiment(
      equalRewardFixture,
      { mode: "agent_uct", exploration_constant: Math.SQRT2, lambda_0: 1, cost_scale: 1 },
      1,
    );

    expect(classic.best_reward).toBe(agentUct.best_reward);
    expect(classic.best_configuration).toEqual(["alpha-expensive"]);
    expect(agentUct.best_configuration).toEqual(["beta-cheap"]);
    expect(agentUct.total_logical_cost_units).toBeLessThan(classic.total_logical_cost_units);
    expect(agentUct.iterations[0]?.candidate_scores.map((entry) => entry.prefix)).toEqual([
      ["beta-cheap"],
      ["alpha-expensive"],
    ]);
  });

  it("keeps budget annealing and residual-value scoring eval-only and deterministic", () => {
    expect(budgetAnnealedScore(0.5, 1, 4)).toBe(0.5);
    expect(budgetAnnealedScore(0.5, 4, 4)).toBe(0.0625);
    expect(clippedResidualValue(1, 9)).toBe(4);
    expect(clippedResidualValue(3, -9)).toBe(-4);
    const result = runAgentUctExperiment(equalRewardFixture, { mode: "budget_annealed", exploration_constant: Math.SQRT2 }, 1);
    expect(result.policy.mode).toBe("budget_annealed");
  });

  it("revisits explored choices and records prefix reuse across iterations", () => {
    const result = runAgentUctExperiment(
      equalRewardFixture,
      { mode: "agent_uct", exploration_constant: Math.SQRT2, lambda_0: 1, cost_scale: 1 },
      4,
    );
    expect(result.iterations).toHaveLength(4);
    expect(result.total_reused_edges).toBeGreaterThan(0);
    expect(result.reuse_summary.totals.reuse_count).toBeGreaterThan(0);
    expect(result.iterations.some((iteration) => iteration.reused_edges > 0)).toBe(true);
  });
});
