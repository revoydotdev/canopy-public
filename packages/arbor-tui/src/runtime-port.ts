/**
 * Canonical runtime command/query bus for operational TUI screens (roadmap 4C,
 * ADR-011). The TUI is a unidirectional projection over canonical runtime
 * services: it never reimplements the runtime or the catalog, and it never
 * imports `@arbor/mcp`. This module is a TUI-owned structural mirror of the
 * runtime catalog's command/query surface so screens can request a real round
 * trip through an injected port. A concrete adapter (composed where the live
 * runtime is composed) supplies the actual catalog transport; absent backend
 * capabilities are simply not offered by the transport's granted set.
 *
 * The kind unions are locked to the catalog's `supported: true` set so no
 * screen can claim an unimplemented control is wired. Commands that require
 * idempotency keys ALWAYS carry one; every command/query carries bounds.
 */

import type {
  GateType,
  RuntimeCursor,
  RuntimeEventSubscription,
  RuntimeResumeResult,
  RuntimeSubscriptionOptions,
} from "@arbor/core";

export type RuntimeCommandKind =
  | "campaign.start"
  | "campaign.halt"
  | "tree.branch"
  | "tree.prune"
  | "tree.interrupt"
  | "operation.cancel"
  | "task.retry"
  | "recovery.retry"
  | "recovery.abandon"
  | "communication.record"
  | "output.capture"
  | "surveillance.scan"
  | "context.artifact.capture"
  | "fold.propose"
  | "fold.approve"
  | "fold.rollback"
  | "playbook.propose"
  | "playbook.approve"
  | "harness.propose"
  | "harness.approve"
  | "harness.rollback"
  | "harness.evaluate"
  | "harness.promote"
  | "subagent.execute"
  | "harness.evaluation.start"
  | "harness.quarantine"
  | "taskcomposer.submit"
  | "taskcomposer.answer"
  | "taskcomposer.confirm"
  | "taskcomposer.cancel"
  | "taskcomposer.retry"
  | "taskcomposer.reject"
  | "result.adopt"
  | "result.scope.authorize"
  | "result.revert"
  | "result.review.comment"
  | "result.review.request_revision"
  | "result.review.editor_handoff"
  | "bus.thread.send"
  | "bus.thread.ack"
  | "bus.record"
  | "peer.grant"
  | "compaction.record"
  | "a2a.send"
  | "a2a.receive"
  | "job.submit"
  | "job.cancel"
  | "job.retry"
  | "job.pause"
  | "job.resume"
  | "approval.request"
  | "approval.approve"
  | "approval.reject"
  | "approval.expire"
  | "userinput.ask"
  | "userinput.answer"
  | "harness.session.interrupt"
  | "harness.session.steer"
  | "harness.session.resume"
  | "harness.session.fork"
  | "harness.session.respawn"
  | "migration.apply"
  | "migration.rollback"
  | "integration.install"
  | "integration.enable"
  | "integration.disable"
  | "integration.update"
  | "session.identity.mutate"
  | "notification.read"
  | "followup.create"
  | "trust.session.enroll"
  | "trust.session.rotate"
  | "trust.session.revoke";

export type RuntimeQueryKind =
  | "campaign.list"
  | "campaign.snapshot"
  | "campaign.tree"
  | "operation.get"
  | "inspect.action"
  | "operation.list"
  | "recovery.pending"
  | "task.list"
  | "event.resume"
  | "communication.selection"
  | "communication.history"
  | "output.descriptor"
  | "output.list"
  | "output.raw"
  | "surveillance.findings"
  | "capability.introspect"
  | "governance.snapshot"
  | "governance.backlog"
  | "kb.list"
  | "audit.list"
  | "config.get"
  | "native.budget.get"
  | "agent.list"
  | "job.list"
  | "approval.list"
  | "userinput.list"
  | "userinput.awaiting"
  | "compaction.list"
  | "compaction.guard"
  | "sibling.status"
  | "bus.thread.history"
  | "bus.history"
  | "a2a.cards"
  | "context.overlays"
  | "context.governance"
  | "subagent.executions"
  | "harness.evaluation.candidates"
  | "harness.evaluation.runs"
  | "harness.evaluation.detail"
  | "harness.connector.inventory"
  | "harness.native.readiness"
  | "project.registry.list"
  | "project.manage"
  | "trust.session.list"
  | "trust.session.status"
  // "devtools.stream" is the one deliberate, permanent exception to this
  // module's own header comment ("locked to the catalog's supported: true
  // set"): it has NO corresponding RUNTIME_CATALOG entry and is never
  // routed through RuntimeCatalogRouter at all. It is intercepted by the
  // concrete adapter's `query()` before reaching the router — see
  // packages/arbor-mcp/src/tui-adapter.ts's `RuntimePortAdapter.query()`
  // justification comment (CS-11) and packages/arbor-mcp/src/tui.ts's
  // `runTui` grant comment, both of which explain why: the devtools ring is
  // this process's own ephemeral in-memory buffer, not campaign/governance
  // state the router owns, and giving the router a back-reference to it
  // would invert ADR-011's adapter-wraps-router direction.
  // packages/arbor-mcp/tests/boundary-parity.test.ts documents this same
  // exception explicitly rather than pinning it as an open defect.
  | "devtools.stream"
  | "harness.session.list"
  | "harness.session.inspect"
  | "harness.session.events"
  | "harness.session.attach"
  | "taskcomposer.list"
  | "taskcomposer.get"
  | "result.list"
  | "result.inspect"
  | "result.review.workspace"
  | "doctor.get"
  | "migration.inspect"
  | "integration.list"
  | "remote.inspect"
  | "scheduler.inspect"
  | "session.identity.search"
  | "session.identity.get"
  | "result.verification.list"
  | "result.verification.get"
  | "notification.list"
  | "followup.list"
  | "harness.session.availability"
  | "control.status"
  | "control.discover"
  | "control.inbox";

/** Structured, bounded error surfaced by the canonical runtime (structural mirror). */
export interface RuntimeError {
  readonly code:
    | "validation"
    | "permission"
    | "conflict"
    | "unavailable"
    | "corrupt_data"
    | "timeout"
    | "transport"
    | "internal";
  readonly summary: string;
  readonly diagnostic?: string;
  /** Typed gate remedy preserved for command-result consumers. */
  readonly gate_refusal?: RuntimeGateRefusal;
}

/** Legacy gate-refusal payload retained during the typed remedy rollout. */
export type RuntimeGateRefusalV1 = {
  readonly schema_version: 1;
  readonly kind: "gate.refusal";
  readonly gate: GateType;
  readonly correcting_actor:
    | "campaign_author"
    | "worktree_operator"
    | "evidence_producer"
    | "auditor"
    | "runtime_operator";
  readonly code: string;
  readonly summary: string;
  readonly remediation: string;
  readonly next_command: string;
} & (
  | { readonly state: "refused"; readonly evidence_deficit: string }
  | { readonly state: "unavailable"; readonly evidence_deficit: null }
);

/** Typed remedy projected by the gate authority to its correcting actor. */
export interface RuntimeGateRefusalV2 {
  readonly schema_version: 2;
  readonly kind: "gate.refusal";
  readonly state: "refused" | "unavailable";
  /** A process gate, or a non-gate refusal authority projecting the same remedy shape. */
  readonly gate: GateType | "capability" | "budget" | "tool_veto";
  readonly correcting_actor: "operator" | "campaign_planner" | "specialist" | "runtime_host" | "caller";
  readonly corrective_action:
    | "repair_plan_or_config"
    | "restore_isolation"
    | "attach_verified_evidence"
    | "resolve_audit_findings"
    | "compose_gate_authority"
    | "grant_capability"
    | "reauthenticate"
    | "request_approval"
    | "raise_budget"
    | "revise_tool_call";
  readonly code: string;
  readonly summary: string;
  readonly evidence_deficit: string | null;
  readonly remediation: string;
}

export type RuntimeGateRefusal = RuntimeGateRefusalV1 | RuntimeGateRefusalV2;

export type RuntimeResult<T> =
  | { readonly ok: true; readonly value: T; readonly capability: string }
  | { readonly ok: false; readonly error: RuntimeError; readonly capability: string | null };

export interface RuntimeCommandMeta {
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly expected_version?: string;
}

/** Bounded command/query envelope structural mirrors. */
export interface RuntimeCommandRequest<K extends RuntimeCommandKind = RuntimeCommandKind> {
  readonly kind: K;
  readonly metadata: RuntimeCommandMeta;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface RuntimeQueryRequest<K extends RuntimeQueryKind = RuntimeQueryKind> {
  readonly kind: K;
  readonly query_id: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * The injected transport seam. Screens never touch the catalog or manager
 * directly — they dispatch commands/queries through this port and reduce on
 * the surfaced result. Implementations are responsible for idempotency-key
 * generation, capability gating, bounds, and (for raw output) transport
 * authorization; the port itself only states the contract.
 */
export interface RuntimePort {
  /** Dispatch a canonical command and await an idempotent acknowledgement. */
  command<K extends RuntimeCommandKind>(
    request: RuntimeCommandRequest<K>,
  ): Promise<RuntimeResult<RuntimeCommandAcknowledgement>>;
  /** Execute a canonical query and await a bounded projection. */
  query<K extends RuntimeQueryKind>(
    request: RuntimeQueryRequest<K>,
  ): Promise<RuntimeResult<unknown>>;
  /** Number of active runtime operations; bounded live view, never a durable counter. */
  activeOperationCount(): number;
  /** M1.1 read-side event seam (see `RuntimeEventSource`); absent when no real event stream is composed behind this port. */
  readonly events?: RuntimeEventSource;
}

export interface RuntimeCommandAcknowledgement {
  readonly accepted: boolean;
  readonly operation_id: string;
  readonly error?: RuntimeError;
}

/**
 * M1.1: the read-side sibling to `RuntimePort`. It exists so a TUI-owned
 * read-model projection (`read-model.ts`) can be fed the same canonical
 * `RuntimeEventEnvelope`s the catalog's `event.resume` query already serves,
 * through a bounded, capability-checked seam — never a second, competing
 * write path into runtime state. Reusing `@arbor/core`'s own
 * `RuntimeCursor`/`RuntimeEventEnvelope`/`RuntimeEventSubscription` contracts
 * rather than redefining them keeps this a structural mirror, the same
 * discipline `RuntimePort` itself follows for commands/queries.
 *
 * Closing or simply dropping a subscription must never cancel any runtime
 * work in flight — a subscriber is a read-only observer of a bounded queue,
 * not a lease on anything.
 */
export interface RuntimeEventSource {
  /**
   * Open a bounded live subscription to the canonical event stream. A full
   * queue closes the subscription (reason `"backpressure"`); it never
   * silently drops events instead.
   */
  subscribe(options?: RuntimeSubscriptionOptions): RuntimeEventSubscription;
  /**
   * Resume from a cursor through the catalog's own `event.resume` query, so
   * the read side stays subject to the same capability gate as every other
   * query. `null` requests "from the beginning" using the same
   * `{stream_id, sequence: 0}` convention `tui.ts`'s diagnostics screen
   * already relies on for `event.resume` — `ApplicationQuery`'s own
   * `event.resume` case (arbor-core/src/runtime-contracts.ts) requires a
   * real `RuntimeCursor`, never a bare `null`, so this is the one shape that
   * can mean "no prior cursor" and still validate. Rejects the returned
   * promise if the capability is denied — callers must treat a caught
   * rejection as "could not resume", not as an empty result.
   */
  resume(cursor: RuntimeCursor | null): Promise<RuntimeResumeResult<unknown>>;
}

/**
 * `RuntimePort` implementations MAY offer the read-side event seam.
 * Optional because not every host (e.g. `headless.ts`'s demo client) wires a
 * real canonical event stream behind it.
 */
export interface RuntimePortWithEvents extends RuntimePort {
  readonly events: RuntimeEventSource;
}

/** Bounds enforced by the runtime port for every surface (structural contract). */
export const RUNTIME_PORT_LIMITS = Object.freeze({
  max_command_params: 64,
  max_query_params: 64,
  max_operation_id_length: 128,
  max_idempotency_key_length: 256,
  max_query_result_records: 1_000,
  active_operation_cap: 10_000,
} as const);

export type RuntimePortLimits = typeof RUNTIME_PORT_LIMITS;
