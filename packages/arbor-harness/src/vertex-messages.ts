/**
 * Claude on Google Cloud's Agent Platform (Vertex AI) `streamRawPredict`
 * transport (ADR-100 Decision §1). Wire contract verified 2026-08-26
 * against Anthropic's own documentation
 * (https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai):
 * the request body is "nearly identical to the Messages API" with two
 * differences -- `model` is never in the body (it's in the URL), and
 * `anthropic_version` is a body field fixed to `"vertex-2023-10-16"`
 * (rather than a header). The endpoint path pattern
 * (`https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:streamRawPredict`,
 * `:rawPredict` for non-streaming, `global` as the location for the
 * recommended global endpoint) is Google's own documented cURL example on
 * that page.
 *
 * The Messages-shaped body/stream-event handling is the shared
 * `./anthropic-messages-wire.ts` (ADR-100 Decision §1). Streaming responses
 * are the same `text/event-stream` shape the direct Anthropic API uses.
 *
 * Credential convention for this tranche: the worker-owned opaque secret
 * (`NativeModelPort.run`/`stream`'s `secret: string | null`) is treated as
 * an already-obtained GCP OAuth2 access token, sent as
 * `Authorization: Bearer <secret>`. The service-account JWT
 * assertion/token-exchange flow that would *produce* that token
 * (`packages/arbor-config/src/gcp-oauth-secret.ts`, per ADR-100 Decision
 * §3) is OUT OF THIS TRANCHE'S FILE OWNERSHIP (only
 * `packages/arbor-config/src/types.ts`/`schema.ts` are owned, and only to
 * extend the adapter-id enum) and has NOT been implemented -- see the task
 * report. This adapter has never executed against a live Vertex endpoint --
 * no credentials, no network in this environment -- and is exercised only
 * with `fetch` stubbed at the boundary.
 */
import {
  buildAnthropicWireConfig,
  buildAnthropicWireRequestBody,
  newAnthropicWireStreamState,
  applyAnthropicWireEvent,
  finishAnthropicWireStream,
  AnthropicWireError,
  type AnthropicWireConfig,
  type AnthropicWireToolDefinition,
  type AnthropicWireStructuredSchema,
} from "./anthropic-messages-wire.js";
import { nativeContextOverflowSignal, type NativeModelSignal } from "./native-model-signal.js";
import type { NativeContextEvidenceRef, NativeInferenceDelta, NativeModelIdentity, NativeRetryClassification } from "./inference.js";
import type { NativeModelPort, NativeModelRequest, NativeToolRisk } from "./native-worker.js";

export interface VertexMessagesFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface VertexMessagesToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly risk: NativeToolRisk;
  readonly context_refs?: readonly NativeContextEvidenceRef[];
}

export interface VertexMessagesStructuredSchema {
  readonly schema_id: string;
  readonly name: string;
  readonly schema: Record<string, unknown>;
}

export interface VertexMessagesModelOptions {
  readonly fetch: VertexMessagesFetch;
  readonly project_id: string;
  /** GCP location: a region (`us-east5`), a multi-region (`us`/`eu`), or `global` (default, recommended). */
  readonly location?: string;
  readonly provider_id: string;
  /** The Agent Platform API model id (e.g. `claude-opus-5`), never a versioned direct-API model string. */
  readonly model_id: string;
  readonly observed_at: string;
  readonly tools?: readonly VertexMessagesToolDefinition[];
  readonly structured_schemas?: readonly VertexMessagesStructuredSchema[];
  readonly credential_required?: boolean;
  readonly timeout_ms?: number;
  readonly max_response_bytes?: number;
  readonly max_tool_argument_bytes?: number;
  readonly max_output_tokens?: number;
  /** Test/override seam: replaces the computed `aiplatform.googleapis.com` host. Never used to redirect a real credential to an untrusted host in production composition. */
  readonly endpoint_override?: string;
}

export class VertexMessagesAdapterError extends Error {
  constructor(
    readonly kind: "credential" | "timeout" | "transport" | "http" | "protocol",
    message: string,
    readonly status: number | null = null,
    readonly retry_after_ms: number | null = null,
    readonly native_signal?: NativeModelSignal,
  ) {
    super(message);
    this.name = "VertexMessagesAdapterError";
  }
}

const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4_194_304;
const MAX_RESPONSE_BYTES = 8_388_608;
const DEFAULT_MAX_TOOL_ARGUMENT_BYTES = 262_144;
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const MAX_OUTPUT_TOKENS = 128_000;

interface Config {
  readonly fetch: VertexMessagesFetch;
  readonly providerId: string;
  readonly modelId: string;
  readonly endpoint: string;
  readonly observedAt: string;
  readonly wire: AnthropicWireConfig;
  readonly credentialRequired: boolean;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export function createVertexMessagesModelPort(options: VertexMessagesModelOptions): NativeModelPort {
  const config = validateOptions(options);
  let identity: NativeModelIdentity = baseIdentity(config);
  return Object.freeze({
    get identity() { return identity; },
    async run(request: NativeModelRequest, secret: string | null, signal: AbortSignal) {
      const deltas: NativeInferenceDelta[] = [];
      for await (const delta of streamMessage(config, request, secret, signal, (observed) => { identity = observed; })) deltas.push(delta);
      return responseFromDeltas(deltas);
    },
    stream(request: NativeModelRequest, secret: string | null, signal: AbortSignal) { return streamMessage(config, request, secret, signal, (observed) => { identity = observed; }); },
    classify_failure(error: unknown): NativeRetryClassification { return classifyVertexMessagesFailure(error); },
  });
}

export function classifyVertexMessagesFailure(error: unknown): NativeRetryClassification {
  if (!(error instanceof VertexMessagesAdapterError)) return { kind: "terminal", reason: "unclassified Vertex Messages adapter failure" };
  if (error.kind === "timeout" || error.kind === "transport") return { kind: "retryable", reason: error.kind, retry_after_ms: error.retry_after_ms };
  if (error.kind === "http" && (error.status === 408 || error.status === 409 || error.status === 429 || (error.status !== null && error.status >= 500))) {
    return { kind: "retryable", reason: `HTTP ${error.status}`, retry_after_ms: error.retry_after_ms };
  }
  return { kind: "terminal", reason: error.kind };
}

function validateOptions(options: VertexMessagesModelOptions): Config {
  nonEmpty(options.provider_id, "provider_id");
  nonEmpty(options.model_id, "model_id");
  nonEmpty(options.project_id, "project_id");
  if (Number.isNaN(Date.parse(options.observed_at))) throw new VertexMessagesAdapterError("protocol", "observed_at must be an ISO timestamp");
  const location = options.location ?? "global";
  nonEmpty(location, "location");
  const timeout = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) throw new VertexMessagesAdapterError("protocol", `timeout_ms must be a positive safe integer no greater than ${MAX_TIMEOUT_MS}`);
  const maxResponseBytes = boundedBytes(options.max_response_bytes, DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, "max_response_bytes");
  const maxToolArgumentBytes = boundedBytes(options.max_tool_argument_bytes, Math.min(DEFAULT_MAX_TOOL_ARGUMENT_BYTES, maxResponseBytes), maxResponseBytes, "max_tool_argument_bytes");
  const maxOutputTokens = boundedRange(options.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS, 1, MAX_OUTPUT_TOKENS, "max_output_tokens");
  let wire: AnthropicWireConfig;
  try {
    wire = buildAnthropicWireConfig({
      modelId: options.model_id, maxOutputTokens, maxResponseBytes, maxToolArgumentBytes,
      tools: options.tools as readonly AnthropicWireToolDefinition[] | undefined,
      structured_schemas: options.structured_schemas as readonly AnthropicWireStructuredSchema[] | undefined,
    });
  } catch (error) {
    if (error instanceof AnthropicWireError) throw new VertexMessagesAdapterError("protocol", error.message);
    throw error;
  }
  const host = options.endpoint_override ?? `${location === "global" ? "" : `${location}-`}aiplatform.googleapis.com`;
  const endpoint = `https://${host}/v1/projects/${encodeURIComponent(options.project_id)}/locations/${encodeURIComponent(location)}/publishers/anthropic/models/${encodeURIComponent(options.model_id)}:streamRawPredict`;
  return Object.freeze({
    fetch: options.fetch, providerId: options.provider_id, modelId: options.model_id,
    endpoint, observedAt: options.observed_at, wire,
    credentialRequired: options.credential_required ?? true, timeoutMs: timeout, maxResponseBytes,
  });
}

function baseIdentity(config: Config): NativeModelIdentity {
  return Object.freeze({ provider_id: config.providerId, model_id: config.modelId, configured_revision: null, revision: null, capabilities: capabilities(config) });
}

function capabilities(config: Config) {
  return Object.freeze([
    capability("streaming", true, config.observedAt, "adapter parses Vertex's streamRawPredict server-sent event stream"),
    capability("tool_calls", config.wire.tools.size > 0, config.observedAt, config.wire.tools.size > 0 ? "adapter validates configured tool_use blocks after their streamed input_json_delta fragments complete" : "no tool schemas were composed"),
    capability("structured_output", config.wire.schemas.size > 0, config.observedAt, config.wire.schemas.size > 0 ? "adapter sends output_config.format for the requested composed schema_id" : "no structured-output schemas were composed"),
    capability("human_input", false, config.observedAt, "Vertex transport does not implement the human-input tool convention this tranche"),
    capability("image_input", false, config.observedAt, "Vertex transport does not implement governed image input this tranche"),
    capability("document_input", false, config.observedAt, "Vertex transport does not implement governed document input this tranche"),
  ]);
}

function capability(capability: NativeModelIdentity["capabilities"][number]["capability"], available: boolean, observedAt: string, detail: string) {
  return Object.freeze({ capability, available, observed_at: observedAt, detail });
}

async function* streamMessage(config: Config, request: NativeModelRequest, secret: string | null, signal: AbortSignal, observeIdentity: (identity: NativeModelIdentity) => void): AsyncIterable<NativeInferenceDelta> {
  if (config.credentialRequired && (secret === null || secret.length === 0)) throw new VertexMessagesAdapterError("credential", "an injected credential is required for this provider");

  const { stream: _stream, ...bodyWithoutStream } = buildAnthropicWireRequestBody(config.wire, request);
  const body = JSON.stringify({ anthropic_version: VERTEX_ANTHROPIC_VERSION, ...bodyWithoutStream });

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
  const combined = anySignal([signal, timeout.signal]);

  let response: Response;
  try {
    response = await config.fetch(config.endpoint, {
      method: "POST",
      headers: Object.freeze({ "content-type": "application/json", accept: "text/event-stream", ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) }),
      body,
      signal: combined,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof VertexMessagesAdapterError) throw error;
    if (timeout.signal.aborted && !signal.aborted) throw new VertexMessagesAdapterError("timeout", "Vertex request exceeded its configured timeout");
    if (signal.aborted) throw error;
    throw new VertexMessagesAdapterError("transport", "Vertex transport failed");
  }
  if (!response.ok) {
    clearTimeout(timer);
    const detail = await boundedText(response);
    throw new VertexMessagesAdapterError("http", `Vertex provider returned HTTP ${response.status}${detail === null ? "" : `: ${detail}`}`, response.status, retryAfterMs(response.headers.get("retry-after")), nativeContextOverflowSignal(detail) ?? undefined);
  }
  if (response.body === null) { clearTimeout(timer); throw new VertexMessagesAdapterError("protocol", "Vertex provider returned an empty streaming body"); }

  const decoder = new TextDecoder();
  let pending = "";
  const state = newAnthropicWireStreamState();
  try {
    const iterator = (response.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    while (true) {
      const next = await nextWithAbort(iterator, combined);
      if (next.done) break;
      state.responseBytes += next.value.byteLength;
      if (state.responseBytes > config.maxResponseBytes) throw new VertexMessagesAdapterError("protocol", "Vertex stream exceeded the configured response byte limit");
      pending += decoder.decode(next.value, { stream: true });
      const parsed = drainSse(pending);
      pending = parsed.rest;
      for (const data of parsed.data) applySseEvent(config, data, state);
      if (state.done) { for (const delta of finishAnthropicWireStream(config.wire, state, request.structured_output !== null)) yield delta; observeIdentity(verifiedIdentity(config)); return; }
    }
    pending += decoder.decode();
    const parsed = drainSse(pending, true);
    for (const data of parsed.data) applySseEvent(config, data, state);
    if (state.done) { for (const delta of finishAnthropicWireStream(config.wire, state, request.structured_output !== null)) yield delta; observeIdentity(verifiedIdentity(config)); return; }
  } catch (error) {
    if (error instanceof VertexMessagesAdapterError) throw error;
    if (error instanceof AnthropicWireError) throw new VertexMessagesAdapterError("protocol", error.message);
    if (timeout.signal.aborted && !signal.aborted) throw new VertexMessagesAdapterError("timeout", "Vertex stream exceeded its configured timeout");
    if (signal.aborted) throw error;
    throw new VertexMessagesAdapterError("protocol", "Vertex streaming response was invalid");
  } finally {
    clearTimeout(timer);
  }
  throw new VertexMessagesAdapterError("protocol", "Vertex stream ended before message_stop");
}

function applySseEvent(config: Config, data: string, state: ReturnType<typeof newAnthropicWireStreamState>): void {
  let event: unknown;
  try { event = JSON.parse(data); } catch { throw new VertexMessagesAdapterError("protocol", "Vertex stream contained invalid JSON"); }
  const streamError = applyAnthropicWireEvent(config.wire, event, state);
  if (streamError !== null) throw new VertexMessagesAdapterError("http", `Vertex stream reported an error: ${streamError.detail}`, streamError.status, null, streamError.native_signal);
}

function verifiedIdentity(config: Config): NativeModelIdentity {
  return Object.freeze({ provider_id: config.providerId, model_id: config.modelId, configured_revision: null, revision: null, capabilities: capabilities(config) });
}

function responseFromDeltas(deltas: readonly NativeInferenceDelta[]) {
  const text: Array<{ readonly text: string; readonly phase: "commentary" | "final" }> = [];
  const toolCalls: Array<{ readonly call_id: string; readonly tool: string; readonly input: unknown; readonly input_summary: string; readonly risk: "low" | "high"; readonly context_refs: readonly NativeContextEvidenceRef[]; readonly uncomposed?: { readonly available_tools: readonly string[] } }> = [];
  let usage: NativeInferenceDelta & { kind: "usage" } | undefined;
  let final: NativeInferenceDelta & { kind: "final" } | undefined;
  let stop: NativeInferenceDelta & { kind: "stop" } | undefined;
  for (const delta of deltas) {
    if (delta.kind === "text") text.push({ text: delta.text, phase: delta.phase });
    else if (delta.kind === "tool_call") toolCalls.push({ call_id: delta.call_id, tool: delta.tool, input: delta.input, input_summary: delta.input_summary, risk: delta.risk, context_refs: delta.context_refs, ...(delta.uncomposed === undefined ? {} : { uncomposed: delta.uncomposed }) });
    else if (delta.kind === "usage") usage = delta;
    else if (delta.kind === "final") final = delta;
    else if (delta.kind === "stop") stop = delta;
  }
  return {
    text,
    tool_calls: toolCalls,
    ...(usage === undefined ? {} : { usage_and_cost: usage.observation }),
    final_message: final?.message ?? null,
    ...(final?.structured_output === undefined ? {} : { structured_output: final.structured_output }),
    ...(final?.structured_output_unparsed === undefined ? {} : { structured_output_unparsed: final.structured_output_unparsed }),
    ...(stop === undefined ? {} : { stop_reason: stop.reason }),
  };
}

function drainSse(input: string, final = false): { data: readonly string[]; rest: string } {
  const events = input.split("\n\n");
  const rest = final ? "" : (events.pop() ?? "");
  const data: string[] = [];
  for (const event of events) {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const value = line.slice(5).trim();
      if (value.length === 0 || value === "[DONE]") continue;
      data.push(value);
    }
  }
  return { data, rest };
}

async function boundedText(response: Response): Promise<string | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes <= 1024) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = 1025 - bytes;
      chunks.push(next.value.subarray(0, remaining));
      bytes += Math.min(next.value.byteLength, remaining);
      if (bytes > 1024) break;
    }
  } finally {
    if (bytes > 1024) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (bytes === 0 || bytes > 1024) return null;
  const value: unknown = await new Response(new TextDecoder().decode(Buffer.concat(chunks))).json().catch(() => null);
  if (!isRecord(value)) return null;
  const error = isRecord(value.error) ? value.error : value;
  const fields = [error.code, error.status, error.message]
    .filter((field): field is string | number => typeof field === "string" || (typeof field === "number" && Number.isSafeInteger(field)))
    .map((field) => String(field).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 256))
    .filter((field) => field.length > 0);
  return fields.length === 0 ? null : fields.join(": ").slice(0, 512);
}

function retryAfterMs(value: string | null): number | null { if (value === null) return null; const seconds = Number(value); return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null; }

function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function nextWithAbort(iterator: AsyncIterator<Uint8Array>, signal: AbortSignal): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return iterator.next();
}

function boundedBytes(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) throw new VertexMessagesAdapterError("protocol", `${label} must be a positive safe integer no greater than ${maximum}`);
  return resolved;
}

function boundedRange(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new VertexMessagesAdapterError("protocol", `${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function nonEmpty(value: string, label: string): void { if (typeof value !== "string" || value.trim().length === 0) throw new VertexMessagesAdapterError("protocol", `${label} must be non-empty`); }
