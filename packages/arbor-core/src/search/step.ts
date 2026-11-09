// arbor-core/search/step — one search step as a pure, replayable state machine.
// Governing records: ADR-186 (search policy core and the @arbor/search-runtime package), ADR-185 (reward is measured and provenance-typed).
//
// decideSearchStep  state → dispatch (with its replay record) | await | stop
// applySearchObservation  state × reward → state
// replaySearchStep  ledger events → state, re-deriving and checking every decision
//
// Stopping (operator decisions 2026-10-06): the first `!verified` attempt ends
// the step (first-verified objective); otherwise the step stops when the
// provider-measured USD spend or the attempt cap is reached, or when the policy
// has no action left. Reaching a limit while an attempt is still in flight is
// "await", not "stop": that attempt may yet verify.

import { selectSearchAction } from "./policy.js";
import { createSeededRng, deriveDecisionState } from "./rng.js";
import {
  SEARCH_DECISION_SCHEMA,
  SEARCH_POLICY_KINDS,
  SearchContractError,
} from "./types.js";
import type {
  SearchAttempt,
  SearchConfig,
  SearchDecisionRecord,
  SearchLedgerEvent,
  SearchRewardInput,
  SearchStepDecision,
  SearchStepState,
} from "./types.js";

export function createSearchStep(stepId: string): SearchStepState {
  if (stepId.length === 0) throw new SearchContractError("step_id must be non-empty");
  return { step_id: stepId, attempts: [], decisions: 0, spent_usd: 0 };
}

const isNonNegativeFinite = (value: number): boolean => Number.isFinite(value) && value >= 0;
const isNonNegativeInteger = (value: number): boolean => Number.isInteger(value) && value >= 0;

/** Every problem with a search configuration; empty when it is usable. */
export function validateSearchConfig(config: SearchConfig): string[] {
  const problems: string[] = [];
  if (!SEARCH_POLICY_KINDS.includes(config.policy.kind)) problems.push(`unknown policy ${String(config.policy.kind)}`);
  if (config.seed.length === 0) problems.push("seed must be non-empty");
  if (!(Number.isFinite(config.budget.max_usd) && config.budget.max_usd > 0)) problems.push("budget.max_usd must be finite and > 0");
  if (!(Number.isInteger(config.budget.max_attempts) && config.budget.max_attempts >= 1)) problems.push("budget.max_attempts must be an integer >= 1");
  if (!isNonNegativeInteger(config.max_refine_depth)) problems.push("max_refine_depth must be an integer >= 0");
  if (config.max_width !== null && !(Number.isInteger(config.max_width) && config.max_width >= 1)) problems.push("max_width must be null or an integer >= 1");
  const policy = config.policy;
  if (policy.kind === "abmcts_beta") {
    if (!(Number.isFinite(policy.prior.alpha) && policy.prior.alpha > 0 && Number.isFinite(policy.prior.beta) && policy.prior.beta > 0)) {
      problems.push("abmcts_beta prior alpha and beta must be finite and > 0");
    }
    if (!isNonNegativeFinite(policy.virtual_loss)) problems.push("abmcts_beta virtual_loss must be finite and >= 0");
  } else if (policy.kind === "puct") {
    if (!isNonNegativeFinite(policy.c_puct)) problems.push("puct c_puct must be finite and >= 0");
    if (!(Number.isFinite(policy.q_init) && policy.q_init >= 0 && policy.q_init <= 1)) problems.push("puct q_init must be in [0, 1]");
    if (!isNonNegativeFinite(policy.gen_prior_weight)) problems.push("puct gen_prior_weight must be finite and >= 0");
  }
  return problems;
}

function assertValidConfig(config: SearchConfig): void {
  const problems = validateSearchConfig(config);
  if (problems.length > 0) throw new SearchContractError(`invalid search config: ${problems.join("; ")}`);
}

/**
 * The next move for a step. A "dispatch" carries the new state, with the new
 * attempt in flight, and the decision's replay record, which the caller writes
 * to the ledger before dispatching.
 */
export function decideSearchStep(state: SearchStepState, config: SearchConfig): SearchStepDecision {
  assertValidConfig(config);
  if (state.attempts.some((attempt) => attempt.verified)) return { kind: "stop", reason: "verified" };
  const inFlight = state.attempts.some((attempt) => attempt.status === "in_flight");
  const limit = state.attempts.length >= config.budget.max_attempts ? "attempt_cap"
    : state.spent_usd >= config.budget.max_usd ? "usd_exhausted"
      : null;
  if (limit !== null) return inFlight ? { kind: "await" } : { kind: "stop", reason: limit };

  const rngState = deriveDecisionState(config.seed, state.step_id, state.decisions);
  const selection = selectSearchAction(state, config, createSeededRng(rngState));
  if (selection === null) return inFlight ? { kind: "await" } : { kind: "stop", reason: "arms_exhausted" };

  const attemptId = `${state.step_id}/a${state.attempts.length}`;
  const parent = selection.action.kind === "refine"
    ? state.attempts.find((attempt) => attempt.id === (selection.action as { attempt_id: string }).attempt_id) as SearchAttempt
    : null;
  const attempt: SearchAttempt = {
    id: attemptId,
    parent_id: parent === null ? null : parent.id,
    depth: parent === null ? 0 : parent.depth + 1,
    status: "in_flight",
    reward: null,
    verified: false,
    cost_usd: null,
    refine_prior: null,
  };
  const record: SearchDecisionRecord = {
    schema: SEARCH_DECISION_SCHEMA,
    step_id: state.step_id,
    decision_index: state.decisions,
    policy: config.policy.kind,
    seed: config.seed,
    rng_state: rngState,
    levels: selection.levels,
    action: selection.action,
    attempt_id: attemptId,
    attempts_before: state.attempts.length,
    spent_usd_before: state.spent_usd,
  };
  return {
    kind: "dispatch",
    record,
    state: { ...state, attempts: [...state.attempts, attempt], decisions: state.decisions + 1 },
  };
}

/** Land one attempt's reward. Throws SearchContractError on any contract violation. */
export function applySearchObservation(state: SearchStepState, observation: SearchRewardInput): SearchStepState {
  const at = state.attempts.findIndex((attempt) => attempt.id === observation.attempt_id);
  if (at < 0) throw new SearchContractError(`observation for unknown attempt ${observation.attempt_id}`);
  if (state.attempts[at].status !== "in_flight") throw new SearchContractError(`attempt ${observation.attempt_id} was already observed`);
  if (!(Number.isFinite(observation.reward) && observation.reward >= 0 && observation.reward <= 1)) {
    throw new SearchContractError(`reward must be in [0, 1], got ${observation.reward}`);
  }
  if (!isNonNegativeFinite(observation.cost_usd)) throw new SearchContractError(`cost_usd must be finite and >= 0, got ${observation.cost_usd}`);
  if (observation.refine_prior !== undefined && !isNonNegativeFinite(observation.refine_prior)) {
    throw new SearchContractError(`refine_prior must be finite and >= 0, got ${observation.refine_prior}`);
  }
  const verification = observation.verification;
  if (verification !== null) {
    if (verification.tag !== "verified" || verification.exit !== 0) {
      throw new SearchContractError("verification must be !verified provenance with exit 0");
    }
    if (observation.reward !== 1) throw new SearchContractError("a verified attempt must carry reward 1");
  }
  const link = observation.duplicate_of;
  if (link !== undefined) {
    if (verification !== null) throw new SearchContractError("a duplicate links to its original's verification; it must not carry its own");
    const original = state.attempts.find((attempt) => attempt.id === link.attempt_id);
    if (original === undefined || original.id === observation.attempt_id) throw new SearchContractError(`duplicate_of names unknown attempt ${link.attempt_id}`);
    if (original.status !== "observed" || original.duplicate_of !== undefined) {
      throw new SearchContractError(`duplicate_of must name an observed, non-duplicate attempt, got ${link.attempt_id}`);
    }
    if (link.digest.length === 0) throw new SearchContractError("duplicate_of digest must be non-empty");
    if (!Object.is(original.reward, observation.reward)) throw new SearchContractError("a duplicate must carry its original's reward");
  }
  const attempts = state.attempts.slice();
  attempts[at] = {
    ...attempts[at],
    ...(link === undefined ? {} : { duplicate_of: link.attempt_id }),
    status: "observed",
    reward: observation.reward,
    verified: verification !== null,
    cost_usd: observation.cost_usd,
    refine_prior: observation.refine_prior ?? null,
  };
  return { ...state, attempts, spent_usd: state.spent_usd + observation.cost_usd };
}

/** Structural equality where numbers must be identical (Object.is), so replay is bit-for-bit. */
function exactlyEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" || typeof right === "number") return Object.is(left, right);
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return left === right;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, at) => key !== rightKeys[at])) return false;
  return leftKeys.every((key) => exactlyEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

export type SearchReplayResult =
  | { readonly ok: true; readonly state: SearchStepState; readonly next: SearchStepDecision }
  | {
    readonly ok: false;
    readonly event_index: number;
    readonly reason: string;
    readonly expected: SearchDecisionRecord | null;
    readonly actual: SearchDecisionRecord | null;
  };

/**
 * Rebuild a step from its ledger events, in ledger order. Every decision is
 * re-derived from the reconstructed state and must equal the recorded one
 * exactly, RNG draws included; the first divergence is reported, not skipped.
 */
export function replaySearchStep(stepId: string, config: SearchConfig, events: readonly SearchLedgerEvent[]): SearchReplayResult {
  let state = createSearchStep(stepId);
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    if (event.kind === "observation") {
      try {
        state = applySearchObservation(state, event.observation);
      } catch (error) {
        return { ok: false, event_index: eventIndex, reason: (error as Error).message, expected: null, actual: null };
      }
      continue;
    }
    const decision = decideSearchStep(state, config);
    if (decision.kind !== "dispatch") {
      return { ok: false, event_index: eventIndex, reason: `recorded a decision where the policy yields ${decision.kind}`, expected: event.record, actual: null };
    }
    if (!exactlyEqual(decision.record, event.record)) {
      return { ok: false, event_index: eventIndex, reason: "re-derived decision differs from the recorded one", expected: event.record, actual: decision.record };
    }
    state = decision.state;
  }
  return { ok: true, state, next: decideSearchStep(state, config) };
}
