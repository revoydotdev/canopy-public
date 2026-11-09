// arbor-core/search/types — the pure search core's contracts.
// Governing records: ADR-186 (search policy core and the @arbor/search-runtime package), ADR-185 (reward is measured and provenance-typed).
//
// A search STEP is one OR-node: alternative attempts at the same plan step.
// An attempt is either GEN (a fresh attempt from the step's base state, "wider")
// or REFINE (continue an observed, unverified attempt with its failure context,
// "deeper"). Everything here is data; the functions in step.ts and policy.ts
// are pure over it, so a whole step can be replayed from its ledger events.

import type { ScoreConfig, ScoreContext } from "../types.js";
import type { VerifiedProvenance } from "../reward.js";

/** The selectable per-step policies. `best_of_n` is the permanent baseline arm. */
export type SearchPolicyKind = "abmcts_beta" | "puct" | "arbor_eq1" | "best_of_n" | "refine_chain";

export const SEARCH_POLICY_KINDS: readonly SearchPolicyKind[] = ["abmcts_beta", "puct", "arbor_eq1", "best_of_n", "refine_chain"];

/** Conjugate Beta prior over an arm's reward in [0, 1]. A planner prior may shape it; it is never backed up as a reward. */
export interface BetaPrior {
  readonly alpha: number;
  readonly beta: number;
}

export type SearchPolicyConfig =
  /** Thompson sampling over Beta posteriors: GEN vs each refinable child, descending the attempt tree (after AB-MCTS-A, arXiv 2503.04412). */
  | { readonly kind: "abmcts_beta"; readonly prior: BetaPrior; readonly virtual_loss: number }
  /** PUCT: Q + c·P·√N / (1 + n). P is `gen_prior_weight` for GEN and each attempt's `refine_prior` (default 1), normalised over available arms. */
  | { readonly kind: "puct"; readonly c_puct: number; readonly q_init: number; readonly gen_prior_weight: number }
  /** The Arbor paper's eq. 1 (`scoreAction`, classic mode) applied per arm, with the arm's visit count as n_cat. */
  | { readonly kind: "arbor_eq1"; readonly score_context: Omit<ScoreContext, "total_visits">; readonly score_config: ScoreConfig }
  /** Verifier-gated best-of-N: always GEN from the step base. */
  | { readonly kind: "best_of_n" }
  /** Always refine the most recently dispatched attempt while it is refinable; otherwise GEN. */
  | { readonly kind: "refine_chain" };

/** Stopping budget. USD is provider-measured cost reported with each observation. */
export interface SearchBudget {
  readonly max_usd: number;
  readonly max_attempts: number;
}

/** The planner's prior for this step's action. Used only by `arbor_eq1`; never a reward. */
export interface SearchStepPrior {
  readonly estimated_gain: number;
  readonly estimated_cost: number;
  readonly category: string;
}

export interface SearchConfig {
  readonly policy: SearchPolicyConfig;
  readonly seed: string;
  readonly budget: SearchBudget;
  /** Longest REFINE chain below a GEN attempt. 0 disables REFINE entirely. */
  readonly max_refine_depth: number;
  /** Most direct children any one node may have (GEN children of the base, REFINE children of an attempt). null = unbounded. */
  readonly max_width: number | null;
  readonly step_prior: SearchStepPrior;
}

/** The `!verified` provenance an observation must carry to end a step. */
// One definition, owned by the reward contract (the Stage 1 / Stage 2 join point).
export type { VerifiedProvenance };

/**
 * The reward the search core consumes for one attempt.
 *
 * JOIN POINT (Stage 1, lane U1): `reward` is the scalar the reward contract's
 * channel combiner produces in [0, 1]. This core only needs that number, the
 * attempt's `!verified` provenance when the verifier passed, and the
 * provider-measured cost. Verification stays separate from reward: a reward of
 * 1 without `verification` does not end the step, and `verification` requires
 * `reward === 1` so a verified attempt is never ranked below a failed one.
 */
export interface SearchRewardInput {
  readonly attempt_id: string;
  /**
   * Set when this attempt produced a byte-identical worktree tree to an
   * already-observed attempt of the same step (UCT plan Stage 6, transposition).
   * The observation is then a LINK, not a measurement: `reward` must equal the
   * original's, `verification` must be null (the `!verified` provenance stays
   * with the original, ADR-185), only `cost_usd` is the duplicate's own, and the
   * attempt is excluded from every policy tally so the posterior is not
   * updated twice for one patch.
   */
  readonly duplicate_of?: SearchDuplicateLink;
  readonly reward: number;
  readonly verification: VerifiedProvenance | null;
  readonly cost_usd: number;
  /** Optional PUCT prior weight for refining this attempt (e.g. a normalised planner or critic prior). */
  readonly refine_prior?: number;
}

/** The ledger-visible dedup decision: which observed attempt this one transposes onto, and the shared tree OID. */
export interface SearchDuplicateLink {
  readonly attempt_id: string;
  readonly digest: string;
}

export type SearchAction = { readonly kind: "gen" } | { readonly kind: "refine"; readonly attempt_id: string };

export interface SearchAttempt {
  readonly id: string;
  /** null for GEN (from the step base); otherwise the attempt this one refines. */
  readonly parent_id: string | null;
  /** 0 for GEN; parent depth + 1 for REFINE. */
  readonly depth: number;
  readonly status: "in_flight" | "observed";
  readonly reward: number | null;
  readonly verified: boolean;
  readonly cost_usd: number | null;
  readonly refine_prior: number | null;
  /** Present only on a transposed duplicate: the original attempt it links to. Duplicates are never selected, refined or tallied. */
  readonly duplicate_of?: string;
}

export interface SearchStepState {
  readonly step_id: string;
  /** In dispatch order. */
  readonly attempts: readonly SearchAttempt[];
  readonly decisions: number;
  readonly spent_usd: number;
}

export type SearchStopReason = "verified" | "usd_exhausted" | "attempt_cap" | "arms_exhausted";

/** "gen", "cont" (abmcts_beta's aggregate of all children), or the id of the child attempt the arm descends into. Attempt ids always contain "/", so they never collide with the two keywords. */
export type SearchArm = "gen" | "cont" | string;

export type SearchArmStats =
  | { readonly kind: "beta"; readonly alpha: number; readonly beta: number; readonly draw: number }
  | { readonly kind: "puct"; readonly prior: number; readonly q: number; readonly score: number }
  | { readonly kind: "eq1"; readonly score: number }
  | { readonly kind: "rule" };

export interface SearchArmEvaluation {
  readonly arm: SearchArm;
  readonly visits: number;
  readonly stats: SearchArmStats;
}

/** One level of the descent: the arms available at `node` (null = the step base) and the one chosen. */
export interface SearchDecisionLevel {
  readonly node: string | null;
  readonly arms: readonly SearchArmEvaluation[];
  readonly chosen: SearchArm;
}

export const SEARCH_DECISION_SCHEMA = "arbor.search.decision.v1";

/** Everything needed to re-derive and check one decision bit-for-bit. */
export interface SearchDecisionRecord {
  readonly schema: typeof SEARCH_DECISION_SCHEMA;
  readonly step_id: string;
  readonly decision_index: number;
  readonly policy: SearchPolicyKind;
  readonly seed: string;
  /** The uint32 RNG state this decision started from. */
  readonly rng_state: number;
  readonly levels: readonly SearchDecisionLevel[];
  readonly action: SearchAction;
  readonly attempt_id: string;
  readonly attempts_before: number;
  readonly spent_usd_before: number;
}

export type SearchLedgerEvent =
  | { readonly kind: "decision"; readonly record: SearchDecisionRecord }
  | { readonly kind: "observation"; readonly observation: SearchRewardInput };

export type SearchStepDecision =
  | { readonly kind: "dispatch"; readonly record: SearchDecisionRecord; readonly state: SearchStepState }
  /** Nothing is selectable now, but an in-flight attempt may still verify or unlock a REFINE arm. */
  | { readonly kind: "await" }
  | { readonly kind: "stop"; readonly reason: SearchStopReason };

export class SearchContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchContractError";
  }
}
