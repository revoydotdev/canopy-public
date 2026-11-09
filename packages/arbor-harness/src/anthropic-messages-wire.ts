import { nativeContextOverflowSignal, type NativeModelSignal } from "./native-model-signal.js";

/**
 * The Anthropic Messages content-block wire shape, shared by the Bedrock
 * and Vertex adapters (ADR-100 Decision §1: "each new adapter is primarily
 * a signing/auth layer wrapped around the request construction and
 * response parsing `anthropic-messages.ts` already owns -- extracted into
 * a shared internal module rather than duplicated three times").
 *
 * `anthropic-messages.ts` is owned by a different tranche this cycle and is
 * not edited here; this module is an independently-authored equivalent for
 * the same wire contract (Bedrock's `InvokeModel*` body is documented as
 * "the same content-block schema" -- see
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages.html,
 * fetched 2026-08-26 -- and Vertex's Claude endpoint is "nearly identical
 * to the Messages API" per
 * https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai,
 * fetched 2026-08-26), so the two implementations are expected to converge
 * in shape even though neither imports the other.
 *
 * Deliberately narrower than `anthropic-messages.ts`: text, tool_use/
 * tool_result round-trips, system text, and structured output are
 * supported; extended thinking, prompt-cache breakpoints, governed image
 * input, and the human-input tool convention are not implemented for
 * Bedrock/Vertex in this tranche (both bedrock-messages.ts and
 * vertex-messages.ts report `image_input`/`human_input` capability as
 * unavailable rather than silently dropping supplied data).
 */
import { createHash } from "node:crypto";
import { nativeStopReasonFromAnthropic, type NativeContextEvidenceRef, type NativeInferenceDelta, type NativeUsageAndCost } from "./inference.js";
import { recoverStructuredReply } from "./structured-reply.js";
import type { NativeModelRequest, NativeToolRisk } from "./native-worker.js";
import { nativeContextCacheClass } from "./context-manager.js";

export interface AnthropicWireToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly risk: NativeToolRisk;
  readonly context_refs?: readonly NativeContextEvidenceRef[];
}

export interface AnthropicWireStructuredSchema {
  readonly schema_id: string;
  readonly name: string;
  readonly schema: Record<string, unknown>;
}

export interface AnthropicWireConfig {
  readonly modelId: string;
  readonly maxOutputTokens: number;
  readonly maxResponseBytes: number;
  readonly maxToolArgumentBytes: number;
  readonly tools: ReadonlyMap<string, AnthropicWireToolDefinition>;
  readonly toolsByWireName: ReadonlyMap<string, AnthropicWireToolDefinition>;
  readonly schemas: ReadonlyMap<string, AnthropicWireStructuredSchema>;
}

export class AnthropicWireError extends Error {
  constructor(readonly kind: "protocol", message: string) {
    super(message);
    this.name = "AnthropicWireError";
  }
}

export function buildAnthropicWireConfig(options: {
  readonly modelId: string;
  readonly maxOutputTokens: number;
  readonly maxResponseBytes: number;
  readonly maxToolArgumentBytes: number;
  readonly tools?: readonly AnthropicWireToolDefinition[];
  readonly structured_schemas?: readonly AnthropicWireStructuredSchema[];
}): AnthropicWireConfig {
  const tools = uniqueBy(options.tools ?? [], (tool) => {
    nonEmpty(tool.name, "tool name");
    nonEmpty(tool.description, "tool description");
    if (tool.risk !== "low" && tool.risk !== "high") throw new AnthropicWireError("protocol", "tool risk must be low or high");
    return tool.name;
  }, "tool name");
  const schemas = uniqueBy(options.structured_schemas ?? [], (schema) => {
    nonEmpty(schema.schema_id, "structured schema_id");
    nonEmpty(schema.name, "structured schema name");
    return schema.schema_id;
  }, "structured schema_id");
  return Object.freeze({
    modelId: options.modelId,
    maxOutputTokens: options.maxOutputTokens,
    maxResponseBytes: options.maxResponseBytes,
    maxToolArgumentBytes: options.maxToolArgumentBytes,
    tools,
    toolsByWireName: wireToolMap(tools),
    schemas,
  });
}

// Mirrors anthropic-messages.ts's `anthropicToolWireName` (that file is
// owned by a different tranche this cycle and is not imported here, per
// this module's header) rather than inventing a second convention: a
// name that already satisfies the wire grammar passes through unchanged;
// otherwise it is sanitized, truncated, and given a content-derived hash
// suffix so the 128-char provider limit is respected and two different
// canonical names collapsing to the same sanitized prefix still disambiguate
// (the suffix is derived from the full original name, not the truncated
// prefix, so a same-suffix collision would require an actual SHA-256
// collision rather than two dotted names merely differing outside the
// allowed character set).
const ANTHROPIC_TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
export function anthropicToolWireName(name: string): string {
  if (ANTHROPIC_TOOL_NAME.test(name)) return name;
  const readable = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 16);
  const wireName = `${readable.slice(0, 109)}__${suffix}`;
  if (!ANTHROPIC_TOOL_NAME.test(wireName)) throw new AnthropicWireError("protocol", "tool name cannot be represented in the Anthropic wire grammar");
  return wireName;
}

function wireToolMap(tools: ReadonlyMap<string, AnthropicWireToolDefinition>): ReadonlyMap<string, AnthropicWireToolDefinition> {
  const byWireName = new Map<string, AnthropicWireToolDefinition>();
  for (const tool of tools.values()) {
    const wireName = anthropicToolWireName(tool.name);
    if (byWireName.has(wireName)) throw new AnthropicWireError("protocol", `tool wire name collision: ${wireName}`);
    byWireName.set(wireName, tool);
  }
  return byWireName;
}

/**
 * Builds the Messages-shaped body minus provider-specific top-level fields
 * (`model`/`anthropic_version`/`stream`): each adapter adds those itself,
 * since Bedrock omits `model` (it's in the URL) and Vertex spells the
 * version field differently from the direct API.
 */
export function buildAnthropicWireRequestBody(config: AnthropicWireConfig, request: NativeModelRequest): Record<string, unknown> {
  const historyEntryIds = new Set(request.history.flatMap((entry) => (entry.evidence ?? []).map((ref) => ref.entry_id)));
  const promptEntryIds = new Set(request.prompt_projection?.context_entry_ids ?? []);
  const additiveEntries = request.context === null ? [] : request.context.entries
    .filter((entry) => !promptEntryIds.has(entry.entry_id) && !historyEntryIds.has(entry.entry_id));
  const stableContext = additiveEntries.filter((entry) => nativeContextCacheClass(entry.source) === "stable").map((entry) => entry.text).join("\n\n");
  const dynamicContext = additiveEntries.filter((entry) => nativeContextCacheClass(entry.source) === "dynamic").map((entry) => entry.text).join("\n\n");
  const systemText = [
    request.profile === null ? null : `Role: ${request.profile.role_id}`,
    ...(request.prompt_projection?.governed_context_included === true ? [] : request.governed_context.instructions.map((instruction) => instruction.text)),
    stableContext,
  ].filter((value): value is string => value !== null && value.length > 0).join("\n\n");

  const messages: Array<Record<string, unknown>> = [];
  for (const entry of request.history) {
    if (entry.kind === "model_text" || entry.kind === "thinking") messages.push({ role: "assistant", content: entry.text });
    else if (entry.kind === "tool_result") messages.push({ role: "user", content: `Tool ${entry.tool ?? "unknown"} (${entry.call_id ?? "unknown"}) returned:\n${entry.text}` });
    else messages.push({ role: "user", content: `Human input:\n${entry.text}` });
  }
  const userText = [request.prompt, dynamicContext.length === 0 ? null : `Dynamic session context:\n${dynamicContext}`]
    .filter((value): value is string => value !== null).join("\n\n");
  messages.push({ role: "user", content: userText });

  const schema = request.structured_output === null ? undefined : config.schemas.get(request.structured_output.schema_id);
  if (request.structured_output !== null && schema === undefined) {
    throw new AnthropicWireError("protocol", "requested structured-output schema was not composed");
  }

  const toolsAllowed = request.tools_allowed !== false && config.tools.size > 0;
  const toolDefinitions = toolsAllowed
    ? [...config.toolsByWireName].map(([wireName, tool]) => ({ name: wireName, description: tool.description, input_schema: anthropicWireInputSchema(tool.parameters) }))
    : [];

  return {
    max_tokens: config.maxOutputTokens,
    stream: true,
    ...(systemText.length === 0 ? {} : { system: systemText }),
    messages,
    ...(toolDefinitions.length === 0 ? {} : { tools: toolDefinitions, tool_choice: { type: "auto" } }),
    ...(schema === undefined ? {} : { output_config: { format: { type: "json_schema", schema: schema.schema } } }),
  };
}

interface StreamedBlock { readonly kind: "text" | "tool_use"; text: string; id: string; name: string; json: string }
export interface AnthropicWireStreamState {
  readonly blocks: Map<number, StreamedBlock>;
  readonly order: number[];
  observedModelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  responseBytes: number;
  /** The provider's `message_delta.delta.stop_reason`, when it sent one. */
  stopReason: string | null;
  done: boolean;
}

export function newAnthropicWireStreamState(): AnthropicWireStreamState {
  return { blocks: new Map(), order: [], observedModelId: null, inputTokens: null, outputTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0, responseBytes: 0, stopReason: null, done: false };
}

const STREAM_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  rate_limit_error: 429, overloaded_error: 529, api_error: 500, timeout_error: 504,
  invalid_request_error: 400, authentication_error: 401, permission_error: 403, not_found_error: 404, billing_error: 403,
});

export interface AnthropicWireStreamError {
  readonly status: number | null;
  readonly detail: string;
  readonly native_signal?: NativeModelSignal;
}

/** Returns a stream-level error observation (Anthropic's `error` event carries no HTTP status of its own) or `null` for a non-error event. */
export function applyAnthropicWireEvent(config: AnthropicWireConfig, event: unknown, state: AnthropicWireStreamState): AnthropicWireStreamError | null {
  if (!isRecord(event) || typeof event.type !== "string") throw new AnthropicWireError("protocol", "stream contained an event with no type");
  if (event.type === "message_start") {
    if (!isRecord(event.message) || typeof event.message.model !== "string") throw new AnthropicWireError("protocol", "message_start was invalid");
    if (state.observedModelId !== null && state.observedModelId !== event.message.model) throw new AnthropicWireError("protocol", "stream changed its response model identity");
    state.observedModelId = event.message.model;
    applyUsage(event.message.usage, state);
    return null;
  }
  if (event.type === "content_block_start") {
    const index = requireIndex(event.index);
    const block = event.content_block;
    if (isRecord(block) && block.type === "tool_use") {
      if (typeof block.id !== "string" || typeof block.name !== "string" || !block.id || !block.name) throw new AnthropicWireError("protocol", "tool_use block was invalid");
      state.blocks.set(index, { kind: "tool_use", text: "", id: block.id, name: block.name, json: "" });
    } else {
      state.blocks.set(index, { kind: "text", text: "", id: "", name: "", json: "" });
    }
    state.order.push(index);
    return null;
  }
  if (event.type === "content_block_delta") {
    const index = requireIndex(event.index);
    const block = state.blocks.get(index);
    if (block === undefined) throw new AnthropicWireError("protocol", "content_block_delta referenced an unknown block");
    const delta = event.delta;
    if (!isRecord(delta)) throw new AnthropicWireError("protocol", "content_block_delta was invalid");
    if (delta.type === "text_delta") {
      if (typeof delta.text !== "string") throw new AnthropicWireError("protocol", "text_delta was invalid");
      block.text += delta.text;
      if (Buffer.byteLength(block.text) > config.maxResponseBytes) throw new AnthropicWireError("protocol", "stream exceeded the configured response byte limit");
    } else if (delta.type === "input_json_delta") {
      if (typeof delta.partial_json !== "string") throw new AnthropicWireError("protocol", "input_json_delta was invalid");
      block.json += delta.partial_json;
      if (Buffer.byteLength(block.json) > config.maxToolArgumentBytes) throw new AnthropicWireError("protocol", "tool arguments exceeded the configured byte limit");
    }
    return null;
  }
  if (event.type === "content_block_stop" || event.type === "ping") return null;
  if (event.type === "message_delta") {
    applyUsage(event.usage, state);
    if (isRecord(event.delta) && typeof event.delta.stop_reason === "string") state.stopReason = event.delta.stop_reason;
    return null;
  }
  if (event.type === "message_stop") { state.done = true; return null; }
  if (event.type === "error") {
    const errorType = isRecord(event.error) && typeof event.error.type === "string" ? event.error.type : null;
    const errorMessage = isRecord(event.error) && typeof event.error.message === "string" ? event.error.message.slice(0, 512) : null;
    const detail = [errorType, errorMessage].filter((value): value is string => value !== null).join(": ") || "unknown";
    const nativeSignal = nativeContextOverflowSignal(detail);
    return {
      status: errorType === null ? null : (STREAM_ERROR_STATUS[errorType] ?? null),
      detail,
      ...(nativeSignal === null ? {} : { native_signal: nativeSignal }),
    };
  }
  return null; // forward-compatible: unknown event types are ignored
}

function applyUsage(value: unknown, state: AnthropicWireStreamState): void {
  if (!isRecord(value)) return;
  if (safeInteger(value.input_tokens)) state.inputTokens = value.input_tokens;
  if (safeInteger(value.output_tokens)) state.outputTokens = value.output_tokens;
  if (safeInteger(value.cache_read_input_tokens)) state.cacheReadTokens = value.cache_read_input_tokens;
  if (safeInteger(value.cache_creation_input_tokens)) state.cacheWriteTokens = value.cache_creation_input_tokens;
}

export function finishAnthropicWireStream(config: AnthropicWireConfig, state: AnthropicWireStreamState, structuredRequested: boolean): readonly NativeInferenceDelta[] {
  if (state.observedModelId !== null && state.observedModelId !== config.modelId) {
    throw new AnthropicWireError("protocol", "response model identity did not match the configured model");
  }
  const output: NativeInferenceDelta[] = [];
  if (state.inputTokens !== null && state.outputTokens !== null) {
    const usage: NativeUsageAndCost = {
      tokens: { kind: "measured", input_tokens: state.inputTokens, output_tokens: state.outputTokens, cache_read_tokens: state.cacheReadTokens, cache_write_tokens: state.cacheWriteTokens },
      cost: { kind: "unpriced", reason: "managed-endpoint response does not include an attributable price schedule" },
    };
    output.push({ kind: "usage", observation: usage });
  }
  const stop = state.stopReason === null ? null : nativeStopReasonFromAnthropic(state.stopReason);
  if (stop !== null) output.push({ kind: "stop", reason: stop });
  const blocks = state.order.map((index) => state.blocks.get(index)!);
  // A turn cut off at max_tokens can end inside a tool_use input: truncation,
  // not a protocol violation. Drop the calls; the worker continues the turn.
  const truncatedCalls = stop === "output_limit" && blocks.some((block) => block.kind === "tool_use" && block.json.trim().length > 0 && !isParsableJson(block.json));
  const toolCalls = truncatedCalls ? [] : blocks.filter((block) => block.kind === "tool_use");
  const text = blocks.filter((block) => block.kind === "text").map((block) => block.text).join("");

  if (toolCalls.length > 0) {
    if (text.length > 0) output.push({ kind: "text", text, phase: "commentary" });
    for (const call of toolCalls) {
      const raw = call.json.trim().length === 0 ? "{}" : call.json;
      let input: unknown;
      try { input = JSON.parse(raw); } catch { throw new AnthropicWireError("protocol", "tool input was not JSON"); }
      const tool = config.toolsByWireName.get(call.name);
      if (!tool) {
        output.push({ kind: "tool_call", call_id: call.id, tool: call.name, input: null, input_summary: `provider requested uncomposed tool ${call.name}`, risk: "low", context_refs: [], uncomposed: { available_tools: [...config.tools.keys()].sort() } });
        continue;
      }
      output.push({ kind: "tool_call", call_id: call.id, tool: tool.name, input, input_summary: `provider requested ${tool.name}`, risk: tool.risk, context_refs: tool.context_refs ?? [] });
    }
    return output;
  }
  if (text.length > 0) output.push({ kind: "text", text, phase: "final" });
  // No recoverable JSON value, or a reply cut off at max_tokens, is a model
  // miss the worker corrects in-session, never a protocol failure.
  const reply = !structuredRequested ? null
    : stop === "output_limit" ? { kind: "unparsed" as const, reason: "the reply was cut off at the output-token limit" }
      : recoverStructuredReply(text);
  output.push({ kind: "final", message: text, ...(reply === null ? {} : reply.kind === "parsed" ? { structured_output: reply.value } : { structured_output_unparsed: reply.reason }) });
  return output;
}

function isParsableJson(raw: string): boolean {
  try { JSON.parse(raw); return true; } catch { return false; }
}

/**
 * Mirrors anthropic-messages.ts's `anthropicInputSchema` (not imported here,
 * per this module's header): Anthropic requires a top-level object input
 * schema and rejects top-level `oneOf`/`anyOf`/`allOf`. Keep the canonical
 * schema untouched for host-side validation and publish its object surface
 * plus the requirements shared by every branch.
 */
function anthropicWireInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const alternatives = [schema.oneOf, schema.anyOf, schema.allOf].find(Array.isArray) as unknown[] | undefined;
  if (alternatives === undefined) return schema;
  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...objectSchema } = schema;
  const sharedRequired = intersectionRequired(alternatives);
  const declaredRequired = stringArrayValue(schema.required);
  const required = [...new Set([...declaredRequired, ...sharedRequired])];
  return Object.freeze({ ...objectSchema, type: "object", ...(required.length === 0 ? {} : { required }) });
}

function intersectionRequired(alternatives: readonly unknown[]): readonly string[] {
  const branches = alternatives.filter(isRecord).map((branch) => stringArrayValue(branch.required));
  if (branches.length !== alternatives.length || branches.length === 0) return [];
  return branches[0]!.filter((field) => branches.slice(1).every((branch) => branch.includes(field)));
}

function stringArrayValue(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function requireIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AnthropicWireError("protocol", "stream event carried an invalid block index");
  return value;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string, label: string): ReadonlyMap<string, T> {
  const values = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (values.has(id)) throw new AnthropicWireError("protocol", `duplicate ${label}: ${id}`);
    values.set(id, item);
  }
  return values;
}

function nonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new AnthropicWireError("protocol", `${label} must be non-empty`);
}
