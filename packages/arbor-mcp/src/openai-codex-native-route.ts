/**
 * Uses the operator's first-party Codex CLI login as an inference transport.
 * Codex runs in an empty temporary directory with its config, rules, shell,
 * MCP, app, web, plugin, hook, and multi-agent capabilities disabled. Tool
 * requests are returned as data for the Canopy model adapter to validate and
 * dispatch; the Codex process never executes them.
 */
import { randomUUID } from "node:crypto";
import { withCodexAuthStoreLock } from "./codex-auth-store-lock.js";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { defaultCodexOAuthCredentialPath, resolveCodexOAuthCredential } from "@arbor/config";
import {
  createOpenAICompatibleModelPort,
  type NativeModelAdapterRequest,
  type NativeModelPort,
  type OpenAICompatibleFetch,
} from "@arbor/harness";

const BRIDGE_BASE_URL = "http://arbor-codex-bridge.invalid";
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_CLI_RUNTIME_MS = 5 * 60_000;
const CLI_KILL_GRACE_MS = 2_000;

export interface CodexCliCompletionOptions {
  readonly executable?: string;
  readonly model: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly output_schema: Record<string, unknown>;
  readonly signal: AbortSignal;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type CodexCliCompletionRunner = (options: CodexCliCompletionOptions) => Promise<string>;

/** The exact per-invocation controls that keep Codex in model-only mode. */
export function buildCodexCliArgs(options: {
  readonly model: string;
  readonly cwd: string;
  readonly schema_path: string;
  readonly output_path: string;
}): string[] {
  return [
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--strict-config", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", options.cwd,
    "--model", options.model, "--output-schema", options.schema_path,
    "--output-last-message", options.output_path,
    "-c", "features.shell_tool=false",
    "-c", "features.unified_exec=false",
    "-c", "agents.enabled=false",
    "-c", "features.multi_agent=false",
    "-c", "features.apps=false",
    "-c", "features.remote_plugin=false",
    "-c", "features.web_search=false",
    "-c", "features.hooks=false",
    "-c", "web_search=\"disabled\"",
    "-c", "mcp_servers={}",
    "-c", "plugins={}",
    "-c", "history.persistence=\"none\"",
    "-",
  ];
}

/** Only pass the CLI enough environment to locate the executable and its own sign-in. */
export function codexCliEnvironment(source: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "CODEX_HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"] as const) {
    const value = source[name];
    if (value !== undefined) output[name] = value;
  }
  return output;
}

export function codexCliRuntimeEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  authPath: string,
  isolatedHome: string,
): NodeJS.ProcessEnv {
  return { ...codexCliEnvironment(source), HOME: isolatedHome, CODEX_HOME: dirname(authPath) };
}

export async function assertSecureCodexAuthStore(authPath: string): Promise<void> {
  const homePath = dirname(authPath);
  let home;
  let auth;
  try {
    home = await lstat(homePath);
    auth = await lstat(authPath);
  } catch {
    throw new Error("Codex auth store is unavailable or cannot be inspected safely");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!home.isDirectory() || home.isSymbolicLink() || (uid !== null && home.uid !== uid) || (home.mode & 0o022) !== 0 || (home.mode & 0o300) !== 0o300) {
    throw new Error("Codex CODEX_HOME must be an owned, non-symlink directory without group or other write permission");
  }
  if (!auth.isFile() || auth.isSymbolicLink() || (uid !== null && auth.uid !== uid) || (auth.mode & 0o777) !== 0o600) {
    throw new Error("Codex auth.json must be an owned, non-symlink file with owner read/write and no group or other permissions");
  }
}

interface ChildCompletion { readonly code: number | null; readonly signal: NodeJS.Signals | null }

export function waitForCodexChild(child: ReturnType<typeof spawn>, signal: AbortSignal): Promise<ChildCompletion> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationMessage: string | undefined;
    const finish = (error?: Error, result?: ChildCompletion) => {
      if (settled) return;
      settled = true;
      clearTimeout(runtimeTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (error) reject(error);
      else resolve(result!);
    };
    const terminate = (message: string) => {
      if (settled || terminationMessage !== undefined) return;
      terminationMessage = message;
      try { child.kill("SIGTERM"); } catch { /* continue to bounded escalation */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* close event still determines lock release */ }
        // Keep the auth-store lock until the OS confirms that the writer has
        // exited; releasing it on a timer could race a still-running refresh.
      }, CLI_KILL_GRACE_MS);
    };
    const abort = () => terminate("Codex CLI request was aborted and the process did not exit after termination escalation");
    const onError = () => finish(new Error("Codex CLI could not be started"));
    const onClose = (code: number | null, childSignal: NodeJS.Signals | null) => {
      if (terminationMessage !== undefined) finish(new Error(terminationMessage));
      else finish(undefined, { code, signal: childSignal });
    };
    const runtimeTimer = setTimeout(() => terminate("Codex CLI inference exceeded its bounded runtime and was terminated"), MAX_CLI_RUNTIME_MS);
    child.once("error", onError);
    child.once("close", onClose);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function runCodexCliCompletion(options: CodexCliCompletionOptions): Promise<string> {
  if (options.signal.aborted) throw new Error("Codex CLI request was aborted");
  const scratch = await mkdtemp(join(tmpdir(), "canopy-codex-native-"));
  const isolatedHome = join(scratch, "home");
  await mkdir(isolatedHome, { mode: 0o700 });
  const schemaPath = join(scratch, "output-schema.json");
  const outputPath = join(scratch, "last-message.json");
  try {
    const parentEnv = options.env ?? process.env;
    const configuredAuthPath = defaultCodexOAuthCredentialPath(parentEnv as NodeJS.ProcessEnv);
    await assertSecureCodexAuthStore(configuredAuthPath);
    const auth = resolveCodexOAuthCredential({ env: parentEnv as NodeJS.ProcessEnv });
    if (auth.status.state === "absent" || (auth.status.state === "expired" && auth.status.refreshable !== true)) throw new Error(auth.status.reason);
    if (basename(auth.file_path) !== "auth.json") throw new Error("Codex native auth requires the first-party CODEX_HOME/auth.json file path");
    await writeFile(schemaPath, JSON.stringify(options.output_schema), { encoding: "utf8", mode: 0o600 });
    return await withCodexAuthStoreLock(auth.file_path, options.signal, async () => {
      // Another Canopy invocation may have refreshed auth.json while this call
      // waited. Re-read only after acquiring the cross-process lock.
      await assertSecureCodexAuthStore(auth.file_path);
      const currentAuth = resolveCodexOAuthCredential({ env: parentEnv as NodeJS.ProcessEnv });
      if (currentAuth.status.state === "absent" || (currentAuth.status.state === "expired" && currentAuth.status.refreshable !== true)) throw new Error(currentAuth.status.reason);
      if (currentAuth.file_path !== auth.file_path) throw new Error("Codex auth store changed while waiting for its lock");
      const args = buildCodexCliArgs({ model: options.model, cwd: scratch, schema_path: schemaPath, output_path: outputPath });
      const child = spawn(options.executable ?? "codex", args, {
        cwd: scratch,
        // Keep the real CODEX_HOME so the first-party CLI can durably rotate
        // auth.json. HOME/config remains isolated and config/rules are ignored.
        env: codexCliRuntimeEnvironment(parentEnv, auth.file_path, isolatedHome),
        stdio: ["pipe", "ignore", "pipe"],
      });
      child.stderr.resume();
      const closed = waitForCodexChild(child, options.signal);
      child.stdin.end(options.prompt);
      const result = await closed;
      if (options.signal.aborted) throw new Error("Codex CLI request was aborted");
      if (result.code !== 0) throw new Error(`Codex CLI inference failed (exit=${result.code ?? "unknown"}, signal=${result.signal ?? "none"}); local CLI diagnostics were suppressed`);
      const output = await readFile(outputPath, "utf8");
      if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) throw new Error("Codex CLI output exceeded the configured size limit");
      return output;
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

interface OpenAIChatRequest {
  readonly model?: unknown;
  readonly messages?: unknown;
  readonly tools?: unknown;
  readonly response_format?: unknown;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildPrompt(body: OpenAIChatRequest): { readonly prompt: string; readonly schema: Record<string, unknown>; readonly model: string } {
  if (typeof body.model !== "string" || body.model.trim() === "" || !Array.isArray(body.messages)) throw new Error("Codex native route requires model and messages");
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolNames = tools.flatMap((entry) => object(entry) && object(entry.function) && typeof entry.function.name === "string" ? [entry.function.name] : []);
  const toolCallSchema: Record<string, unknown> = {
    type: "array",
    items: toolNames.length === 0 ? { type: "object", maxProperties: 0 } : {
      type: "object",
      properties: { name: { type: "string", enum: toolNames }, arguments: { type: "object" } },
      required: ["name", "arguments"], additionalProperties: false,
    },
    ...(toolNames.length === 0 ? { maxItems: 0 } : {}),
  };
  const responseFormat = object(body.response_format) && object(body.response_format.json_schema) ? body.response_format.json_schema : null;
  const requestedSchema = responseFormat && object(responseFormat.schema) ? responseFormat.schema : null;
  const schema: Record<string, unknown> = {
    type: "object",
    properties: {
      content: { type: "string" },
      structured_output: requestedSchema === null ? { type: "null" } : { anyOf: [requestedSchema, { type: "null" }] },
      tool_calls: toolCallSchema,
    },
    required: ["content", "structured_output", "tool_calls"],
    additionalProperties: false,
  };
  const prompt = [
    "You are a stateless inference endpoint used by the Canopy native agent harness. Never execute tools or commands.",
    "Return exactly one JSON object matching the required output schema.",
    "For an ordinary answer, set content to the final answer, structured_output to null, and tool_calls to an empty array.",
    "For a structured final answer, set structured_output to the requested schema value and content to its JSON encoding.",
    "When a listed Canopy function should run, return its exact name and JSON arguments in tool_calls, set content to an empty string, and structured_output to null. Canopy will validate and execute the request.",
    `Requested functions: ${JSON.stringify(tools)}`,
    requestedSchema === null ? "No structured-output schema was requested." : `Structured-output schema: ${JSON.stringify(requestedSchema)}`,
    `Conversation: ${JSON.stringify(body.messages)}`,
  ].join("\n\n");
  return { prompt, schema, model: body.model };
}

function sse(body: Record<string, unknown>): Response {
  const id = `chatcmpl-${randomUUID()}`;
  const model = body["model"] as string;
  let completion: Record<string, unknown>;
  try { completion = JSON.parse(String(body["content"] ?? "")) as Record<string, unknown>; }
  catch { throw new Error("Codex CLI output did not match its declared JSON response schema"); }
  const structured = completion["structured_output"];
  const content = structured !== null && structured !== undefined
    ? JSON.stringify(structured)
    : typeof completion["content"] === "string" ? completion["content"] : "";
  const calls = Array.isArray(completion["tool_calls"]) ? completion["tool_calls"] : [];
  const toolCalls = calls.map((entry, index) => {
    if (!object(entry) || typeof entry["name"] !== "string" || !object(entry["arguments"])) throw new Error("Codex CLI returned a malformed Canopy tool request");
    return { index, id: `call_${randomUUID()}`, type: "function", function: { name: entry["name"], arguments: JSON.stringify(entry["arguments"]) } };
  });
  const choice = { index: 0, delta: { ...(content ? { content } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? "tool_calls" : "stop" };
  const chunk = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [choice] };
  const final = { id, object: "chat.completion.chunk", created: chunk.created, model, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] };
  const text = `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`;
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Compose an OpenAI-compatible local boundary around the first-party Codex CLI session. */
export function createOpenAICodexNativeModelPort(options: {
  readonly request: NativeModelAdapterRequest;
  readonly cwd: string;
  readonly executable?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run_completion?: CodexCliCompletionRunner;
}): NativeModelPort {
  if (options.request.provider_id.trim().toLowerCase() !== "openai" || options.request.adapter_id !== "openai-compatible") {
    throw new Error("Codex CLI auth route requires provider_id openai and adapter_id openai-compatible");
  }
  const secret = `bridge-${randomUUID()}`;
  const fetch: OpenAICompatibleFetch = async (_url, init) => {
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });
    if (typeof init?.body !== "string") return new Response("invalid request body", { status: 400 });
    let body: OpenAIChatRequest;
    try { body = JSON.parse(init.body) as OpenAIChatRequest; }
    catch { return new Response("invalid JSON", { status: 400 }); }
    const composed = buildPrompt(body);
    const output = await (options.run_completion ?? runCodexCliCompletion)({
      executable: options.executable,
      model: composed.model,
      cwd: options.cwd,
      prompt: composed.prompt,
      output_schema: composed.schema,
      signal: init.signal ?? new AbortController().signal,
      env: options.env,
    });
    return sse({ model: composed.model, content: output });
  };
  const port = createOpenAICompatibleModelPort({
    ...options.request,
    base_url: BRIDGE_BASE_URL,
    fetch,
    provider_id: options.request.provider_id,
    model_id: options.request.model_id,
    revision: null,
    credential_required: true,
  });
  return Object.freeze({
    get identity() { return port.identity; },
    run: (request: Parameters<NativeModelPort["run"]>[0], _lease: string | null, signal: AbortSignal) => port.run(request, secret, signal),
    ...(port.stream === undefined ? {} : { stream: (request: Parameters<NonNullable<NativeModelPort["stream"]>>[0], _lease: string | null, signal: AbortSignal) => port.stream!(request, secret, signal) }),
    classify_failure: port.classify_failure,
  });
}
