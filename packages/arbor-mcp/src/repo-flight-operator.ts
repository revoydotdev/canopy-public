/** Bounded, secret-free operator API over the repo-local Flight Director authorities. */
import type { RepoFlightAuthority, RepoFlightCandidateBinding, RepoFlightClearanceRecord, RepoFlightClearanceRequest, RepoFlightClearanceStatus, RepoFlightDrainRecord, RepoFlightDrainStatus } from "./repo-flight-authority.js";
import type { RepoFlightDeliveryAdapter, RepoFlightDeliveryProjection, RepoFlightDeliveryState, RepoFlightDeliveryTransitionInput, RepoFlightSentInput } from "./repo-flight-delivery.js";
import type { RepoFlightEffectExecutor, RepoFlightEffectRecord } from "./repo-flight-effects.js";
import type { RepoFlightEnrollmentRegistry } from "./repo-flight-enrollment.js";
import type { RepoFlightExecutionPlanInput } from "./repo-flight-execution-plan.js";
import type { RepoFlightGateCoordinator, RepoFlightGatePlan, RepoFlightGatePlanRequest } from "./repo-flight-gates.js";
import type { RepoFlightProfile } from "./repo-flight-profile.js";
import type { RepoFlightSessionManifestInput, RepoFlightSessionProjection, RepoFlightSessionRecord, RepoFlightSessionState } from "./repo-flight-session.js";
import type { RepoFlightLifecycleStore } from "./repo-flight-store.js";
import type { RepoFlightBindingPatch, RepoFlightPhase } from "./repo-flight-contracts.js";
import type { RepoFlightRunState } from "./repo-flight-state.js";
import type { RepoFlightTelemetryObservation, RepoFlightTelemetryStore } from "./repo-flight-telemetry.js";

export type RepoFlightOperatorQuery =
  | { readonly kind: "repo.flight.status" }
  | { readonly kind: "repo.flight.sessions"; readonly state?: RepoFlightSessionState; readonly limit?: number }
  | { readonly kind: "repo.flight.clearances"; readonly status?: RepoFlightClearanceStatus; readonly limit?: number }
  | { readonly kind: "repo.flight.drains"; readonly status?: RepoFlightDrainStatus; readonly limit?: number }
  | { readonly kind: "repo.flight.gate"; readonly plan_id: string }
  | { readonly kind: "repo.flight.deliveries"; readonly repo_run_id?: string; readonly state?: RepoFlightDeliveryState; readonly limit?: number }
  | { readonly kind: "repo.flight.effects"; readonly repo_run_id?: string; readonly status?: RepoFlightEffectRecord["status"]; readonly limit?: number }
  | { readonly kind: "repo.flight.runs"; readonly phase?: RepoFlightPhase; readonly limit?: number }
  | { readonly kind: "repo.flight.profile" }
  | { readonly kind: "repo.flight.telemetry"; readonly repo_run_id: string; readonly limit?: number };

export interface RepoFlightOperatorQueryEnvelope { readonly schema_version: 1; readonly query_id: string; readonly query: RepoFlightOperatorQuery }
export interface RepoFlightOperatorMetadata { readonly operation_id: string; readonly idempotency_key: string; readonly correlation_id: string; readonly actor_id: string; readonly requested_at: string; readonly expected_version?: string; readonly remote_session?: unknown; readonly session?: unknown }

export type RepoFlightOperatorCommand =
  | { readonly kind: "repo.flight.session.enroll"; readonly request: Omit<RepoFlightSessionManifestInput, "repository" | "process_start_token" | "host_boot_id" | "process_group"> & { readonly worktree_root?: string } }
  | { readonly kind: "repo.flight.session.reconcile"; readonly instance_id: string; readonly control_channel: "connected" | "disconnected" | "unknown" }
  | { readonly kind: "repo.flight.session.drain"; readonly instance_id: string }
  | { readonly kind: "repo.flight.session.quiesce"; readonly instance_id: string }
  | { readonly kind: "repo.flight.clearance.request"; readonly request: RepoFlightClearanceRequest }
  | { readonly kind: "repo.flight.clearance.renew"; readonly request: Parameters<RepoFlightAuthority["renew"]>[0] }
  | { readonly kind: "repo.flight.clearance.revoke"; readonly grant_id: string; readonly reason: string }
  | { readonly kind: "repo.flight.drain.request"; readonly request: { readonly request_id: string; readonly drain_id: string; readonly repo_run_id: string; readonly instance_id: string; readonly candidate: RepoFlightCandidateBinding; readonly ttl_ms: number } }
  | { readonly kind: "repo.flight.drain.ack"; readonly drain_id: string; readonly instance_id: string }
  | { readonly kind: "repo.flight.drain.activate"; readonly drain_id: string; readonly candidate: RepoFlightCandidateBinding }
  | { readonly kind: "repo.flight.drain.release"; readonly drain_id: string; readonly reason: string }
  | { readonly kind: "repo.flight.gate.request"; readonly request: RepoFlightGatePlanRequest }
  | { readonly kind: "repo.flight.gate.ack"; readonly plan_id: string; readonly instance_id: string }
  | { readonly kind: "repo.flight.gate.activate"; readonly plan_id: string }
  | { readonly kind: "repo.flight.gate.run"; readonly plan_id: string }
  | { readonly kind: "repo.flight.delivery.sent"; readonly request: RepoFlightSentInput }
  | { readonly kind: "repo.flight.delivery.transition"; readonly request: RepoFlightDeliveryTransitionInput }
  | { readonly kind: "repo.flight.effect.reconcile"; readonly transaction_id: string; readonly outcome: "applied" | "no_effect"; readonly result_digest: `sha256:${string}` }
  | { readonly kind: "repo.flight.run.create"; readonly repo_run_id: string; readonly base_oid?: string; readonly work_class?: "decision_bound" | "exploratory" }
  | { readonly kind: "repo.flight.run.authorize"; readonly repo_run_id: string; readonly attestation: unknown }
  | { readonly kind: "repo.flight.execution.schedule"; readonly request: RepoFlightExecutionScheduleRequest }
  | { readonly kind: "repo.flight.run.transition"; readonly repo_run_id: string; readonly to: RepoFlightPhase; readonly expected_revision: number; readonly bindings?: RepoFlightBindingPatch };

export interface RepoFlightOperatorCommandEnvelope { readonly schema_version: 1; readonly metadata: RepoFlightOperatorMetadata; readonly command: RepoFlightOperatorCommand }

export interface RepoFlightExecutionScheduleRequest {
  readonly repo_run_id: string;
  readonly instance_id: string;
  readonly mode: "snapshot" | "quiescent";
  readonly plan_input: Omit<RepoFlightExecutionPlanInput, "profile">;
  readonly signed_plan: unknown;
  readonly completed_gate_ids?: readonly string[];
}

export interface RepoFlightGateProjection extends Omit<RepoFlightGatePlan, "commands"> {
  /** Gate argv is intentionally excluded from operator projections. */
  readonly commands: readonly { readonly gate_id: string; readonly timeout_ms: number; readonly read_only: boolean }[];
}

export interface RepoFlightOperatorStatusProjection {
  readonly schema_version: 1;
  readonly repository_id: string;
  readonly as_of: string;
  readonly deployment: { readonly status: RepoFlightProfile["status"]; readonly profile_digest: RepoFlightProfile["profile_digest"]; readonly missing_control_count: number };
  readonly repo_runs: { readonly total: number; readonly by_phase: Readonly<Record<string, number>> };
  readonly sessions: { readonly total: number; readonly by_state: Readonly<Record<string, number>>; readonly fenced: number };
  readonly clearances: { readonly total: number; readonly active: number };
  readonly drains: { readonly total: number; readonly active: number };
  readonly deliveries: { readonly total: number; readonly by_state: Readonly<Record<string, number>> };
  readonly gate_broker_configured: boolean;
}

export type RepoFlightOperatorQueryResult =
  | { readonly ok: true; readonly capability: "repo.flight.read"; readonly value: RepoFlightOperatorStatusProjection | readonly RepoFlightSessionProjection[] | readonly RepoFlightClearanceRecord[] | readonly RepoFlightDrainRecord[] | RepoFlightGateProjection | readonly RepoFlightDeliveryProjection[] | readonly RepoFlightEffectRecord[] | readonly RepoFlightRunState[] | readonly RepoFlightTelemetryObservation[] | RepoFlightProfile }
  | { readonly ok: false; readonly capability: "repo.flight.read" | null; readonly error: { readonly code: "validation" | "not_found" | "unavailable"; readonly summary: string } };

export type RepoFlightOperatorCommandResult =
  | { readonly ok: true; readonly capability: "repo.flight.write"; readonly value: { readonly accepted: true; readonly operation_id: string; readonly projection: unknown } }
  | { readonly ok: true; readonly capability: "repo.flight.write"; readonly value: { readonly accepted: false; readonly operation_id: string; readonly error: { readonly code: "conflict" | "unavailable"; readonly summary: string } } }
  | { readonly ok: false; readonly capability: "repo.flight.write" | null; readonly error: { readonly code: "validation"; readonly summary: string } };
export type RepoFlightOperatorCommandAcknowledgement = Extract<RepoFlightOperatorCommandResult, { ok: true }>["value"];

export interface RepoFlightOperatorOptions {
  readonly lifecycle: Pick<RepoFlightLifecycleStore, "snapshot">;
  readonly enrollment: Pick<RepoFlightEnrollmentRegistry, "projections" | "projection" | "transition">;
  readonly authority: Pick<RepoFlightAuthority, "acquire" | "renew" | "beginDrain" | "acknowledgeDrain" | "activateQuiescence" | "releaseDrain" | "revoke" | "inspect" | "inspectDrains">;
  readonly gates?: Pick<RepoFlightGateCoordinator, "acknowledge" | "activate" | "run" | "inspect">;
  readonly deliveries: Pick<RepoFlightDeliveryAdapter, "recordSent" | "transition" | "list">;
  readonly effects?: Pick<RepoFlightEffectExecutor, "inspect" | "reconcile">;
  readonly telemetry?: Pick<RepoFlightTelemetryStore, "list">;
  readonly run_control?: { readonly create: (input: { readonly repo_run_id: string; readonly operation_id: string; readonly correlation_id: string; readonly base_oid?: string; readonly work_class?: "decision_bound" | "exploratory"; readonly proposer_identity?: string }) => RepoFlightRunState; readonly authorize: (repoRunId: string, attestation: unknown) => RepoFlightRunState; readonly schedule: (input: RepoFlightExecutionScheduleRequest) => unknown; readonly transition: (repoRunId: string, to: RepoFlightPhase, bindings?: RepoFlightBindingPatch) => RepoFlightRunState };
  readonly session_control?: { readonly enroll: (input: Omit<RepoFlightSessionManifestInput, "repository" | "process_start_token" | "host_boot_id" | "process_group"> & { readonly worktree_root?: string }) => RepoFlightSessionRecord; readonly reconcile: (channels: Readonly<Record<string, "connected" | "disconnected" | "unknown">>) => unknown };
  readonly profile: RepoFlightProfile;
  readonly now?: () => Date;
}

/** Operator composition only; domain authorities remain the sole state owners. */
export class RepoFlightOperatorService {
  private readonly drainTokens = new Map<string, string>();
  private readonly now: () => Date;
  constructor(private readonly options: RepoFlightOperatorOptions) { this.now = options.now ?? (() => new Date()); }

  executeQuery(input: unknown): RepoFlightOperatorQueryResult {
    if (!isRepoFlightOperatorQueryEnvelope(input)) return queryFailure("validation", "invalid repo-flight operator query envelope", null);
    const query = input.query;
    try {
      if (query.kind === "repo.flight.status") return querySuccess(this.status());
      if (query.kind === "repo.flight.sessions") return querySuccess(limit(this.options.enrollment.projections().filter((value) => query.state === undefined || value.state === query.state), query.limit));
      if (query.kind === "repo.flight.clearances") return querySuccess(limit(this.options.authority.inspect().filter((value) => query.status === undefined || value.status === query.status).map(projectClearance), query.limit));
      if (query.kind === "repo.flight.drains") return querySuccess(limit(this.options.authority.inspectDrains().filter((value) => query.status === undefined || value.status === query.status).map(projectDrain), query.limit));
      if (query.kind === "repo.flight.gate") { const plan = this.options.gates?.inspect(query.plan_id) ?? null; return plan === null ? queryFailure(this.options.gates === undefined ? "unavailable" : "not_found", this.options.gates === undefined ? "gate broker is not configured" : "gate plan was not found", "repo.flight.read") : querySuccess(projectGate(plan)); }
      if (query.kind === "repo.flight.deliveries") return querySuccess(limit(this.options.deliveries.list(query.repo_run_id, boundedLimit(query.limit)).filter((value) => query.state === undefined || value.state === query.state), query.limit));
      if (query.kind === "repo.flight.effects") return this.options.effects === undefined ? queryFailure("unavailable", "effect reconciler is not configured", "repo.flight.read") : querySuccess(limit(this.options.effects.inspect().filter((value) => (query.repo_run_id === undefined || value.repo_run_id === query.repo_run_id) && (query.status === undefined || value.status === query.status)), query.limit));
      if (query.kind === "repo.flight.runs") return querySuccess(limit(this.options.lifecycle.snapshot().runs.filter((value) => query.phase === undefined || value.phase === query.phase), query.limit));
      if (query.kind === "repo.flight.profile") return querySuccess(structuredClone(this.options.profile));
      if (query.kind === "repo.flight.telemetry") return this.options.telemetry === undefined ? queryFailure("unavailable", "telemetry store is not configured", "repo.flight.read") : querySuccess(this.options.telemetry.list(query.repo_run_id, boundedLimit(query.limit)));
      return assertNever(query);
    } catch (error) { return queryFailure("unavailable", boundedError(error), "repo.flight.read"); }
  }

  executeCommand(input: unknown): RepoFlightOperatorCommandResult {
    if (!isRepoFlightOperatorCommandEnvelope(input)) return commandFailure("invalid repo-flight operator command envelope");
    const { command, metadata } = input;
    try {
      if (command.kind === "repo.flight.session.enroll") { if (this.options.session_control === undefined) return rejected(metadata.operation_id, "session admission is not configured", "unavailable"); const record = this.options.session_control.enroll(command.request); const projection = this.options.enrollment.projection(record.manifest.instance_id); return projection === null ? rejected(metadata.operation_id, "enrolled session projection is unavailable") : accepted(metadata.operation_id, projection); }
      if (command.kind === "repo.flight.session.reconcile") { if (this.options.session_control === undefined) return rejected(metadata.operation_id, "session reconciliation is not configured", "unavailable"); this.options.session_control.reconcile({ [command.instance_id]: command.control_channel }); const projection = this.options.enrollment.projection(command.instance_id); return projection === null ? rejected(metadata.operation_id, "reconciled session projection is unavailable") : accepted(metadata.operation_id, projection); }
      if (command.kind === "repo.flight.session.drain" || command.kind === "repo.flight.session.quiesce") { this.options.enrollment.transition(command.instance_id, command.kind.endsWith("quiesce") ? "quiesced" : "draining"); const projection = this.options.enrollment.projections().find((value) => value.instance_id === command.instance_id); return projection === undefined ? rejected(metadata.operation_id, "transitioned session projection is unavailable") : accepted(metadata.operation_id, projection); }
      if (command.kind === "repo.flight.clearance.request") { const result = this.options.authority.acquire(command.request); return result.ok ? accepted(metadata.operation_id, projectClearance(result.grant)) : rejected(metadata.operation_id, result.summary); }
      if (command.kind === "repo.flight.clearance.renew") { const result = this.options.authority.renew(command.request); return result.ok ? accepted(metadata.operation_id, projectClearance(result.grant)) : rejected(metadata.operation_id, result.summary); }
      if (command.kind === "repo.flight.clearance.revoke") { const result = this.options.authority.revoke(command.grant_id, command.reason); return result === null ? rejected(metadata.operation_id, "clearance was not found") : accepted(metadata.operation_id, projectClearance(result)); }
      if (command.kind === "repo.flight.drain.request") { const result = this.options.authority.beginDrain(command.request); if (!result.ok) return rejected(metadata.operation_id, result.summary); this.drainTokens.set(result.drain.drain_id, result.token); return accepted(metadata.operation_id, projectDrain(result.drain)); }
      if (command.kind === "repo.flight.drain.ack") { const result = this.options.authority.acknowledgeDrain(command); return result.ok ? accepted(metadata.operation_id, projectDrain(result.drain)) : rejected(metadata.operation_id, result.summary); }
      if (command.kind === "repo.flight.drain.activate") { const token = this.drainTokens.get(command.drain_id); if (token === undefined) return rejected(metadata.operation_id, "drain credential is unavailable; replay its exact request after restart"); const result = this.options.authority.activateQuiescence({ ...command, token }); return result.ok ? accepted(metadata.operation_id, projectDrain(result.drain)) : rejected(metadata.operation_id, result.summary); }
      if (command.kind === "repo.flight.drain.release") { const token = this.drainTokens.get(command.drain_id); if (token === undefined) return rejected(metadata.operation_id, "drain credential is unavailable; replay its exact request after restart"); const result = this.options.authority.releaseDrain(token, command.reason); return result === null ? rejected(metadata.operation_id, "drain credential was rejected") : accepted(metadata.operation_id, projectDrain(result)); }
      if (command.kind === "repo.flight.gate.request") return rejected(metadata.operation_id, "direct gate requests are disabled; use a trusted profile-derived execution schedule", "unavailable");
      if (command.kind === "repo.flight.gate.ack") return this.gateResult(metadata.operation_id, this.options.gates?.acknowledge(command.plan_id, command.instance_id));
      if (command.kind === "repo.flight.gate.activate") return this.gateResult(metadata.operation_id, this.options.gates?.activate(command.plan_id));
      if (command.kind === "repo.flight.gate.run") return this.gateResult(metadata.operation_id, this.options.gates?.run(command.plan_id));
      if (command.kind === "repo.flight.delivery.sent") { const result = this.options.deliveries.recordSent(command.request); return result.ok ? accepted(metadata.operation_id, result.projection) : rejected(metadata.operation_id, result.reason); }
      if (command.kind === "repo.flight.delivery.transition") { const result = this.options.deliveries.transition(command.request); return result.ok ? accepted(metadata.operation_id, result.projection) : rejected(metadata.operation_id, result.reason); }
      if (command.kind === "repo.flight.effect.reconcile") { if (this.options.effects === undefined) return rejected(metadata.operation_id, "effect reconciler is not configured", "unavailable"); const result = this.options.effects.reconcile({ ...command, certified_by: metadata.actor_id }); return result.ok ? accepted(metadata.operation_id, result.record) : rejected(metadata.operation_id, result.summary); }
      if (command.kind === "repo.flight.run.create") { if (this.options.run_control === undefined) return rejected(metadata.operation_id, "repo-run control is not configured", "unavailable"); return accepted(metadata.operation_id, this.options.run_control.create({ repo_run_id: command.repo_run_id, operation_id: metadata.operation_id, correlation_id: metadata.correlation_id, proposer_identity: metadata.actor_id, ...(command.base_oid === undefined ? {} : { base_oid: command.base_oid }), ...(command.work_class === undefined ? {} : { work_class: command.work_class }) })); }
      if (command.kind === "repo.flight.run.authorize") { if (this.options.run_control === undefined) return rejected(metadata.operation_id, "repo-run control is not configured", "unavailable"); return accepted(metadata.operation_id, this.options.run_control.authorize(command.repo_run_id, command.attestation)); }
      if (command.kind === "repo.flight.execution.schedule") { if (this.options.run_control === undefined) return rejected(metadata.operation_id, "repo-run control is not configured", "unavailable"); return accepted(metadata.operation_id, this.options.run_control.schedule(command.request)); }
      if (command.kind === "repo.flight.run.transition") { if (this.options.run_control === undefined) return rejected(metadata.operation_id, "repo-run control is not configured", "unavailable"); const current = this.options.lifecycle.snapshot().runs.find((value) => value.repo_run_id === command.repo_run_id); if (current === undefined) return rejected(metadata.operation_id, "repo run was not found"); if (current.revision !== command.expected_revision) return rejected(metadata.operation_id, `expected repo-run revision ${command.expected_revision}, found ${current.revision}`); return accepted(metadata.operation_id, this.options.run_control.transition(command.repo_run_id, command.to, command.bindings)); }
      return assertNever(command);
    } catch (error) { return rejected(metadata.operation_id, boundedError(error)); }
  }

  private status(): RepoFlightOperatorStatusProjection {
    const runs = this.options.lifecycle.snapshot().runs, sessions = this.options.enrollment.projections();
    const clearances = this.options.authority.inspect(), drains = this.options.authority.inspectDrains(), deliveries = this.options.deliveries.list(undefined, 1_000);
    return Object.freeze({
      schema_version: 1, repository_id: this.options.profile.repository_id, as_of: canonicalInstant(this.now()),
      deployment: Object.freeze({ status: this.options.profile.status, profile_digest: this.options.profile.profile_digest, missing_control_count: this.options.profile.missing_controls.length }),
      repo_runs: Object.freeze({ total: runs.length, by_phase: countBy(runs.map((value) => value.phase)) }),
      sessions: Object.freeze({ total: sessions.length, by_state: countBy(sessions.map((value) => value.state)), fenced: sessions.filter((value) => value.fenced).length }),
      clearances: Object.freeze({ total: clearances.length, active: clearances.filter((value) => value.status === "active").length }),
      drains: Object.freeze({ total: drains.length, active: drains.filter((value) => value.status === "draining" || value.status === "quiesced").length }),
      deliveries: Object.freeze({ total: deliveries.length, by_state: countBy(deliveries.map((value) => value.state)) }),
      gate_broker_configured: this.options.gates !== undefined && this.options.profile.controls.gate_broker,
    });
  }

  private gateResult(operationId: string, result: ReturnType<RepoFlightGateCoordinator["request"]> | undefined): RepoFlightOperatorCommandResult {
    if (result === undefined) return rejected(operationId, "gate broker is not configured", "unavailable");
    return result.ok ? accepted(operationId, projectGate(result.plan)) : rejected(operationId, result.summary);
  }
}

export function isRepoFlightOperatorQueryEnvelope(value: unknown): value is RepoFlightOperatorQueryEnvelope {
  if (!exact(value, ["schema_version", "query_id", "query"]) || value.schema_version !== 1 || !identifier(value.query_id) || !record(value.query)) return false;
  const query = value.query;
  if (query.kind === "repo.flight.status" || query.kind === "repo.flight.profile") return exact(query, ["kind"]);
  if (query.kind === "repo.flight.telemetry") return exact(query, ["kind", "repo_run_id"], ["limit"]) && identifier(query.repo_run_id) && validLimit(query.limit);
  if (query.kind === "repo.flight.sessions") return exact(query, ["kind"], ["state", "limit"]) && (query.state === undefined || sessionState(query.state)) && validLimit(query.limit);
  if (query.kind === "repo.flight.clearances") return exact(query, ["kind"], ["status", "limit"]) && (query.status === undefined || clearanceStatus(query.status)) && validLimit(query.limit);
  if (query.kind === "repo.flight.drains") return exact(query, ["kind"], ["status", "limit"]) && (query.status === undefined || drainStatus(query.status)) && validLimit(query.limit);
  if (query.kind === "repo.flight.gate") return exact(query, ["kind", "plan_id"]) && identifier(query.plan_id);
  if (query.kind === "repo.flight.deliveries") return exact(query, ["kind"], ["repo_run_id", "state", "limit"]) && (query.repo_run_id === undefined || identifier(query.repo_run_id)) && (query.state === undefined || deliveryState(query.state)) && validLimit(query.limit);
  if (query.kind === "repo.flight.effects") return exact(query, ["kind"], ["repo_run_id", "status", "limit"]) && (query.repo_run_id === undefined || identifier(query.repo_run_id)) && (query.status === undefined || effectStatus(query.status)) && validLimit(query.limit);
  if (query.kind === "repo.flight.runs") return exact(query, ["kind"], ["phase", "limit"]) && (query.phase === undefined || runPhase(query.phase)) && validLimit(query.limit);
  return false;
}

export function isRepoFlightOperatorCommandEnvelope(value: unknown): value is RepoFlightOperatorCommandEnvelope {
  if (!exact(value, ["schema_version", "metadata", "command"]) || value.schema_version !== 1 || !validMetadata(value.metadata) || !record(value.command) || typeof value.command.kind !== "string") return false;
  const command = value.command;
  if (command.kind === "repo.flight.session.enroll") return exact(command, ["kind", "request"]) && record(command.request);
  if (command.kind === "repo.flight.session.reconcile") return exact(command, ["kind", "instance_id", "control_channel"]) && identifier(command.instance_id) && (command.control_channel === "connected" || command.control_channel === "disconnected" || command.control_channel === "unknown");
  if (command.kind === "repo.flight.session.drain" || command.kind === "repo.flight.session.quiesce") return exact(command, ["kind", "instance_id"]) && identifier(command.instance_id);
  if (command.kind === "repo.flight.clearance.request" || command.kind === "repo.flight.clearance.renew" || command.kind === "repo.flight.drain.request" || command.kind === "repo.flight.gate.request" || command.kind === "repo.flight.delivery.sent" || command.kind === "repo.flight.delivery.transition") return exact(command, ["kind", "request"]) && record(command.request);
  if (command.kind === "repo.flight.clearance.revoke") return exact(command, ["kind", "grant_id", "reason"]) && identifier(command.grant_id) && boundedText(command.reason);
  if (command.kind === "repo.flight.drain.ack" || command.kind === "repo.flight.gate.ack") return exact(command, ["kind", command.kind.includes("drain") ? "drain_id" : "plan_id", "instance_id"]) && identifier(command.instance_id) && identifier(command.kind.includes("drain") ? command.drain_id : command.plan_id);
  if (command.kind === "repo.flight.drain.activate") return exact(command, ["kind", "drain_id", "candidate"]) && identifier(command.drain_id) && record(command.candidate);
  if (command.kind === "repo.flight.drain.release") return exact(command, ["kind", "drain_id", "reason"]) && identifier(command.drain_id) && boundedText(command.reason);
  if (command.kind === "repo.flight.gate.activate" || command.kind === "repo.flight.gate.run") return exact(command, ["kind", "plan_id"]) && identifier(command.plan_id);
  if (command.kind === "repo.flight.effect.reconcile") return exact(command, ["kind", "transaction_id", "outcome", "result_digest"]) && identifier(command.transaction_id) && (command.outcome === "applied" || command.outcome === "no_effect") && digest(command.result_digest);
  if (command.kind === "repo.flight.run.create") return exact(command, ["kind", "repo_run_id"], ["base_oid", "work_class"]) && identifier(command.repo_run_id) && (command.base_oid === undefined || oid(command.base_oid)) && (command.work_class === undefined || command.work_class === "decision_bound" || command.work_class === "exploratory");
  if (command.kind === "repo.flight.run.authorize") return exact(command, ["kind", "repo_run_id", "attestation"]) && identifier(command.repo_run_id) && typeof command.attestation === "object" && command.attestation !== null;
  if (command.kind === "repo.flight.execution.schedule") {
    if (!exact(command, ["kind", "request"]) || !exact(command.request, ["repo_run_id", "instance_id", "mode", "plan_input", "signed_plan"], ["completed_gate_ids"]) || !identifier(command.request.repo_run_id) || !identifier(command.request.instance_id) || (command.request.mode !== "snapshot" && command.request.mode !== "quiescent") || !record(command.request.plan_input) || !record(command.request.signed_plan)) return false;
    return command.request.completed_gate_ids === undefined || (Array.isArray(command.request.completed_gate_ids) && command.request.completed_gate_ids.length <= 256 && command.request.completed_gate_ids.every(identifier) && new Set(command.request.completed_gate_ids).size === command.request.completed_gate_ids.length);
  }
  if (command.kind === "repo.flight.run.transition") return exact(command, ["kind", "repo_run_id", "to", "expected_revision"], ["bindings"]) && identifier(command.repo_run_id) && runPhase(command.to) && Number.isSafeInteger(command.expected_revision) && (command.expected_revision as number) >= 0 && (command.bindings === undefined || record(command.bindings));
  return false;
}


function projectClearance(record: RepoFlightClearanceRecord): RepoFlightClearanceRecord { return Object.freeze({ ...structuredClone(record), terminal_reason: record.terminal_reason === null ? null : redact(record.terminal_reason) }); }
function projectDrain(record: RepoFlightDrainRecord): RepoFlightDrainRecord { return Object.freeze({ ...structuredClone(record), terminal_reason: record.terminal_reason === null ? null : redact(record.terminal_reason) }); }
function projectGate(plan: RepoFlightGatePlan): RepoFlightGateProjection { return Object.freeze({
  ...structuredClone(plan),
  commands: Object.freeze(plan.commands.map((command) => Object.freeze({ gate_id: command.gate_id, timeout_ms: command.timeout_ms, read_only: command.read_only }))),
  attempts: Object.freeze(plan.attempts.map((attempt) => Object.freeze({ ...structuredClone(attempt), summary: redact(attempt.summary) }))),
  terminal_reason: plan.terminal_reason === null ? null : redact(plan.terminal_reason),
}); }
type RepoFlightOperatorQueryValue = Extract<RepoFlightOperatorQueryResult, { ok: true }>["value"];
function querySuccess<T extends RepoFlightOperatorQueryValue>(value: T): RepoFlightOperatorQueryResult { return { ok: true, capability: "repo.flight.read", value }; }
function queryFailure(code: "validation" | "not_found" | "unavailable", summary: string, capability: "repo.flight.read" | null): RepoFlightOperatorQueryResult { return { ok: false, capability, error: { code, summary: redact(summary) } }; }
function accepted(operationId: string, projection: unknown): RepoFlightOperatorCommandResult { return { ok: true, capability: "repo.flight.write", value: { accepted: true, operation_id: operationId, projection: structuredClone(projection) } }; }
function rejected(operationId: string, summary: string, code: "conflict" | "unavailable" = "conflict"): RepoFlightOperatorCommandResult { return { ok: true, capability: "repo.flight.write", value: { accepted: false, operation_id: operationId, error: { code, summary: redact(summary) } } }; }
function commandFailure(summary: string): RepoFlightOperatorCommandResult { return { ok: false, capability: null, error: { code: "validation", summary } }; }
function countBy(values: readonly string[]): Readonly<Record<string, number>> { const result: Record<string, number> = {}; for (const value of [...values].sort()) result[value] = (result[value] ?? 0) + 1; return Object.freeze(result); }
function limit<T>(values: readonly T[], requested?: number): readonly T[] { return Object.freeze(values.slice(0, boundedLimit(requested)).map((value) => structuredClone(value))); }
function boundedLimit(value: number | undefined): number { return value === undefined ? 200 : Math.min(value, 1_000); }
function validLimit(value: unknown): boolean { return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1_000); }
function validMetadata(value: unknown): value is RepoFlightOperatorMetadata { return exact(value, ["operation_id", "idempotency_key", "correlation_id", "actor_id", "requested_at"], ["expected_version", "remote_session", "session"]) && identifier(value.operation_id) && identifier(value.idempotency_key) && identifier(value.correlation_id) && identifier(value.actor_id) && instant(value.requested_at) && (value.expected_version === undefined || identifier(value.expected_version)) && (value.remote_session === undefined || record(value.remote_session)) && (value.session === undefined || record(value.session)); }
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> { if (!record(value)) return false; const admitted = new Set([...required, ...optional]); return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => admitted.has(key)); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value); }
function instant(value: unknown): value is string { return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value)); }
function boundedText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 512; }
function sessionState(value: unknown): value is RepoFlightSessionState { return typeof value === "string" && ["live", "draining", "quiesced", "disconnected", "dead_confirmed", "ambiguous"].includes(value); }
function clearanceStatus(value: unknown): value is RepoFlightClearanceStatus { return typeof value === "string" && ["active", "released", "revoked", "expired"].includes(value); }
function drainStatus(value: unknown): value is RepoFlightDrainStatus { return typeof value === "string" && ["draining", "quiesced", "released", "expired"].includes(value); }
function deliveryState(value: unknown): value is RepoFlightDeliveryState { return typeof value === "string" && ["sent", "claimed", "delivered", "acknowledged", "applied", "declined", "expired", "dead_lettered"].includes(value); }
function effectStatus(value: unknown): value is RepoFlightEffectRecord["status"] { return typeof value === "string" && ["prepared", "authorized", "dispatched", "applied", "no_effect", "ambiguous", "rejected"].includes(value); }
function runPhase(value: unknown): value is RepoFlightPhase { return typeof value === "string" && ["planned", "awaiting_governance", "governance_authorized", "admitted", "workspace_leased", "session_started", "candidate_ready", "verifying", "awaiting_review", "awaiting_acceptance", "adoptable", "adopted", "awaiting_operator", "draining", "interrupted", "recovering", "failed", "rejected", "exhausted", "abandoned"].includes(value); }
function digest(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function oid(value: unknown): value is string { return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
function canonicalInstant(now: Date): string { if (!Number.isFinite(now.getTime())) throw new Error("operator clock is invalid"); return now.toISOString(); }
function boundedError(error: unknown): string { return redact(error instanceof Error ? error.message : "repo-flight authority rejected the operation"); }
function redact(value: string): string { return value.replace(/(signing[_ -]?secret|api[_ -]?key|token|password)\s*[:=]\s*\S+/giu, "$1=[redacted]").replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ").slice(0, 512); }
function assertNever(value: never): never { throw new Error(`unsupported repo-flight operator kind ${(value as { kind?: string }).kind ?? "unknown"}`); }
