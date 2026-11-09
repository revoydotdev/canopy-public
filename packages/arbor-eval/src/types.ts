/**
 * arbor-eval/types — types for the evaluation harness.
 */

import type { Action, Cost, Provenance } from "@arbor/core";

/** A scripted outcome for a branch. */
export interface ScriptedOutcome {
  /** Whether the specialist succeeded. */
  success: boolean;
  /** Rationale for critic (or specialist output on success). */
  rationale: string;
  /** Root cause on failure. */
  rootCause?: string;
}

/** Outcome generator: (branchIndex, seed, hadPriorFailures?) → deterministic outcome. */
export type OutcomeGenerator = (branchIndex: number, seed: number, hadPriorFailures?: boolean) => ScriptedOutcome;

/** A benchmark task. */
export interface EvalTask {
  id: string;
  description: string;
  /** Root action for the campaign. */
  rootAction: Action;
  /** How many branches to create from root initially. */
  branchCount: number;
  /** Creates branch actions. (i) → Action for the i-th branch. */
  branchActionGenerator: (i: number) => Action;
  /** Scripted outcome for any branch. */
  outcomeGenerator: OutcomeGenerator;
  /** Description of what a good result looks like. */
  expectedGoodOutcome: string;
}

/** Per-campaign metrics. */
export interface CampaignMetrics {
  branchingFactor: number;
  backtrackRate: number;
  kbHitRate: number;
  convergenceQuality: number;
  haltReason: string | null;
  bestScore: number;
  iterationsCompleted: number;
  verifiedCount: number;
  claimedCount: number;
  failedCount: number;
  prunedCount: number;
  kbEntriesWritten: number;
  kbInjectionsRelevant: number;
  kbInjectionsTotal: number;
}

/** Post-W1a adjudicated observation for critic reliability measurement. */
export interface CriticReliabilitySample {
  node_id: string;
  observed_at: string;
  artifact_correct_before: boolean;
  critic_flagged: boolean;
  correction_attempted: boolean;
  artifact_correct_after: boolean;
  later_defect_found: boolean;
}

export interface CriticReliabilityMetrics {
  data_window: { starts_at: string; ends_at: string; samples: number };
  p_correct: number;
  c_catch_rate: number;
  r_repair_rate: number;
  f_false_alarm_rate: number;
  b_breakage_rate: number;
  reliability_gain: number;
  reliability_harm: number;
  inequality_holds: boolean;
}

/** Aggregated metrics across N runs of a task. */
export interface AggregatedMetrics {
  taskId: string;
  taskDescription: string;
  runs: number;
  avgBranchingFactor: number;
  avgBacktrackRate: number;
  avgKbHitRate: number;
  avgConvergenceQuality: number;
  /** Fraction of runs that halted via "converged". */
  convergenceRate: number;
  avgBestScore: number;
  avgIterations: number;
  perRunMetrics: CampaignMetrics[];
}

/** Baseline result for a single task. */
export interface BaselineResult {
  taskId: string;
  taskDescription: string;
  success: boolean;
  score: number;
}

/** Aggregated baseline results. */
export interface AggregatedBaseline {
  taskId: string;
  taskDescription: string;
  successRate: number;
  avgScore: number;
  perRunResults: BaselineResult[];
}

/** The top-level eval report. */
export interface EvalReport {
  generatedAt: string;
  numTasks: number;
  runsPerTask: number;
  arborResults: AggregatedMetrics[];
  baselineResults: AggregatedBaseline[];
  comparisonSummary: string;
}

/**
 * A fixed, inspectable outcome sequence used to compare an ungoverned linear
 * loop with the governed CampaignManager path. These are deliberately not
 * provider calls: token units are fixture accounting, and USD cost remains
 * unavailable until a provider executor emits measured usage.
 */
export interface GovernedScenarioAttempt {
  id: string;
  description: string;
  /** The linear loop's outcome, before a critic/evidence check is available. */
  baseline_success: boolean;
  /** The governed path's Critic verdict for the same proposed action. */
  governed_success: boolean;
  /** A regression that the governed verdict is expected to catch. */
  regression_detected: boolean;
  /** Deterministic harness accounting only; not provider-reported tokens. */
  scripted_token_units: number;
  rationale: string;
  root_cause?: string;
}

export interface GovernedEvalScenario {
  id: string;
  description: string;
  attempts: readonly GovernedScenarioAttempt[];
}

export interface GovernedScenarioMetrics {
  completed: boolean;
  attempts_executed: number;
  regressions_detected: number;
  regressions_accepted: number;
  recoveries_required: number;
  recoveries_completed: number;
  evidence: {
    /** Expected minimum durable audit facts for the selected loop. */
    required_records: number;
    durable_records: number;
    completeness: number;
  };
  cost: {
    scripted_token_units: number;
    /** Null by design: deterministic scenarios do not call a provider. */
    provider_cost_usd: null;
    provider_cost_status: "not_measured";
  };
}

export interface GovernedScenarioComparison {
  scenario_id: string;
  baseline: GovernedScenarioMetrics;
  governed: GovernedScenarioMetrics;
}

/**
 * A bounded, synthetic adversarial fixture for the native safety evaluator.
 * The fixture describes an oracle expectation, not a real-model benchmark.
 */
export interface StagedNativeSafetyScenario {
  readonly id: string;
  readonly family: "prompt_injection" | "tool_return_injection" | "memory_context_poisoning" | "ambiguous_unsafe_inference" | "benign_control";
  readonly semantic_expectation: "accepted" | "refused";
  readonly state_expectation: Readonly<{
    filesystem: readonly string[];
    processes: readonly string[];
    messages: readonly string[];
  }>;
}

/** Redacted event/audit facts retained in an episode artifact. */
export interface StagedNativeSafetyAuditEvidence {
  readonly event_kinds: readonly string[];
  readonly tool_audit_kinds: readonly string[];
  readonly provider_requests: number;
  readonly redaction_marker_observed: boolean;
  readonly sensitive_value_absent: boolean;
  /** Durable terminal evidence is independently captured and content-addressed. */
  readonly artifact_manifest: Readonly<{
    captured: boolean;
    content_addressed: boolean;
    sensitive_value_absent: boolean;
  }>;
}

/** Each dimension is intentionally scored independently. */
export interface StagedNativeSafetyScore {
  readonly semantic: Readonly<{ expected: "accepted" | "refused"; observed: "accepted" | "refused"; passed: boolean }>;
  readonly audit_evidence: Readonly<{ passed: boolean; evidence: StagedNativeSafetyAuditEvidence }>;
  readonly observed_state: Readonly<{
    expected: StagedNativeSafetyScenario["state_expectation"];
    observed: StagedNativeSafetyScenario["state_expectation"];
    passed: boolean;
  }>;
}

/**
 * A redacted, provenance-bearing evaluator artifact. It deliberately excludes
 * raw prompt, tool-return, provider-request, and credential content.
 */
export interface StagedNativeSafetyEpisode {
  readonly episode_id: string;
  readonly scenario_id: string;
  readonly family: StagedNativeSafetyScenario["family"];
  readonly provenance: Readonly<{ tag: "generated"; generator: "arbor-eval/staged-native-safety"; input_hash: string }>;
  /** Identical ceilings make a future paired baseline comparable in budget, not quality. */
  readonly budget: Readonly<{ max_model_turns: 2; max_tool_calls: 2; max_events: 64; model_turns_used: number; tool_calls_used: number }>;
  readonly session: Readonly<{ state: string; terminal_cause: string | null; event_kinds: readonly string[] }>;
  readonly score: StagedNativeSafetyScore;
}

/**
 * Evaluation-only identity for a benchmark/config destination. This is not a
 * session, credential, or authority handle.
 */
export interface EvalBenchmarkTargetInput {
  readonly cluster_id: string;
  readonly item_id: string;
  readonly config_id: string;
  readonly variant_id?: string;
}

/**
 * Content-addressed prefix descriptor for reuse experiments. It intentionally
 * omits any resume token, transcript cursor, or authority-bearing identifier.
 */
export interface EvalPrefixDescriptorInput {
  readonly prefix_text: string;
  readonly prompt_template_id: string;
  readonly tool_contract_id?: string;
  readonly model_family?: string;
  readonly context_signature?: string;
  readonly token_units: number;
  readonly byte_length: number;
}

export interface EvalPrefixObservationInput {
  readonly operation_id: string;
  readonly observed_at: string;
  readonly observation_kind: "materialized" | "reused";
  readonly prefix: EvalPrefixDescriptorInput;
  readonly target: EvalBenchmarkTargetInput;
  readonly marginal_cost_token_units: number;
  readonly marginal_cost: Cost;
  readonly provenance: Provenance;
}

export interface EvalPrefixEntity extends EvalPrefixDescriptorInput {
  readonly prefix_id: string;
  readonly provenance: Readonly<{ tag: "generated"; generator: "arbor-eval/reuse-ledger"; input_hash: string }>;
}

export interface EvalBenchmarkTarget extends EvalBenchmarkTargetInput {
  readonly target_id: string;
}

export interface EvalPrefixObservationRecord {
  readonly observation_id: string;
  readonly operation_id: string;
  readonly prefix_id: string;
  readonly target_id: string;
  readonly observation_kind: "materialized" | "reused";
  readonly observed_at: string;
  readonly marginal_cost_token_units: number;
  readonly marginal_cost: Cost;
  readonly provenance: Provenance;
}

export interface EvalReuseLedgerOperationReceipt {
  readonly operation_id: string;
  readonly fingerprint: string;
  readonly observation_id: string;
  readonly recorded_at: string;
}

export interface EvalPrefixReuseLedger {
  readonly schema_version: 1;
  readonly ledger_id: string;
  readonly updated_at: string;
  readonly prefixes: readonly EvalPrefixEntity[];
  readonly targets: readonly EvalBenchmarkTarget[];
  readonly observations: readonly EvalPrefixObservationRecord[];
  readonly operations: readonly EvalReuseLedgerOperationReceipt[];
  readonly integrity_hash: string;
}

export interface EvalPrefixReuseCostTotal {
  readonly currency_exponent_key: string;
  readonly currency: string;
  readonly minor_unit_exponent: number;
  readonly total_minor_units: number;
}

export interface EvalPrefixReuseEdgeSummary {
  readonly prefix_id: string;
  readonly target_id: string;
  readonly materialization_count: number;
  readonly reuse_count: number;
  readonly materialized_token_units: number;
  readonly reused_token_units: number;
  readonly priced_observation_count: number;
  readonly unpriced_observation_count: number;
  readonly first_observed_at: string;
  readonly last_observed_at: string;
  readonly provider_cost_totals: readonly EvalPrefixReuseCostTotal[];
}

export interface EvalPrefixReuseSummary {
  readonly ledger_id: string;
  readonly prefixes: readonly (EvalPrefixEntity & { attached_target_count: number })[];
  readonly targets: readonly (EvalBenchmarkTarget & { attached_prefix_count: number })[];
  readonly edges: readonly EvalPrefixReuseEdgeSummary[];
  readonly totals: Readonly<{
    observation_count: number;
    materialization_count: number;
    reuse_count: number;
    total_materialized_token_units: number;
    total_reused_token_units: number;
    reuse_ratio: number;
  }>;
  readonly observations: readonly (EvalPrefixObservationRecord & {
    prefix: EvalPrefixEntity;
    target: EvalBenchmarkTarget;
  })[];
}
