/**
 * Provider-neutral inference vocabulary for the native executor.
 *
 * These are deliberately inward-facing facts.  They do not encode a
 * provider's request shape, streaming wire protocol, or pricing catalogue.
 */
import type { Cost, Provenance } from "@arbor/core";

export interface NativeModelIdentity {
  /** Composition-owned stable provider identity; never a credential account. */
  readonly provider_id: string;
  readonly model_id: string;
  /** Operator-composed response revision expectation, never provider evidence by itself. */
  readonly configured_revision?: string | null;
  /** Optional provider revision/version observed by the adapter for this response. */
  readonly revision: string | null;
  /** Closed-by-the-adapter capability claims, with observation evidence. */
  readonly capabilities: readonly NativeModelCapability[];
}

export interface NativeModelCapability {
  readonly capability: "streaming" | "tool_calls" | "structured_output" | "human_input" | "image_input" | "document_input";
  readonly available: boolean;
  readonly observed_at: string;
  readonly detail: string;
}

/** Token measurement is explicit: unavailable usage is never mistaken for zero. */
export type NativeTokenUsage =
  | { readonly kind: "measured"; readonly input_tokens: number; readonly output_tokens: number; readonly cache_read_tokens: number; readonly cache_write_tokens: number }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Cost uses core's priced-or-unpriced union, preserving the absence reason. */
export interface NativeUsageAndCost {
  readonly tokens: NativeTokenUsage;
  readonly cost: Cost;
}

export type NativeRetryClassification =
  | { readonly kind: "retryable"; readonly reason: string; readonly retry_after_ms: number | null }
  | { readonly kind: "terminal"; readonly reason: string };

/** The validator belongs to a caller-controlled boundary; the harness invents no schema semantics. */
export interface NativeStructuredOutputContract {
  readonly schema_id: string;
  validate(value: unknown): NativeStructuredOutputValidation;
  /**
   * Optional: the contract's own reason for a reply from which no JSON value
   * could be recovered, given the adapter's bounded description. It is both
   * the correction handed back to the model and, once the corrections are
   * spent, the session's failure message, so a contract can name the reply
   * in its own vocabulary. Absent, the worker states a generic reason that
   * names `schema_id`.
   */
  unparsed_reason?(detail: string): string;
}

export type NativeStructuredOutputValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/** A non-content reference joins model intent to governed context/evidence. */
export interface NativeContextEvidenceRef {
  readonly entry_id: string;
  readonly provenance: Provenance;
}

export interface NativeInferenceTextDelta {
  readonly kind: "text";
  readonly text: string;
  readonly phase: "commentary" | "final";
}

export interface NativeInferenceToolCallDelta {
  readonly kind: "tool_call";
  readonly call_id: string;
  readonly tool: string;
  readonly input: unknown;
  readonly input_summary: string;
  readonly risk: "low" | "high";
  /** Evidence actually relied upon for this intent; content remains out of audit events. */
  readonly context_refs: readonly NativeContextEvidenceRef[];
  /**
   * Present only when the provider requested a tool name outside the set
   * actually composed into this request. The adapter still emits a typed
   * `tool_call` delta rather than throwing -- it never dispatches anything --
   * so the worker can hand the model back a recoverable "tool not available"
   * result (naming what *is* available) instead of failing the whole turn.
   * `input`/`risk`/`context_refs` are inert placeholders when this is set.
   */
  readonly uncomposed?: Readonly<{ readonly available_tools: readonly string[] }>;
}

/**
 * A preserved extended-thinking content block. `signature` is the
 * provider's opaque verification token, carried verbatim so it can be
 * echoed back unchanged on the next request -- Anthropic's contract ties
 * replay validity to this value reaching the API byte-for-byte (ADR-109).
 */
export interface NativeInferenceThinkingDelta {
  readonly kind: "thinking";
  readonly text: string;
  readonly signature: string;
}

export interface NativeInferenceUsageDelta {
  readonly kind: "usage";
  readonly observation: NativeUsageAndCost;
}

export interface NativeInferenceFinalDelta {
  readonly kind: "final";
  readonly message: string;
  readonly structured_output?: unknown;
  /**
   * Present only when structured output was requested and no JSON value could
   * be recovered from the reply: the adapter's bounded reason (for example
   * "the reply was prose with no JSON value"). It is a model miss, not a
   * protocol failure, so the worker spends its bounded structured-output
   * corrections on it exactly as it does on JSON the contract rejected.
   */
  readonly structured_output_unparsed?: string;
}

/**
 * Why the provider ended a turn, normalised across providers.
 *
 * - `completed`: the model ended its turn itself (OpenAI `stop`, Anthropic
 *   `end_turn`/`stop_sequence`, Ollama `stop`).
 * - `tool_use`: the model stopped to call tools.
 * - `output_limit`: the provider cut the turn off at its output-token limit
 *   (OpenAI `length`, Anthropic `max_tokens`, Ollama `length`). The visible
 *   text, if any, is truncated, and the worker never accepts it as a final
 *   answer or as structured output.
 * - `content_filter`: the provider withheld or cut the output.
 * - `other`: any other provider value; the turn is handled on its content.
 */
export type NativeModelStopReason = "completed" | "tool_use" | "output_limit" | "content_filter" | "other";
export const NATIVE_MODEL_STOP_REASONS: readonly NativeModelStopReason[] = Object.freeze(["completed", "tool_use", "output_limit", "content_filter", "other"]);

/** The provider's reason for ending the turn, emitted at most once and before `final`. */
export interface NativeInferenceStopDelta {
  readonly kind: "stop";
  readonly reason: NativeModelStopReason;
}

/** Maps an OpenAI-compatible `finish_reason` (or Ollama `done_reason`) to the native stop reason. */
export function nativeStopReasonFromOpenAI(value: string): NativeModelStopReason {
  if (value === "stop") return "completed";
  if (value === "tool_calls" || value === "function_call") return "tool_use";
  if (value === "length") return "output_limit";
  if (value === "content_filter") return "content_filter";
  return "other";
}

/** Maps an Anthropic Messages `stop_reason` to the native stop reason. */
export function nativeStopReasonFromAnthropic(value: string): NativeModelStopReason {
  if (value === "end_turn" || value === "stop_sequence") return "completed";
  if (value === "tool_use") return "tool_use";
  if (value === "max_tokens") return "output_limit";
  if (value === "refusal") return "content_filter";
  return "other";
}

export interface NativeInferenceHumanInputDelta {
  readonly kind: "human_input";
  readonly request: NativeHumanInputRequest;
}

export type NativeInferenceDelta =
  | NativeInferenceTextDelta
  | NativeInferenceThinkingDelta
  | NativeInferenceToolCallDelta
  | NativeInferenceUsageDelta
  | NativeInferenceFinalDelta
  | NativeInferenceHumanInputDelta
  | NativeInferenceStopDelta;

export interface NativeHumanInputRequest {
  readonly request_id: string;
  readonly question: string;
  readonly reason: string;
  readonly evidence: readonly NativeContextEvidenceRef[];
}

export type NativeHumanInputResult =
  | { readonly kind: "submitted"; readonly response: string; readonly provenance: Provenance }
  /**
   * The composition root has durably handed the request back to its campaign
   * governor.  This is deliberately not an answer: the worker must stop and
   * must not place invented human text into its model history.
   */
  | { readonly kind: "handoff"; readonly reason: string }
  | { readonly kind: "declined"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface NativeHumanInputPort {
  request(request: NativeHumanInputRequest, signal: AbortSignal): Promise<NativeHumanInputResult>;
}

export interface NativeRetryPolicy {
  /** Includes the initial call. */
  readonly max_model_attempts_per_turn: number;
  /** Deterministic exponential backoff starts here when an adapter has no retry-after hint. */
  readonly initial_delay_ms?: number;
  /** A provider retry-after hint is never allowed to make a worker sleep unboundedly. */
  readonly max_delay_ms?: number;
}

/** Bounded retry/backoff is native behavior, not a provider-specific promise. */
export const DEFAULT_NATIVE_RETRY_POLICY: NativeRetryPolicy = Object.freeze({
  max_model_attempts_per_turn: 2,
  initial_delay_ms: 250,
  max_delay_ms: 5_000,
});

/** A safe, deterministic default for adapters that do not expose retry evidence. */
export function classifyNativeInferenceFailure(_error: unknown): NativeRetryClassification {
  return { kind: "terminal", reason: "adapter did not classify the inference failure" };
}

/**
 * The spend of a model turn an adapter aborted mid-stream (for example at
 * its response byte limit). The provider billed the turn even though no
 * response reached the worker, so the adapter carries what it knew on the
 * thrown error as `aborted_turn_usage`, and the worker records it rather than
 * losing it with the response.
 *
 * - `reported`: the provider's own usage report arrived before the abort.
 * - `unpriced_estimate`: no report arrived. `observation` is honest by type
 *   (tokens unavailable, cost unpriced, both reasons naming the estimate);
 *   the numeric fields bound only what was streamed before the abort, at one
 *   token per UTF-8 byte of streamed content, reasoning and tool arguments
 *   (and by the request's `max_tokens` when one was sent). Input tokens were
 *   billed too and are unknown.
 */
export type NativeAbortedTurnUsage =
  | { readonly kind: "reported"; readonly observation: NativeUsageAndCost; readonly response_bytes: number }
  | {
      readonly kind: "unpriced_estimate";
      readonly observation: NativeUsageAndCost;
      readonly response_bytes: number;
      readonly streamed_text_bytes: number;
      readonly streamed_output_tokens_upper_bound: number;
    };

/** Reads an adapter error's `aborted_turn_usage`, or null when it carries none (or an invalid one). */
export function nativeAbortedTurnUsage(error: unknown): NativeAbortedTurnUsage | null {
  if (!isRecord(error) || !isRecord(error.aborted_turn_usage)) return null;
  const value = error.aborted_turn_usage;
  if (!isNativeUsageAndCost(value.observation) || !isSafeNonNegative(value.response_bytes)) return null;
  if (value.kind === "reported") return value as unknown as NativeAbortedTurnUsage;
  if (value.kind !== "unpriced_estimate" || !isSafeNonNegative(value.streamed_text_bytes) || !isSafeNonNegative(value.streamed_output_tokens_upper_bound)) return null;
  return value as unknown as NativeAbortedTurnUsage;
}

export function isNativeUsageAndCost(value: unknown): value is NativeUsageAndCost {
  if (!isRecord(value) || !isRecord(value.tokens) || !isRecord(value.cost)) return false;
  const tokens = value.tokens;
  const validTokens = tokens.kind === "measured"
    ? isSafeNonNegative(tokens.input_tokens) && isSafeNonNegative(tokens.output_tokens)
      && isSafeNonNegative(tokens.cache_read_tokens) && isSafeNonNegative(tokens.cache_write_tokens)
    : tokens.kind === "unavailable" && typeof tokens.reason === "string" && tokens.reason.trim().length > 0;
  if (!validTokens) return false;
  const cost = value.cost;
  return cost.kind === "priced"
    ? isSafeNonNegative(cost.minor_units) && typeof cost.currency === "string" && typeof cost.minor_unit_exponent === "number" && typeof cost.price_source_id === "string"
    : cost.kind === "unpriced" && typeof cost.reason === "string" && cost.reason.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
