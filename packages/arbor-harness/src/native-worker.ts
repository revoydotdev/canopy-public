/**
 * Connector-neutral execution worker for the revoy-owned native harness.
 *
 * It deliberately owns orchestration only.  Model, tool, approval, and
 * credential implementations are injected ports, so this package neither
 * discovers ambient configuration nor reaches into provider SDKs.
 */
import { createHash } from "node:crypto";
import { isRuntimeGateRefusal } from "@arbor/core";
import type { Provenance, RuntimeGateRefusalV2 } from "@arbor/core";
import type { CapabilityRequirement, HarnessCapability } from "./capabilities.js";
import { NativeContextError, NativeContextManager, type NativeContextCompactionEvidence, type NativeContextCompositionObservation, type NativeContextSnapshot, redactNativeText } from "./context-manager.js";
import {
  DEFAULT_NATIVE_RETRY_POLICY,
  classifyNativeInferenceFailure,
  NATIVE_MODEL_STOP_REASONS,
  isNativeUsageAndCost,
  nativeAbortedTurnUsage,
  type NativeAbortedTurnUsage,
  type NativeModelStopReason,
  type NativeContextEvidenceRef,
  type NativeHumanInputPort,
  type NativeHumanInputRequest,
  type NativeModelIdentity,
  type NativeRetryClassification,
  type NativeRetryPolicy,
  type NativeStructuredOutputContract,
  type NativeUsageAndCost,
  type NativeInferenceDelta,
} from "./inference.js";
import type { NativeUsageBudgetPort } from "./usage-budget.js";
import type { NativeModelSignal } from "./native-model-signal.js";
import type { ExecutionPolicy, NativePreSignalCompletionGuard, NativeSignaledCompletion, NativeToolActionScopeEvidence, NativeToolEffect, NativeToolExecutionEvidence, NativeToolExecutionStage, NativeToolOperationAnnotations, SessionInspection, SessionStartRequest } from "./protocol.js";
import { HarnessAdmissionError, NativeSessionEngine, isToolPermitted } from "./native-session.js";

export type NativeToolRisk = "low" | "high";

export interface NativeModelText {
  readonly text: string;
  readonly phase: "commentary" | "final";
}

export interface NativeToolCall {
  /** Stable only within one model response; it is never a credential identity. */
  readonly call_id: string;
  readonly tool: string;
  /** Passed verbatim only to the selected tool port, never to canonical events. */
  readonly input: unknown;
  /** The model-supplied redacted description suitable for the audit event. */
  readonly input_summary: string;
  readonly risk: NativeToolRisk;
  /** Optional for legacy adapters; supplied references are checked before tool dispatch. */
  readonly context_refs?: readonly NativeContextEvidenceRef[];
  /**
   * Present only when the adapter observed the provider requesting a tool
   * name outside the composed set for this request. Never dispatched:
   * `executeTool` short-circuits to a recoverable "tool not available"
   * result naming `available_tools` instead of looking up a host port.
   */
  readonly uncomposed?: Readonly<{ readonly available_tools: readonly string[] }>;
}

export interface NativeUsageObservation {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly unavailable_reason?: string;
}

export interface NativeConversationEntry {
  readonly kind: "model_text" | "thinking" | "tool_result" | "human_input";
  readonly text: string;
  readonly tool?: string;
  readonly call_id?: string;
  readonly evidence?: readonly NativeContextEvidenceRef[];
  /**
   * Present only on a `"thinking"` entry: the provider's opaque verification
   * token for that block. Anthropic's contract ties replay validity to this
   * value reaching the next outbound request byte-for-byte, so it is carried
   * verbatim -- never redacted, never regenerated (see ADR-109 O4 and
   * `shared/model-migration.md`'s "don't strip thinking blocks" guidance).
   */
  readonly signature?: string;
}

/**
 * Protected provider-continuity material captured immediately before a model
 * turn. Unlike the canonical session event stream, this contains bounded
 * redacted conversation text and must only be persisted by a host-owned
 * replay store with stricter disclosure controls.
 */
export interface NativeConversationCheckpoint {
  readonly version: 1;
  readonly session_id: string;
  readonly next_turn: number;
  readonly captured_sequence: number;
  readonly prompt: string;
  readonly history: readonly NativeConversationEntry[];
}

export interface NativeSessionSteeringMessage {
  readonly message_id: string;
  readonly text: string;
  readonly provenance: Provenance;
}

export interface NativeSessionSteeringPort {
  drain(session_id: string): readonly NativeSessionSteeringMessage[];
}

/**
 * A declarative role boundary, not an embedded prompt.  Composition may use
 * role identifiers such as an architect or documentation writer without
 * making this native package a source of their instructions or behavior.
 */
export interface NativeExecutionProfile {
  readonly role_id: string;
  /** An additional allow-list intersected with the immutable session policy. */
  readonly allowed_tools: readonly string[];
  /** Explicit required capabilities may not exceed this declarative profile. */
  readonly allowed_capabilities: readonly HarnessCapability[];
  /** Capabilities that this role requires in addition to the session request. */
  readonly required_capabilities?: readonly CapabilityRequirement[];
}

/** Caller-owned, provenance-bearing context for a role; never recorded as an event. */
export interface NativeGovernedInstruction {
  readonly instruction_id: string;
  readonly text: string;
  readonly provenance: Provenance;
}

/** Metadata and caller-supplied content for an artifact a model port may consume. */
export interface NativeGovernedArtifact {
  readonly artifact_id: string;
  readonly media_type: string;
  /** UTF-8 is the default. Binary media must be explicitly base64 encoded. */
  readonly encoding?: "utf8" | "base64";
  readonly content: string;
  readonly provenance: Provenance;
}

export interface NativeGovernedContext {
  readonly instructions: readonly NativeGovernedInstruction[];
  readonly artifacts: readonly NativeGovernedArtifact[];
}

export interface NativeModelRequest {
  readonly session_id: string;
  readonly turn: number;
  /** False only for a reserved terminal response turn; adapters must expose no tools. */
  readonly tools_allowed?: boolean;
  /** Caller-owned task text.  Credentials and ambient configuration are excluded. */
  readonly prompt: string;
  readonly history: readonly NativeConversationEntry[];
  /** Declarative role identity only; it has no harness-owned prompt. */
  readonly profile: Readonly<{ role_id: string }> | null;
  /** Caller-owned governed instructions and artifacts, excluded from events. */
  readonly governed_context: NativeGovernedContext;
  /** Selected additive context; `null` means composition did not configure a manager. */
  readonly context: NativeContextSnapshot | null;
  /** Validation remains at the caller-owned contract boundary. */
  readonly structured_output: Readonly<{ schema_id: string }> | null;
  /** Explicit composition proof used by adapters to avoid serializing duplicate prompt material. */
  readonly prompt_projection?: Readonly<{ context_entry_ids: readonly string[]; governed_context_included: boolean }>;
}

/** A preserved extended-thinking block: text plus its verbatim provider signature. */
export interface NativeModelThinking {
  readonly text: string;
  readonly signature: string;
}

export interface NativeModelResponse {
  readonly text: readonly NativeModelText[];
  /**
   * Preserved in original order; never discarded (ADR-109). Optional so
   * existing model ports that predate thinking-block preservation remain
   * valid responses -- an absent array is treated identically to an empty
   * one, never as a discard.
   */
  readonly thinking?: readonly NativeModelThinking[];
  readonly tool_calls: readonly NativeToolCall[];
  readonly usage?: NativeUsageObservation;
  /** A final result is mutually exclusive with tool calls in the same response. */
  readonly final_message: string | null;
  /** Raw value is not trusted until the caller-injected contract accepts it. */
  readonly structured_output?: unknown;
  /**
   * The adapter's bounded reason when structured output was requested and no
   * JSON value could be recovered from the reply. A model miss the worker
   * corrects in-session, like JSON the contract rejected.
   */
  readonly structured_output_unparsed?: string;
  /**
   * Why the provider ended the turn, when the adapter observed it. An
   * `output_limit` turn is never accepted as a final result or as structured
   * output; see `MAX_OUTPUT_LIMIT_CONTINUATIONS`.
   */
  readonly stop_reason?: NativeModelStopReason;
  readonly human_input_request?: NativeHumanInputRequest;
  /** Typed usage/cost suitable for portfolio telemetry, separate from legacy event usage. */
  readonly usage_and_cost?: NativeUsageAndCost;
}

/**
 * An opaque credential boundary.  The worker never receives, stores, logs,
 * or returns a secret.  The callback is the only point where an injected
 * execution port can receive one.
 */
export interface NativeCredentialLeasePort {
  readonly lease_id: string;
  inject<T>(recipient: (secret: string) => Promise<T>): Promise<T>;
}

export interface NativeModelPort {
  run(request: NativeModelRequest, secret: string | null, signal: AbortSignal): Promise<NativeModelResponse>;
  /** Optional streaming surface; adapters may retain `run` while they migrate. */
  stream?(request: NativeModelRequest, secret: string | null, signal: AbortSignal): AsyncIterable<NativeInferenceDelta>;
  readonly identity?: NativeModelIdentity;
  classify_failure?(error: unknown): NativeRetryClassification;
}

export interface NativeToolRequest {
  readonly session_id: string;
  readonly turn: number;
  readonly call_id: string;
  readonly input: unknown;
  readonly workspace_roots: readonly string[];
  /** Immutable session isolation decision; tool hosts must enforce, never infer it. */
  readonly filesystem: ExecutionPolicy["filesystem"];
  readonly network_allowed: boolean;
  /** Content-free context/evidence used to justify the tool intent. */
  readonly intent_evidence: readonly NativeContextEvidenceRef[];
}

export interface NativeToolResponse {
  /** Redacted result description suitable for the canonical event stream. */
  readonly result_summary: string;
  /** Model-visible tool output.  It is not copied into an event. */
  readonly model_output: string;
  /** Content-free host evidence; the worker never infers this from output text. */
  readonly evidence: NativeToolExecutionEvidence;
  /**
   * A governed artifact this call adds to the session's governed context for
   * every subsequent turn (never the turn already in flight). Only a
   * trusted, composition-owned port may populate this — the model's own tool
   * input never reaches this field directly, only whichever artifact the
   * port itself resolved from a campaign-owned catalog (e.g. `image.attach`
   * in `native-tool-host.ts`). Ignored unless `evidence.outcome` is
   * `"succeeded"`; a malformed value fails the session rather than being
   * silently dropped, mirroring `invalid_tool_response` below.
   */
  readonly governed_artifact_attached?: NativeGovernedArtifact;
}

export interface NativeToolPort {
  readonly tool: string;
  /** Host-declared crash-recovery semantics; callers must never infer these from a tool name. */
  recovery_protection?(request: NativeToolRequest): Readonly<{
    readonly effect_kind: "read_only" | "file_write" | "file_patch" | "shell" | "external";
    readonly repeatable: boolean;
    readonly idempotency_key_hash: string | null;
    readonly acknowledged_by: string | null;
  }>;
  /**
   * Host-owned admission checked before human approval or credential delivery.
   * It is deliberately separate from `execute`: model context references do
   * not grant high-risk authority and cannot be used to skip this boundary.
   */
  preflight?(request: NativeToolRequest): NativeToolPreflightResult;
  execute(request: NativeToolRequest, secret: string | null, signal: AbortSignal): Promise<NativeToolResponse>;
}

export type NativeToolPreflightResult =
  | { readonly allowed: true }
  | {
    readonly allowed: false; readonly code: string; readonly reason: string; readonly evidence: NativeToolExecutionEvidence;
    /**
     * The refusing authority's typed remedy (the v2 refusal contract). When it
     * names the specialist as the correcting actor and the refusal is
     * recoverable, it is rendered into the model-visible tool result.
     */
    readonly remedy?: RuntimeGateRefusalV2;
  };

export interface NativeApprovalRequest {
  readonly session_id: string;
  readonly request_id: string;
  readonly tool: string;
  readonly input_summary: string;
  readonly risk: NativeToolRisk;
}

export interface NativeApprovalResolution {
  readonly approved: boolean;
  /** Caller-supplied but non-secret audit rationale. */
  readonly rationale: string;
}

export interface NativeApprovalPort {
  decide(request: NativeApprovalRequest, signal: AbortSignal): Promise<NativeApprovalResolution>;
}

export interface NativeVerifiedCompletion {
  readonly message: string;
  readonly provenance: Extract<Provenance, { tag: "verified" }>;
}

/**
 * A composition-root supplied evidence boundary.  It may return `null` when
 * verification is unavailable; that preserves a claimed completion.  It is
 * intentionally separate from the model port so the model cannot self-verify.
 */
export interface NativeGovernedCompletionPort {
  verify(input: {
    readonly session_id: string;
    readonly final_message: string;
    readonly history: readonly NativeConversationEntry[];
  }, signal: AbortSignal): Promise<NativeVerifiedCompletion | null>;
}

/**
 * The one place a model turn ends successfully — the point this worker owns
 * that a Claude Code `Stop` event corresponds to. Both halves of the per-turn
 * boundary seam read it, and neither adds a decision shape of its own: the
 * observer cannot deny, and the gate can only refuse.
 */
export interface NativeTurnBoundary {
  readonly session_id: string;
  readonly turn: number;
  readonly max_turns: number;
  /**
   * The run's own signal. A gate that can abort must: it is awaited in line
   * with every other step of the turn, so aborting is the only preemption this
   * runtime offers it.
   */
  readonly signal: AbortSignal;
}

export interface NativeHarnessWorkerOptions {
  readonly session_engine: NativeSessionEngine;
  readonly model: NativeModelPort;
  /**
   * Session-owned capability boundary for model requests. `false` makes every
   * request a no-tool request, including turns before the ordinary reserved
   * final turn; a role cannot merely hide its tool definitions and still be
   * routed as tool-capable.
   */
  readonly model_tools_allowed?: boolean;
  readonly tools?: readonly NativeToolPort[];
  readonly approvals?: NativeApprovalPort;
  /** @deprecated Use the separate model/tool leases so a model API key never reaches a tool port. */
  readonly credential?: NativeCredentialLeasePort;
  readonly model_credential?: NativeCredentialLeasePort;
  readonly tool_credential?: NativeCredentialLeasePort;
  /**
   * Deferred lease lookup. The worker invokes it only at the matching
   * provider/tool boundary, after the session admission event is observed.
   */
  readonly model_credential_factory?: () => NativeCredentialLeasePort | undefined;
  readonly tool_credential_factory?: () => NativeCredentialLeasePort | undefined;
  readonly governed_completion?: NativeGovernedCompletionPort;
  /** Final veto boundary evaluated immediately before any completion signal. */
  readonly completion_guard?: NativePreSignalCompletionGuard;
  readonly context?: NativeContextManager;
  /**
   * Composition-owned evidence used when a provider protocol cannot carry
   * per-call context references. It is validated against the active manager;
   * a model-supplied non-empty reference list never falls back to this value.
   */
  readonly default_tool_intent_evidence?: readonly NativeContextEvidenceRef[];
  /** Injectable, abort-aware delay surface for bounded model retries. */
  readonly retry_delay?: NativeRetryDelayPort;
  readonly human_input?: NativeHumanInputPort;
  /** Session-local prospective admission and measured-usage enforcement. */
  readonly usage_budget?: NativeUsageBudgetPort;
  /** Synchronous write-ahead boundary for resumable/forkable conversation state. */
  readonly on_checkpoint?: (checkpoint: NativeConversationCheckpoint) => void;
  /** Host-owned inbox drained only between model turns. */
  readonly steering?: NativeSessionSteeringPort;
  /**
   * OBSERVE half of the per-turn boundary seam. Called once per turn that ends
   * successfully, at the point the turn is offered for acceptance, and before
   * any `turn_gate` verdict: a refusal does not un-happen the turn, so an
   * observer a permanently-refusing gate could suppress would be the
   * "registered and never fired" defect this boundary exists to end.
   *
   * It is synchronous and returns nothing. A consumer whose work is slow must
   * start it detached and settle it on its own; the hook bus's `turn_end`
   * observe lane does exactly that.
   */
  readonly on_turn_end?: (boundary: NativeTurnBoundary) => void;
  /**
   * REFUSAL half of the seam. A string refuses the turn and is fed back to the
   * model as the reason; `null` allows it. It reuses the correction path the
   * structured-output branch above already owns — there is deliberately no
   * second continuation primitive here.
   *
   * `null` is also where a per-turn stand-down lands. ADR-160 §4 lets a
   * stop-tier consumer stand down while a session window is open, because a
   * check that costs tens of seconds and runs on every turn is otherwise a tax
   * nobody asked for; a consumer that decides this turn's check is deferred
   * returns `null` and the turn proceeds. A third value was rejected: a
   * deferral and a clean check produce the same observable outcome, so a token
   * for it would have no consumer.
   *
   * Two bounds, and no timer. The refusal budget
   * (`MAX_TURN_GATE_REFUSALS`) is what stops a permanently-red gate from
   * spending the whole turn budget producing output nobody accepts; past it the
   * gate is not consulted and a diagnostic says so. A timer would be worse than
   * nothing: a worker cannot preempt an in-line `await` any more than a
   * single-threaded bus can preempt a running synchronous handler, so
   * discarding a slow gate's verdict would ALLOW the turn — a silently-dropped
   * guard. A gate that overruns therefore costs budget and produces a visible
   * row, and the session's own `max_wall_clock_ms` still governs it.
   */
  readonly turn_gate?: (boundary: NativeTurnBoundary) => Promise<string | null>;
  /**
   * ADVISORY half of the seam, and the only one whose product is model-facing
   * TEXT. Returns the bounded prompt block to append to the NEXT turn's
   * prompt, or `null` for nothing.
   *
   * It is `async` and the worker AWAITS it, but never on the turn that started
   * it: the injection is begun at the top of a turn, detached, and settled at
   * the top of the next one. "Out of band" therefore means "started at the
   * boundary, awaited at the next boundary", not "never awaited" — an inject's
   * product is a prompt, so unlike an observe note it cannot be fire-and-forget
   * without becoming a note nobody reads.
   *
   * Two bounds, and both exist because the alternative is a turn tax or a
   * silent drop. A handler that has not settled by the next boundary is
   * DROPPED WITH A NAMED DIAGNOSTIC (`turn_injection_dropped`) — not carried
   * stale, which would deliver a finding about a turn that already happened,
   * and not dropped silently, which is indistinguishable from a handler with
   * nothing to say. The settle window is `TURN_INJECT_SETTLE_MS`, chosen to
   * exceed every bound an `inject` handler may declare on this lane, so a
   * handler that used its full budget is not dropped for having done so. And
   * the settled text is CONSUMED BY DELIVERY: it is a per-iteration value, not
   * a slot, so a scope reaches the model exactly once. That is a different
   * property from the bus's §5.3 dedupe, which suppresses a scope whose
   * derivation has not moved; both are wanted, and `turn-inject-carry.test.ts`
   * and `turn-inject-lane.test.ts` prove each half against real code.
   */
  readonly turn_inject?: (boundary: NativeTurnBoundary) => Promise<string | null>;
}

export interface NativeRetryDelayPort {
  wait(delay_ms: number, signal: AbortSignal): Promise<"elapsed" | "aborted">;
}

export interface NativeWorkerRunRequest {
  readonly start: SessionStartRequest;
  readonly prompt: string;
  readonly max_turns: number;
  readonly profile?: NativeExecutionProfile;
  readonly governed_context?: NativeGovernedContext;
  readonly signal?: AbortSignal;
  readonly structured_output?: NativeStructuredOutputContract;
  readonly retry_policy?: NativeRetryPolicy;
  readonly prompt_projection?: Readonly<{ context_entry_ids: readonly string[]; governed_context_included: boolean }>;
  /** Bounded, already-redacted history imported only after a fresh session admission. */
  readonly initial_history?: readonly NativeConversationEntry[];
}

export interface NativeWorkerRunResult {
  readonly session: SessionInspection;
  readonly turns_started: number;
  /** Adapter-declared model/capability identity, if composition supplied it. */
  readonly model_identity: NativeModelIdentity | null;
  /** Cumulative measured token usage and configured/provider cost, when observed. */
  readonly usage_and_cost: NativeUsageAndCost | null;
  /**
   * The accepted caller-owned structured value, never a raw provider string.
   * It is null unless a final response passed the active contract, so callers
   * cannot accidentally derive governance from a parallel free-form channel.
   */
  readonly structured_output: unknown | null;
  /** Privacy-safe token-composition counts from the session's context manager, or `null` when none was configured. */
  readonly context_composition: NativeContextCompositionObservation | null;
  /** Every real, evidenced compaction observed this run, in turn order; empty when none occurred (never a skip/disabled report — those are events only). */
  readonly context_compactions: readonly NativeContextCompactionEvidence[];
  readonly tool_economy: NativeToolEconomyObservation;
}

export interface NativeToolEconomyObservation {
  readonly offered_calls: number;
  readonly host_executions: number;
  readonly reused_reads: number;
  readonly avoided_output_bytes: number;
}

export class NativeWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeWorkerError";
  }
}

interface RecordedContext {
  readonly evidence: NativeContextEvidenceRef;
  /** The manager-owned redacted text; raw model and tool bytes never enter history. */
  readonly text: string;
}

type NativeModelAttempt =
  | { readonly kind: "response"; readonly response: NativeModelResponse }
  | { readonly kind: "context_overflow"; readonly signal: NativeModelSignal };

/**
 * ADR-117 §1/§2: preflight codes the model can act on by choosing a
 * different action -- it asked outside `write_paths`/`command_argv`/its
 * authorized action scope, not a broken host. Produced only by
 * `highRiskScopeFailure` (`native-tool-host.ts`). Every other preflight
 * code (`missing_trusted_intent`, `workspace_roots_mismatch`,
 * `tool_preflight_failed`, `invalid_tool_preflight`, ...) means composition
 * or the host itself is broken for this session and stays terminal.
 */
const RECOVERABLE_PREFLIGHT_CODES: ReadonlySet<string> = new Set([
  "path_invalid",
  // A malformed command argv is the same kind of mistake as a malformed path:
  // the model can correct it, and the host's refusal-loop breaker still stops
  // a model that repeats the identical bad call.
  "argv_invalid",
  "action_scope_command_denied",
  "action_scope_path_denied",
  "action_scope_missing_or_stale",
  // A governed hook's policy veto is the same shape: the model asked for an
  // action a reduction-only overlay forbids and can choose another. A veto
  // handler that FAILED (`hook_veto_failed`) is a broken host and stays terminal.
  "hook_denied",
]);

/**
 * How many times the worker refuses one identical call (same tool, same
 * canonical input) before the next identical proposal ends the session. The
 * same bound, and the same terminal code, as the repository tool host's own
 * breaker (`NATIVE_TOOL_REFUSAL_LOOP_LIMIT` in `@arbor/mcp`): ADR-117 made
 * these refusals recoverable so the model can choose another call, and a
 * model that instead re-proposes the refused one would otherwise spend its
 * whole turn budget on a refusal that cannot change.
 */
export const NATIVE_WORKER_REFUSAL_LOOP_LIMIT = 3;
export const NATIVE_WORKER_REFUSAL_LOOP_CODE = "tool_refusal_loop";

/** Refusals the worker itself issues, and so the only ones its breaker counts. */
export type NativeWorkerRefusalKind = "approval_denied" | "hook_denied" | "tool_not_composed";
export const NATIVE_WORKER_REFUSAL_KINDS: readonly NativeWorkerRefusalKind[] = Object.freeze(["approval_denied", "hook_denied", "tool_not_composed"]);

/**
 * The typed remedy (ADR-179's table) for a session the worker's breaker
 * stopped. The correcting actor follows the refusal kind, never the host
 * breaker's planner: a governed hook's veto and an approver's denial are
 * both vetoes of that exact call, cleared only by the specialist choosing a
 * different one (`tool_veto` -> specialist/revise_tool_call); a tool absent
 * from the session's composed set is the operator's capability grant
 * (`capability` -> operator/grant_capability).
 */
export function nativeWorkerRefusalLoopRemedy(kind: NativeWorkerRefusalKind, tool: string): RuntimeGateRefusalV2 {
  const name = tool.slice(0, 64);
  const summary = `session stopped: the specialist proposed the same refused ${name} call ${NATIVE_WORKER_REFUSAL_LOOP_LIMIT} times without progress (${kind}).`;
  return kind === "tool_not_composed"
    ? Object.freeze({
      schema_version: 2, kind: "gate.refusal", state: "refused", gate: "capability", code: NATIVE_WORKER_REFUSAL_LOOP_CODE, summary, evidence_deficit: null,
      correcting_actor: "operator", corrective_action: "grant_capability",
      remediation: `Compose ${name} for this role's session, or revise the task so it does not need the tool; then retry the node.`,
    })
    : Object.freeze({
      schema_version: 2, kind: "gate.refusal", state: "refused", gate: "tool_veto", code: NATIVE_WORKER_REFUSAL_LOOP_CODE, summary, evidence_deficit: null,
      correcting_actor: "specialist", corrective_action: "revise_tool_call",
      remediation: kind === "hook_denied"
        ? "Retry the node; the specialist must choose a call the vetoing hook policy permits instead of repeating the vetoed one."
        : "Retry the node; the specialist must choose a call the approver accepts instead of repeating the denied one.",
    });
}

/**
 * A bounded, sequential worker.  Every boundary checks terminal state, so a
 * limit or interruption cannot be followed by another provider/tool action.
 */
export class NativeHarnessWorker {
  private readonly engine: NativeSessionEngine;
  private readonly model: NativeModelPort;
  private readonly tools: ReadonlyMap<string, NativeToolPort>;
  private readonly approvals: NativeApprovalPort | undefined;
  private readonly modelCredential: NativeCredentialLeasePort | undefined;
  private readonly toolCredential: NativeCredentialLeasePort | undefined;
  private readonly modelCredentialFactory: (() => NativeCredentialLeasePort | undefined) | undefined;
  private readonly toolCredentialFactory: (() => NativeCredentialLeasePort | undefined) | undefined;
  /** Resolution is session-scoped: an absent lease is cached too. */
  private modelCredentialResolved = false;
  private toolCredentialResolved = false;
  private resolvedModelCredential: NativeCredentialLeasePort | undefined;
  private resolvedToolCredential: NativeCredentialLeasePort | undefined;
  private readonly governedCompletion: NativeGovernedCompletionPort | undefined;
  private readonly completionGuard: NativePreSignalCompletionGuard | undefined;
  private readonly context: NativeContextManager | undefined;
  private readonly defaultToolIntentEvidence: readonly NativeContextEvidenceRef[];
  private readonly retryDelay: NativeRetryDelayPort;
  private readonly humanInput: NativeHumanInputPort | undefined;
  private readonly usageBudget: NativeUsageBudgetPort | undefined;
  private readonly onCheckpoint: NativeHarnessWorkerOptions["on_checkpoint"];
  private readonly modelToolsAllowed: boolean;
  private readonly steering: NativeSessionSteeringPort | undefined;
  private readonly onTurnEnd: NativeHarnessWorkerOptions["on_turn_end"];
  private readonly turnGate: NativeHarnessWorkerOptions["turn_gate"];
  private readonly turnInject: NativeHarnessWorkerOptions["turn_inject"];
  /**
   * Session-local exact-read memoization. Only host-declared repeatable,
   * read-only calls enter this map, and any potentially mutating call clears
   * it before execution. Values are represented to the model by a compact
   * pointer to the already-retained result, never by duplicating its bulk.
   */
  private readonly readMemo = new Map<string, {
    readonly context_entry_id: string;
    readonly source_evidence: NativeContextEvidenceRef;
    readonly source_operation_id: string;
    readonly output_digest: string;
    readonly output_bytes: number;
  }>();
  /**
   * Approval denials already decided in this session, keyed by the exact tool
   * and input the operator ruled on. ADR-117 makes a denied turn continue so
   * the model can adapt; without this the same unchanged request would be put
   * to the operator again on every remaining turn. The decision is re-served
   * from here — a denial stays a denial, the model still receives the refusal,
   * and only the duplicate human interrupt is removed.
   */
  private readonly approvalDenialMemo = new Map<string, string | undefined>();
  /**
   * No-progress breaker state for refusals the WORKER issues (approval
   * denials, governed hook vetoes, uncomposed tools), keyed like
   * `approvalDenialMemo` by tool + canonical input. The repository tool
   * host's breaker never sees these: they are decided before, or instead of,
   * any host call. The last refusal kind picks the remedy's correcting actor.
   */
  private readonly workerRefusals = new Map<string, { count: number; kind: NativeWorkerRefusalKind }>();
  private offeredToolCalls = 0;
  private hostToolExecutions = 0;
  private reusedReads = 0;
  private avoidedOutputBytes = 0;
  /** Only real, evidenced compactions accumulate here — never a skip/disabled/not-triggered report. */
  private readonly contextCompactions: NativeContextCompactionEvidence[] = [];
  /**
   * Governed image/document artifacts attached mid-session by a
   * model-callable tool (e.g. `image.attach`), appended to the dispatch-time
   * governed context for every subsequent turn of this run. Reset per
   * worker instance (one instance per session): a later continuation
   * re-resolves dispatch-time attachments fresh but does not replay a
   * mid-session attach across the continuation boundary — the model simply
   * calls the tool again, exactly as it would re-discover any other
   * session-local state.
   */
  private readonly attachedGovernedArtifacts: NativeGovernedArtifact[] = [];

  constructor(options: NativeHarnessWorkerOptions) {
    this.engine = options.session_engine;
    this.model = options.model;
    this.approvals = options.approvals;
    this.modelCredential = options.model_credential ?? options.credential;
    this.toolCredential = options.tool_credential ?? options.credential;
    this.modelCredentialFactory = options.model_credential_factory;
    this.toolCredentialFactory = options.tool_credential_factory;
    this.governedCompletion = options.governed_completion;
    this.completionGuard = options.completion_guard;
    this.context = options.context;
    this.defaultToolIntentEvidence = Object.freeze((options.default_tool_intent_evidence ?? []).map((ref) => Object.freeze({ entry_id: ref.entry_id, provenance: Object.freeze({ ...ref.provenance }) })));
    this.retryDelay = options.retry_delay ?? systemRetryDelay;
    this.humanInput = options.human_input;
    this.usageBudget = options.usage_budget;
    this.onCheckpoint = options.on_checkpoint;
    this.modelToolsAllowed = options.model_tools_allowed !== false;
    this.steering = options.steering;
    this.onTurnEnd = options.on_turn_end;
    this.turnGate = options.turn_gate;
    this.turnInject = options.turn_inject;
    const tools = new Map<string, NativeToolPort>();
    for (const tool of options.tools ?? []) {
      assertNonEmpty(tool.tool, "tool identifier");
      if (tools.has(tool.tool)) throw new NativeWorkerError(`duplicate tool port: ${tool.tool}`);
      tools.set(tool.tool, tool);
    }
    this.tools = tools;
  }

  async run(request: NativeWorkerRunRequest): Promise<NativeWorkerRunResult> {
    assertNonEmpty(request.prompt, "prompt");
    if (!Number.isSafeInteger(request.max_turns) || request.max_turns <= 0) {
      throw new NativeWorkerError("max_turns must be a positive safe integer");
    }

    const start = profileStart(request.start, request.profile);
    const governedContext = freezeGovernedContext(request.governed_context);
    const retryPolicy = freezeRetryPolicy(request.retry_policy ?? DEFAULT_NATIVE_RETRY_POLICY);
    this.engine.start(start);
    const signal = request.signal;
    if (signal?.aborted) return this.interrupted(start.session_id, 0);

    const initialHistory = normalizeInitialHistory(request.initial_history ?? []);
    const history: NativeConversationEntry[] = [...initialHistory];
    // Structured-output sessions (the critic verdict, the Taproot plan) fail
    // terminally when a provider returns a response the caller-owned contract
    // rejects — observed live: a critic session ending `structured_output_invalid`
    // left a verified specialist node unfinalized. Give the model a bounded
    // number of in-session corrections: feed the rejection reason back and let
    // it retry, rather than failing the whole session on the first miss.
    let structuredRetries = MAX_STRUCTURED_RETRIES;
    let pendingStructuredCorrection: string | null = null;
    // The same shape of bound, for the same reason: a boundary that refuses a
    // turn needs a turn left to re-prompt on, so an unbounded refusal budget
    // against a permanently-red gate is an infinite loop wearing a turn budget.
    let turnGateRefusals = MAX_TURN_GATE_REFUSALS;
    let pendingTurnRefusal: string | null = null;
    // The advisory injection begun on the PREVIOUS turn, awaited at the top of
    // this one. A `let` because the value is replaced every turn, never
    // accumulated: a carry is one scope deep, and it is consumed by delivery.
    let turnInjectionInFlight: Promise<string | null> | null = null;
    // H6 (UCT Stage 0 Revision 2.2): a turn the provider cut off at its
    // output-token limit is neither a final answer nor "no progress". The
    // model gets a bounded continuation turn telling it so; consecutive
    // cut-off turns without a tool call are counted, and past
    // MAX_OUTPUT_LIMIT_CONTINUATIONS the session ends with a typed reason.
    let outputLimitTurns = 0;
    let pendingOutputLimitNote: string | null = null;
    for (let turn = 1; turn <= request.max_turns; turn += 1) {
      if (this.isTerminal(start.session_id)) return this.result(start.session_id, turn - 1);
      if (signal?.aborted) return this.interrupted(start.session_id, turn - 1);
      const steeringFailure = this.deliverSteering(start.session_id, turn - 1, this.steering?.drain(start.session_id) ?? [], history);
      if (steeringFailure !== null) return steeringFailure;
      try {
        this.onCheckpoint?.(freezeConversationCheckpoint(start.session_id, turn, this.engine.inspect(start.session_id).latest_sequence, request.prompt, history));
      } catch {
        return this.failed(start.session_id, turn - 1, "checkpoint_failed", "protected conversation checkpoint could not be persisted");
      }

      // Before projecting context, compact non-recent history once it crosses
      // the manager's configured mid-session threshold, instead of waiting for
      // an outright per-request overflow. `compact()` either appends a real,
      // evidenced anchor (structural fold, or a model summary when a
      // summarizer is composed) or returns an honest typed report of why it
      // did not — never a fabricated compaction record.
      if (this.context !== undefined) await this.recordCompaction(start.session_id, this.context, `${start.session_id}:compact:${turn}`, turn);
      const context = this.context?.snapshot() ?? null;
      const finalizationOnly = request.max_turns > 1 && turn === request.max_turns;
      const toolsAllowed = this.modelToolsAllowed && !finalizationOnly;
      // Settle the advisory injection the PREVIOUS turn began, then begin this
      // turn's. Awaiting it here rather than at the boundary that started it is
      // the whole timing contract: the work of the last turn overlaps the work
      // of this one, so a handler that does I/O costs the turn nothing, and the
      // text still reaches a prompt before the model sees it.
      const boundaryFor = (): NativeTurnBoundary => Object.freeze({ session_id: start.session_id, turn, max_turns: request.max_turns, signal: signal ?? neverAbortSignal });
      const turnInjection = await this.settleTurnInjection(start.session_id, turnInjectionInFlight);
      if (this.turnInject !== undefined) turnInjectionInFlight = this.beginTurnInjection(boundaryFor());
      const modelRequest = Object.freeze({
        session_id: start.session_id,
        turn,
        tools_allowed: toolsAllowed,
        // A capable model left to its own pacing over-explores and never commits
        // to producing its result before the turn budget ends (observed: 24
        // file reads and zero writes on a one-file task). A deterministic
        // depleting-budget note tells it how many turns remain and, past a
        // threshold, to stop exploring and produce its result now.
        prompt: withOutputLimitContinuation(withTurnGateRefusal(withStructuredCorrection(withTurnInjection(withTurnBudgetNote(request.prompt, turn, request.max_turns), turnInjection), pendingStructuredCorrection), pendingTurnRefusal), pendingOutputLimitNote),
        // Context-aware sessions never forward an independent raw transcript:
        // history is a redacted projection of the same bounded snapshot.
        history: boundedHistory(history, context),
        profile: request.profile === undefined ? null : Object.freeze({ role_id: request.profile.role_id }),
        // Every turn re-derives this from the fixed dispatch-time context
        // plus whatever `image.attach`-style tools have added so far this
        // run — the same resend-every-turn behavior dispatch-time governed
        // images already rely on (see `governedContext` above), just with a
        // growing tail instead of a fixed one.
        governed_context: this.attachedGovernedArtifacts.length === 0 ? governedContext : Object.freeze({
          instructions: governedContext.instructions,
          artifacts: Object.freeze([...governedContext.artifacts, ...this.attachedGovernedArtifacts]),
        }),
        context,
        structured_output: request.structured_output === undefined ? null : Object.freeze({ schema_id: request.structured_output.schema_id }),
        ...(request.prompt_projection === undefined ? {} : { prompt_projection: Object.freeze({ context_entry_ids: Object.freeze([...request.prompt_projection.context_entry_ids]), governed_context_included: request.prompt_projection.governed_context_included }) }),
      });
      const admission = this.usageBudget?.admit(modelRequest);
      if (admission !== undefined && !admission.allowed) return this.failed(start.session_id, turn, "usage_budget", admission.reason);
      let attempted = await this.requestModel(modelRequest, signal, retryPolicy, start.session_id, turn);
      if (attempted === null) return this.result(start.session_id, turn);
      if (attempted.kind === "context_overflow") {
        this.recordOverflowRecoveryDiagnostic(start.session_id, "context_overflow_recovery_started", "provider confirmed context-window overflow; attempting one context compaction");
        if (signal?.aborted) return this.interrupted(start.session_id, turn);
        if (this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
        if (this.context === undefined) {
          this.recordOverflowRecoveryDiagnostic(start.session_id, "context_overflow_recovery_unavailable", "context overflow recovery unavailable because no context manager is configured");
          return this.failed(start.session_id, turn, "model_failure", "model port failed: context window overflow");
        }
        const compaction = await this.recordCompaction(start.session_id, this.context, `${start.session_id}:compact:overflow:${turn}`, turn, true);
        if (signal?.aborted) return this.interrupted(start.session_id, turn);
        if (this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
        if (compaction.kind !== "compacted") {
          this.recordOverflowRecoveryDiagnostic(start.session_id, "context_overflow_recovery_unavailable", "context overflow recovery could not produce a compaction anchor");
          return this.failed(start.session_id, turn, "model_failure", "model port failed: context window overflow");
        }
        const recoveredContext = this.context.snapshot();
        const recoveredRequest = Object.freeze({
          ...modelRequest,
          context: recoveredContext,
          history: boundedHistory(history, recoveredContext),
        });
        const recoveryAdmission = this.usageBudget?.admit(recoveredRequest);
        if (recoveryAdmission !== undefined && !recoveryAdmission.allowed) {
          return this.failed(start.session_id, turn, "usage_budget", recoveryAdmission.reason);
        }
        this.recordOverflowRecoveryDiagnostic(start.session_id, "context_overflow_recovery_retry", "retrying the same model turn once with compacted context");
        if (signal?.aborted) return this.interrupted(start.session_id, turn);
        if (this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
        // This retry is its own single attempt. It cannot add another transient
        // retry allowance on top of the turn's configured retry policy.
        attempted = await this.requestModel(recoveredRequest, signal, { ...retryPolicy, max_model_attempts_per_turn: 1 }, start.session_id, turn);
        if (attempted === null) return this.result(start.session_id, turn);
        if (attempted.kind === "context_overflow") {
          this.recordOverflowRecoveryDiagnostic(start.session_id, "context_overflow_recovery_failed", "provider confirmed context-window overflow after the one recovery retry");
          return this.failed(start.session_id, turn, "model_failure", "model port failed: context window overflow after recovery");
        }
      }
      const response: unknown = attempted.response;
      if (signal?.aborted) return this.interrupted(start.session_id, turn);
      if (!isModelResponse(response)) return this.failed(start.session_id, turn, "invalid_model_response", "model port returned an invalid response");
      // The note was delivered with this turn's request; it is consumed, never carried.
      pendingOutputLimitNote = null;
      // Each check below ends a turn whose stream completed, so the provider
      // billed it: record its usage before failing rather than dropping it (D3).
      if (response.final_message !== null && response.tool_calls.length > 0) {
        this.recordUsageOfFailedTurn(start.session_id, response);
        return this.failed(start.session_id, turn, "invalid_model_response", "model response combined final output and tool calls");
      }
      if (!toolsAllowed && response.tool_calls.length > 0) {
        this.recordUsageOfFailedTurn(start.session_id, response);
        return this.failed(start.session_id, turn, finalizationOnly ? "finalization_protocol_violation" : "tool_capability_violation", finalizationOnly
          ? "model adapter returned a tool call during the reserved final response turn"
          : "model adapter returned a tool call while the session capability was no-tools");
      }
      if (response.human_input_request !== undefined && (response.final_message !== null || response.tool_calls.length > 0)) {
        this.recordUsageOfFailedTurn(start.session_id, response);
        return this.failed(start.session_id, turn, "invalid_model_response", "model response combined human input with a final result or tool call");
      }
      // A cut-off turn's text is an unfinished draft, never a final answer:
      // it is kept as commentary so the continuation turn can see it.
      const cutOff = response.stop_reason === "output_limit" && response.tool_calls.length === 0 && response.human_input_request === undefined;

      for (const thinking of response.thinking ?? []) {
        // A signature-only block (no accompanying text) is still a real
        // provider artifact worth preserving; an entirely empty block
        // carries nothing to replay and is skipped, mirroring the
        // whitespace-only skip below for model text.
        if (thinking.text.trim().length === 0 && thinking.signature.trim().length === 0) continue;
        const contextRecord = this.recordContext("generate", `${start.session_id}:thinking:${turn}:${history.length + 1}`, thinking.text.length === 0 ? " " : thinking.text);
        if (contextRecord === null) return this.failed(start.session_id, turn, "context_budget", "context manager rejected model thinking output");
        // The signature is never routed through redaction or the context
        // manager's text pipeline -- it is an opaque verification token, not
        // model-authored content, and must reach the next request unchanged.
        history.push(Object.freeze({ kind: "thinking", text: contextRecord.text, signature: thinking.signature, evidence: [contextRecord.evidence] }));
        if (this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
      }

      for (const text of response.text) {
        // Providers routinely interleave whitespace-only commentary chunks
        // (e.g. "\n\n") with a tool call or their real answer. The context
        // manager rejects empty text ("context text must be non-empty"), so
        // recording such a chunk would fail the whole session over content
        // that carries no information. Skip it: it is neither an event worth
        // keeping nor a context fact.
        if (text.text.trim().length === 0) continue;
        this.engine.record(start.session_id, { kind: "model_text", payload: { ...text, ...(cutOff ? { phase: "commentary" as const } : {}), text: this.redact(text.text) } });
        const contextRecord = this.recordContext("generate", `${start.session_id}:model:${turn}:${history.length + 1}`, text.text);
        if (contextRecord === null) return this.failed(start.session_id, turn, "context_budget", "context manager rejected model output");
        history.push(Object.freeze({ kind: "model_text", text: contextRecord.text, evidence: [contextRecord.evidence] }));
        if (this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
      }
      if (response.usage !== undefined) {
        this.engine.record(start.session_id, { kind: "usage", payload: response.usage });
        if (this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
      }

      if (response.usage_and_cost !== undefined && !isNativeUsageAndCost(response.usage_and_cost)) {
        return this.failed(start.session_id, turn, "invalid_usage", "model port returned invalid typed usage or cost");
      }
      if (response.usage_and_cost !== undefined && this.usageBudget !== undefined) {
        const observed = this.usageBudget.observe(response.usage_and_cost);
        if (!observed.allowed) return this.failed(start.session_id, turn, "usage_budget", observed.reason ?? "native usage budget rejected provider observation");
      }

      if (cutOff) {
        outputLimitTurns += 1;
        if (outputLimitTurns > MAX_OUTPUT_LIMIT_CONTINUATIONS) {
          return this.failed(start.session_id, turn, NATIVE_WORKER_OUTPUT_LIMIT_CODE, `model turn stopped at the provider output-token limit ${outputLimitTurns} times in a row without a tool call or a complete answer (limit: ${MAX_OUTPUT_LIMIT_CONTINUATIONS} continuation turns)`);
        }
        if (turn >= request.max_turns) {
          return this.failed(start.session_id, turn, NATIVE_WORKER_OUTPUT_LIMIT_CODE, "model turn stopped at the provider output-token limit on the session's last turn; no turn remains for a continuation");
        }
        const left = MAX_OUTPUT_LIMIT_CONTINUATIONS - outputLimitTurns;
        pendingOutputLimitNote = outputLimitContinuationNote(toolsAllowed && turn + 1 < request.max_turns, request.structured_output?.schema_id ?? null);
        this.engine.record(start.session_id, { kind: "diagnostic", payload: { code: "model_output_limit_continuation", message: `model turn stopped at the provider output-token limit before acting; its text was not accepted as a result. Continuing with a bounded turn (${left} continuation${left === 1 ? "" : "s"} left)` } });
        if (this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
        continue;
      }
      if (response.tool_calls.length > 0) outputLimitTurns = 0;

      if (response.human_input_request !== undefined) {
        const handled = await this.requestHumanInput(start.session_id, turn, response.human_input_request, history, signal);
        if (!handled || this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
        continue;
      }

      if (response.final_message !== null) {
        if (response.final_message.trim().length === 0) {
          return this.failed(start.session_id, turn, "model_no_progress", "model response contained an empty final result");
        }
        // Operator steering queued while this turn's provider call was in
        // flight would otherwise be drained by no later turn: the session
        // completes here and the host settles (discards) the inbox, so an
        // accepted steer would have no effect at all. Drain it now. With a
        // turn left, the final result is kept in the transcript, the steering
        // follows it, and the model answers again; with none left, each
        // message is recorded as undelivered rather than silently lost.
        const lateSteering = this.steering?.drain(start.session_id) ?? [];
        if (lateSteering.length > 0) {
          if (turn < request.max_turns) {
            const finalRecord = this.recordContext("generate", `${start.session_id}:final:${turn}`, response.final_message);
            if (finalRecord === null) return this.failed(start.session_id, turn, "context_budget", "context manager rejected a final result superseded by operator steering");
            history.push(Object.freeze({ kind: "model_text", text: finalRecord.text, evidence: [finalRecord.evidence] }));
            const lateFailure = this.deliverSteering(start.session_id, turn, lateSteering, history);
            if (lateFailure !== null) return lateFailure;
            if (this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
            continue;
          }
          for (const message of lateSteering) {
            this.engine.record(start.session_id, { kind: "diagnostic", payload: { code: "operator_steering_undelivered", message: `operator steering arrived after the final turn and was not delivered: ${validSteeringMessage(message) ? message.message_id.slice(0, 128) : "invalid message"}` } });
            if (this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
          }
        }
        // Before terminally accepting/failing a structured-output response,
        // spend a bounded correction: if the contract rejects it and turns and
        // retries remain, feed the reason back and re-prompt instead of failing.
        const retryReason = structuredRetries > 0 && turn < request.max_turns
          ? this.structuredRetryReason(request.structured_output, response.structured_output, response.structured_output_unparsed)
          : null;
        if (retryReason !== null) {
          structuredRetries -= 1;
          pendingStructuredCorrection = this.redact(retryReason);
          this.engine.record(start.session_id, { kind: "diagnostic", payload: { code: "structured_output_retry", message: `structured output rejected; re-prompting (${structuredRetries} correction${structuredRetries === 1 ? "" : "s"} left)` } });
          if (this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
          continue;
        }
        if (this.onTurnEnd !== undefined || this.turnGate !== undefined) {
          const boundary: NativeTurnBoundary = Object.freeze({ session_id: start.session_id, turn, max_turns: request.max_turns, signal: signal ?? neverAbortSignal });
          this.onTurnEnd?.(boundary);
          if (this.turnGate !== undefined) {
            // `turn < max_turns` for the same reason the structured branch has
            // it: a refusal spends a turn, and the last turn has nowhere to
            // spend one.
            if (turnGateRefusals > 0 && turn < request.max_turns) {
              let refusal: string | null;
              try { refusal = await this.turnGate(boundary); } catch (error) {
                // Fail CLOSED on the decision, as the bus fails a veto handler
                // closed on a throw: an unevaluable guard is not a passing one.
                refusal = `the turn gate could not be evaluated (${this.redact(error instanceof Error ? error.message : "gate rejected with a non-Error value")})`;
              }
              if (typeof refusal === "string") {
                turnGateRefusals -= 1;
                pendingTurnRefusal = this.boundedTurnRefusal(refusal);
                this.engine.record(start.session_id, { kind: "diagnostic", payload: { code: "turn_gate_refused", message: `turn gate refused the final result; re-prompting (${turnGateRefusals} refusal${turnGateRefusals === 1 ? "" : "s"} left)` } });
                if (this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
                continue;
              }
            } else if (turnGateRefusals === 0) {
              // The guard stopped being consulted. Say so on every turn it is
              // not consulted for: a guard that goes quiet is the defect this
              // repo has shipped three times, and this one is deliberate.
              this.engine.record(start.session_id, { kind: "diagnostic", payload: { code: "turn_gate_budget_exhausted", message: "the turn gate was not consulted: its bounded refusal budget is spent, and the turn was allowed without it" } });
            }
          }
        }
        try {
          const replayHistory = [...history, Object.freeze({ kind: "model_text" as const, text: this.redact(response.final_message) })];
          this.onCheckpoint?.(freezeConversationCheckpoint(start.session_id, turn + 1, this.engine.inspect(start.session_id).latest_sequence, request.prompt, replayHistory));
        } catch {
          return this.failed(start.session_id, turn, "checkpoint_failed", "protected final conversation checkpoint could not be persisted");
        }
        return this.complete(start.session_id, turn, response.final_message, response.structured_output, request.structured_output, history, signal, response.structured_output_unparsed);
      }
      if (response.tool_calls.length === 0) {
        return this.failed(start.session_id, turn, "model_no_progress", "model response contained neither a final result nor a tool call");
      }

      const dispatchStopped = await this.dispatchToolCalls(start.session_id, turn, response.tool_calls, start.policy, history, signal);
      if (dispatchStopped || this.isTerminal(start.session_id)) return this.result(start.session_id, turn);
      if (signal?.aborted) return this.interrupted(start.session_id, turn);
    }
    return this.failed(start.session_id, request.max_turns, "turn_limit", "native worker turn limit exceeded");
  }

  /**
   * Starts this turn's advisory injection without awaiting it, and normalises
   * every failure into a NAMED diagnostic plus no text.
   *
   * Never rejects, and never resolves to a rejection a later turn could trip
   * over: a worker that returned early with a rejected promise in flight would
   * raise an unhandled rejection, which vitest reports as a suite-level
   * failure attributable to nothing.
   */
  private beginTurnInjection(boundary: NativeTurnBoundary): Promise<string | null> {
    const failed = (reason: string): Promise<string | null> => {
      this.engine.record(boundary.session_id, { kind: "diagnostic", payload: { code: "turn_injection_failed", message: reason } });
      return Promise.resolve(null);
    };
    try {
      return Promise.resolve(this.turnInject!(boundary)).then(
        (value) => typeof value === "string" && value !== "" ? value : null,
        (error: unknown) => failed(`the turn injection could not be evaluated (${this.redact(error instanceof Error ? error.message : "rejected with a non-Error value")})`),
      );
    } catch (error) {
      return failed(`the turn injection could not be evaluated (${this.redact(error instanceof Error ? error.message : "threw a non-Error value")})`);
    }
  }

  /**
   * Await the previous turn's injection under `TURN_INJECT_SETTLE_MS`, or
   * report it dropped.
   *
   * The timer is cleared in `finally` and only ever armed when an injection is
   * genuinely outstanding, so the ordinary case — a handler that settled while
   * the model was thinking — costs one microtask and no wall clock at all.
   */
  private async settleTurnInjection(sessionId: string, pending: Promise<string | null> | null): Promise<string | null> {
    if (pending === null) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The handler's answer is WRAPPED, so the race's own "timed out" value
      // cannot be confused with it: `null` is a real handler answer ("this
      // trigger has nothing new to say"), and conflating the two would make an
      // overrun indistinguishable from silence — the exact failure this lane
      // must not have.
      const outcome = await Promise.race([
        pending.then((value) => Object.freeze({ value })),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), TURN_INJECT_SETTLE_MS); }),
      ]);
      if (outcome === null) {
        this.engine.record(sessionId, { kind: "diagnostic", payload: { code: "turn_injection_dropped", message: `a turn injection had not settled within ${TURN_INJECT_SETTLE_MS} ms and was dropped rather than carried stale` } });
        return null;
      }
      return outcome.value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async requestModel(
    request: NativeModelRequest,
    signal: AbortSignal | undefined,
    retry: ResolvedNativeRetryPolicy,
    sessionId: string,
    turn: number,
  ): Promise<NativeModelAttempt | null> {
    for (let attempt = 1; attempt <= retry.max_model_attempts_per_turn; attempt += 1) {
      try {
        const response = await this.withModelCredential(async (secret) => this.model.stream === undefined
          ? this.model.run(request, secret, signal ?? neverAbortSignal)
          : collectNativeStream(this.model.stream(request, secret, signal ?? neverAbortSignal)));
        return { kind: "response", response };
      } catch (error) {
        this.recordAbortedTurnUsage(sessionId, error);
        if (signal?.aborted) { this.interrupted(sessionId, turn); return null; }
        const nativeSignal = nativeModelSignal(error);
        if (nativeSignal?.kind === "context_overflow") return { kind: "context_overflow", signal: nativeSignal };
        const classification = this.model.classify_failure?.(error) ?? classifyNativeInferenceFailure(error);
        if (!isRetryClassification(classification)) {
          this.failed(sessionId, turn, "invalid_retry_classification", "model adapter returned invalid retry classification");
          return null;
        }
        if (classification.kind === "retryable" && attempt < retry.max_model_attempts_per_turn) {
          if (classification.retry_after_ms !== null && classification.retry_after_ms > retry.max_delay_ms) {
            this.failed(sessionId, turn, "model_retry_deferred", `provider cooldown of ${classification.retry_after_ms} ms exceeds the ${retry.max_delay_ms} ms automatic retry limit; retry later`);
            return null;
          }
          const delayMs = retryDelayMs(retry, attempt, classification.retry_after_ms);
          const errorKind = isRecord(error) ? error.kind : undefined;
          const failureKind = errorKind === "timeout" || errorKind === "transport" || errorKind === "http"
            || errorKind === "protocol" || errorKind === "credential" ? errorKind : "unknown";
          this.engine.record(sessionId, { kind: "diagnostic", payload: {
            code: "model_retry", message: `model adapter requested a bounded retry after ${delayMs} ms`,
            retry: { attempt, max_attempts: retry.max_model_attempts_per_turn, delay_ms: delayMs, failure_kind: failureKind },
          } });
          if (this.isTerminal(sessionId)) return null;
          const waited = await this.retryDelay.wait(delayMs, signal ?? neverAbortSignal);
          if (waited === "aborted" || signal?.aborted) { this.interrupted(sessionId, turn); return null; }
          if (this.isTerminal(sessionId)) return null;
          continue;
        }
        this.failed(sessionId, turn, classification.kind === "retryable" ? "model_retry_exhausted" : "model_failure", `model port failed: ${describeModelError(error)}`);
        return null;
      }
    }
    return null;
  }

  /**
   * Record the usage of a completed response that the worker is about to fail
   * on a protocol invariant. The provider billed it, so it is recorded and
   * added to the budget's total; the session is ending, so the budget's
   * verdict on it is not consulted.
   */
  private recordUsageOfFailedTurn(sessionId: string, response: NativeModelResponse): void {
    if (this.isTerminal(sessionId)) return;
    if (response.usage !== undefined) this.engine.record(sessionId, { kind: "usage", payload: response.usage });
    else if (response.usage_and_cost !== undefined) this.engine.record(sessionId, { kind: "usage", payload: usageEventFromTypedObservation(response.usage_and_cost) });
    if (response.usage_and_cost !== undefined && !this.isTerminal(sessionId)) this.usageBudget?.observe(response.usage_and_cost);
  }

  /**
   * A turn the adapter aborted mid-stream (its response byte limit) was still
   * billed by the provider. Record what the adapter knew so the session's
   * spend is not silently undercounted: a provider-reported observation is a
   * usage event and is observed by the usage budget like any completed turn;
   * an `unpriced_estimate` is a usage event whose tokens are unavailable by
   * type, plus a diagnostic naming the bound, and is not fed to the budget
   * (it carries no measured tokens or priced cost to add).
   */
  private recordAbortedTurnUsage(sessionId: string, error: unknown): void {
    const aborted = nativeAbortedTurnUsage(error);
    if (aborted === null || this.isTerminal(sessionId)) return;
    this.engine.record(sessionId, { kind: "usage", payload: usageEventFromTypedObservation(aborted.observation) });
    if (aborted.kind === "reported") {
      this.usageBudget?.observe(aborted.observation);
      return;
    }
    if (this.isTerminal(sessionId)) return;
    this.engine.record(sessionId, { kind: "diagnostic", payload: {
      code: "aborted_turn_usage_estimate",
      message: `model turn aborted after ${aborted.response_bytes} response bytes without a provider usage report; unpriced_estimate: at most ${aborted.streamed_output_tokens_upper_bound} output tokens streamed (${aborted.streamed_text_bytes} text bytes); input tokens unknown`,
    } });
  }

  /**
   * Deliver drained operator steering into the conversation as a
   * model-visible operator message. It enters as `human_input` (a user turn
   * in every adapter), never as a `tool_result`, so the model cannot mistake
   * it for tool output; the entry's evidence carries the operator's own
   * provenance, and the text names it as operator steering with that tag so
   * the model can tell it apart from the task and from a human-input answer.
   */
  private deliverSteering(sessionId: string, turns: number, messages: readonly NativeSessionSteeringMessage[], history: NativeConversationEntry[]): NativeWorkerRunResult | null {
    for (const message of messages) {
      if (!validSteeringMessage(message)) return this.failed(sessionId, turns, "steering_invalid", "operator steering inbox returned an invalid message");
      const contextRecord = this.recordContext("human_input", `${sessionId}:steer:${message.message_id}`, operatorSteeringText(message), message.provenance, "human_input");
      if (contextRecord === null) return this.failed(sessionId, turns, "context_budget", "context manager rejected operator steering");
      history.push(Object.freeze({ kind: "human_input", text: contextRecord.text, evidence: [contextRecord.evidence] }));
      this.engine.record(sessionId, { kind: "diagnostic", payload: { code: "operator_steering_received", message: `operator steering received: ${message.message_id}` } });
    }
    return null;
  }

  private recordOverflowRecoveryDiagnostic(sessionId: string, code: string, message: string): void {
    if (!this.isTerminal(sessionId)) this.engine.record(sessionId, { kind: "diagnostic", payload: { code, message } });
  }

  private recordContext(operation: "generate" | "reflect" | "curate" | "evidence" | "human_input", entryId: string, text: string, provenance: Provenance = { tag: "generated", generator: "native-harness-worker", input_hash: stableTextId(text) }, source?: import("./context-manager.js").NativeContextSource, evidence?: readonly NativeContextEvidenceRef[]): RecordedContext | null {
    if (!this.context) return { evidence: Object.freeze({ entry_id: entryId, provenance }), text: this.redact(text) };
    try {
      const append = operation === "generate" ? this.context.generate.bind(this.context)
        : operation === "reflect" ? this.context.reflect.bind(this.context)
          : operation === "curate" ? this.context.curate.bind(this.context)
            : operation === "evidence" ? this.context.evidence.bind(this.context)
              : this.context.humanInput.bind(this.context);
      const entry = append({ entry_id: entryId, text, provenance, ...(source === undefined ? {} : { source }), ...(evidence === undefined ? {} : { evidence }) });
      return Object.freeze({ evidence: Object.freeze({ entry_id: entry.entry_id, provenance: entry.provenance }), text: entry.text });
    } catch (error) {
      if (!(error instanceof NativeContextError)) throw error;
      return null;
    }
  }

  private async requestHumanInput(
    sessionId: string,
    turn: number,
    input: NativeHumanInputRequest,
    history: NativeConversationEntry[],
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (!isHumanInputRequest(input)) { this.failed(sessionId, turn, "invalid_human_input_request", "model port returned an invalid human-input request"); return false; }
    try { this.context?.assertEvidence(input.evidence); } catch { this.failed(sessionId, turn, "human_input_evidence_invalid", "human-input request cited unknown context evidence"); return false; }
    // The request ID remains untouched for handoff and context correlation;
    // diagnostics receive only a bounded, secret-redacted projection.
    const diagnosticRequestId = this.redact(input.request_id).slice(0, 128);
    this.engine.record(sessionId, { kind: "diagnostic", payload: { code: "human_input_requested", message: `human input requested: ${diagnosticRequestId}` } });
    if (!this.humanInput) { this.failed(sessionId, turn, "human_input_unavailable", "human input was required but no handoff port is available"); return false; }
    let result: unknown;
    try { result = await this.humanInput.request(input, signal ?? neverAbortSignal); } catch {
      if (signal?.aborted) { this.interrupted(sessionId, turn); return false; }
      this.failed(sessionId, turn, "human_input_failure", "human-input handoff port failed"); return false;
    }
    if (signal?.aborted) { this.interrupted(sessionId, turn); return false; }
    if (!isHumanInputResult(result)) { this.failed(sessionId, turn, "invalid_human_input_result", "human-input handoff port returned an invalid result"); return false; }
    if (result.kind === "handoff") {
      // A campaign governor, not this bounded model session, owns the
      // resulting RequestUserInput record and any eventual answer.  Finish
      // the session without manufacturing an answer or retaining hidden
      // waiting state in the worker.
      this.engine.record(sessionId, { kind: "diagnostic", payload: { code: "human_input_handed_off", message: this.redact(result.reason) } });
      await this.signalCompletion(sessionId, turn, {
        result: "claimed",
        message: "human input handoff pending campaign governance",
        provenance: { tag: "claimed", claimant: "native-harness-worker" },
      }, signal);
      return false;
    }
    if (result.kind !== "submitted") { this.failed(sessionId, turn, `human_input_${result.kind}`, this.redact(result.reason)); return false; }
    const contextRecord = this.recordContext("human_input", `${sessionId}:human:${turn}:${input.request_id}`, result.response, result.provenance, "human_input");
    if (contextRecord === null) { this.failed(sessionId, turn, "context_budget", "context manager rejected human input"); return false; }
    history.push(Object.freeze({ kind: "human_input", text: contextRecord.text, evidence: [contextRecord.evidence] }));
    this.engine.record(sessionId, { kind: "diagnostic", payload: { code: "human_input_resolved", message: `human input resolved: ${diagnosticRequestId}` } });
    return true;
  }

  /**
   * Dispatches one turn's tool calls per ADR-109: bounded-concurrency
   * parallel dispatch, not a serial `for` and not unbounded `Promise.all`.
   *
   * Grouping (`dispatchWaves`) is the worker's own conflict policy, not the
   * tool host's: every `risk: "high"` call (`NATIVE_REPOSITORY_TOOL_RISKS`
   * -- writes, patches, shell, verification, evidence refresh) runs alone in
   * its own wave, serialized relative to every other call in the turn,
   * because `NativeToolCall.input` is opaque here (`"Passed verbatim only to
   * the selected tool port, never to canonical events"`) -- the worker
   * cannot itself resolve a finer-grained write-target collision, so it
   * treats the risk tier itself as the conflict signal the host's write-path
   * serialization already keys on. Consecutive `risk: "low"` calls (reads)
   * batch together up to `NATIVE_TOOL_DISPATCH_CONCURRENCY` and run
   * concurrently.
   *
   * Each call gets its own scratch `NativeConversationEntry[]` sink instead
   * of the shared `history` array `executeTool` was written against, so
   * `executeTool` itself is unchanged: only what it pushes into is
   * different. After a wave settles, sinks are appended to `history` in
   * `Promise.all`'s (== the wave's original) index order -- never completion
   * order -- so history stays diffable exactly as it was under the serial
   * loop, even though Anthropic itself pairs `tool_result` by `call_id`, not
   * position.
   *
   * `Promise.allSettled` (not `Promise.all`) is deliberate: `executeTool`'s
   * own try/catch already turns every recoverable failure into a resolved
   * `true` plus a recorded `tool_result` -- exactly the existing serial
   * per-call error path -- so one call's outcome never cancels a wave-mate
   * still in flight. A wave member's rejection is a genuine escape from that
   * contract (unexpected, not a modeled failure) and fails the turn rather
   * than silently dropping the call. The shared `signal` still cancels every
   * in-flight call at once on an external interrupt.
   */
  private async dispatchToolCalls(
    sessionId: string,
    turn: number,
    toolCalls: readonly NativeToolCall[],
    policy: ExecutionPolicy,
    history: NativeConversationEntry[],
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    for (const wave of dispatchWaves(toolCalls)) {
      const settled = await Promise.allSettled(wave.map(async ({ call, index }) => {
        const sink: NativeConversationEntry[] = [];
        const stopped = await this.executeTool(sessionId, turn, index + 1, call, policy, sink, signal);
        return { sink, stopped };
      }));
      let stop = false;
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          history.push(...outcome.value.sink);
          if (outcome.value.stopped) stop = true;
        } else {
          this.failed(sessionId, turn, "tool_dispatch_failure", `unexpected tool dispatch failure: ${describeModelError(outcome.reason)}`);
          stop = true;
        }
      }
      if (stop || this.isTerminal(sessionId) || signal?.aborted) return true;
    }
    return false;
  }

  private async executeTool(
    sessionId: string,
    turn: number,
    index: number,
    call: NativeToolCall,
    policy: ExecutionPolicy,
    history: NativeConversationEntry[],
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    this.offeredToolCalls += 1;
    if (!isToolCall(call)) {
      this.failed(sessionId, turn, "invalid_tool_call", "model response contained an invalid tool call");
      return true;
    }
    const refusalKey = approvalMemoKey(call.tool, call.input);
    const priorRefusals = this.workerRefusals.get(refusalKey);
    if (priorRefusals !== undefined && priorRefusals.count >= NATIVE_WORKER_REFUSAL_LOOP_LIMIT) return this.stopRefusalLoop(sessionId, turn, call, priorRefusals.kind);
    // A model-chosen name that is not even a well-formed tool name (text-form
    // tool-call syntax, prose, an unbounded string) cannot name a composed
    // tool, so it gets the same recoverable refusal as an uncomposed one
    // whichever adapter produced it, before any evidence carries it.
    const malformedName = call.uncomposed === undefined && !this.tools.has(call.tool) && !isNativeEvidenceToolName(call.tool);
    if (call.uncomposed !== undefined || malformedName) {
      this.noteWorkerRefusal(refusalKey, "tool_not_composed");
      return this.recordUncomposedToolCall(sessionId, turn, call, history, call.uncomposed?.available_tools ?? [...this.tools.keys()].filter((tool) => isToolPermitted(policy, tool)).sort());
    }
    const port = this.tools.get(call.tool);
    if (!port) {
      this.recordToolResult(sessionId, call.tool, "tool unavailable", failedToolEvidence("audit", "tool_unavailable", "none"));
      this.failed(sessionId, turn, "tool_unavailable", "requested tool has no native port");
      return true;
    }
    if (!isToolPermitted(policy, call.tool)) {
      this.recordToolResult(sessionId, call.tool, "tool denied by immutable policy", refusedToolEvidence("audit", "tool_denied"));
      this.failed(sessionId, turn, "tool_denied", "requested tool is denied by immutable policy");
      return true;
    }
    const contextRefs = call.context_refs !== undefined && call.context_refs.length > 0
      ? call.context_refs
      : this.defaultToolIntentEvidence;
    try { this.context?.assertEvidence(contextRefs); } catch {
      this.failed(sessionId, turn, "tool_intent_evidence_invalid", "tool intent cited unknown context evidence");
      return true;
    }
    const toolRequest: NativeToolRequest = Object.freeze({
      session_id: sessionId, turn, call_id: call.call_id, input: call.input,
      workspace_roots: policy.workspace_roots, filesystem: policy.filesystem,
      network_allowed: policy.network_allowed, intent_evidence: Object.freeze([...contextRefs]),
    });
    const recovery = safeRecoveryProtection(port, toolRequest);
    // An attempted action is canonical evidence even when host admission
    // refuses it before approval/dispatch.
    this.engine.record(sessionId, { kind: "tool_intent", payload: { tool: call.tool, input_summary: this.redact(call.input_summary), annotations: toolOperationAnnotations(recovery), context_refs: contextRefs } });
    if (this.isTerminal(sessionId)) return true;
    let admission: NativeToolPreflightResult | undefined;
    try { admission = port.preflight?.(toolRequest); } catch {
      this.recordToolResult(sessionId, call.tool, "tool admission failed", failedToolEvidence("audit", "tool_preflight_failed", "none"));
      this.failed(sessionId, turn, "tool_preflight_failed", "tool host could not establish action-specific admission");
      return true;
    }
    if (admission !== undefined && !isToolPreflightResult(admission)) {
      this.recordToolResult(sessionId, call.tool, "invalid tool admission", failedToolEvidence("audit", "invalid_tool_preflight", "none"));
      this.failed(sessionId, turn, "invalid_tool_preflight", "tool host returned an invalid action-specific admission");
      return true;
    }
    if (admission !== undefined && !admission.allowed) {
      const redactedReason = this.redact(admission.reason);
      this.recordToolResult(sessionId, call.tool, redactedReason, admission.evidence);
      // Invalid path arguments and scope denials are the actor's own boundary trip -- the model asked
      // outside `write_paths`/`command_argv`/its authorized scope -- and it
      // can try a different, in-scope action next turn. Route those through
      // the same recoverable `tool_result` shape `recordUncomposedToolCall`
      // uses. Every other preflight code (missing_trusted_intent,
      // workspace_roots_mismatch, and anything else the host may return)
      // means composition or the host is broken for this session, not that
      // the model asked outside its bounds; those stay terminal (ADR-117 §2).
      if (RECOVERABLE_PREFLIGHT_CODES.has(admission.code)) {
        // Scope and path denials are the host's own refusals and its own
        // breaker counts them; a hook veto is decided by the governed bus in
        // front of the host, so only this worker can count it.
        if (admission.code === "hook_denied") this.noteWorkerRefusal(refusalKey, "hook_denied");
        return this.recordRecoverableRefusal(sessionId, turn, call, history, withSpecialistRemedy(redactedReason, admission.remedy, (value) => this.redact(value)));
      }
      this.failed(sessionId, turn, admission.code, redactedReason);
      return true;
    }

    if (approvalRequired(policy, call.risk)) {
      const requestId = `${sessionId}:approval:${turn}:${index}`;
      // A decision the operator already made on this exact request is re-served
      // rather than re-asked (see `approvalDenialMemo`). The refusal still
      // reaches the model every turn, so ADR-117's delivery is unchanged.
      const denialKey = approvalMemoKey(call.tool, call.input);
      if (this.approvalDenialMemo.has(denialKey)) {
        this.noteWorkerRefusal(refusalKey, "approval_denied");
        this.recordToolResult(sessionId, call.tool, "tool action was not approved", refusedToolEvidence("audit", "approval_denied"));
        return this.recordRecoverableRefusal(sessionId, turn, call, history, approvalRefusalText(this.approvalDenialMemo.get(denialKey)));
      }
      this.engine.record(sessionId, { kind: "approval_requested", payload: { request_id: requestId, subject: call.tool } });
      if (this.isTerminal(sessionId)) return true;
      if (!this.approvals) {
        this.recordToolResult(sessionId, call.tool, "approval unavailable", failedToolEvidence("audit", "approval_unavailable", "none"));
        this.failed(sessionId, turn, "approval_unavailable", "tool action requires an approval port");
        return true;
      }
      let resolution: unknown;
      try {
        resolution = await this.approvals.decide(Object.freeze({
          session_id: sessionId,
          request_id: requestId,
          tool: call.tool,
          input_summary: this.redact(call.input_summary),
          risk: call.risk,
        }), signal ?? neverAbortSignal);
      } catch {
        if (signal?.aborted) {
          this.engine.interrupt(sessionId, "execution aborted");
          return true;
        }
        this.recordToolResult(sessionId, call.tool, "approval port failed", failedToolEvidence("audit", "approval_failure", "none"));
        this.failed(sessionId, turn, "approval_failure", "approval port failed");
        return true;
      }
      if (signal?.aborted) {
        this.engine.interrupt(sessionId, "execution aborted");
        return true;
      }
      if (!isApprovalResolution(resolution)) {
        this.recordToolResult(sessionId, call.tool, "invalid approval resolution", failedToolEvidence("audit", "invalid_approval_resolution", "none"));
        this.failed(sessionId, turn, "invalid_approval_resolution", "approval port returned an invalid resolution");
        return true;
      }
      this.engine.record(sessionId, { kind: "approval_resolved", payload: { request_id: requestId, approved: resolution.approved, rationale: resolution.rationale } });
      if (!resolution.approved) {
        this.recordToolResult(sessionId, call.tool, "tool action was not approved", refusedToolEvidence("audit", "approval_denied"));
        // Approval denial is recoverable for the same reason a scope denial
        // is (ADR-117 §1) — the model can propose a different action next turn
        // instead of the session ending here. The approver's rationale is on
        // the canonical event stream via `approval_resolved`, but the model
        // does not read that stream, so it is also carried in the refusal the
        // model actually receives; that is the whole point of ADR-117.
        this.approvalDenialMemo.set(denialKey, resolution.rationale);
        this.noteWorkerRefusal(refusalKey, "approval_denied");
        return this.recordRecoverableRefusal(sessionId, turn, call, history, approvalRefusalText(resolution.rationale));
      }
      if (this.isTerminal(sessionId)) return true;
    }

    const memoKey = recovery?.effect_kind === "read_only" && recovery.repeatable
      ? readMemoKey(call.tool, toolRequest.input, toolRequest.workspace_roots, {
        session_id: sessionId,
        purpose: call.input_summary,
        operation_class: recovery.effect_kind,
        intent_evidence: contextRefs,
      })
      : null;
    if (memoKey !== null) {
      const memo = this.readMemo.get(memoKey);
      if (memo !== undefined) {
        this.reusedReads += 1;
        this.avoidedOutputBytes += memo.output_bytes;
        const message = `Unchanged duplicate read suppressed. Reuse ${memo.context_entry_id} (output ${memo.output_digest}).`;
        this.engine.record(sessionId, { kind: "diagnostic", payload: { code: "tool_read_reused", message: `reused prior ${call.tool} result without host execution` } });
        this.recordToolResult(sessionId, call.tool, "unchanged duplicate read reused", memoizedReadEvidence(), memo.source_operation_id, memo.context_entry_id);
        const contextRecord = this.recordContext("evidence", `${sessionId}:tool:${turn}:${call.call_id}`, message, undefined, "tool_output", [memo.source_evidence]);
        if (contextRecord === null) {
          this.failed(sessionId, turn, "context_budget", "context manager rejected memoized tool result");
          return true;
        }
        history.push(Object.freeze({ kind: "tool_result", tool: call.tool, call_id: call.call_id, text: contextRecord.text, evidence: [contextRecord.evidence, memo.source_evidence] }));
        return this.isTerminal(sessionId);
      }
    } else {
      // A write, patch, shell command, opaque external operation, or live
      // non-repeatable read can invalidate an earlier observation. Clear
      // before dispatch even if the host ultimately refuses or fails: unknown
      // effects must not authorize stale reuse.
      this.readMemo.clear();
    }

    let result: unknown;
    try {
      this.hostToolExecutions += 1;
      result = await this.withToolCredential((secret) => port.execute(toolRequest, secret, signal ?? neverAbortSignal));
    } catch {
      if (signal?.aborted) {
        this.engine.interrupt(sessionId, "execution aborted");
        return true;
      }
      this.recordToolResult(sessionId, call.tool, "tool execution failed", failedToolEvidence("execution", "tool_failure", "unknown"));
      this.failed(sessionId, turn, "tool_failure", "tool port failed");
      return true;
    }
    if (signal?.aborted) {
      this.engine.interrupt(sessionId, "execution aborted");
      return true;
    }
    if (!isToolResponse(result)) {
      this.recordToolResult(sessionId, call.tool, "invalid tool response", failedToolEvidence("execution", "invalid_tool_response", "unknown"));
      this.failed(sessionId, turn, "invalid_tool_response", "tool port returned an invalid response");
      return true;
    }
    if (result.governed_artifact_attached !== undefined) {
      if (result.evidence.outcome !== "succeeded" || !this.attachGovernedArtifact(result.governed_artifact_attached)) {
        this.recordToolResult(sessionId, call.tool, "invalid governed artifact attachment", failedToolEvidence("execution", "invalid_governed_artifact", "unknown"));
        this.failed(sessionId, turn, "invalid_governed_artifact", "tool port returned an invalid governed artifact attachment");
        return true;
      }
    }
    const operationId = this.recordToolResult(sessionId, call.tool, this.redact(result.result_summary), result.evidence);
    const contextRecord = this.recordContext("evidence", `${sessionId}:tool:${turn}:${call.call_id}`, result.model_output, undefined, "tool_output");
    if (contextRecord === null) {
      this.failed(sessionId, turn, "context_budget", "context manager rejected tool output");
      return true;
    }
    history.push(Object.freeze({ kind: "tool_result", tool: call.tool, call_id: call.call_id, text: contextRecord.text, evidence: [contextRecord.evidence] }));
    if (memoKey !== null && result.evidence.outcome === "succeeded") {
      this.readMemo.set(memoKey, Object.freeze({ context_entry_id: contextRecord.evidence.entry_id, source_evidence: contextRecord.evidence, source_operation_id: operationId, output_digest: sha256Text(contextRecord.text), output_bytes: Buffer.byteLength(contextRecord.text, "utf8") }));
    }
    return this.isTerminal(sessionId);
  }

  /**
   * A preflight scope denial or an approval denial (ADR-117) is a
   * recoverable protocol event, mirroring `recordUncomposedToolCall` below:
   * the action was refused and never dispatched (the audit-only
   * `recordToolResult` call the caller already made is untouched), but
   * `history` still gets the same `tool_result` shape so the model sees why
   * and can attempt a different, in-scope action on its next turn instead of
   * the session ending here. `message` is the same code/reason string the
   * caller already computed and already recorded to the audit trail --
   * this only changes which channel it also reaches, never its content
   * (message wording is ADR-118's concern, not this method's).
   *
   * Bounding: this does not add a new retry loop. The worker's existing
   * per-session turn budget (`withTurnBudgetNote`/`maxTurns`) already caps
   * total turns regardless of how any single turn resolves, so a session
   * that keeps tripping the same scope or approval boundary still
   * terminates -- it runs longer before failing (as ADR-117's Consequences
   * section accepts), it does not run forever.
   */
  private recordRecoverableRefusal(sessionId: string, turn: number, call: NativeToolCall, history: NativeConversationEntry[], message: string): boolean {
    if (this.isTerminal(sessionId)) return true;
    const contextRecord = this.recordContext("evidence", `${sessionId}:tool:${turn}:${call.call_id}`, message, undefined, "tool_output");
    if (contextRecord === null) {
      this.failed(sessionId, turn, "context_budget", "context manager rejected refusal result");
      return true;
    }
    history.push(Object.freeze({ kind: "tool_result", tool: call.tool, call_id: call.call_id, text: contextRecord.text, evidence: [contextRecord.evidence] }));
    return this.isTerminal(sessionId);
  }

  private noteWorkerRefusal(key: string, kind: NativeWorkerRefusalKind): void {
    const prior = this.workerRefusals.get(key);
    this.workerRefusals.set(key, { count: (prior?.count ?? 0) + 1, kind });
  }

  /**
   * The worker's no-progress breaker: the model proposed a call the worker
   * has already refused `NATIVE_WORKER_REFUSAL_LOOP_LIMIT` times, identically.
   * Nothing is asked or dispatched again. The stopped call is recorded as
   * refused under the same code as its earlier refusals (as a remembered
   * approval denial already is), then the session ends with
   * `tool_refusal_loop` and the typed remedy for that refusal kind.
   */
  private stopRefusalLoop(sessionId: string, turn: number, call: NativeToolCall, kind: NativeWorkerRefusalKind): boolean {
    const remedy = nativeWorkerRefusalLoopRemedy(kind, nativeEvidenceToolName(call.tool));
    this.recordToolResult(sessionId, call.tool, "identical refused call stopped by the no-progress breaker", refusedToolEvidence("audit", kind));
    this.failed(sessionId, turn, NATIVE_WORKER_REFUSAL_LOOP_CODE, `${remedy.summary} ${remedy.remediation}`);
    return true;
  }

  /**
   * A provider requesting a tool name outside the composed set is a
   * recoverable protocol event, not a fatal one: nothing is dispatched, and
   * the model sees a typed "tool not available" result naming what it can
   * actually call, exactly as it would recover from any other tool refusal.
   * Unlike `this.tools.get(call.tool)` returning undefined (a genuine
   * wiring gap between an advertised, host-composed tool and its port),
   * this never calls `this.failed()` -- the turn continues.
   */
  private recordUncomposedToolCall(sessionId: string, turn: number, call: NativeToolCall, history: NativeConversationEntry[], availableTools: readonly string[]): boolean {
    // The model sees what it asked for (bounded) so it can correct itself;
    // the canonical evidence below only ever carries an evidence-safe label.
    const message = `Tool '${call.tool.slice(0, 128)}' is not available for this session. Available tools: ${availableTools.length > 0 ? availableTools.join(", ") : "(none)"}. Call a tool only through the tool-calling interface, by one of those exact names; never write tool-call syntax as text.`;
    // No `tool_intent` event here: that canonical kind is gated by immutable
    // session policy (`isToolPermitted`, see `NativeSessionEngine.record`),
    // and a name outside the composed set was never on that allow-list by
    // construction -- recording one would either throw or misrepresent an
    // attempt against a policy the tool was never checked against. The
    // refused `tool_result` below is the honest canonical trace of this call.
    this.recordToolResult(sessionId, call.tool, "requested tool was not composed for this session", refusedToolEvidence("audit", "tool_not_composed"));
    if (this.isTerminal(sessionId)) return true;
    const contextRecord = this.recordContext("evidence", `${sessionId}:tool:${turn}:${call.call_id}`, message, undefined, "tool_output");
    if (contextRecord === null) {
      this.failed(sessionId, turn, "context_budget", "context manager rejected uncomposed-tool result");
      return true;
    }
    history.push(Object.freeze({ kind: "tool_result", tool: call.tool, call_id: call.call_id, text: contextRecord.text, evidence: [contextRecord.evidence] }));
    return this.isTerminal(sessionId);
  }

  /**
   * Validate and retain one mid-session governed artifact attach, reusing
   * `freezeGovernedContext`'s existing artifact validation so this is not a
   * second, divergent shape check. Returns false (never throws) on a
   * malformed artifact so the caller can fail the session cleanly.
   * Idempotent by `artifact_id`: re-attaching the same image is a no-op
   * rather than duplicating it in every subsequent turn's content blocks.
   */
  private attachGovernedArtifact(artifact: NativeGovernedArtifact): boolean {
    try {
      const validated = freezeGovernedContext({ instructions: [], artifacts: [artifact] })
        .artifacts[0]!;
      if (!this.attachedGovernedArtifacts.some((existing) => existing.artifact_id === validated.artifact_id)) {
        this.attachedGovernedArtifacts.push(validated);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The rejection reason if a required structured output is retryable (absent,
   * or present but rejected by the caller-owned contract), else null. A
   * validator that itself throws or returns an invalid shape is NOT retryable —
   * that is a composition fault, not a model miss, and `complete()` fails it
   * terminally.
   */
  /**
   * A turn-gate refusal, redacted and bounded before it enters a prompt that
   * is recomposed on every later turn of the run.
   *
   * Truncation is announced rather than silent, so a model told to act on half
   * a reason knows it is half.
   */
  private boundedTurnRefusal(reason: string): string {
    const redacted = this.redact(reason);
    return redacted.length <= TURN_GATE_REASON_BYTES
      ? redacted
      : `${redacted.slice(0, TURN_GATE_REASON_BYTES)} […truncated: the refusal exceeded ${TURN_GATE_REASON_BYTES} bytes]`;
  }

  /**
   * The caller-owned structured-output contract's rejection reason, when the
   * contract is present and rejected it (absent, present but rejected by the
   * caller-owned contract), else null. A validator that itself throws or
   * returns an invalid shape is NOT retryable — that is a composition fault,
   * not a model miss, and `complete()` fails it terminally.
   */
  private structuredRetryReason(contract: NativeStructuredOutputContract | undefined, structuredOutput: unknown, unparsed?: string): string | null {
    if (contract === undefined) return null;
    if (structuredOutput === undefined) return unparsed === undefined ? "no structured output was provided" : unparsedStructuredReason(contract, unparsed);
    let validation: unknown;
    try { validation = contract.validate(structuredOutput); } catch { return null; }
    if (!isStructuredValidation(validation)) return null;
    return validation.valid ? null : (validation.reason ?? "structured output was rejected");
  }

  private async complete(
    sessionId: string,
    turns: number,
    finalMessage: string,
    structuredOutput: unknown,
    contract: NativeStructuredOutputContract | undefined,
    history: readonly NativeConversationEntry[],
    signal: AbortSignal | undefined,
    unparsed?: string,
  ): Promise<NativeWorkerRunResult> {
    const safeFinalMessage = this.redact(finalMessage);
    // A concurrent observer (for example live-session polling) may have
    // enforced the wall-clock policy after the connector returned but before
    // this worker reaches its finalization boundary. That terminal outcome
    // wins over late model output; do not attempt the active-only completion
    // call or promote the result's provenance.
    if (this.isTerminal(sessionId)) return this.result(sessionId, turns);
    if (contract !== undefined) {
      // A reply with no JSON value, once its corrections are spent, fails as
      // invalid structured output under the contract's own reason, exactly as
      // rejected JSON does, so a caller classifies both alike.
      if (structuredOutput === undefined && unparsed !== undefined) return this.failed(sessionId, turns, "structured_output_invalid", this.redact(unparsedStructuredReason(contract, unparsed)));
      if (structuredOutput === undefined) return this.failed(sessionId, turns, "structured_output_missing", "model did not provide required structured output");
      let validation: unknown;
      try { validation = contract.validate(structuredOutput); } catch { return this.failed(sessionId, turns, "structured_output_validation_failure", "structured-output validator failed"); }
      if (!isStructuredValidation(validation)) return this.failed(sessionId, turns, "invalid_structured_output_validation", "structured-output validator returned an invalid result");
      if (!validation.valid) return this.failed(sessionId, turns, "structured_output_invalid", this.redact(validation.reason ?? "structured output was rejected"));
    }
    let verified: unknown = null;
    if (this.governedCompletion) {
      try {
        verified = await this.governedCompletion.verify(Object.freeze({ session_id: sessionId, final_message: safeFinalMessage, history: Object.freeze(history.slice()) }), signal ?? neverAbortSignal);
      } catch {
        if (signal?.aborted) return this.interrupted(sessionId, turns);
        return this.failed(sessionId, turns, "verification_failure", "governed completion boundary failed");
      }
    }
    if (signal?.aborted) return this.interrupted(sessionId, turns);
    // Governed verification may itself take long enough for an observer to
    // terminalize the session. Preserve that operational stop rather than
    // turning it into a HarnessSessionError from `complete()`.
    if (this.isTerminal(sessionId)) return this.result(sessionId, turns);
    if (verified !== null && !isVerifiedCompletion(verified)) {
      return this.failed(sessionId, turns, "invalid_verification", "governed completion boundary returned invalid evidence");
    }
    const completion: NativeSignaledCompletion = verified === null
      ? { result: "claimed", message: safeFinalMessage, provenance: { tag: "claimed", claimant: "native-harness-worker" } }
      : { result: "verified", message: this.redact(verified.message), provenance: verified.provenance };
    return this.signalCompletion(sessionId, turns, completion, signal, contract === undefined ? null : structuredOutput);
  }

  /** Run the fail-closed veto at the last boundary before signaling completion. */
  private async signalCompletion(
    sessionId: string,
    turns: number,
    completion: NativeSignaledCompletion,
    signal: AbortSignal | undefined,
    structuredOutput: unknown = null,
  ): Promise<NativeWorkerRunResult> {
    if (this.isTerminal(sessionId)) return this.result(sessionId, turns);
    // Keep the value inspected by governance identical to the value passed to
    // the engine, even if an implementation ignores the readonly contract.
    const provenance = completion.provenance;
    const guardedProvenance = provenance.tag === "verified"
      ? Object.freeze({
        ...provenance,
        ...(provenance.check === undefined ? {} : {
          check: Object.freeze({
            kind: provenance.check.kind,
            breadth: provenance.check.breadth,
          }),
        }),
      })
      : Object.freeze({ ...provenance });
    const guardedCompletion: NativeSignaledCompletion = Object.freeze({
      ...completion,
      provenance: guardedProvenance,
    }) as NativeSignaledCompletion;
    if (this.completionGuard !== undefined) {
      let decision: unknown;
      try {
        decision = await this.completionGuard.authorize(Object.freeze({ session_id: sessionId, completion: guardedCompletion }), signal ?? neverAbortSignal);
      } catch {
        if (signal?.aborted) return this.interrupted(sessionId, turns);
        return this.failed(sessionId, turns, "completion_guard_failure", "pre-signal completion governance failed");
      }
      if (signal?.aborted) return this.interrupted(sessionId, turns);
      if (this.isTerminal(sessionId)) return this.result(sessionId, turns);
      if (decision === "deny") return this.failed(sessionId, turns, "completion_denied", "pre-signal completion governance denied completion");
      if (decision !== "allow") return this.failed(sessionId, turns, "completion_guard_failure", "pre-signal completion governance returned an invalid decision");
    }
    if (signal?.aborted) return this.interrupted(sessionId, turns);
    if (this.isTerminal(sessionId)) return this.result(sessionId, turns);
    this.engine.complete(sessionId, guardedCompletion);
    return this.result(sessionId, turns, structuredOutput);
  }

  private failed(sessionId: string, turns: number, code: string, message: string): NativeWorkerRunResult {
    if (!this.isTerminal(sessionId)) {
      const safeMessage = this.redact(message);
      this.engine.record(sessionId, { kind: "diagnostic", payload: { code, message: safeMessage } });
      if (!this.isTerminal(sessionId)) this.engine.fail(sessionId, safeMessage);
    }
    return this.result(sessionId, turns);
  }

  private recordToolResult(sessionId: string, tool: string, resultSummary: string, evidence: NativeToolExecutionEvidence, reusedFromOperationId?: string, reusedContextEntryId?: string): string {
    const normalized = evidence.confinement === undefined ? Object.freeze({ ...evidence, confinement: "application_validated" as const }) : evidence;
    const nextSequence = this.engine.inspect(sessionId).latest_sequence + 1;
    const operationId = sha256Text(`${sessionId}:${nextSequence}`);
    this.engine.record(sessionId, {
      kind: "tool_result",
      payload: Object.freeze({ tool: nativeEvidenceToolName(tool), result_summary: this.redact(resultSummary), success: normalized.outcome === "succeeded", evidence: normalized, operation_id: operationId, ...(reusedFromOperationId === undefined ? {} : { reused_from_operation_id: reusedFromOperationId }), ...(reusedContextEntryId === undefined ? {} : { reused_context_entry_id: reusedContextEntryId }) }),
    });
    return operationId;
  }

  /** Drives one turn's `compact()` attempt and mirrors its outcome into the canonical event stream, so a skip is as auditable as a real compaction. */
  private async recordCompaction(sessionId: string, context: NativeContextManager, compactionId: string, turn: number, force = false): Promise<Awaited<ReturnType<NativeContextManager["compact"]>>> {
    const outcome = await context.compact({ compaction_id: compactionId, turn, force });
    if (outcome.kind === "compacted") {
      this.contextCompactions.push(outcome.evidence);
      this.engine.record(sessionId, {
        kind: "diagnostic",
        payload: { code: "context_compacted", message: `context compacted via ${outcome.evidence.method}: ${outcome.evidence.pre_tokens} -> ${outcome.evidence.post_tokens} tokens, anchor ${outcome.evidence.anchor_entry_id}` },
      });
    } else if (outcome.kind === "skipped") {
      this.engine.record(sessionId, {
        kind: "diagnostic",
        payload: { code: "context_compaction_skipped", message: `context compaction skipped (${outcome.reason}): ${outcome.detail}` },
      });
    } else if (outcome.kind === "cooldown") {
      this.engine.record(sessionId, {
        kind: "diagnostic",
        payload: { code: "context_compaction_cooldown", message: `context compaction deferred for ${outcome.remaining_turns} turn(s); eligible again at turn ${outcome.cooldown_until_turn}` },
      });
    }
    // "disabled" and "not_triggered" are routine; cooldown is emitted because
    // it changes the next recovery decision and must be explainable.
    return outcome;
  }

  private interrupted(sessionId: string, turns: number): NativeWorkerRunResult {
    if (!this.isTerminal(sessionId)) this.engine.interrupt(sessionId, "execution aborted");
    return this.result(sessionId, turns);
  }

  private result(sessionId: string, turns: number, structuredOutput: unknown | null = null): NativeWorkerRunResult {
    return Object.freeze({
      session: this.engine.inspect(sessionId),
      turns_started: turns,
      model_identity: freezeModelIdentity(this.model.identity),
      usage_and_cost: this.usageBudget?.total() ?? null,
      structured_output: structuredOutput,
      context_composition: this.context?.observeComposition() ?? null,
      context_compactions: Object.freeze([...this.contextCompactions]),
      tool_economy: Object.freeze({ offered_calls: this.offeredToolCalls, host_executions: this.hostToolExecutions, reused_reads: this.reusedReads, avoided_output_bytes: this.avoidedOutputBytes }),
    });
  }

  private isTerminal(sessionId: string): boolean {
    const state = this.engine.inspect(sessionId).state;
    return state === "completed" || state === "failed" || state === "interrupted";
  }

  private redact(value: string): string { return this.context?.redact(value) ?? redactNativeText(value); }

  private async withModelCredential<T>(operation: (secret: string | null) => Promise<T>): Promise<T> {
    if (!this.modelCredentialResolved) {
      this.resolvedModelCredential = this.modelCredential ?? this.modelCredentialFactory?.();
      this.modelCredentialResolved = true;
    }
    const credential = this.resolvedModelCredential;
    return credential ? credential.inject(operation) : operation(null);
  }

  private async withToolCredential<T>(operation: (secret: string | null) => Promise<T>): Promise<T> {
    if (!this.toolCredentialResolved) {
      this.resolvedToolCredential = this.toolCredential ?? this.toolCredentialFactory?.();
      this.toolCredentialResolved = true;
    }
    const credential = this.resolvedToolCredential;
    return credential ? credential.inject(operation) : operation(null);
  }
}

const MAX_REPLAY_HISTORY_ENTRIES = 2_048;
const MAX_REPLAY_TEXT_BYTES = 1_048_576;
const MAX_REPLAY_TOTAL_BYTES = 8_388_608;

function normalizeInitialHistory(value: readonly NativeConversationEntry[]): readonly NativeConversationEntry[] {
  if (!Array.isArray(value) || value.length > MAX_REPLAY_HISTORY_ENTRIES) throw new NativeWorkerError("initial_history exceeds the bounded replay entry limit");
  let total = 0;
  const normalized = value.map((entry) => {
    if (entry === null || typeof entry !== "object" || !new Set(["model_text", "tool_result", "human_input"]).has(entry.kind) || typeof entry.text !== "string" || !entry.text.trim()) throw new NativeWorkerError("initial_history contains an invalid conversation entry");
    const bytes = Buffer.byteLength(entry.text, "utf8"); total += bytes;
    if (bytes > MAX_REPLAY_TEXT_BYTES || total > MAX_REPLAY_TOTAL_BYTES) throw new NativeWorkerError("initial_history exceeds the bounded replay text limit");
    if (entry.tool !== undefined && (typeof entry.tool !== "string" || !entry.tool.trim())) throw new NativeWorkerError("initial_history contains an invalid tool identity");
    if (entry.call_id !== undefined && (typeof entry.call_id !== "string" || !entry.call_id.trim())) throw new NativeWorkerError("initial_history contains an invalid call identity");
    const evidence = entry.evidence?.map((ref: NativeContextEvidenceRef) => Object.freeze({ entry_id: ref.entry_id, provenance: Object.freeze({ ...ref.provenance }) }));
    return Object.freeze({ kind: entry.kind, text: entry.text, ...(entry.tool === undefined ? {} : { tool: entry.tool }), ...(entry.call_id === undefined ? {} : { call_id: entry.call_id }), ...(evidence === undefined ? {} : { evidence: Object.freeze(evidence) }) });
  });
  return Object.freeze(normalized);
}

function freezeConversationCheckpoint(sessionId: string, nextTurn: number, capturedSequence: number, prompt: string, history: readonly NativeConversationEntry[]): NativeConversationCheckpoint {
  if (Buffer.byteLength(prompt, "utf8") > MAX_REPLAY_TEXT_BYTES) throw new NativeWorkerError("prompt exceeds the protected replay text limit");
  return Object.freeze({ version: 1, session_id: sessionId, next_turn: nextTurn, captured_sequence: capturedSequence, prompt, history: normalizeInitialHistory(history) });
}

function validSteeringMessage(value: NativeSessionSteeringMessage): boolean {
  return value !== null && typeof value === "object" && typeof value.message_id === "string" && !!value.message_id.trim() && value.message_id.length <= 1_024
    && typeof value.text === "string" && !!value.text.trim() && Buffer.byteLength(value.text, "utf8") <= 8_192
    && value.provenance !== null && typeof value.provenance === "object" && typeof value.provenance.tag === "string";
}

/**
 * The model-visible form of one operator steering message: who sent it, its
 * provenance tag, and the (already host-redacted) text.
 */
export function operatorSteeringText(message: NativeSessionSteeringMessage): string {
  return `Operator steering (message ${message.message_id.slice(0, 128)}, provenance ${message.provenance.tag}). This instruction comes from the operator supervising this session, not from a tool. Take it into account from this turn on:\n${message.text}`;
}

const neverAbortSignal = new AbortController().signal;

/**
 * Bounded, fixed concurrency for a turn's low-risk (read) tool calls --
 * deliberately not unbounded `Promise.all`. A turn that also spawns a
 * high-risk call (e.g. `subagent.execute`) never lets it join this pool: see
 * `dispatchWaves`. The limit is a worker-owned constant, not caller-composed,
 * mirroring the fixed serial-loop behavior it replaces.
 */
const NATIVE_TOOL_DISPATCH_CONCURRENCY = 4;

/**
 * Partitions one turn's tool calls, in original order, into dispatch waves:
 * every `risk: "high"` call gets its own solo wave (serialized relative to
 * everything else in the turn, since the worker cannot resolve a
 * finer-grained write-target collision than the host's risk tier -- see
 * `dispatchToolCalls`); consecutive `risk: "low"` calls batch together up to
 * `NATIVE_TOOL_DISPATCH_CONCURRENCY` per wave.
 */
function dispatchWaves(toolCalls: readonly NativeToolCall[]): ReadonlyArray<ReadonlyArray<{ readonly call: NativeToolCall; readonly index: number }>> {
  const waves: Array<Array<{ call: NativeToolCall; index: number }>> = [];
  let current: Array<{ call: NativeToolCall; index: number }> = [];
  const flush = () => { if (current.length > 0) { waves.push(current); current = []; } };
  toolCalls.forEach((call, index) => {
    if (call.risk === "high") {
      flush();
      waves.push([{ call, index }]);
      return;
    }
    current.push({ call, index });
    if (current.length >= NATIVE_TOOL_DISPATCH_CONCURRENCY) flush();
  });
  flush();
  return waves;
}

function approvalRequired(policy: ExecutionPolicy, risk: NativeToolRisk): boolean {
  return policy.approvals === "always" || (policy.approvals === "on_risk" && risk === "high");
}

function isModelResponse(value: unknown): value is NativeModelResponse {
  if (!isRecord(value)) return false;
  return Array.isArray(value.text)
    && value.text.every((text) => typeof text.text === "string" && (text.phase === "commentary" || text.phase === "final"))
    && (value.thinking === undefined || (Array.isArray(value.thinking) && value.thinking.every((thinking) => isThinking(thinking))))
    && Array.isArray(value.tool_calls)
    && (value.final_message === null || typeof value.final_message === "string")
    && (value.usage === undefined || isUsage(value.usage))
    && (value.usage_and_cost === undefined || isNativeUsageAndCost(value.usage_and_cost))
    && (value.structured_output_unparsed === undefined || typeof value.structured_output_unparsed === "string")
    && (value.stop_reason === undefined || isStopReason(value.stop_reason))
    && (value.human_input_request === undefined || isHumanInputRequest(value.human_input_request));
}

function isStopReason(value: unknown): value is NativeModelStopReason {
  return typeof value === "string" && (NATIVE_MODEL_STOP_REASONS as readonly string[]).includes(value);
}

function isThinking(value: unknown): value is NativeModelThinking {
  return isRecord(value) && typeof value.text === "string" && typeof value.signature === "string";
}

function isUsage(value: unknown): value is NativeUsageObservation {
  if (!isRecord(value)) return false;
  return (value.input_tokens === null || (typeof value.input_tokens === "number" && isNonNegativeSafeInteger(value.input_tokens)))
    && (value.output_tokens === null || (typeof value.output_tokens === "number" && isNonNegativeSafeInteger(value.output_tokens)))
    && (value.unavailable_reason === undefined || typeof value.unavailable_reason === "string");
}

function isToolCall(value: unknown): value is NativeToolCall {
  if (!isRecord(value)) return false;
  return typeof value.call_id === "string" && value.call_id.trim().length > 0
    && typeof value.tool === "string" && value.tool.trim().length > 0
    && typeof value.input_summary === "string"
    && (value.risk === "low" || value.risk === "high")
    && (value.context_refs === undefined || isContextRefs(value.context_refs))
    && (value.uncomposed === undefined || isUncomposedToolCall(value.uncomposed));
}

function isUncomposedToolCall(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.available_tools) && value.available_tools.every((tool) => typeof tool === "string");
}

function isToolResponse(value: unknown): value is NativeToolResponse {
  if (!isRecord(value)) return false;
  return typeof value.result_summary === "string" && typeof value.model_output === "string" && isToolExecutionEvidence(value.evidence);
}

function isApprovalResolution(value: unknown): value is NativeApprovalResolution {
  if (!isRecord(value)) return false;
  return typeof value.approved === "boolean" && typeof value.rationale === "string";
}

function isVerifiedCompletion(value: unknown): value is NativeVerifiedCompletion {
  if (!isRecord(value) || !isRecord(value.provenance)) return false;
  return typeof value.message === "string" && value.message.trim().length > 0 && value.provenance.tag === "verified";
}

function isContextRefs(value: unknown): value is readonly NativeContextEvidenceRef[] {
  return Array.isArray(value) && value.every((ref) => isRecord(ref) && typeof ref.entry_id === "string" && ref.entry_id.trim().length > 0 && isRecord(ref.provenance) && typeof ref.provenance.tag === "string");
}

function isHumanInputRequest(value: unknown): value is NativeHumanInputRequest {
  return isRecord(value)
    && typeof value.request_id === "string" && value.request_id.trim().length > 0
    && typeof value.question === "string" && value.question.trim().length > 0
    && typeof value.reason === "string" && value.reason.trim().length > 0
    && isContextRefs(value.evidence);
}

function isHumanInputResult(value: unknown): value is import("./inference.js").NativeHumanInputResult {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  return value.kind === "submitted"
    ? typeof value.response === "string" && isRecord(value.provenance) && typeof value.provenance.tag === "string"
    : (value.kind === "handoff" || value.kind === "declined" || value.kind === "unavailable") && typeof value.reason === "string";
}

function isRetryClassification(value: unknown): value is NativeRetryClassification {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.reason !== "string") return false;
  return value.kind === "terminal" || (value.kind === "retryable" && (value.retry_after_ms === null || (typeof value.retry_after_ms === "number" && isNonNegativeSafeInteger(value.retry_after_ms))));
}

function isToolPreflightResult(value: unknown): value is NativeToolPreflightResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.allowed === true || (record.allowed === false && typeof record.code === "string" && record.code.length > 0 && typeof record.reason === "string" && record.reason.length > 0 && isToolExecutionEvidence(record.evidence)
    // A remedy is optional, but a present one must be a complete v2 remedy:
    // a malformed one is an invalid admission, never silently dropped.
    && (record.remedy === undefined || (isRuntimeGateRefusal(record.remedy) && record.remedy.schema_version === 2)));
}

function isToolExecutionEvidence(value: unknown): value is NativeToolExecutionEvidence {
  if (!isRecord(value) || typeof value.code !== "string" || value.code.length === 0 || !isRecord(value.action_scope)) return false;
  const scope = value.action_scope;
  const scopeStatus = scope.status === "not_required" || scope.status === "bound" || scope.status === "absent" || scope.status === "invalid";
  const provenance = scope.provenance_tag === undefined || scope.provenance_tag === "verified" || scope.provenance_tag === "claimed" || scope.provenance_tag === "critic_approved" || scope.provenance_tag === "generated";
  const scopeId = typeof scope.scope_id_hash === "string" && /^sha256:[a-f0-9]{64}$/.test(scope.scope_id_hash);
  const scopeInvariant = scope.status === "bound"
    ? scopeId && provenance && scope.provenance_tag !== undefined
    : scope.scope_id_hash === undefined && (scope.status === "not_required" || scope.status === "absent" ? scope.provenance_tag === undefined : provenance);
  const outcome = value.outcome === "succeeded" || value.outcome === "refused" || value.outcome === "failed" || value.outcome === "cancelled" || value.outcome === "truncated";
  const effect = value.effect === "none" || value.effect === "observed" || value.effect === "applied" || value.effect === "unknown";
  const confinement = value.confinement === undefined || value.confinement === "application_validated" || value.confinement === "os_confined" || value.confinement === "container_confined" || value.confinement === "remote_attested";
  const outcomeEffectInvariant = (value.outcome === "refused" && value.effect === "none")
    || (value.outcome === "succeeded" && value.effect !== "none")
    || ((value.outcome === "failed" || value.outcome === "cancelled" || value.outcome === "truncated") && (value.effect === "none" || value.effect === "unknown"));
  return outcome
    && (value.stage === "semantic" || value.stage === "audit" || value.stage === "sandbox" || value.stage === "execution")
    && effect && confinement && scopeStatus && scopeInvariant && outcomeEffectInvariant;
}

const NO_ACTION_SCOPE: NativeToolActionScopeEvidence = Object.freeze({ status: "not_required" });
function refusedToolEvidence(stage: NativeToolExecutionStage, code: string, actionScope: NativeToolActionScopeEvidence = NO_ACTION_SCOPE): NativeToolExecutionEvidence {
  return Object.freeze({ outcome: "refused", stage, code, effect: "none", confinement: "application_validated", action_scope: actionScope });
}
function failedToolEvidence(stage: NativeToolExecutionStage, code: string, effect: NativeToolEffect, actionScope: NativeToolActionScopeEvidence = NO_ACTION_SCOPE): NativeToolExecutionEvidence {
  return Object.freeze({ outcome: "failed", stage, code, effect, confinement: "application_validated", action_scope: actionScope });
}
function memoizedReadEvidence(): NativeToolExecutionEvidence {
  return Object.freeze({ outcome: "succeeded", stage: "execution", code: "memoized_read", effect: "observed", confinement: "application_validated", action_scope: NO_ACTION_SCOPE });
}

function safeRecoveryProtection(port: NativeToolPort, request: NativeToolRequest): ReturnType<NonNullable<NativeToolPort["recovery_protection"]>> | null {
  try {
    const value = port.recovery_protection?.(request);
    if (value === undefined) return null;
    if (!(["read_only", "file_write", "file_patch", "shell", "external"] as const).includes(value.effect_kind)
      || typeof value.repeatable !== "boolean") return null;
    return value;
  } catch {
    return null;
  }
}

/** Host declarations are projected into observable hints, never dispatch authority. */
function toolOperationAnnotations(recovery: ReturnType<NonNullable<NativeToolPort["recovery_protection"]>> | null): NativeToolOperationAnnotations {
  const effectKind = recovery?.effect_kind ?? "unknown";
  const readOnly = effectKind === "read_only";
  const openWorld = effectKind === "shell" || effectKind === "external" || effectKind === "unknown";
  const mutating = !readOnly;
  return Object.freeze({
    effect_kind: effectKind,
    read_only: readOnly,
    repeatable: recovery?.repeatable ?? false,
    mutating,
    destructive: effectKind !== "read_only",
    open_world: openWorld,
    ownership: "session",
  });
}

/**
 * Workspace roots are an authorization set, so their presentation order must
 * not defeat exact-read reuse.  Hosts may derive the same roots from maps with
 * different insertion order across turns; sorting here keeps the fingerprint
 * content-addressed while preserving the full scope in the key.
 */
export function readMemoKey(
  tool: string,
  input: unknown,
  workspaceRoots: readonly string[],
  scope: {
    readonly session_id?: string;
    /** Caller-supplied intent summary is included conservatively as purpose. */
    readonly purpose?: string;
    readonly operation_class?: "read_only";
    readonly intent_evidence?: readonly NativeContextEvidenceRef[];
  } = {},
): string {
  return sha256Text(canonicalJson({
    session_id: scope.session_id ?? "",
    tool,
    operation_class: scope.operation_class ?? "read_only",
    purpose: scope.purpose ?? "",
    input,
    workspace_roots: [...workspaceRoots].sort(),
    intent_evidence: (scope.intent_evidence ?? []).map((ref) => ({ entry_id: ref.entry_id, provenance: ref.provenance })),
  }));
}

/** Identifies the exact request an operator ruled on, so only an unchanged one is re-served. */
function approvalMemoKey(tool: string, input: unknown): string {
  return sha256Text(canonicalJson({ tool, input }));
}

/**
 * The refusal the model receives for a denied approval. The operator's own
 * rationale is included when they gave one — a model told only "not approved"
 * has nothing to adapt toward and will usually re-propose the same action.
 */
/**
 * Append a typed remedy to a model-visible refusal only when the model is the
 * actor it names: a remedy owned by the operator or the runtime host is not an
 * instruction the model can carry out, and rendering it would invite the model
 * to try.
 */
function withSpecialistRemedy(reason: string, remedy: RuntimeGateRefusalV2 | undefined, redact: (value: string) => string): string {
  if (remedy === undefined || remedy.correcting_actor !== "specialist") return reason;
  return `${reason}\nCorrecting actor: ${remedy.correcting_actor}. Corrective action: ${remedy.corrective_action}. Remedy: ${redact(remedy.remediation).slice(0, 512)}`;
}

function approvalRefusalText(rationale: string | undefined): string {
  const trimmed = rationale?.trim();
  return trimmed === undefined || trimmed.length === 0
    ? "tool action was not approved"
    : `tool action was not approved: ${trimmed.slice(0, 512)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The shape a tool name must have to be canonical session evidence: the
 * same bounded atom the durable session journal and tool audit accept.
 * Every host-composed tool name has it; a model-chosen name may not.
 */
const NATIVE_EVIDENCE_TOOL_NAME = /^[a-zA-Z0-9._:-]{1,128}$/;

export function isNativeEvidenceToolName(value: string): boolean {
  return NATIVE_EVIDENCE_TOOL_NAME.test(value);
}

/**
 * The evidence-safe label for a tool name. A well-formed name is kept
 * verbatim; any other model-chosen string becomes `malformed_tool_name.`
 * plus a 16-hex digest, so repeated attempts at the same name stay
 * distinguishable without the raw bytes ever becoming evidence (D6, UCT
 * Stage 0 pilot 4: such a name was refused by the journal and ended the
 * whole campaign).
 */
export function nativeEvidenceToolName(value: string): string {
  return isNativeEvidenceToolName(value) ? value : `malformed_tool_name.${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isStructuredValidation(value: unknown): value is { readonly valid: boolean; readonly reason?: string } {
  return isRecord(value) && (value.valid === true || (value.valid === false && typeof value.reason === "string"));
}

interface ResolvedNativeRetryPolicy {
  readonly max_model_attempts_per_turn: number;
  readonly initial_delay_ms: number;
  readonly max_delay_ms: number;
}

function freezeRetryPolicy(policy: NativeRetryPolicy): ResolvedNativeRetryPolicy {
  if (!Number.isSafeInteger(policy.max_model_attempts_per_turn) || policy.max_model_attempts_per_turn <= 0 || policy.max_model_attempts_per_turn > 10) throw new NativeWorkerError("max_model_attempts_per_turn must be an integer from 1 to 10");
  const initial = policy.initial_delay_ms ?? 250;
  const maximum = policy.max_delay_ms ?? 5_000;
  if (!Number.isSafeInteger(initial) || initial < 0) throw new NativeWorkerError("initial_delay_ms must be a non-negative safe integer");
  if (!Number.isSafeInteger(maximum) || maximum < initial || maximum > 60_000) throw new NativeWorkerError("max_delay_ms must be a safe integer no smaller than initial_delay_ms and no greater than 60000");
  return Object.freeze({ max_model_attempts_per_turn: policy.max_model_attempts_per_turn, initial_delay_ms: initial, max_delay_ms: maximum });
}

/** No jitter: replay and adversarial tests retain a deterministic retry schedule. */
function retryDelayMs(policy: ResolvedNativeRetryPolicy, attempt: number, retryAfterMs: number | null): number {
  const exponential = Math.min(policy.max_delay_ms, policy.initial_delay_ms * 2 ** (attempt - 1));
  return Math.min(policy.max_delay_ms, retryAfterMs ?? exponential);
}

const systemRetryDelay: NativeRetryDelayPort = Object.freeze({
  wait(delayMs: number, signal: AbortSignal): Promise<"elapsed" | "aborted"> {
    if (signal.aborted) return Promise.resolve("aborted");
    return new Promise((resolve) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve("elapsed"); }, delayMs);
      const abort = (): void => { clearTimeout(timer); resolve("aborted"); };
      signal.addEventListener("abort", abort, { once: true });
    });
  },
});

function freezeModelIdentity(identity: NativeModelIdentity | undefined): NativeModelIdentity | null {
  if (identity === undefined) return null;
  assertNonEmpty(identity.provider_id, "model provider_id");
  assertNonEmpty(identity.model_id, "model model_id");
  if (identity.configured_revision !== undefined && identity.configured_revision !== null && (typeof identity.configured_revision !== "string" || identity.configured_revision.trim().length === 0)) throw new NativeWorkerError("model configured revision must be a non-empty string or null");
  if (identity.revision !== null && typeof identity.revision !== "string") throw new NativeWorkerError("model revision must be a string or null");
  const capabilities = identity.capabilities.map((capability) => {
    if ((capability.capability !== "streaming" && capability.capability !== "tool_calls" && capability.capability !== "structured_output" && capability.capability !== "human_input" && capability.capability !== "image_input" && capability.capability !== "document_input") || typeof capability.available !== "boolean" || Number.isNaN(Date.parse(capability.observed_at)) || capability.detail.trim().length === 0) {
      throw new NativeWorkerError("model identity contains invalid capability evidence");
    }
    return Object.freeze({ ...capability });
  });
  return Object.freeze({ ...identity, capabilities: Object.freeze(capabilities) });
}

async function collectNativeStream(stream: AsyncIterable<NativeInferenceDelta>): Promise<NativeModelResponse> {
  const text: NativeModelText[] = [];
  const thinking: NativeModelThinking[] = [];
  const toolCalls: NativeToolCall[] = [];
  let finalMessage: string | null = null;
  let structuredOutput: unknown;
  let structuredUnparsed: string | undefined;
  let stopReason: NativeModelStopReason | undefined;
  let humanInput: NativeHumanInputRequest | undefined;
  let usageAndCost: NativeUsageAndCost | undefined;
  try {
    for await (const delta of stream) collect(delta);
  } catch (error) {
    // The provider reported this turn's usage before the stream failed. Keep
    // that bill with the error (unless the adapter already attached one), so
    // the worker records it instead of dropping it with the response.
    throw usageAndCost === undefined ? error : withReportedTurnUsage(error, usageAndCost);
  }
  if (humanInput !== undefined && (finalMessage !== null || toolCalls.length > 0)) throw withReportedTurnUsage(new NativeWorkerError("human-input stream response combined incompatible actions"), usageAndCost);
  return {
    text,
    thinking,
    tool_calls: toolCalls,
    final_message: finalMessage,
    structured_output: structuredOutput,
    ...(structuredUnparsed === undefined ? {} : { structured_output_unparsed: structuredUnparsed }),
    ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    human_input_request: humanInput,
    usage_and_cost: usageAndCost,
    ...(usageAndCost === undefined ? {} : { usage: usageEventFromTypedObservation(usageAndCost) }),
  };

  function collect(delta: NativeInferenceDelta): void {
    if (!isRecord(delta) || typeof delta.kind !== "string") throw new NativeWorkerError("model stream emitted an invalid delta");
    switch (delta.kind) {
      case "text":
        if (typeof delta.text !== "string" || (delta.phase !== "commentary" && delta.phase !== "final")) throw new NativeWorkerError("model stream emitted an invalid text delta");
        {
          const previous = text[text.length - 1];
          if (previous?.phase === delta.phase) text[text.length - 1] = { text: previous.text + delta.text, phase: delta.phase };
          else text.push({ text: delta.text, phase: delta.phase });
        }
        break;
      case "thinking":
        if (typeof delta.text !== "string" || typeof delta.signature !== "string") throw new NativeWorkerError("model stream emitted an invalid thinking delta");
        thinking.push({ text: delta.text, signature: delta.signature }); break;
      case "tool_call":
        if (!isToolCall(delta)) throw new NativeWorkerError("model stream emitted an invalid tool-call delta");
        toolCalls.push({ call_id: delta.call_id, tool: delta.tool, input: delta.input, input_summary: delta.input_summary, risk: delta.risk, context_refs: delta.context_refs, ...(delta.uncomposed === undefined ? {} : { uncomposed: delta.uncomposed }) }); break;
      case "usage":
        if (!isNativeUsageAndCost(delta.observation) || usageAndCost !== undefined) throw new NativeWorkerError("model stream emitted an invalid usage delta");
        usageAndCost = delta.observation; break;
      case "final":
        if (typeof delta.message !== "string" || finalMessage !== null
          || (delta.structured_output_unparsed !== undefined && typeof delta.structured_output_unparsed !== "string")) throw new NativeWorkerError("model stream emitted an invalid final delta");
        finalMessage = delta.message; structuredOutput = delta.structured_output; structuredUnparsed = delta.structured_output_unparsed; break;
      case "human_input":
        if (!isHumanInputRequest(delta.request) || humanInput !== undefined) throw new NativeWorkerError("model stream emitted an invalid human-input delta");
        humanInput = delta.request; break;
      case "stop":
        if (!isStopReason(delta.reason) || stopReason !== undefined) throw new NativeWorkerError("model stream emitted an invalid stop delta");
        stopReason = delta.reason; break;
      default: throw new NativeWorkerError("model stream emitted an unknown delta");
    }
  }
}

/**
 * Attach a provider-reported usage observation to a turn failure that carries
 * none, so `recordAbortedTurnUsage` keeps the bill. An error that already
 * carries one (the adapter's own) is returned unchanged.
 */
function withReportedTurnUsage(error: unknown, usage: NativeUsageAndCost | undefined): unknown {
  if (usage === undefined || !isRecord(error) || nativeAbortedTurnUsage(error) !== null || !Object.isExtensible(error)) return error;
  const aborted: NativeAbortedTurnUsage = Object.freeze({ kind: "reported", observation: usage, response_bytes: 0 });
  try { Object.defineProperty(error, "aborted_turn_usage", { value: aborted, enumerable: false, configurable: true }); } catch { /* a sealed error keeps its own shape */ }
  return error;
}

/** The canonical protocol can represent provider usage but never manufactures a zero for absence. */
function usageEventFromTypedObservation(observation: NativeUsageAndCost): NativeUsageObservation {
  return observation.tokens.kind === "measured"
    ? { input_tokens: observation.tokens.input_tokens, output_tokens: observation.tokens.output_tokens }
    : { input_tokens: null, output_tokens: null, unavailable_reason: observation.tokens.reason };
}

/**
 * When a manager exists, model history is a projection of its selected,
 * redacted entries—not an independent unbounded side-channel. Every retained
 * history entry must point at exactly one selected provenance-bearing fact.
 */
function boundedHistory(history: readonly NativeConversationEntry[], context: NativeContextSnapshot | null): readonly NativeConversationEntry[] {
  if (context === null) return Object.freeze(history.slice());
  const selected = new Map(context.entries.map((entry) => [entry.entry_id, entry]));
  const projected: NativeConversationEntry[] = [];
  for (const entry of history) {
    if (entry.evidence === undefined || entry.evidence.length === 0) continue;
    const sources = entry.evidence.map((evidence) => selected.get(evidence.entry_id));
    if (sources.some((source, index) => source === undefined || JSON.stringify(source.provenance) !== JSON.stringify(entry.evidence![index]!.provenance))) continue;
    const source = sources[0]!;
    projected.push(Object.freeze({ ...entry, text: source.text, evidence: Object.freeze(entry.evidence.map((evidence) => ({ entry_id: evidence.entry_id, provenance: Object.freeze({ ...evidence.provenance }) }))) }));
  }
  return Object.freeze(projected);
}

/**
 * A deterministic per-turn budget signal appended to the task. Silent for the
 * first two-thirds of the budget (exploration is fine early); in the final
 * third it states the turns remaining and directs the model to stop gathering
 * context and produce its result with its tools; on the last two turns it is
 * emphatic that unproduced work is lost. Bounded and side-effect-free.
 */
/** Bounded in-session structured-output corrections before a session fails. */
const MAX_STRUCTURED_RETRIES = 2;
/**
 * Bounded continuation turns after a turn the provider cut off at its
 * output-token limit with no tool call (H6). The count is of CONSECUTIVE
 * cut-off turns; a turn that calls a tool resets it. Each continuation is an
 * ordinary turn: it counts against `max_turns` and is admitted and observed
 * by the usage budget like any other. The third consecutive cut-off turn
 * ends the session with `NATIVE_WORKER_OUTPUT_LIMIT_CODE`.
 */
export const MAX_OUTPUT_LIMIT_CONTINUATIONS = 2;
export const NATIVE_WORKER_OUTPUT_LIMIT_CODE = "model_output_limit";

/**
 * The model-facing note for the turn after a cut-off turn. It names what
 * happened and asks for the smallest useful next step, because the usual
 * cause is a turn spent reasoning: the next one must act, not deliberate.
 */
export function outputLimitContinuationNote(toolsAvailable: boolean, structuredSchemaId: string | null): string {
  const act = structuredSchemaId !== null
    ? `Reply now with only the JSON object required by ${structuredSchemaId.slice(0, 128)}, with no reasoning, prose or markdown.`
    : toolsAvailable
      ? "Act now: make one tool call, or give a concise final answer. Keep any reasoning brief."
      : "Give a concise final answer now. Keep any reasoning brief.";
  return `[Your previous turn was cut off at the output-token limit before it finished, so nothing from it was accepted. ${act}]`;
}

/** Append the continuation note after a cut-off turn; null passthrough, like its siblings. */
export function withOutputLimitContinuation(prompt: string, note: string | null): string {
  return note === null ? prompt : `${prompt}\n\n${note}`;
}

/**
 * The correction for a reply from which no JSON value could be recovered:
 * the contract's own wording when it supplies one, otherwise a precise
 * generic one naming the schema.
 */
function unparsedStructuredReason(contract: NativeStructuredOutputContract, detail: string): string {
  const boundedDetail = detail.slice(0, 256);
  if (typeof contract.unparsed_reason === "function") {
    try {
      const reason = contract.unparsed_reason(boundedDetail);
      if (typeof reason === "string" && reason.trim().length > 0) return reason.slice(0, TURN_GATE_REASON_BYTES);
    } catch { /* fall back to the generic reason */ }
  }
  return `your reply was not a JSON object (${boundedDetail}); reply with only the JSON object required by ${contract.schema_id.slice(0, 128)}, with no prose or markdown`;
}
/**
 * Bounded turn-gate refusals before a session stops asking. The same shape and
 * the same magnitude as the structured-output correction budget above, because
 * it is the same kind of event: the model produced a final result and a
 * boundary refused it. The admission test beside it (`turn < max_turns`) caps
 * the other direction, so a permanently-red gate costs two turns, never a whole
 * budget.
 */
const MAX_TURN_GATE_REFUSALS = 2;
/**
 * A refusal reason is a bounded detail string attached to a failure and handed
 * to the model, so it takes this package's existing bound for exactly that role
 * (`MAX_PROVIDER_ERROR_DETAIL_BYTES`) rather than a number invented here. The
 * slice is by code unit, which is the head-slice semantics the hook bus already
 * applies to a deny reason (`HOOK_MAX_REASON_BYTES`).
 */
const TURN_GATE_REASON_BYTES = 1_024;

/**
 * How long the turn loop waits for the injection the PREVIOUS turn began, at
 * the top of this one.
 *
 * DERIVED, not chosen: the hook bus bounds each `inject` handler by the
 * `timeout_ms` on its own registry entry, so a settle window shorter than the
 * largest declared bound would drop a handler for having used the budget it
 * declared. The largest bound an `inject` handler may declare is the next
 * round number above `inject.repo-session-open`'s
 * `REPO_SESSION_HANDLER_BOUND_MS` (its durable-store read plus write), so 5 s
 * clears every bound in the shipped registry with room to spare and still
 * costs a turn nothing in the ordinary case — the timer is armed only when an
 * injection is genuinely outstanding, and cleared as soon as it settles.
 *
 * A worker cannot preempt the handler itself, exactly as it cannot preempt an
 * in-line `turn_gate`; what this bounds is the WAIT, and crossing it is a
 * named drop rather than a discarded verdict.
 */
const TURN_INJECT_SETTLE_MS = 5_000;

/**
 * Append the settled advisory injection. Placed AFTER the turn-budget note and
 * BEFORE the structured correction and the turn-gate refusal, because recency
 * is the ordering rule: the refusal answers the model's most recent output and
 * is therefore the last thing it reads, while the budget note is standing
 * context. Null passthrough, like its two siblings.
 */
export function withTurnInjection(prompt: string, injection: string | null): string {
  if (injection === null) return prompt;
  return `${prompt}\n\n${injection}`;
}

/**
 * Append a bounded correction directive when the previous turn's structured
 * output was rejected, so the model produces a schema-valid response next turn.
 * Null correction leaves the prompt untouched.
 */
export function withStructuredCorrection(prompt: string, correction: string | null): string {
  if (correction === null) return prompt;
  return `${prompt}\n\n[Your previous response's structured output was rejected: ${correction}. Return a corrected response that satisfies the required schema exactly — valid JSON, all required fields, no extra fields, no prose or markdown.]`;
}

/**
 * Append a bounded refusal when a previous turn's final result was refused at
 * the turn boundary, so the model knows its result was not accepted and why.
 * Mirrors `withStructuredCorrection`'s null-passthrough shape.
 */
export function withTurnGateRefusal(prompt: string, refusal: string | null): string {
  if (refusal === null) return prompt;
  return `${prompt}\n\n[The final result you just produced was REFUSED at the turn boundary and not accepted: ${refusal}. Act on the refusal, then produce a new final result.]`;
}

export function withTurnBudgetNote(prompt: string, turn: number, maxTurns: number): string {
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 1) return prompt;
  const remaining = maxTurns - turn + 1;
  const threshold = Math.max(1, Math.ceil(maxTurns / 3));
  if (remaining > threshold) return prompt;
  const note = remaining === 1
    ? `[Turn budget: 1 of ${maxTurns} turns left — FINAL RESPONSE ONLY. Do not call any tool or make another change. Return your concise final result now, including what changed, what verification actually ran, and any remaining limitation. A tool call cannot be followed by another model turn and will leave the task unfinished.]`
    : remaining === 2
      ? `[Turn budget: 2 of ${maxTurns} turns left. This is your LAST TOOL-USE OPPORTUNITY. Do not explore. If a concrete acceptance criterion still requires one bounded check or correction, perform it now; otherwise return the final result now. The next and final turn is reserved exclusively for the no-tools final response.]`
      : `[Turn budget: ${remaining} of ${maxTurns} turns left. Enter closure now: stop exploring, make only changes required by a concrete unmet acceptance criterion, and use bounded verification rather than broad searching. Reserve the final two turns for at most one last tool action followed by the required no-tools final response.]`;
  return `${prompt}\n\n${note}`;
}

function stableTextId(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16_777_619); }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nativeModelSignal(error: unknown): NativeModelSignal | null {
  if (!isRecord(error) || !isRecord(error.native_signal)) return null;
  const signal = error.native_signal;
  if (signal.kind !== "context_overflow"
    || (signal.provider_code !== null && typeof signal.provider_code !== "string")
    || (signal.observed_tokens !== undefined && (!Number.isSafeInteger(signal.observed_tokens) || (signal.observed_tokens as number) < 0))
    || (signal.context_limit !== undefined && (!Number.isSafeInteger(signal.context_limit) || (signal.context_limit as number) < 0))) return null;
  return signal as unknown as NativeModelSignal;
}

/**
 * A model port is an injected, provider-neutral boundary: this worker cannot
 * know an adapter's concrete error shape (e.g. `OpenAICompatibleAdapterError`
 * lives in a sibling module and is never imported here). It still owes
 * operators enough to diagnose a failure without a debugger, so it duck-types
 * the class name, an optional adapter-declared `kind`, and a length-capped
 * copy of the message -- the same value `failed()` already redacts before it
 * reaches canonical events or the terminal cause.
 */
const MAX_MODEL_ERROR_DETAIL_CHARS = 256;
function describeModelError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const kind = isRecord(error) && typeof error.kind === "string" ? error.kind : undefined;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.length > MAX_MODEL_ERROR_DETAIL_CHARS ? `${rawMessage.slice(0, MAX_MODEL_ERROR_DETAIL_CHARS)}…` : rawMessage;
  return kind === undefined ? `${name}: ${message}` : `${name} (${kind}): ${message}`;
}

function profileStart(start: SessionStartRequest, profile: NativeExecutionProfile | undefined): SessionStartRequest {
  if (profile === undefined) return start;
  assertNonEmpty(profile.role_id, "profile role_id");
  assertUniqueNonEmpty(profile.allowed_tools, "profile allowed tool");
  assertUniqueNonEmpty(profile.allowed_capabilities, "profile allowed capability");
  const additional = profile.required_capabilities ?? [];
  for (const requirement of [...start.required_capabilities, ...additional]) {
    if (!profile.allowed_capabilities.includes(requirement.capability)) {
      throw new NativeWorkerError(`profile does not allow required capability: ${requirement.capability}`);
    }
  }
  return Object.freeze({
    ...start,
    required_capabilities: Object.freeze([...start.required_capabilities, ...additional]),
    policy: Object.freeze({
      ...start.policy,
      tool_allow: Object.freeze(start.policy.tool_allow.filter((tool) => profile.allowed_tools.includes(tool))),
      tool_deny: Object.freeze([...start.policy.tool_deny]),
      workspace_roots: Object.freeze([...start.policy.workspace_roots]),
    }),
  });
}

function freezeGovernedContext(context: NativeGovernedContext | undefined): NativeGovernedContext {
  const instructions = context?.instructions ?? [];
  const artifacts = context?.artifacts ?? [];
  for (const instruction of instructions) {
    assertNonEmpty(instruction.instruction_id, "governed instruction_id");
    assertNonEmpty(instruction.text, "governed instruction text");
  }
  for (const artifact of artifacts) {
    assertNonEmpty(artifact.artifact_id, "governed artifact_id");
    assertNonEmpty(artifact.media_type, "governed artifact media_type");
  }
  return Object.freeze({
    instructions: Object.freeze(instructions.map((instruction) => Object.freeze({ ...instruction, provenance: Object.freeze({ ...instruction.provenance }) }))),
    artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze({ ...artifact, provenance: Object.freeze({ ...artifact.provenance }) }))),
  });
}

function assertUniqueNonEmpty(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    assertNonEmpty(value, label);
    if (seen.has(value)) throw new NativeWorkerError(`${label} occurs more than once: ${value}`);
    seen.add(value);
  }
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new HarnessAdmissionError(`${label} must be non-empty`);
}
