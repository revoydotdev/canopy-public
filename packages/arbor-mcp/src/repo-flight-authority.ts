import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalizeForHash, type WriterLockHandle, acquireWriterLock } from "@arbor/core";

export const REPO_FLIGHT_MAX_TTL_MS = 86_400_000;
export const REPO_FLIGHT_MAX_RESOURCES = 128;
export const REPO_FLIGHT_MAX_OPERATIONS = 32;

export const REPO_FLIGHT_RESOURCE_KINDS = [
  "path.write",
  "git.index",
  "git.ref",
  "git.head",
  "git.stash",
  "git.worktree.admin",
  "dependency.lockfile",
  "evidence.produce",
  "evidence.publish",
  "gate.snapshot",
  "gate.quiescence",
  "result.adopt",
  "repository.push",
] as const;

export type RepoFlightResourceKind = typeof REPO_FLIGHT_RESOURCE_KINDS[number];
export type RepoFlightPathMode = "exact" | "subtree";

export interface RepoFlightResource {
  readonly kind: RepoFlightResourceKind;
  readonly key: string;
  readonly path_mode?: RepoFlightPathMode;
}

export interface RepoFlightCandidateBinding {
  readonly base_oid: string;
  readonly head_oid: string;
  readonly tree_digest: `sha256:${string}`;
  readonly index_digest?: `sha256:${string}` | null;
}

export interface RepoFlightClearanceRequest {
  readonly request_id: string;
  readonly repo_run_id: string;
  readonly instance_id: string;
  readonly principal_chain: readonly string[];
  readonly operations: readonly RepoFlightResourceKind[];
  readonly resources: readonly RepoFlightResource[];
  readonly candidate: RepoFlightCandidateBinding;
  readonly policy_version: string;
  readonly ttl_ms: number;
  readonly max_uses: number;
  readonly approval_id?: string | null;
}

export interface RepoFlightResourceFence {
  readonly resource_id: string;
  readonly fencing_epoch: number;
  readonly resource_version: number;
}

export type RepoFlightDrainStatus = "draining" | "quiesced" | "released" | "expired";

export interface RepoFlightDrainRecord {
  readonly schema_version: 1;
  readonly drain_id: string;
  readonly request_id: string;
  readonly repo_run_id: string;
  readonly instance_id: string;
  readonly repository_id: string;
  readonly candidate: RepoFlightCandidateBinding;
  readonly requested_at: string;
  readonly expires_at: string;
  readonly status: RepoFlightDrainStatus;
  readonly blocker_grant_ids: readonly string[];
  readonly blocker_instance_ids: readonly string[];
  readonly acknowledged_instance_ids: readonly string[];
  readonly fencing_epoch: number;
  readonly resource_version: number;
  readonly terminal_reason: string | null;
}

export type RepoFlightDrainResult =
  | { readonly ok: true; readonly drain: RepoFlightDrainRecord; readonly token: string; readonly idempotent: boolean }
  | { readonly ok: false; readonly code: "invalid" | "conflict" | "not_ready" | "candidate_changed" | "unauthorized"; readonly summary: string; readonly blockers?: readonly string[] };

export type RepoFlightClearanceStatus = "active" | "released" | "revoked" | "expired";

export interface RepoFlightClearanceRecord {
  readonly schema_version: 1;
  readonly grant_id: string;
  readonly request_id: string;
  readonly request_fingerprint: `sha256:${string}`;
  readonly repository_id: string;
  readonly repo_run_id: string;
  readonly instance_id: string;
  readonly principal_chain: readonly string[];
  readonly operations: readonly RepoFlightResourceKind[];
  readonly resources: readonly RepoFlightResource[];
  readonly candidate: RepoFlightCandidateBinding;
  readonly policy_version: string;
  readonly governance_attestation_digest: `sha256:${string}`;
  readonly approval_id: string | null;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly max_uses: number;
  readonly uses: number;
  readonly status: RepoFlightClearanceStatus;
  readonly terminal_reason: string | null;
  readonly fences: readonly RepoFlightResourceFence[];
  readonly sequence: number;
}

export type RepoFlightClearanceResult =
  | { readonly ok: true; readonly token: string; readonly grant: RepoFlightClearanceRecord; readonly idempotent: boolean }
  | { readonly ok: false; readonly code: "invalid" | "conflict" | "capacity"; readonly summary: string; readonly blocked_by?: readonly string[] };

export type RepoFlightEffectResult =
  | { readonly ok: true; readonly grant: RepoFlightClearanceRecord; readonly use_number: number; readonly receipt_digest: `sha256:${string}`; readonly governance_attestation_digest: `sha256:${string}` }
  | { readonly ok: false; readonly code: "invalid" | "unauthorized" | "expired" | "fence_rejected" | "candidate_changed" | "exhausted"; readonly summary: string };

export type RepoFlightApprovalFenceResult =
  | { readonly ok: true; readonly fence_digest: `sha256:${string}`; readonly fences: readonly RepoFlightResourceFence[] }
  | { readonly ok: false; readonly summary: string };

interface StoredRequest {
  readonly fingerprint: `sha256:${string}`;
  readonly grant_id: string;
}

interface StoredEffectAuthorization {
  readonly fingerprint: `sha256:${string}`;
  readonly request_fingerprint: `sha256:${string}`;
  readonly grant_id: string;
  readonly use_number: number;
  readonly receipt_digest: `sha256:${string}`;
}

interface RepoFlightAuthorityState {
  readonly schema_version: 1;
  readonly repository_id: string;
  policy_version: string;
  sequence: number;
  resource_epochs: Record<string, number>;
  resource_versions: Record<string, number>;
  grants: RepoFlightClearanceRecord[];
  drains: RepoFlightDrainRecord[];
  quiescence_epoch: number;
  quiescence_version: number;
  requests: Record<string, StoredRequest>;
  drain_requests: Record<string, { readonly fingerprint: `sha256:${string}`; readonly drain_id: string }>;
  renewals: Record<string, { readonly fingerprint: `sha256:${string}`; readonly grant_id: string }>;
  effect_authorizations: Record<string, StoredEffectAuthorization>;
}

export interface RepoFlightAuthorityOptions {
  readonly persistence_dir: string;
  readonly repository_id: string;
  readonly policy_version: string;
  readonly signing_secret: string;
  readonly now?: () => Date;
  readonly grant_id?: () => string;
  readonly pid?: number;
  /** Runtime-owned identity admission. Omit only for isolated authority tests. */
  readonly holder_admission?: (repoRunId: string, instanceId: string, candidate?: RepoFlightCandidateBinding) => { readonly ok: boolean; readonly summary: string; readonly governance_attestation_digest?: `sha256:${string}` };
}

export class RepoFlightAuthority {
  private readonly path: string;
  private readonly lock: WriterLockHandle;
  private readonly now: () => Date;
  private readonly grantId: () => string;
  private state: RepoFlightAuthorityState;
  private closed = false;

  constructor(private readonly options: RepoFlightAuthorityOptions) {
    if (!boundedId(options.repository_id, 128)) throw new Error("repository_id must be a canonical bounded identifier");
    if (!boundedId(options.policy_version, 128)) throw new Error("policy_version must be a canonical bounded identifier");
    if (Buffer.byteLength(options.signing_secret) < 32 || Buffer.byteLength(options.signing_secret) > 4096) throw new Error("flight authority signing secret must be 32 through 4096 bytes");
    mkdirSync(options.persistence_dir, { recursive: true });
    const lock = acquireWriterLock(options.persistence_dir, { holder: `repo-flight:${options.repository_id}`, pid: options.pid });
    if (!lock.ok) throw new Error(`repo flight authority unavailable: ${lock.detail}`);
    this.lock = lock.lock;
    this.path = join(options.persistence_dir, "repo-flight-authority.json");
    this.now = options.now ?? (() => new Date());
    this.grantId = options.grant_id ?? (() => `clearance:${randomUUID()}`);
    try {
      this.state = this.restore();
      if (this.state.repository_id !== options.repository_id) throw new Error("persisted flight authority belongs to a different repository");
      if (this.state.policy_version !== options.policy_version) {
        for (const grant of [...this.state.grants]) if (grant.status === "active") this.terminal(grant.grant_id, "revoked", "authority policy version changed");
        for (const drain of [...this.state.drains]) if (drain.status === "draining" || drain.status === "quiesced") {
          this.replaceDrain(drain.drain_id, { status: "released", resource_version: ++this.state.quiescence_version, terminal_reason: "authority policy version changed" });
          this.state.quiescence_epoch++;
          this.state.sequence++;
        }
        this.state.policy_version = options.policy_version;
      }
      this.expireDue(this.now());
      this.persist();
    } catch (error) {
      this.lock.release();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lock.release();
  }

  currentPolicyVersion(): string {
    this.assertOpen();
    return this.state.policy_version;
  }

  acquire(input: RepoFlightClearanceRequest): RepoFlightClearanceResult {
    this.assertOpen();
    const normalized = normalizeRequest(input);
    if (!normalized.ok) return normalized;
    const request = normalized.value;
    if (request.policy_version !== this.state.policy_version) return { ok: false, code: "conflict", summary: "clearance policy version is not current" };
    const holder = this.admitHolder(request.repo_run_id, request.instance_id);
    if (!holder.ok) return { ok: false, code: "conflict", summary: holder.summary };
    if (holder.governance_attestation_digest === undefined) return { ok: false, code: "conflict", summary: "holder admission did not bind a governance attestation" };
    const fingerprint = digest(request);
    const previous = this.state.requests[request.request_id];
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { ok: false, code: "conflict", summary: "clearance request id was reused with different content" };
      const grant = this.state.grants.find((candidate) => candidate.grant_id === previous.grant_id);
      if (!grant) return { ok: false, code: "invalid", summary: "clearance idempotency record references a missing grant" };
      return { ok: true, grant: cloneGrant(grant), token: this.token(grant), idempotent: true };
    }

    const now = this.now();
    this.expireDue(now);
    const activeDrain = this.state.drains.find((drain) => (drain.status === "draining" || drain.status === "quiesced") && request.resources.some((resource) => resource.kind !== "gate.snapshot"));
    if (activeDrain) {
      this.persist();
      return { ok: false, code: "conflict", summary: "repository is draining or quiesced for an admitted gate", blocked_by: [activeDrain.drain_id] };
    }
    const blockers = this.state.grants
      .filter((grant) => grant.status === "active" && grant.resources.some((held) => request.resources.some((wanted) => resourcesConflict(held, wanted))))
      .map((grant) => grant.grant_id)
      .sort();
    if (blockers.length > 0) {
      this.persist();
      return { ok: false, code: "conflict", summary: "requested resources are held by active clearances", blocked_by: blockers };
    }

    const grantId = this.grantId();
    if (!boundedId(grantId, 256)) return { ok: false, code: "invalid", summary: "grant id generator returned an invalid identifier" };
    const fences = request.resources.map((resource) => {
      const resourceId = canonicalResourceId(this.state.repository_id, resource);
      const fencingEpoch = increment(this.state.resource_epochs, resourceId);
      const resourceVersion = increment(this.state.resource_versions, resourceId);
      return Object.freeze({ resource_id: resourceId, fencing_epoch: fencingEpoch, resource_version: resourceVersion });
    });
    const sequence = ++this.state.sequence;
    const grant: RepoFlightClearanceRecord = Object.freeze({
      schema_version: 1,
      grant_id: grantId,
      request_id: request.request_id,
      request_fingerprint: fingerprint,
      repository_id: this.state.repository_id,
      repo_run_id: request.repo_run_id,
      instance_id: request.instance_id,
      principal_chain: Object.freeze([...request.principal_chain]),
      operations: Object.freeze([...request.operations]),
      resources: Object.freeze(request.resources.map((resource) => Object.freeze({ ...resource }))),
      candidate: Object.freeze({ ...request.candidate }),
      policy_version: request.policy_version,
      governance_attestation_digest: holder.governance_attestation_digest,
      approval_id: request.approval_id ?? null,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + request.ttl_ms).toISOString(),
      max_uses: request.max_uses,
      uses: 0,
      status: "active",
      terminal_reason: null,
      fences: Object.freeze(fences),
      sequence,
    });
    this.state.grants.push(grant);
    this.state.requests[request.request_id] = { fingerprint, grant_id: grant.grant_id };
    this.persist();
    return { ok: true, grant: cloneGrant(grant), token: this.token(grant), idempotent: false };
  }

  beginDrain(input: { readonly request_id: string; readonly drain_id: string; readonly repo_run_id: string; readonly instance_id: string; readonly candidate: RepoFlightCandidateBinding; readonly ttl_ms: number }): RepoFlightDrainResult {
    this.assertOpen();
    if (!boundedId(input.request_id, 256) || !boundedId(input.drain_id, 256) || !boundedId(input.repo_run_id, 256) || !boundedId(input.instance_id, 256) || !candidateValid(input.candidate) || !Number.isSafeInteger(input.ttl_ms) || input.ttl_ms < 1_000 || input.ttl_ms > REPO_FLIGHT_MAX_TTL_MS) return { ok: false, code: "invalid", summary: "quiescence drain request is malformed" };
    const normalized = Object.freeze({ ...input, candidate: Object.freeze({ ...input.candidate }) });
    const fingerprint = digest(normalized);
    const previous = this.state.drain_requests[input.request_id];
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { ok: false, code: "conflict", summary: "drain request id was reused with different content" };
      const drain = this.state.drains.find((candidate) => candidate.drain_id === previous.drain_id);
      if (!drain) return { ok: false, code: "invalid", summary: "drain idempotency record references a missing drain" };
      return { ok: true, drain: structuredClone(drain), token: this.drainToken(drain), idempotent: true };
    }
    const now = this.now();
    this.expireDue(now);
    const holder = this.admitHolder(input.repo_run_id, input.instance_id, input.candidate);
    if (!holder.ok || holder.governance_attestation_digest === undefined) return { ok: false, code: "unauthorized", summary: holder.summary };
    const other = this.state.drains.find((drain) => drain.status === "draining" || drain.status === "quiesced");
    if (other) return { ok: false, code: "conflict", summary: "another repository drain is active", blockers: [other.drain_id] };
    if (this.state.drains.some((drain) => drain.drain_id === input.drain_id)) return { ok: false, code: "conflict", summary: "drain id is already used" };
    const blockers = this.state.grants.filter((grant) => grant.status === "active" && grant.resources.some((resource) => resource.kind !== "gate.snapshot"));
    const drain: RepoFlightDrainRecord = Object.freeze({
      schema_version: 1,
      drain_id: input.drain_id,
      request_id: input.request_id,
      repo_run_id: input.repo_run_id,
      instance_id: input.instance_id,
      repository_id: this.state.repository_id,
      candidate: Object.freeze({ ...input.candidate }),
      requested_at: now.toISOString(),
      expires_at: new Date(now.getTime() + input.ttl_ms).toISOString(),
      status: "draining",
      blocker_grant_ids: Object.freeze(blockers.map((grant) => grant.grant_id).sort()),
      blocker_instance_ids: Object.freeze([...new Set(blockers.map((grant) => grant.instance_id))].sort()),
      acknowledged_instance_ids: Object.freeze([]),
      fencing_epoch: ++this.state.quiescence_epoch,
      resource_version: ++this.state.quiescence_version,
      terminal_reason: null,
    });
    this.state.drains.push(drain);
    this.state.drain_requests[input.request_id] = { fingerprint, drain_id: input.drain_id };
    this.state.sequence++;
    this.persist();
    return { ok: true, drain: structuredClone(drain), token: this.drainToken(drain), idempotent: false };
  }

  renew(input: { readonly request_id: string; readonly token: string; readonly repo_run_id: string; readonly instance_id: string; readonly candidate: RepoFlightCandidateBinding; readonly policy_version: string; readonly ttl_ms: number }): RepoFlightClearanceResult {
    this.assertOpen();
    if (!boundedId(input.request_id, 256) || !boundedId(input.repo_run_id, 256) || !boundedId(input.instance_id, 256) || !boundedId(input.policy_version, 128) || !candidateValid(input.candidate) || !Number.isSafeInteger(input.ttl_ms) || input.ttl_ms < 1_000 || input.ttl_ms > REPO_FLIGHT_MAX_TTL_MS) return { ok: false, code: "invalid", summary: "clearance renewal request is malformed" };
    const fingerprint = digest({ ...input, token: digest(input.token) });
    const previous = this.state.renewals[input.request_id];
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { ok: false, code: "conflict", summary: "renewal request id was reused with different content" };
      const restored = this.state.grants.find((grant) => grant.grant_id === previous.grant_id);
      if (!restored) return { ok: false, code: "invalid", summary: "renewal record references a missing clearance" };
      return { ok: true, token: this.token(restored), grant: cloneGrant(restored), idempotent: true };
    }
    const grant = this.grantForToken(input.token);
    if (!grant || grant.status !== "active") return { ok: false, code: "conflict", summary: "clearance renewal token is invalid or inactive" };
    const now = this.now();
    if (Date.parse(grant.expires_at) <= now.getTime()) { this.terminal(grant.grant_id, "expired", "clearance TTL elapsed"); return { ok: false, code: "conflict", summary: "expired clearance cannot be renewed" }; }
    const holder = this.admitHolder(input.repo_run_id, input.instance_id, input.candidate);
    if (!holder.ok) return { ok: false, code: "conflict", summary: holder.summary };
    if (holder.governance_attestation_digest === undefined || grant.governance_attestation_digest !== holder.governance_attestation_digest || grant.repo_run_id !== input.repo_run_id || grant.instance_id !== input.instance_id || grant.policy_version !== input.policy_version || this.state.policy_version !== input.policy_version || !candidateEqual(grant.candidate, input.candidate)) return { ok: false, code: "conflict", summary: "renewal identity, governance warrant, candidate, or policy binding changed" };
    if (grant.fences.some((fence) => this.state.resource_epochs[fence.resource_id] !== fence.fencing_epoch)) return { ok: false, code: "conflict", summary: "stale clearance fence cannot be renewed" };
    const updated = this.replaceGrant(grant.grant_id, { expires_at: new Date(now.getTime() + input.ttl_ms).toISOString(), sequence: ++this.state.sequence });
    this.state.renewals[input.request_id] = { fingerprint, grant_id: grant.grant_id };
    this.persist();
    return { ok: true, token: this.token(updated), grant: cloneGrant(updated), idempotent: false };
  }

  acknowledgeDrain(input: { readonly drain_id: string; readonly instance_id: string }): RepoFlightDrainResult {
    this.assertOpen();
    const drain = this.state.drains.find((candidate) => candidate.drain_id === input.drain_id);
    if (!drain || drain.status !== "draining") return { ok: false, code: "invalid", summary: "drain is absent or not awaiting acknowledgements" };
    if (!drain.blocker_instance_ids.includes(input.instance_id)) return { ok: false, code: "unauthorized", summary: "instance was not a blocker for this drain" };
    const acknowledged = [...new Set([...drain.acknowledged_instance_ids, input.instance_id])].sort();
    const updated = this.replaceDrain(drain.drain_id, { acknowledged_instance_ids: Object.freeze(acknowledged) });
    this.state.sequence++;
    this.persist();
    return { ok: true, drain: structuredClone(updated), token: this.drainToken(updated), idempotent: drain.acknowledged_instance_ids.includes(input.instance_id) };
  }

  activateQuiescence(input: { readonly drain_id: string; readonly token: string; readonly candidate: RepoFlightCandidateBinding }): RepoFlightDrainResult {
    this.assertOpen();
    const drain = this.drainForToken(input.token);
    if (!drain || drain.drain_id !== input.drain_id) return { ok: false, code: "unauthorized", summary: "drain token is invalid" };
    if (drain.status !== "draining") return { ok: false, code: "invalid", summary: `drain is ${drain.status}` };
    if (!candidateEqual(drain.candidate, input.candidate)) return { ok: false, code: "candidate_changed", summary: "repository candidate changed during drain" };
    const activeBlockers = drain.blocker_grant_ids.filter((grantId) => this.state.grants.some((grant) => grant.grant_id === grantId && grant.status === "active"));
    const missingAcks = drain.blocker_instance_ids.filter((instanceId) => !drain.acknowledged_instance_ids.includes(instanceId));
    if (activeBlockers.length > 0 || missingAcks.length > 0) return { ok: false, code: "not_ready", summary: "drain blockers have not released and acknowledged", blockers: [...activeBlockers, ...missingAcks].sort() };
    const updated = this.replaceDrain(drain.drain_id, { status: "quiesced", resource_version: ++this.state.quiescence_version });
    this.state.sequence++;
    this.persist();
    return { ok: true, drain: structuredClone(updated), token: this.drainToken(updated), idempotent: false };
  }

  releaseDrain(token: string, reason = "gate hold released"): RepoFlightDrainRecord | null {
    this.assertOpen();
    const drain = this.drainForToken(token);
    if (!drain) return null;
    if (drain.status === "released" || drain.status === "expired") return structuredClone(drain);
    const updated = this.replaceDrain(drain.drain_id, { status: "released", resource_version: ++this.state.quiescence_version, terminal_reason: boundedReason(reason) });
    this.state.quiescence_epoch++;
    this.state.sequence++;
    this.persist();
    return structuredClone(updated);
  }

  authorizeEffect(input: {
    readonly authorization_id?: string;
    readonly request_fingerprint?: `sha256:${string}`;
    readonly token: string;
    readonly repo_run_id: string;
    readonly instance_id: string;
    readonly operation: RepoFlightResourceKind;
    readonly resources: readonly RepoFlightResource[];
    readonly candidate: RepoFlightCandidateBinding;
    readonly effect_digest: `sha256:${string}`;
    readonly policy_version: string;
    readonly approval_id: string | null;
  }): RepoFlightEffectResult {
    this.assertOpen();
    const resources = normalizeResources(input.resources);
    if (!resources.ok) return { ok: false, code: "invalid", summary: resources.summary };
    const semantic = { token: digest(input.token), repo_run_id: input.repo_run_id, instance_id: input.instance_id, operation: input.operation, resources: resources.value, candidate: input.candidate, effect_digest: input.effect_digest, policy_version: input.policy_version, approval_id: input.approval_id };
    const fallbackFingerprint = digest(semantic);
    const durableAuthorization = input.authorization_id !== undefined && input.request_fingerprint !== undefined;
    if ((input.authorization_id === undefined) !== (input.request_fingerprint === undefined)) return { ok: false, code: "invalid", summary: "effect authorization identity must be supplied as a complete pair" };
    const authorizationId = input.authorization_id ?? `effect-auth:${randomUUID()}`;
    const requestFingerprint = input.request_fingerprint ?? fallbackFingerprint;
    if (!boundedId(authorizationId, 256) || !exactDigest(requestFingerprint)) return { ok: false, code: "invalid", summary: "effect authorization identity is malformed" };
    const authorizationFingerprint = digest({ authorization_id: authorizationId, request_fingerprint: requestFingerprint, ...semantic });
    const previous = durableAuthorization ? this.state.effect_authorizations[authorizationId] : undefined;
    if (previous) {
      if (previous.fingerprint !== authorizationFingerprint || previous.request_fingerprint !== requestFingerprint) return { ok: false, code: "unauthorized", summary: "effect authorization id was reused with different content" };
      const restored = this.state.grants.find((candidate) => candidate.grant_id === previous.grant_id);
      if (!restored) return { ok: false, code: "invalid", summary: "effect authorization references a missing clearance" };
      return { ok: true, grant: cloneGrant(restored), use_number: previous.use_number, receipt_digest: previous.receipt_digest, governance_attestation_digest: restored.governance_attestation_digest };
    }
    const grant = this.grantForToken(input.token);
    if (!grant) return { ok: false, code: "unauthorized", summary: "clearance token is absent, malformed, or has an invalid signature" };
    const now = this.now();
    if (grant.status !== "active") return { ok: false, code: "unauthorized", summary: `clearance is ${grant.status}` };
    if (Date.parse(grant.expires_at) <= now.getTime()) {
      this.terminal(grant.grant_id, "expired", "clearance TTL elapsed");
      return { ok: false, code: "expired", summary: "clearance expired before the effect" };
    }
    if (grant.repo_run_id !== input.repo_run_id || grant.instance_id !== input.instance_id) return { ok: false, code: "unauthorized", summary: "effect identity does not match the clearance holder" };
    const holder = this.admitHolder(input.repo_run_id, input.instance_id, input.candidate);
    if (!holder.ok) return { ok: false, code: "unauthorized", summary: holder.summary };
    if (holder.governance_attestation_digest === undefined || grant.governance_attestation_digest !== holder.governance_attestation_digest) return { ok: false, code: "unauthorized", summary: "effect governance warrant changed after clearance" };
    if (input.policy_version !== this.state.policy_version || grant.policy_version !== input.policy_version) return { ok: false, code: "unauthorized", summary: "effect policy version is not current" };
    if (grant.approval_id !== input.approval_id) return { ok: false, code: "unauthorized", summary: "effect approval does not match the clearance" };
    if (!grant.operations.includes(input.operation)) return { ok: false, code: "unauthorized", summary: "effect operation is outside the clearance" };
    if (!exactDigest(input.effect_digest)) return { ok: false, code: "invalid", summary: "effect digest must be an exact SHA-256" };
    if (!candidateEqual(grant.candidate, input.candidate)) return { ok: false, code: "candidate_changed", summary: "repository candidate changed after clearance" };
    if (resources.value.length === 0 || resources.value.some((resource) => !resourceCovered(grant.resources, resource))) return { ok: false, code: "unauthorized", summary: "effect resource is outside the clearance" };
    for (const fence of grant.fences) {
      if (this.state.resource_epochs[fence.resource_id] !== fence.fencing_epoch) return { ok: false, code: "fence_rejected", summary: `clearance fence is stale for ${fence.resource_id}` };
    }
    if (grant.uses >= grant.max_uses) return { ok: false, code: "exhausted", summary: "clearance use bound is exhausted" };

    const sequence = ++this.state.sequence;
    const updated = this.replaceGrant(grant.grant_id, { uses: grant.uses + 1 });
    const receiptDigest = digest({ authorization_id: authorizationId, request_fingerprint: requestFingerprint, grant_id: grant.grant_id, use_number: updated.uses, governance_attestation_digest: holder.governance_attestation_digest, effect_digest: input.effect_digest, operation: input.operation, resources: resources.value, candidate: input.candidate, sequence });
    if (durableAuthorization) this.state.effect_authorizations[authorizationId] = { fingerprint: authorizationFingerprint, request_fingerprint: requestFingerprint, grant_id: grant.grant_id, use_number: updated.uses, receipt_digest: receiptDigest };
    this.persist();
    return { ok: true, grant: cloneGrant(updated), use_number: updated.uses, receipt_digest: receiptDigest, governance_attestation_digest: holder.governance_attestation_digest };
  }

  /** Recovery-only proof that authorization committed before dispatch did. */
  effectAuthorization(authorizationId: string, requestFingerprint: `sha256:${string}`): `sha256:${string}` | null {
    this.assertOpen();
    if (!boundedId(authorizationId, 256) || !exactDigest(requestFingerprint)) return null;
    const authorization = this.state.effect_authorizations[authorizationId];
    return authorization?.request_fingerprint === requestFingerprint ? authorization.receipt_digest : null;
  }

  /** Resolve the live fence set used to make one approval non-transferable. */
  approvalFence(input: {
    readonly token: string;
    readonly repo_run_id: string;
    readonly instance_id: string;
    readonly candidate: RepoFlightCandidateBinding;
    readonly policy_version: string;
    readonly approval_id: string;
  }): RepoFlightApprovalFenceResult {
    this.assertOpen();
    const grant = this.grantForToken(input.token);
    if (!grant || grant.status !== "active") return { ok: false, summary: "approval clearance is absent, malformed, or inactive" };
    if (Date.parse(grant.expires_at) <= this.now().getTime()) return { ok: false, summary: "approval clearance is expired" };
    if (grant.repo_run_id !== input.repo_run_id || grant.instance_id !== input.instance_id || grant.approval_id !== input.approval_id) return { ok: false, summary: "approval identity does not match the clearance" };
    const holder = this.admitHolder(input.repo_run_id, input.instance_id, input.candidate);
    if (!holder.ok || holder.governance_attestation_digest !== grant.governance_attestation_digest) return { ok: false, summary: "approval governance warrant is not current" };
    if (grant.policy_version !== input.policy_version || this.state.policy_version !== input.policy_version) return { ok: false, summary: "approval policy version is not current" };
    if (!candidateEqual(grant.candidate, input.candidate)) return { ok: false, summary: "approval candidate does not match the clearance" };
    if (grant.fences.some((fence) => this.state.resource_epochs[fence.resource_id] !== fence.fencing_epoch)) return { ok: false, summary: "approval clearance fence is stale" };
    const fences = Object.freeze(grant.fences.map((fence) => Object.freeze({ ...fence })));
    return { ok: true, fence_digest: digest(fences), fences };
  }

  release(token: string, reason = "holder released clearance"): RepoFlightClearanceRecord | null {
    this.assertOpen();
    const grant = this.grantForToken(token);
    if (!grant) return null;
    return this.terminal(grant.grant_id, "released", boundedReason(reason));
  }

  revoke(grantId: string, reason: string): RepoFlightClearanceRecord | null {
    this.assertOpen();
    return this.terminal(grantId, "revoked", boundedReason(reason));
  }

  inspect(): readonly RepoFlightClearanceRecord[] {
    this.assertOpen();
    this.expireDue(this.now());
    this.persist();
    return Object.freeze(this.state.grants.map(cloneGrant));
  }

  inspectDrains(): readonly RepoFlightDrainRecord[] {
    this.assertOpen();
    this.expireDue(this.now());
    this.persist();
    return Object.freeze(this.state.drains.map((drain) => structuredClone(drain)));
  }

  private terminal(grantId: string, status: Exclude<RepoFlightClearanceStatus, "active">, reason: string): RepoFlightClearanceRecord | null {
    const grant = this.state.grants.find((candidate) => candidate.grant_id === grantId);
    if (!grant) return null;
    if (grant.status !== "active") return cloneGrant(grant);
    for (const fence of grant.fences) {
      increment(this.state.resource_epochs, fence.resource_id);
      increment(this.state.resource_versions, fence.resource_id);
    }
    const updated = this.replaceGrant(grantId, { status, terminal_reason: reason });
    this.state.sequence++;
    this.persist();
    return cloneGrant(updated);
  }

  private expireDue(now: Date): void {
    for (const grant of [...this.state.grants]) if (grant.status === "active" && Date.parse(grant.expires_at) <= now.getTime()) this.terminal(grant.grant_id, "expired", "clearance TTL elapsed");
    for (const drain of [...this.state.drains]) if ((drain.status === "draining" || drain.status === "quiesced") && Date.parse(drain.expires_at) <= now.getTime()) {
      this.replaceDrain(drain.drain_id, { status: "expired", resource_version: ++this.state.quiescence_version, terminal_reason: "drain TTL elapsed" });
      this.state.quiescence_epoch++;
      this.state.sequence++;
    }
  }

  private replaceGrant(grantId: string, patch: Partial<Pick<RepoFlightClearanceRecord, "uses" | "status" | "terminal_reason" | "expires_at" | "sequence">>): RepoFlightClearanceRecord {
    const index = this.state.grants.findIndex((candidate) => candidate.grant_id === grantId);
    if (index < 0) throw new Error("clearance grant disappeared during mutation");
    const updated = Object.freeze({ ...this.state.grants[index]!, ...patch });
    this.state.grants[index] = updated;
    return updated;
  }

  private replaceDrain(drainId: string, patch: Partial<Pick<RepoFlightDrainRecord, "status" | "acknowledged_instance_ids" | "resource_version" | "terminal_reason">>): RepoFlightDrainRecord {
    const index = this.state.drains.findIndex((candidate) => candidate.drain_id === drainId);
    if (index < 0) throw new Error("repository drain disappeared during mutation");
    const updated = Object.freeze({ ...this.state.drains[index]!, ...patch });
    this.state.drains[index] = updated;
    return updated;
  }

  private token(grant: RepoFlightClearanceRecord): string {
    const body = immutableGrantClaims(grant);
    const signature = createHmac("sha256", this.options.signing_secret).update(canonicalizeForHash(body)).digest("hex");
    return `${grant.grant_id}.${signature}`;
  }

  private grantForToken(token: string): RepoFlightClearanceRecord | null {
    const split = token.lastIndexOf(".");
    if (split <= 0) return null;
    const grant = this.state.grants.find((candidate) => candidate.grant_id === token.slice(0, split));
    if (!grant) return null;
    const expected = this.token(grant);
    return safeEqual(expected, token) ? grant : null;
  }

  private drainToken(drain: RepoFlightDrainRecord): string {
    const claims = { schema_version: drain.schema_version, drain_id: drain.drain_id, request_id: drain.request_id, repo_run_id: drain.repo_run_id, instance_id: drain.instance_id, repository_id: drain.repository_id, candidate: drain.candidate, requested_at: drain.requested_at, expires_at: drain.expires_at, blocker_grant_ids: drain.blocker_grant_ids, blocker_instance_ids: drain.blocker_instance_ids, fencing_epoch: drain.fencing_epoch };
    const signature = createHmac("sha256", this.options.signing_secret).update(canonicalizeForHash(claims)).digest("hex");
    return `${drain.drain_id}.${signature}`;
  }

  private drainForToken(token: string): RepoFlightDrainRecord | null {
    const split = token.lastIndexOf(".");
    if (split <= 0) return null;
    const drain = this.state.drains.find((candidate) => candidate.drain_id === token.slice(0, split));
    return drain && safeEqual(this.drainToken(drain), token) ? drain : null;
  }

  private restore(): RepoFlightAuthorityState {
    if (!existsSync(this.path)) return { schema_version: 1, repository_id: this.options.repository_id, policy_version: this.options.policy_version, sequence: 0, resource_epochs: {}, resource_versions: {}, grants: [], drains: [], quiescence_epoch: 0, quiescence_version: 0, requests: {}, drain_requests: {}, renewals: {}, effect_authorizations: {} };
    const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!validState(parsed)) throw new Error("persisted repo flight authority state is malformed or internally inconsistent");
    return parsed;
  }

  private persist(): void {
    durableWrite(this.path, `${canonicalizeForHash(this.state)}\n`);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("repo flight authority is closed");
  }

  private admitHolder(repoRunId: string, instanceId: string, candidate?: RepoFlightCandidateBinding): { readonly ok: boolean; readonly summary: string; readonly governance_attestation_digest?: `sha256:${string}` } {
    if (this.options.holder_admission === undefined) return { ok: true, summary: "identity admission is not externally composed", governance_attestation_digest: digest({ isolated_authority: this.state.repository_id }) };
    try { return this.options.holder_admission(repoRunId, instanceId, candidate); }
    catch { return { ok: false, summary: "holder identity admission was unavailable" }; }
  }
}

export function resourcesConflict(left: RepoFlightResource, right: RepoFlightResource): boolean {
  if (left.kind === "gate.snapshot" || right.kind === "gate.snapshot") return false;
  if (left.kind === "gate.quiescence" || right.kind === "gate.quiescence") return true;
  if (left.kind === "git.stash" || right.kind === "git.stash" || left.kind === "git.worktree.admin" || right.kind === "git.worktree.admin") return true;
  if (left.kind === "path.write" && right.kind === "path.write") return pathOverlap(left, right);
  if (left.kind === "path.write" || right.kind === "path.write") {
    const nonPath = left.kind === "path.write" ? right.kind : left.kind;
    return nonPath === "result.adopt";
  }
  const gitKinds = new Set<RepoFlightResourceKind>(["git.index", "git.ref", "git.head", "result.adopt", "repository.push"]);
  if (gitKinds.has(left.kind) && gitKinds.has(right.kind)) return true;
  const evidenceKinds = new Set<RepoFlightResourceKind>(["evidence.produce", "evidence.publish"]);
  if (evidenceKinds.has(left.kind) && evidenceKinds.has(right.kind)) return true;
  if (left.kind === "dependency.lockfile" && right.kind === "dependency.lockfile") return true;
  return left.kind === right.kind && left.key === right.key;
}

export function canonicalResourceId(repositoryId: string, resource: RepoFlightResource): string {
  if (!boundedId(repositoryId, 128)) throw new Error("repository id is invalid");
  const normalized = normalizeResource(resource);
  if (!normalized) throw new Error("resource is invalid");
  return `repo-flight:v1:${repositoryId}:${normalized.kind}:${normalized.path_mode ?? "exact"}:${encodeURIComponent(normalized.key)}`;
}

function normalizeRequest(input: RepoFlightClearanceRequest): { ok: true; value: RepoFlightClearanceRequest } | { ok: false; code: "invalid" | "capacity"; summary: string } {
  if (!boundedId(input.request_id, 256) || !boundedId(input.repo_run_id, 256) || !boundedId(input.instance_id, 256) || !boundedId(input.policy_version, 128)) return { ok: false, code: "invalid", summary: "clearance identity fields are malformed" };
  if (!Array.isArray(input.principal_chain) || input.principal_chain.length < 1 || input.principal_chain.length > 16 || input.principal_chain.some((item) => !boundedId(item, 256))) return { ok: false, code: "invalid", summary: "principal chain must contain 1 through 16 bounded identities" };
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > REPO_FLIGHT_MAX_OPERATIONS || input.operations.some((operation) => !REPO_FLIGHT_RESOURCE_KINDS.includes(operation))) return { ok: false, code: "capacity", summary: "operations are absent, invalid, or exceed the bound" };
  const operations = [...new Set(input.operations)].sort();
  const resources = normalizeResources(input.resources);
  if (!resources.ok) return resources;
  if (resources.value.length < 1 || resources.value.length > REPO_FLIGHT_MAX_RESOURCES) return { ok: false, code: "capacity", summary: "resources are absent or exceed the bound" };
  if (!candidateValid(input.candidate)) return { ok: false, code: "invalid", summary: "candidate binding is malformed" };
  if (!Number.isSafeInteger(input.ttl_ms) || input.ttl_ms < 1_000 || input.ttl_ms > REPO_FLIGHT_MAX_TTL_MS) return { ok: false, code: "invalid", summary: "clearance TTL must be 1 second through 24 hours" };
  if (!Number.isSafeInteger(input.max_uses) || input.max_uses < 1 || input.max_uses > 1_000_000) return { ok: false, code: "invalid", summary: "clearance use bound is invalid" };
  if (input.approval_id !== undefined && input.approval_id !== null && !boundedId(input.approval_id, 256)) return { ok: false, code: "invalid", summary: "approval id is invalid" };
  return { ok: true, value: Object.freeze({ ...input, principal_chain: Object.freeze([...input.principal_chain]), operations: Object.freeze(operations), resources: Object.freeze(resources.value), candidate: Object.freeze({ ...input.candidate }), approval_id: input.approval_id ?? null }) };
}

function normalizeResources(input: readonly RepoFlightResource[]): { ok: true; value: RepoFlightResource[] } | { ok: false; code: "invalid" | "capacity"; summary: string } {
  if (!Array.isArray(input) || input.length > REPO_FLIGHT_MAX_RESOURCES) return { ok: false, code: "capacity", summary: "resource collection exceeds the bound" };
  const resources: RepoFlightResource[] = [];
  for (const resource of input) {
    const normalized = normalizeResource(resource);
    if (!normalized) return { ok: false, code: "invalid", summary: "resource identity is malformed" };
    if (!resources.some((candidate) => canonicalizeForHash(candidate) === canonicalizeForHash(normalized))) resources.push(normalized);
  }
  resources.sort((a, b) => canonicalizeForHash(a).localeCompare(canonicalizeForHash(b)));
  return { ok: true, value: resources };
}

function normalizeResource(resource: RepoFlightResource): RepoFlightResource | null {
  if (!resource || !REPO_FLIGHT_RESOURCE_KINDS.includes(resource.kind) || typeof resource.key !== "string") return null;
  if (resource.kind === "path.write") {
    const key = canonicalRelativePath(resource.key);
    const pathMode = resource.path_mode ?? "exact";
    return key && (pathMode === "exact" || pathMode === "subtree") ? Object.freeze({ kind: resource.kind, key, path_mode: pathMode }) : null;
  }
  if (resource.path_mode !== undefined) return null;
  const key = resource.key.trim().normalize("NFC");
  return key.length >= 1 && Buffer.byteLength(key) <= 512 && !/[\0\r\n]/u.test(key) ? Object.freeze({ kind: resource.kind, key }) : null;
}

function canonicalRelativePath(value: string): string | null {
  if (value.length < 1 || value.length > 4096 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return null;
  const normalized = value.normalize("NFC");
  const parts = normalized.split("/");
  return parts.some((part) => part.length === 0 || part === "." || part === "..") ? null : parts.join("/");
}

function pathOverlap(left: RepoFlightResource, right: RepoFlightResource): boolean {
  if (left.key === right.key) return true;
  const leftSubtree = left.path_mode === "subtree" && right.key.startsWith(`${left.key}/`);
  const rightSubtree = right.path_mode === "subtree" && left.key.startsWith(`${right.key}/`);
  return leftSubtree || rightSubtree;
}

function resourceCovered(granted: readonly RepoFlightResource[], requested: RepoFlightResource): boolean {
  return granted.some((held) => held.kind === requested.kind && (held.key === requested.key || held.kind === "path.write" && held.path_mode === "subtree" && requested.key.startsWith(`${held.key}/`)));
}

function immutableGrantClaims(grant: RepoFlightClearanceRecord): object {
  return {
    schema_version: grant.schema_version,
    grant_id: grant.grant_id,
    request_id: grant.request_id,
    request_fingerprint: grant.request_fingerprint,
    repository_id: grant.repository_id,
    repo_run_id: grant.repo_run_id,
    instance_id: grant.instance_id,
    principal_chain: grant.principal_chain,
    operations: grant.operations,
    resources: grant.resources,
    candidate: grant.candidate,
    policy_version: grant.policy_version,
    governance_attestation_digest: grant.governance_attestation_digest,
    approval_id: grant.approval_id,
    issued_at: grant.issued_at,
    expires_at: grant.expires_at,
    max_uses: grant.max_uses,
    fences: grant.fences,
    sequence: grant.sequence,
  };
}

function candidateValid(value: RepoFlightCandidateBinding): boolean {
  return !!value && gitOid(value.base_oid) && gitOid(value.head_oid) && exactDigest(value.tree_digest) && (value.index_digest === undefined || value.index_digest === null || exactDigest(value.index_digest));
}

function candidateEqual(left: RepoFlightCandidateBinding, right: RepoFlightCandidateBinding): boolean {
  return candidateValid(right) && canonicalizeForHash(left) === canonicalizeForHash(right);
}

function validState(value: unknown): value is RepoFlightAuthorityState {
  if (!exactKeys(value, ["schema_version", "repository_id", "policy_version", "sequence", "resource_epochs", "resource_versions", "grants", "drains", "quiescence_epoch", "quiescence_version", "requests", "drain_requests", "renewals", "effect_authorizations"]) || value.schema_version !== 1 || !boundedId(value.repository_id, 128) || !boundedId(value.policy_version, 128) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || !record(value.resource_epochs) || !record(value.resource_versions) || !Array.isArray(value.grants) || !Array.isArray(value.drains) || !Number.isSafeInteger(value.quiescence_epoch) || value.quiescence_epoch < 0 || !Number.isSafeInteger(value.quiescence_version) || value.quiescence_version < 0 || !record(value.requests) || !record(value.drain_requests) || !record(value.renewals) || !record(value.effect_authorizations)) return false;
  if (Object.entries(value.resource_epochs).some(([key, entry]) => !boundedOpaque(key, 2_048) || !positive(entry)) || Object.entries(value.resource_versions).some(([key, entry]) => !boundedOpaque(key, 2_048) || !positive(entry))) return false;
  const grants = value.grants as unknown[];
  if (grants.some((grant) => !validGrant(grant))) return false;
  const drains = value.drains as unknown[];
  if (drains.some((drain) => !validDrain(drain))) return false;
  const typedGrants = grants as RepoFlightClearanceRecord[], typedDrains = drains as RepoFlightDrainRecord[];
  if (typedGrants.some((grant) => grant.repository_id !== value.repository_id || grant.sequence > value.sequence || grant.fences.some((fence) => (value.resource_epochs[fence.resource_id] ?? 0) < fence.fencing_epoch || (value.resource_versions[fence.resource_id] ?? 0) < fence.resource_version || grant.status === "active" && value.resource_epochs[fence.resource_id] !== fence.fencing_epoch))) return false;
  if (typedDrains.some((drain) => drain.repository_id !== value.repository_id || drain.blocker_grant_ids.some((id) => !typedGrants.some((grant) => grant.grant_id === id)))) return false;
  return new Set(typedGrants.map((grant) => grant.grant_id)).size === grants.length
    && new Set(drains.map((drain) => (drain as RepoFlightDrainRecord).drain_id)).size === drains.length
    && Object.entries(value.requests).every(([requestId, entry]) => boundedId(requestId, 256) && exactKeys(entry, ["fingerprint", "grant_id"]) && exactDigest(entry.fingerprint) && boundedId(entry.grant_id, 256) && typedGrants.some((grant) => grant.grant_id === entry.grant_id && grant.request_id === requestId && grant.request_fingerprint === entry.fingerprint))
    && Object.entries(value.drain_requests).every(([requestId, entry]) => boundedId(requestId, 256) && exactKeys(entry, ["fingerprint", "drain_id"]) && exactDigest(entry.fingerprint) && boundedId(entry.drain_id, 256) && typedDrains.some((drain) => drain.drain_id === entry.drain_id && drain.request_id === requestId))
    && Object.values(value.renewals).every((entry) => exactKeys(entry, ["fingerprint", "grant_id"]) && exactDigest(entry.fingerprint) && boundedId(entry.grant_id, 256) && typedGrants.some((grant) => grant.grant_id === entry.grant_id))
    && Object.entries(value.effect_authorizations).every(([authorizationId, entry]) => boundedId(authorizationId, 256) && exactKeys(entry, ["fingerprint", "request_fingerprint", "grant_id", "use_number", "receipt_digest"]) && exactDigest(entry.fingerprint) && exactDigest(entry.request_fingerprint) && boundedId(entry.grant_id, 256) && positive(entry.use_number) && exactDigest(entry.receipt_digest) && typedGrants.some((grant) => grant.grant_id === entry.grant_id && grant.uses >= entry.use_number));
}

function validGrant(value: unknown): value is RepoFlightClearanceRecord {
  if (!exactKeys(value, ["schema_version", "grant_id", "request_id", "request_fingerprint", "repository_id", "repo_run_id", "instance_id", "principal_chain", "operations", "resources", "candidate", "policy_version", "governance_attestation_digest", "approval_id", "issued_at", "expires_at", "max_uses", "uses", "status", "terminal_reason", "fences", "sequence"]) || value.schema_version !== 1 || !boundedId(value.grant_id, 256) || !boundedId(value.request_id, 256) || !exactDigest(value.request_fingerprint) || !boundedId(value.repository_id, 128) || !boundedId(value.repo_run_id, 256) || !boundedId(value.instance_id, 256) || !Array.isArray(value.principal_chain) || value.principal_chain.length < 1 || value.principal_chain.length > 16 || value.principal_chain.some((id) => !boundedId(id, 256)) || !Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > REPO_FLIGHT_MAX_OPERATIONS || !Array.isArray(value.resources) || value.resources.length < 1 || value.resources.length > REPO_FLIGHT_MAX_RESOURCES || !candidateValid(value.candidate as RepoFlightCandidateBinding) || !boundedId(value.policy_version, 128) || !exactDigest(value.governance_attestation_digest) || (value.approval_id !== null && !boundedId(value.approval_id, 256)) || !validDate(value.issued_at) || !validDate(value.expires_at) || Date.parse(value.expires_at) <= Date.parse(value.issued_at) || !positive(value.max_uses) || !Number.isSafeInteger(value.uses) || value.uses < 0 || value.uses > value.max_uses || !["active", "released", "revoked", "expired"].includes(String(value.status)) || (value.status === "active" ? value.terminal_reason !== null : typeof value.terminal_reason !== "string" || value.terminal_reason.length < 1 || value.terminal_reason.length > 512) || !Array.isArray(value.fences) || !positive(value.sequence)) return false;
  const resources = value.resources as RepoFlightResource[], operations = value.operations as RepoFlightResourceKind[], fences = value.fences as unknown[];
  if (resources.some((resource) => normalizeResource(resource) === null) || operations.some((operation) => !REPO_FLIGHT_RESOURCE_KINDS.includes(operation)) || new Set(operations).size !== operations.length || resources.some((resource) => !operations.includes(resource.kind)) || fences.length !== resources.length || fences.some((fence) => !validFence(fence))) return false;
  const expected = resources.map((resource) => canonicalResourceId(value.repository_id, resource)).sort();
  const actual = (fences as RepoFlightResourceFence[]).map((fence) => fence.resource_id).sort();
  return new Set(actual).size === actual.length && canonicalizeForHash(expected) === canonicalizeForHash(actual);
}

function validDrain(value: unknown): value is RepoFlightDrainRecord {
  if (!exactKeys(value, ["schema_version", "drain_id", "request_id", "repo_run_id", "instance_id", "repository_id", "candidate", "requested_at", "expires_at", "status", "blocker_grant_ids", "blocker_instance_ids", "acknowledged_instance_ids", "fencing_epoch", "resource_version", "terminal_reason"]) || value.schema_version !== 1 || !boundedId(value.drain_id, 256) || !boundedId(value.request_id, 256) || !boundedId(value.repo_run_id, 256) || !boundedId(value.instance_id, 256) || !boundedId(value.repository_id, 128) || !candidateValid(value.candidate as RepoFlightCandidateBinding) || !validDate(value.requested_at) || !validDate(value.expires_at) || Date.parse(value.expires_at) <= Date.parse(value.requested_at) || !["draining", "quiesced", "released", "expired"].includes(String(value.status)) || !Array.isArray(value.blocker_grant_ids) || value.blocker_grant_ids.some((id) => !boundedId(id, 256)) || !Array.isArray(value.blocker_instance_ids) || value.blocker_instance_ids.some((id) => !boundedId(id, 256)) || !Array.isArray(value.acknowledged_instance_ids) || value.acknowledged_instance_ids.some((id) => !boundedId(id, 256)) || !positive(value.fencing_epoch) || !positive(value.resource_version) || (value.status === "draining" || value.status === "quiesced" ? value.terminal_reason !== null : typeof value.terminal_reason !== "string" || value.terminal_reason.length < 1 || value.terminal_reason.length > 512)) return false;
  const blockers = value.blocker_instance_ids as string[], acknowledged = value.acknowledged_instance_ids as string[], grants = value.blocker_grant_ids as string[];
  return new Set(blockers).size === blockers.length && new Set(acknowledged).size === acknowledged.length && new Set(grants).size === grants.length && acknowledged.every((id) => blockers.includes(id));
}

function validFence(value: unknown): value is RepoFlightResourceFence { return exactKeys(value, ["resource_id", "fencing_epoch", "resource_version"]) && boundedOpaque(value.resource_id, 2_048) && positive(value.fencing_epoch) && positive(value.resource_version); }

function cloneGrant(grant: RepoFlightClearanceRecord): RepoFlightClearanceRecord {
  return structuredClone(grant);
}

function increment(target: Record<string, number>, key: string): number {
  const value = (target[key] ?? 0) + 1;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("flight authority counter exhausted");
  target[key] = value;
  return value;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalizeForHash(value)).digest("hex")}`;
}

function durableWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function exactDigest(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function gitOid(value: unknown): value is string { return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
function validDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function boundedId(value: unknown, bytes: number): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value) && Buffer.byteLength(value) <= bytes; }
function boundedOpaque(value: unknown, bytes: number): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= bytes && !/[\0\r\n]/u.test(value); }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, any> { return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function boundedReason(value: string): string { const normalized = String(value).trim().slice(0, 512); return normalized || "unspecified"; }
