import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "@arbor/audit";
import { buildRunManifest, compareEvalEstimates, evaluateEconomizationGuard, falseAcceptanceByVerification, rightForRightReasons, siblingOutcomeSignals, unresolvedComparisonRate, validateRunManifest } from "../src/trajectory-metrics.js";

const heldOutCohort = { cohort_id: "held-out-v1", scope: "held_out" as const, provenance: { tag: "verified" as const, cmd: "arbor-eval cohort verify held-out-v1", exit: 0, stdout_hash: "sha256:held-out-v1" } };

function ledger(): EvidenceLedger {
  const value = new EvidenceLedger();
  const witness = value.record({
    campaign_id: "campaign", node_id: "node", timestamp: "2026-08-12T12:00:00.000Z", action_description: "run",
    action_category: "test", specialist_agent: "seed", critic_agent: "lenticel", node_state_before: "expanding", node_state_after: "failed",
    provenance: { tag: "claimed", claimant: "seed" }, specialist_output: "failed", critic_verdict_approved: false,
    critic_root_cause: "test_failure", score_before: 0, score_after: 0, gates: [], kb_entries_written: [],
  });
  const generated = { tag: "generated" as const, generator: "fixture", input_hash: "manifest" };
  value.recordTelemetryObservation({ campaign_id: "campaign", node_id: "node", operation_id: "model:s", epoch: 1, type: "role_model_identity", phase: "expand", outcome: "success", source_evidence_id: witness, idempotency_key: "model:s", provenance: generated, role: "specialist", model_id: "openai/gpt-5.6" });
  value.recordTelemetryObservation({ campaign_id: "campaign", node_id: "node", operation_id: "cost", epoch: 1, type: "usage_cost", phase: "critic", outcome: "success", source_evidence_id: witness, idempotency_key: "cost", provenance: generated, agent_id: "lenticel", provider: "openai", model_family: "gpt", input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 4, cost: { kind: "priced", minor_units: 7, currency: "USD", minor_unit_exponent: 6, price_source_id: "price/v1" } });
  value.recordTelemetryObservation({ campaign_id: "campaign", node_id: "node", operation_id: "time", epoch: 1, type: "phase_timing", phase: "critic", outcome: "success", source_evidence_id: witness, idempotency_key: "time", provenance: generated, duration_ms: 123 });
  const sources = ["system_instructions", "project_instructions", "task", "repository_graph", "code", "tool_output", "trajectory", "memory", "critic_feedback", "human_input"] as const;
  value.recordTelemetryObservation({ campaign_id: "campaign", node_id: "node", operation_id: "context", epoch: 1, type: "context_economy", phase: "expand", outcome: "success", source_evidence_id: witness, idempotency_key: "context", provenance: generated,
    offered_tokens: 100, retained_tokens: 60, pruned_tokens: 40, indexed_reference_tokens: 10, stable_prefix_tokens: 10, dynamic_tokens: 50,
    per_source: sources.map((source) => ({ source, offered_tokens: source === "task" ? 100 : 0, retained_tokens: source === "task" ? 60 : 0,
      cache_class: (["system_instructions", "project_instructions", "repository_graph", "memory"] as readonly string[]).includes(source) ? "stable" as const : "dynamic" as const,
      disposition: source === "task" ? "mixed" as const : "absent" as const, reason: source === "task" ? "fixture partial retention" : "fixture absent",
      provenance: generated, evidence_pointer: `context-source:${source}:fixture` })) });
  value.recordTelemetryObservation({ campaign_id: "campaign", node_id: "node", operation_id: "tools", epoch: 1, type: "tool_economy", phase: "expand", outcome: "success", source_evidence_id: witness, idempotency_key: "tools", provenance: generated,
    offered_calls: 4, host_executions: 2, reused_reads: 1, avoided_output_bytes: 4096 });
  return value;
}

describe("trajectory-faithful evaluation metrics", () => {
  it("emits a schema-valid content-addressed run manifest from durable records", () => {
    const manifest = buildRunManifest(ledger(), { campaign_id: "campaign", environment_digest: `sha256:${"a".repeat(64)}`, run_date: "2026-08-12T13:00:00.000Z", sampling_rule: "all terminal nodes", aggregation_rule: "micro-average" });
    expect(validateRunManifest(manifest)).toBe(true);
    expect(manifest).toMatchObject({ models: [{ role: "specialist", model_id: "openai/gpt-5.6" }], cost: { input_tokens: 100, wall_clock_ms: 123, priced: [{ minor_units: 7 }],
      by_phase: [{ phase: "critic", calls: 1, input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 4, effective_tokens: 188 }],
      by_role: [{ role: "critic", phase: "critic", calls: 1, effective_tokens: 188 }],
      by_agent: [{ agent_id: "lenticel", calls: 1, effective_tokens: 188 }] },
      context_economy: { observations: 1, offered_tokens: 100, retained_tokens: 60, retention_ratio: 0.6, by_source: expect.arrayContaining([{ source: "task", offered_tokens: 100, retained_tokens: 60, pruned_tokens: 40, retention_ratio: 0.6 }]) },
      tool_economy: { observations: 1, offered_calls: 4, host_executions: 2, reused_reads: 1, avoided_output_bytes: 4096, reuse_ratio: 0.25 },
      cache_economy: { eligible_input_tokens: 130, cache_read_tokens: 30, cache_write_tokens: 4, cache_read_ratio: 0.230769, cache_write_ratio: 0.030769 },
      efficiency: { effective_token_policy: { input: 1, cache_read: 0.1, cache_write: 1.25, output: 4, unit: "weighted_token" }, effective_tokens: 188, verified_progress_units: 0, verified_progress_per_effective_token: 0 },
      failures: [{ category: "test_failure", count: 1, node_ids: ["node"] }] });
    expect(validateRunManifest({ ...manifest, environment_digest: "latest" })).toBe(false);
  });

  it("uses null ratios when no context or effective tokens were observed", () => {
    const empty = new EvidenceLedger();
    const manifest = buildRunManifest(empty, { campaign_id: "empty", environment_digest: `sha256:${"b".repeat(64)}`, run_date: "2026-08-12T13:00:00.000Z", sampling_rule: "all", aggregation_rule: "micro" });
    expect(manifest.context_economy.retention_ratio).toBeNull();
    expect(manifest.efficiency.verified_progress_per_effective_token).toBeNull();
    expect(validateRunManifest(manifest)).toBe(true);
  });

  it("computes R4R and WDG separately", () => {
    expect(rightForRightReasons([
      { succeeded: true, correct: true, grounded: true },
      { succeeded: true, correct: false, grounded: true },
      { succeeded: true, correct: true, grounded: false },
      { succeeded: false, correct: false, grounded: false },
    ])).toEqual({ r4r: 0.25, wdg: 0.25 });
  });

  it("splits false acceptance by breadth and oracle class", () => {
    const rows = falseAcceptanceByVerification([
      { accepted: true, correct: false, provenance: { tag: "verified", cmd: "suite", exit: 0, stdout_hash: "sha256:x", check: { kind: "shell_command", breadth: "suite" } } },
      { accepted: true, correct: true, provenance: { tag: "verified", cmd: "suite", exit: 0, stdout_hash: "sha256:y", check: { kind: "shell_command", breadth: "suite" } } },
      { accepted: true, correct: false, provenance: { tag: "critic_approved", critic: "lenticel", rationale: "ok" } },
    ]);
    expect(rows).toContainEqual({ breadth: "suite", oracle: "deterministic", accepted: 2, false_acceptances: 1, rate: 0.5 });
    expect(rows).toContainEqual({ breadth: "unclassified", oracle: "self_reflective", accepted: 1, false_acceptances: 1, rate: 1 });
  });

  it("reports overlapping comparisons as unresolved and includes their rate", () => {
    const unresolved = compareEvalEstimates({ config_id: "a", lower: 0.6, upper: 0.8 }, { config_id: "b", lower: 0.7, upper: 0.9 });
    const winner = compareEvalEstimates({ config_id: "a", lower: 0.91, upper: 0.95 }, { config_id: "b", lower: 0.7, upper: 0.9 });
    expect(unresolved).toEqual({ result: "unresolved", config_ids: ["a", "b"] });
    expect(winner).toEqual({ result: "winner", config_id: "a" });
    expect(unresolvedComparisonRate([unresolved, winner])).toBe(0.5);
  });

  it("activates token economization only after conservative held-out non-inferiority bounds pass", () => {
    const outcomes = Array.from({ length: 100 }, (_, index) => ({ task_id: `task-${index}`, succeeded: true, correct: true, grounded: true, accepted: true }));
    const result = evaluateEconomizationGuard(
      { config_id: "baseline", effective_tokens: 1_000_000, outcomes, cohort: heldOutCohort },
      { config_id: "candidate", effective_tokens: 500_000, outcomes, cohort: heldOutCohort },
      { max_r4r_regression: 0.05, max_false_acceptance_increase: 0.05, min_token_reduction_ratio: 0.2 },
    );
    expect(result).toMatchObject({ decision: "eligible", paired_tasks: 100, token_reduction_ratio: 0.5, baseline: { r4r: 1 }, candidate: { r4r: 1 } });
  });

  it("rejects a cheaper policy whose quality point estimate exceeds the accuracy floor", () => {
    const baseline = Array.from({ length: 20 }, (_, index) => ({ task_id: `task-${index}`, succeeded: true, correct: true, grounded: true, accepted: true }));
    const candidate = baseline.map((outcome, index) => index < 4 ? { ...outcome, correct: false, grounded: false } : outcome);
    const result = evaluateEconomizationGuard(
      { config_id: "baseline", effective_tokens: 1000, outcomes: baseline, cohort: heldOutCohort },
      { config_id: "candidate", effective_tokens: 500, outcomes: candidate, cohort: heldOutCohort },
      { max_r4r_regression: 0.05, max_false_acceptance_increase: 0.05, min_token_reduction_ratio: 0.2 },
    );
    expect(result.decision).toBe("rejected");
    expect(result.reason).toContain("R4R regression");
  });

  it("keeps a small cheaper sample unresolved instead of treating no observed regression as proof", () => {
    const outcomes = Array.from({ length: 5 }, (_, index) => ({ task_id: `task-${index}`, succeeded: true, correct: true, grounded: true, accepted: true }));
    expect(evaluateEconomizationGuard(
      { config_id: "baseline", effective_tokens: 1000, outcomes, cohort: heldOutCohort },
      { config_id: "candidate", effective_tokens: 500, outcomes, cohort: heldOutCohort },
      { max_r4r_regression: 0.05, max_false_acceptance_increase: 0.05, min_token_reduction_ratio: 0.2 },
    ).decision).toBe("unresolved");
  });

  it("fails closed on malformed or incomparable economization cohorts", () => {
    const outcome = { task_id: "task-1", succeeded: true, correct: true, grounded: true, accepted: true };
    const arm = { config_id: "baseline", effective_tokens: 100, outcomes: [outcome], cohort: heldOutCohort };
    const policy = { max_r4r_regression: 0.05, max_false_acceptance_increase: 0.05, min_token_reduction_ratio: 0.2 };
    expect(() => evaluateEconomizationGuard(arm, { ...arm, outcomes: [] }, policy)).toThrow("same unique held-out task ids");
    expect(() => evaluateEconomizationGuard(arm, { ...arm, outcomes: [{ ...outcome, task_id: "task-2" }] }, policy)).toThrow("same unique held-out task ids");
    expect(() => evaluateEconomizationGuard({ ...arm, outcomes: [] }, { ...arm, outcomes: [] }, policy)).toThrow("at least one paired task");
    expect(() => evaluateEconomizationGuard({ ...arm, outcomes: [outcome, outcome] }, arm, policy)).toThrow("unique and non-empty");
    expect(() => evaluateEconomizationGuard({ ...arm, config_id: "" }, arm, policy)).toThrow("invalid economization arm");
    expect(() => evaluateEconomizationGuard(arm, { ...arm, cohort: { ...heldOutCohort, cohort_id: "other" } }, policy)).toThrow("same cohort");
    expect(() => evaluateEconomizationGuard(arm, arm, { ...policy, confidence: 1 })).toThrow("invalid economization guard policy");
  });

  it("never promotes a calibration or unverified cohort", () => {
    const outcomes = Array.from({ length: 100 }, (_, index) => ({ task_id: `task-${index}`, succeeded: true, correct: true, grounded: true, accepted: true }));
    const calibration = { cohort_id: "calibration-v1", scope: "calibration" as const, provenance: { tag: "generated" as const, generator: "fixture", input_hash: "calibration" } };
    expect(evaluateEconomizationGuard(
      { config_id: "baseline", effective_tokens: 1000, outcomes, cohort: calibration },
      { config_id: "candidate", effective_tokens: 500, outcomes, cohort: calibration },
      { max_r4r_regression: 0.05, max_false_acceptance_increase: 0.05, min_token_reduction_ratio: 0.2 },
    )).toMatchObject({ decision: "unresolved", reason: expect.stringContaining("cannot promote") });
  });

  it("rejects savings below policy and increased false acceptance before confidence promotion", () => {
    const baselineOutcomes = Array.from({ length: 20 }, (_, index) => ({ task_id: `task-${index}`, succeeded: true, correct: true, grounded: true, accepted: index < 10 }));
    expect(evaluateEconomizationGuard(
      { config_id: "baseline", effective_tokens: 100, outcomes: baselineOutcomes, cohort: heldOutCohort },
      { config_id: "candidate", effective_tokens: 90, outcomes: baselineOutcomes, cohort: heldOutCohort },
      { max_r4r_regression: 0.05, max_false_acceptance_increase: 0.05, min_token_reduction_ratio: 0.2, confidence: 0.9 },
    ).reason).toContain("minimum token reduction");

    const candidateOutcomes = baselineOutcomes.map((outcome, index) => index >= 10 && index < 14
      ? { ...outcome, accepted: true, correct: false, grounded: false }
      : outcome);
    expect(evaluateEconomizationGuard(
      { config_id: "baseline", effective_tokens: 100, outcomes: baselineOutcomes, cohort: heldOutCohort },
      { config_id: "candidate", effective_tokens: 50, outcomes: candidateOutcomes, cohort: heldOutCohort },
      { max_r4r_regression: 0.25, max_false_acceptance_increase: 0.05, min_token_reduction_ratio: 0.2 },
    ).reason).toContain("false-acceptance increase");

    expect(evaluateEconomizationGuard(
      { config_id: "baseline", effective_tokens: 0, outcomes: baselineOutcomes, cohort: heldOutCohort },
      { config_id: "candidate", effective_tokens: 0, outcomes: baselineOutcomes, cohort: heldOutCohort },
      { max_r4r_regression: 0.05, max_false_acceptance_increase: 0.05, min_token_reduction_ratio: 0.01 },
    ).token_reduction_ratio).toBe(0);
  });

  it("derives sibling-outcome spread from replayed parent joins", () => {
    const value = new EvidenceLedger();
    const record = (node_id: string, parent_id: string | null, verified: boolean, approved: boolean) => value.record({
      campaign_id: "siblings", node_id, parent_id, timestamp: "2026-08-12T12:00:00.000Z", action_description: node_id, action_category: "test",
      specialist_agent: "seed", critic_agent: "lenticel", node_state_before: "expanding", node_state_after: verified ? "verified" : "failed",
      provenance: verified ? { tag: "verified", cmd: "test", exit: 0, stdout_hash: `sha256:${node_id}` } : { tag: "claimed", claimant: "seed" },
      specialist_output: node_id, critic_verdict_approved: approved, critic_root_cause: verified ? null : "failed", score_before: 0, score_after: verified ? 1 : 0, gates: [], kb_entries_written: [],
    });
    record("parent", null, true, true); record("child-a", "parent", true, true); record("child-b", "parent", false, false);
    expect(siblingOutcomeSignals(value, "siblings")).toEqual({
      signals: [{ parent_id: "parent", expanded_children: 2, verified_rate: 0.5, outcome_spread: 1, critic_approved: true, disagrees_with_critic: false }],
      critic_spread_correlation: null,
    });
  });
});
