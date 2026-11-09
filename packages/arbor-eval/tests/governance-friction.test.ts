import { describe, expect, it } from "vitest";
import { evaluateGovernanceFriction, parseGovernanceFrictionFixture } from "../src/governance-friction.js";

const fixture = {
  schema: "arbor.governance-friction-fixture/v1",
  episodes: [
    { task_id: "a", cohort_id: "valid", task_wall_time_ms: 1000, gate_latencies_ms: [10, 20], gate_refusals: 1, false_veto: false, false_veto_adjudicator_id: "reviewer-a", false_veto_evidence_ref: "review://case-a", operator_interventions: 2, recovery: "succeeded", time_to_next_action_ms: 30 },
    { task_id: "b", cohort_id: "valid", task_wall_time_ms: 500, gate_latencies_ms: [40], gate_refusals: 0, false_veto: true, false_veto_adjudicator_id: "reviewer-b", false_veto_evidence_ref: "review://case-b", operator_interventions: 0, recovery: "not_attempted", time_to_next_action_ms: null },
    { task_id: "c", cohort_id: "unknown", task_wall_time_ms: 10, gate_latencies_ms: [], gate_refusals: 0, false_veto: null, operator_interventions: null, recovery: "failed", time_to_next_action_ms: 0 },
  ],
} as const;

describe("governance friction cohort evaluation", () => {
  it("reports bounded cohort metrics, keeping missing denominators unknown", () => {
    const report = evaluateGovernanceFriction(fixture);
    expect(report.cohorts[0]).toMatchObject({
      cohort_id: "unknown", gate_count: 0, gate_latency_p95_ms: null,
      gate_time_share_of_task_time: 0,
      gate_refusal_rate: null, evidence_linked_false_veto_rate: null, recovery_success_rate: 0,
      intervention_observation_count: 0, operator_interventions_per_observed_task: null,
      next_action_observation_count: 1, mean_time_to_next_action_ms: 0,
    });
    expect(report.cohorts[1]).toMatchObject({
      cohort_id: "valid", gate_count: 3, gate_latency_p95_ms: 40,
      gate_time_share_of_task_time: 70 / 1500,
      gate_refusal_rate: 1 / 3, asserted_false_veto_rate: 0.5, evidence_linked_adjudication_count: 2, evidence_linked_false_veto_rate: 0.5,
      intervention_observation_count: 2, operator_interventions_per_observed_task: 1, recovery_attempt_count: 1,
      recovery_success_rate: 1, next_action_observation_count: 1,
      mean_time_to_next_action_ms: 30,
    });
    expect(report.provenance).toMatchObject({ tag: "generated", generator: "arbor-eval/governance-friction", input_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
  });

  it("binds output to fixture content and sorts cohorts deterministically", () => {
    const first = evaluateGovernanceFriction(fixture);
    const reversed = evaluateGovernanceFriction({ ...fixture, episodes: [...fixture.episodes].reverse() });
    expect(first.cohorts.map(({ cohort_id }) => cohort_id)).toEqual(["unknown", "valid"]);
    expect(first.provenance.input_hash).not.toBe(reversed.provenance.input_hash);
    expect(first.cohorts).toEqual(reversed.cohorts);
  });

  it("rejects duplicate tasks and impossible refusal counts instead of fabricating metrics", () => {
    const duplicate = { ...fixture, episodes: [fixture.episodes[0], fixture.episodes[0]] };
    expect(() => parseGovernanceFrictionFixture(duplicate)).toThrow("duplicate task_id");
    const impossible = { ...fixture, episodes: [{ ...fixture.episodes[0], gate_refusals: 3 }] };
    expect(() => evaluateGovernanceFriction(impossible)).toThrow("invalid refusal count");
  });

  it("keeps inferred veto labels out of the adjudicated rate and leaves unrecorded counts unavailable", () => {
    const adversarialFixture = {
      schema: "arbor.governance-friction-fixture/v1",
      episodes: [
        { task_id: "heuristic-only", cohort_id: "adversarial", task_wall_time_ms: 0, gate_latencies_ms: [], gate_refusals: 0,
          false_veto: null, false_veto_inferred: true, operator_interventions: null, recovery: "unavailable", time_to_next_action_ms: null },
        { task_id: "reviewed", cohort_id: "adversarial", task_wall_time_ms: 10, gate_latencies_ms: [4], gate_refusals: 1,
          false_veto: false, false_veto_adjudicator_id: "reviewer-x", false_veto_evidence_ref: "review://case-x",
          false_veto_inferred: true, operator_interventions: 0, recovery: "not_attempted", time_to_next_action_ms: null },
      ],
    } as const;
    const cohort = evaluateGovernanceFriction(adversarialFixture).cohorts[0]!;
    expect(cohort).toMatchObject({
      gate_refusal_rate: 1,
      asserted_false_veto_task_count: 1,
      asserted_false_veto_rate: 0,
      evidence_linked_adjudication_count: 1,
      evidence_linked_unsubstantiated_task_count: 0,
      evidence_linked_false_veto_rate: 0,
      inferred_false_veto_assessment_count: 2,
      inferred_false_veto_task_count: 2,
      inference_adjudication_comparison_count: 1,
      inference_adjudication_disagreement_count: 1,
      intervention_observation_count: 1,
      operator_interventions_per_observed_task: 0,
      recovery_attempt_count: 0,
      recovery_unavailable_count: 1,
      recovery_success_rate: null,
      next_action_observation_count: 0,
      mean_time_to_next_action_ms: null,
    });
  });

  it("rejects absent intervention measurements instead of treating them as zero", () => {
    const missing = { ...fixture, episodes: [{ ...fixture.episodes[0], operator_interventions: undefined }] };
    expect(() => parseGovernanceFrictionFixture(missing)).toThrow("invalid intervention count");
  });

  it("counts an outcome without reviewer and evidence references only as an assertion", () => {
    const unsubstantiated = { ...fixture, episodes: [{ ...fixture.episodes[0], false_veto: true, false_veto_adjudicator_id: null, false_veto_evidence_ref: null }] };
    const cohort = evaluateGovernanceFriction(unsubstantiated).cohorts[0]!;
    expect(cohort).toMatchObject({
      asserted_false_veto_task_count: 1,
      asserted_false_veto_positive_count: 1,
      asserted_false_veto_rate: 1,
      evidence_linked_adjudication_count: 0,
      evidence_linked_unsubstantiated_task_count: 1,
      evidence_linked_false_veto_rate: null,
    });
  });
});
