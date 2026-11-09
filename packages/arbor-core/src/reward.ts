// arbor-core/reward — the provenance-typed reward contract (ADR-185).
//
// What a terminal transition backs up the tree, and what `best_score` and the
// below-threshold halt read, is derived here and ONLY from measured outcomes.
// Before this module the manager backed up `scoreAction(...)` — the node's own
// selection score (planner gain/cost priors plus an exploration bonus) — so the
// "reward" was the scheduler's estimate fed back in as if it were a result.
//
// The contract, in order of precedence:
//   1. A `!verified` terminal pass is worth exactly 1.
//   2. Otherwise the fraction of machine-verification stages that passed,
//      weighted by `graded_weight` and bounded by `ceiling` < 1, so no
//      unverified outcome can ever reach a verified one.
//   3. A critic estimate contributes only through a recorded calibration;
//      with no calibration its weight is 0 (operator decision 2026-10-06).
//   4. Planner priors (`estimated_gain`, `estimated_cost`) are not an input to
//      anything here. The observation types carry no field for them, and the
//      combiner reads only the fields it names, so a prior cannot reach a
//      backed-up value by construction.
//
// Pure, synchronous, dependency-free: the same observations always produce a
// byte-identical `BackedUpReward`, in any input order, so a replay of the
// recorded observations reproduces the recorded value.

import type { Provenance } from "./types.js";

/** `!verified` provenance, the only kind that can be a terminal pass. */
export type VerifiedProvenance = Extract<Provenance, { tag: "verified" }>;

/** A ledger-recorded calibration of an estimator against verifier outcomes. */
export interface RewardCalibration {
  readonly calibration_id: string;
  /** Weight the calibration earned for this estimator, in [0, ceiling − graded_weight]. */
  readonly weight: number;
}

/** One measured or estimated signal about a terminal outcome. */
export type RewardObservation =
  | {
    readonly channel: "terminal";
    /** The `!verified` provenance the node was actually verified with. */
    readonly provenance: VerifiedProvenance;
  }
  | {
    readonly channel: "graded";
    readonly source: "verification_stage_fraction";
    readonly stages_passed: number;
    readonly stages_total: number;
  }
  | {
    readonly channel: "estimate";
    readonly source: "critic_confidence";
    /** The estimator's own value in [0, 1]. */
    readonly value: number;
    /** `null` until a calibration is recorded; an uncalibrated estimate weighs 0. */
    readonly calibration: RewardCalibration | null;
  };

/** Named weights for combining channels. `graded_weight ≤ ceiling < 1`. */
export interface RewardContractConfig {
  readonly graded_weight: number;
  readonly ceiling: number;
}

export const DEFAULT_REWARD_CONTRACT: RewardContractConfig = { graded_weight: 0.9, ceiling: 0.9 };

/**
 * Which signal the backed-up value came from.
 * - `verified_terminal`: a `!verified` pass (value 1).
 * - `measured_partial`: a machine-measured stage fraction, possibly plus a calibrated estimate.
 * - `calibrated_estimate`: only a calibrated estimate contributed; not a measurement.
 * - `unmeasured`: nothing measured and nothing calibrated (value 0, and not a low score).
 */
export type RewardSource = "verified_terminal" | "measured_partial" | "calibrated_estimate" | "unmeasured";

/** One observation's audited contribution to the backed-up value. */
export interface RewardComponent {
  readonly channel: RewardObservation["channel"];
  readonly source: "verified_terminal" | "verification_stage_fraction" | "critic_confidence";
  /** The observation's own value in [0, 1] before weighting. */
  readonly raw: number;
  readonly weight: number;
  readonly contribution: number;
  /** Provenance tag of the evidence behind this component. */
  readonly provenance_tag: Provenance["tag"];
  readonly calibration_id: string | null;
}

/** The value a terminal transition backs up, with the evidence it came from. */
export interface BackedUpReward {
  /** In [0, 1]; exactly 1 only for a `!verified` terminal pass. */
  readonly value: number;
  readonly source: RewardSource;
  /** True only when a machine measurement (terminal or graded) backs the value. */
  readonly measured: boolean;
  /** Provenance tag of the dominant evidence; `null` when unmeasured. */
  readonly provenance_tag: Provenance["tag"] | null;
  /** Every observation's contribution, in canonical order, including zero-weight estimates. */
  readonly components: readonly RewardComponent[];
}

export class RewardContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RewardContractError";
  }
}

const CHANNEL_ORDER: Record<RewardObservation["channel"], number> = { terminal: 0, graded: 1, estimate: 2 };

function unitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function assertConfig(config: RewardContractConfig): void {
  if (!Number.isFinite(config.ceiling) || config.ceiling < 0 || config.ceiling >= 1) {
    throw new RewardContractError(`reward ceiling must be in [0, 1); got ${config.ceiling}`);
  }
  if (!Number.isFinite(config.graded_weight) || config.graded_weight < 0 || config.graded_weight > config.ceiling) {
    throw new RewardContractError(`graded_weight must be in [0, ceiling]; got ${config.graded_weight}`);
  }
}

function componentOf(observation: RewardObservation, config: RewardContractConfig): RewardComponent {
  switch (observation.channel) {
    case "terminal": {
      if (observation.provenance?.tag !== "verified") {
        throw new RewardContractError("a terminal reward requires !verified provenance");
      }
      return { channel: "terminal", source: "verified_terminal", raw: 1, weight: 1, contribution: 1, provenance_tag: "verified", calibration_id: null };
    }
    case "graded": {
      const { stages_passed: passed, stages_total: total } = observation;
      if (!Number.isSafeInteger(passed) || !Number.isSafeInteger(total) || total < 1 || passed < 0 || passed > total) {
        throw new RewardContractError(`stage counts must be integers with 0 ≤ passed ≤ total, total ≥ 1; got ${passed}/${total}`);
      }
      const raw = passed / total;
      return {
        channel: "graded", source: "verification_stage_fraction", raw, weight: config.graded_weight,
        contribution: config.graded_weight * raw, provenance_tag: "generated", calibration_id: null,
      };
    }
    case "estimate": {
      if (!unitInterval(observation.value)) {
        throw new RewardContractError(`an estimate must be in [0, 1]; got ${observation.value}`);
      }
      const calibration = observation.calibration;
      let weight = 0;
      if (calibration !== null) {
        if (typeof calibration.calibration_id !== "string" || calibration.calibration_id.trim().length === 0) {
          throw new RewardContractError("a calibration must name the ledger record it came from");
        }
        if (!Number.isFinite(calibration.weight) || calibration.weight < 0 || calibration.weight > config.ceiling - config.graded_weight) {
          throw new RewardContractError(`calibration weight must be in [0, ceiling − graded_weight]; got ${calibration.weight}`);
        }
        weight = calibration.weight;
      }
      return {
        channel: "estimate", source: "critic_confidence", raw: observation.value, weight,
        contribution: weight * observation.value, provenance_tag: "critic_approved",
        calibration_id: calibration?.calibration_id ?? null,
      };
    }
    default:
      throw new RewardContractError(`unknown reward channel ${(observation as { channel?: unknown }).channel as string}`);
  }
}

function compareComponents(left: RewardComponent, right: RewardComponent): number {
  return CHANNEL_ORDER[left.channel] - CHANNEL_ORDER[right.channel]
    || right.contribution - left.contribution
    || right.raw - left.raw
    || (left.calibration_id ?? "").localeCompare(right.calibration_id ?? "");
}

/**
 * Combine a terminal outcome's observations into the value that is backed up.
 *
 *   r = 1                                              if any `!verified` terminal pass
 *   r = min(τ, w_g · max(graded) + max(w_e · estimate)) otherwise
 *
 * Within a channel the strongest observation counts (order-independent, so a
 * replay in any order reproduces the value). Invalid input throws
 * `RewardContractError` rather than being coerced: a reward that cannot be
 * justified is not silently replaced with a plausible number.
 */
export function combineReward(
  observations: readonly RewardObservation[],
  config: RewardContractConfig = DEFAULT_REWARD_CONTRACT,
): BackedUpReward {
  assertConfig(config);
  const components = observations.map((observation) => componentOf(observation, config)).sort(compareComponents);

  if (components.some((component) => component.channel === "terminal")) {
    return { value: 1, source: "verified_terminal", measured: true, provenance_tag: "verified", components };
  }

  const best = (channel: RewardObservation["channel"]): RewardComponent | null =>
    components.find((component) => component.channel === channel) ?? null;
  const graded = best("graded");
  const estimate = best("estimate");
  const estimateContribution = estimate?.contribution ?? 0;
  const value = Math.min(config.ceiling, (graded?.contribution ?? 0) + estimateContribution);

  if (graded !== null) {
    return { value, source: "measured_partial", measured: true, provenance_tag: "generated", components };
  }
  if (estimateContribution > 0) {
    return { value, source: "calibrated_estimate", measured: false, provenance_tag: "critic_approved", components };
  }
  return { value: 0, source: "unmeasured", measured: false, provenance_tag: null, components };
}
