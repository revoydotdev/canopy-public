/**
 * Pure translation between the OpenAI chat-completions wire shape and the
 * Claude Code CLI's headless interface. Kept free of I/O so the wire contract
 * can be tested without spawning a process or opening a socket.
 */
import {
  BridgeRequestError,
  type ChatCompletionRequest,
  type ChatMessage,
  type ClaudeUsage,
  type FunctionTool,
  type OpenAIUsage,
  type StreamChunk,
  type ToolCallDelta,
} from "./protocol.js";

/** Tools are denied individually; the CLI has no single "no tools" switch. */
export const DENIED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "NotebookEdit", "TodoWrite",
].join(",");

/**
 * Aliases arbor operators are likely to configure, mapped to the pinned ids the
 * CLI reports back in `modelUsage`. Unknown values pass through untouched so a
 * newly released model id works without a code change.
 */
const MODEL_ALIASES = new Map<string, string>([
  ["haiku", "claude-haiku-4-5"],
  ["sonnet", "claude-sonnet-4-6"],
  ["opus", "claude-opus-4-8"],
  ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
]);

export function resolveModel(requested: string): string {
  const trimmed = requested.trim();
  if (trimmed === "") throw new BridgeRequestError("model must be a non-empty string", 400, "invalid_request_error");
  return MODEL_ALIASES.get(trimmed) ?? trimmed;
}

function partsToText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  const texts: string[] = [];
  for (const part of content) {
    if (part.type !== "text" || typeof part.text !== "string") {
      throw new BridgeRequestError(
        `unsupported content part "${part.type}"; this bridge serves text only`,
        400,
        "invalid_request_error",
      );
    }
    texts.push(part.text);
  }
  return texts.join("\n");
}

export interface ComposedPrompt {
  readonly systemPrompt: string | null;
  readonly prompt: string;
}

/**
 * Flatten a message list into the CLI's single-prompt interface.
 *
 * System messages become `--system-prompt` (replacing Claude Code's agent
 * persona, which a model endpoint must not inherit). A lone user message is
 * passed verbatim; a multi-turn history is replayed as labelled turns, because
 * the CLI's `-p` mode accepts exactly one prompt string.
 */
export function composePrompt(messages: readonly ChatMessage[]): ComposedPrompt {
  if (messages.length === 0) {
    throw new BridgeRequestError("messages must not be empty", 400, "invalid_request_error");
  }
  const systems: string[] = [];
  const turns: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") systems.push(partsToText(message.content));
    else turns.push(message);
  }
  if (turns.length === 0) {
    throw new BridgeRequestError("messages must contain at least one user or assistant turn", 400, "invalid_request_error");
  }
  const systemPrompt = systems.length === 0 ? null : systems.join("\n\n");
  const prompt =
    turns.length === 1 && turns[0]!.role === "user"
      ? partsToText(turns[0]!.content)
      : turns.map((t) => `${t.role === "user" ? "Human" : "Assistant"}: ${partsToText(t.content)}`).join("\n\n");
  return { systemPrompt, prompt };
}

/**
 * Map Claude's usage onto the OpenAI shape arbor reads.
 *
 * `prompt_tokens` is the TOTAL prompt, of which cache reads and cache writes
 * are disjoint subsets. Claude reports the three as separate fields:
 * `input_tokens` (neither read nor written), `cache_read_input_tokens`, and
 * `cache_creation_input_tokens`. Folding only the cache read into the total
 * left `cache_read + cache_creation > prompt_tokens`, which arbor's
 * `parseUsage` correctly rejects as a protocol violation -- every campaign
 * through this route failed on its first model call. The total must therefore
 * be the sum of all three, which also makes arbor's decomposition
 * `prompt_tokens - cached - cache_creation` recover Claude's own
 * `input_tokens` exactly.
 */
export function toOpenAIUsage(usage: ClaudeUsage | undefined): OpenAIUsage {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  const prompt = input + cacheRead + cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: cacheRead, cache_creation_tokens: cacheWrite },
  };
}

/**
 * Validate the request and reject what a CLI-backed bridge cannot honestly
 * serve. Tools are accepted: they are served by emulation (below), not by
 * dropping them. What is still refused is refused loudly, because a caller
 * that believes a knob took effect when it did not is the failure this
 * surface exists to prevent.
 */
export function validateRequest(body: unknown): ChatCompletionRequest {
  if (typeof body !== "object" || body === null) {
    throw new BridgeRequestError("request body must be a JSON object", 400, "invalid_request_error");
  }
  const request = body as ChatCompletionRequest;
  if (typeof request.model !== "string") {
    throw new BridgeRequestError("model must be a string", 400, "invalid_request_error");
  }
  if (!Array.isArray(request.messages)) {
    throw new BridgeRequestError("messages must be an array", 400, "invalid_request_error");
  }
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) throw new BridgeRequestError("tools must be an array", 400, "invalid_request_error");
    for (const tool of request.tools) {
      const fn = (tool as FunctionTool | null)?.function;
      if ((tool as FunctionTool | null)?.type !== "function" || typeof fn?.name !== "string" || fn.name.trim() === "") {
        throw new BridgeRequestError("every tool must be a function tool with a non-empty name", 400, "invalid_request_error");
      }
    }
  }
  if (request.tool_choice !== undefined && request.tool_choice !== "auto" && request.tool_choice !== "none") {
    throw new BridgeRequestError("tool_choice must be \"auto\" or \"none\"; forcing a named tool is not supported by the emulation", 400, "unsupported_parameter");
  }
  return request;
}

/**
 * Tool-call emulation.
 *
 * The Claude Code CLI runs its own tool loop and has no way to hand a tool
 * request back to the caller, so the OpenAI `tool_calls` contract is served
 * by a closed decision schema instead: every turn the model must answer, via
 * the CLI's own `--json-schema` validator, either `final` with its answer or
 * `tool_calls` with the calls to make now. The bridge translates the decision
 * into the streamed `tool_calls` deltas arbor's adapter assembles by `index`.
 *
 * Tool argument schemas are NOT folded into the decision schema. The CLI's
 * structured-output validator is a narrower JSON Schema dialect than what a
 * harness composes for its tools, and one unsupported keyword would refuse
 * every turn. The catalogue (name, description, parameters) is put in front of
 * the model as text, and arbor validates the arguments against the real
 * schema when the call completes, exactly as it does for any provider.
 */
export interface ToolDecision {
  readonly action: "final" | "tool_calls";
  readonly text: string;
  readonly tool_calls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[];
}

export function activeTools(request: ChatCompletionRequest): readonly FunctionTool[] {
  if (request.tool_choice === "none") return [];
  return request.tools ?? [];
}

export function toolDecisionSchema(tools: readonly FunctionTool[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["final", "tool_calls"] },
      text: { type: "string" },
      tool_calls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", enum: tools.map((tool) => tool.function.name) },
            arguments: { type: "object" },
          },
          required: ["name", "arguments"],
        },
      },
    },
    required: ["action", "text", "tool_calls"],
  };
}

export function toolProtocolInstructions(tools: readonly FunctionTool[], responseSchema: Record<string, unknown> | undefined): string {
  const catalogue = tools.map((tool) => JSON.stringify({
    name: tool.function.name,
    ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
    parameters: tool.function.parameters ?? { type: "object" },
  })).join("\n");
  const finalShape = responseSchema === undefined
    ? "When the task is complete, answer with action \"final\", the answer in \"text\", and an empty \"tool_calls\" array."
    : "When the task is complete, answer with action \"final\" and an empty \"tool_calls\" array; \"text\" must then be exactly one JSON document conforming to this schema and nothing else:\n" + JSON.stringify(responseSchema);
  return [
    "TOOL PROTOCOL. You have the tools listed below, one JSON Schema per line. You cannot run them yourself; you request them and their results come back in the next user turn as \"Tool <name> (<id>) returned:\".",
    catalogue,
    "Every reply is one JSON object with exactly the fields action, text and tool_calls.",
    "To use tools now, answer with action \"tool_calls\" and list each call as {\"name\", \"arguments\"} with arguments conforming to that tool's parameters schema; \"text\" may carry a brief note or be empty. Request several calls in one turn only when they are independent.",
    finalShape,
    "Never invent a tool result and never describe a tool call in prose instead of requesting it.",
  ].join("\n\n");
}

/** Parse the CLI's structured decision. A malformed decision is a provider fault, not a caller fault. */
export function parseToolDecision(value: unknown, tools: readonly FunctionTool[]): ToolDecision {
  if (typeof value !== "object" || value === null) throw new Error("tool decision was not an object");
  const decision = value as Partial<ToolDecision>;
  if (decision.action !== "final" && decision.action !== "tool_calls") throw new Error("tool decision action was invalid");
  const text = typeof decision.text === "string" ? decision.text : "";
  const calls = Array.isArray(decision.tool_calls) ? decision.tool_calls : [];
  const known = new Set(tools.map((tool) => tool.function.name));
  const parsedCalls = calls.map((call) => {
    if (typeof call !== "object" || call === null || typeof call.name !== "string" || !known.has(call.name)) throw new Error("tool decision named an unknown tool");
    const args = typeof call.arguments === "object" && call.arguments !== null && !Array.isArray(call.arguments) ? call.arguments as Record<string, unknown> : {};
    return { name: call.name, arguments: args };
  });
  // A "tool_calls" decision with nothing to call is a final answer in disguise.
  if (decision.action === "tool_calls" && parsedCalls.length === 0) return { action: "final", text, tool_calls: [] };
  return { action: decision.action, text, tool_calls: decision.action === "final" ? [] : parsedCalls };
}

export function toolCallDeltas(decision: ToolDecision, makeId: () => string): readonly ToolCallDelta[] {
  return decision.tool_calls.map((call, index) => ({
    index,
    id: `call_${makeId()}`,
    type: "function" as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
}

export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

export function buildChunk(
  id: string,
  created: number,
  model: string,
  delta: { role?: "assistant"; content?: string; tool_calls?: readonly ToolCallDelta[] },
  options: { finishReason?: string | null; usage?: OpenAIUsage } = {},
): StreamChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: options.finishReason ?? null }],
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  };
}

/**
 * A usage-only terminal chunk. Arbor detects completion from the `[DONE]`
 * sentinel rather than `finish_reason`, but requires usage to have arrived on
 * some chunk when `stream_options.include_usage` was requested.
 */
export function buildUsageChunk(id: string, created: number, model: string, usage: OpenAIUsage): StreamChunk {
  return { id, object: "chat.completion.chunk", created, model, choices: [], usage };
}
