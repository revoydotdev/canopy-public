// Governing records: ADR-131 (measure before tuning), ADR-095 (efficacy is evidenced, not simulated).
import type { Provenance } from "@arbor/core";
import { evaluateEconomizationGuard, type EconomizationGuardResult } from "./trajectory-metrics.js";

export interface PairedEconomyTokens {
  /** Provider-measured fresh prompt input. */
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
}

export type PairedEconomyPrice =
  | { readonly kind: "priced"; readonly currency: string; readonly minor_unit_exponent: number; readonly minor_units: number; readonly price_source_id: string }
  | { readonly kind: "unpriced"; readonly reason: string };

export interface PairedEconomyAttempt {
  readonly task_id: string;
  readonly arm: "baseline" | "candidate";
  readonly scope: "calibration" | "held_out";
  readonly tokens: PairedEconomyTokens;
  readonly verified: boolean;
  readonly right_for_right_reasons: boolean;
  readonly false_acceptance: boolean;
  readonly succeeded: boolean;
  readonly correct: boolean;
  readonly grounded: boolean;
  readonly accepted: boolean;
  readonly price: PairedEconomyPrice;
}

export interface PairedEconomyPolicy {
  readonly minimum_matched_tasks: number;
  readonly minimum_effective_token_reduction: number;
  readonly minimum_candidate_priced_coverage: number;
  readonly max_r4r_regression: number;
  readonly max_false_acceptance_increase: number;
  readonly confidence: number;
  readonly weights: { readonly input: number; readonly cache_read: number; readonly cache_write: number; readonly output: number };
}

export interface PairedEconomyEvaluation {
  readonly schema: "arbor.paired-economy-eval/v1";
  readonly cohort_id: string;
  readonly mechanism: "cache" | "retrieval" | "combined";
  readonly scope: "calibration" | "held_out";
  readonly provenance: Provenance;
  /** Inputs are caller supplied observations; fixture labels cannot establish authority. */
  readonly evidence_authority: "fixture_asserted";
  readonly matched_tasks: number;
  readonly baseline: PairedArmSummary;
  readonly candidate: PairedArmSummary;
  readonly effective_token_reduction: number | null;
  readonly quality_regressions: {
    readonly verified: number;
    readonly right_for_right_reasons: number;
    readonly false_acceptance: number;
  };
  readonly promotion: {
    readonly status: "eligible" | "ineligible" | "insufficient_evidence" | "calibration_only" | "fixture_only";
    readonly reasons: readonly string[];
  };
  readonly quality_guard: EconomizationGuardResult;
  readonly policy: PairedEconomyPolicy;
}

export interface PairedArmSummary {
  readonly attempts: number;
  readonly verified: number;
  readonly right_for_right_reasons: number;
  readonly false_acceptance: number;
  readonly tokens: PairedEconomyTokens;
  readonly effective_tokens: number;
  readonly priced_coverage: number | null;
  readonly priced_totals: readonly { readonly currency: string; readonly minor_unit_exponent: number; readonly minor_units: number; readonly price_source_ids: readonly string[] }[];
  readonly unpriced_calls: number;
  readonly unpriced_reasons: readonly string[];
}

const DEFAULT_POLICY: PairedEconomyPolicy = Object.freeze({
  minimum_matched_tasks: 20,
  minimum_effective_token_reduction: 0.2,
  minimum_candidate_priced_coverage: 0.95,
  max_r4r_regression: 0.05,
  max_false_acceptance_increase: 0.01,
  confidence: 0.95,
  weights: Object.freeze({ input: 1, cache_read: 0.1, cache_write: 1.25, output: 4 }),
});

/**
 * Compare one baseline/candidate result for every identical task. Promotion is
 * held out only, requires minimum sample size, non-regression on each paired
 * quality signal, token reduction, and candidate price coverage. Quality
 * promotion uses the existing Wilson interval guard and remains unresolved
 * when the cohort cannot establish its configured non-inferiority bounds.
 * This JSON/fixture evaluator cannot verify evidence provenance, so it never
 * produces an authoritative promotion decision even when statistical checks pass.
 */
export function evaluatePairedEconomy(input: {
  readonly cohort_id: string;
  readonly mechanism: "cache" | "retrieval" | "combined";
  readonly provenance: Provenance;
  readonly attempts: readonly PairedEconomyAttempt[];
  readonly policy?: Partial<PairedEconomyPolicy>;
}): PairedEconomyEvaluation {
  if (!input.cohort_id.trim() || input.attempts.length === 0) throw new Error("paired economy evaluation requires a cohort id and attempts");
  const policy = resolvePolicy(input.policy);
  const rows = new Map<string, Partial<Record<PairedEconomyAttempt["arm"], PairedEconomyAttempt>>>();
  let scope: PairedEconomyAttempt["scope"] | null = null;
  for (const attempt of input.attempts) {
    validateAttempt(attempt);
    if (scope !== null && scope !== attempt.scope) throw new Error("paired economy cohort cannot mix calibration and held-out attempts");
    scope = attempt.scope;
    const pair = rows.get(attempt.task_id) ?? {};
    if (pair[attempt.arm] !== undefined) throw new Error(`duplicate ${attempt.arm} result for task ${attempt.task_id}`);
    pair[attempt.arm] = attempt;
    rows.set(attempt.task_id, pair);
  }
  const orderedPairs = [...rows.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [taskId, pair] of orderedPairs) {
    if (pair.baseline === undefined || pair.candidate === undefined) throw new Error(`paired economy task ${taskId} is missing one arm`);
  }
  const pairs = orderedPairs.map(([, pair]) => ({ baseline: pair.baseline!, candidate: pair.candidate! }));
  const baseline = summarizeArm(pairs.map((pair) => pair.baseline), policy.weights);
  const candidate = summarizeArm(pairs.map((pair) => pair.candidate), policy.weights);
  const qualityRegressions = {
    verified: pairs.filter(({ baseline: before, candidate: after }) => before.verified && !after.verified).length,
    right_for_right_reasons: pairs.filter(({ baseline: before, candidate: after }) => before.right_for_right_reasons && !after.right_for_right_reasons).length,
    false_acceptance: pairs.filter(({ baseline: before, candidate: after }) => !before.false_acceptance && after.false_acceptance).length,
  };
  const reduction = baseline.effective_tokens <= 0 ? null : round((baseline.effective_tokens - candidate.effective_tokens) / baseline.effective_tokens);
  const cohort = { cohort_id: input.cohort_id, scope: scope!, provenance: input.provenance } as const;
  const qualityGuard = evaluateEconomizationGuard(
    { config_id: "paired/baseline", effective_tokens: baseline.effective_tokens, outcomes: pairs.map(({ baseline: row }) => ({ task_id: row.task_id, succeeded: row.succeeded, correct: row.correct, grounded: row.grounded, accepted: row.accepted, right_for_right_reasons: row.right_for_right_reasons, false_acceptance: row.false_acceptance })), cohort },
    { config_id: "paired/candidate", effective_tokens: candidate.effective_tokens, outcomes: pairs.map(({ candidate: row }) => ({ task_id: row.task_id, succeeded: row.succeeded, correct: row.correct, grounded: row.grounded, accepted: row.accepted, right_for_right_reasons: row.right_for_right_reasons, false_acceptance: row.false_acceptance })), cohort },
    { min_token_reduction_ratio: policy.minimum_effective_token_reduction, max_r4r_regression: policy.max_r4r_regression, max_false_acceptance_increase: policy.max_false_acceptance_increase, confidence: policy.confidence },
  );
  const reasons: string[] = [];
  let status: PairedEconomyEvaluation["promotion"]["status"];
  if (scope === "calibration") {
    status = "calibration_only";
    reasons.push("calibration cohorts cannot promote a policy");
  } else {
    if (pairs.length < policy.minimum_matched_tasks) reasons.push(`matched tasks ${pairs.length} below minimum ${policy.minimum_matched_tasks}`);
    if (qualityGuard.decision !== "eligible") reasons.push(qualityGuard.reason);
    if (candidate.priced_coverage === null || candidate.priced_coverage < policy.minimum_candidate_priced_coverage) reasons.push("candidate priced-cost coverage is below policy or unavailable");
    if (qualityRegressions.verified > 0) reasons.push("candidate regressed on verified outcomes");
    if (qualityRegressions.right_for_right_reasons > 0) reasons.push("candidate regressed on right-for-right-reasons outcomes");
    if (qualityRegressions.false_acceptance > 0) reasons.push("candidate increased false acceptance on a matched task");
    if (pairs.length < policy.minimum_matched_tasks || qualityGuard.decision === "unresolved") status = "insufficient_evidence";
    else if (reasons.length > 0) status = "ineligible";
    else {
      status = "fixture_only";
      reasons.push("fixture observations and caller-supplied provenance cannot authorize policy promotion");
    }
  }
  return Object.freeze({
    schema: "arbor.paired-economy-eval/v1", cohort_id: input.cohort_id, mechanism: input.mechanism,
    scope: scope!, provenance: input.provenance, evidence_authority: "fixture_asserted", matched_tasks: pairs.length, baseline, candidate,
    effective_token_reduction: reduction, quality_regressions: Object.freeze(qualityRegressions),
    promotion: Object.freeze({ status, reasons: Object.freeze(reasons) }), quality_guard: qualityGuard, policy,
  });
}

export function generatePairedEconomyReport(evaluation: PairedEconomyEvaluation): string {
  return [
    `# Paired economy evaluation: ${evaluation.cohort_id}`,
    "",
    `- Mechanism: ${evaluation.mechanism}`,
    `- Scope: ${evaluation.scope}`,
    `- Evidence authority: ${evaluation.evidence_authority} (caller-supplied observations cannot authorize promotion)`,
    `- Matched tasks: ${evaluation.matched_tasks}`,
    `- Promotion status: ${evaluation.promotion.status}`,
    `- Baseline effective tokens: ${evaluation.baseline.effective_tokens}`,
    `- Candidate effective tokens: ${evaluation.candidate.effective_tokens}`,
    `- Effective token reduction: ${evaluation.effective_token_reduction === null ? "unavailable" : `${(evaluation.effective_token_reduction * 100).toFixed(2)}%`}`,
    `- Candidate priced coverage: ${evaluation.candidate.priced_coverage === null ? "unavailable" : `${(evaluation.candidate.priced_coverage * 100).toFixed(2)}%`}`,
    `- Candidate unpriced calls: ${evaluation.candidate.unpriced_calls}`,
    `- Cache read/write tokens: ${evaluation.candidate.tokens.cache_read_tokens}/${evaluation.candidate.tokens.cache_write_tokens}`,
    `- Candidate priced totals: ${evaluation.candidate.priced_totals.length === 0 ? "unavailable" : evaluation.candidate.priced_totals.map((row) => `${row.currency}e${row.minor_unit_exponent} ${row.minor_units} (${row.price_source_ids.join(", ")})`).join("; ")}`,
    `- Candidate unpriced reasons: ${evaluation.candidate.unpriced_reasons.length === 0 ? "none" : evaluation.candidate.unpriced_reasons.join("; ")}`,
    `- Quality regressions (verified/right-for-right-reasons/false-acceptance): ${evaluation.quality_regressions.verified}/${evaluation.quality_regressions.right_for_right_reasons}/${evaluation.quality_regressions.false_acceptance}`,
    "",
    "## Decision reasons",
    "",
    ...(evaluation.promotion.reasons.length === 0 ? ["- No policy condition failed."] : evaluation.promotion.reasons.map((reason) => `- ${reason}`)),
    "",
    `Quality guard: ${evaluation.quality_guard.decision} (${evaluation.quality_guard.reason}); R4R delta interval ${evaluation.quality_guard.r4r_delta_interval.join(" to ")}; false-acceptance delta interval ${evaluation.quality_guard.false_acceptance_delta_interval.join(" to ")}.`,
    "Price totals remain grouped by currency and minor-unit exponent; unpriced observations never become zero cost.",
  ].join("\n");
}

function summarizeArm(attempts: readonly PairedEconomyAttempt[], weights: PairedEconomyPolicy["weights"]): PairedArmSummary {
  const tokens = attempts.reduce((total, attempt) => ({
    input_tokens: total.input_tokens + attempt.tokens.input_tokens,
    output_tokens: total.output_tokens + attempt.tokens.output_tokens,
    cache_read_tokens: total.cache_read_tokens + attempt.tokens.cache_read_tokens,
    cache_write_tokens: total.cache_write_tokens + attempt.tokens.cache_write_tokens,
  }), { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
  const prices = new Map<string, { currency: string; minor_unit_exponent: number; minor_units: number; price_source_ids: Set<string> }>();
  const unpricedReasons = new Set<string>();
  let unpricedCalls = 0;
  for (const attempt of attempts) {
    if (attempt.price.kind === "unpriced") { unpricedCalls++; unpricedReasons.add(attempt.price.reason); continue; }
    const key = `${attempt.price.currency}\0${attempt.price.minor_unit_exponent}`;
    const row = prices.get(key) ?? { currency: attempt.price.currency, minor_unit_exponent: attempt.price.minor_unit_exponent, minor_units: 0, price_source_ids: new Set<string>() };
    row.minor_units += attempt.price.minor_units;
    row.price_source_ids.add(attempt.price.price_source_id);
    prices.set(key, row);
  }
  const pricedAttempts = attempts.length - unpricedCalls;
  return Object.freeze({
    attempts: attempts.length,
    verified: attempts.filter((attempt) => attempt.verified).length,
    right_for_right_reasons: attempts.filter((attempt) => attempt.right_for_right_reasons).length,
    false_acceptance: attempts.filter((attempt) => attempt.false_acceptance).length,
    tokens: Object.freeze(tokens),
    effective_tokens: tokens.input_tokens * weights.input + tokens.cache_read_tokens * weights.cache_read
      + tokens.cache_write_tokens * weights.cache_write + tokens.output_tokens * weights.output,
    priced_coverage: attempts.length === 0 ? null : round(pricedAttempts / attempts.length),
    priced_totals: Object.freeze([...prices.values()].sort((a, b) => a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : a.minor_unit_exponent - b.minor_unit_exponent).map((row) => Object.freeze({ ...row, price_source_ids: Object.freeze([...row.price_source_ids].sort()) }))),
    unpriced_calls: unpricedCalls,
    unpriced_reasons: Object.freeze([...unpricedReasons].sort()),
  });
}

function resolvePolicy(policy: Partial<PairedEconomyPolicy> | undefined): PairedEconomyPolicy {
  const weights = { ...DEFAULT_POLICY.weights, ...(policy?.weights ?? {}) };
  const resolved = { ...DEFAULT_POLICY, ...policy, weights: Object.freeze(weights) };
  if (!Number.isSafeInteger(resolved.minimum_matched_tasks) || resolved.minimum_matched_tasks < 1
    || !ratio(resolved.minimum_effective_token_reduction) || !ratio(resolved.minimum_candidate_priced_coverage)
    || !ratio(resolved.max_r4r_regression) || !ratio(resolved.max_false_acceptance_increase) || !Number.isFinite(resolved.confidence) || resolved.confidence <= 0 || resolved.confidence >= 1
    || Object.values(weights).some((weight) => !Number.isFinite(weight) || weight < 0)) throw new Error("invalid paired economy policy");
  return Object.freeze(resolved);
}

function validateAttempt(attempt: PairedEconomyAttempt): void {
  if (!attempt.task_id.trim() || !["baseline", "candidate"].includes(attempt.arm) || !["calibration", "held_out"].includes(attempt.scope)
    || Object.values(attempt.tokens).some((value) => !Number.isSafeInteger(value) || value < 0)
    || typeof attempt.verified !== "boolean" || typeof attempt.right_for_right_reasons !== "boolean" || typeof attempt.false_acceptance !== "boolean"
    || typeof attempt.succeeded !== "boolean" || typeof attempt.correct !== "boolean" || typeof attempt.grounded !== "boolean" || typeof attempt.accepted !== "boolean"
    || attempt.right_for_right_reasons !== (attempt.succeeded && attempt.correct && attempt.grounded)
    || attempt.false_acceptance !== (attempt.accepted && !attempt.correct)) throw new Error("invalid paired economy attempt or inconsistent quality labels");
  if (attempt.price.kind === "priced") {
    if (!attempt.price.currency.trim() || !Number.isSafeInteger(attempt.price.minor_unit_exponent) || attempt.price.minor_unit_exponent < 0 || attempt.price.minor_unit_exponent > 9
      || !Number.isSafeInteger(attempt.price.minor_units) || attempt.price.minor_units < 0 || !attempt.price.price_source_id.trim()) throw new Error("invalid priced economy observation");
  } else if (!attempt.price.reason.trim()) throw new Error("unpriced economy observation requires a reason");
}
function ratio(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 1; }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
