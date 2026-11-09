import type { RepoFlightBindings, RepoFlightGovernanceAttemptPayload, RepoFlightPhase, RepoFlightRunRepositoryIdentity, RepoFlightWorkClass } from "./repo-flight-contracts.js";

export interface RepoFlightRunState {
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
  readonly phase: RepoFlightPhase;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly bindings: RepoFlightBindings;
  readonly governance_attempts: readonly RepoFlightGovernanceAttemptPayload[];
}

export interface RepoFlightSnapshot {
  readonly version: 1;
  readonly sequence: number;
  readonly head_hash: `sha256:${string}` | null;
  readonly runs: readonly RepoFlightRunState[];
  /** Digest of the canonical snapshot excluding this field. */
  readonly snapshot_hash: `sha256:${string}`;
}

export const EMPTY_REPO_FLIGHT_BINDINGS: RepoFlightBindings = Object.freeze({
  active_governance_attempt_id: null,
  governance_attestation_digest: null,
  session_id: null,
  worktree_id: null,
  worktree_path: null,
  lease_id: null,
  fence_token: null,
  candidate_oid: null,
  tree_digest: null,
  gate_attempt_ids: Object.freeze([]),
  evidence_refs: Object.freeze([]),
  approval_refs: Object.freeze([]),
  adoption_refs: Object.freeze([]),
});
