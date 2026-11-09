/**
 * Versioned, transport-neutral boundary between an operator client and the
 * canonical runtime.  This deliberately describes requests and projections;
 * it neither dispatches work nor owns any domain state.
 */

import type { Action, CampaignConfig, GateType } from "./types.js";
import { isSafeRelativePath, isValidCampaignId } from "./campaign-id.js";

export const RUNTIME_CONTRACT_VERSION = 1 as const;
export type RuntimeContractVersion = typeof RUNTIME_CONTRACT_VERSION;

export interface RuntimeCursor {
  stream_id: string;
  sequence: number;
}

export interface OperationMetadata {
  operation_id: string;
  idempotency_key: string;
  correlation_id: string;
  actor_id: string;
  requested_at: string;
  /** Required by mutations that must detect a stale projection. */
  expected_version?: string;
  /** Durable verifier attribution for an accepted opt-in remote request. */
  remote_session?: {
    session_id: string;
    key_id: string;
    certificate_id: string;
    nonce: string;
    issued_at: string;
    integrity: "ed25519";
    /** ADR-041 JCS signing preimage digest; never a raw proof or signature. */
    proof_digest?: `sha256:${string}`;
  };
}

export interface CampaignPlanReviewInput {
  plan_reviewed: boolean;
  resources_available: boolean;
}

/**
 * Optional, advisory shape for a caller-supplied lease on `recovery.retry`.
 * The real lease is always minted fresh, server-side, by
 * `RecoveryLeaseAuthority.acquireFresh` — a caller cannot know that lease
 * before the server mints it, so this can never be a required input. If
 * supplied, it is shape-validated and otherwise ignored; nothing downstream
 * of validation reads it. A caller with no lease to report (e.g. a fresh
 * client dispatching a retry for the first time) should simply omit it.
 */
export interface RecoveryLeaseInput {
  lease_id: string;
  worktree_id: string;
  expires_at: string;
}

export interface RecoveryAbandonAuthorization {
  authority: "operator" | "auditor";
  authorized_by: string;
  rationale: string;
}

export type ApplicationCommand =
  | { kind: "campaign.start"; campaign_id: string; plan_path: string; root_action: Action; config?: Partial<CampaignConfig>; plan_review?: CampaignPlanReviewInput }
  /** Manual halt authority is a durable approval record, verified by the catalog. */
  | { kind: "campaign.halt"; campaign_id: string; reason: "manual"; approval_id: string }
  | { kind: "tree.branch"; campaign_id: string; node_id: string; actions: Action[] }
  | { kind: "tree.prune"; campaign_id: string; node_id: string }
  | { kind: "operation.cancel"; target_operation_id: string }
  | { kind: "task.retry"; task_id: string }
  | { kind: "recovery.retry"; campaign_id: string; node_id: string; prior_operation_id: string; reason: string; lease?: RecoveryLeaseInput }
  | { kind: "recovery.abandon"; campaign_id: string; node_id: string; prior_operation_id: string; reason: string; authorization: RecoveryAbandonAuthorization };

export interface RuntimeCommandEnvelope {
  schema_version: RuntimeContractVersion;
  metadata: OperationMetadata;
  command: ApplicationCommand;
}

export type ApplicationQuery =
  | { kind: "campaign.list"; cursor?: RuntimeCursor; limit: number }
  | { kind: "campaign.snapshot"; campaign_id: string }
  | { kind: "campaign.tree"; campaign_id: string; cursor?: RuntimeCursor; limit: number }
  | { kind: "operation.get"; operation_id: string }
  | { kind: "task.list"; scope_id?: string; cursor?: RuntimeCursor; limit: number }
  | { kind: "event.resume"; cursor: RuntimeCursor };

export interface RuntimeQueryEnvelope {
  schema_version: RuntimeContractVersion;
  query_id: string;
  query: ApplicationQuery;
}

export type SupervisorTaskState =
  | "accepted"
  | "started"
  | "retrying"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "completed"
  | "timed_out";

export interface SupervisorTask {
  id: string;
  operation_id: string;
  kind: string;
  owner_scope_id: string;
  parent_id: string | null;
  state: SupervisorTaskState;
  started_at: string | null;
  deadline_at: string | null;
  progress: number | null;
  /** Last explicit progress observation; null for legacy snapshots with no timestamp. */
  last_progress_at: string | null;
  /** Last explicit liveness heartbeat; null until the runner reports one. */
  last_heartbeat_at: string | null;
  /** Monotonic within this task; equal timestamps remain ordered. */
  progress_sequence: number;
  retry_attempt: number;
  cleanup: "pending" | "completed" | "failed" | null;
}

export type RuntimeEvent =
  | { kind: "campaign.changed"; campaign_id: string; change: "created" | "halted" | "restored" }
  | { kind: "tree.node_changed"; campaign_id: string; node_id: string; state: string }
  | { kind: "gate.recorded"; campaign_id: string; node_id: string | null; gate: string; result: "pass" | "fail" | "bypass"; bypass_evidence_deficit?: string }
  | { kind: "kb.entry_added"; campaign_id: string; entry_id: string }
  | { kind: "audit.evidence_recorded"; campaign_id: string; evidence_id: string }
  | { kind: "operation.accepted"; accepted_operation_id: string }
  | { kind: "operation.rejected"; error: RuntimeError }
  | { kind: "task.changed"; task: SupervisorTask }
  | { kind: "taskcomposer.changed"; draft_id: string; status: "planning" | "awaiting_clarification" | "proposed" | "rejected" | "cancelled" | "admitted" | "failed" | "answered"; revision: number }
  | { kind: "stream.truncated"; stream_id: string; cursor: RuntimeCursor; dropped_records: number }
  | { kind: "tree.decomposed"; campaign_id: string; parent_id: string; children_ids: string[]; depth: number };

export interface RuntimeEventEnvelope {
  schema_version: RuntimeContractVersion;
  id: string;
  cursor: RuntimeCursor;
  occurred_at: string;
  correlation_id: string;
  causation_id?: string;
  operation_id?: string;
  event: RuntimeEvent;
  redacted: boolean;
}

export type RuntimeErrorCode =
  | "validation"
  | "permission"
  | "conflict"
  | "unavailable"
  | "transport"
  | "timeout"
  | "cancellation"
  | "corrupt_data"
  | "internal";

export interface RuntimeError {
  code: RuntimeErrorCode;
  severity: "info" | "warning" | "error" | "fatal";
  recoverable: boolean;
  source: string;
  summary: string;
  entity_id?: string;
  operation_id?: string;
  correlation_id?: string;
  diagnostic?: string;
  /** Preserved canonical gate remedy for command clients; absent on ordinary failures. */
  gate_refusal?: RuntimeGateRefusal;
}

/** Shared fields in the legacy command-client projection. */
interface RuntimeGateRefusalV1Base {
  schema_version: 1;
  kind: "gate.refusal";
  gate: GateType;
  correcting_actor: "campaign_author" | "worktree_operator" | "evidence_producer" | "auditor" | "runtime_operator";
  code: string;
  summary: string;
  remediation: string;
  next_command: string;
}

/** Legacy command-client projection retained while the canonical v2 remedy rolls out. */
export type RuntimeGateRefusalV1 = RuntimeGateRefusalV1Base & (
  | { state: "refused"; evidence_deficit: string }
  | { state: "unavailable"; evidence_deficit: null }
);

/**
 * The authority that refused an action. The four campaign process gates keep
 * their names; `capability` (ADR-028 tier / transport grant / authenticated
 * session), `budget` (native usage and campaign spend ceilings) and
 * `tool_veto` (a governed hook's preflight veto) are the non-gate refusal
 * authorities that project the same remedy shape instead of a parallel one.
 */
export type RuntimeRefusalAuthority = GateType | "capability" | "budget" | "tool_veto";
export type RuntimeRemedyActor = "operator" | "campaign_planner" | "specialist" | "runtime_host" | "caller";
export type RuntimeCorrectiveAction =
  | "repair_plan_or_config" | "restore_isolation" | "attach_verified_evidence" | "resolve_audit_findings" | "compose_gate_authority"
  | "grant_capability" | "reauthenticate" | "request_approval" | "raise_budget" | "revise_tool_call";

/**
 * Every (actor, action) pair an authority may assign for a `refused` remedy.
 * A remedy naming any other pair is rejected at every boundary: a valid
 * action key handed to an actor who cannot perform it is not a remedy.
 * `unavailable` is authority-independent: the runtime host composes the
 * missing authority (`compose_gate_authority`).
 */
export const RUNTIME_REFUSAL_REMEDIES: Readonly<Record<RuntimeRefusalAuthority, readonly Readonly<{ actor: RuntimeRemedyActor; action: RuntimeCorrectiveAction }>[]>> = Object.freeze({
  admission: Object.freeze([Object.freeze({ actor: "campaign_planner", action: "repair_plan_or_config" } as const)]),
  isolation: Object.freeze([Object.freeze({ actor: "runtime_host", action: "restore_isolation" } as const)]),
  evidence: Object.freeze([Object.freeze({ actor: "specialist", action: "attach_verified_evidence" } as const)]),
  audit: Object.freeze([Object.freeze({ actor: "operator", action: "resolve_audit_findings" } as const)]),
  // `request_approval` (ADR-179 amendment 2026-10-06): a read authorized by a
  // two-party approval record alone (`output.raw`) is refused for a missing,
  // pending, expired or mismatched record, which no session or tier change
  // can clear. The caller obtains a matching approval and retries.
  capability: Object.freeze([
    Object.freeze({ actor: "operator", action: "grant_capability" } as const),
    Object.freeze({ actor: "caller", action: "reauthenticate" } as const),
    Object.freeze({ actor: "caller", action: "request_approval" } as const),
  ]),
  budget: Object.freeze([Object.freeze({ actor: "operator", action: "raise_budget" } as const)]),
  tool_veto: Object.freeze([Object.freeze({ actor: "specialist", action: "revise_tool_call" } as const)]),
});

/** True when `actor` may perform `action` for this authority and projection state. */
export function isAuthorizedRefusalRemedy(state: unknown, authority: unknown, actor: unknown, action: unknown): boolean {
  if (state === "unavailable") return isRefusalAuthority(authority) && actor === "runtime_host" && action === "compose_gate_authority";
  if (state !== "refused" || !isRefusalAuthority(authority)) return false;
  return RUNTIME_REFUSAL_REMEDIES[authority].some((pair) => pair.actor === actor && pair.action === action);
}

export function isRefusalAuthority(value: unknown): value is RuntimeRefusalAuthority {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RUNTIME_REFUSAL_REMEDIES, value);
}

/** Canonical typed remedy projected by the refusing authority to its correcting actor. */
export interface RuntimeGateRefusalV2 {
  schema_version: 2;
  kind: "gate.refusal";
  state: "refused" | "unavailable";
  gate: RuntimeRefusalAuthority;
  correcting_actor: RuntimeRemedyActor;
  corrective_action: RuntimeCorrectiveAction;
  code: string;
  summary: string;
  evidence_deficit: string | null;
  remediation: string;
}

export type RuntimeGateRefusal = RuntimeGateRefusalV1 | RuntimeGateRefusalV2;

export type CommandAcknowledgement =
  | { accepted: true; operation_id: string }
  | { accepted: false; operation_id: string; error: RuntimeError };

export interface RuntimeContractViolation {
  path: string;
  message: string;
}

export type RuntimeValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; violations: RuntimeContractViolation[] };

// Dynamic boundary values are narrowed to object records; every field is still
// checked by the validators below before it enters a typed contract.
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalid(path: string, message: string): RuntimeValidationResult<never> {
  return { ok: false, violations: [{ path, message }] };
}

function valid<T>(value: T): RuntimeValidationResult<T> {
  return { ok: true, value };
}

function validateCursor(value: unknown, path: string): RuntimeValidationResult<RuntimeCursor> {
  if (!isRecord(value) || !isNonEmptyString(value.stream_id) || !isNonNegativeSafeInteger(value.sequence)) {
    return invalid(path, "must contain a non-empty stream_id and a non-negative integer sequence");
  }
  return valid({ stream_id: value.stream_id, sequence: value.sequence });
}

function validateMetadata(value: unknown): RuntimeValidationResult<OperationMetadata> {
  if (!isRecord(value) || !isNonEmptyString(value.operation_id) || !isNonEmptyString(value.idempotency_key)
    || !isNonEmptyString(value.correlation_id) || !isNonEmptyString(value.actor_id) || !isIsoTimestamp(value.requested_at)
    || (value.expected_version !== undefined && !isNonEmptyString(value.expected_version))
    || (value.remote_session !== undefined && !validRemoteSession(value.remote_session))) {
    return invalid("metadata", "must contain valid operation, idempotency, correlation, actor, timestamp, and optional expected version fields");
  }
  return valid({ operation_id: value.operation_id, idempotency_key: value.idempotency_key, correlation_id: value.correlation_id, actor_id: value.actor_id, requested_at: value.requested_at, ...(value.expected_version === undefined ? {} : { expected_version: value.expected_version }), ...(value.remote_session === undefined ? {} : { remote_session: { session_id: value.remote_session.session_id, key_id: value.remote_session.key_id, certificate_id: value.remote_session.certificate_id, nonce: value.remote_session.nonce, issued_at: value.remote_session.issued_at, integrity: "ed25519" as const, ...(value.remote_session.proof_digest === undefined ? {} : { proof_digest: value.remote_session.proof_digest as `sha256:${string}` }) } }) });
}

function validRemoteSession(value: unknown): value is NonNullable<OperationMetadata["remote_session"]> {
  return isRecord(value) && isNonEmptyString(value.session_id) && isNonEmptyString(value.key_id)
    && isNonEmptyString(value.certificate_id) && isNonEmptyString(value.nonce) && isIsoTimestamp(value.issued_at)
    && value.integrity === "ed25519" && (value.proof_digest === undefined || (typeof value.proof_digest === "string" && /^sha256:[a-f0-9]{64}$/i.test(value.proof_digest)));
}

function validateAction(value: unknown): value is Action {
  return isRecord(value) && isNonEmptyString(value.description) && typeof value.estimated_gain === "number" && Number.isFinite(value.estimated_gain)
    && typeof value.estimated_cost === "number" && Number.isFinite(value.estimated_cost) && value.estimated_cost >= 0
    && isNonEmptyString(value.category) && isNonEmptyString(value.delegate_to)
    && (value.constraints === undefined || (Array.isArray(value.constraints) && value.constraints.every(isNonEmptyString)))
    && (value.execution_role === undefined || value.execution_role === "architect" || value.execution_role === "documentation-writer")
    && validSkillSelection(value.skill_id, value.skill_version)
    && (value.skill_inputs === undefined || (value.skill_id !== undefined && value.skill_version !== undefined))
    && validSkillInputsClaim(value.skill_inputs, value.skill_inputs_provenance)
    && (value.high_risk_tool_scope === undefined || validHighRiskToolScope(value.high_risk_tool_scope));
}

function validSkillInputsClaim(inputs: unknown, provenance: unknown): boolean {
  if (inputs === undefined && provenance === undefined) return true;
  if (!isRecord(inputs) || !isRecord(provenance) || Object.keys(inputs).length === 0 || Object.keys(inputs).length > 16) return false;
  if (!Object.keys(provenance).every((key) => ["tag", "claimant", "command_name", "command_descriptor_hash", "input_hash"].includes(key)) || Object.keys(provenance).length !== 5) return false;
  return Object.entries(inputs).every(([name, value]) => /^[a-z][a-z0-9_]{0,31}$/.test(name) && typeof value === "string" && Buffer.byteLength(value, "utf8") <= 8 * 1024)
    && provenance.tag === "claimed" && provenance.claimant === "cli-command" && typeof provenance.command_name === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(provenance.command_name)
    && typeof provenance.command_descriptor_hash === "string" && /^sha256:[a-f0-9]{64}$/.test(provenance.command_descriptor_hash)
    && typeof provenance.input_hash === "string" && /^sha256:[a-f0-9]{64}$/.test(provenance.input_hash);
}

function validSkillSelection(skillId: unknown, version: unknown): boolean {
  if (skillId === undefined || version === undefined) return skillId === undefined && version === undefined;
  return typeof skillId === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(skillId) && typeof version === "string" && version.length <= 128 && SEMVER.test(version);
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function validHighRiskToolScope(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.write_paths) || !Array.isArray(value.command_argv)) return false;
  return value.write_paths.every((path) => isCanonicalRelativePath(path))
    && value.command_argv.every((entry) => isCommandArgvEntry(entry));
}

/** ADR-119: a `command_argv` entry is either a literal argv array or an intent (`argv_prefix`/`purpose`) entry. */
function isCommandArgvEntry(entry: unknown): boolean {
  if (Array.isArray(entry)) {
    return entry.length > 0 && entry.length <= 32 && entry.every((part) => typeof part === "string" && part.length > 0 && part.length <= 4_096 && !part.includes("\u0000"));
  }
  if (!isRecord(entry)) return false;
  return Array.isArray(entry.argv_prefix) && entry.argv_prefix.length > 0 && entry.argv_prefix.length <= 32
    && entry.argv_prefix.every((part) => typeof part === "string" && part.length > 0 && part.length <= 4_096 && !part.includes("\u0000"))
    && isNonEmptyString(entry.purpose) && (entry.purpose as string).length <= 4_096;
}

function isCanonicalRelativePath(value: unknown): value is string {
  return isSafeRelativePath(value);
}

function validateConfig(value: unknown): value is Partial<CampaignConfig> {
  if (!isRecord(value)) return false;
  if (value.max_seconds !== undefined && (typeof value.max_seconds !== "number" || !Number.isFinite(value.max_seconds) || value.max_seconds < 0)) return false;
  if (value.min_score !== undefined && (typeof value.min_score !== "number" || !Number.isFinite(value.min_score) || value.min_score < 0)) return false;
  if (value.convergence_iterations !== undefined && (!Number.isSafeInteger(value.convergence_iterations) || typeof value.convergence_iterations !== "number" || value.convergence_iterations < 1)) return false;
  return value.score_config === undefined || (isRecord(value.score_config) && typeof value.score_config.exploration_constant === "number" && Number.isFinite(value.score_config.exploration_constant) && value.score_config.exploration_constant > 0);
}

function validPlanReview(value: unknown): value is CampaignPlanReviewInput {
  return isRecord(value) && typeof value.plan_reviewed === "boolean" && typeof value.resources_available === "boolean";
}

function validRecoveryLease(value: unknown): value is RecoveryLeaseInput {
  return isRecord(value) && isNonEmptyString(value.lease_id) && isNonEmptyString(value.worktree_id) && isIsoTimestamp(value.expires_at);
}

function validAbandonAuthorization(value: unknown, actorId: string): value is RecoveryAbandonAuthorization {
  return isRecord(value) && (value.authority === "operator" || value.authority === "auditor")
    && value.authorized_by === actorId && isNonEmptyString(value.rationale);
}

function validateCommand(value: unknown, metadata: OperationMetadata): RuntimeValidationResult<ApplicationCommand> {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) return invalid("command", "must be a discriminated command object");
  const campaignId = isValidCampaignId(value.campaign_id) ? value.campaign_id : null;
  const nodeId = isNonEmptyString(value.node_id) ? value.node_id : null;
  switch (value.kind) {
    case "campaign.start": if (campaignId !== null && isNonEmptyString(value.plan_path) && validateAction(value.root_action) && (value.config === undefined || validateConfig(value.config)) && (value.plan_review === undefined || validPlanReview(value.plan_review))) return valid({ kind: value.kind, campaign_id: campaignId, plan_path: value.plan_path, root_action: value.root_action, ...(value.config === undefined ? {} : { config: value.config }), ...(value.plan_review === undefined ? {} : { plan_review: value.plan_review }) });
      return invalid("command", "campaign.start requires campaign_id, plan_path, full root_action, and valid optional config/plan_review");
    case "campaign.halt": if (campaignId !== null && value.reason === "manual" && isNonEmptyString(value.approval_id)) return valid({ kind: value.kind, campaign_id: campaignId, reason: value.reason, approval_id: value.approval_id });
      return invalid("command", "campaign.halt requires manual reason and a durable approval_id");
    case "tree.branch": if (campaignId !== null && nodeId !== null && Array.isArray(value.actions) && value.actions.length > 0 && value.actions.every(validateAction)) return valid({ kind: value.kind, campaign_id: campaignId, node_id: nodeId, actions: value.actions });
      return invalid("command", "tree.branch requires campaign_id, node_id, and one or more full actions");
    case "tree.prune": return campaignId !== null && nodeId !== null ? valid({ kind: value.kind, campaign_id: campaignId, node_id: nodeId }) : invalid("command", "tree.prune requires campaign_id and node_id");
    case "operation.cancel": return isNonEmptyString(value.target_operation_id) ? valid({ kind: value.kind, target_operation_id: value.target_operation_id }) : invalid("command", "operation.cancel requires target_operation_id");
    case "task.retry": return isNonEmptyString(value.task_id) ? valid({ kind: value.kind, task_id: value.task_id }) : invalid("command", "task.retry requires task_id");
    case "recovery.retry": if (campaignId !== null && nodeId !== null && metadata.expected_version !== undefined && isNonEmptyString(value.prior_operation_id) && isNonEmptyString(value.reason) && (value.lease === undefined || validRecoveryLease(value.lease))) return valid({ kind: value.kind, campaign_id: campaignId, node_id: nodeId, prior_operation_id: value.prior_operation_id, reason: value.reason, ...(value.lease === undefined ? {} : { lease: { lease_id: value.lease.lease_id, worktree_id: value.lease.worktree_id, expires_at: value.lease.expires_at } }) });
      return invalid("command", "recovery.retry requires campaign/node, prior operation, reason, expected version, and a well-formed lease if one is supplied");
    case "recovery.abandon": if (campaignId !== null && nodeId !== null && metadata.expected_version !== undefined && isNonEmptyString(value.prior_operation_id) && isNonEmptyString(value.reason) && validAbandonAuthorization(value.authorization, metadata.actor_id)) return valid({ kind: value.kind, campaign_id: campaignId, node_id: nodeId, prior_operation_id: value.prior_operation_id, reason: value.reason, authorization: { authority: value.authorization.authority, authorized_by: value.authorization.authorized_by, rationale: value.authorization.rationale } });
      return invalid("command", "recovery.abandon requires campaign/node, prior operation, reason, actor authorization, and expected version");
    default: return invalid("command.kind", `unsupported command kind ${JSON.stringify(value.kind)}`);
  }
}

export function validateRuntimeCommand(value: unknown): RuntimeValidationResult<RuntimeCommandEnvelope> {
  if (!isRecord(value) || value.schema_version !== RUNTIME_CONTRACT_VERSION) return invalid("schema_version", `must equal ${RUNTIME_CONTRACT_VERSION}`);
  const metadata = validateMetadata(value.metadata);
  if (!metadata.ok) return metadata;
  const command = validateCommand(value.command, metadata.value);
  if (!command.ok) return command;
  return valid({ schema_version: RUNTIME_CONTRACT_VERSION, metadata: metadata.value, command: command.value });
}

export function validateRuntimeQuery(value: unknown): RuntimeValidationResult<RuntimeQueryEnvelope> {
  if (!isRecord(value) || value.schema_version !== RUNTIME_CONTRACT_VERSION || !isNonEmptyString(value.query_id) || !isRecord(value.query) || !isNonEmptyString(value.query.kind)) {
    return invalid("query", "must be a versioned query with a non-empty query_id and kind");
  }
  const query = value.query;
  const hasLimit = Number.isSafeInteger(query.limit) && query.limit > 0;
  const optionalCursor = query.cursor === undefined || validateCursor(query.cursor, "query.cursor").ok;
  switch (query.kind) {
    case "campaign.list": return hasLimit && optionalCursor ? valid(value as RuntimeQueryEnvelope) : invalid("query", "campaign.list requires positive limit and optional cursor");
    case "campaign.snapshot": return isNonEmptyString(query.campaign_id) ? valid(value as RuntimeQueryEnvelope) : invalid("query.campaign_id", "must be non-empty");
    case "campaign.tree": return isNonEmptyString(query.campaign_id) && hasLimit && optionalCursor ? valid(value as RuntimeQueryEnvelope) : invalid("query", "campaign.tree requires campaign_id, positive limit, and optional cursor");
    case "operation.get": return isNonEmptyString(query.operation_id) ? valid(value as RuntimeQueryEnvelope) : invalid("query.operation_id", "must be non-empty");
    case "task.list": return hasLimit && optionalCursor && (query.scope_id === undefined || isNonEmptyString(query.scope_id)) ? valid(value as RuntimeQueryEnvelope) : invalid("query", "task.list requires positive limit, optional cursor, and optional non-empty scope_id");
    case "event.resume": return validateCursor(query.cursor, "query.cursor").ok ? valid(value as RuntimeQueryEnvelope) : invalid("query.cursor", "must be a valid cursor");
    default: return invalid("query.kind", `unsupported query kind ${JSON.stringify(query.kind)}`);
  }
}

export function validateRuntimeEvent(value: unknown): RuntimeValidationResult<RuntimeEventEnvelope> {
  if (!isRecord(value) || value.schema_version !== RUNTIME_CONTRACT_VERSION || !isNonEmptyString(value.id)
    || !isIsoTimestamp(value.occurred_at) || !isNonEmptyString(value.correlation_id) || typeof value.redacted !== "boolean") {
    return invalid("event", "must contain the canonical event envelope fields");
  }
  if (!validateCursor(value.cursor, "cursor").ok || !isRecord(value.event) || !isNonEmptyString(value.event.kind)) return invalid("event", "must contain a valid cursor and discriminated event");
  if ((value.causation_id !== undefined && !isNonEmptyString(value.causation_id)) || (value.operation_id !== undefined && !isNonEmptyString(value.operation_id))) return invalid("event", "optional IDs must be non-empty strings");
  const event = value.event;
  switch (event.kind) {
    case "campaign.changed": return isNonEmptyString(event.campaign_id) && ["created", "halted", "restored"].includes(String(event.change)) ? valid(value as RuntimeEventEnvelope) : invalid("event", "campaign.changed is invalid");
    case "tree.node_changed": return isNonEmptyString(event.campaign_id) && isNonEmptyString(event.node_id) && isNonEmptyString(event.state) ? valid(value as RuntimeEventEnvelope) : invalid("event", "tree.node_changed is invalid");
    case "gate.recorded": return isNonEmptyString(event.campaign_id) && (event.node_id === null || isNonEmptyString(event.node_id)) && isNonEmptyString(event.gate) && ["pass", "fail", "bypass"].includes(String(event.result)) ? valid(value as RuntimeEventEnvelope) : invalid("event", "gate.recorded is invalid");
    case "kb.entry_added": return isNonEmptyString(event.campaign_id) && isNonEmptyString(event.entry_id) ? valid(value as RuntimeEventEnvelope) : invalid("event", "kb.entry_added is invalid");
    case "audit.evidence_recorded": return isNonEmptyString(event.campaign_id) && isNonEmptyString(event.evidence_id) ? valid(value as RuntimeEventEnvelope) : invalid("event", "audit.evidence_recorded is invalid");
    case "operation.accepted": return isNonEmptyString(event.accepted_operation_id) ? valid(value as RuntimeEventEnvelope) : invalid("event", "operation.accepted is invalid");
    case "operation.rejected": return validateRuntimeError(event.error).ok ? valid(value as RuntimeEventEnvelope) : invalid("event.error", "operation.rejected requires a structured error");
    case "task.changed": {
      const task = validateSupervisorTask(event.task);
      return task.ok ? valid({ ...value, event: { ...event, task: task.value } } as RuntimeEventEnvelope) : invalid("event.task", "task.changed requires a valid task");
    }
    case "taskcomposer.changed": return isNonEmptyString(event.draft_id) && ["planning", "awaiting_clarification", "proposed", "rejected", "cancelled", "admitted", "failed", "answered"].includes(String(event.status)) && Number.isSafeInteger(event.revision) && event.revision >= 1 ? valid(value as RuntimeEventEnvelope) : invalid("event", "taskcomposer.changed is invalid");
    case "stream.truncated": return isNonEmptyString(event.stream_id) && validateCursor(event.cursor, "event.cursor").ok && Number.isSafeInteger(event.dropped_records) && event.dropped_records >= 0 ? valid(value as RuntimeEventEnvelope) : invalid("event", "stream.truncated is invalid");
    case "tree.decomposed": return isNonEmptyString(event.campaign_id) && isNonEmptyString(event.parent_id) && Array.isArray(event.children_ids) && event.children_ids.every(isNonEmptyString) && Number.isSafeInteger(event.depth) && event.depth >= 0 ? valid(value as RuntimeEventEnvelope) : invalid("event", "tree.decomposed is invalid");
    default: return invalid("event.kind", `unsupported event kind ${JSON.stringify(event.kind)}`);
  }
}

export function validateRuntimeError(value: unknown): RuntimeValidationResult<RuntimeError> {
  if (!isRecord(value) || !["validation", "permission", "conflict", "unavailable", "transport", "timeout", "cancellation", "corrupt_data", "internal"].includes(String(value.code))
    || !["info", "warning", "error", "fatal"].includes(String(value.severity)) || typeof value.recoverable !== "boolean" || !isNonEmptyString(value.source) || !isNonEmptyString(value.summary)) {
    return invalid("error", "must contain code, severity, recoverability, source, and summary");
  }
  for (const field of ["entity_id", "operation_id", "correlation_id", "diagnostic"]) if (value[field] !== undefined && !isNonEmptyString(value[field])) return invalid(`error.${field}`, "must be a non-empty string when present");
  if (value.gate_refusal !== undefined) {
    if (!isRuntimeGateRefusal(value.gate_refusal)) return invalid("error.gate_refusal", "must contain a complete typed gate remedy");
  }
  return valid(value as RuntimeError);
}

/** Boundary check for a v1 or v2 refusal remedy, shared by every consumer that accepts one. */
export function isRuntimeGateRefusal(value: unknown): value is RuntimeGateRefusal {
  if (!isRecord(value)) return false;
  const refusal = value;
  return refusal.kind === "gate.refusal"
    && (refusal.state === "refused" || refusal.state === "unavailable")
    && (refusal.schema_version === 1 || refusal.schema_version === 2)
    // V1 predates the non-gate refusal authorities and stays bound to the four gates.
    && (refusal.schema_version === 2 ? isRefusalAuthority(refusal.gate) : ["admission", "isolation", "evidence", "audit"].includes(String(refusal.gate)))
    && [refusal.code, refusal.summary, refusal.remediation].every(isNonEmptyString)
    && isValidGateRefusalEvidence(refusal)
    && (refusal.schema_version === 1 ? isLegacyGateRefusal(refusal) : isAuthorizedRefusalRemedy(refusal.state, refusal.gate, refusal.correcting_actor, refusal.corrective_action));
}

function correctingActorForGate(gate: unknown): RuntimeGateRefusalV1["correcting_actor"] | null {
  switch (gate) {
    case "admission": return "campaign_author";
    case "isolation": return "worktree_operator";
    case "evidence": return "evidence_producer";
    case "audit": return "auditor";
    default: return null;
  }
}

function isValidGateRefusalEvidence(refusal: Record<string, unknown>): boolean {
  if (refusal.state === "unavailable") return refusal.evidence_deficit === null;
  if (refusal.state !== "refused") return false;
  // V1's public type is state-discriminated: refusals always name a deficit.
  // V2 remains nullable because the canonical gate may have no specific
  // evidence deficit to report for a refused action.
  if (refusal.schema_version === 1) return isNonEmptyString(refusal.evidence_deficit);
  if (refusal.schema_version === 2) return refusal.evidence_deficit === null || isNonEmptyString(refusal.evidence_deficit);
  return false;
}

function isLegacyGateRefusal(refusal: Record<string, unknown>): boolean {
  return ["campaign_author", "worktree_operator", "evidence_producer", "auditor", "runtime_operator"].includes(String(refusal.correcting_actor))
    && (refusal.state === "unavailable" ? refusal.correcting_actor === "runtime_operator" : refusal.correcting_actor === correctingActorForGate(refusal.gate))
    && isNonEmptyString(refusal.next_command);
}

export function validateSupervisorTask(value: unknown): RuntimeValidationResult<SupervisorTask> {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.operation_id) || !isNonEmptyString(value.kind) || !isNonEmptyString(value.owner_scope_id)
    || (value.parent_id !== null && !isNonEmptyString(value.parent_id)) || !["accepted", "started", "retrying", "cancel_requested", "cancelled", "failed", "completed", "timed_out"].includes(String(value.state))
    || (value.started_at !== null && !isIsoTimestamp(value.started_at)) || (value.deadline_at !== null && !isIsoTimestamp(value.deadline_at))
    || (value.progress !== null && (typeof value.progress !== "number" || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1))
    || (value.last_progress_at !== undefined && value.last_progress_at !== null && !isIsoTimestamp(value.last_progress_at))
    || (value.last_heartbeat_at !== undefined && value.last_heartbeat_at !== null && !isIsoTimestamp(value.last_heartbeat_at))
    || (value.progress_sequence !== undefined && !isNonNegativeSafeInteger(value.progress_sequence))
    || !Number.isSafeInteger(value.retry_attempt) || value.retry_attempt < 0 || (value.cleanup !== null && !["pending", "completed", "failed"].includes(String(value.cleanup)))) {
    return invalid("task", "must contain a valid durable supervisor task shape");
  }
  // Older durable snapshots predate explicit progress/heartbeat clocks. Keep
  // them readable without inventing timestamps; new writes always include all
  // three fields.
  return valid({
    ...value,
    last_progress_at: value.last_progress_at ?? null,
    last_heartbeat_at: value.last_heartbeat_at ?? null,
    progress_sequence: value.progress_sequence ?? 0,
  } as SupervisorTask);
}
