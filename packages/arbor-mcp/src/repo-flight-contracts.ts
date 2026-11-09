/** Closed, provider-neutral contracts for a repository Flight Director run. */
import { createHash } from "node:crypto";
import type { GovernanceAdmissionAttestation } from "@arbor/governance";

export const REPO_FLIGHT_PHASES = [
  "planned", "awaiting_governance", "governance_authorized", "admitted", "workspace_leased", "session_started", "candidate_ready",
  "verifying", "awaiting_review", "awaiting_acceptance", "adoptable", "adopted",
  "awaiting_operator", "draining", "interrupted", "recovering", "failed", "rejected",
  "exhausted", "abandoned",
] as const;

export type RepoFlightPhase = (typeof REPO_FLIGHT_PHASES)[number];
export const REPO_FLIGHT_WORK_CLASSES = ["decision_bound", "exploratory"] as const;
export type RepoFlightWorkClass = (typeof REPO_FLIGHT_WORK_CLASSES)[number];

export interface RepoFlightRunRepositoryIdentity {
  /** Stable digest of the canonical repository identity, not a display name. */
  readonly repository_id: `repo:v1:${string}`;
  readonly git_common_dir: string;
  readonly worktree_root: string;
  readonly canonical_remote: string | null;
}

export interface RepoFlightBindings {
  readonly active_governance_attempt_id: string | null;
  readonly governance_attestation_digest: `sha256:${string}` | null;
  readonly session_id: string | null;
  readonly worktree_id: string | null;
  readonly worktree_path: string | null;
  readonly lease_id: string | null;
  readonly fence_token: number | null;
  readonly candidate_oid: string | null;
  readonly tree_digest: `sha256:${string}` | null;
  readonly gate_attempt_ids: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly approval_refs: readonly string[];
  readonly adoption_refs: readonly string[];
}

export interface RepoFlightBindingPatch {
  readonly active_governance_attempt_id?: string;
  readonly governance_attestation_digest?: `sha256:${string}`;
  readonly session_id?: string;
  readonly worktree_id?: string;
  readonly worktree_path?: string;
  readonly lease_id?: string;
  readonly fence_token?: number;
  readonly candidate_oid?: string;
  readonly tree_digest?: `sha256:${string}`;
  readonly gate_attempt_id?: string;
  readonly evidence_ref?: string;
  readonly approval_ref?: string;
  readonly adoption_ref?: string;
}

export interface RepoFlightCreatedPayload {
  readonly repo_run_id: string;
  readonly repository: RepoFlightRunRepositoryIdentity;
  readonly base_oid: string;
  readonly operation_id: string;
  readonly correlation_id: string;
  readonly work_class: RepoFlightWorkClass;
  readonly input_digest: `sha256:${string}`;
  readonly scope_digest: `sha256:${string}`;
  readonly workspace_lineage_digest: `sha256:${string}`;
  readonly profile_version: string;
  readonly policy_version: string;
  readonly proposer_identity: string;
}

export interface RepoFlightGovernanceAttemptPayload {
  readonly repo_run_id: string;
  readonly expected_revision: number;
  readonly attempt_id: string;
  readonly attestation_id: string;
  readonly attestation_digest: `sha256:${string}`;
  readonly issuer_identity: string;
  readonly key_id: string;
  readonly verified_at: string;
  readonly expires_at: string;
  readonly outcome: "verified" | "refused";
  readonly refusal_code: string | null;
  readonly attestation: GovernanceAdmissionAttestation | null;
}

export interface RepoFlightTransitionPayload {
  readonly repo_run_id: string;
  readonly expected_revision: number;
  readonly from: RepoFlightPhase;
  readonly to: RepoFlightPhase;
  readonly bindings?: RepoFlightBindingPatch;
}

export type RepoFlightEventBody =
  | { readonly kind: "repo_run.created"; readonly payload: RepoFlightCreatedPayload }
  | { readonly kind: "repo_run.governance_attempted"; readonly payload: RepoFlightGovernanceAttemptPayload }
  | { readonly kind: "repo_run.transitioned"; readonly payload: RepoFlightTransitionPayload };

/** A hash-chained envelope. Sequence and hashes are assigned by the durable store. */
export type RepoFlightEvent = RepoFlightEventBody & {
  readonly version: 1;
  readonly sequence: number;
  readonly event_id: string;
  readonly idempotency_key: string;
  readonly occurred_at: string;
  readonly previous_hash: `sha256:${string}` | null;
  readonly event_hash: `sha256:${string}`;
};

export interface RepoFlightEventInput {
  readonly event_id: string;
  readonly idempotency_key: string;
  readonly occurred_at: string;
  readonly body: RepoFlightEventBody;
}

export type RepoFlightAppendResult =
  | { readonly ok: true; readonly replayed: boolean; readonly event: RepoFlightEvent }
  | { readonly ok: false; readonly code: "invalid_event" | "idempotency_conflict" | "illegal_transition" | "revision_conflict" | "corrupt_store" | "write_failed"; readonly reason: string };

export interface RepoFlightReplayDiagnostic {
  readonly code: "malformed_line" | "invalid_event" | "broken_hash_chain" | "reduction_failed" | "write_failed";
  readonly line?: number;
  readonly message: string;
}

export function isRepoFlightPhase(value: unknown): value is RepoFlightPhase {
  return typeof value === "string" && (REPO_FLIGHT_PHASES as readonly string[]).includes(value);
}

export function isRepoFlightId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

export function isRepoFlightDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function isRepoFlightRepositoryId(value: unknown): value is `repo:v1:${string}` {
  return typeof value === "string" && /^repo:v1:[a-f0-9]{64}$/.test(value);
}

/** Canonical repo identity shared by controller, enrollment, and clients. */
export function repoFlightRepositoryId(gitCommonDir: string): `repo:v1:${string}` {
  return `repo:v1:${createHash("sha256").update(gitCommonDir).digest("hex")}`;
}

export function isRepoFlightGitOid(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}
