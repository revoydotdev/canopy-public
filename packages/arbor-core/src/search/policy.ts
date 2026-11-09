// arbor-core/search/policy — per-step selection policies over the attempt tree.
// Governing records: ADR-186 (search policy core and the @arbor/search-runtime package), ADR-185 (reward is measured and provenance-typed).
//
// The attempt tree under one step: the step base (node null) has GEN children;
// each observed, unverified attempt may have REFINE children. A descent policy
// starts at the base and, at every node, chooses among the node's own GEN arm
// (a new child of that node) and one arm per child whose subtree still has an
// available action. Choosing a child descends into it; choosing GEN ends the
// descent. GEN at the base is a fresh attempt; GEN at an attempt refines it.
//
// abmcts_beta follows AB-MCTS-A (Inoue et al., arXiv 2503.04412): Thompson
// sampling decides wider vs deeper at every node, with the existing children
// aggregated behind one CONT arm so that the wider/deeper choice is not biased
// toward "deeper" merely because there are many children to draw a maximum
// from. At a node n with both kinds of arm available, two draws decide first:
//   GEN arm  — rewards of n's direct children (what widening at n produced);
//   CONT arm — rewards of every deeper attempt below n's children (what
//              continuing past n's children produced).
// If CONT wins, a second Thompson round picks the child, each child arm
// carrying the rewards of its whole subtree, child included. These statistics
// are this module's own definitions, written from the paper's description.
// Rewards in [0, 1] update a Beta posterior as fractional pseudo-counts
// (alpha += r, beta += 1 − r). Each in-flight attempt adds `virtual_loss`
// pseudo-failures to every arm containing it, so concurrent picks diversify.

import { scoreAction } from "../scoring.js";
import { sampleBeta, type SeededRng } from "./rng.js";
import type {
  SearchAction,
  SearchArm,
  SearchArmEvaluation,
  SearchAttempt,
  SearchConfig,
  SearchDecisionLevel,
  SearchPolicyConfig,
  SearchStepState,
} from "./types.js";

type DescentPolicy = Extract<SearchPolicyConfig, { kind: "abmcts_beta" | "puct" | "arbor_eq1" }>;

export interface SearchSelection {
  readonly levels: readonly SearchDecisionLevel[];
  readonly action: SearchAction;
}

interface AttemptIndex {
  readonly byId: ReadonlyMap<string, SearchAttempt>;
  readonly children: ReadonlyMap<string | null, readonly SearchAttempt[]>;
}

interface ArmTally {
  /** Sum of observed rewards. */
  readonly sum: number;
  readonly observed: number;
  readonly inFlight: number;
}

function indexAttempts(attempts: readonly SearchAttempt[]): AttemptIndex {
  const byId = new Map<string, SearchAttempt>();
  const children = new Map<string | null, SearchAttempt[]>();
  for (const attempt of attempts) {
    byId.set(attempt.id, attempt);
    const siblings = children.get(attempt.parent_id);
    if (siblings) siblings.push(attempt);
    else children.set(attempt.parent_id, [attempt]);
  }
  return { byId, children };
}

function childrenOf(index: AttemptIndex, node: string | null): readonly SearchAttempt[] {
  return index.children.get(node) ?? [];
}

/** Whether a new child of `node` (GEN at the base, REFINE of an attempt) is allowed. */
function canGenerate(index: AttemptIndex, node: string | null, config: SearchConfig): boolean {
  if (config.max_width !== null && childrenOf(index, node).length >= config.max_width) return false;
  if (node === null) return true;
  const attempt = index.byId.get(node);
  return attempt !== undefined
    && attempt.status === "observed"
    && attempt.duplicate_of === undefined
    && !attempt.verified
    && attempt.depth + 1 <= config.max_refine_depth;
}

function hasAvailableAction(index: AttemptIndex, node: string, config: SearchConfig): boolean {
  if (canGenerate(index, node, config)) return true;
  return childrenOf(index, node).some((child) => hasAvailableAction(index, child.id, config));
}

/** Available arms in canonical order: GEN first, then children in dispatch order. */
function availableArms(index: AttemptIndex, node: string | null, config: SearchConfig): SearchArm[] {
  const arms: SearchArm[] = canGenerate(index, node, config) ? ["gen"] : [];
  for (const child of childrenOf(index, node)) {
    if (hasAvailableAction(index, child.id, config)) arms.push(child.id);
  }
  return arms;
}

function tallyAttempts(attempts: readonly SearchAttempt[]): ArmTally {
  let sum = 0;
  let observed = 0;
  let inFlight = 0;
  for (const attempt of attempts) {
    // A transposed duplicate is a link to its original's observation, not a second one.
    if (attempt.duplicate_of !== undefined) continue;
    if (attempt.status === "in_flight") inFlight++;
    else {
      observed++;
      sum += attempt.reward as number;
    }
  }
  return { sum, observed, inFlight };
}

function subtree(index: AttemptIndex, root: string): SearchAttempt[] {
  const out: SearchAttempt[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    out.push(index.byId.get(id) as SearchAttempt);
    for (const child of childrenOf(index, id)) stack.push(child.id);
  }
  return out;
}

function armTally(index: AttemptIndex, node: string | null, arm: SearchArm): ArmTally {
  if (arm === "gen") return tallyAttempts(childrenOf(index, node));
  if (arm === "cont") return tallyAttempts(childrenOf(index, node).flatMap((child) => subtree(index, child.id).slice(1)));
  return tallyAttempts(subtree(index, arm));
}

function argmax(scores: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < scores.length; index++) {
    if (scores[index] > scores[best]) best = index;
  }
  return best;
}

interface ScoredArm {
  readonly evaluation: SearchArmEvaluation;
  readonly value: number;
}

function evaluateArms(
  index: AttemptIndex,
  node: string | null,
  arms: readonly SearchArm[],
  policy: DescentPolicy,
  config: SearchConfig,
  rng: SeededRng,
): ScoredArm[] {
  const tallies = arms.map((arm) => armTally(index, node, arm));
  if (policy.kind === "abmcts_beta") {
    return arms.map((arm, at) => {
      const tally = tallies[at];
      const alpha = policy.prior.alpha + tally.sum;
      const beta = policy.prior.beta + (tally.observed - tally.sum) + policy.virtual_loss * tally.inFlight;
      const draw = sampleBeta(rng, alpha, beta);
      return { evaluation: { arm, visits: tally.observed + tally.inFlight, stats: { kind: "beta", alpha, beta, draw } }, value: draw };
    });
  }
  const totalVisits = tallies.reduce((sum, tally) => sum + tally.observed + tally.inFlight, 0);
  if (policy.kind === "puct") {
    const weights = arms.map((arm) => arm === "gen" ? policy.gen_prior_weight : ((index.byId.get(arm) as SearchAttempt).refine_prior ?? 1));
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
    return arms.map((arm, at) => {
      const tally = tallies[at];
      const visits = tally.observed + tally.inFlight;
      const prior = weightSum > 0 ? weights[at] / weightSum : 1 / arms.length;
      // In-flight visits count with reward 0: PUCT's form of virtual loss.
      const q = visits === 0 ? policy.q_init : tally.sum / visits;
      const score = q + policy.c_puct * prior * Math.sqrt(totalVisits) / (1 + visits);
      return { evaluation: { arm, visits, stats: { kind: "puct", prior, q, score } }, value: score };
    });
  }
  // arbor_eq1: one implementation of eq. 1 — the production scorer — with the
  // arm's visits as n_cat and the node's total visits as N.
  const action = {
    description: "",
    delegate_to: "",
    estimated_gain: config.step_prior.estimated_gain,
    estimated_cost: config.step_prior.estimated_cost,
    category: config.step_prior.category,
  };
  return arms.map((arm, at) => {
    const tally = tallies[at];
    const visits = tally.observed + tally.inFlight;
    const score = scoreAction(action, { ...policy.score_context, total_visits: totalVisits }, visits, policy.score_config);
    return { evaluation: { arm, visits, stats: { kind: "eq1", score } }, value: score };
  });
}

function descend(index: AttemptIndex, policy: DescentPolicy, config: SearchConfig, rng: SeededRng): SearchSelection | null {
  const levels: SearchDecisionLevel[] = [];
  let node: string | null = null;
  for (;;) {
    let arms = availableArms(index, node, config);
    // Only the base can have no arms: a child is an arm only when its subtree has an action.
    if (arms.length === 0) return null;
    if (policy.kind === "abmcts_beta" && arms[0] === "gen" && arms.length > 1) {
      const gate = evaluateArms(index, node, ["gen", "cont"], policy, config, rng);
      const wider = gate[0].value >= gate[1].value;
      levels.push({ node, arms: gate.map((entry) => entry.evaluation), chosen: wider ? "gen" : "cont" });
      if (wider) return { levels, action: node === null ? { kind: "gen" } : { kind: "refine", attempt_id: node } };
      arms = arms.slice(1);
    }
    const scored = evaluateArms(index, node, arms, policy, config, rng);
    const chosen = arms[argmax(scored.map((entry) => entry.value))];
    levels.push({ node, arms: scored.map((entry) => entry.evaluation), chosen });
    if (chosen === "gen") {
      return { levels, action: node === null ? { kind: "gen" } : { kind: "refine", attempt_id: node } };
    }
    node = chosen;
  }
}

function ruleLevel(index: AttemptIndex, node: string | null): SearchDecisionLevel {
  return { node, arms: [{ arm: "gen", visits: childrenOf(index, node).length, stats: { kind: "rule" } }], chosen: "gen" };
}

/**
 * Choose the next attempt for a step, or null when no action is available.
 * Pure given `rng`; the returned levels are the decision's replay evidence.
 */
export function selectSearchAction(state: SearchStepState, config: SearchConfig, rng: SeededRng): SearchSelection | null {
  const index = indexAttempts(state.attempts);
  const policy = config.policy;
  if (policy.kind === "best_of_n") {
    return canGenerate(index, null, config) ? { levels: [ruleLevel(index, null)], action: { kind: "gen" } } : null;
  }
  if (policy.kind === "refine_chain") {
    const latest = state.attempts[state.attempts.length - 1];
    if (latest !== undefined && canGenerate(index, latest.id, config)) {
      return { levels: [ruleLevel(index, latest.id)], action: { kind: "refine", attempt_id: latest.id } };
    }
    return canGenerate(index, null, config) ? { levels: [ruleLevel(index, null)], action: { kind: "gen" } } : null;
  }
  return descend(index, policy, config, rng);
}
