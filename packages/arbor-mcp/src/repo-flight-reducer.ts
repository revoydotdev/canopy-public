import type { RepoFlightBindingPatch, RepoFlightBindings, RepoFlightEvent, RepoFlightPhase } from "./repo-flight-contracts.js";
import { EMPTY_REPO_FLIGHT_BINDINGS, type RepoFlightRunState } from "./repo-flight-state.js";

export class RepoFlightReductionError extends Error {
  constructor(readonly code: "illegal_transition" | "revision_conflict" | "invalid_event", message: string) { super(message); }
}

const TERMINAL = new Set<RepoFlightPhase>(["adopted", "failed", "rejected", "exhausted", "abandoned"]);
const TRANSITIONS: Readonly<Record<RepoFlightPhase, ReadonlySet<RepoFlightPhase>>> = Object.freeze({
  planned: phases("awaiting_governance", "failed", "abandoned"),
  awaiting_governance: phases("governance_authorized", "failed", "rejected", "abandoned"),
  governance_authorized: phases("admitted", "awaiting_governance", "failed", "rejected", "abandoned"),
  admitted: phases("workspace_leased", "awaiting_operator", "rejected", "failed", "abandoned"),
  workspace_leased: phases("session_started", "awaiting_operator", "draining", "interrupted", "failed", "abandoned"),
  session_started: phases("candidate_ready", "awaiting_operator", "draining", "interrupted", "failed", "exhausted", "abandoned"),
  candidate_ready: phases("verifying", "awaiting_operator", "draining", "interrupted", "failed", "abandoned"),
  verifying: phases("awaiting_review", "awaiting_operator", "draining", "interrupted", "failed"),
  awaiting_review: phases("awaiting_acceptance", "awaiting_operator", "draining", "rejected", "failed", "abandoned"),
  awaiting_acceptance: phases("adoptable", "awaiting_operator", "draining", "rejected", "failed", "abandoned"),
  adoptable: phases("adopted", "awaiting_operator", "rejected", "failed", "abandoned"),
  adopted: phases(), failed: phases(), rejected: phases(), exhausted: phases(), abandoned: phases(),
  awaiting_operator: phases("admitted", "workspace_leased", "session_started", "candidate_ready", "verifying", "awaiting_review", "awaiting_acceptance", "adoptable", "draining", "interrupted", "recovering", "failed", "rejected", "abandoned"),
  draining: phases("interrupted", "awaiting_operator", "candidate_ready", "failed", "abandoned"),
  interrupted: phases("recovering", "awaiting_operator", "failed", "abandoned"),
  recovering: phases("workspace_leased", "session_started", "candidate_ready", "verifying", "awaiting_review", "awaiting_acceptance", "awaiting_operator", "failed", "abandoned"),
});

function phases(...values: RepoFlightPhase[]): ReadonlySet<RepoFlightPhase> { return new Set(values); }

export function reduceRepoFlightEvent(current: RepoFlightRunState | undefined, event: RepoFlightEvent): RepoFlightRunState {
  switch (event.kind) {
    case "repo_run.created": {
      if (current !== undefined) throw new RepoFlightReductionError("invalid_event", `repo run ${event.payload.repo_run_id} already exists`);
      return Object.freeze({
        ...event.payload,
        phase: "planned" as const,
        revision: 0,
        created_at: event.occurred_at,
        updated_at: event.occurred_at,
        bindings: EMPTY_REPO_FLIGHT_BINDINGS,
        governance_attempts: Object.freeze([]),
      });
    }
    case "repo_run.governance_attempted": {
      if (current === undefined) throw new RepoFlightReductionError("invalid_event", `repo run ${event.payload.repo_run_id} does not exist`);
      if (current.phase !== "awaiting_governance") throw new RepoFlightReductionError("illegal_transition", "governance attempts are only accepted while awaiting governance");
      if (event.payload.expected_revision !== current.revision) throw new RepoFlightReductionError("revision_conflict", `expected revision ${event.payload.expected_revision}, found ${current.revision}`);
      if (current.governance_attempts.some((attempt) => attempt.attempt_id === event.payload.attempt_id)) throw new RepoFlightReductionError("invalid_event", "governance attempt identity is immutable");
      return Object.freeze({ ...current, revision: current.revision + 1, updated_at: event.occurred_at, governance_attempts: Object.freeze([...current.governance_attempts, Object.freeze(event.payload)]) });
    }
    case "repo_run.transitioned": {
      if (current === undefined) throw new RepoFlightReductionError("invalid_event", `repo run ${event.payload.repo_run_id} does not exist`);
      if (event.payload.repo_run_id !== current.repo_run_id) throw new RepoFlightReductionError("invalid_event", "event targets a different repo run");
      if (event.payload.expected_revision !== current.revision) throw new RepoFlightReductionError("revision_conflict", `expected revision ${event.payload.expected_revision}, found ${current.revision}`);
      if (event.payload.from !== current.phase) throw new RepoFlightReductionError("revision_conflict", `expected phase ${event.payload.from}, found ${current.phase}`);
      if (TERMINAL.has(current.phase) || !TRANSITIONS[current.phase].has(event.payload.to)) throw new RepoFlightReductionError("illegal_transition", `transition ${current.phase} -> ${event.payload.to} is not permitted`);
      if (current.phase === "awaiting_governance" && event.payload.to === "governance_authorized") {
        const attemptId = event.payload.bindings?.active_governance_attempt_id;
        const digest = event.payload.bindings?.governance_attestation_digest;
        const attempt = current.governance_attempts.find((candidate) => candidate.attempt_id === attemptId);
        if (attempt === undefined || attempt.outcome !== "verified" || attempt.attestation_digest !== digest || Date.parse(attempt.expires_at) <= Date.parse(event.occurred_at)) throw new RepoFlightReductionError("invalid_event", "governance authorization requires a current verified append-only attempt");
      }
      return Object.freeze({
        ...current,
        phase: event.payload.to,
        revision: current.revision + 1,
        updated_at: event.occurred_at,
        bindings: mergeBindings(current.bindings, event.payload.bindings),
      });
    }
    default: return assertNever(event);
  }
}

function mergeBindings(current: RepoFlightBindings, patch: RepoFlightBindingPatch | undefined): RepoFlightBindings {
  if (patch === undefined) return current;
  const active_governance_attempt_id = patch.active_governance_attempt_id ?? current.active_governance_attempt_id;
  const governance_attestation_digest = patch.governance_attestation_digest ?? current.governance_attestation_digest;
  const session_id = bindOnce("session_id", current.session_id, patch.session_id);
  const worktree_id = bindOnce("worktree_id", current.worktree_id, patch.worktree_id);
  const worktree_path = bindOnce("worktree_path", current.worktree_path, patch.worktree_path);
  const lease_id = bindOnce("lease_id", current.lease_id, patch.lease_id);
  const fence_token = bindOnce("fence_token", current.fence_token, patch.fence_token);
  const candidate_oid = bindOnce("candidate_oid", current.candidate_oid, patch.candidate_oid);
  const tree_digest = bindOnce("tree_digest", current.tree_digest, patch.tree_digest);
  return Object.freeze({
    active_governance_attempt_id, governance_attestation_digest, session_id, worktree_id, worktree_path, lease_id, fence_token, candidate_oid, tree_digest,
    gate_attempt_ids: appendUnique(current.gate_attempt_ids, patch.gate_attempt_id),
    evidence_refs: appendUnique(current.evidence_refs, patch.evidence_ref),
    approval_refs: appendUnique(current.approval_refs, patch.approval_ref),
    adoption_refs: appendUnique(current.adoption_refs, patch.adoption_ref),
  });
}

function bindOnce<T>(name: string, current: T | null, proposed: T | undefined): T | null {
  if (proposed === undefined) return current;
  if (current !== null && current !== proposed) throw new RepoFlightReductionError("invalid_event", `${name} is immutable once bound`);
  return proposed;
}

function appendUnique(values: readonly string[], value: string | undefined): readonly string[] {
  return value === undefined || values.includes(value) ? values : Object.freeze([...values, value]);
}

function assertNever(value: never): never { throw new RepoFlightReductionError("invalid_event", `unsupported event ${(value as { kind?: string }).kind ?? "unknown"}`); }
