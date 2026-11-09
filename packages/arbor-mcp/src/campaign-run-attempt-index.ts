/**
 * ADR-093: durable campaign-run attempt identity index.
 *
 * This is the ONE new durable record ADR-093 authorizes. It establishes
 * identity and lineage for a campaign-run attempt where no existing
 * authority (`TaskSupervisor`, `JobScheduler`, `CampaignManager`,
 * `HarnessSessionJournal`) already does — it never copies a campaign tree,
 * task lifecycle, session transcript, approval, critic verdict, or tool
 * result. `campaign-run-status-projection.ts` is the sole reader that joins
 * this index against those authorities into one canonical status.
 *
 * Persistence follows the same atomic-rewrite pattern as
 * `supervisor-persist.ts`: the complete small array is rewritten to a
 * sibling temp file and renamed, so a crash leaves either the old valid
 * history or the complete new one. Attempts are few and small (one per
 * campaign-run admission or refusal), so a full-array rewrite is simpler
 * than an append-only NDJSON log and gives free validation-on-load.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const CAMPAIGN_RUN_ATTEMPT_INDEX_VERSION = 1 as const;

/** A closed, redacted refusal code — never a raw stack trace or provider payload. */
export interface CampaignRunAttemptRefusal {
  readonly code: string;
  /** Opaque/redacted reference to a campaign diagnostic, session, gate, or recovery record. */
  readonly diagnostic_ref: string | null;
  readonly terminal_at: string;
}

export interface CampaignRunAttempt {
  readonly schema_version: typeof CAMPAIGN_RUN_ATTEMPT_INDEX_VERSION;
  readonly attempt_id: string;
  readonly campaign_id: string;
  readonly attempt_ordinal: number;
  /** Null only for a refusal: nothing was ever admitted into a supervised task. */
  readonly supervisor_task_id: string | null;
  readonly operation_id: string;
  readonly supersedes_attempt_id: string | null;
  readonly created_at: string;
  readonly refusal: CampaignRunAttemptRefusal | null;
}

/** Caller-supplied classification of the campaign's current latest attempt, used to enforce Decision §3's supersession rule without this index holding a `TaskSupervisor` reference. */
export type CampaignRunAttemptLatestTaskState = "none" | "terminal" | "reconciliation_required" | "runnable";

export interface CampaignRunAttemptAdmissionInput {
  readonly campaign_id: string;
  readonly operation_id: string;
  readonly supervisor_task_id: string;
  readonly created_at?: string;
}

export interface CampaignRunAttemptRefusalInput {
  readonly campaign_id: string;
  readonly operation_id: string;
  readonly code: string;
  readonly diagnostic_ref?: string | null;
  readonly created_at?: string;
}

export type CampaignRunAttemptResult =
  | { readonly ok: true; readonly attempt: CampaignRunAttempt; readonly replayed: boolean }
  | { readonly ok: false; readonly reason: string };

export interface CampaignRunAttemptIndexOptions {
  readonly persistence_dir?: string;
}

export type CampaignRunAttemptDiagnosticCode = "invalid_json" | "invalid_shape" | "unsupported_version";
export interface CampaignRunAttemptDiagnostic {
  readonly code: CampaignRunAttemptDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validateAttempt(value: unknown): CampaignRunAttempt {
  if (!isRecord(value)) throw new Error("attempt must be a JSON object");
  if (value.schema_version !== CAMPAIGN_RUN_ATTEMPT_INDEX_VERSION) throw new Error(`unsupported attempt schema_version ${JSON.stringify(value.schema_version)}`);
  if (!nonEmptyString(value.attempt_id) || !nonEmptyString(value.campaign_id) || !nonEmptyString(value.operation_id)) throw new Error("attempt_id, campaign_id, and operation_id must be non-empty strings");
  if (!Number.isSafeInteger(value.attempt_ordinal) || (value.attempt_ordinal as number) < 1) throw new Error("attempt_ordinal must be a safe integer >= 1");
  if (!isoTimestamp(value.created_at)) throw new Error("created_at must be an ISO timestamp");
  if (value.supervisor_task_id !== null && !nonEmptyString(value.supervisor_task_id)) throw new Error("supervisor_task_id must be null or a non-empty string");
  if (value.supersedes_attempt_id !== null && !nonEmptyString(value.supersedes_attempt_id)) throw new Error("supersedes_attempt_id must be null or a non-empty string");
  const refusal = value.refusal;
  if (refusal !== null) {
    if (!isRecord(refusal) || !nonEmptyString(refusal.code) || !isoTimestamp(refusal.terminal_at) || (refusal.diagnostic_ref !== null && !nonEmptyString(refusal.diagnostic_ref))) {
      throw new Error("refusal must be null or {code, diagnostic_ref, terminal_at}");
    }
    if (value.supervisor_task_id !== null) throw new Error("a refused attempt must not carry a supervisor_task_id");
  } else if (value.supervisor_task_id === null) {
    throw new Error("a non-refused attempt must carry a supervisor_task_id");
  }
  return {
    schema_version: CAMPAIGN_RUN_ATTEMPT_INDEX_VERSION,
    attempt_id: value.attempt_id,
    campaign_id: value.campaign_id,
    attempt_ordinal: value.attempt_ordinal as number,
    supervisor_task_id: value.supervisor_task_id as string | null,
    operation_id: value.operation_id,
    supersedes_attempt_id: value.supersedes_attempt_id as string | null,
    created_at: value.created_at,
    refusal: refusal === null ? null : { code: (refusal as Record<string, unknown>).code as string, diagnostic_ref: (refusal as Record<string, unknown>).diagnostic_ref as string | null, terminal_at: (refusal as Record<string, unknown>).terminal_at as string },
  };
}

function indexPath(dir: string): string { return join(dir, "campaign-run-attempts", "attempts.json"); }

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Durable, process-local attempt identity index for campaign-run execution
 * status (ADR-093 §1). No-persistence composition roots get an ephemeral,
 * in-memory-only index (`isAvailable() === false`); the status projection
 * must mark those results `ephemeral: true` rather than claiming restart
 * durability.
 */
export class CampaignRunAttemptIndex {
  private readonly dir: string | null;
  private readonly attempts: CampaignRunAttempt[] = [];
  private readonly byOperation = new Map<string, string>();
  private readonly diagnostics: CampaignRunAttemptDiagnostic[] = [];

  constructor(options: CampaignRunAttemptIndexOptions = {}) {
    this.dir = options.persistence_dir ?? null;
    if (this.dir) this.load();
  }

  isAvailable(): boolean { return this.dir !== null; }
  loadDiagnostics(): readonly CampaignRunAttemptDiagnostic[] { return [...this.diagnostics]; }

  /** All attempts, deterministically ordered by campaign id then ordinal. */
  list(campaignId?: string): readonly CampaignRunAttempt[] {
    return this.attempts
      .filter((attempt) => campaignId === undefined || attempt.campaign_id === campaignId)
      .sort((a, b) => a.campaign_id.localeCompare(b.campaign_id) || a.attempt_ordinal - b.attempt_ordinal);
  }

  get(attemptId: string): CampaignRunAttempt | null {
    return this.attempts.find((attempt) => attempt.attempt_id === attemptId) ?? null;
  }

  byOperationId(operationId: string): CampaignRunAttempt | null {
    const attemptId = this.byOperation.get(operationId);
    return attemptId === undefined ? null : this.get(attemptId);
  }

  /** Highest-ordinal attempt for a campaign (refusal or admitted), or null if none exists yet. */
  latestFor(campaignId: string): CampaignRunAttempt | null {
    const scoped = this.list(campaignId);
    return scoped.length === 0 ? null : scoped[scoped.length - 1]!;
  }

  /**
   * Record (or idempotently replay) a normal attempt that links exactly one
   * supervised task. `latestTaskState` is the caller's classification of the
   * campaign's current latest attempt (see Decision §3): a `"runnable"`
   * predecessor refuses admission of a new attempt outright — the caller
   * must first make it terminal or reconciliation-required through the
   * single-writer supervisor, not through this index.
   */
  recordAttempt(input: CampaignRunAttemptAdmissionInput, latestTaskState: CampaignRunAttemptLatestTaskState): CampaignRunAttemptResult {
    if (!nonEmptyString(input.campaign_id) || !nonEmptyString(input.operation_id) || !nonEmptyString(input.supervisor_task_id)) {
      return { ok: false, reason: "campaign_id, operation_id, and supervisor_task_id are required" };
    }
    const replay = this.byOperationId(input.operation_id);
    if (replay !== null) return { ok: true, attempt: replay, replayed: true };
    if (latestTaskState === "runnable") {
      return { ok: false, reason: `campaign ${input.campaign_id} already has a runnable attempt; it must become terminal or reconciliation-required before a new attempt is admitted` };
    }
    const latest = this.latestFor(input.campaign_id);
    const attempt: CampaignRunAttempt = {
      schema_version: CAMPAIGN_RUN_ATTEMPT_INDEX_VERSION,
      attempt_id: `crun_${randomUUID()}`,
      campaign_id: input.campaign_id,
      attempt_ordinal: (latest?.attempt_ordinal ?? 0) + 1,
      supervisor_task_id: input.supervisor_task_id,
      operation_id: input.operation_id,
      supersedes_attempt_id: latest?.attempt_id ?? null,
      created_at: input.created_at ?? new Date().toISOString(),
      refusal: null,
    };
    return this.commit(attempt);
  }

  /**
   * Record (or idempotently replay) a preflight/dispatch refusal: an
   * attempt that never became a runnable task. It still consumes the next
   * ordinal for the campaign so a refused run is durably observable rather
   * than silently invisible.
   */
  recordRefusal(input: CampaignRunAttemptRefusalInput): CampaignRunAttemptResult {
    if (!nonEmptyString(input.campaign_id) || !nonEmptyString(input.operation_id) || !nonEmptyString(input.code)) {
      return { ok: false, reason: "campaign_id, operation_id, and code are required" };
    }
    const replay = this.byOperationId(input.operation_id);
    if (replay !== null) return { ok: true, attempt: replay, replayed: true };
    const latest = this.latestFor(input.campaign_id);
    const terminalAt = input.created_at ?? new Date().toISOString();
    const attempt: CampaignRunAttempt = {
      schema_version: CAMPAIGN_RUN_ATTEMPT_INDEX_VERSION,
      attempt_id: `crun_${randomUUID()}`,
      campaign_id: input.campaign_id,
      attempt_ordinal: (latest?.attempt_ordinal ?? 0) + 1,
      supervisor_task_id: null,
      operation_id: input.operation_id,
      supersedes_attempt_id: latest?.attempt_id ?? null,
      created_at: terminalAt,
      refusal: { code: input.code, diagnostic_ref: input.diagnostic_ref ?? null, terminal_at: terminalAt },
    };
    return this.commit(attempt);
  }

  private commit(attempt: CampaignRunAttempt): CampaignRunAttemptResult {
    const duplicateOrdinal = this.attempts.some((existing) => existing.campaign_id === attempt.campaign_id && existing.attempt_ordinal === attempt.attempt_ordinal);
    if (duplicateOrdinal) return { ok: false, reason: `attempt ordinal ${attempt.attempt_ordinal} is already recorded for campaign ${attempt.campaign_id}` };
    if (this.dir) {
      try { this.persist([...this.attempts, attempt]); } catch (error) { return { ok: false, reason: `attempt could not be durably recorded: ${error instanceof Error ? error.message : String(error)}` }; }
    }
    this.attempts.push(attempt);
    this.byOperation.set(attempt.operation_id, attempt.attempt_id);
    return { ok: true, attempt, replayed: false };
  }

  private persist(attempts: readonly CampaignRunAttempt[]): void {
    const dir = this.dir!;
    const attemptDir = join(dir, "campaign-run-attempts");
    mkdirSync(attemptDir, { recursive: true });
    const value = { schema_version: CAMPAIGN_RUN_ATTEMPT_INDEX_VERSION, saved_at: new Date().toISOString(), attempts: attempts.map((attempt) => ({ ...attempt })) };
    const target = indexPath(dir);
    const temporary = join(attemptDir, `.attempts.${process.pid}.tmp`);
    writeFileSync(temporary, JSON.stringify(value, null, 2));
    syncFile(temporary);
    renameSync(temporary, target);
    try { syncFile(attemptDir); } catch { /* directory fsync is not portable */ }
  }

  private load(): void {
    const path = indexPath(this.dir!);
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (!isRecord(raw) || raw.schema_version !== CAMPAIGN_RUN_ATTEMPT_INDEX_VERSION || !Array.isArray(raw.attempts)) {
        this.diagnostics.push({ code: raw && isRecord(raw) && raw.schema_version !== CAMPAIGN_RUN_ATTEMPT_INDEX_VERSION ? "unsupported_version" : "invalid_shape", path, message: "campaign-run attempt index failed shape validation" });
        return;
      }
      const validated: CampaignRunAttempt[] = [];
      const seenOrdinals = new Set<string>();
      for (const entry of raw.attempts) {
        const attempt = validateAttempt(entry);
        const ordinalKey = `${attempt.campaign_id}::${attempt.attempt_ordinal}`;
        if (seenOrdinals.has(ordinalKey)) throw new Error(`duplicate attempt ordinal for ${ordinalKey}`);
        seenOrdinals.add(ordinalKey);
        validated.push(attempt);
      }
      for (const attempt of validated) { this.attempts.push(attempt); this.byOperation.set(attempt.operation_id, attempt.attempt_id); }
    } catch (error) {
      this.diagnostics.push({ code: error instanceof SyntaxError ? "invalid_json" : "invalid_shape", path, message: `campaign-run attempt index could not be loaded: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
}
