/**
 * The HTTP surface: an OpenAI-compatible `/v1/chat/completions` endpoint that
 * arbor's `openai-compatible` native adapter can drive unmodified.
 *
 * Shape obligations imposed by that adapter (packages/arbor-harness/src/openai-compatible.ts):
 *  - `Authorization: Bearer <secret>` is always sent and is required here.
 *  - the request always sets `stream: true` + `stream_options.include_usage`.
 *  - the response must be an SSE stream of `data: {...}` frames whose top-level
 *    `model` never changes, carrying `choices[].delta.content`, and must end
 *    with `data: [DONE]` -- ending without the sentinel is a protocol error.
 *  - usage must use OpenAI names (`prompt_tokens`/`completion_tokens`), not
 *    Anthropic's (`input_tokens`/`output_tokens`).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClaude } from "./claude-backend.js";
import { BridgeRequestError } from "./protocol.js";
import {
  SSE_DONE,
  activeTools,
  buildChunk,
  buildUsageChunk,
  composePrompt,
  parseToolDecision,
  resolveModel,
  sseFrame,
  toOpenAIUsage,
  toolCallDeltas,
  toolDecisionSchema,
  toolProtocolInstructions,
  validateRequest,
} from "./translate.js";

/** Emitted per request so an operator can prove a caller actually reached the bridge. */
export interface BridgeAccessLog {
  readonly at: string;
  readonly model: string;
  readonly durationMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
  /** Set when the completion ended in an in-stream error; the message the caller received. */
  readonly error?: string;
  /** "tools" when the request carried function tools (served by emulation), "schema" for structured output, else "text". */
  readonly mode: "text" | "schema" | "tools";
}

export interface BridgeConfig {
  /** Shared secret the caller must present as a bearer token. */
  readonly apiKey: string;
  readonly port: number;
  readonly host?: string;
  /** Working directory for spawned CLI processes. */
  readonly cwd?: string;
  readonly executable?: string;
  /** Called once per completed completion. Defaults to a JSON line on stderr. */
  readonly onAccess?: (entry: BridgeAccessLog) => void;
  /**
   * Opt-in diagnostics: when set, every completion writes one JSON file
   * (`<id>.json`) with the request the caller sent, the system prompt the
   * CLI received, and what came back (decision, structured value, or error).
   * This is the model-facing conversation, secrets excluded (the bearer
   * never reaches this file); use it to answer "what did the model actually
   * see" when a pilot's specialist misreads its tools.
   */
  readonly traceDir?: string;
}

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleChatCompletions(request: Request, config: BridgeConfig): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "request body was not valid JSON");
  }

  let composed: ReturnType<typeof composePrompt>;
  let model: string;
  let parsed: ReturnType<typeof validateRequest>;
  try {
    parsed = validateRequest(body);
    model = resolveModel(parsed.model);
    composed = composePrompt(parsed.messages);
  } catch (error) {
    if (error instanceof BridgeRequestError) return errorResponse(error.status, error.type, error.message);
    throw error;
  }

  // Echo the model string the caller asked for, unchanged. Arbor compares the
  // observed `model` against its configured `model_id` and treats any drift --
  // including our alias resolution -- as a protocol error.
  const echoModel = parsed.model;
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const responseSchema = parsed.response_format?.json_schema?.schema;
  const tools = activeTools(parsed);
  // Tools present: the CLI answers the decision schema, and the caller's own
  // response_format (if any) is carried inside the decision's final text.
  // No tools: the caller's schema goes to the CLI validator unchanged.
  const schema = tools.length > 0 ? toolDecisionSchema(tools) : responseSchema;
  // Under a schema the model tends to narrate ("Let me assess…") before
  // calling StructuredOutput; the narration is dropped (below) but still
  // costs output tokens and can exhaust the ceiling before the value exists.
  const schemaDiscipline = schema === undefined ? null
    : "OUTPUT DISCIPLINE. Produce the structured output directly and immediately; do not narrate, explain or restate the task before it. Everything you want to say belongs inside the structured fields.";
  const systemPrompt = [composed.systemPrompt, tools.length === 0 ? null : toolProtocolInstructions(tools, responseSchema), schemaDiscipline]
    .filter((part): part is string => part !== null).join("\n\n");
  const finalSystemPrompt = systemPrompt.length === 0 ? null : systemPrompt;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (payload: unknown) => controller.enqueue(encoder.encode(sseFrame(payload)));
      let usageSent = false;
      const startedAt = Date.now();
      let costUsd = 0;
      const trace: Record<string, unknown> = { id, model: echoModel, mode: tools.length > 0 ? "tools" : schema !== undefined ? "schema" : "text", request: parsed, system_prompt: finalSystemPrompt, prompt: composed.prompt };
      let logged: { prompt: number; completion: number } = { prompt: 0, completion: 0 };
      let lastError: string | undefined;
      const sendError = (code: number, message: string) => { lastError = message; send({ error: { code, message } }); };
      try {
        send(buildChunk(id, created, echoModel, { role: "assistant", content: "" }));
        let streamedText = false;
        void streamedText;
        for await (const event of runClaude({
          model,
          prompt: composed.prompt,
          systemPrompt: finalSystemPrompt,
          maxTokens: parsed.max_tokens,
          jsonSchema: schema,
          cwd: config.cwd,
          executable: config.executable,
          signal: request.signal,
        })) {
          if (event.kind === "text") {
            // With a schema on the CLI the model may still narrate ("Let me
            // assess…") before it calls StructuredOutput; the pilot's critic
            // received that narration as its verdict and failed. Under a
            // schema only the result frame's value is the answer.
            if (schema !== undefined) continue;
            streamedText = true;
            send(buildChunk(id, created, echoModel, { content: event.text }));
          } else if (event.kind === "done") {
            const usage = toOpenAIUsage(event.usage);
            costUsd = event.costUsd;
            logged = { prompt: usage.prompt_tokens, completion: usage.completion_tokens };
            let finishReason = "stop";
            if (tools.length > 0) {
              // The decision arrives only in the result frame (never as text).
              let decision;
              try {
                decision = parseToolDecision(event.structuredOutput ?? (event.resultText === undefined ? undefined : JSON.parse(event.resultText)), tools);
              } catch (error) {
                sendError(502, `bridge tool emulation: ${error instanceof Error ? error.message : String(error)}`);
                decision = null;
              }
              trace.decision = decision ?? event.structuredOutput ?? event.resultText;
              if (decision !== null) {
                if (decision.text.length > 0) send(buildChunk(id, created, echoModel, { content: decision.text }));
                if (decision.action === "tool_calls") {
                  send(buildChunk(id, created, echoModel, { tool_calls: toolCallDeltas(decision, () => randomUUID().replace(/-/g, "").slice(0, 24)) }));
                  finishReason = "tool_calls";
                }
              }
            } else if (schema !== undefined) {
              // Structured output without tools: the value lives only in the
              // result frame, so forward it as the assistant content.
              const text = event.structuredOutput !== undefined ? JSON.stringify(event.structuredOutput) : (event.resultText ?? "");
              trace.structured_output = event.structuredOutput ?? event.resultText;
              if (text.length > 0) send(buildChunk(id, created, echoModel, { content: text }));
              else sendError(502, "claude CLI finished a structured-output request without a structured_output value");
            }
            send(buildChunk(id, created, echoModel, {}, { finishReason }));
            send(buildUsageChunk(id, created, echoModel, usage));
            usageSent = true;
          } else {
            // Mid-stream failure. Arbor reads a top-level `error` object out of
            // an otherwise-200 stream (OpenRouter's convention) and classifies
            // it for retry, so report it that way rather than tearing the
            // connection down with no diagnosis.
            sendError(502, event.message);
          }
        }
        if (!usageSent) send(buildUsageChunk(id, created, echoModel, toOpenAIUsage(undefined)));
      } catch (error) {
        sendError(500, error instanceof Error ? error.message : String(error));
      } finally {
        controller.enqueue(encoder.encode(SSE_DONE));
        controller.close();
        const entry: BridgeAccessLog = {
          at: new Date().toISOString(),
          model: echoModel,
          durationMs: Date.now() - startedAt,
          promptTokens: logged.prompt,
          completionTokens: logged.completion,
          costUsd,
          mode: tools.length > 0 ? "tools" : schema !== undefined ? "schema" : "text",
          ...(lastError === undefined ? {} : { error: lastError }),
        };
        (config.onAccess ?? ((e) => process.stderr.write(`${JSON.stringify(e)}\n`)))(entry);
        if (config.traceDir !== undefined) {
          try {
            mkdirSync(config.traceDir, { recursive: true });
            writeFileSync(join(config.traceDir, `${id}.json`), `${JSON.stringify({ ...trace, access: entry }, null, 2)}\n`, "utf8");
          } catch { /* diagnostics never fail a completion */ }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export function createFetchHandler(config: BridgeConfig): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { headers: { "content-type": "application/json" } });
    }

    const presented = request.headers.get("authorization");
    if (presented !== `Bearer ${config.apiKey}`) {
      return errorResponse(401, "authentication_error", "missing or invalid bearer token");
    }

    if (url.pathname === "/v1/models" && request.method === "GET") {
      const models = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"];
      return new Response(
        JSON.stringify({
          object: "list",
          data: models.map((mid) => ({ id: mid, object: "model", created: 0, owned_by: "anthropic" })),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      return handleChatCompletions(request, config);
    }

    return errorResponse(404, "not_found_error", `no route for ${request.method} ${url.pathname}`);
  };
}

export interface RunningBridge {
  readonly port: number;
  stop(): Promise<void>;
}

/** Start the bridge on Bun's HTTP server. */
export function startBridge(config: BridgeConfig): RunningBridge {
  const handler = createFetchHandler(config);
  const server = (globalThis as any).Bun.serve({
    port: config.port,
    hostname: config.host ?? "127.0.0.1",
    idleTimeout: 255,
    fetch: handler,
  });
  return {
    port: server.port,
    stop: async () => { await server.stop(true); },
  };
}
