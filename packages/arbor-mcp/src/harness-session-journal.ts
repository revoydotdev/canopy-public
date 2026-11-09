/** Durable, redacted observation journal for revoy-owned harness sessions. */
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Provenance } from "@arbor/core";
import type { NativeLoopSessionRecord } from "./native-loop-executor.js";
import type { HarnessSessionConnectorId, HarnessSessionExecutionKind } from "./harness-session-execution.js";
import type { NativeToolAuditRecord } from "./native-tools/contracts.js";
import { redactNativeText, type NativeSessionModelIdentity, type SessionLineage } from "@arbor/harness";
import { FRESH_ADMISSION_KINDS, RECOVERY_OPERATION_PHASES, recoveryHash, recoveryText, type ContinuationAuthorization, type RecoveryOperationCheckpoint } from "./recovery/contracts.js";
import type { HookFiredRecord } from "./hooks/bus.js";
import { HOOK_ALL_EVENTS } from "./hooks/contracts.js";

export interface HarnessSessionDiagnostic { readonly code: string; readonly message: string }
/**
 * A journal write the host could not make durable. Since a malformed
 * projection is persisted as a typed placeholder instead of refused, a false
 * return from a journal write means ordering or durability itself was lost,
 * and only then does a host halt the run, under this typed name.
 */
export class HarnessSessionDurabilityError extends Error {
  readonly code = "harness_session_durability_lost";
  constructor(readonly record: "admission" | "event" | "tool_audit" | "operation_checkpoint" | "completion", message: string) {
    super(message);
    this.name = "HarnessSessionDurabilityError";
  }
}
type ContextOverflowRecoveryDiagnosticCode =
  | "context_overflow_recovery_started"
  | "context_overflow_recovery_unavailable"
  | "context_overflow_recovery_retry"
  | "context_overflow_recovery_failed";
const CONTEXT_OVERFLOW_RECOVERY_DIAGNOSTIC_CODES: readonly ContextOverflowRecoveryDiagnosticCode[] = Object.freeze([
  "context_overflow_recovery_started",
  "context_overflow_recovery_unavailable",
  "context_overflow_recovery_retry",
  "context_overflow_recovery_failed",
]);
export interface HarnessSessionCorruptionDiagnostic extends HarnessSessionDiagnostic { readonly code: "missing" | "malformed_json" | "invalid_entry" | "write_failed"; readonly line?: number }
/**
 * Read-only restart classification derived from a durable session checkpoint.
 * It records neither a provider retry nor a synthetic terminal result.
 */
export type HarnessSessionRecoveryDisposition =
  | { readonly kind: "not_required" }
  | {
      readonly kind: "recovery_required";
      readonly reason: "started_without_terminal" | "interrupt_requested_without_terminal" | "interrupted_with_terminal";
      readonly automatic_replay: false;
      /** Redacted checkpoint identity retained at the last durable observation. */
      readonly checkpoint: Readonly<{ state: string; latest_sequence: number }>;
    };
export interface HarnessSessionSummary {
  /** Timestamp of the latest canonical event; absent until an event is witnessed. */
  readonly latest_event_at?: string;
  readonly session_id: string; readonly campaign_id: string; readonly node_id: string;
  readonly operation: "specialize" | "review"; readonly connector_id: HarnessSessionConnectorId; readonly execution_kind: HarnessSessionExecutionKind; readonly profile_id: string;
  readonly lineage: SessionLineage;
  readonly state: string; readonly latest_sequence: number; readonly terminal: { readonly state: string; readonly cause: string; readonly result?: string; readonly provenance?: Provenance } | null;
  /**
   * Redacted provider/model identity witnessed at lifecycle admission.
   * `configured_revision` is merely an operator expectation; `revision` is
   * null until a supporting adapter observed it in a response.  This is not
   * a liveness or provider-health claim.
   */
  readonly model_identity: NativeSessionModelIdentity | null;
  /** Derived on restart from a nonterminal durable checkpoint; never dispatch authority. */
  readonly recovery: HarnessSessionRecoveryDisposition;
  readonly diagnostics: readonly HarnessSessionDiagnostic[];
  /** Present only for a failed terminal: ordered retries plus the canonical, redacted reason. */
  readonly failure?: HarnessSessionFailureChronology;
}
export interface HarnessSessionEventProjection { readonly session_id: string; readonly sequence: number; readonly occurred_at: string; readonly kind: string; readonly payload: Readonly<Record<string, unknown>> }
/** Redacted host audit evidence, separate from the model-facing event stream. */
export interface HarnessSessionToolAuditProjection {
  readonly session_id: string; readonly call_id: string; readonly tool: string; readonly risk: string;
  /** One-way purpose join; no caller-controlled intent prose is durable. */
  readonly intent: Readonly<{ purpose_hash: string; provenance_tag: string }> | null;
  readonly action_scope: NativeToolAuditRecord["action_scope"];
  readonly outcome: NativeToolAuditRecord["outcome"]; readonly stage: NativeToolAuditRecord["stage"];
  readonly code: string; readonly effect: NativeToolAuditRecord["effect"];
  readonly confinement: NativeToolAuditRecord["confinement"]; readonly summary: string;
}
/**
 * Immutable, content-addressed evidence projection generated only after a
 * terminal native-session observation. It intentionally contains no model
 * transcript, tool arguments/results, credentials, or continuation token.
 */
export interface HarnessSessionArtifactProjection {
  readonly artifact_id: string;
  readonly session_id: string;
  readonly kind: "session_evidence_manifest";
  readonly media_type: "application/vnd.revoy.harness-session-evidence+json";
  readonly provenance: Extract<Provenance, { readonly tag: "generated" }>;
  readonly size_bytes: number;
  /** `durable` only when the journal was composed with a persistence dir. */
  readonly storage: "durable" | "volatile";
}
export type HarnessSessionHookFiredProjection = HookFiredRecord;
export interface HarnessSessionJournalOptions { readonly persistence_dir?: string }
/** Read-only continuation intent history. This projection is descriptive and grants no admission authority. */
export interface HarnessSessionContinuationIntentHistory {
  readonly authorization_id: string;
  readonly continuation_kind: "resume" | "fork" | "respawn";
  readonly state: "staged" | "active" | "canceled";
}
type Entry = { readonly version: 1; readonly kind: "started"; readonly summary: HarnessSessionSummary }
  | { readonly version: 1; readonly kind: "event"; readonly event: HarnessSessionEventProjection }
  | { readonly version: 1; readonly kind: "interrupt_requested"; readonly session_id: string }
  | { readonly version: 1; readonly kind: "finished"; readonly session_id: string; readonly state: string; readonly latest_sequence: number; readonly terminal: HarnessSessionSummary["terminal"] }
  | { readonly version: 1; readonly kind: "tool_audit"; readonly audit: HarnessSessionToolAuditProjection }
  | { readonly version: 1; readonly kind: "artifact_capture"; readonly artifact: HarnessSessionArtifactProjection }
  | { readonly version: 1; readonly kind: "operation_checkpoint"; readonly checkpoint: RecoveryOperationCheckpoint }
  | { readonly version: 1; readonly kind: "continuation_authorization_staged"; readonly authorization: ContinuationAuthorization }
  | { readonly version: 1; readonly kind: "continuation_authorization_activated"; readonly authorization_id: string }
  | { readonly version: 1; readonly kind: "continuation_authorization_cancelled"; readonly authorization_id: string }
  /** Legacy v1 records were written as active authorizations. */
  | { readonly version: 1; readonly kind: "continuation_authorization"; readonly authorization: ContinuationAuthorization }
  | { readonly version: 1; readonly kind: "hook_fired"; readonly hook: HarnessSessionHookFiredProjection };

/**
 * A logical append-only NDJSON journal. Each append rewrites the complete
 * immutable history to a sibling temporary file and renames it atomically, so
 * a crash leaves either the old valid history or the complete new history.
 */
export class HarnessSessionJournal {
  private readonly file: string | null;
  private readonly artifactDirectory: string | null;
  private readonly entries: Entry[] = [];
  private readonly summaries = new Map<string, HarnessSessionSummary>();
  /** Highest durably witnessed canonical event for each session. */
  private readonly eventSequences = new Map<string, number>();
  private readonly finishedSessions = new Set<string>();
  private readonly toolAuditKeys = new Set<string>();
  private readonly hookFiredKeys = new Set<string>();
  private readonly artifacts = new Map<string, HarnessSessionArtifactProjection[]>();
  private readonly operationRecords = new Map<string, RecoveryOperationCheckpoint[]>();
  /** Only activated records are exposed as continuation authority. */
  private readonly continuationAuthorizations = new Map<string, ContinuationAuthorization>();
  private readonly continuationIdempotency = new Map<string, string>();
  /** Revoked authorizations remain indexed so an idempotent replay conflicts. */
  private readonly cancelledContinuations = new Set<string>();
  /** Staged records reserve identity/idempotency but cannot admit dispatch. */
  private readonly stagedContinuations = new Map<string, ContinuationAuthorization>();
  private readonly stagedContinuationIdempotency = new Map<string, string>();
  private readonly startedContinuations = new Map<string, string>();
  private readonly diagnostics: HarnessSessionCorruptionDiagnostic[] = [];
  constructor(options: HarnessSessionJournalOptions = {}) {
    this.file = options.persistence_dir ? join(options.persistence_dir, "harness-sessions.ndjson") : null;
    this.artifactDirectory = options.persistence_dir ? join(options.persistence_dir, "harness-session-artifacts") : null;
    if (this.file) {
      this.replay();
      // A newly opened durable journal has no surviving worker/controller.
      // Classify every nonterminal checkpoint before exposing the read model.
      this.reconcileOrphanedSessions();
    }
  }
  isAvailable(): boolean { return this.file !== null; }
  replayDiagnostics(): readonly HarnessSessionCorruptionDiagnostic[] { return [...this.diagnostics]; }
  list(campaignId?: string, limit = 200): readonly HarnessSessionSummary[] {
    return [...this.summaries.values()].filter((s) => campaignId === undefined || s.campaign_id === campaignId).sort((a, b) => b.session_id.localeCompare(a.session_id)).slice(0, limit);
  }
  inspect(sessionId: string): HarnessSessionSummary | null { return this.summaries.get(sessionId) ?? null; }
  events(sessionId: string, afterSequence = 0, limit = 200): readonly HarnessSessionEventProjection[] {
    return this.entries.filter((e): e is Extract<Entry, { kind: "event" }> => e.kind === "event" && e.event.session_id === sessionId && e.event.sequence > afterSequence).map((e) => e.event).slice(0, limit);
  }
  toolAudits(sessionId: string, limit = 200): readonly HarnessSessionToolAuditProjection[] {
    return this.entries.filter((entry): entry is Extract<Entry, { kind: "tool_audit" }> => entry.kind === "tool_audit" && entry.audit.session_id === sessionId).map((entry) => entry.audit).slice(0, limit);
  }
  operationCheckpoints(sessionId: string, limit = 1_000): readonly RecoveryOperationCheckpoint[] {
    return (this.operationRecords.get(sessionId) ?? []).slice(0, limit);
  }
  continuationAuthorizationsFor(campaignId: string, nodeId?: string): readonly ContinuationAuthorization[] {
    return [...this.continuationAuthorizations.values()].filter((record) => record.campaign_id === campaignId && (nodeId === undefined || record.node_id === nodeId));
  }
  /**
   * Report durable continuation intent history for diagnosis and reconciliation.
   * Unlike `pendingContinuation` and `admitsContinuation`, this includes staged
   * and canceled records (including failed fork attempts) and never returns the
   * authorization payload or establishes dispatch/admission authority.
   */
  continuationIntentHistoryFor(campaignId: string, nodeId: string): readonly HarnessSessionContinuationIntentHistory[] {
    const history = new Map<string, HarnessSessionContinuationIntentHistory>();
    for (const entry of this.entries) {
      if (entry.kind === "continuation_authorization_staged" || entry.kind === "continuation_authorization") {
        const record = entry.authorization;
        if (record.campaign_id !== campaignId || record.node_id !== nodeId) continue;
        history.set(record.authorization_id, Object.freeze({
          authorization_id: record.authorization_id,
          continuation_kind: record.continuation_kind ?? "resume",
          state: entry.kind === "continuation_authorization_staged" ? "staged" : "active",
        }));
      } else if (entry.kind === "continuation_authorization_activated") {
        const previous = history.get(entry.authorization_id);
        if (previous !== undefined) history.set(entry.authorization_id, Object.freeze({ ...previous, state: "active" }));
      } else if (entry.kind === "continuation_authorization_cancelled") {
        const previous = history.get(entry.authorization_id);
        if (previous !== undefined) history.set(entry.authorization_id, Object.freeze({ ...previous, state: "canceled" }));
      }
    }
    return Object.freeze([...history.values()]);
  }
  continuationByIdempotencyKey(key: string): ContinuationAuthorization | null {
    const authorizationId = this.continuationIdempotency.get(key);
    if (authorizationId !== undefined) return this.continuationAuthorizations.get(authorizationId) ?? null;
    const stagedId = this.stagedContinuationIdempotency.get(key);
    return stagedId === undefined ? null : this.stagedContinuations.get(stagedId) ?? null;
  }
  pendingContinuation(campaignId: string, nodeId: string): ContinuationAuthorization | null {
    return [...this.continuationAuthorizations.values()].reverse().find((record) => record.campaign_id === campaignId && record.node_id === nodeId
      && !this.cancelledContinuations.has(record.authorization_id)
      && this.startedContinuations.get(record.authorization_id) === undefined) ?? null;
  }
  admitsContinuation(lineage: Extract<SessionLineage, { readonly kind: "continuation" }>, sessionId: string): boolean {
    const record = this.continuationAuthorizations.get(lineage.authorization_id);
    return record !== undefined && !this.cancelledContinuations.has(lineage.authorization_id)
      && record.new_session_id === sessionId && record.source_session_id === lineage.source_session_id
      && record.source_checkpoint === lineage.checkpoint && record.admissions.length === FRESH_ADMISSION_KINDS.length
      && record.admissions.every((admission) => admission.admitted);
  }
  /** Runtime hook evidence is separate from git-hook liveness attestation. */
  hookInvocations(limit = 500): readonly HarnessSessionHookFiredProjection[] {
    return this.entries.filter((entry): entry is Extract<Entry, { kind: "hook_fired" }> => entry.kind === "hook_fired").map((entry) => entry.hook).slice(-limit);
  }
  /**
   * Artifact discovery is read-only. Reading an artifact is deliberately not
   * an execution/resumption operation; callers receive only the redacted
   * evidence manifest identifier and metadata.
   */
  artifactsFor(sessionId: string, limit = 50): readonly HarnessSessionArtifactProjection[] {
    return (this.artifacts.get(sessionId) ?? []).slice(0, limit);
  }
  /**
   * Write the admission checkpoint before dispatch. Repeated callbacks are
   * idempotent and never manufacture a second start record.
   */
  recordStarted(input: { session_id: string; campaign_id: string; node_id: string; operation: "specialize" | "review"; connector_id: HarnessSessionConnectorId; execution_kind: HarnessSessionExecutionKind; profile_id: string; state: string; latest_sequence: number; lineage?: SessionLineage }): boolean {
    if (this.summaries.has(input.session_id)) return true;
    const lineage = input.lineage ?? Object.freeze({ kind: "new" as const });
    if (lineage.kind === "continuation") {
      if (!this.admitsContinuation(lineage, input.session_id)) return false;
      const started = this.startedContinuations.get(lineage.authorization_id);
      if (started !== undefined && started !== input.session_id) return false;
    }
    const summary: HarnessSessionSummary = Object.freeze({ ...input, lineage, terminal: null, model_identity: null, recovery: NO_HARNESS_SESSION_RECOVERY, diagnostics: [] });
    if (!this.append({ version: 1, kind: "started", summary })) return false;
    this.summaries.set(summary.session_id, summary);
    if (lineage.kind === "continuation") this.startedContinuations.set(lineage.authorization_id, summary.session_id);
    return true;
  }
  /**
   * Persist one redacted canonical event immediately. Sequence identity is a
   * replay checkpoint, not a best-effort list index: duplicate delivery is a
   * no-op and a gap fails closed rather than inventing unseen evidence.
   */
  recordEvent(event: { session_id: string; sequence: number; occurred_at: string; kind: string; payload: unknown }): boolean {
    const current = this.summaries.get(event.session_id);
    if (!current) return false;
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) return false;
    const sequence = this.eventSequences.get(event.session_id);
    if (sequence !== undefined && event.sequence <= sequence) return true;
    if ((sequence === undefined && event.sequence !== 1) || (sequence !== undefined && event.sequence !== sequence + 1)) return false;
    // A projection the journal cannot accept verbatim is never a reason to
    // lose the chronology or end the campaign (D6, UCT Stage 0 pilot 4): it
    // is persisted as a typed placeholder at its own sequence, and the refused
    // field names travel with it. Only ordering and durability failures
    // (above, and `append` below) still return false.
    const projected = redactHarnessSessionEvent(event);
    const redacted = validEventProjection(projected) ? projected : refusedEventPlaceholder(projected);
    if (!validEventProjection(redacted)) return false;
    if (!this.append({ version: 1, kind: "event", event: redacted })) return false;
    this.reduceEvent(redacted);
    return true;
  }
  /** Persist host-owned tool evidence without accepting raw model/tool bytes. */
  recordToolAudit(record: NativeToolAuditRecord): boolean {
    if (!this.summaries.has(record.session_id)) return false;
    const audit: HarnessSessionToolAuditProjection = Object.freeze({
      session_id: record.session_id, call_id: record.call_id, tool: redactToolAuditAtom(record.tool), risk: record.risk,
      intent: record.intent === null ? null : Object.freeze({ purpose_hash: sha256(record.intent.purpose), provenance_tag: record.intent.provenance_tag }),
      action_scope: redactToolActionScope(record.action_scope), outcome: record.outcome, stage: record.stage,
      code: redactToolAuditAtom(record.code), effect: record.effect, confinement: record.confinement, summary: "redacted",
    });
    if (!validToolAudit(audit)) return false;
    const key = toolAuditKey(audit);
    if (this.toolAuditKeys.has(key)) return true;
    if (!this.append({ version: 1, kind: "tool_audit", audit })) return false;
    this.toolAuditKeys.add(key);
    return true;
  }
  recordOperationCheckpoint(checkpoint: RecoveryOperationCheckpoint): boolean {
    if (!this.summaries.has(checkpoint.session_id) || this.finishedSessions.has(checkpoint.session_id) || !validOperationCheckpoint(checkpoint)) return false;
    const records = this.operationRecords.get(checkpoint.session_id) ?? [];
    const sameOperation = records.filter((record) => record.operation_id === checkpoint.operation_id);
    const duplicate = sameOperation.find((record) => record.phase === checkpoint.phase);
    if (duplicate !== undefined) return stableJson(duplicate) === stableJson(checkpoint);
    if (!validOperationTransition(sameOperation, checkpoint)) return false;
    const frozen = Object.freeze({ ...checkpoint });
    if (!this.append({ version: 1, kind: "operation_checkpoint", checkpoint: frozen })) return false;
    this.operationRecords.set(checkpoint.session_id, [...records, frozen]);
    return true;
  }
  recordContinuationAuthorization(record: ContinuationAuthorization): { readonly ok: true; readonly record: ContinuationAuthorization; readonly replayed: boolean } | { readonly ok: false; readonly conflict: boolean; readonly reason: string } {
    const staged = this.stageContinuationAuthorization(record);
    if (!staged.ok) return staged;
    const activated = this.activateContinuationAuthorization(record.authorization_id);
    if (!activated.ok) return activated;
    return { ok: true, record: activated.record, replayed: staged.replayed || activated.replayed };
  }
  /**
   * Durably reserve a complete continuation authorization without granting
   * dispatch authority. Recovery uses this before changing a node to pending.
   * A later activation record is required before readers admit the lineage.
   */
  stageContinuationAuthorization(record: ContinuationAuthorization): { readonly ok: true; readonly record: ContinuationAuthorization; readonly replayed: boolean } | { readonly ok: false; readonly conflict: boolean; readonly reason: string } {
    if (!validContinuationAuthorization(record) || !this.summaries.has(record.source_session_id)) return { ok: false, conflict: false, reason: "continuation authorization is invalid or its source session is absent" };
    const priorId = this.continuationIdempotency.get(record.idempotency_key);
    if (priorId !== undefined) {
      const prior = this.continuationAuthorizations.get(priorId)!;
      return stableJson(prior) === stableJson(record)
        ? { ok: true, record: prior, replayed: true }
        : { ok: false, conflict: true, reason: "idempotency key names a different continuation authorization" };
    }
    const stagedId = this.stagedContinuationIdempotency.get(record.idempotency_key);
    if (stagedId !== undefined) {
      const prior = this.stagedContinuations.get(stagedId)!;
      return stableJson(prior) === stableJson(record)
        ? { ok: true, record: prior, replayed: true }
        : { ok: false, conflict: true, reason: "idempotency key names a different staged continuation authorization" };
    }
    if (this.continuationAuthorizations.has(record.authorization_id) || this.stagedContinuations.has(record.authorization_id)) return { ok: false, conflict: true, reason: "authorization_id names a different continuation authorization" };
    const frozen = freezeContinuationAuthorization(record);
    if (!this.append({ version: 1, kind: "continuation_authorization_staged", authorization: frozen })) return { ok: false, conflict: false, reason: "staged continuation authorization could not be durably recorded" };
    this.stagedContinuations.set(frozen.authorization_id, frozen); this.stagedContinuationIdempotency.set(frozen.idempotency_key, frozen.authorization_id);
    return { ok: true, record: frozen, replayed: false };
  }
  /** Activate a staged authorization after its node transition is durable. */
  activateContinuationAuthorization(authorizationId: string): { readonly ok: true; readonly record: ContinuationAuthorization; readonly replayed: boolean } | { readonly ok: false; readonly conflict: boolean; readonly reason: string } {
    if (this.cancelledContinuations.has(authorizationId)) return { ok: false, conflict: true, reason: "continuation authorization was cancelled" };
    const active = this.continuationAuthorizations.get(authorizationId);
    if (active !== undefined) return { ok: true, record: active, replayed: true };
    const staged = this.stagedContinuations.get(authorizationId);
    if (staged === undefined) return { ok: false, conflict: false, reason: "continuation authorization is not durably staged" };
    if (!this.append({ version: 1, kind: "continuation_authorization_activated", authorization_id: authorizationId })) return { ok: false, conflict: false, reason: "continuation authorization could not be durably activated" };
    this.stagedContinuations.delete(authorizationId);
    this.stagedContinuationIdempotency.delete(staged.idempotency_key);
    this.continuationAuthorizations.set(authorizationId, staged);
    this.continuationIdempotency.set(staged.idempotency_key, authorizationId);
    return { ok: true, record: staged, replayed: false };
  }
  /** Permanently revoke staged or active dispatch authority while retaining its identity for replay conflicts. */
  cancelContinuationAuthorization(authorizationId: string): { readonly ok: true; readonly replayed: boolean } | { readonly ok: false; readonly reason: string } {
    if (this.cancelledContinuations.has(authorizationId)) return { ok: true, replayed: true };
    if (!this.continuationAuthorizations.has(authorizationId) && !this.stagedContinuations.has(authorizationId)) return { ok: true, replayed: true };
    if (!this.append({ version: 1, kind: "continuation_authorization_cancelled", authorization_id: authorizationId })) return { ok: false, reason: "continuation authorization cancellation could not be durably recorded" };
    this.cancelledContinuations.add(authorizationId);
    return { ok: true, replayed: false };
  }
  /** Persist an already-bounded, already-redacted hook firing for liveness and audit. */
  recordHookFired(record: HookFiredRecord): boolean {
    if (!validHookFired(record)) return false;
    const hook = Object.freeze({ ...record });
    const key = hookFiredKey(hook);
    if (this.hookFiredKeys.has(key)) return true;
    if (!this.append({ version: 1, kind: "hook_fired", hook })) return false;
    this.hookFiredKeys.add(key);
    return true;
  }
  record(record: NativeLoopSessionRecord): boolean {
    // Completion can race the optional live-start callback (or be replayed by
    // a host that only records completed sessions).  The record already owns
    // the composed profile, so never replace it with a generic placeholder.
    if (!this.summaries.has(record.inspection.session_id) && !this.recordStarted({ session_id: record.inspection.session_id, campaign_id: record.campaign_id, node_id: record.node_id, operation: record.operation, connector_id: record.connector_id, execution_kind: record.execution_kind, profile_id: record.profile_id, state: record.inspection.state, latest_sequence: 0 })) return false;
    for (const event of record.events) if (!this.recordEvent(event)) return false;
    const terminal = record.inspection.terminal === null ? null : redactTerminal(record.inspection.terminal);
    const old = this.summaries.get(record.inspection.session_id)!;
    const summary: HarnessSessionSummary = Object.freeze({ ...old, state: record.inspection.state, latest_sequence: record.inspection.latest_sequence, terminal, recovery: recoveryForTerminal(old.recovery, terminal, record.inspection.state, record.inspection.latest_sequence), diagnostics: this.events(record.inspection.session_id, 0, Number.MAX_SAFE_INTEGER).flatMap(eventDiagnostics) });
    if (!this.finishedSessions.has(summary.session_id)) {
      if (!this.append({ version: 1, kind: "finished", session_id: summary.session_id, state: summary.state, latest_sequence: summary.latest_sequence, terminal })) return false;
      this.summaries.set(summary.session_id, summary); this.finishedSessions.add(summary.session_id);
    }
    // Capture only a terminal, independently redacted structural projection.
    // This cannot revive provider/model history, mint a tool scope, or make
    // a terminal claim authoritative; it is evidence for a *fresh* future
    // admission path only.
    return this.captureEvidenceManifest(this.summaries.get(summary.session_id)!);
  }
  markInterruptRequested(sessionId: string): boolean {
    const current = this.summaries.get(sessionId); if (!current || current.terminal) return false;
    if (current.state === "interrupt_requested") return true;
    // This is durable control-plane evidence, deliberately not a fabricated
    // harness event sequence. The worker records the canonical event when it
    // observes the abort signal, and `record()` persists that sequence later.
    if (!this.append({ version: 1, kind: "interrupt_requested", session_id: sessionId })) return false;
    this.summaries.set(sessionId, Object.freeze({ ...current, state: "interrupt_requested" }));
    return true;
  }
  /**
   * Reconcile persisted starts after a process restart. This deliberately
   * changes only this read model: it does not append to the journal, call a
   * provider/tool, acquire a lease, or submit recovery. ADR-012/026 require
   * an explicit operator-authorized recovery operation for all of those.
   */
  reconcileOrphanedSessions(): readonly HarnessSessionSummary[] {
    const reconciled: HarnessSessionSummary[] = [];
    for (const [sessionId, current] of this.summaries) {
      if (current.terminal !== null || current.recovery.kind === "recovery_required") continue;
      const reason = current.state === "interrupt_requested"
        ? "interrupt_requested_without_terminal" as const
        : "started_without_terminal" as const;
      const next: HarnessSessionSummary = Object.freeze({
        ...current,
        // The old process is not presumed alive. This is a recovery
        // disposition, not a terminal event or a claim about side effects.
        state: "interrupted",
        recovery: Object.freeze({
          kind: "recovery_required",
          reason,
          automatic_replay: false,
          checkpoint: Object.freeze({ state: current.state, latest_sequence: current.latest_sequence }),
        }),
      });
      this.summaries.set(sessionId, next);
      reconciled.push(next);
    }
    return Object.freeze(reconciled);
  }
  private replay(): void {
    try { const text = readFileSync(this.file!, "utf8"); for (const [index, line] of text.split("\n").entries()) { if (!line.trim()) continue; try { const entry = normalizeLegacyEntry(JSON.parse(line)); if (!validEntry(entry) || !this.replayable(entry)) throw new Error("invalid entry"); this.entries.push(entry); this.reduce(entry); } catch { this.diagnostics.push({ code: "invalid_entry", message: "harness session journal line was ignored", line: index + 1 }); } } }
    catch (error: unknown) { if ((error as { code?: string }).code !== "ENOENT") this.diagnostics.push({ code: "missing", message: "harness session journal could not be replayed" }); }
  }
  private reduce(entry: Entry): void {
    if (entry.kind === "started") {
      const summary = normalizeSummary(entry.summary); this.summaries.set(summary.session_id, summary);
      if (summary.lineage.kind === "continuation") this.startedContinuations.set(summary.lineage.authorization_id, summary.session_id);
    }
    else if (entry.kind === "event") this.reduceEvent(entry.event);
    else if (entry.kind === "interrupt_requested") { const old = this.summaries.get(entry.session_id); if (old && !old.terminal) this.summaries.set(entry.session_id, Object.freeze({ ...old, state: "interrupt_requested" })); }
    else if (entry.kind === "finished") { const old = this.summaries.get(entry.session_id); if (old) this.summaries.set(entry.session_id, Object.freeze({ ...old, state: entry.state, latest_sequence: entry.latest_sequence, terminal: entry.terminal, recovery: recoveryForTerminal(old.recovery, entry.terminal, entry.state, entry.latest_sequence) })); this.finishedSessions.add(entry.session_id); }
    else if (entry.kind === "tool_audit") this.toolAuditKeys.add(toolAuditKey(entry.audit));
    else if (entry.kind === "artifact_capture") this.addArtifact(entry.artifact);
    else if (entry.kind === "operation_checkpoint") this.operationRecords.set(entry.checkpoint.session_id, [...(this.operationRecords.get(entry.checkpoint.session_id) ?? []), entry.checkpoint]);
    else if (entry.kind === "hook_fired") this.hookFiredKeys.add(hookFiredKey(entry.hook));
    else if (entry.kind === "continuation_authorization_staged") {
      this.stagedContinuations.set(entry.authorization.authorization_id, entry.authorization);
      this.stagedContinuationIdempotency.set(entry.authorization.idempotency_key, entry.authorization.authorization_id);
    }
    else if (entry.kind === "continuation_authorization_activated") {
      const staged = this.stagedContinuations.get(entry.authorization_id);
      if (staged !== undefined) {
        this.stagedContinuations.delete(entry.authorization_id);
        this.stagedContinuationIdempotency.delete(staged.idempotency_key);
        this.continuationAuthorizations.set(staged.authorization_id, staged);
        this.continuationIdempotency.set(staged.idempotency_key, staged.authorization_id);
      }
    }
    else if (entry.kind === "continuation_authorization_cancelled") this.cancelledContinuations.add(entry.authorization_id);
    else { // Legacy v1 continuation_authorization entries were active on write.
      this.continuationAuthorizations.set(entry.authorization.authorization_id, entry.authorization);
      this.continuationIdempotency.set(entry.authorization.idempotency_key, entry.authorization.authorization_id);
    }
  }
  private replayable(entry: Entry): boolean {
    if (entry.kind === "started") {
      if (!validStart(entry.summary) || this.summaries.has(entry.summary.session_id)) return false;
      const lineage = entry.summary.lineage;
      return lineage === undefined || lineage.kind !== "continuation" || this.admitsContinuation(lineage, entry.summary.session_id);
    }
    if (entry.kind === "event") {
      if (!this.summaries.has(entry.event.session_id) || this.finishedSessions.has(entry.event.session_id)) return false;
      if (!Number.isSafeInteger(entry.event.sequence) || entry.event.sequence <= 0) return false;
      const prior = this.eventSequences.get(entry.event.session_id);
      return (prior === undefined ? entry.event.sequence === 1 : entry.event.sequence === prior + 1) && validEventProjection(entry.event);
    }
    if (entry.kind === "tool_audit") return this.summaries.has(entry.audit.session_id) && !this.finishedSessions.has(entry.audit.session_id) && validToolAudit(entry.audit);
    if (entry.kind === "hook_fired") return validHookFired(entry.hook);
    if (entry.kind === "artifact_capture") return this.finishedSessions.has(entry.artifact.session_id) && validArtifact(entry.artifact) && this.artifactContentIsPresent(entry.artifact);
    if (entry.kind === "operation_checkpoint") return this.summaries.has(entry.checkpoint.session_id) && !this.finishedSessions.has(entry.checkpoint.session_id) && validOperationCheckpoint(entry.checkpoint) && validOperationTransition((this.operationRecords.get(entry.checkpoint.session_id) ?? []).filter((record) => record.operation_id === entry.checkpoint.operation_id), entry.checkpoint);
    if (entry.kind === "continuation_authorization_staged") return this.summaries.has(entry.authorization.source_session_id) && validContinuationAuthorization(entry.authorization) && !this.continuationAuthorizations.has(entry.authorization.authorization_id) && !this.stagedContinuations.has(entry.authorization.authorization_id) && !this.continuationIdempotency.has(entry.authorization.idempotency_key) && !this.stagedContinuationIdempotency.has(entry.authorization.idempotency_key);
    if (entry.kind === "continuation_authorization_activated") return this.stagedContinuations.has(entry.authorization_id) && !this.continuationAuthorizations.has(entry.authorization_id);
    if (entry.kind === "continuation_authorization_cancelled") return this.continuationAuthorizations.has(entry.authorization_id) || this.stagedContinuations.has(entry.authorization_id) || this.cancelledContinuations.has(entry.authorization_id);
    if (entry.kind === "continuation_authorization") return this.summaries.has(entry.authorization.source_session_id) && validContinuationAuthorization(entry.authorization) && !this.continuationAuthorizations.has(entry.authorization.authorization_id) && !this.stagedContinuations.has(entry.authorization.authorization_id) && !this.continuationIdempotency.has(entry.authorization.idempotency_key) && !this.stagedContinuationIdempotency.has(entry.authorization.idempotency_key);
    if (entry.kind === "interrupt_requested") return this.summaries.has(entry.session_id) && !this.finishedSessions.has(entry.session_id) && this.summaries.get(entry.session_id)?.terminal === null;
    return this.summaries.has(entry.session_id) && !this.finishedSessions.has(entry.session_id);
  }
  private reduceEvent(event: HarnessSessionEventProjection): void {
    const previous = this.eventSequences.get(event.session_id);
    if (previous !== undefined && event.sequence <= previous) return;
    this.eventSequences.set(event.session_id, event.sequence);
    const old = this.summaries.get(event.session_id); if (!old) return;
    const terminal = event.kind === "terminal" ? event.payload as HarnessSessionSummary["terminal"] : old.terminal;
    const model_identity = extractHarnessSessionModelIdentity(event) ?? old.model_identity;
    const state = event.kind === "lifecycle" && event.payload.state === "started" ? "running"
      : event.kind === "terminal" && typeof event.payload.state === "string" ? event.payload.state : old.state;
    const diagnostics = [...old.diagnostics, ...eventDiagnostics(event)];
    const latestSequence = Math.max(old.latest_sequence, event.sequence);
    // Derived from the same durable redacted events on write and on replay.
    const failure = event.kind === "terminal" ? deriveHarnessSessionFailure(this.events(event.session_id, 0, Number.MAX_SAFE_INTEGER)) : old.failure ?? null;
    this.summaries.set(event.session_id, Object.freeze({ ...old, state, latest_sequence: latestSequence, latest_event_at: event.occurred_at, terminal, model_identity, recovery: recoveryForTerminal(old.recovery, terminal, state, latestSequence), diagnostics, ...(failure === null ? {} : { failure }) }));
  }
  private append(entry: Entry): boolean {
    if (!this.file) { this.entries.push(entry); return true; }
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${[...this.entries, entry].map((x) => JSON.stringify(x)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, this.file); this.entries.push(entry); return true;
    } catch { this.diagnostics.push({ code: "write_failed", message: "harness session journal write failed" }); return false; }
  }
  private captureEvidenceManifest(summary: HarnessSessionSummary): boolean {
    const existing = this.artifacts.get(summary.session_id);
    if (existing?.some((artifact) => artifact.kind === "session_evidence_manifest")) return true;
    if (summary.terminal === null) return false;
    const source = {
      schema_version: 1,
      kind: "native_session_evidence" as const,
      session: {
        session_id: summary.session_id, campaign_id: summary.campaign_id, node_id: summary.node_id,
        operation: summary.operation, connector_id: summary.connector_id, execution_kind: summary.execution_kind,
        profile_id: summary.profile_id, model_identity: summary.model_identity, latest_sequence: summary.latest_sequence,
        terminal: summary.terminal,
      },
      events: this.events(summary.session_id, 0, 10_000),
      tool_audits: this.toolAudits(summary.session_id, 10_000),
    };
    const serialized = stableJson(source);
    const artifact_id = sha256(serialized);
    const artifact: HarnessSessionArtifactProjection = Object.freeze({
      artifact_id, session_id: summary.session_id, kind: "session_evidence_manifest",
      media_type: "application/vnd.revoy.harness-session-evidence+json",
      provenance: Object.freeze({ tag: "generated", generator: "revoy-native-session-journal", input_hash: sha256(stableJson(source.session)) }),
      size_bytes: Buffer.byteLength(serialized, "utf8"), storage: this.artifactDirectory === null ? "volatile" : "durable",
    });
    if (!validArtifact(artifact) || !this.writeArtifact(artifact, serialized)) return false;
    if (!this.append({ version: 1, kind: "artifact_capture", artifact })) return false;
    this.addArtifact(artifact);
    return true;
  }
  private addArtifact(artifact: HarnessSessionArtifactProjection): void {
    const prior = this.artifacts.get(artifact.session_id) ?? [];
    if (prior.some((item) => item.artifact_id === artifact.artifact_id)) return;
    this.artifacts.set(artifact.session_id, [...prior, artifact]);
  }
  private writeArtifact(artifact: HarnessSessionArtifactProjection, serialized: string): boolean {
    if (this.artifactDirectory === null) return true;
    try {
      // Evidence is redacted, but its identifiers and structural tool/session
      // facts are still operational data. Do not rely on the host umask for
      // the directory boundary; a broad existing directory is tightened too.
      mkdirSync(this.artifactDirectory, { recursive: true, mode: 0o700 });
      const directory = lstatSync(this.artifactDirectory);
      if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error("artifact directory is not a real directory");
      chmodSync(this.artifactDirectory, 0o700);
      const destination = join(this.artifactDirectory, `${artifact.artifact_id.slice("sha256:".length)}.json`);
      if (this.artifactContentIsPresent(artifact)) { chmodSync(destination, 0o600); return true; }
      const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, serialized, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, destination);
      return true;
    } catch { this.diagnostics.push({ code: "write_failed", message: "harness session artifact write failed" }); return false; }
  }
  private artifactContentIsPresent(artifact: HarnessSessionArtifactProjection): boolean {
    if (this.artifactDirectory === null) return true;
    try {
      const directory = lstatSync(this.artifactDirectory);
      if (directory.isSymbolicLink() || !directory.isDirectory() || (directory.mode & 0o077) !== 0) return false;
      const destination = join(this.artifactDirectory, `${artifact.artifact_id.slice("sha256:".length)}.json`);
      // Do not expose a content-addressed handle for a file that a local
      // group/other principal can read, even if its hash matches.
      const file = lstatSync(destination);
      if (file.isSymbolicLink() || !file.isFile() || (file.mode & 0o077) !== 0) return false;
      const content = readFileSync(destination, "utf8");
      return sha256(content) === artifact.artifact_id;
    } catch { return false; }
  }
}
const NO_HARNESS_SESSION_RECOVERY: HarnessSessionRecoveryDisposition = Object.freeze({ kind: "not_required" });
/**
 * A session that settles on its own, IN-PROCESS, to a genuinely interrupted
 * terminal (`terminal.state === "interrupted"` — e.g. a real operator
 * `tree.interrupt`/`harness.session.interrupt` cancelling the live
 * AbortController mid-turn, see `LiveNativeSessionRegistry.interrupt` and
 * `native-worker.ts`'s `interrupted()`) is durable, real evidence of a
 * governed stop -- not the "process died with no evidence at all" case
 * `reconcileOrphanedSessions` exists for. Before this, `record`/`reduceEvent`
 * unconditionally forced ANY terminal (completed, failed, OR interrupted)
 * to `NO_HARNESS_SESSION_RECOVERY`, which made `RecoveryService.previewSession`/
 * `previewContinuation` (both keyed strictly on `recovery.kind ===
 * "recovery_required"`) permanently unable to see a live-interrupted session
 * as a continuation candidate -- `harness.session.resume`/`.respawn` could
 * only ever succeed after a hard process restart reconciled a crash orphan,
 * never for the in-process interrupt the manifest's "Harness continuations"
 * gap actually asks to demonstrate. This does not widen dispatch authority:
 * `prepareContinuation`/`prepareFork` still independently gate on
 * dispositions, idempotency, fresh admissions, and lease/isolation checks --
 * this only makes a genuinely-interrupted session ELIGIBLE for that
 * existing gate, matching a completed/failed terminal's already-correct
 * "not recoverable" classification.
 */
function recoveryForTerminal(old: HarnessSessionRecoveryDisposition, terminal: HarnessSessionSummary["terminal"], state: string, latestSequence: number): HarnessSessionRecoveryDisposition {
  if (terminal === null) return old;
  if (terminal.state !== "interrupted") return NO_HARNESS_SESSION_RECOVERY;
  return Object.freeze({
    kind: "recovery_required" as const,
    reason: "interrupted_with_terminal" as const,
    automatic_replay: false as const,
    checkpoint: Object.freeze({ state, latest_sequence: latestSequence }),
  });
}
/** Old v1 lines predate the derived field and remain safely replayable. */
function normalizeSummary(value: HarnessSessionSummary): HarnessSessionSummary {
  // `started` records intentionally never persist a model identity.  It is
  // derived only from the validated lifecycle event below, so a forged or
  // legacy start row cannot manufacture an observed revision.
  const model_identity = validLifecycleModelIdentity(value.model_identity) ? freezeModelIdentity(value.model_identity) : null;
  // A failure chronology is derived from events only; a start row cannot carry one.
  const { failure: _derivedOnly, ...rest } = value;
  return Object.freeze({ ...rest, lineage: value.lineage ?? Object.freeze({ kind: "new" as const }), model_identity, recovery: value.recovery === undefined ? NO_HARNESS_SESSION_RECOVERY : value.recovery });
}
function redactTerminal(value: { state: string; cause: string; result?: string; provenance?: Provenance }): HarnessSessionSummary["terminal"] { return { state: value.state, cause: value.cause, ...(value.result ? { result: value.result } : {}), ...(value.provenance ? { provenance: value.provenance } : {}) }; }
const MAX_OPERATOR_MODEL_TEXT_CHARS = 16_000;

/**
 * Shared by durable persistence and live catalog projections. Model text is
 * the operator-facing conversation product, so it survives this boundary
 * after the harness redactor and a hard size bound. Hidden reasoning and raw
 * tool/request content remain redacted.
 */
export function redactHarnessSessionEvent(event: { session_id: string; sequence: number; occurred_at: string; kind: string; payload: unknown }): HarnessSessionEventProjection {
  const payload = event.payload as Record<string, unknown>; const safe: Record<string, unknown> = {};
  if (event.kind === "usage") { safe.input_tokens = payload.input_tokens ?? null; safe.output_tokens = payload.output_tokens ?? null; if (typeof payload.unavailable_reason === "string") safe.unavailable_reason = payload.unavailable_reason; }
  else if (event.kind === "model_text") {
    safe.text = typeof payload.text === "string"
      ? redactNativeText(payload.text).slice(0, MAX_OPERATOR_MODEL_TEXT_CHARS)
      : "";
    safe.phase = payload.phase === "final" ? "final" : "commentary";
  }
  else if (event.kind === "model_route") {
    // A route receipt is the only durable model-selection fact for a routed
    // session. It is deliberately restricted to non-secret identities: no
    // prompt, tool schema, capability, account, or credential crosses here.
    safe.route = payload.route;
    safe.provider_id = payload.provider_id;
    safe.model_id = payload.model_id;
    safe.configured_revision = payload.configured_revision ?? null;
    safe.revision = payload.revision ?? null;
  }
  else if (event.kind === "artifact") { safe.artifact_id = payload.artifact_id; safe.media_type = payload.media_type; safe.provenance = payload.provenance; }
  else if (event.kind === "terminal") Object.assign(safe, redactTerminal(payload as { state: string; cause: string; result?: string; provenance?: Provenance }));
  else if (event.kind === "diagnostic") {
    // Diagnostic messages can contain adapter/provider text. Persist only
    // the stable code; the known one-shot recovery outcomes are explicit so
    // replayed operator views can distinguish the branch that was taken.
    safe.code = typeof payload.code === "string" && (isContextOverflowRecoveryDiagnosticCode(payload.code) || /^[a-z][a-z0-9_]{0,127}$/.test(payload.code))
      ? payload.code
      : "unknown";
    const retry = payload.retry;
    if (payload.code === "model_retry" && typeof retry === "object" && retry !== null) {
      const r = retry as Record<string, unknown>;
      if (typeof r.attempt === "number" && Number.isSafeInteger(r.attempt) && r.attempt > 0
        && typeof r.max_attempts === "number" && Number.isSafeInteger(r.max_attempts) && r.max_attempts > r.attempt
        && typeof r.delay_ms === "number" && Number.isSafeInteger(r.delay_ms) && r.delay_ms >= 0
        && typeof r.failure_kind === "string" && ["timeout", "transport", "http", "protocol", "credential", "unknown"].includes(r.failure_kind)) {
        safe.retry = { attempt: r.attempt, max_attempts: r.max_attempts, delay_ms: r.delay_ms, failure_kind: r.failure_kind };
      }
    }
    // A terminal model-port failure keeps a typed, bounded, independently
    // redacted provider reason; the raw message itself still never crosses.
    const providerFailure = typeof payload.message === "string" && (PROVIDER_FAILURE_DIAGNOSTIC_CODES as readonly unknown[]).includes(payload.code)
      ? parseProviderFailure(payload.message)
      : null;
    if (providerFailure !== null) safe.provider_failure = providerFailure;
  }
  else if (event.kind === "tool_intent") {
    safe.tool = payload.tool;
    // Entry ids and provenance tags are content-free joins to the governed
    // context boundary; tool input summaries remain intentionally absent.
    if (Array.isArray(payload.context_refs)) safe.intent_provenance_tags = payload.context_refs
      .filter((ref): ref is Record<string, unknown> => typeof ref === "object" && ref !== null)
      .map((ref) => typeof (ref.provenance as Record<string, unknown> | undefined)?.tag === "string" ? (ref.provenance as Record<string, unknown>).tag : null)
      .filter((tag): tag is string => tag !== null);
  }
  else if (event.kind === "tool_result") {
    safe.tool = payload.tool;
    if (typeof payload.success === "boolean") safe.success = payload.success;
    if (isAuditHash(payload.operation_id)) safe.operation_id = payload.operation_id;
    if (isAuditHash(payload.reused_from_operation_id)) safe.reused_from_operation_id = payload.reused_from_operation_id;
    const evidence = payload.evidence;
    if (typeof evidence === "object" && evidence !== null) {
      const record = evidence as Record<string, unknown>;
      if (typeof record.outcome === "string") safe.outcome = record.outcome;
      if (typeof record.stage === "string") safe.stage = record.stage;
      if (typeof record.code === "string") safe.code = record.code;
      if (typeof record.effect === "string") safe.effect = record.effect;
      if (typeof record.action_scope === "object" && record.action_scope !== null) {
        const scope = record.action_scope as Record<string, unknown>;
        const safeScope: Record<string, unknown> = {};
        if (typeof scope.status === "string") safeScope.status = scope.status;
        if (typeof scope.scope_id_hash === "string") safeScope.scope_id_hash = scope.scope_id_hash;
        if (typeof scope.provenance_tag === "string") safeScope.provenance_tag = scope.provenance_tag;
        safe.action_scope = safeScope;
      }
    }
  }
  else if (event.kind === "lifecycle") {
    safe.state = payload.state; safe.ephemeral = payload.ephemeral;
    const identity = payload.model_identity;
    if (isRecord(identity) && typeof identity.provider_id === "string" && typeof identity.model_id === "string"
      && (identity.configured_revision === null || typeof identity.configured_revision === "string")
      && (identity.revision === null || typeof identity.revision === "string")) {
      // This is composition identity plus an optional response observation;
      // it contains no account or credential material.
      safe.model_identity = Object.freeze({ provider_id: identity.provider_id, model_id: identity.model_id, configured_revision: identity.configured_revision, revision: identity.revision });
    }
  }
  else safe.redacted = true;
  return { session_id: event.session_id, sequence: event.sequence, occurred_at: event.occurred_at, kind: event.kind, payload: safe };
}

function isContextOverflowRecoveryDiagnosticCode(value: string): value is ContextOverflowRecoveryDiagnosticCode {
  return (CONTEXT_OVERFLOW_RECOVERY_DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

/** The native worker's terminal model-port failure codes (`requestModel`). */
const PROVIDER_FAILURE_DIAGNOSTIC_CODES = Object.freeze(["model_failure", "model_retry_exhausted"] as const);
const MODEL_PORT_FAILURE_PREFIX = "model port failed: ";
/** Mirrors the worker's own head bound on a model error detail (`MAX_MODEL_ERROR_DETAIL_CHARS`). */
const MAX_PROVIDER_FAILURE_MESSAGE_CHARS = 256;
const FAILURE_KINDS = Object.freeze(["timeout", "transport", "http", "protocol", "credential", "unknown"] as const);
type ProviderFailureKind = typeof FAILURE_KINDS[number];

/**
 * Typed terminal provider reason (ADR-190 journal provider failure
 * reason). Every field is either a closed enum, a grammar-checked atom, or a
 * bounded message that passed the harness redactor AND this module's own
 * credential-shape scrub; a body-shaped tail is cut, never retained.
 */
export interface HarnessSessionProviderFailure {
  readonly error_class: string;
  readonly failure_kind: ProviderFailureKind;
  readonly http_status: number | null;
  readonly provider_code: string | null;
  readonly message: string | null;
}

/** One bounded automatic retry, in durable sequence order. */
export interface HarnessSessionRetryAttempt {
  readonly sequence: number; readonly occurred_at: string;
  readonly attempt: number; readonly max_attempts: number; readonly delay_ms: number;
  readonly failure_kind: ProviderFailureKind;
}

/**
 * The ordered retry chronology and canonical reason of a FAILED session,
 * derived only from redacted canonical events. The live registry and the
 * durable journal both call `deriveHarnessSessionFailure`, so a restart
 * reproduces exactly what the live projection showed.
 */
export interface HarnessSessionFailureChronology {
  readonly retries: readonly HarnessSessionRetryAttempt[];
  readonly reason: Readonly<{ sequence: number; occurred_at: string; code: string; provider: HarnessSessionProviderFailure | null }> | null;
  readonly terminal_sequence: number;
}

export function deriveHarnessSessionFailure(events: readonly HarnessSessionEventProjection[]): HarnessSessionFailureChronology | null {
  const terminalIndex = events.findIndex((event) => event.kind === "terminal");
  if (terminalIndex < 0 || events[terminalIndex]!.payload.state !== "failed") return null;
  const prior = events.slice(0, terminalIndex);
  const retries: HarnessSessionRetryAttempt[] = [];
  for (const event of prior) {
    const retry = event.kind === "diagnostic" && event.payload.code === "model_retry" ? event.payload.retry : undefined;
    if (!isRecord(retry)) continue;
    retries.push(Object.freeze({
      sequence: event.sequence, occurred_at: event.occurred_at,
      attempt: retry.attempt as number, max_attempts: retry.max_attempts as number, delay_ms: retry.delay_ms as number,
      failure_kind: retry.failure_kind as ProviderFailureKind,
    }));
  }
  // `failed()` records the canonical diagnostic immediately before settling.
  const diagnostic = [...prior].reverse().find((event) => event.kind === "diagnostic" && event.payload.code !== "model_retry");
  const provider = diagnostic !== undefined && isRecord(diagnostic.payload.provider_failure) && validProviderFailure(diagnostic.payload.provider_failure)
    ? diagnostic.payload.provider_failure as unknown as HarnessSessionProviderFailure
    : null;
  return Object.freeze({
    retries: Object.freeze(retries),
    reason: diagnostic === undefined ? null : Object.freeze({ sequence: diagnostic.sequence, occurred_at: diagnostic.occurred_at, code: String(diagnostic.payload.code), provider }),
    terminal_sequence: events[terminalIndex]!.sequence,
  });
}

/**
 * Parse the worker's `model port failed: <Class> (<kind>): <detail>` shape
 * (`describeModelError`). Anything not in that shape yields null rather
 * than a guessed reason.
 */
function parseProviderFailure(message: string): HarnessSessionProviderFailure | null {
  if (!message.startsWith(MODEL_PORT_FAILURE_PREFIX)) return null;
  const match = /^([A-Za-z_$][\w$]{0,63})(?: \(([a-z_]{1,32})\))?: ([\s\S]*)$/.exec(message.slice(MODEL_PORT_FAILURE_PREFIX.length));
  if (match === null) return null;
  const kind = match[2] === undefined ? "unknown" : (FAILURE_KINDS as readonly string[]).includes(match[2]) ? match[2] as ProviderFailureKind : "unknown";
  const detail = sanitizeProviderFailureMessage(match[3]!);
  const status = detail === null ? null : /\bHTTP (\d{3})\b/.exec(detail);
  const http_status = status === null ? null : Number(status[1]);
  const codeMatch = detail === null ? null : /\bHTTP \d{3}: ([A-Za-z][A-Za-z0-9_.-]{0,63})(?::|$)/.exec(detail);
  return Object.freeze({
    error_class: match[1]!,
    failure_kind: kind,
    http_status: http_status !== null && http_status >= 100 && http_status <= 599 ? http_status : null,
    provider_code: codeMatch === null ? null : codeMatch[1]!,
    message: detail,
  });
}

/**
 * The worker already redacted this text; this is an independent second
 * boundary. It cuts at the first body-shaped character so an adapter that
 * forwards a raw JSON/HTML body cannot persist it, removes credential
 * shapes the generic redactor does not name, and bounds the result.
 */
function sanitizeProviderFailureMessage(value: string): string | null {
  const bodyStart = value.search(/[{}<>]/);
  const head = bodyStart < 0 ? value : value.slice(0, bodyStart);
  // redactNativeText already removes key shapes (sk-/pk-/rk-, AKIA/ASIA,
  // gh*_, xox*, JWT, AIza; redactCredentialShapes in @arbor/harness). This
  // field is a bounded provider reason, so it is stricter still: any long
  // opaque run is treated as a credential, even without a key-ish label.
  const clean = redactNativeText(head)
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/[:\s]+$/, "");
  if (clean.length === 0) return null;
  return clean.length > MAX_PROVIDER_FAILURE_MESSAGE_CHARS ? `${clean.slice(0, MAX_PROVIDER_FAILURE_MESSAGE_CHARS)}…` : clean;
}

function validProviderFailure(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort().join(",");
  return keys === "error_class,failure_kind,http_status,message,provider_code"
    && typeof value.error_class === "string" && /^[A-Za-z_$][\w$]{0,63}$/.test(value.error_class)
    && (FAILURE_KINDS as readonly unknown[]).includes(value.failure_kind)
    && (value.http_status === null || (typeof value.http_status === "number" && Number.isSafeInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599))
    && (value.provider_code === null || (typeof value.provider_code === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value.provider_code)))
    && (value.message === null || (typeof value.message === "string" && value.message.length <= MAX_PROVIDER_FAILURE_MESSAGE_CHARS + 1 && !/[{}<>\u0000-\u001f\u007f]/.test(value.message)));
}

/**
 * Read the one content-free provider identity that survives event redaction.
 * Callers must use this rather than treating a configured adapter/model as a
 * response observation.  It accepts only the closed lifecycle shape.
 */
export function extractHarnessSessionModelIdentity(event: HarnessSessionEventProjection): NativeSessionModelIdentity | null {
  if (event.kind !== "lifecycle") return null;
  const identity = event.payload.model_identity;
  return validLifecycleModelIdentity(identity) ? freezeModelIdentity(identity) : null;
}

function freezeModelIdentity(value: unknown): NativeSessionModelIdentity {
  const identity = value as NativeSessionModelIdentity;
  return Object.freeze({
    provider_id: identity.provider_id,
    model_id: identity.model_id,
    configured_revision: identity.configured_revision,
    revision: identity.revision,
  });
}
function toolAuditKey(audit: HarnessSessionToolAuditProjection): string { return `${audit.session_id}\u0000${audit.call_id}\u0000${audit.tool}\u0000${audit.stage}\u0000${audit.outcome}\u0000${audit.code}`; }
function hookFiredKey(hook: HarnessSessionHookFiredProjection): string { return `${hook.at}\u0000${hook.hook_id}\u0000${hook.version}\u0000${hook.event}\u0000${hook.decision}`; }
/**
 * A host audit atom that is not well formed becomes a bounded, valid label
 * rather than a marker the audit validator itself would refuse (the old
 * `[REDACTED]` failed `isAuditAtom`, so the audit write failed and the CLI
 * threw out of the campaign, the D6 shape on the tool-audit path).
 */
function redactToolAuditAtom(value: string): string {
  return isAuditAtom(value) ? value : refusedAtomLabel(value);
}
/** Bounded, content-free stand-in for a refused atom: equal inputs share a label. */
function refusedAtomLabel(value: unknown): string {
  return `journal_refused.${createHash("sha256").update(typeof value === "string" ? value : stableJson(value ?? null)).digest("hex").slice(0, 16)}`;
}
/** Fields of a projection the journal replaced instead of persisting verbatim. */
export const HARNESS_SESSION_JOURNAL_REFUSED_FIELD = "journal_refused_field";
/** Diagnostic code for an event the journal could not persist even field by field. */
export const HARNESS_SESSION_JOURNAL_REFUSED_EVENT = "journal_refused_event";
/**
 * The typed stand-in for a projection `validEventProjection` refused. A tool
 * event keeps its kind and every valid field, with each malformed atom
 * (`tool`, `code`) replaced by a digest label and named in
 * `journal_refused_field`. Anything else, or a tool event that is still
 * invalid, becomes a `journal_refused_event` diagnostic at the same sequence
 * that records only the refused kind: no unvalidated claim (a forged
 * outcome, say) survives into the chronology.
 */
function refusedEventPlaceholder(event: HarnessSessionEventProjection): HarnessSessionEventProjection {
  if (event.kind === "tool_result" || event.kind === "tool_intent") {
    const refused = (["tool", "code"] as const).filter((field) => (field === "tool" || event.kind === "tool_result") && !isAuditAtom(event.payload[field]));
    if (refused.length > 0) {
      const payload: Record<string, unknown> = { ...event.payload, [HARNESS_SESSION_JOURNAL_REFUSED_FIELD]: refused };
      for (const field of refused) payload[field] = refusedAtomLabel(event.payload[field]);
      const sanitized = { ...event, payload };
      if (validEventProjection(sanitized)) return sanitized;
    }
  }
  return {
    session_id: event.session_id, sequence: event.sequence, occurred_at: event.occurred_at,
    kind: "diagnostic",
    payload: { code: HARNESS_SESSION_JOURNAL_REFUSED_EVENT, refused_kind: isAuditAtom(event.kind) ? event.kind : "unknown", [HARNESS_SESSION_JOURNAL_REFUSED_FIELD]: ["payload"] },
  };
}
function validRefusedFields(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every((field) => typeof field === "string" && /^[a-z_]{1,32}$/.test(field)));
}
/** Session-summary diagnostics one durable event contributes, identical on write and replay. */
function eventDiagnostics(event: HarnessSessionEventProjection): HarnessSessionDiagnostic[] {
  if (event.kind === "diagnostic") return [{ code: typeof event.payload.code === "string" ? event.payload.code : "unknown", message: "redacted session diagnostic" }];
  return event.payload[HARNESS_SESSION_JOURNAL_REFUSED_FIELD] === undefined ? [] : [{ code: HARNESS_SESSION_JOURNAL_REFUSED_FIELD, message: "redacted session diagnostic" }];
}
function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function redactToolActionScope(scope: NativeToolAuditRecord["action_scope"]): NativeToolAuditRecord["action_scope"] {
  const status = scope.status === "not_required" || scope.status === "bound" || scope.status === "absent" || scope.status === "invalid" ? scope.status : "invalid";
  const provenance_tag = scope.provenance_tag === "verified" || scope.provenance_tag === "claimed" || scope.provenance_tag === "critic_approved" || scope.provenance_tag === "generated" ? scope.provenance_tag : undefined;
  const scope_id_hash = status === "bound" && typeof scope.scope_id_hash === "string" && /^sha256:[a-f0-9]{64}$/.test(scope.scope_id_hash) ? scope.scope_id_hash : undefined;
  return Object.freeze({ status, ...(scope_id_hash === undefined ? {} : { scope_id_hash }), ...(provenance_tag === undefined ? {} : { provenance_tag }) });
}
function validStart(summary: HarnessSessionSummary): boolean {
  return typeof summary.session_id === "string" && summary.session_id.length > 0
    && typeof summary.campaign_id === "string" && typeof summary.node_id === "string"
    && Number.isSafeInteger(summary.latest_sequence) && summary.latest_sequence >= 0
    // Identity is appended in the first lifecycle event, never in `started`.
    && (summary.model_identity === undefined || summary.model_identity === null);
}
function validToolAudit(audit: HarnessSessionToolAuditProjection): boolean {
  if (!isSessionId(audit.session_id) || !isAuditAtom(audit.call_id) || !isAuditAtom(audit.tool) || !isAuditAtom(audit.code)) return false;
  if (audit.risk !== "low" && audit.risk !== "high") return false;
  if (audit.outcome !== "succeeded" && audit.outcome !== "refused" && audit.outcome !== "failed" && audit.outcome !== "cancelled" && audit.outcome !== "truncated") return false;
  if (audit.stage !== "semantic" && audit.stage !== "audit" && audit.stage !== "sandbox" && audit.stage !== "execution") return false;
  if (audit.effect !== "none" && audit.effect !== "observed" && audit.effect !== "applied" && audit.effect !== "unknown") return false;
  if (audit.confinement !== "application_validated" && audit.confinement !== "os_confined" && audit.confinement !== "container_confined" && audit.confinement !== "remote_attested") return false;
  if (audit.summary !== "redacted") return false;
  if (!validAuditScope(audit.action_scope)) return false;
  return audit.intent === null || (isAuditHash(audit.intent.purpose_hash) && isProvenanceTag(audit.intent.provenance_tag));
}
/**
 * The event test reads the bus's OWN canonical catalog, `HOOK_ALL_EVENTS`,
 * rather than a hand-typed array of event names.
 *
 * It was a hand-typed array, and that was a fourth instance of this
 * repository's "correct in isolation, broken in composition" defect: the array
 * held ten events while `HOOK_ALL_EVENTS` held fifteen, so the four observe
 * events added after it was written — `tool_write`, `user_prompt_submit`,
 * `pre_compact`, `notification`, and `turn_end` — were all refused here. A
 * refused `hook_fired` makes `recordHookFired` return false, and the composition
 * site's `on_fired` THROWS "runtime hook evidence could not be durably
 * recorded" out of the dispatch that produced it — so the first descriptor
 * bound to any of those events took its whole session down. The `inject` kind
 * above was the same bug one release earlier, and its comment records it.
 *
 * A second copy of a closed catalog is the cause in both cases: the copy is
 * what drifts, and nothing can fail while it is merely wrong. Deriving it is
 * the fix, and it cannot drift again while the catalog gains an event.
 */
function validHookFired(hook: HarnessSessionHookFiredProjection): boolean {
  return isAuditAtom(hook.hook_id)
    && typeof hook.version === "string" && hook.version.length > 0 && hook.version.length <= 128
    // `inject` is included because it is one of `HookFiredRecord`'s four
    // kinds (`HookKind`). Omitting it made every inject firing throw
    // "runtime hook evidence could not be durably recorded" out of
    // `injectForSession` and take the session down with it — invisible only
    // while the inject lane had no activated descriptor (see `catalog.ts`).
    && (hook.kind === "observe" || hook.kind === "veto" || hook.kind === "lifecycle" || hook.kind === "inject")
    && HOOK_ALL_EVENTS.includes(hook.event)
    && (hook.decision === "observed" || hook.decision === "allow" || hook.decision === "deny" || hook.decision === "error")
    && typeof hook.evidence_ref === "string" && Buffer.byteLength(hook.evidence_ref, "utf8") <= 512
    && !Number.isNaN(Date.parse(hook.at));
}
function isAuditAtom(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value); }
/** Session identities compose campaign, panel/role, operation, and UUID segments. */
function isSessionId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,512}$/.test(value); }
function isAuditHash(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function isProvenanceTag(value: unknown): boolean { return value === "verified" || value === "claimed" || value === "critic_approved" || value === "generated"; }
function validAuditScope(scope: HarnessSessionToolAuditProjection["action_scope"]): boolean {
  if (scope.status !== "not_required" && scope.status !== "bound" && scope.status !== "absent" && scope.status !== "invalid") return false;
  if (scope.status === "bound") return isAuditHash(scope.scope_id_hash) && isProvenanceTag(scope.provenance_tag);
  return scope.scope_id_hash === undefined && ((scope.status === "not_required" || scope.status === "absent") ? scope.provenance_tag === undefined : (scope.provenance_tag === undefined || isProvenanceTag(scope.provenance_tag)));
}
function validArtifact(artifact: HarnessSessionArtifactProjection): boolean {
  return isAuditHash(artifact.artifact_id) && isSessionId(artifact.session_id)
    && artifact.kind === "session_evidence_manifest"
    && artifact.media_type === "application/vnd.revoy.harness-session-evidence+json"
    && artifact.provenance.tag === "generated"
    && artifact.provenance.generator === "revoy-native-session-journal"
    && isAuditHash(artifact.provenance.input_hash)
    && Number.isSafeInteger(artifact.size_bytes) && artifact.size_bytes >= 0
    && (artifact.storage === "durable" || artifact.storage === "volatile");
}
function validEventProjection(event: HarnessSessionEventProjection): boolean {
  if (typeof event.session_id !== "string" || event.session_id.length === 0 || typeof event.kind !== "string" || Number.isNaN(Date.parse(event.occurred_at))) return false;
  if (!validRefusedFields(event.payload[HARNESS_SESSION_JOURNAL_REFUSED_FIELD])) return false;
  if (event.kind === "lifecycle") {
    if (event.payload.state !== "started" || typeof event.payload.ephemeral !== "boolean") return false;
    const identity = event.payload.model_identity;
    return identity === undefined || validLifecycleModelIdentity(identity);
  }
  if (event.kind === "tool_intent") {
    const tags = event.payload.intent_provenance_tags;
    return isAuditAtom(event.payload.tool) && (tags === undefined || (Array.isArray(tags) && tags.every(isProvenanceTag)));
  }
  if (event.kind === "model_route") {
    return (event.payload.route === "tool_capable" || event.payload.route === "non_tool")
      && isModelIdentityAtom(event.payload.provider_id) && isModelIdentityAtom(event.payload.model_id)
      && (event.payload.configured_revision === null || isModelIdentityAtom(event.payload.configured_revision))
      && (event.payload.revision === null || isModelIdentityAtom(event.payload.revision));
  }
  if (event.kind === "model_text") {
    return typeof event.payload.text === "string"
      && event.payload.text.length <= MAX_OPERATOR_MODEL_TEXT_CHARS
      && (event.payload.phase === "commentary" || event.payload.phase === "final");
  }
  if (event.kind === "diagnostic") {
    const provider = event.payload.provider_failure;
    return provider === undefined || (isRecord(provider) && validProviderFailure(provider));
  }
  if (event.kind !== "tool_result") return true;
  const scope = event.payload.action_scope;
  return isAuditAtom(event.payload.tool) && typeof event.payload.success === "boolean"
    && (event.payload.operation_id === undefined || isAuditHash(event.payload.operation_id))
    && (event.payload.reused_from_operation_id === undefined || (isAuditHash(event.payload.reused_from_operation_id) && isAuditHash(event.payload.operation_id) && event.payload.reused_from_operation_id !== event.payload.operation_id))
    && (event.payload.outcome === "succeeded" || event.payload.outcome === "refused" || event.payload.outcome === "failed" || event.payload.outcome === "cancelled" || event.payload.outcome === "truncated")
    && (event.payload.stage === "semantic" || event.payload.stage === "audit" || event.payload.stage === "sandbox" || event.payload.stage === "execution")
    && isAuditAtom(event.payload.code)
    && (event.payload.effect === "none" || event.payload.effect === "observed" || event.payload.effect === "applied" || event.payload.effect === "unknown")
    && event.payload.success === (event.payload.outcome === "succeeded")
    && isRecord(scope) && validAuditScope(scope as unknown as HarnessSessionToolAuditProjection["action_scope"]);
}
function validLifecycleModelIdentity(value: unknown): boolean {
  if (!isRecord(value) || !isModelIdentityAtom(value.provider_id) || !isModelIdentityAtom(value.model_id)) return false;
  return (value.configured_revision === null || isModelIdentityAtom(value.configured_revision))
    && (value.revision === null || isModelIdentityAtom(value.revision));
}
// Provider model identifiers commonly contain a namespace separator (for
// example `openai/gpt-5.6-luna`). They remain content-free identifiers, but
// are not tool-audit atoms and must not be rejected by that narrower grammar.
function isModelIdentityAtom(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:/@-]{1,256}$/.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}
function validEntry(value: unknown): value is Entry { return typeof value === "object" && value !== null && (value as { version?: unknown }).version === 1 && ["started", "event", "interrupt_requested", "finished", "tool_audit", "artifact_capture", "operation_checkpoint", "continuation_authorization_staged", "continuation_authorization_activated", "continuation_authorization_cancelled", "continuation_authorization", "hook_fired"].includes((value as { kind?: unknown }).kind as string); }

function validOperationCheckpoint(value: RecoveryOperationCheckpoint): boolean {
  return isSessionId(value.session_id) && recoveryText(value.operation_id) && recoveryText(value.operation)
    && (value.operation_kind === "provider" || value.operation_kind === "tool")
    && RECOVERY_OPERATION_PHASES.includes(value.phase)
    && ["provider", "read_only", "file_write", "file_patch", "shell", "external"].includes(value.effect_kind)
    && typeof value.repeatable === "boolean" && (value.idempotency_key_hash === null || recoveryHash(value.idempotency_key_hash))
    && (value.acknowledged_by === null || recoveryText(value.acknowledged_by))
    && (value.outcome === null || ["succeeded", "failed", "refused", "cancelled", "truncated"].includes(value.outcome))
    && (value.effect === null || ["none", "observed", "applied", "unknown"].includes(value.effect))
    && (value.compensation_id === null || recoveryText(value.compensation_id)) && !Number.isNaN(Date.parse(value.occurred_at));
}
function validOperationTransition(prior: readonly RecoveryOperationCheckpoint[], next: RecoveryOperationCheckpoint): boolean {
  if (prior.length === 0) return next.phase === "prepared";
  const base = prior[0]!;
  if (base.session_id !== next.session_id || base.operation !== next.operation || base.operation_kind !== next.operation_kind || base.effect_kind !== next.effect_kind || base.repeatable !== next.repeatable) return false;
  const phases = new Set(prior.map((record) => record.phase));
  if (next.phase === "idempotency_acknowledged") return phases.has("prepared") && next.idempotency_key_hash !== null && next.acknowledged_by !== null;
  if (next.phase === "dispatched") return phases.has("prepared");
  if (next.phase === "settled") return phases.has("dispatched") && next.outcome !== null && next.effect !== null;
  return next.phase === "compensation_available" && phases.has("dispatched") && next.compensation_id !== null;
}
function validContinuationAuthorization(value: ContinuationAuthorization): boolean {
  if (![value.authorization_id, value.idempotency_key, value.campaign_id, value.node_id, value.source_session_id, value.new_session_id, value.actor_id].every((item) => recoveryText(item))) return false;
  if (!Number.isSafeInteger(value.source_checkpoint) || value.source_checkpoint < 0 || !recoveryHash(value.classification_fingerprint) || Number.isNaN(Date.parse(value.authorized_at))) return false;
  if (value.admissions.length !== FRESH_ADMISSION_KINDS.length || new Set(value.admissions.map((item) => item.kind)).size !== FRESH_ADMISSION_KINDS.length || value.admissions.some((item) => !item.admitted || !recoveryText(item.evidence_id) || !recoveryText(item.reason, 1_024))) return false;
  if (value.context.length > 64 || value.context.some((item) => !recoveryText(item.reference_id) || !recoveryText(item.summary, 1_024))) return false;
  return value.effects.length <= 256 && value.effects.every((item) => recoveryText(item.operation_id) && recoveryText(item.operation) && ["observed-complete", "observed-failed", "safely-idempotent", "compensatable", "indeterminate"].includes(item.classification))
    && value.dispositions.every((item) => recoveryText(item.operation_id) && recoveryText(item.reason, 1_024) && ["retry", "accept_observed", "compensate", "abandon"].includes(item.decision));
}
function freezeContinuationAuthorization(value: ContinuationAuthorization): ContinuationAuthorization {
  return Object.freeze({ ...value, effects: Object.freeze(value.effects.map((item) => Object.freeze({ ...item }))), dispositions: Object.freeze(value.dispositions.map((item) => Object.freeze({ ...item }))), admissions: Object.freeze(value.admissions.map((item) => Object.freeze({ ...item }))), context: Object.freeze(value.context.map((item) => Object.freeze({ ...item, provenance: Object.freeze({ ...item.provenance }) }))) });
}
function normalizeLegacyEntry(value: unknown): unknown {
  if (typeof value !== "object" || value === null || (value as { kind?: unknown }).kind !== "tool_audit") return value;
  const audit = (value as { audit?: unknown }).audit;
  if (typeof audit !== "object" || audit === null || "confinement" in audit) return value;
  // Records written before ADR-044 could only have application checks.
  return { ...value, audit: { ...audit, confinement: "application_validated" } };
}
