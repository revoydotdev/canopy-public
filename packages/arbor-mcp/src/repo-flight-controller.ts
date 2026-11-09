import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { verifyGovernanceAdmissionAttestation, type GovernanceAdmissionTrustState } from "@arbor/governance";
import { ApprovalService } from "./approval-service.js";
import { RepoFlightAuthority } from "./repo-flight-authority.js";
import { repoFlightRepositoryId, type RepoFlightBindingPatch, type RepoFlightEventInput, type RepoFlightPhase, type RepoFlightRunRepositoryIdentity } from "./repo-flight-contracts.js";
import { RepoFlightDeliveryAdapter } from "./repo-flight-delivery.js";
import { compareRepoFlightExecutionPlanShadow, runnableRepoFlightPlanGates, verifyRepoFlightExecutionPlan, type RepoFlightExecutionPlanInput } from "./repo-flight-execution-plan.js";
import { RepoFlightEffectExecutor } from "./repo-flight-effects.js";
import { RepoFlightEnrollmentRegistry } from "./repo-flight-enrollment.js";
import { RepoFlightGateCoordinator } from "./repo-flight-gates.js";
import { createRepoFlightWorkspaceSnapshot, isRepoFlightProvisionedWorkspace, probeRepoFlightGitCandidate, probeRepoFlightQuiescentConfinement, runRepoFlightGateCommand } from "./repo-flight-git.js";
import { RepoFlightOperatorService } from "./repo-flight-operator.js";
import { observeRepoFlightHostProcess, probeRepoFlightHostProcess } from "./repo-flight-process.js";
import { evaluateRepoFlightProfile, REPO_FLIGHT_PROVIDERS, type RepoFlightCheckoutProtection, type RepoFlightFederationFacts, type RepoFlightProfile, type RepoFlightProfileProvider, type RepoFlightProviderInterceptorFacts } from "./repo-flight-profile.js";
import type { RepoFlightSessionManifestInput, RepoFlightSessionRecord } from "./repo-flight-session.js";
import { RepoFlightLifecycleStore } from "./repo-flight-store.js";
import type { RepoFlightRunState } from "./repo-flight-state.js";
import type { RepoFlightAgentCredentialBinding } from "./repo-flight-transport.js";
import { RepoFlightTelemetryStore } from "./repo-flight-telemetry.js";
import { RepoFlightValidationCache, type RepoFlightValidationTrustRoots } from "./repo-flight-validation-cache.js";

export interface RepoFlightDeploymentProbe {
  readonly providers?: Partial<Readonly<Record<RepoFlightProfileProvider, RepoFlightProviderInterceptorFacts>>>;
  readonly canonical_shared_checkout: RepoFlightCheckoutProtection;
  readonly unmanaged_sessions_present: boolean;
  readonly raw_shell_mutation_interceptor: boolean;
  readonly effect_interceptor?: boolean;
  readonly adoption_fencing?: boolean;
  readonly federation?: RepoFlightFederationFacts;
}

export interface RepoFlightControllerOptions {
  readonly repository_root: string;
  readonly persistence_dir: string;
  readonly policy_version: string;
  readonly signing_secret: string;
  readonly required_providers: readonly RepoFlightProfileProvider[];
  readonly deployment: RepoFlightDeploymentProbe;
  readonly approval_service?: ApprovalService;
  readonly director_instance_id?: string;
  readonly now?: () => Date;
  /** Governance-owned, dynamically read trust state. Flight receives no private key. */
  readonly governance_trust?: () => GovernanceAdmissionTrustState;
  readonly execution_profile?: unknown;
  readonly execution_plan_trust?: ReadonlyMap<string, string>;
  readonly validation_trust_roots?: RepoFlightValidationTrustRoots;
}

export interface RepoFlightRunCreateInput {
  readonly repo_run_id: string;
  readonly operation_id: string;
  readonly correlation_id: string;
  readonly base_oid?: string;
  /** Defaults to the stricter governed class; exploratory is never inferred. */
  readonly work_class?: "decision_bound" | "exploratory";
  readonly input_digest?: `sha256:${string}`;
  readonly scope_digest?: `sha256:${string}`;
  readonly workspace_lineage_digest?: `sha256:${string}`;
  readonly proposer_identity?: string;
}

/** Production composition: one authority process and explicit sub-store roots per repository. */
export class RepoFlightController {
  readonly lifecycle!: RepoFlightLifecycleStore;
  readonly enrollment!: RepoFlightEnrollmentRegistry;
  readonly authority!: RepoFlightAuthority;
  readonly deliveries!: RepoFlightDeliveryAdapter;
  readonly gates!: RepoFlightGateCoordinator;
  readonly effects!: RepoFlightEffectExecutor;
  readonly approvals!: ApprovalService;
  readonly operator!: RepoFlightOperatorService;
  readonly telemetry!: RepoFlightTelemetryStore;
  readonly validation_cache!: RepoFlightValidationCache | null;
  readonly profile!: RepoFlightProfile;
  readonly repository!: RepoFlightRunRepositoryIdentity;
  readonly director_instance_id!: string;
  private readonly now: () => Date;
  private readonly policyVersion: string;
  private readonly governanceTrust: (() => GovernanceAdmissionTrustState) | null;
  private readonly executionProfile: unknown;
  private readonly executionPlanTrust: ReadonlyMap<string, string>;
  private closed = false;

  constructor(options: RepoFlightControllerOptions) {
    this.now = options.now ?? (() => new Date());
    this.policyVersion = options.policy_version;
    this.governanceTrust = options.governance_trust ?? null;
    this.executionProfile = options.execution_profile;
    this.executionPlanTrust = options.execution_plan_trust ?? new Map();
    mkdirSync(options.persistence_dir, { recursive: true });
    const candidate = probeRepoFlightGitCandidate(options.repository_root);
    this.repository = Object.freeze({ repository_id: repoFlightRepositoryId(candidate.git_common_dir), git_common_dir: candidate.git_common_dir, worktree_root: candidate.repository_root, canonical_remote: gitOptional(candidate.repository_root, ["config", "--get", "remote.origin.url"]) });
    this.director_instance_id = options.director_instance_id ?? `director:v1:${createHash("sha256").update(`${this.repository.repository_id}\0${realpathSync(options.persistence_dir)}`).digest("hex")}`;
    let enrollment: RepoFlightEnrollmentRegistry | null = null;
    let authority: RepoFlightAuthority | null = null;
    let gates: RepoFlightGateCoordinator | null = null;
    let effects: RepoFlightEffectExecutor | null = null;
    let telemetry: RepoFlightTelemetryStore | null = null;
    let validationCache: RepoFlightValidationCache | null = null;
    try {
      authority = new RepoFlightAuthority({
        persistence_dir: join(options.persistence_dir, "authority"), repository_id: this.repository.repository_id,
        policy_version: options.policy_version, signing_secret: options.signing_secret, now: this.now,
        holder_admission: (runId, instanceId) => this.admitHolder(enrollment, runId, instanceId),
      });
      enrollment = new RepoFlightEnrollmentRegistry({ persistence_dir: join(options.persistence_dir, "enrollment"), now: this.now });
      this.authority = authority;
      this.enrollment = enrollment;
      this.lifecycle = new RepoFlightLifecycleStore({ persistence_dir: join(options.persistence_dir, "lifecycle") });
      this.deliveries = new RepoFlightDeliveryAdapter({ persistence_dir: join(options.persistence_dir, "delivery") });
      this.approvals = options.approval_service ?? new ApprovalService({ persistence_dir: join(options.persistence_dir, "approval"), clock: () => this.timestamp() });
      telemetry = new RepoFlightTelemetryStore({ persistence_dir: join(options.persistence_dir, "telemetry") });
      this.telemetry = telemetry;
      validationCache = options.validation_trust_roots === undefined ? null : new RepoFlightValidationCache({ persistence_dir: join(options.persistence_dir, "validation-cache"), trust_roots: options.validation_trust_roots, now: this.now });
      this.validation_cache = validationCache;
      gates = new RepoFlightGateCoordinator({ persistence_dir: join(options.persistence_dir, "gates"), repository_root: candidate.repository_root, authority, candidate_probe: (base) => probeRepoFlightGitCandidate(candidate.repository_root, base), snapshot_factory: (binding) => createRepoFlightWorkspaceSnapshot(candidate.repository_root, binding), run_command: runRepoFlightGateCommand, telemetry, now: this.now });
      effects = new RepoFlightEffectExecutor({ persistence_dir: join(options.persistence_dir, "effects"), authority, approval_lookup: (id) => this.approvals.get(id), candidate_probe: (base) => probeRepoFlightGitCandidate(candidate.repository_root, base), now: this.now });
      this.gates = gates;
      this.effects = effects;
      const gateConfinement = probeRepoFlightQuiescentConfinement();
      this.profile = evaluateRepoFlightProfile({
        schema_version: 1, repository_id: this.repository.repository_id, required_providers: options.required_providers,
        providers: providerFacts(options.deployment.providers),
        controls: {
          stores: { authority: true, enrollment: true, lifecycle: true },
          canonical_shared_checkout: options.deployment.canonical_shared_checkout,
          unmanaged_sessions_present: options.deployment.unmanaged_sessions_present,
          raw_shell_mutation_interceptor: options.deployment.raw_shell_mutation_interceptor,
          gate_broker: gateConfinement.available, effect_interceptor: options.deployment.effect_interceptor === true, approval_closure: true, a2a_receipt_adapter: true, adoption_fencing: options.deployment.adoption_fencing === true,
        },
        ...(options.deployment.federation === undefined ? {} : { federation: options.deployment.federation }),
      });
      this.operator = new RepoFlightOperatorService({ lifecycle: this.lifecycle, enrollment, authority, gates, deliveries: this.deliveries, effects, telemetry, run_control: { create: (input) => this.createRun(input), authorize: (runId, attestation) => this.authorizeGovernance(runId, attestation), schedule: (input) => this.scheduleExecutionPlan(input), transition: (runId, to, bindings) => this.transitionRun(runId, to, bindings) }, session_control: { enroll: (input) => this.enroll(input), reconcile: (channels) => this.reconcileProcesses(channels) }, profile: this.profile, now: this.now });
    } catch (error) {
      try { effects?.close(); } catch { /* preserve original startup failure */ }
      try { telemetry?.close(); } catch { /* preserve original startup failure */ }
      try { validationCache?.close(); } catch { /* preserve original startup failure */ }
      try { gates?.close(); } catch { /* preserve original startup failure */ }
      try { enrollment?.close(); } catch { /* preserve original startup failure */ }
      try { authority?.close(); } catch { /* preserve original startup failure */ }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.effects.close(); this.gates.close(); this.validation_cache?.close(); this.telemetry.close(); this.enrollment.close(); this.authority.close();
  }

  createRun(input: RepoFlightRunCreateInput): RepoFlightRunState {
    this.assertOpen();
    const candidate = probeRepoFlightGitCandidate(this.repository.worktree_root, input.base_oid);
    const profileVersion = `profile:v1:${createHash("sha256").update(JSON.stringify(this.profile)).digest("hex")}`;
    const event: RepoFlightEventInput = { event_id: `flight-event:${randomUUID()}`, idempotency_key: `repo-run:create:${input.repo_run_id}`, occurred_at: this.timestamp(), body: { kind: "repo_run.created", payload: {
      repo_run_id: input.repo_run_id, repository: this.repository, base_oid: candidate.base_oid, operation_id: input.operation_id, correlation_id: input.correlation_id,
      work_class: input.work_class ?? "decision_bound",
      input_digest: input.input_digest ?? flightDigest({ operation_id: input.operation_id, correlation_id: input.correlation_id, base_oid: candidate.base_oid }),
      scope_digest: input.scope_digest ?? flightDigest({ repository_id: this.repository.repository_id, operation_id: input.operation_id }),
      workspace_lineage_digest: input.workspace_lineage_digest ?? flightDigest({ repository_id: this.repository.repository_id, admission_base_oid: candidate.base_oid }),
      profile_version: profileVersion, policy_version: this.policyVersion, proposer_identity: input.proposer_identity ?? `operator:${input.operation_id}`,
    } } };
    const result = this.lifecycle.append(event);
    if (!result.ok) throw new Error(result.reason);
    return this.requiredRun(input.repo_run_id);
  }

  /** Verify and witness the only successful planned-to-admitted path. */
  authorizeGovernance(repoRunId: string, attestation: unknown): RepoFlightRunState {
    this.assertOpen();
    let run = this.requiredRun(repoRunId);
    if (run.phase === "planned") run = this.transitionRun(repoRunId, "awaiting_governance");
    if (run.phase !== "awaiting_governance") throw new Error(`repo run phase ${run.phase} cannot receive governance authorization`);
    const verifiedAt = this.timestamp();
    const expected = { repository_id: run.repository.repository_id, repo_run_id: run.repo_run_id, work_class: run.work_class, admission_base_oid: run.base_oid, input_digest: run.input_digest, scope_digest: run.scope_digest, workspace_lineage_digest: run.workspace_lineage_digest, profile_version: run.profile_version, policy_version: run.policy_version };
    const verification = this.governanceTrust === null
      ? { ok: false as const, code: "trust" as const, reason: "governance trust state is not configured" }
      : verifyGovernanceAdmissionAttestation(attestation, expected, this.governanceTrust(), verifiedAt);
    const fields = attestationFields(attestation);
    const attemptId = `governance-attempt:${randomUUID()}`;
    const attempt: RepoFlightEventInput = {
      event_id: `flight-event:${randomUUID()}`, idempotency_key: `repo-run:governance:${repoRunId}:${attemptId}`, occurred_at: verifiedAt,
      body: { kind: "repo_run.governance_attempted", payload: { repo_run_id: repoRunId, expected_revision: run.revision, attempt_id: attemptId, attestation_id: fields.attestation_id, attestation_digest: verification.ok ? verification.attestation_digest : fields.digest, issuer_identity: fields.issuer_identity, key_id: fields.key_id, verified_at: verifiedAt, expires_at: fields.expires_at, outcome: verification.ok ? "verified" : "refused", refusal_code: verification.ok ? null : verification.code, attestation: verification.ok ? structuredClone(attestation) as never : null } },
    };
    const appended = this.lifecycle.append(attempt);
    if (!appended.ok) throw new Error(appended.reason);
    if (!verification.ok) throw new Error(`governance authorization refused: ${verification.reason}`);
    run = this.transitionRun(repoRunId, "governance_authorized", { active_governance_attempt_id: attemptId, governance_attestation_digest: verification.attestation_digest });
    // Reverify immediately before admission; trust/revocation inputs are dynamic.
    const rebound = verifyGovernanceAdmissionAttestation(attestation, expected, this.governanceTrust!(), this.timestamp());
    if (!rebound.ok || rebound.attestation_digest !== verification.attestation_digest) {
      this.transitionRun(repoRunId, "awaiting_governance");
      throw new Error(`governance authorization changed before admission: ${rebound.ok ? "digest mismatch" : rebound.reason}`);
    }
    return this.transitionRun(repoRunId, "admitted");
  }

  scheduleExecutionPlan(input: { readonly repo_run_id: string; readonly instance_id: string; readonly mode: "snapshot" | "quiescent"; readonly plan_input: Omit<RepoFlightExecutionPlanInput, "profile">; readonly signed_plan: unknown; readonly completed_gate_ids?: readonly string[] }): import("./repo-flight-gates.js").RepoFlightGatePlan {
    this.assertOpen();
    if (this.executionProfile === undefined || this.executionPlanTrust.size === 0) throw new Error("profile-to-Flight adapter trust is not configured");
    const run = this.requiredRun(input.repo_run_id);
    const governance = this.rebindGovernance(run);
    if (!governance.ok) throw new Error(governance.summary);
    const planInput = { ...input.plan_input, profile: this.executionProfile };
    const signed = verifyRepoFlightExecutionPlan(input.signed_plan, this.executionPlanTrust);
    const parity = compareRepoFlightExecutionPlanShadow(planInput, signed);
    if (!parity.ok) throw new Error(`profile-to-Flight shadow parity failed: ${parity.findings.map((finding) => finding.path).join(", ")}`);
    const candidate = probeRepoFlightGitCandidate(this.repository.worktree_root, run.base_oid);
    if (signed.candidate.candidate_oid !== candidate.head_oid || signed.candidate.input_digest !== candidate.tree_digest) throw new Error("execution plan candidate does not match the current repository candidate");
    const completed = new Set(input.completed_gate_ids ?? []);
    const runnable = runnableRepoFlightPlanGates(signed, completed);
    if (runnable.length === 0) throw new Error("execution plan has no runnable read-only gate wave");
    const requestId = `flight-plan-request:${signed.plan_digest.slice(7, 39)}:${runnable[0]!.wave}`;
    const result = this.gates.request({ request_id: requestId, plan_id: `flight-plan:${signed.plan_digest.slice(7, 39)}:${runnable[0]!.wave}`, repo_run_id: run.repo_run_id, instance_id: input.instance_id, mode: input.mode, candidate, profile_digest: signed.profile.profile_digest, commands: runnable.map((gate) => ({ gate_id: gate.gate_id, argv: gate.argv, timeout_ms: gate.timeout_ms, read_only: true })) });
    if (!result.ok) throw new Error(result.summary);
    return result.plan;
  }

  transitionRun(repoRunId: string, to: RepoFlightPhase, bindings?: RepoFlightBindingPatch): RepoFlightRunState {
    this.assertOpen();
    const current = this.requiredRun(repoRunId);
    const event: RepoFlightEventInput = { event_id: `flight-event:${randomUUID()}`, idempotency_key: `repo-run:transition:${repoRunId}:${current.revision}:${to}`, occurred_at: this.timestamp(), body: { kind: "repo_run.transitioned", payload: { repo_run_id: repoRunId, expected_revision: current.revision, from: current.phase, to, ...(bindings === undefined ? {} : { bindings }) } } };
    const result = this.lifecycle.append(event);
    if (!result.ok) throw new Error(result.reason);
    return this.requiredRun(repoRunId);
  }

  enroll(input: Omit<RepoFlightSessionManifestInput, "repository" | "process_start_token" | "host_boot_id" | "process_group"> & { readonly worktree_root?: string }): RepoFlightSessionRecord {
    this.assertOpen();
    const run = this.requiredRun(input.repo_run_id);
    const worktree = input.worktree_root ?? this.repository.worktree_root;
    const candidate = probeRepoFlightGitCandidate(worktree, run.base_oid);
    if (candidate.git_common_dir !== this.repository.git_common_dir && !isRepoFlightProvisionedWorkspace(this.repository.worktree_root, candidate.repository_root, { campaign_id: input.campaign_id, node_id: input.node_id, base_oid: run.base_oid })) throw new Error("session worktree belongs to a different Git repository or lacks a matching active Revoy lease");
    const { worktree_root: _worktreeRoot, ...session } = input;
    const processIdentity = probeRepoFlightHostProcess(input.pid);
    return this.enrollment.enroll({ ...session, process_start_token: processIdentity.process_start_token, host_boot_id: processIdentity.host_boot_id, process_group: { pgid: processIdentity.pgid, child_pids: processIdentity.child_pids }, repository: { repository_root: this.repository.worktree_root, git_common_dir: this.repository.git_common_dir, worktree_root: candidate.repository_root, branch: gitOptional(candidate.repository_root, ["symbolic-ref", "--quiet", "--short", "HEAD"]), base_oid: run.base_oid, head_oid: candidate.head_oid } });
  }

  reconcileProcesses(controlChannels: Readonly<Record<string, "connected" | "disconnected" | "unknown">> = {}): readonly RepoFlightSessionRecord[] {
    this.assertOpen();
    const now = this.timestamp();
    return Object.freeze(this.enrollment.projections().map((projection) => this.enrollment.observe(projection.instance_id, observeRepoFlightHostProcess(projection.pid, now, controlChannels[projection.instance_id] ?? "unknown"))));
  }

  agentCredentialBinding(instanceId: string): RepoFlightAgentCredentialBinding | null {
    this.assertOpen();
    const record = this.enrollment.record(instanceId);
    const projection = this.enrollment.projection(instanceId);
    if (record === null || projection === null) return null;
    const run = this.lifecycle.inspect(projection.repo_run_id);
    const governance = run === null ? { ok: false as const } : this.rebindGovernance(run);
    return Object.freeze({ instance_id: projection.instance_id, repository_id: projection.repository_id, repo_run_id: projection.repo_run_id, provider_session_ref: projection.provider_session_ref, process_identity_ref: projection.process_identity_ref, revocation_epoch: record.revision, active: record.state === "live" && !record.fenced && governance.ok });
  }

  private admitHolder(enrollment: RepoFlightEnrollmentRegistry | null, repoRunId: string, instanceId: string, candidate?: import("./repo-flight-authority.js").RepoFlightCandidateBinding): { readonly ok: boolean; readonly summary: string; readonly governance_attestation_digest?: `sha256:${string}` } {
    const run = this.lifecycle?.inspect(repoRunId) ?? null;
    if (run === null || run.repository.repository_id !== this.repository.repository_id) return { ok: false, summary: "holder repo run is absent or belongs to another repository" };
    if (["planned", "awaiting_governance", "governance_authorized", "awaiting_operator", "interrupted", "adopted", "failed", "rejected", "exhausted", "abandoned"].includes(run.phase)) return { ok: false, summary: `repo run phase ${run.phase} does not admit protected effects` };
    if (run.bindings.active_governance_attempt_id === null || run.bindings.governance_attestation_digest === null) return { ok: false, summary: "repo run has no active governance warrant" };
    if (run.work_class === "exploratory") return { ok: false, summary: "exploratory runs cannot acquire protected mutation, publication, adoption, or finalization authority" };
    const governance = this.rebindGovernance(run);
    if (!governance.ok) return governance;
    if (candidate !== undefined && !this.candidateInAuthorizedLineage(run.base_oid, candidate)) return { ok: false, summary: "effect candidate is outside the governance-authorized workspace lineage" };
    if (instanceId === this.director_instance_id) return { ok: true, summary: "repository director identity admitted", governance_attestation_digest: governance.governance_attestation_digest };
    const session = enrollment?.projection(instanceId) ?? null;
    if (session === null || session.repository_id !== this.repository.repository_id || session.repo_run_id !== repoRunId) return { ok: false, summary: "holder session is not enrolled for this repository run" };
    if (session.fenced || (session.state !== "live" && session.state !== "draining")) return { ok: false, summary: `holder session is ${session.state} or fenced` };
    return { ok: true, summary: "enrolled holder identity admitted", governance_attestation_digest: governance.governance_attestation_digest };
  }

  private rebindGovernance(run: RepoFlightRunState): { readonly ok: true; readonly summary: string; readonly governance_attestation_digest: `sha256:${string}` } | { readonly ok: false; readonly summary: string } {
    if (this.governanceTrust === null || run.bindings.active_governance_attempt_id === null || run.bindings.governance_attestation_digest === null) return { ok: false, summary: "governance trust or active warrant is unavailable" };
    const attempt = run.governance_attempts.find((candidate) => candidate.attempt_id === run.bindings.active_governance_attempt_id);
    if (attempt?.outcome !== "verified" || attempt.attestation === null) return { ok: false, summary: "active governance attempt is absent or unverified" };
    const expected = { repository_id: run.repository.repository_id, repo_run_id: run.repo_run_id, work_class: run.work_class, admission_base_oid: run.base_oid, input_digest: run.input_digest, scope_digest: run.scope_digest, workspace_lineage_digest: run.workspace_lineage_digest, profile_version: run.profile_version, policy_version: run.policy_version };
    const result = verifyGovernanceAdmissionAttestation(attempt.attestation, expected, this.governanceTrust(), this.timestamp());
    if (!result.ok || result.attestation_digest !== run.bindings.governance_attestation_digest) return { ok: false, summary: result.ok ? "active governance warrant digest changed" : result.reason };
    return { ok: true, summary: "active governance warrant rebound", governance_attestation_digest: result.attestation_digest };
  }

  private candidateInAuthorizedLineage(baseOid: string, candidate: import("./repo-flight-authority.js").RepoFlightCandidateBinding): boolean {
    if (candidate.base_oid !== baseOid) return false;
    const result = spawnSync("git", ["merge-base", "--is-ancestor", baseOid, candidate.head_oid], { cwd: this.repository.worktree_root, encoding: "utf8", shell: false });
    return result.status === 0;
  }

  private requiredRun(id: string): RepoFlightRunState { const run = this.lifecycle.inspect(id); if (!run) throw new Error(`repo run ${id} was not found`); return run; }
  private timestamp(): string { const value = this.now(); if (!Number.isFinite(value.getTime())) throw new Error("flight controller clock is invalid"); return value.toISOString(); }
  private assertOpen(): void { if (this.closed) throw new Error("repo flight controller is closed"); }
}

function providerFacts(input: RepoFlightDeploymentProbe["providers"]): Readonly<Record<RepoFlightProfileProvider, RepoFlightProviderInterceptorFacts>> {
  return Object.freeze(Object.fromEntries(REPO_FLIGHT_PROVIDERS.map((provider) => [provider, Object.freeze(input?.[provider] ?? { launch_interceptor: false, identity_enrollment: false, mutation_interceptor: false })])) as unknown as Record<RepoFlightProfileProvider, RepoFlightProviderInterceptorFacts>);
}
function gitOptional(root: string, argv: readonly string[]): string | null { const result = spawnSync("git", argv, { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024, shell: false }); if (result.status !== 0) return null; const value = result.stdout.trim(); return value.length ? value : null; }
function flightDigest(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function attestationFields(value: unknown): { attestation_id: string; issuer_identity: string; key_id: string; expires_at: string; digest: `sha256:${string}` } {
  const hash = flightDigest(value);
  const payload = typeof value === "object" && value !== null && typeof (value as { payload?: unknown }).payload === "object" && (value as { payload: object }).payload !== null ? (value as { payload: Record<string, unknown> }).payload : {};
  const bounded = (field: string, fallback: string): string => typeof payload[field] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(payload[field] as string) ? payload[field] as string : fallback;
  const expiry = typeof payload.expires_at === "string" && !Number.isNaN(Date.parse(payload.expires_at)) ? payload.expires_at : new Date(0).toISOString();
  return { attestation_id: bounded("attestation_id", `invalid:${hash.slice(7, 39)}`), issuer_identity: bounded("issuer_identity", "invalid:issuer"), key_id: bounded("key_id", "invalid:key"), expires_at: expiry, digest: hash };
}
