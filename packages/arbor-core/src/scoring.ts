// arbor-core/scoring — UCT scoring function with regression-aware priors
// Clean-room from Arbor paper §3.2, eq. (1) (arXiv 2606.12563v1), formula independently implemented.
// UCT basis: Kocsis & Szepesvári 2006 (public domain algorithm).

import {
  DEFAULT_AGENT_UCT_SCORE_CONFIG,
  DEFAULT_SCORE_POLICY,
} from "./types.js";
import type {
  Action,
  AgentUctScoreConfig,
  AgentUctScoreEvidence,
  ScoreContext,
  ScoreConfig,
  ScorePolicy,
} from "./types.js";

/**
 * Score an action via the Arbor UCT formula:
 *
 *   h(a) = [g(a)/c(a)] · (1 − r_acc) · (1 − r_crash) · m_gap + C · √(ln N / (1 + n_cat))
 *
 * Variables:
 *   g(a) = estimated gain      c(a) = estimated cost
 *   r_acc = accuracy regression rate    r_crash = crash regression rate
 *   m_gap = normalized gain relative to best known (gain/best_known; >1 surpasses)
 *   C = exploration constant (default √2)
 *   N = total node visits    n_cat = visits to this action's category
 *
 * The regression penalties (1−r_acc)(1−r_crash) make the score conservative
 * when prior iterations in this category caused regressions.
 * The UCB exploration term ensures underexplored categories get visited.
 */
export function scoreAction(
  action: Action,
  ctx: ScoreContext,
  categoryVisits: number,
  config: ScoreConfig,
): number {
  return scoreActionWithPolicy(action, ctx, categoryVisits, config);
}

function scoreClassicAction(
  action: Action,
  ctx: ScoreContext,
  categoryVisits: number,
  config: ScoreConfig,
): number {
  const { exploitation, exploration } = deriveClassicScoreTerms(action, ctx, categoryVisits, config);
  return exploitation + exploration;
}

/**
 * Score an action under an explicit policy gate.
 *
 * `mode: "classic"` (`deriveClassicScoreTerms`) implements the paper's
 * actual §3.2 formula, equation (1): a category-pooled exploration bonus,
 * `C · √(ln N / (1 + n_cat))`. This is production Arbor scoring.
 *
 * `mode: "agent_uct"` (`scoreAgentUct`) is this repository's own
 * extension — a per-edge visit-count and cost-decay-regularized variant
 * with **no counterpart in the cited paper**:
 *
 *   \hat{Q}_t(s,a) + C * sqrt(log(N_t(s)+1) / (N_t(s,a)+1)) - \lambda_t * \widehat{\Delta C}_t(s,a)
 *
 * with `\lambda_t = lambda_0 / sqrt(t)`. arXiv 2606.12563v1 contains no
 * per-edge, per-state-action visit-count formula and no cost-decay
 * regularization term anywhere in it; this mode does not reproduce
 * anything in the paper, it is Arbor-team-original.
 *
 * This path is intentionally explicit and separate from production Arbor
 * scoring, and is kept eval-only precisely so that difference from the
 * cited paper is never silently absorbed into production selection. It
 * exists so eval lanes can compare ADR-002 against this repository's own
 * prefix-cost regularization variant without silently changing campaign
 * selection.
 */
export function scoreActionWithPolicy(
  action: Action,
  ctx: ScoreContext,
  categoryVisits: number,
  config: ScoreConfig,
  policy: ScorePolicy = DEFAULT_SCORE_POLICY,
): number {
  if (policy.mode === "classic") return scoreClassicAction(action, ctx, categoryVisits, config);
  return scoreAgentUct(policy.evidence, config, policy.agent_uct_config);
}

export function scoreAgentUct(
  evidence: AgentUctScoreEvidence,
  config: Pick<ScoreConfig, "exploration_constant">,
  agentUctConfig: AgentUctScoreConfig = DEFAULT_AGENT_UCT_SCORE_CONFIG,
): number {
  const rewardEstimate = Number.isFinite(evidence.reward_estimate) ? evidence.reward_estimate : 0;
  const stateVisitCount = clampNonNegative(evidence.state_visit_count);
  const edgeVisitCount = clampNonNegative(evidence.edge_visit_count);
  const exploration =
    config.exploration_constant *
    Math.sqrt(
      Math.log(stateVisitCount + 1) /
      (edgeVisitCount + 1),
    );
  const lambda = deriveDecayingLambda(evidence.iteration, agentUctConfig.lambda_0);
  const scaledCost = clampNonNegative(evidence.marginal_cost_estimate) * clampNonNegative(agentUctConfig.cost_scale);
  return rewardEstimate + exploration - (lambda * scaledCost);
}

export function deriveDecayingLambda(iteration: number, lambda0: number): number {
  const boundedIteration = Number.isFinite(iteration) ? Math.max(1, iteration) : 1;
  return clampNonNegative(lambda0) / Math.sqrt(boundedIteration);
}

/**
 * Below this, `ctx.best_known` is treated as "nothing verified yet" rather
 * than a real (if small) frontier — see `deriveClassicScoreTerms`.
 */
const NO_BASELINE_EPSILON = 1e-3;

function deriveClassicScoreTerms(
  action: Action,
  ctx: ScoreContext,
  categoryVisits: number,
  config: ScoreConfig,
): { exploitation: number; exploration: number } {
  // Expected gain per unit cost
  const gainPerCost = action.estimated_gain / Math.max(action.estimated_cost, 0.001);

  // Regression penalties — zero out if either regression rate is 1.0
  const accPenalty = 1 - clamp01(ctx.accuracy_regression_rate);
  const crashPenalty = 1 - clamp01(ctx.crash_regression_rate);

  // Performance gap as a normalized ratio: 1.0 at best_known, >1 when the action
  // surpasses the frontier, <1 when short. Monotonic in gain — the exploitation
  // term must reward the actions that win, never penalize them (the prior
  // best_known − gain form inverted this and zeroed exploitation for the best actions).
  //
  // `best_known` starts at 0 and only ever moves when a terminal outcome
  // is MEASURED (manager.ts's best_score, the provenance-typed reward
  // contract in reward.ts), so early in a campaign — before anything has been
  // measured — it carries no real frontier to compare against. Dividing by a near-zero floor (the prior `1e-6` clamp) turned
  // that absence of a baseline into a million-scale score for a fresh or
  // premature claim, dwarfing genuinely useful traces (~0.8 once a baseline
  // exists). Below NO_BASELINE_EPSILON there is nothing to normalize
  // against, so the gap term is neutral (1.0, i.e. "no scaling") rather than
  // a blown-up ratio — the score still ranks candidates by gain-per-cost and
  // regression penalties, just without a meaningless division.
  const performanceGap = ctx.best_known < NO_BASELINE_EPSILON
    ? 1
    : Math.max(0, action.estimated_gain / ctx.best_known);

  // UCB exploration bonus — sqrt(ln(N) / (1 + n_cat))
  const exploration =
    config.exploration_constant *
    Math.sqrt(Math.log(Math.max(ctx.total_visits, 1)) / (1 + categoryVisits));

  const exploitation = gainPerCost * accPenalty * crashPenalty * performanceGap;
  return { exploitation, exploration };
}

/**
 * Check whether the campaign should halt.
 * Three conditions, any one triggers halt:
 * 1. Wall-clock budget exhausted
 * 2. Best MEASURED reward below threshold
 * 3. Two consecutive iterations with no new KB entry (convergence)
 *
 * `bestScore` is a measured quality on the reward contract's [0, 1] scale
 * (`combineReward`: 1 for a `!verified` pass, a bounded stage fraction for a
 * measured failure), never a planner prior or a selection score. `min_score`
 * is therefore a measured-quality threshold, not an estimate threshold.
 */
export function haltCheck(
  startedAt: number, // epoch ms
  /** Best measured reward, or `null` when nothing has been measured yet — see the below_threshold branch. */
  bestScore: number | null,
  iterationsCompleted: number,
  iterationsWithoutKbEntry: number,
  config: { max_seconds: number; min_score: number; convergence_iterations: number },
): HaltResult {
  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  if (config.max_seconds > 0 && elapsedSeconds >= config.max_seconds) {
    return {
      halted: true,
      reason: "budget_exhausted",
      iterations_completed: iterationsCompleted,
      iterations_without_kb_entry: iterationsWithoutKbEntry,
      best_score: bestScore ?? 0,
      elapsed_seconds: elapsedSeconds,
    };
  }

  // `bestScore === null` means NOTHING HAS SCORED YET — not that the best
  // score is low. Those are different facts and this check must not conflate
  // them: `campaign.best_score` is only written on node verification, so a
  // campaign whose first specialist FAILED review still carries its initial
  // 0. Comparing that 0 against `min_score` halted the campaign after a
  // single failed expansion, with every remaining candidate unexplored —
  // making backtracking, the entire purpose of the tree search, unreachable.
  // Observed on two real campaigns 2026-08-08; `loop-phase3.test.ts` had
  // already been setting `min_score: 0` in three places to work around it.
  //
  // This is the repository's own governing rule applied to its own scoring
  // function: absence is a value, not a default, and a missing measurement is
  // never a zero.
  if (bestScore !== null && bestScore < config.min_score && iterationsCompleted > 0) {
    return {
      halted: true,
      reason: "below_threshold",
      iterations_completed: iterationsCompleted,
      iterations_without_kb_entry: iterationsWithoutKbEntry,
      best_score: bestScore ?? 0,
      elapsed_seconds: elapsedSeconds,
    };
  }

  if (iterationsWithoutKbEntry >= config.convergence_iterations) {
    return {
      halted: true,
      reason: "converged",
      iterations_completed: iterationsCompleted,
      iterations_without_kb_entry: iterationsWithoutKbEntry,
      best_score: bestScore ?? 0,
      elapsed_seconds: elapsedSeconds,
    };
  }

  return {
    halted: false,
    reason: null,
    iterations_completed: iterationsCompleted,
    iterations_without_kb_entry: iterationsWithoutKbEntry,
    best_score: bestScore ?? 0,
    elapsed_seconds: elapsedSeconds,
  };
}

export interface HaltResult {
  halted: boolean;
  reason: "budget_exhausted" | "below_threshold" | "converged" | "manual" | null;
  iterations_completed: number;
  iterations_without_kb_entry: number;
  best_score: number;
  elapsed_seconds: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clampNonNegative(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}
