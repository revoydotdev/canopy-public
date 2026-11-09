/**
 * Drives the local `claude` CLI in headless streaming mode and yields the
 * events the OpenAI surface needs: incremental assistant text, then one final
 * usage record.
 *
 * Why the CLI and not an SDK or the raw API: the CLI is the only surface that
 * uses the operator's existing Claude Code subscription auth. Arbor's native
 * transport is otherwise unusable on this machine -- every provider key in
 * `.env` is an empty placeholder, so `loadNativeProviderSecretOverlay` reports
 * `credential_absent` and the doctor demotes the lane to the connector.
 */
import { spawn } from "node:child_process";
import { DENIED_TOOLS } from "./translate.js";
import type { ClaudeUsage } from "./protocol.js";

export type BackendEvent =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "done";
      readonly usage: ClaudeUsage;
      readonly costUsd: number;
      /**
       * With `--json-schema` the CLI never streams the value as text: it
       * arrives only here, as the result frame's `structured_output` (and
       * `result`, its JSON text). Verified against claude 2.1.259 on
       * 2026-09-03. A bridge that forwards text deltas alone therefore
       * answers a structured request with an empty body.
       */
      readonly structuredOutput?: unknown;
      readonly resultText?: string;
    }
  | { readonly kind: "error"; readonly message: string };

export interface BackendOptions {
  readonly model: string;
  readonly prompt: string;
  readonly systemPrompt: string | null;
  readonly maxTokens?: number | undefined;
  /** JSON Schema for structured output, passed to the CLI's own `--json-schema` validator. */
  readonly jsonSchema?: Record<string, unknown> | undefined;
  readonly cwd?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly executable?: string | undefined;
}

export function buildClaudeArgs(options: BackendOptions): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", options.model,
    // A model endpoint must not inherit the agent's tool loop, hooks, project
    // memory, or MCP servers -- they cost tokens and leak the host repo into
    // what should be a stateless completion.
    "--setting-sources", "",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--disallowedTools", DENIED_TOOLS,
    // `--tools ""` (claude >= 2.1) disables the built-in set wholesale; the
    // per-name denial above stays for older CLIs that lack the flag.
    "--tools", "",
  ];
  if (options.systemPrompt !== null) args.push("--system-prompt", options.systemPrompt);
  if (options.jsonSchema !== undefined) args.push("--json-schema", JSON.stringify(options.jsonSchema));
  return args;
}

/**
 * Parse one NDJSON line from `--output-format stream-json`.
 *
 * Only two event shapes matter. `stream_event` frames carry Anthropic-native
 * content-block deltas, of which we forward `text_delta` and deliberately drop
 * `thinking_delta` -- reasoning tokens are not assistant content, and emitting
 * them would corrupt a structured-output response. The terminal `result` frame
 * carries authoritative usage and cost.
 */
export function parseBackendLine(line: string): BackendEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let event: Record<string, any>;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (event["type"] === "stream_event") {
    const delta = event["event"]?.delta;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return { kind: "text", text: delta.text };
    }
    return null;
  }
  if (event["type"] === "result") {
    if (event["is_error"] === true || event["subtype"] !== "success") {
      const detail = typeof event["result"] === "string" && event["result"] !== ""
        ? event["result"]
        : String(event["subtype"] ?? "unknown error");
      return { kind: "error", message: `claude CLI returned ${detail}` };
    }
    return {
      kind: "done",
      usage: (event["usage"] ?? {}) as ClaudeUsage,
      costUsd: typeof event["total_cost_usd"] === "number" ? event["total_cost_usd"] : 0,
      ...(event["structured_output"] === undefined ? {} : { structuredOutput: event["structured_output"] }),
      ...(typeof event["result"] === "string" ? { resultText: event["result"] } : {}),
    };
  }
  return null;
}

/** Spawn the CLI and yield backend events as they arrive. */
export async function* runClaude(options: BackendOptions): AsyncGenerator<BackendEvent> {
  const child = spawn(options.executable ?? "claude", buildClaudeArgs(options), {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    // The CLI has no --max-tokens flag; its output ceiling is this variable.
    // A caller's `max_tokens` would otherwise be silently ignored, and a
    // critic that narrates before its structured call was cut off at the
    // CLI's own ceiling with no value at all (pilot run 3, 2026-09-03).
    env: options.maxTokens === undefined ? process.env : { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxTokens) },
  });

  const abort = () => child.kill("SIGTERM");
  options.signal?.addEventListener("abort", abort, { once: true });

  child.stdin.end(options.prompt);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (piece: string) => { stderr += piece; });

  const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));

  let buffer = "";
  let sawTerminal = false;
  try {
    child.stdout.setEncoding("utf8");
    for await (const piece of child.stdout as AsyncIterable<string>) {
      buffer += piece;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const parsed = parseBackendLine(line);
        if (parsed !== null) {
          if (parsed.kind !== "text") sawTerminal = true;
          yield parsed;
        }
        newline = buffer.indexOf("\n");
      }
    }
    const tail = parseBackendLine(buffer);
    if (tail !== null) {
      sawTerminal = sawTerminal || tail.kind !== "text";
      yield tail;
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }

  const code = await exited;
  if (!sawTerminal) {
    yield {
      kind: "error",
      message: `claude CLI exited ${code} without a result frame${stderr.trim() === "" ? "" : `: ${stderr.trim().slice(0, 500)}`}`,
    };
  }
}
