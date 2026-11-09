/**
 * arbor-eval/stage0/types — the records of the UCT plan's Stage 0 instrument.
 *
 * Stage 0 measures the production `arbor task` path on the pinned external
 * cohort (docs/research/uct-search/stage0-preregistration.md). Its unit of
 * execution is one ATTEMPT: one independent production campaign in a fresh
 * clone of a task fixture, followed by adoption and an independent run of the
 * task's acceptance command on the adopted tree. Arms are derived from the
 * attempts of a (task, seed) unit by the policies in `arms.ts`; nothing in an
 * attempt knows which arm will read it.
 */
import type { VerifiedProvenance } from "@arbor/core";

export type Stage0Member = "yocto-queue" | "more-itertools" | "semver";
export type Stage0Language = "javascript" | "python" | "rust";

/** How a task was produced. See the preregistration's "Task set" section. */
export type Stage0TaskGenerator =
  /** An authored feature request with an injected red test and a reference fix. */
  | "feature_injection"
  /** An upstream function body replaced by a stub; upstream tests are the specification and the upstream body is the reference fix. */
  | "body_stub";

export type Stage0Split = "calibration" | "held_out";

export interface Stage0Task {
  readonly id: string;
  readonly member: Stage0Member;
  readonly language: Stage0Language;
  readonly generator: Stage0TaskGenerator;
  /** The symbol the task is about (e.g. `Queue#peekLast`, `more_itertools.chunked`, `Version::new`). */
  readonly symbol: string;
  /** Paths the task text names in its `Edit exactly …;` clause. */
  readonly edit_paths: readonly string[];
  readonly task_text: string;
  readonly acceptance: readonly string[];
  /** Files the specialist must leave byte-identical (the specification). Checked after adoption. */
  readonly protected_paths: readonly string[];
  readonly split: Stage0Split;
}

/** One built fixture: the task's red baseline commit and its red/green proof. */
export interface Stage0FixtureProof {
  readonly task_id: string;
  readonly fixture_repo: string;
  readonly fixture_commit: string;
  readonly baseline_exit: number | null;
  readonly reference_exit: number | null;
  /** sha256 of each protected path at the fixture commit. */
  readonly protected_sha256: Readonly<Record<string, string>>;
  readonly admitted: boolean;
  readonly reason: string | null;
}

export type Stage0Experiment = "smoke" | "pilot" | "full";

/**
 * Why an attempt did not produce a verified-and-adopted result.
 * `model` is the expected, non-defect outcome: the campaign ran correctly and
 * the work did not pass. The next four are the preregistered defect classes.
 * `aborted` (Revision 2) is an attempt the run guard stopped before it
 * finished because a run cap was reached; it is neither a defect nor a model
 * outcome.
 */
export type Stage0FailureClass = "model" | "harness" | "repository" | "provider" | "capture" | "aborted";

export interface Stage0Tokens {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
}

export const STAGE0_ATTEMPT_SCHEMA = "revoy2.stage0.attempt.v1";

export interface Stage0AttemptRecord {
  readonly schema: typeof STAGE0_ATTEMPT_SCHEMA;
  readonly experiment: Stage0Experiment;
  readonly task_id: string;
  readonly seed: number;
  /** Position in the unit's predetermined attempt order (a0, a1, …). */
  readonly attempt_index: number;
  /** K-wide wave this attempt was dispatched in (0-based). */
  readonly wave: number;
  readonly started_at: string;
  readonly finished_at: string;
  readonly wall_ms: number;
  readonly campaign_id: string | null;
  readonly arbor_task_exit: number | null;
  readonly arbor_task_timed_out: boolean;
  readonly halt_reason: string | null;
  /** The campaign's best node is `verified` with `!verified` provenance: the verifier-gate signal arms select on. */
  readonly harness_verified: boolean;
  readonly verification: VerifiedProvenance | null;
  readonly adopt_apply_exit: number | null;
  readonly adopted: boolean;
  readonly changed_paths: readonly string[];
  /** Exit of the task's acceptance command run by this harness on the adopted tree. */
  readonly independent_acceptance_exit: number | null;
  readonly protected_paths_intact: boolean;
  /** The primary outcome: harness-verified, adopted, independently green, specification untouched. */
  readonly verified_and_adopted: boolean;
  /** Runtime-priced USD plus unpriced spans re-priced from the same configured price observation. */
  readonly cost_usd: number;
  readonly cost_priced_usd: number;
  readonly cost_unpriced_estimate_usd: number;
  readonly unpriced_spans: number;
  readonly tokens: Stage0Tokens;
  /** Spend of sessions that never finished, read from the session journal (D9); already part of `cost_usd`. */
  readonly unrecorded_usage?: Stage0UnrecordedUsage | null;
  readonly failure_class: Stage0FailureClass | null;
  readonly failure_detail: string | null;
  /** Where every log, the target clone and its `.arbor` persistence are preserved. */
  readonly run_dir: string;
  /** Provider errors the attempt's audit and session logs record (absent in records written before Revision 2). */
  readonly provider_errors?: readonly Stage0ProviderError[];
  /** Harness connector ids the attempt's sessions ran on. */
  readonly connector_ids?: readonly string[];
  /** Why the run guard aborted this attempt before it finished, if it did. */
  readonly aborted_by?: string | null;
  /** The fully merged arbor config this attempt ran with, secrets redacted (absent before pilot-3 D4). */
  readonly effective_config?: Readonly<Record<string, unknown>> | null;
  /** sha256 of the canonical JSON of `effective_config`. */
  readonly effective_config_sha256?: string | null;
}

/** Usage the session journal records but the campaign audit spans do not; an estimate, never a runtime price. */
export interface Stage0UnrecordedUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly aborted_turn_estimates: number;
  readonly aborted_turn_output_upper_bound: number;
  readonly unbounded_estimates: number;
  readonly cost_usd: number;
  readonly basis: string;
}

/** A provider error as the runtime records it (see `guard.ts`). */
export interface Stage0ProviderError {
  readonly kind: string;
  readonly status: number | null;
  readonly signature: string;
}

/** A K-wide wave as it actually executed. */
export const STAGE0_WAVE_SCHEMA = "revoy2.stage0.wave.v1";

export interface Stage0WaveRecord {
  readonly schema: typeof STAGE0_WAVE_SCHEMA;
  readonly experiment: Stage0Experiment;
  readonly task_id: string;
  readonly seed: number;
  readonly wave: number;
  readonly attempt_indices: readonly number[];
  readonly started_at: string;
  readonly finished_at: string;
  readonly wall_ms: number;
}

/**
 * A post-hoc correction of an attempt's MEASUREMENT fields, appended (never
 * edited in place) when the preserved evidence shows a field was captured
 * wrongly. It can change spend, tokens and the failure classification only;
 * it can never change whether the attempt verified or was adopted.
 */
export const STAGE0_CORRECTION_SCHEMA = "revoy2.stage0.correction.v1";

export interface Stage0CorrectionRecord {
  readonly schema: typeof STAGE0_CORRECTION_SCHEMA;
  readonly experiment: Stage0Experiment;
  readonly at: string;
  readonly task_id: string;
  readonly seed: number;
  readonly attempt_index: number;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly set: Partial<Pick<Stage0AttemptRecord, "cost_usd" | "cost_priced_usd" | "cost_unpriced_estimate_usd" | "unpriced_spans" | "tokens" | "unrecorded_usage" | "campaign_id" | "failure_class" | "failure_detail">>;
}

export type Stage0LedgerEntry =
  | Stage0AttemptRecord
  | Stage0WaveRecord
  | Stage0CorrectionRecord
  | { readonly schema: "revoy2.stage0.event.v1"; readonly experiment: Stage0Experiment; readonly at: string; readonly event: string; readonly detail: Readonly<Record<string, unknown>> };

/** The preregistered design parameters that `arms.ts` and `analysis.ts` read. */
export interface Stage0Design {
  /** Budget levels in units of the pilot's median per-attempt USD. */
  readonly budget_levels: readonly number[];
  /** Concurrent attempts per wave for the K-wide arm. */
  readonly k_wide: number;
  /** Pilot-measured median USD per attempt; the budget unit. */
  readonly usd_unit: number;
  readonly seeds: readonly number[];
  readonly bootstrap_resamples: number;
  readonly bootstrap_seed: string;
}
