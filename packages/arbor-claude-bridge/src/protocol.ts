/**
 * Wire types for the OpenAI-compatible surface this bridge serves.
 *
 * The contract is fixed by arbor's own consumer, `createOpenAICompatibleModelPort`
 * in `@arbor/harness` (packages/arbor-harness/src/openai-compatible.ts), not by a
 * general reading of the OpenAI spec. Only the fields that adapter actually
 * constructs or reads are modelled here; anything it never sends is rejected as
 * unsupported rather than silently ignored, so a caller never believes a knob
 * took effect when it did not.
 */

/** Text part of a multi-part content array. The adapter also emits `image_url` parts, which this bridge rejects. */
export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | readonly TextPart[];
}

export interface JsonSchemaFormat {
  readonly type: "json_schema";
  readonly json_schema: {
    readonly name: string;
    readonly schema: Record<string, unknown>;
    readonly strict?: boolean;
  };
}

/** One OpenAI function tool as arbor's adapter composes it. */
export interface FunctionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream?: boolean;
  readonly stream_options?: { readonly include_usage?: boolean };
  readonly max_tokens?: number;
  readonly response_format?: JsonSchemaFormat;
  /**
   * Function tools. The CLI cannot emit OpenAI `tool_calls` itself, so the
   * bridge emulates them: the model answers a closed decision schema through
   * the CLI's own structured-output validator and the bridge translates the
   * decision into `tool_calls` deltas (see `translate.ts`).
   */
  readonly tools?: readonly FunctionTool[];
  readonly tool_choice?: "auto" | "none" | Record<string, unknown>;
}

/** A streamed tool-call fragment in the OpenAI delta shape arbor assembles by `index`. */
export interface ToolCallDelta {
  readonly index: number;
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/**
 * OpenAI-shaped usage. `prompt_tokens_details` is the pair arbor reads to recover
 * true input tokens: it computes `input_tokens = prompt_tokens - cached_tokens`
 * and `cache_write_tokens = cache_creation_tokens`.
 */
export interface OpenAIUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly prompt_tokens_details: {
    readonly cached_tokens: number;
    readonly cache_creation_tokens: number;
  };
}

export interface StreamChunk {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly delta: { readonly role?: "assistant"; readonly content?: string; readonly tool_calls?: readonly ToolCallDelta[] };
    readonly finish_reason: string | null;
  }[];
  readonly usage?: OpenAIUsage;
}

/** Raw usage as reported by `claude -p --output-format json`. */
export interface ClaudeUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

export class BridgeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}
