import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireWriterLock, canonicalizeForHash, type WriterLockHandle } from "@arbor/core";
import { verifyApprovedAuthority, type ApprovalRecord } from "./approval-service.js";
import { REPO_FLIGHT_RESOURCE_KINDS, RepoFlightAuthority, type RepoFlightCandidateBinding, type RepoFlightResource, type RepoFlightResourceKind } from "./repo-flight-authority.js";

export type RepoFlightEffectStatus = "prepared" | "authorized" | "dispatched" | "applied" | "no_effect" | "ambiguous" | "rejected";
export type RepoFlightTerminalEffectStatus = Extract<RepoFlightEffectStatus, "applied" | "no_effect" | "ambiguous" | "rejected">;

export interface RepoFlightEffectRequest {
  readonly transaction_id: string;
  readonly idempotency_key: string;
  readonly repo_run_id: string;
  readonly instance_id: string;
  readonly clearance_token: string;
  readonly operation: RepoFlightResourceKind;
  readonly resources: readonly RepoFlightResource[];
  readonly candidate: RepoFlightCandidateBinding;
  readonly effect_digest: `sha256:${string}`;
  readonly policy_version: string;
  readonly approval_id: string | null;
  readonly approval_required: boolean;
}

export interface RepoFlightEffectRecord {
  readonly schema_version: 1;
  readonly transaction_id: string;
  readonly idempotency_key: string;
  readonly request_fingerprint: `sha256:${string}`;
  readonly repo_run_id: string;
  readonly instance_id: string;
  readonly operation: RepoFlightResourceKind;
  readonly resources: readonly RepoFlightResource[];
  readonly candidate: RepoFlightCandidateBinding;
  readonly effect_digest: `sha256:${string}`;
  readonly policy_version: string;
  readonly approval_id: string | null;
  readonly approval_required: boolean;
  readonly status: RepoFlightEffectStatus;
  readonly prepared_at: string;
  readonly updated_at: string;
  readonly authorization_receipt: `sha256:${string}` | null;
  readonly governance_attestation_digest: `sha256:${string}` | null;
  readonly result_digest: `sha256:${string}` | null;
  readonly post_candidate: RepoFlightCandidateBinding | null;
  readonly terminal_reason: string | null;
  readonly reconciled_by: string | null;
}

export interface RepoFlightEffectCallbackResult {
  readonly outcome: "applied" | "no_effect" | "ambiguous";
  readonly result_digest: `sha256:${string}`;
}

export type RepoFlightEffectExecutionResult =
  | { readonly ok: true; readonly record: RepoFlightEffectRecord; readonly idempotent: boolean }
  | { readonly ok: false; readonly code: "invalid" | "conflict" | "approval_required" | "unauthorized" | "candidate_changed" | "ambiguous"; readonly summary: string; readonly record?: RepoFlightEffectRecord };

export interface RepoFlightEffectExecutorOptions {
  readonly persistence_dir: string;
  readonly authority: RepoFlightAuthority;
  readonly approval_lookup: (approvalId: string) => ApprovalRecord | null;
  readonly candidate_probe: (baseOid?: string) => RepoFlightCandidateBinding;
  readonly now?: () => Date;
}

interface EffectState { readonly schema_version: 1; records: RepoFlightEffectRecord[]; idempotency: Record<string, { fingerprint: `sha256:${string}`; transaction_id: string }> }

/**
 * Durable effect closure around the authority's final commit-time decision.
 * The external callback is invoked only after approval, candidate, policy and
 * fence checks. A crash after durable dispatch is never retried automatically.
 */
export class RepoFlightEffectExecutor {
  private readonly path: string;
  private readonly lock: WriterLockHandle;
  private readonly now: () => Date;
  private state: EffectState;
  private closed = false;

  constructor(private readonly options: RepoFlightEffectExecutorOptions) {
    mkdirSync(options.persistence_dir, { recursive: true });
    const acquired = acquireWriterLock(options.persistence_dir, { holder: "repo-flight-effects" });
    if (!acquired.ok) throw new Error(acquired.detail);
    this.lock = acquired.lock;
    this.path = join(options.persistence_dir, "repo-flight-effects.json");
    this.now = options.now ?? (() => new Date());
    try {
      this.state = this.restore();
      let recovered = false;
      for (const record of [...this.state.records]) {
        if (record.status === "prepared" && this.options.authority.effectAuthorization(record.transaction_id, record.request_fingerprint) !== null) { this.replace(record.transaction_id, { status: "no_effect", terminal_reason: "recovered after durable authorization but before durable dispatch", updated_at: this.timestamp() }, false); recovered = true; }
        if (record.status === "authorized") { this.replace(record.transaction_id, { status: "no_effect", terminal_reason: "recovered before durable dispatch", updated_at: this.timestamp() }, false); recovered = true; }
        if (record.status === "dispatched") { this.replace(record.transaction_id, { status: "ambiguous", terminal_reason: "controller restarted after durable dispatch without a terminal receipt", updated_at: this.timestamp() }, false); recovered = true; }
      }
      if (recovered) this.persist();
    } catch (error) { this.lock.release(); throw error; }
  }

  close(): void { if (!this.closed) { this.closed = true; this.lock.release(); } }

  execute(input: RepoFlightEffectRequest, effect: () => RepoFlightEffectCallbackResult): RepoFlightEffectExecutionResult {
    this.assertOpen();
    const normalized = normalizeRequest(input);
    if (!normalized.ok) return normalized;
    const request = normalized.value;
    const fingerprint = digest({ ...request, clearance_token: digest(request.clearance_token) });
    const prior = this.state.idempotency[request.idempotency_key];
    let record: RepoFlightEffectRecord;
    if (prior) {
      if (prior.fingerprint !== fingerprint) return { ok: false, code: "conflict", summary: "effect idempotency key was reused with different content" };
      record = this.required(prior.transaction_id);
      if (record.status === "applied" || record.status === "no_effect") return { ok: true, record: clone(record), idempotent: true };
      if (record.status === "rejected") return { ok: false, code: "unauthorized", summary: record.terminal_reason ?? "effect was rejected", record: clone(record) };
      if (record.status === "ambiguous") return { ok: false, code: "ambiguous", summary: "effect outcome requires certified reconciliation before retry", record: clone(record) };
    } else {
      if (this.state.records.some((candidate) => candidate.transaction_id === request.transaction_id)) return { ok: false, code: "conflict", summary: "effect transaction id is already used" };
      const now = this.timestamp();
      record = freeze({ schema_version: 1, transaction_id: request.transaction_id, idempotency_key: request.idempotency_key, request_fingerprint: fingerprint, repo_run_id: request.repo_run_id, instance_id: request.instance_id, operation: request.operation, resources: request.resources, candidate: request.candidate, effect_digest: request.effect_digest, policy_version: request.policy_version, approval_id: request.approval_id, approval_required: request.approval_required, status: "prepared", prepared_at: now, updated_at: now, authorization_receipt: null, governance_attestation_digest: null, result_digest: null, post_candidate: null, terminal_reason: null, reconciled_by: null });
      this.state.records.push(record);
      this.state.idempotency[request.idempotency_key] = { fingerprint, transaction_id: request.transaction_id };
      this.persist();
    }

    const approval = this.verifyApproval(request);
    if (!approval.ok) return this.reject(record, approval.code, approval.summary);
    const before = this.options.candidate_probe(request.candidate.base_oid);
    if (!candidateEqual(before, request.candidate)) return this.reject(record, "candidate_changed", "repository candidate changed before effect authorization");
    const authorized = this.options.authority.authorizeEffect({ authorization_id: request.transaction_id, request_fingerprint: fingerprint, token: request.clearance_token, repo_run_id: request.repo_run_id, instance_id: request.instance_id, operation: request.operation, resources: request.resources, candidate: before, effect_digest: request.effect_digest, policy_version: request.policy_version, approval_id: request.approval_id });
    if (!authorized.ok) return this.reject(record, authorized.code === "candidate_changed" ? "candidate_changed" : "unauthorized", authorized.summary);
    record = this.replace(record.transaction_id, { status: "authorized", authorization_receipt: authorized.receipt_digest, governance_attestation_digest: authorized.governance_attestation_digest, updated_at: this.timestamp() });
    record = this.replace(record.transaction_id, { status: "dispatched", updated_at: this.timestamp() });
    let result: RepoFlightEffectCallbackResult;
    try { result = effect(); }
    catch (error) {
      const summary = error instanceof Error ? error.message : "effect callback threw after dispatch";
      const ambiguous = this.replace(record.transaction_id, { status: "ambiguous", terminal_reason: boundedReason(summary), post_candidate: this.safeProbe(record.candidate.base_oid), updated_at: this.timestamp() });
      return { ok: false, code: "ambiguous", summary: "effect callback failed after durable dispatch", record: clone(ambiguous) };
    }
    if (!validCallbackResult(result)) {
      const ambiguous = this.replace(record.transaction_id, { status: "ambiguous", terminal_reason: "effect callback returned an invalid terminal receipt", post_candidate: this.safeProbe(record.candidate.base_oid), updated_at: this.timestamp() });
      return { ok: false, code: "ambiguous", summary: ambiguous.terminal_reason!, record: clone(ambiguous) };
    }
    const terminal = this.replace(record.transaction_id, { status: result.outcome, result_digest: result.result_digest, post_candidate: this.safeProbe(record.candidate.base_oid), terminal_reason: result.outcome === "ambiguous" ? "effect provider reported an ambiguous outcome" : null, updated_at: this.timestamp() });
    return result.outcome === "ambiguous" ? { ok: false, code: "ambiguous", summary: terminal.terminal_reason!, record: clone(terminal) } : { ok: true, record: clone(terminal), idempotent: false };
  }

  reconcile(input: { readonly transaction_id: string; readonly outcome: "applied" | "no_effect"; readonly result_digest: `sha256:${string}`; readonly certified_by: string }): RepoFlightEffectExecutionResult {
    this.assertOpen();
    if (!bounded(input.transaction_id, 256) || !bounded(input.certified_by, 256) || !exactDigest(input.result_digest)) return { ok: false, code: "invalid", summary: "effect reconciliation certificate is malformed" };
    const record = this.state.records.find((candidate) => candidate.transaction_id === input.transaction_id);
    if (!record) return { ok: false, code: "invalid", summary: "effect transaction was not found" };
    if (record.status !== "ambiguous") return { ok: false, code: "conflict", summary: `effect transaction is ${record.status}, not ambiguous`, record: clone(record) };
    const reconciled = this.replace(record.transaction_id, { status: input.outcome, result_digest: input.result_digest, reconciled_by: input.certified_by, post_candidate: this.safeProbe(record.candidate.base_oid), terminal_reason: `certified ${input.outcome}`, updated_at: this.timestamp() });
    return { ok: true, record: clone(reconciled), idempotent: false };
  }

  inspect(): readonly RepoFlightEffectRecord[] { this.assertOpen(); return Object.freeze(this.state.records.map(clone)); }

  private verifyApproval(request: RepoFlightEffectRequest): { ok: true } | { ok: false; code: "approval_required" | "unauthorized"; summary: string } {
    if (!request.approval_required) return request.approval_id === null ? { ok: true } : { ok: false, code: "unauthorized", summary: "unrequired approvals cannot be attached to an effect" };
    if (request.approval_id === null) return { ok: false, code: "approval_required", summary: "effect requires a distinct durable approval" };
    const fence = this.options.authority.approvalFence({ token: request.clearance_token, repo_run_id: request.repo_run_id, instance_id: request.instance_id, candidate: request.candidate, policy_version: request.policy_version, approval_id: request.approval_id });
    if (!fence.ok) return { ok: false, code: "unauthorized", summary: fence.summary };
    const verified = verifyApprovedAuthority(this.options.approval_lookup(request.approval_id), { action: "permission.grant", resource_id: approvalResourceId(request, fence.fence_digest), policy_version: request.policy_version, actor: request.instance_id, session_id: request.repo_run_id }, this.timestamp());
    return verified.ok ? { ok: true } : { ok: false, code: "unauthorized", summary: verified.error };
  }

  private reject(record: RepoFlightEffectRecord, code: "approval_required" | "unauthorized" | "candidate_changed", summary: string): RepoFlightEffectExecutionResult {
    const rejected = this.replace(record.transaction_id, { status: "rejected", terminal_reason: boundedReason(summary), updated_at: this.timestamp() });
    return { ok: false, code, summary, record: clone(rejected) };
  }

  private safeProbe(baseOid?: string): RepoFlightCandidateBinding | null { try { const value = this.options.candidate_probe(baseOid); return candidateValid(value) ? Object.freeze({ ...value }) : null; } catch { return null; } }
  private timestamp(): string { return this.now().toISOString(); }
  private required(id: string): RepoFlightEffectRecord { const record = this.state.records.find((candidate) => candidate.transaction_id === id); if (!record) throw new Error("effect idempotency record references a missing transaction"); return record; }
  private replace(id: string, patch: Partial<RepoFlightEffectRecord>, persist = true): RepoFlightEffectRecord { const index = this.state.records.findIndex((candidate) => candidate.transaction_id === id); if (index < 0) throw new Error("effect transaction disappeared"); const updated = freeze({ ...this.state.records[index]!, ...patch }); this.state.records[index] = updated; if (persist) this.persist(); return updated; }
  private restore(): EffectState { if (!existsSync(this.path)) return { schema_version: 1, records: [], idempotency: {} }; const value: unknown = JSON.parse(readFileSync(this.path, "utf8")); if (!validState(value)) throw new Error("repo flight effect state is malformed"); return value; }
  private persist(): void { durableWrite(this.path, `${canonicalizeForHash(this.state)}\n`); }
  private assertOpen(): void { if (this.closed) throw new Error("repo flight effect executor is closed"); }
}

export function approvalResourceId(
  request: Pick<RepoFlightEffectRequest, "repo_run_id" | "instance_id" | "operation" | "resources" | "candidate" | "effect_digest" | "policy_version">,
  fenceDigest: `sha256:${string}`,
): string {
  if (!exactDigest(fenceDigest)) throw new Error("approval fence digest is malformed");
  return `repo-flight-effect:v2:${digest({ repo_run_id: request.repo_run_id, instance_id: request.instance_id, operation: request.operation, resources: request.resources, candidate: request.candidate, effect_digest: request.effect_digest, policy_version: request.policy_version, fence_digest: fenceDigest })}`;
}

function normalizeRequest(input: RepoFlightEffectRequest): { ok: true; value: RepoFlightEffectRequest } | { ok: false; code: "invalid"; summary: string } {
  if (![input.transaction_id, input.idempotency_key, input.repo_run_id, input.instance_id, input.policy_version].every((value) => bounded(value, 256)) || !REPO_FLIGHT_RESOURCE_KINDS.includes(input.operation) || !exactDigest(input.effect_digest) || typeof input.approval_required !== "boolean" || (input.approval_id !== null && !bounded(input.approval_id, 256)) || !candidateValid(input.candidate) || !Array.isArray(input.resources) || input.resources.length < 1 || input.resources.length > 128 || input.resources.some((resource) => !validResource(resource))) return { ok: false, code: "invalid", summary: "effect request is malformed or oversized" };
  return { ok: true, value: Object.freeze({ ...input, resources: Object.freeze(input.resources.map((resource) => Object.freeze({ ...resource }))), candidate: Object.freeze({ ...input.candidate }) }) };
}
function validState(value: unknown): value is EffectState {
  if (!record(value) || value.schema_version !== 1 || !Array.isArray(value.records) || value.records.some((entry) => !validRecord(entry)) || !record(value.idempotency) || Object.values(value.idempotency).some((entry) => !record(entry) || !exactDigest(entry.fingerprint) || !bounded(entry.transaction_id, 256))) return false;
  const records = value.records as RepoFlightEffectRecord[];
  if (new Set(records.map((entry) => entry.transaction_id)).size !== records.length || new Set(records.map((entry) => entry.idempotency_key)).size !== records.length) return false;
  return Object.entries(value.idempotency).every(([key, entry]) => records.some((candidate) => candidate.idempotency_key === key && candidate.transaction_id === entry.transaction_id && candidate.request_fingerprint === entry.fingerprint));
}
function validRecord(value: unknown): value is RepoFlightEffectRecord { return record(value) && value.schema_version === 1 && bounded(value.transaction_id, 256) && bounded(value.idempotency_key, 256) && exactDigest(value.request_fingerprint) && bounded(value.repo_run_id, 256) && bounded(value.instance_id, 256) && bounded(value.policy_version, 256) && REPO_FLIGHT_RESOURCE_KINDS.includes(value.operation) && exactDigest(value.effect_digest) && candidateValid(value.candidate) && Array.isArray(value.resources) && value.resources.length >= 1 && value.resources.length <= 128 && value.resources.every(validResource) && typeof value.approval_required === "boolean" && (value.approval_id === null || bounded(value.approval_id, 256)) && ["prepared", "authorized", "dispatched", "applied", "no_effect", "ambiguous", "rejected"].includes(value.status) && typeof value.prepared_at === "string" && !Number.isNaN(Date.parse(value.prepared_at)) && typeof value.updated_at === "string" && !Number.isNaN(Date.parse(value.updated_at)) && (value.authorization_receipt === null || exactDigest(value.authorization_receipt)) && (value.governance_attestation_digest === null || exactDigest(value.governance_attestation_digest)) && (value.result_digest === null || exactDigest(value.result_digest)) && (value.post_candidate === null || candidateValid(value.post_candidate)) && (value.terminal_reason === null || bounded(value.terminal_reason, 1024)) && (value.reconciled_by === null || bounded(value.reconciled_by, 256)); }
function validResource(value: unknown): value is RepoFlightResource { if (!record(value) || !REPO_FLIGHT_RESOURCE_KINDS.includes(value.kind) || typeof value.key !== "string" || value.key.length < 1 || Buffer.byteLength(value.key) > 4096 || /[\0\r\n]/u.test(value.key)) return false; if (value.kind === "path.write") return (value.path_mode === undefined || value.path_mode === "exact" || value.path_mode === "subtree") && !value.key.startsWith("/") && !value.key.includes("\\") && !value.key.split("/").some((part: string) => part === "" || part === "." || part === ".."); return value.path_mode === undefined; }
function validCallbackResult(value: unknown): value is RepoFlightEffectCallbackResult { return record(value) && ["applied", "no_effect", "ambiguous"].includes(value.outcome) && exactDigest(value.result_digest); }
function candidateValid(value: unknown): value is RepoFlightCandidateBinding { return record(value) && gitOid(value.base_oid) && gitOid(value.head_oid) && exactDigest(value.tree_digest) && (value.index_digest === undefined || value.index_digest === null || exactDigest(value.index_digest)); }
function candidateEqual(left: RepoFlightCandidateBinding, right: RepoFlightCandidateBinding): boolean { return candidateValid(left) && candidateValid(right) && canonicalizeForHash(left) === canonicalizeForHash(right); }
function freeze(record: RepoFlightEffectRecord): RepoFlightEffectRecord { return Object.freeze({ ...record, resources: Object.freeze(record.resources.map((resource) => Object.freeze({ ...resource }))), candidate: Object.freeze({ ...record.candidate }), post_candidate: record.post_candidate ? Object.freeze({ ...record.post_candidate }) : null }); }
function clone(record: RepoFlightEffectRecord): RepoFlightEffectRecord { return structuredClone(record); }
function digest(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(canonicalizeForHash(value)).digest("hex")}`; }
function exactDigest(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function gitOid(value: unknown): value is string { return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max && !/[\0\r\n]/u.test(value); }
function boundedReason(value: string): string { return value.normalize("NFC").slice(0, 1024); }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function durableWrite(path: string, content: string): void { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`; const file = openSync(temporary, "wx", 0o600); try { writeFileSync(file, content, "utf8"); fsyncSync(file); } finally { closeSync(file); } renameSync(temporary, path); const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); } }
