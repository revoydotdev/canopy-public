/** Deterministic cohort metrics over explicitly captured governance episodes. Governing records: ADR-095, ADR-131. */
import { canonicalizeForHash } from "@arbor/core";
import { createHash } from "node:crypto";

export interface GovernanceFrictionEpisode {
  readonly task_id: string;
  readonly cohort_id: string;
  readonly task_wall_time_ms: number;
  readonly gate_latencies_ms: readonly number[];
  readonly gate_refusals: number;
  /** A fixture assertion only; this does not by itself establish an adjudication. */
  readonly false_veto: boolean | null;
  /** Present only when a reviewer recorded an adjudication against a named evidence reference. */
  readonly false_veto_adjudicator_id?: string | null;
  readonly false_veto_evidence_ref?: string | null;
  /** A heuristic/inferred label is tracked separately and never enters the false-veto denominator. */
  readonly false_veto_inferred?: boolean | null;
  /** null means the episode did not record intervention count. */
  readonly operator_interventions: number | null;
  readonly recovery: "succeeded" | "failed" | "not_attempted" | "unavailable";
  readonly time_to_next_action_ms: number | null;
}

export interface GovernanceFrictionFixture {
  readonly schema: "arbor.governance-friction-fixture/v1";
  readonly episodes: readonly GovernanceFrictionEpisode[];
}

export interface GovernanceFrictionCohortReport {
  readonly cohort_id: string;
  readonly task_count: number;
  readonly gate_count: number;
  readonly gate_latency_p95_ms: number | null;
  /** Sum of observed gate durations / sum of task wall time; may exceed 1 when gates overlap. */
  readonly gate_time_share_of_task_time: number | null;
  readonly gate_refusal_rate: number | null;
  readonly asserted_false_veto_task_count: number;
  readonly asserted_false_veto_positive_count: number;
  readonly asserted_false_veto_rate: number | null;
  readonly evidence_linked_adjudication_count: number;
  readonly evidence_linked_unsubstantiated_task_count: number;
  readonly evidence_linked_false_veto_rate: number | null;
  readonly inferred_false_veto_assessment_count: number;
  readonly inferred_false_veto_task_count: number;
  readonly inference_adjudication_comparison_count: number;
  readonly inference_adjudication_disagreement_count: number;
  readonly intervention_observation_count: number;
  readonly operator_interventions_per_observed_task: number | null;
  readonly recovery_attempt_count: number;
  readonly recovery_unavailable_count: number;
  readonly recovery_success_rate: number | null;
  readonly next_action_observation_count: number;
  readonly mean_time_to_next_action_ms: number | null;
}

export interface GovernanceFrictionReport {
  readonly schema: "arbor.governance-friction-report/v1";
  readonly provenance: { readonly tag: "generated"; readonly generator: "arbor-eval/governance-friction"; readonly input_hash: `sha256:${string}` };
  readonly cohorts: readonly GovernanceFrictionCohortReport[];
}

export class GovernanceFrictionInputError extends Error {
  constructor(message: string) { super(message); this.name = "GovernanceFrictionInputError"; }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && typeof value === "number" && value >= 0; }
function duration(value: unknown): value is number { return count(value) && value <= 31_536_000_000; }

/** Reject incomplete/corrupt evidence rather than turning missing measurements into zero. */
export function parseGovernanceFrictionFixture(value: unknown): GovernanceFrictionFixture {
  if (!record(value) || value.schema !== "arbor.governance-friction-fixture/v1" || !Array.isArray(value.episodes) || value.episodes.length === 0 || value.episodes.length > 10_000) {
    throw new GovernanceFrictionInputError("fixture must use arbor.governance-friction-fixture/v1 and contain 1 to 10000 episodes");
  }
  const seen = new Set<string>();
  for (const [index, item] of value.episodes.entries()) {
    if (!record(item) || !nonEmpty(item.task_id) || !nonEmpty(item.cohort_id)) throw new GovernanceFrictionInputError(`episode ${index} requires task_id and cohort_id`);
    if (seen.has(item.task_id)) throw new GovernanceFrictionInputError(`duplicate task_id: ${item.task_id}`);
    seen.add(item.task_id);
    if (!duration(item.task_wall_time_ms) || !Array.isArray(item.gate_latencies_ms) || item.gate_latencies_ms.length > 10_000 || !item.gate_latencies_ms.every(duration)) throw new GovernanceFrictionInputError(`episode ${item.task_id} has invalid wall time or gate latencies`);
    if (!count(item.gate_refusals) || item.gate_refusals > item.gate_latencies_ms.length) throw new GovernanceFrictionInputError(`episode ${item.task_id} has invalid refusal count`);
    if (item.false_veto !== null && typeof item.false_veto !== "boolean") throw new GovernanceFrictionInputError(`episode ${item.task_id} false_veto must be true, false, or null`);
    if (item.false_veto_adjudicator_id !== undefined && item.false_veto_adjudicator_id !== null && !nonEmpty(item.false_veto_adjudicator_id)) throw new GovernanceFrictionInputError(`episode ${item.task_id} has invalid false-veto adjudicator id`);
    if (item.false_veto_evidence_ref !== undefined && item.false_veto_evidence_ref !== null && !nonEmpty(item.false_veto_evidence_ref)) throw new GovernanceFrictionInputError(`episode ${item.task_id} has invalid false-veto evidence reference`);
    if (item.false_veto === null && (item.false_veto_adjudicator_id != null || item.false_veto_evidence_ref != null)) throw new GovernanceFrictionInputError(`episode ${item.task_id} has adjudication metadata without an asserted outcome`);
    if (item.false_veto_inferred !== undefined && item.false_veto_inferred !== null && typeof item.false_veto_inferred !== "boolean") throw new GovernanceFrictionInputError(`episode ${item.task_id} false_veto_inferred must be true, false, or null`);
    if (item.operator_interventions !== null && !count(item.operator_interventions)) throw new GovernanceFrictionInputError(`episode ${item.task_id} has invalid intervention count`);
    if (!["succeeded", "failed", "not_attempted", "unavailable"].includes(String(item.recovery))) throw new GovernanceFrictionInputError(`episode ${item.task_id} has invalid recovery outcome`);
    if (item.time_to_next_action_ms !== null && !duration(item.time_to_next_action_ms)) throw new GovernanceFrictionInputError(`episode ${item.task_id} has invalid time_to_next_action_ms`);
  }
  return value as unknown as GovernanceFrictionFixture;
}

export function evaluateGovernanceFriction(input: unknown): GovernanceFrictionReport {
  const fixture = parseGovernanceFrictionFixture(input);
  const groups = new Map<string, GovernanceFrictionEpisode[]>();
  for (const episode of fixture.episodes) groups.set(episode.cohort_id, [...(groups.get(episode.cohort_id) ?? []), episode]);
  const cohorts = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cohort_id, episodes]): GovernanceFrictionCohortReport => {
    const gateLatencies = episodes.flatMap((episode) => episode.gate_latencies_ms).sort((a, b) => a - b);
    const asserted = episodes.filter((episode) => episode.false_veto !== null);
    const evidenceLinked = asserted.filter((episode) => nonEmpty(episode.false_veto_adjudicator_id) && nonEmpty(episode.false_veto_evidence_ref));
    const recoveryAttempts = episodes.filter((episode) => episode.recovery === "succeeded" || episode.recovery === "failed");
    const interventionObservations = episodes.flatMap((episode) => episode.operator_interventions === null ? [] : [episode.operator_interventions]);
    const nextActions = episodes.flatMap((episode) => episode.time_to_next_action_ms === null ? [] : [episode.time_to_next_action_ms]);
    const assertedVetoes = asserted.filter((episode) => episode.false_veto === true).length;
    const evidenceLinkedVetoes = evidenceLinked.filter((episode) => episode.false_veto === true).length;
    const refusals = episodes.reduce((sum, episode) => sum + episode.gate_refusals, 0);
    const interventions = interventionObservations.reduce((sum, value) => sum + value, 0);
    const taskWallTime = episodes.reduce((sum, episode) => sum + episode.task_wall_time_ms, 0);
    const summedGateTime = gateLatencies.reduce((sum, ms) => sum + ms, 0);
    return Object.freeze({
      cohort_id, task_count: episodes.length, gate_count: gateLatencies.length,
      gate_latency_p95_ms: gateLatencies.length ? gateLatencies[Math.ceil(gateLatencies.length * 0.95) - 1]! : null,
      gate_time_share_of_task_time: taskWallTime > 0 ? summedGateTime / taskWallTime : null,
      gate_refusal_rate: gateLatencies.length ? refusals / gateLatencies.length : null,
      asserted_false_veto_task_count: asserted.length,
      asserted_false_veto_positive_count: assertedVetoes,
      asserted_false_veto_rate: asserted.length ? assertedVetoes / asserted.length : null,
      evidence_linked_adjudication_count: evidenceLinked.length,
      evidence_linked_unsubstantiated_task_count: asserted.length - evidenceLinked.length,
      evidence_linked_false_veto_rate: evidenceLinked.length ? evidenceLinkedVetoes / evidenceLinked.length : null,
      inferred_false_veto_assessment_count: episodes.filter((episode) => episode.false_veto_inferred !== undefined && episode.false_veto_inferred !== null).length,
      inferred_false_veto_task_count: episodes.filter((episode) => episode.false_veto_inferred === true).length,
      inference_adjudication_comparison_count: episodes.filter((episode) => evidenceLinked.includes(episode) && episode.false_veto_inferred !== undefined && episode.false_veto_inferred !== null).length,
      inference_adjudication_disagreement_count: episodes.filter((episode) => evidenceLinked.includes(episode) && episode.false_veto_inferred !== undefined && episode.false_veto_inferred !== null && episode.false_veto !== episode.false_veto_inferred).length,
      intervention_observation_count: interventionObservations.length,
      operator_interventions_per_observed_task: interventionObservations.length ? interventions / interventionObservations.length : null,
      recovery_attempt_count: recoveryAttempts.length,
      recovery_unavailable_count: episodes.filter((episode) => episode.recovery === "unavailable").length,
      recovery_success_rate: recoveryAttempts.length ? recoveryAttempts.filter((episode) => episode.recovery === "succeeded").length / recoveryAttempts.length : null,
      next_action_observation_count: nextActions.length,
      mean_time_to_next_action_ms: nextActions.length ? nextActions.reduce((sum, ms) => sum + ms, 0) / nextActions.length : null,
    });
  });
  const input_hash = `sha256:${createHash("sha256").update(canonicalizeForHash(fixture)).digest("hex")}` as const;
  return Object.freeze({ schema: "arbor.governance-friction-report/v1", provenance: Object.freeze({ tag: "generated", generator: "arbor-eval/governance-friction", input_hash }), cohorts: Object.freeze(cohorts) });
}

/** Render the exact denominators and unmeasured states alongside each cohort. */
export function generateGovernanceFrictionReport(report: GovernanceFrictionReport): string {
  const lines = [
    "# Governance friction report", "",
    `Input: ${report.provenance.input_hash}`, "",
    "Rates use observed denominators: refusal rate = refusals / gate checks; asserted false-veto rate uses fixture assertions; evidence-linked false-veto rate uses asserted outcomes with both a reviewer ID and evidence reference. These references are recorded, not resolved or independently verified by this evaluator. Inferred labels are reported separately. Recovery success = successful / observed attempted recoveries. Intervention rate uses tasks with recorded intervention counts. Gate time share = summed gate durations / summed task wall time and may exceed 100% when gate checks overlap.",
    "Null means there were no observations for that denominator; it is not a zero measurement.", "",
    "| Cohort | Tasks | Gate p95 (ms) | Gate time share | Refusal rate | Asserted false-veto (positive/asserted) | Evidence-linked false-veto rate (linked; unsubstantiated) | Inferred false-veto (positive/assessed; disagreement/compared) | Interventions/observed task (n) | Recovery success (attempts; unavailable) | Mean next action (ms) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const cohort of report.cohorts) {
    const rate = (value: number | null) => value === null ? "unmeasured" : `${(value * 100).toFixed(1)}%`;
    lines.push(`| ${cohort.cohort_id} | ${cohort.task_count} | ${cohort.gate_latency_p95_ms ?? "unmeasured"} | ${rate(cohort.gate_time_share_of_task_time)} | ${rate(cohort.gate_refusal_rate)} | ${cohort.asserted_false_veto_positive_count}/${cohort.asserted_false_veto_task_count} | ${rate(cohort.evidence_linked_false_veto_rate)} (${cohort.evidence_linked_adjudication_count}; ${cohort.evidence_linked_unsubstantiated_task_count} unsubstantiated) | ${cohort.inferred_false_veto_task_count}/${cohort.inferred_false_veto_assessment_count}; ${cohort.inference_adjudication_disagreement_count}/${cohort.inference_adjudication_comparison_count} disagreement | ${cohort.operator_interventions_per_observed_task === null ? "unmeasured" : cohort.operator_interventions_per_observed_task.toFixed(2)} (${cohort.intervention_observation_count}) | ${rate(cohort.recovery_success_rate)} (${cohort.recovery_attempt_count}; ${cohort.recovery_unavailable_count} unavailable) | ${cohort.mean_time_to_next_action_ms ?? "unmeasured"} |`);
  }
  lines.push("", "These fixture-backed measurements do not establish product-wide rates. The evaluator does not establish cohort representativeness, reviewer independence, or that evidence references resolve to valid records.", "");
  return lines.join("\n");
}
