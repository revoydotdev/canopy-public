// arbor-search-runtime/driver — the sequential (K = 1) step driver.
// Governing records: ADR-186 (search policy core and the @arbor/search-runtime package), ADR-185 (reward is measured and provenance-typed).
//
// It owns ordering and nothing else: every selection decision comes from
// @arbor/core's pure `decideSearchStep`, every reward is validated by
// `applySearchObservation`, and both are written to the ledger in the order
// they took effect, so `replaySearchStep` over the same events rebuilds the
// step exactly. The decision is written BEFORE its attempt is dispatched
// (write-ahead): a crash mid-attempt leaves a ledger whose replay shows that
// attempt in flight, never an attempt with no recorded reason.
//
// What an attempt IS — a worktree lease, a specialist episode, the verifier —
// belongs to the `SearchAttemptDispatcher` the caller supplies (UCT plan
// Stage 3). Parallel width (K > 1) is Stage 4 and is not handled here.

import { applySearchObservation, createSearchStep, decideSearchStep, SearchContractError } from "@arbor/core";
import type {
  SearchAction,
  SearchConfig,
  SearchDecisionRecord,
  SearchLedgerEvent,
  SearchRewardInput,
  SearchStepState,
  SearchStopReason,
} from "@arbor/core";

export interface SearchAttemptRequest {
  readonly step_id: string;
  readonly attempt_id: string;
  readonly action: SearchAction;
  /** The decision that chose this attempt, already in the ledger. */
  readonly decision: SearchDecisionRecord;
}

/**
 * Runs one attempt and reports its reward. Implementations must report
 * `verification` only from a `!verified` verifier result, and `cost_usd` as the
 * provider-measured spend of the attempt.
 */
export interface SearchAttemptDispatcher {
  dispatch(request: SearchAttemptRequest): Promise<SearchRewardInput>;
}

/** Durable, ordered storage for a step's events. */
export interface SearchLedgerSink {
  append(event: SearchLedgerEvent): Promise<void>;
}

export interface SearchStepRunInput {
  readonly step_id: string;
  readonly config: SearchConfig;
  readonly dispatcher: SearchAttemptDispatcher;
  readonly ledger: SearchLedgerSink;
}

export interface SearchStepRunResult {
  readonly state: SearchStepState;
  readonly stop_reason: SearchStopReason;
}

/** Drive one step to its stop: first `!verified` attempt, budget, attempt cap, or no remaining arm. */
export async function runSearchStep(input: SearchStepRunInput): Promise<SearchStepRunResult> {
  let state = createSearchStep(input.step_id);
  for (;;) {
    const decision = decideSearchStep(state, input.config);
    if (decision.kind === "stop") return { state, stop_reason: decision.reason };
    // A sequential driver observes every attempt before deciding again, so the
    // core can never be waiting on one.
    if (decision.kind === "await") throw new SearchContractError("sequential driver reached an await with no attempt in flight");
    await input.ledger.append({ kind: "decision", record: decision.record });
    const observation = await input.dispatcher.dispatch({
      step_id: input.step_id,
      attempt_id: decision.record.attempt_id,
      action: decision.record.action,
      decision: decision.record,
    });
    if (observation.attempt_id !== decision.record.attempt_id) {
      throw new SearchContractError(`dispatcher answered for ${observation.attempt_id}, expected ${decision.record.attempt_id}`);
    }
    const next = applySearchObservation(decision.state, observation);
    await input.ledger.append({ kind: "observation", observation });
    state = next;
  }
}
