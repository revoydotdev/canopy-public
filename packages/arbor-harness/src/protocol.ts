/**
 * revoy2-owned inward contract for a subordinate harness.
 *
 * This surface deliberately describes revoy2 lifecycle facts, rather than an
 * external provider's wire format.  In particular, a connector may retain its
 * raw events separately, but it may not use them as canonical authority here.
 */
import type { Provenance } from "@arbor/core";
import type { CapabilityRequirement, CapabilitySupport } from "./capabilities.js";

export const HARNESS_PROTOCOL_VERSION = "1" as const;

export type FilesystemIsolation = "read_only" | "workspace_write" | "isolated";
export type ApprovalBehavior = "always" | "on_risk" | "never";

/**
 * Ordered policy lists are retained for auditability.  Deny matching is
 * evaluated independently and therefore wins regardless of list ordering.
 */
export interface ExecutionPolicy {
  readonly filesystem: FilesystemIsolation;
  readonly approvals: ApprovalBehavior;
  readonly tool_allow: readonly string[];
  readonly tool_deny: readonly string[];
  readonly workspace_roots: readonly string[];
  readonly max_wall_clock_ms: number;
  readonly max_events: number;
  readonly network_allowed: boolean;
  readonly ambient_plugins_allowed: boolean;
  readonly user_configuration_allowed: boolean;
  readonly inherited_credentials_allowed: boolean;
}

export type SessionLineage =
  | { readonly kind: "new" }
  | { readonly kind: "resume"; readonly source_session_id: string; readonly checkpoint: number }
  | { readonly kind: "fork"; readonly source_session_id: string; readonly checkpoint: number }
  /**
   * A fresh session linked to a durable session owned by a prior process.
   * Unlike resume/fork, the source is not imported into this engine. A
   * composition-owned admission callback must prove the durable authority.
   */
  | { readonly kind: "continuation"; readonly source_session_id: string; readonly checkpoint: number; readonly authorization_id: string; readonly continuation_kind?: "resume" | "fork" | "respawn" };

export interface SessionStartRequest {
  /** Caller-provided identifiers make replay fixtures and audit joins stable. */
  readonly session_id: string;
  readonly policy: ExecutionPolicy;
  readonly required_capabilities: readonly CapabilityRequirement[];
  readonly lineage: SessionLineage;
  readonly ephemeral: boolean;
  /** Composition identity only; response revision is an observation, not authority. */
  readonly model_identity?: NativeSessionModelIdentity;
}

/** Content-free model identity persisted with the lifecycle admission event. */
export interface NativeSessionModelIdentity {
  readonly provider_id: string;
  readonly model_id: string;
  readonly configured_revision: string | null;
  readonly revision: string | null;
}

export type SessionState = "running" | "interrupt_requested" | "completed" | "failed" | "interrupted";
export type TerminalSessionState = Extract<SessionState, "completed" | "failed" | "interrupted">;

export interface EventEnvelope<K extends string, P> {
  readonly protocol_version: typeof HARNESS_PROTOCOL_VERSION;
  readonly session_id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly kind: K;
  readonly payload: P;
}

export type LifecycleEvent = EventEnvelope<"lifecycle", {
  readonly state: "started";
  readonly lineage: SessionLineage;
  readonly ephemeral: boolean;
  readonly model_identity?: NativeSessionModelIdentity;
}>;
export type ModelTextEvent = EventEnvelope<"model_text", { readonly text: string; readonly phase: "commentary" | "final" }>;
/**
 * Content-free per-turn routing evidence. A session can select distinct model
 * children over its lifetime, so this fact intentionally does not overload
 * the one admission-time lifecycle model identity.
 */
export type ModelRouteEvent = EventEnvelope<"model_route", {
  readonly route: "tool_capable" | "non_tool";
  readonly provider_id: string;
  readonly model_id: string;
  readonly configured_revision: string | null;
  readonly revision: string | null;
}>;
/** Content-free provenance joins: intent can be audited without replaying context text. */
export interface NativeToolOperationAnnotations {
  /** Effect class is a host declaration for this exact call, never model input. */
  readonly effect_kind: "read_only" | "file_write" | "file_patch" | "shell" | "external" | "unknown";
  readonly read_only: boolean;
  readonly repeatable: boolean;
  readonly mutating: boolean;
  readonly destructive: boolean;
  readonly open_world: boolean;
  /** The operation is owned by the session that encloses this event. */
  readonly ownership: "session";
}

export type ToolIntentEvent = EventEnvelope<"tool_intent", {
  readonly tool: string;
  readonly input_summary: string;
  /** Host-derived per-call hints; absence is permitted only for legacy events. */
  readonly annotations?: NativeToolOperationAnnotations;
  readonly context_refs?: readonly { readonly entry_id: string; readonly provenance: Provenance }[];
}>;
/**
 * A tool result describes whether the governed host actually accepted and
 * completed an action.  `success` is retained as a convenient boolean, but
 * consumers must use the typed outcome/effect evidence when deciding what a
 * result proves.  No tool input, output, credential, or path is included.
 */
export type NativeToolExecutionOutcome = "succeeded" | "refused" | "failed" | "cancelled" | "truncated";
export type NativeToolExecutionStage = "semantic" | "audit" | "sandbox" | "execution";
/** A host can prove a local write, observe a read, or honestly leave an external effect unknown. */
export type NativeToolEffect = "none" | "observed" | "applied" | "unknown";
export type ConfinementGrade = "application_validated" | "os_confined" | "container_confined" | "remote_attested";
export interface NativeToolActionScopeEvidence {
  readonly status: "not_required" | "bound" | "absent" | "invalid";
  /** One-way identifier; the durable stream never exposes a raw scope id. */
  readonly scope_id_hash?: string;
  readonly provenance_tag?: Provenance["tag"];
}
export interface NativeToolExecutionEvidence {
  readonly outcome: NativeToolExecutionOutcome;
  readonly stage: NativeToolExecutionStage;
  readonly code: string;
  readonly effect: NativeToolEffect;
  /** Legacy injected tool ports may omit this; the worker normalizes them to application_validated before recording. */
  readonly confinement?: ConfinementGrade;
  readonly action_scope: NativeToolActionScopeEvidence;
}
export type ToolResultEvent = EventEnvelope<"tool_result", {
  readonly tool: string;
  readonly result_summary: string;
  readonly success: boolean;
  readonly evidence: NativeToolExecutionEvidence;
  /** Content-free identity linking this observed tool outcome to later reuse. */
  readonly operation_id?: string;
  /** Prior result operation whose bounded context reference was reused. */
  readonly reused_from_operation_id?: string;
  /** Bounded context entry id for the prior result; carries no result content. */
  readonly reused_context_entry_id?: string;
}>;
export type ApprovalRequestedEvent = EventEnvelope<"approval_requested", { readonly request_id: string; readonly subject: string }>;
export type ApprovalResolvedEvent = EventEnvelope<"approval_resolved", { readonly request_id: string; readonly approved: boolean; readonly rationale: string }>;
export type UsageEvent = EventEnvelope<"usage", { readonly input_tokens: number | null; readonly output_tokens: number | null; readonly unavailable_reason?: string }>;
export type ArtifactEvent = EventEnvelope<"artifact", { readonly artifact_id: string; readonly media_type: string; readonly provenance: Provenance }>;
export type DiagnosticEvent = EventEnvelope<"diagnostic", {
  readonly code: string;
  readonly message: string;
  /** Content-free retry facts may cross the operator redaction boundary. */
  readonly retry?: {
    readonly attempt: number;
    readonly max_attempts: number;
    readonly delay_ms: number;
    readonly failure_kind: "timeout" | "transport" | "http" | "protocol" | "credential" | "unknown";
  };
}>;
export type InterruptRequestedEvent = EventEnvelope<"interrupt_requested", { readonly reason: string }>;

export type Completion =
  | { readonly result: "claimed"; readonly message: string; readonly provenance: Extract<Provenance, { tag: "claimed" }> }
  | { readonly result: "verified"; readonly message: string; readonly provenance: Extract<Provenance, { tag: "verified" }> }
  | { readonly result: "failed"; readonly message: string; readonly provenance: Provenance };

/** A completion that is ready to be signaled by the native session engine. */
export type NativeSignaledCompletion = Extract<Completion, { readonly result: "claimed" | "verified" }>;

/**
 * Source-native governance may veto a proposed completion immediately before
 * it is signaled. Its result has no replacement payload, so it cannot rewrite
 * text, change provenance, promote a claim, or grant capabilities.
 */
export interface NativePreSignalCompletionGuard {
  authorize(input: {
    readonly session_id: string;
    readonly completion: NativeSignaledCompletion;
  }, signal: AbortSignal): Promise<"allow" | "deny">;
}

export type TerminalCause = "completed" | "failed" | "interrupted" | "wall_clock_limit" | "event_limit";
export type TerminalEvent = EventEnvelope<"terminal", {
  readonly state: TerminalSessionState;
  readonly cause: TerminalCause;
  readonly message: string;
  /** Only caller-supplied completion evidence is present; operational stops have none. */
  readonly provenance?: Provenance;
  readonly result?: Completion["result"];
}>;

/** Unrecognized connector material is preserved, but cannot become authority. */
export type OpaqueEvidenceEvent = EventEnvelope<"opaque_evidence", { readonly connector_kind: string; readonly payload: unknown }>;

export type SessionEvent =
  | LifecycleEvent
  | ModelTextEvent
  | ModelRouteEvent
  | ToolIntentEvent
  | ToolResultEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | UsageEvent
  | ArtifactEvent
  | DiagnosticEvent
  | InterruptRequestedEvent
  | TerminalEvent
  | OpaqueEvidenceEvent;

export type SessionEventInput =
  | { readonly kind: "model_text"; readonly payload: ModelTextEvent["payload"] }
  | { readonly kind: "model_route"; readonly payload: ModelRouteEvent["payload"] }
  | { readonly kind: "tool_intent"; readonly payload: ToolIntentEvent["payload"] }
  | { readonly kind: "tool_result"; readonly payload: ToolResultEvent["payload"] }
  | { readonly kind: "approval_requested"; readonly payload: ApprovalRequestedEvent["payload"] }
  | { readonly kind: "approval_resolved"; readonly payload: ApprovalResolvedEvent["payload"] }
  | { readonly kind: "usage"; readonly payload: UsageEvent["payload"] }
  | { readonly kind: "artifact"; readonly payload: ArtifactEvent["payload"] }
  | { readonly kind: "diagnostic"; readonly payload: DiagnosticEvent["payload"] }
  | { readonly kind: "opaque_evidence"; readonly payload: OpaqueEvidenceEvent["payload"] };

export interface SessionInspection {
  readonly session_id: string;
  readonly state: SessionState;
  readonly policy: ExecutionPolicy;
  readonly capabilities: readonly CapabilitySupport[];
  readonly lineage: SessionLineage;
  readonly ephemeral: boolean;
  readonly latest_sequence: number;
  readonly terminal: TerminalEvent["payload"] | null;
}

export interface HarnessClock {
  /** Unix epoch milliseconds.  The injected clock is the only timestamp source. */
  now(): number;
}

export interface NativeSessionEngineOptions {
  readonly capabilities: readonly CapabilitySupport[];
  readonly clock: HarnessClock;
  /**
   * Synchronous observation hook invoked only after a canonical event has
   * been appended to the in-memory session.  Composition roots use this as a
   * write-ahead boundary: throwing prevents the worker from crossing its
   * next provider, approval, or tool side-effect boundary.
   */
  readonly on_event?: (event: SessionEvent, inspection: SessionInspection) => void;
  /** Verifies an externally durable continuation admission; never optional for continuation lineage. */
  readonly continuation_authority?: (lineage: Extract<SessionLineage, { readonly kind: "continuation" }>, session_id: string) => boolean;
}
