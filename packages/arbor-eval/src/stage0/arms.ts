/**
 * arbor-eval/stage0/arms — derive each arm's outcome on one (task, seed) unit.
 *
 * The attempts of a unit are independent production campaigns in a fixed
 * order a0, a1, …. Every arm is a stopping/selection policy over that order,
 * and the selection decisions are made by `@arbor/core`'s search step with the
 * `best_of_n` policy — the same pure code a production search would run — so
 * each arm's decisions come with replayable `SearchDecisionRecord`s.
 *
 * - `current`: the production path today. One campaign: a0.
 * - `best_of_n@B`: sequential, verifier-gated. Dispatch GEN until the first
 *   attempt with `!verified` provenance, the attempt cap B, or provider-
 *   measured spend ≥ B × usd_unit.
 * - `kwide@B`: the same stop rule with up to K attempts in flight per wave.
 *   A wave runs to completion (no cancellation of losers); the step stops
 *   after the first wave containing a verified attempt.
 *
 * The verifier gate selects on the campaign's own `!verified` result. The
 * outcome an arm is scored on is the SELECTED attempt's `verified_and_adopted`
 * (adopted and independently green), so a harness false acceptance costs the
 * arm its result rather than being hidden.
 */
import { applySearchObservation, createSearchStep, decideSearchStep } from "@arbor/core";
import type { SearchConfig, SearchDecisionRecord, SearchStepState, SearchStopReason } from "@arbor/core";
import type { Stage0AttemptRecord } from "./types.js";

export type Stage0ArmKind = "current" | "best_of_n" | "kwide";

export interface Stage0ArmOutcome {
  readonly arm: Stage0ArmKind;
  readonly budget: number;
  readonly task_id: string;
  readonly seed: number;
  /** Attempt indices the policy dispatched, in dispatch order. */
  readonly dispatched: readonly number[];
  /** The attempt the verifier gate selected, or null when none verified. */
  readonly selected: number | null;
  readonly verified_and_adopted: boolean;
  /** Harness said verified, but adoption, the independent acceptance run, or the protected-path check said no. */
  readonly false_acceptance: boolean;
  readonly cost_usd: number;
  /** Wall time to the arm's outcome: sequential sum for best_of_n, measured wave spans for kwide. */
  readonly wall_ms: number;
  readonly stop_reason: SearchStopReason | "single_attempt";
  readonly decisions: readonly SearchDecisionRecord[];
}

/** Raised when a unit lacks an attempt the policy needs: the unit is incomplete, not a failure. */
export class Stage0IncompleteUnitError extends Error {
  constructor(readonly task_id: string, readonly seed: number, readonly attempt_index: number) {
    super(`unit ${task_id}#${seed} has no attempt a${attempt_index}`);
    this.name = "Stage0IncompleteUnitError";
  }
}

const attemptIndexOf = (attemptId: string): number => {
  const match = /\/a(\d+)$/.exec(attemptId);
  if (match === null) throw new Error(`unexpected search attempt id ${attemptId}`);
  return Number(match[1]);
};

export function bestOfNConfig(taskId: string, seed: number, budget: number, usdUnit: number): SearchConfig {
  return {
    policy: { kind: "best_of_n" },
    seed: `stage0:${taskId}:${seed}`,
    budget: { max_usd: budget * usdUnit, max_attempts: budget },
    max_refine_depth: 0,
    max_width: null,
    step_prior: { estimated_gain: 1, estimated_cost: 1, category: "stage0" },
  };
}

function observe(state: SearchStepState, attemptId: string, attempt: Stage0AttemptRecord): SearchStepState {
  const verified = attempt.harness_verified && attempt.verification !== null && attempt.verification.exit === 0;
  return applySearchObservation(state, {
    attempt_id: attemptId,
    // The graded channel has no production producer yet (ADR-185 O4): a failure backs up an unmeasured 0.
    reward: verified ? 1 : 0,
    verification: verified ? attempt.verification : null,
    cost_usd: attempt.cost_usd,
  });
}

function byIndex(attempts: readonly Stage0AttemptRecord[]): Map<number, Stage0AttemptRecord> {
  const map = new Map<number, Stage0AttemptRecord>();
  for (const attempt of attempts) {
    if (map.has(attempt.attempt_index)) throw new Error(`duplicate attempt a${attempt.attempt_index} for ${attempt.task_id}#${attempt.seed}`);
    map.set(attempt.attempt_index, attempt);
  }
  return map;
}

function scoreSelection(selected: Stage0AttemptRecord | null): { verified_and_adopted: boolean; false_acceptance: boolean } {
  if (selected === null) return { verified_and_adopted: false, false_acceptance: false };
  return { verified_and_adopted: selected.verified_and_adopted, false_acceptance: !selected.verified_and_adopted };
}

export function deriveCurrent(attempts: readonly Stage0AttemptRecord[], taskId: string, seed: number): Stage0ArmOutcome {
  const first = byIndex(attempts).get(0);
  if (first === undefined) throw new Stage0IncompleteUnitError(taskId, seed, 0);
  const selected = first.harness_verified ? first : null;
  return {
    arm: "current",
    budget: 1,
    task_id: taskId,
    seed,
    dispatched: [0],
    selected: selected === null ? null : 0,
    ...scoreSelection(selected),
    cost_usd: first.cost_usd,
    wall_ms: first.wall_ms,
    stop_reason: "single_attempt",
    decisions: [],
  };
}

/**
 * Run the core `best_of_n` step over the unit's attempts with up to `width`
 * attempts in flight per wave. width = 1 is sequential best-of-N.
 */
function deriveGated(
  arm: "best_of_n" | "kwide",
  attempts: readonly Stage0AttemptRecord[],
  taskId: string,
  seed: number,
  budget: number,
  usdUnit: number,
  width: number,
  waveWallMs: (indices: readonly number[]) => number,
): Stage0ArmOutcome {
  if (!(Number.isInteger(width) && width >= 1)) throw new RangeError(`width must be a positive integer, got ${width}`);
  const config = bestOfNConfig(taskId, seed, budget, usdUnit);
  const indexed = byIndex(attempts);
  let state = createSearchStep(`${taskId}#${seed}`);
  const decisions: SearchDecisionRecord[] = [];
  const dispatched: number[] = [];
  let costUsd = 0;
  let wallMs = 0;
  let stopReason: SearchStopReason | null = null;
  let selected: Stage0AttemptRecord | null = null;
  while (stopReason === null) {
    const wave: { id: string; index: number }[] = [];
    while (wave.length < width) {
      const decision = decideSearchStep(state, config);
      if (decision.kind === "stop") {
        stopReason = decision.reason;
        break;
      }
      if (decision.kind === "await") break;
      decisions.push(decision.record);
      state = decision.state;
      wave.push({ id: decision.record.attempt_id, index: attemptIndexOf(decision.record.attempt_id) });
    }
    if (wave.length === 0) break;
    const landed = wave.map(({ id, index }) => {
      const attempt = indexed.get(index);
      if (attempt === undefined) throw new Stage0IncompleteUnitError(taskId, seed, index);
      return { id, attempt };
    });
    for (const { id, attempt } of landed) {
      state = observe(state, id, attempt);
      dispatched.push(attempt.attempt_index);
      costUsd += attempt.cost_usd;
    }
    wallMs += waveWallMs(landed.map(({ attempt }) => attempt.attempt_index));
    const verifiedInWave = landed
      .map(({ attempt }) => attempt)
      .filter((attempt) => attempt.harness_verified && attempt.verification !== null)
      // A race keeps the first to finish; ties break on attempt order.
      .sort((a, b) => a.finished_at.localeCompare(b.finished_at) || a.attempt_index - b.attempt_index);
    if (verifiedInWave.length > 0) selected = verifiedInWave[0];
  }
  const finalDecision = decideSearchStep(state, config);
  const reason = stopReason ?? (finalDecision.kind === "stop" ? finalDecision.reason : "arms_exhausted");
  return {
    arm,
    budget,
    task_id: taskId,
    seed,
    dispatched,
    selected: selected === null ? null : selected.attempt_index,
    ...scoreSelection(selected),
    cost_usd: costUsd,
    wall_ms: wallMs,
    stop_reason: reason,
    decisions,
  };
}

export function deriveBestOfN(attempts: readonly Stage0AttemptRecord[], taskId: string, seed: number, budget: number, usdUnit: number): Stage0ArmOutcome {
  const indexed = byIndex(attempts);
  return deriveGated("best_of_n", attempts, taskId, seed, budget, usdUnit, 1, (indices) =>
    indices.reduce((sum, index) => sum + (indexed.get(index)?.wall_ms ?? 0), 0));
}

/**
 * K-wide. `waveSpanMs` gives the measured wall span of the executed wave that
 * contained these attempts; when the derived wave matches an executed wave
 * this is the real elapsed time, otherwise the slowest member's wall time.
 */
export function deriveKWide(
  attempts: readonly Stage0AttemptRecord[],
  taskId: string,
  seed: number,
  budget: number,
  usdUnit: number,
  k: number,
  waveSpanMs?: (indices: readonly number[]) => number | null,
): Stage0ArmOutcome {
  const indexed = byIndex(attempts);
  const slowest = (indices: readonly number[]): number => Math.max(0, ...indices.map((index) => indexed.get(index)?.wall_ms ?? 0));
  return deriveGated("kwide", attempts, taskId, seed, budget, usdUnit, Math.min(k, budget), (indices) =>
    waveSpanMs?.(indices) ?? slowest(indices));
}

/**
 * The attempt indices a unit must have executed so every preregistered arm at
 * every budget level can be derived: the K-wide arm at the largest budget
 * dispatches a superset of what the sequential arm and smaller budgets need.
 * Returns the next wave to run, or [] when the unit is complete.
 */
export function nextWaveToRun(
  attempts: readonly Stage0AttemptRecord[],
  taskId: string,
  seed: number,
  maxBudget: number,
  usdUnit: number,
  k: number,
): number[] {
  try {
    deriveKWide(attempts, taskId, seed, maxBudget, usdUnit, k);
    return [];
  } catch (error) {
    if (!(error instanceof Stage0IncompleteUnitError)) throw error;
    const have = new Set(attempts.map((attempt) => attempt.attempt_index));
    const width = Math.min(k, maxBudget);
    const start = error.attempt_index - (error.attempt_index % width);
    const wave: number[] = [];
    for (let index = start; index < Math.min(start + width, maxBudget); index++) if (!have.has(index)) wave.push(index);
    return wave;
  }
}
