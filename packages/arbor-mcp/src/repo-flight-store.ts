import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { governanceAdmissionAttestationDigest } from "@arbor/governance";
import {
  isRepoFlightDigest, isRepoFlightGitOid, isRepoFlightId, isRepoFlightPhase, isRepoFlightRepositoryId,
  REPO_FLIGHT_WORK_CLASSES, type RepoFlightAppendResult, type RepoFlightBindingPatch, type RepoFlightCreatedPayload, type RepoFlightGovernanceAttemptPayload,
  type RepoFlightEvent, type RepoFlightEventBody, type RepoFlightEventInput,
  type RepoFlightReplayDiagnostic, type RepoFlightRunRepositoryIdentity,
  type RepoFlightTransitionPayload,
} from "./repo-flight-contracts.js";
import { reduceRepoFlightEvent, RepoFlightReductionError } from "./repo-flight-reducer.js";
import type { RepoFlightRunState, RepoFlightSnapshot } from "./repo-flight-state.js";

export interface RepoFlightLifecycleStoreOptions { readonly persistence_dir?: string }

/**
 * Append-first repository-run lifecycle journal.
 *
 * A durable append rewrites the complete immutable JSONL history to a sibling
 * file, fsyncs it, atomically renames it, then fsyncs the parent directory.
 * Therefore a process crash exposes either the prior complete chain or the new
 * complete chain. A malformed or hash-invalid journal replays its valid prefix
 * for inspection but becomes read-only until an operator repairs it.
 */
export class RepoFlightLifecycleStore {
  private readonly file: string | null;
  private readonly journal: RepoFlightEvent[] = [];
  private readonly runs = new Map<string, RepoFlightRunState>();
  private readonly idempotency = new Map<string, RepoFlightEvent>();
  private readonly eventIds = new Map<string, RepoFlightEvent>();
  private readonly diagnostics: RepoFlightReplayDiagnostic[] = [];
  private corrupt = false;

  constructor(options: RepoFlightLifecycleStoreOptions = {}) {
    this.file = options.persistence_dir === undefined ? null : join(options.persistence_dir, "repo-flight-lifecycle.jsonl");
    this.restore();
  }

  isDurable(): boolean { return this.file !== null; }
  isAppendable(): boolean { return !this.corrupt; }
  replayDiagnostics(): readonly RepoFlightReplayDiagnostic[] { return structuredClone(this.diagnostics); }
  events(): readonly RepoFlightEvent[] { return structuredClone(this.journal); }
  inspect(repoRunId: string): RepoFlightRunState | null { const state = this.runs.get(repoRunId); return state === undefined ? null : structuredClone(state); }
  list(): readonly RepoFlightRunState[] { return [...this.runs.values()].sort((a, b) => a.repo_run_id.localeCompare(b.repo_run_id)).map((state) => structuredClone(state)); }

  snapshot(): RepoFlightSnapshot {
    const payload = Object.freeze({
      version: 1 as const,
      sequence: this.journal.length,
      head_hash: this.journal.at(-1)?.event_hash ?? null,
      runs: Object.freeze(this.list()),
    });
    return Object.freeze({ ...payload, snapshot_hash: sha256(payload) });
  }

  append(input: RepoFlightEventInput): RepoFlightAppendResult {
    if (this.corrupt) return failure("corrupt_store", "repository lifecycle journal failed replay validation and is read-only");
    if (!validEventInput(input)) return failure("invalid_event", "repository lifecycle event does not satisfy the closed schema");

    const prior = this.idempotency.get(input.idempotency_key);
    if (prior !== undefined) {
      return semanticInput(prior) === stableJson(input)
        ? { ok: true, replayed: true, event: structuredClone(prior) }
        : failure("idempotency_conflict", "idempotency key names a different repository lifecycle event");
    }
    const sameId = this.eventIds.get(input.event_id);
    if (sameId !== undefined) return failure("idempotency_conflict", "event_id has already been used with a different idempotency key");

    const sequence = this.journal.length + 1;
    const withoutHash = Object.freeze({
      version: 1 as const,
      sequence,
      event_id: input.event_id,
      idempotency_key: input.idempotency_key,
      occurred_at: input.occurred_at,
      previous_hash: this.journal.at(-1)?.event_hash ?? null,
      ...input.body,
    });
    const event: RepoFlightEvent = Object.freeze({ ...withoutHash, event_hash: sha256(withoutHash) });
    const runId = event.payload.repo_run_id;
    let state: RepoFlightRunState;
    try { state = reduceRepoFlightEvent(this.runs.get(runId), event); }
    catch (error) {
      if (error instanceof RepoFlightReductionError) return failure(error.code, error.message);
      return failure("invalid_event", "repository lifecycle reducer rejected the event");
    }
    const next = [...this.journal, event];
    const persistence = this.persist(next);
    if (persistence === "stale") return failure("revision_conflict", "durable journal advanced in another controller; reopen and retry");
    if (persistence === "failed") return failure("write_failed", "repository lifecycle event could not be durably appended");
    this.accept(event, state);
    return { ok: true, replayed: false, event: structuredClone(event) };
  }

  private accept(event: RepoFlightEvent, state: RepoFlightRunState): void {
    this.journal.push(event);
    this.runs.set(state.repo_run_id, state);
    this.idempotency.set(event.idempotency_key, event);
    this.eventIds.set(event.event_id, event);
  }

  private restore(): void {
    if (this.file === null || !existsSync(this.file)) return;
    try {
      if (!lstatSync(this.file).isFile()) { this.failReplay("invalid_event", "repository lifecycle journal is not a regular file"); return; }
      const content = readFileSync(this.file, "utf8");
      const lines = content.split("\n");
      if (lines.at(-1) === "") lines.pop();
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        let parsed: unknown;
        try { parsed = JSON.parse(line); }
        catch { this.failReplay("malformed_line", "repository lifecycle journal contains malformed JSON", index + 1); return; }
        if (!validStoredEvent(parsed)) { this.failReplay("invalid_event", "repository lifecycle journal contains an invalid event", index + 1); return; }
        const event = parsed;
        const expectedSequence = this.journal.length + 1;
        const expectedPrevious = this.journal.at(-1)?.event_hash ?? null;
        const { event_hash, ...withoutHash } = event;
        if (event.sequence !== expectedSequence || event.previous_hash !== expectedPrevious || sha256(withoutHash) !== event_hash) {
          this.failReplay("broken_hash_chain", "repository lifecycle journal hash chain is invalid", index + 1); return;
        }
        if (this.idempotency.has(event.idempotency_key) || this.eventIds.has(event.event_id)) {
          this.failReplay("invalid_event", "repository lifecycle journal reuses an event identity", index + 1); return;
        }
        let state: RepoFlightRunState;
        try { state = reduceRepoFlightEvent(this.runs.get(event.payload.repo_run_id), event); }
        catch { this.failReplay("reduction_failed", "repository lifecycle journal cannot be deterministically reduced", index + 1); return; }
        this.accept(event, state);
      }
    } catch {
      this.failReplay("invalid_event", "repository lifecycle journal is unreadable");
    }
  }

  private failReplay(code: RepoFlightReplayDiagnostic["code"], message: string, line?: number): void {
    this.corrupt = true;
    this.diagnostics.push(Object.freeze({ code, message, ...(line === undefined ? {} : { line }) }));
  }

  private persist(events: readonly RepoFlightEvent[]): "ok" | "stale" | "failed" {
    if (this.file === null) return "ok";
    let temporary: string | null = null;
    let lock: string | null = null;
    let lockFd: number | null = null;
    let lockOwned = false;
    try {
      const directory = dirname(this.file);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory()) return "failed";
      chmodSync(directory, 0o700);
      // A single writer is elected mechanically for the complete compare and
      // replace. A crashed writer leaves the lock behind and therefore fails
      // closed for explicit operator recovery rather than guessing liveness.
      lock = `${this.file}.lock`;
      lockFd = openSync(lock, "wx", 0o600);
      lockOwned = true;
      writeFileSync(lockFd, `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, "utf8");
      fsyncSync(lockFd);
      const expected = this.journal.length === 0 ? "" : `${this.journal.map((event) => stableJson(event)).join("\n")}\n`;
      const observed = existsSync(this.file) ? readFileSync(this.file, "utf8") : "";
      if (observed !== expected) return "stale";
      temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      const bytes = `${events.map((event) => stableJson(event)).join("\n")}\n`;
      writeFileSync(temporary, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const temporaryFd = openSync(temporary, "r");
      try { fsyncSync(temporaryFd); } finally { closeSync(temporaryFd); }
      renameSync(temporary, this.file); temporary = null;
      chmodSync(this.file, 0o600);
      const directoryFd = openSync(directory, "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      return "ok";
    } catch {
      this.diagnostics.push(Object.freeze({ code: "write_failed", message: "repository lifecycle journal append failed" }));
      return "failed";
    } finally {
      if (lockFd !== null) { try { closeSync(lockFd); lockFd = null; } catch { /* preserve the fail-closed lock if close is uncertain */ } }
      if (lockOwned && lockFd === null && lock !== null && existsSync(lock)) { try { unlinkSync(lock); } catch { /* a retained lock fails closed */ } }
      if (temporary !== null && existsSync(temporary)) { try { unlinkSync(temporary); } catch { /* retain a bounded diagnostic above */ } }
    }
  }
}

function validEventInput(value: unknown): value is RepoFlightEventInput {
  if (!recordWithKeys(value, ["event_id", "idempotency_key", "occurred_at", "body"])) return false;
  return isRepoFlightId(value.event_id) && isRepoFlightId(value.idempotency_key) && validTimestamp(value.occurred_at) && validBody(value.body);
}

function validBody(value: unknown): value is RepoFlightEventBody {
  if (!recordWithKeys(value, ["kind", "payload"]) || typeof value.kind !== "string") return false;
  if (value.kind === "repo_run.created") return validCreated(value.payload);
  if (value.kind === "repo_run.governance_attempted") return validGovernanceAttempt(value.payload);
  if (value.kind === "repo_run.transitioned") return validTransition(value.payload);
  return false;
}

function validCreated(value: unknown): value is RepoFlightCreatedPayload {
  return recordWithKeys(value, ["repo_run_id", "repository", "base_oid", "operation_id", "correlation_id", "work_class", "input_digest", "scope_digest", "workspace_lineage_digest", "profile_version", "policy_version", "proposer_identity"])
    && isRepoFlightId(value.repo_run_id) && validRepository(value.repository) && isRepoFlightGitOid(value.base_oid)
    && isRepoFlightId(value.operation_id) && isRepoFlightId(value.correlation_id) && REPO_FLIGHT_WORK_CLASSES.includes(value.work_class as never)
    && isRepoFlightDigest(value.input_digest) && isRepoFlightDigest(value.scope_digest) && isRepoFlightDigest(value.workspace_lineage_digest)
    && isRepoFlightId(value.profile_version) && isRepoFlightId(value.policy_version) && isRepoFlightId(value.proposer_identity);
}

function validGovernanceAttempt(value: unknown): value is RepoFlightGovernanceAttemptPayload {
  return recordWithKeys(value, ["repo_run_id", "expected_revision", "attempt_id", "attestation_id", "attestation_digest", "issuer_identity", "key_id", "verified_at", "expires_at", "outcome", "refusal_code", "attestation"])
    && isRepoFlightId(value.repo_run_id) && Number.isSafeInteger(value.expected_revision) && (value.expected_revision as number) >= 0
    && isRepoFlightId(value.attempt_id) && isRepoFlightId(value.attestation_id) && isRepoFlightDigest(value.attestation_digest)
    && isRepoFlightId(value.issuer_identity) && isRepoFlightId(value.key_id) && validTimestamp(value.verified_at) && validTimestamp(value.expires_at)
    && (value.outcome === "verified" || value.outcome === "refused")
    && ((value.outcome === "verified" && value.refusal_code === null && validStoredAttestation(value.attestation, value.attestation_digest)) || (value.outcome === "refused" && isRepoFlightId(value.refusal_code) && value.attestation === null));
}

function validStoredAttestation(value: unknown, expectedDigest: `sha256:${string}`): boolean {
  try { return typeof value === "object" && value !== null && governanceAdmissionAttestationDigest(value as never) === expectedDigest; }
  catch { return false; }
}

function validRepository(value: unknown): value is RepoFlightRunRepositoryIdentity {
  return recordWithKeys(value, ["repository_id", "git_common_dir", "worktree_root", "canonical_remote"])
    && isRepoFlightRepositoryId(value.repository_id) && typeof value.git_common_dir === "string" && isAbsolute(value.git_common_dir)
    && typeof value.worktree_root === "string" && isAbsolute(value.worktree_root)
    && (value.canonical_remote === null || (typeof value.canonical_remote === "string" && value.canonical_remote.length > 0 && value.canonical_remote.length <= 4_096));
}

function validTransition(value: unknown): value is RepoFlightTransitionPayload {
  if (!recordWithKeys(value, ["repo_run_id", "expected_revision", "from", "to"], ["bindings"])) return false;
  return isRepoFlightId(value.repo_run_id) && Number.isSafeInteger(value.expected_revision) && (value.expected_revision as number) >= 0
    && isRepoFlightPhase(value.from) && isRepoFlightPhase(value.to)
    && (value.bindings === undefined || validPatch(value.bindings));
}

const PATCH_KEYS = ["active_governance_attempt_id", "governance_attestation_digest", "session_id", "worktree_id", "worktree_path", "lease_id", "fence_token", "candidate_oid", "tree_digest", "gate_attempt_id", "evidence_ref", "approval_ref", "adoption_ref"] as const;
function validPatch(value: unknown): value is RepoFlightBindingPatch {
  if (!recordWithKeys(value, [], PATCH_KEYS)) return false;
  if (Object.keys(value).length === 0) return false;
  for (const key of ["active_governance_attempt_id", "session_id", "worktree_id", "lease_id", "gate_attempt_id", "evidence_ref", "approval_ref", "adoption_ref"] as const) if (value[key] !== undefined && !isRepoFlightId(value[key])) return false;
  return (value.worktree_path === undefined || (typeof value.worktree_path === "string" && isAbsolute(value.worktree_path)))
    && (value.governance_attestation_digest === undefined || isRepoFlightDigest(value.governance_attestation_digest))
    && (value.fence_token === undefined || (Number.isSafeInteger(value.fence_token) && (value.fence_token as number) > 0))
    && (value.candidate_oid === undefined || isRepoFlightGitOid(value.candidate_oid))
    && (value.tree_digest === undefined || isRepoFlightDigest(value.tree_digest));
}

function validStoredEvent(value: unknown): value is RepoFlightEvent {
  if (!recordWithKeys(value, ["version", "sequence", "event_id", "idempotency_key", "occurred_at", "previous_hash", "event_hash", "kind", "payload"])) return false;
  if (value.version !== 1 || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || !isRepoFlightId(value.event_id) || !isRepoFlightId(value.idempotency_key) || !validTimestamp(value.occurred_at)) return false;
  if (!(value.previous_hash === null || isRepoFlightDigest(value.previous_hash)) || !isRepoFlightDigest(value.event_hash)) return false;
  return validBody({ kind: value.kind, payload: value.payload });
}

function recordWithKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function validTimestamp(value: unknown): value is string { return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value)); }
function failure(code: Extract<RepoFlightAppendResult, { ok: false }>["code"], reason: string): RepoFlightAppendResult { return { ok: false, code, reason }; }
function semanticInput(event: RepoFlightEvent): string {
  return stableJson({ event_id: event.event_id, idempotency_key: event.idempotency_key, occurred_at: event.occurred_at, body: { kind: event.kind, payload: event.payload } });
}
function sha256(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`; }
function stableJson(value: unknown): string { return JSON.stringify(sortJson(value)); }
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
}
