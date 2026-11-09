/**
 * Amazon Bedrock's Anthropic Claude `InvokeModelWithResponseStream`
 * transport (ADR-100 Decision §1/§2). Wire contract verified 2026-08-26
 * against AWS's own documentation:
 *  - Request/response body shape (the Anthropic Messages content-block
 *    schema plus `anthropic_version: "bedrock-2023-05-31"`, no top-level
 *    `stream` field, `model` never in the body):
 *    https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages.html
 *  - Endpoint path (`POST /model/{modelId}/invoke-with-response-stream`),
 *    streaming `Content-Type: application/vnd.amazon.eventstream`, and the
 *    per-chunk `{"chunk": {"bytes": <base64>}}` / named-exception response
 *    shape:
 *    https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModelWithResponseStream.html
 *  - Runtime host pattern (`bedrock-runtime.<region>.amazonaws.com`) and
 *    the SigV4 service name (`bedrock`, shared by control-plane and
 *    runtime): https://docs.aws.amazon.com/general/latest/gr/bedrock.html
 *
 * Signing is `./aws-sigv4.ts` (verified against AWS's own SigV4 test
 * vectors); the eventstream framing is `./bedrock-eventstream.ts`; the
 * Messages-shaped body/stream-event handling is the shared
 * `./anthropic-messages-wire.ts` (ADR-100 Decision §1: "extracted into a
 * shared internal module rather than duplicated three times").
 *
 * Credential convention for this tranche: the worker-owned opaque secret
 * (`NativeModelPort.run`/`stream`'s `secret: string | null`) is a JSON
 * string `{"access_key_id":"...","secret_access_key":"...","session_token"?:"..."}`.
 * This is a stand-in for a real `aws_sigv4` credential-mechanism type on
 * `NativeCredentialMechanism` (`packages/arbor-config/src/native-secret.ts`)
 * and a matching `credential_mechanism_unsupported_by_adapter` pairing in
 * `resolveNativeHarnessExecutionReadiness`
 * (`packages/arbor-mcp/src/native-harness-readiness.ts`) -- both files are
 * outside this tranche's file ownership, so that plumbing has NOT landed;
 * see the task report for the exact boundary. This adapter has never
 * executed against a live Bedrock endpoint -- no credentials, no network in
 * this environment -- and is exercised only with `fetch` stubbed at the
 * boundary plus the independently-verified SigV4/eventstream modules.
 */
import { signAwsSigV4Request, AwsSigV4Error, type AwsSigV4Credentials } from "./aws-sigv4.js";
import { drainEventStreamMessages, BedrockEventStreamError } from "./bedrock-eventstream.js";
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
import type { NativeContextEvidenceRef, NativeInferenceDelta, NativeModelIdentity, NativeRetryClassification } from "./inference.js";
import type { NativeModelPort, NativeModelRequest, NativeToolRisk } from "./native-worker.js";
import { nativeContextOverflowSignal, type NativeModelSignal } from "./native-model-signal.js";

export interface BedrockMessagesFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface BedrockMessagesToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly risk: NativeToolRisk;
  readonly context_refs?: readonly NativeContextEvidenceRef[];
}

export interface BedrockMessagesStructuredSchema {
  readonly schema_id: string;
  readonly name: string;
  readonly schema: Record<string, unknown>;
}

export interface BedrockMessagesModelOptions {
  readonly fetch: BedrockMessagesFetch;
  readonly region: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly observed_at: string;
  readonly tools?: readonly BedrockMessagesToolDefinition[];
  readonly structured_schemas?: readonly BedrockMessagesStructuredSchema[];
  readonly credential_required?: boolean;
  readonly timeout_ms?: number;
  readonly max_response_bytes?: number;
  readonly max_tool_argument_bytes?: number;
  readonly max_output_tokens?: number;
}

export class BedrockMessagesAdapterError extends Error {
  constructor(
    readonly kind: "credential" | "timeout" | "transport" | "http" | "protocol",
    message: string,
    readonly status: number | null = null,
    readonly retry_after_ms: number | null = null,
    readonly native_signal?: NativeModelSignal,
  ) {
    super(message);
    this.name = "BedrockMessagesAdapterError";
  }
}

const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";
const SIGV4_SERVICE = "bedrock";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4_194_304;
const MAX_RESPONSE_BYTES = 8_388_608;
const DEFAULT_MAX_TOOL_ARGUMENT_BYTES = 262_144;
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const MAX_OUTPUT_TOKENS = 128_000;

interface Config {
  readonly fetch: BedrockMessagesFetch;
  readonly region: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly endpoint: string;
  readonly observedAt: string;
  readonly wire: AnthropicWireConfig;
  readonly credentialRequired: boolean;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export function createBedrockMessagesModelPort(options: BedrockMessagesModelOptions): NativeModelPort {
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
    classify_failure(error: unknown): NativeRetryClassification { return classifyBedrockMessagesFailure(error); },
  });
}

export function classifyBedrockMessagesFailure(error: unknown): NativeRetryClassification {
  if (!(error instanceof BedrockMessagesAdapterError)) return { kind: "terminal", reason: "unclassified Bedrock Messages adapter failure" };
  if (error.kind === "timeout" || error.kind === "transport") return { kind: "retryable", reason: error.kind, retry_after_ms: error.retry_after_ms };
  if (error.kind === "http" && (error.status === 408 || error.status === 409 || error.status === 429 || (error.status !== null && error.status >= 500))) {
    return { kind: "retryable", reason: `HTTP ${error.status}`, retry_after_ms: error.retry_after_ms };
  }
  return { kind: "terminal", reason: error.kind };
}

function validateOptions(options: BedrockMessagesModelOptions): Config {
  nonEmpty(options.provider_id, "provider_id");
  nonEmpty(options.model_id, "model_id");
  nonEmpty(options.region, "region");
  if (Number.isNaN(Date.parse(options.observed_at))) throw new BedrockMessagesAdapterError("protocol", "observed_at must be an ISO timestamp");
  const timeout = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) throw new BedrockMessagesAdapterError("protocol", `timeout_ms must be a positive safe integer no greater than ${MAX_TIMEOUT_MS}`);
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
    if (error instanceof AnthropicWireError) throw new BedrockMessagesAdapterError("protocol", error.message);
    throw error;
  }
  const host = `bedrock-runtime.${options.region}.amazonaws.com`;
  const endpoint = `https://${host}/model/${encodePathSegment(options.model_id)}/invoke-with-response-stream`;
  return Object.freeze({
    fetch: options.fetch, region: options.region, providerId: options.provider_id, modelId: options.model_id,
    endpoint, observedAt: options.observed_at, wire,
    credentialRequired: options.credential_required ?? true, timeoutMs: timeout, maxResponseBytes,
  });
}

function encodePathSegment(value: string): string {
  // Bedrock model ids can carry ':' (e.g. inference-profile ARNs); the raw
  // wire path keeps it literal (a valid URI path character), and SigV4
  // canonicalization re-encodes it independently in aws-sigv4.ts.
  return encodeURIComponent(value).replace(/%3A/g, ":");
}

function baseIdentity(config: Config): NativeModelIdentity {
  return Object.freeze({
    provider_id: config.providerId,
    model_id: config.modelId,
    configured_revision: null,
    revision: null,
    capabilities: capabilities(config),
  });
}

function capabilities(config: Config) {
  return Object.freeze([
    capability("streaming", true, config.observedAt, "adapter parses the AWS eventstream-framed Anthropic Messages event stream"),
    capability("tool_calls", config.wire.tools.size > 0, config.observedAt, config.wire.tools.size > 0 ? "adapter validates configured tool_use blocks after their streamed input_json_delta fragments complete" : "no tool schemas were composed"),
    capability("structured_output", config.wire.schemas.size > 0, config.observedAt, config.wire.schemas.size > 0 ? "adapter sends output_config.format for the requested composed schema_id" : "no structured-output schemas were composed"),
    capability("human_input", false, config.observedAt, "Bedrock transport does not implement the human-input tool convention this tranche"),
    capability("image_input", false, config.observedAt, "Bedrock transport does not implement governed image input this tranche"),
    capability("document_input", false, config.observedAt, "Bedrock transport does not implement governed document input this tranche"),
  ]);
}

function capability(capability: NativeModelIdentity["capabilities"][number]["capability"], available: boolean, observedAt: string, detail: string) {
  return Object.freeze({ capability, available, observed_at: observedAt, detail });
}

function parseCredential(secret: string): AwsSigV4Credentials {
  let parsed: unknown;
  try { parsed = JSON.parse(secret); } catch { throw new BedrockMessagesAdapterError("credential", "injected Bedrock credential was not the expected JSON {access_key_id, secret_access_key, session_token?} shape"); }
  if (!isRecord(parsed) || typeof parsed.access_key_id !== "string" || typeof parsed.secret_access_key !== "string" || parsed.access_key_id.length === 0 || parsed.secret_access_key.length === 0) {
    throw new BedrockMessagesAdapterError("credential", "injected Bedrock credential was missing access_key_id/secret_access_key");
  }
  const sessionToken = typeof parsed.session_token === "string" && parsed.session_token.length > 0 ? parsed.session_token : undefined;
  return Object.freeze({ access_key_id: parsed.access_key_id, secret_access_key: parsed.secret_access_key, ...(sessionToken === undefined ? {} : { session_token: sessionToken }) });
}

async function* streamMessage(config: Config, request: NativeModelRequest, secret: string | null, signal: AbortSignal, observeIdentity: (identity: NativeModelIdentity) => void): AsyncIterable<NativeInferenceDelta> {
  if (config.credentialRequired && (secret === null || secret.length === 0)) throw new BedrockMessagesAdapterError("credential", "an injected credential is required for this provider");
  const credentials = secret === null ? null : parseCredential(secret);

  const { stream: _stream, ...bodyWithoutStream } = buildAnthropicWireRequestBody(config.wire, request);
  const body = JSON.stringify({ anthropic_version: BEDROCK_ANTHROPIC_VERSION, ...bodyWithoutStream });

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
  const combined = anySignal([signal, timeout.signal]);

  const baseHeaders: Record<string, string> = { "content-type": "application/json", accept: "application/vnd.amazon.eventstream" };
  let requestHeaders: Record<string, string> = { ...baseHeaders };
  if (credentials !== null) {
    let signed;
    try {
      signed = signAwsSigV4Request({ method: "POST", url: config.endpoint, region: config.region, service: SIGV4_SERVICE, headers: baseHeaders, body }, credentials);
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof AwsSigV4Error) throw new BedrockMessagesAdapterError("credential", `failed to sign Bedrock request: ${error.message}`);
      throw error;
    }
    requestHeaders = { ...baseHeaders, ...signed.headers };
  }

  let response: Response;
  try {
    response = await config.fetch(config.endpoint, { method: "POST", headers: Object.freeze(requestHeaders), body, signal: combined });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof BedrockMessagesAdapterError) throw error;
    if (timeout.signal.aborted && !signal.aborted) throw new BedrockMessagesAdapterError("timeout", "Bedrock request exceeded its configured timeout");
    if (signal.aborted) throw error;
    throw new BedrockMessagesAdapterError("transport", "Bedrock transport failed");
  }
  if (!response.ok) {
    clearTimeout(timer);
    const detail = await boundedText(response);
    throw new BedrockMessagesAdapterError("http", `Bedrock provider returned HTTP ${response.status}${detail === null ? "" : `: ${detail}`}`, response.status, retryAfterMs(response.headers.get("retry-after")), nativeContextOverflowSignal(detail) ?? undefined);
  }
  if (response.body === null) { clearTimeout(timer); throw new BedrockMessagesAdapterError("protocol", "Bedrock provider returned an empty streaming body"); }

  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  const state = newAnthropicWireStreamState();
  try {
    const iterator = (response.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    while (true) {
      const next = await nextWithAbort(iterator, combined);
      if (next.done) break;
      state.responseBytes += next.value.byteLength;
      if (state.responseBytes > config.maxResponseBytes) throw new BedrockMessagesAdapterError("protocol", "Bedrock stream exceeded the configured response byte limit");
      pending = concatBytes(pending, next.value);
      let drained;
      try { drained = drainEventStreamMessages(pending); } catch (error) {
        if (error instanceof BedrockEventStreamError) throw new BedrockMessagesAdapterError("protocol", `Bedrock eventstream framing was invalid: ${error.message}`);
        throw error;
      }
      pending = drained.rest;
      for (const message of drained.messages) {
        const streamError = applyEventStreamMessage(config, message, state);
        if (streamError !== null) throw new BedrockMessagesAdapterError("http", `Bedrock stream reported an error: ${streamError.detail}`, streamError.status, null, streamError.native_signal);
      }
      if (state.done) { for (const delta of finishAnthropicWireStream(config.wire, state, request.structured_output !== null)) yield delta; observeIdentity(verifiedIdentity(config)); return; }
    }
  } catch (error) {
    if (error instanceof BedrockMessagesAdapterError) throw error;
    if (error instanceof AnthropicWireError) throw new BedrockMessagesAdapterError("protocol", error.message);
    if (timeout.signal.aborted && !signal.aborted) throw new BedrockMessagesAdapterError("timeout", "Bedrock stream exceeded its configured timeout");
    if (signal.aborted) throw error;
    throw new BedrockMessagesAdapterError("protocol", "Bedrock streaming response was invalid");
  } finally {
    clearTimeout(timer);
  }
  throw new BedrockMessagesAdapterError("protocol", "Bedrock stream ended before message_stop");
}

function applyEventStreamMessage(config: Config, message: { readonly headers: ReadonlyMap<string, string>; readonly payload: Uint8Array }, state: ReturnType<typeof newAnthropicWireStreamState>) {
  const messageType = message.headers.get(":message-type");
  const text = new TextDecoder().decode(message.payload);
  if (messageType === "exception") {
    const exceptionType = message.headers.get(":exception-type") ?? "unknown";
    let parsedMessage: string | null = null;
    try { const value: unknown = JSON.parse(text); if (isRecord(value) && typeof value.message === "string") parsedMessage = value.message; } catch { /* best-effort detail */ }
    const detail = parsedMessage === null ? exceptionType : `${exceptionType}: ${parsedMessage}`;
    return { status: exceptionStatus(exceptionType), detail, native_signal: nativeContextOverflowSignal(detail) ?? undefined };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new BedrockMessagesAdapterError("protocol", "Bedrock eventstream payload was not JSON"); }
  if (!isRecord(parsed) || typeof parsed.bytes !== "string") throw new BedrockMessagesAdapterError("protocol", "Bedrock chunk payload was missing bytes");
  let decoded: string;
  try { decoded = Buffer.from(parsed.bytes, "base64").toString("utf8"); } catch { throw new BedrockMessagesAdapterError("protocol", "Bedrock chunk payload was not valid base64"); }
  let event: unknown;
  try { event = JSON.parse(decoded); } catch { throw new BedrockMessagesAdapterError("protocol", "Bedrock chunk payload did not decode to JSON"); }
  return applyAnthropicWireEvent(config.wire, event, state);
}

const EXCEPTION_STATUS: Readonly<Record<string, number>> = Object.freeze({
  throttlingException: 429, modelTimeoutException: 408, modelStreamErrorException: 424,
  internalServerException: 500, serviceUnavailableException: 503, validationException: 400,
  accessDeniedException: 403, resourceNotFoundException: 404,
});
function exceptionStatus(exceptionType: string): number | null { return EXCEPTION_STATUS[exceptionType] ?? null; }

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
  if (bytes === 0) return null;
  return new TextDecoder().decode(Buffer.concat(chunks)).replace(/[ -]/g, " ").trim().slice(0, 512) || null;
}

function concatBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
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

async function nextWithAbort(iterator: AsyncIterator<Uint8Array>, signal: AbortSignal): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return iterator.next();
}

function boundedBytes(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) throw new BedrockMessagesAdapterError("protocol", `${label} must be a positive safe integer no greater than ${maximum}`);
  return resolved;
}

function boundedRange(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new BedrockMessagesAdapterError("protocol", `${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function nonEmpty(value: string, label: string): void { if (typeof value !== "string" || value.trim().length === 0) throw new BedrockMessagesAdapterError("protocol", `${label} must be non-empty`); }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
