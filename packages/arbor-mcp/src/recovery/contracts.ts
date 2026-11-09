import type { Provenance } from "@arbor/core";

const RECOVERY_EFFECT_CLASSES = ["observed-complete", "observed-failed", "safely-idempotent", "compensatable", "indeterminate"] as const;
export type RecoveryEffectClass = typeof RECOVERY_EFFECT_CLASSES[number];

export const RECOVERY_OPERATION_PHASES = ["prepared", "idempotency_acknowledged", "dispatched", "settled", "compensation_available"] as const;
export type RecoveryOperationPhase = typeof RECOVERY_OPERATION_PHASES[number];
export type RecoveryEffectKind = "provider" | "read_only" | "file_write" | "file_patch" | "shell" | "external";

/** Content-free write-ahead evidence. Payloads, paths, credentials and results are excluded. */
export interface RecoveryOperationCheckpoint {
  readonly session_id: string;
  readonly operation_id: string;
  readonly operation_kind: "provider" | "tool";
  readonly operation: string;
  readonly phase: RecoveryOperationPhase;
  readonly effect_kind: RecoveryEffectKind;
  readonly repeatable: boolean;
  readonly idempotency_key_hash: string | null;
  readonly acknowledged_by: string | null;
  readonly outcome: "succeeded" | "failed" | "refused" | "cancelled" | "truncated" | null;
  readonly effect: "none" | "observed" | "applied" | "unknown" | null;
  readonly compensation_id: string | null;
  readonly occurred_at: string;
  /**
   * S02 (audit/2026-09-06-remediation): bounded, non-secret evidence for a
   * failed/refused command, so a retry has something to act on instead of
   * only `command_exit_nonzero`. `live-haiku/cancellation/findings.md`:
   * "Retry context contains changed-file deltas but evidence: [] ... The
   * worker lacks the failed argv, exit detail, and bounded stderr needed
   * for targeted repair." Absent on every checkpoint recorded before this
   * field existed, and on any checkpoint whose phase never reached a
   * command outcome (e.g. `read_only` calls never populate it). Always
   * construct this with `boundRecoveryFailureEvidence` — never assemble the
   * object by hand — so the bounds below are enforced at the one
   * construction site rather than trusted from each caller.
   */
  readonly failure_evidence?: RecoveryFailureEvidence | null;
}

/** Bounded, content-free-of-secrets record of one failed command, for retry targeting. Never a raw transcript or full stdout/stderr capture. */
export interface RecoveryFailureEvidence {
  /** The exact argv that ran, capped to `RECOVERY_MAX_FAILURE_ARGV_TOKENS` tokens. */
  readonly command_argv: readonly string[];
  readonly exit_code: number | null;
  /** Tail of stderr, capped to `RECOVERY_MAX_STDERR_EXCERPT_BYTES` UTF-8 bytes. Callers must redact secrets before this boundary; this only bounds size. */
  readonly stderr_excerpt: string | null;
}

export const RECOVERY_MAX_FAILURE_ARGV_TOKENS = 32;
export const RECOVERY_MAX_STDERR_EXCERPT_BYTES = 2_048;

/**
 * The sole construction site for `RecoveryFailureEvidence`. Bounds argv
 * length and stderr byte size regardless of what the caller passes, so an
 * unbounded capture upstream can never reach durable storage or a
 * continuation-plan context fact through this type. `null` stderr is
 * preserved as `null` (distinct from an empty-but-present string) so a
 * consumer can tell "no stderr was captured" from "stderr was empty".
 */
export function boundRecoveryFailureEvidence(input: {
  readonly command_argv: readonly string[];
  readonly exit_code: number | null;
  readonly stderr: string | null;
}): RecoveryFailureEvidence {
  const argv = input.command_argv.slice(0, RECOVERY_MAX_FAILURE_ARGV_TOKENS).map((token) => String(token));
  const stderr_excerpt = input.stderr === null ? null : boundUtf8Tail(input.stderr, RECOVERY_MAX_STDERR_EXCERPT_BYTES);
  return Object.freeze({ command_argv: Object.freeze(argv), exit_code: input.exit_code, stderr_excerpt });
}

/** The last `maxBytes` UTF-8 bytes of `value` (a failing command's most recent output is the actionable part), decoded back to a valid string. */
function boundUtf8Tail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  let start = buffer.byteLength - maxBytes;
  // Skip UTF-8 continuation bytes (10xxxxxx) so the cut never splits a codepoint into U+FFFD.
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

export interface RecoveryDisposition {
  readonly operation_id: string;
  readonly decision: "retry" | "accept_observed" | "compensate" | "abandon";
  readonly reason: string;
}

export const FRESH_ADMISSION_KINDS = ["connector", "credential", "budget", "worktree", "policy", "approval", "high_risk_scope", "model_revision"] as const;
export type FreshAdmissionKind = typeof FRESH_ADMISSION_KINDS[number];
export interface FreshAdmissionResult {
  readonly kind: FreshAdmissionKind;
  readonly admitted: boolean;
  /** Bounded non-secret evidence identity, never an authority token. */
  readonly evidence_id: string;
  readonly reason: string;
}

export interface ContinuationContextFact {
  readonly kind: "artifact" | "decision" | "open_question" | "summary";
  readonly reference_id: string;
  readonly summary: string;
  readonly provenance: Provenance;
}

export interface ContinuationAuthorization {
  readonly authorization_id: string;
  readonly idempotency_key: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly source_session_id: string;
  readonly source_checkpoint: number;
  readonly new_session_id: string;
  /** Product intent for the fresh session; absent legacy records are resumes. */
  readonly continuation_kind?: "resume" | "fork" | "respawn";
  readonly classification_fingerprint: string;
  readonly effects: readonly Readonly<{ operation_id: string; operation: string; classification: RecoveryEffectClass }>[];
  readonly dispositions: readonly RecoveryDisposition[];
  readonly admissions: readonly FreshAdmissionResult[];
  readonly context: readonly ContinuationContextFact[];
  readonly actor_id: string;
  readonly authorized_at: string;
}

export const RECOVERY_MAX_OPERATIONS = 256;
export const RECOVERY_MAX_CONTEXT_FACTS = 64;
export const RECOVERY_MAX_SUMMARY_BYTES = 1_024;

export function recoveryText(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= max;
}

export function recoveryHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
