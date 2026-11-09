/**
 * Structured-transport LoopExecutor — Stage 0 of
 * docs/full-harness-ownership-brief.md §5: drive `opencode serve`'s HTTP API
 * instead of shelling out to `opencode run` and scraping stdout.
 *
 * Verified live against opencode 1.18.10's `serve` (manual curl session,
 * 2026-08-04 — see the Stage 0 dispatch report; not exercised by the vitest
 * suite, which stays hermetic/no-network per this package's existing
 * convention):
 *   - `POST /session/{id}/message` (`session.prompt`) returns
 *     `info.tokens: {input,output,reasoning,cache:{read,write}}` and
 *     `info.cost` — real, provider-observed usage. No more
 *     `{ kind: "unavailable" }` for calls made through this transport.
 *   - Passing `format: {type:"json_schema", schema}` makes the SERVER itself
 *     validate (and, per `retryCount`, retry) the model's answer against a
 *     JSON Schema before returning; the validated value comes back on
 *     `info.structured`. No brace-scraping, no ANSI stripping, no
 *     approval-biased fallback — the critic verdict is typed data, not text
 *     recovered from a terminal transcript.
 *   - The `directory` query param scopes a session's tool calls (bash, edit,
 *     …) to a given path, confirmed with a live `pwd` round-trip — one server
 *     process can serve every worktree a campaign opens, rather than a new
 *     `opencode run` subprocess per dispatch.
 *
 * The subprocess executor (opencode-executor.ts) is untouched and remains the
 * default; this is an addition, selected explicitly by the caller (see
 * `demo.ts`'s `--transport` flag / `ARBOR_OPENCODE_TRANSPORT` env var).
 *
 * No new runtime dependency: this talks to `opencode serve` with the
 * platform's native `fetch` and a plain `spawn`, not the `@opencode-ai/sdk`
 * package.
 */
import { spawn } from "node:child_process";
import type { LoopExecutor, LoopEvent, SpecialistResult, CriticResult } from "@arbor/opencode";
import { FAULT_MATRIX } from "@arbor/opencode";
import type { CriticCheck, CriticVerdict, NodeError, Provenance, TokenUsage } from "@arbor/core";
import { AGENT_PROMPTS } from "@arbor/prompts";
import type { RuntimePortAdapter, DevtoolsStreamLine } from "./tui-adapter.js";
import {
  DEFAULT_SPECIALIST_MODEL,
  DEFAULT_CRITIC_MODEL,
  rawResponseHash,
  runVerification,
  captureWorktreeDiff,
  captureWorktreeChanges,
  type ParsedCriticVerdict,
} from "./opencode-executor.js";

/**
 * Classify a failed HTTP/process interaction with `opencode serve` into the
 * closed `NodeError` union (G-08's HTTP-transport equivalent of
 * `classifyOpenCodeError` in opencode-executor.ts). Before this, every
 * failure shape here — a 429, a 5xx, a dropped connection, a server that
 * never came up — collapsed into an unstructured string glued onto
 * `rationale`/`output`; none of it reached the typed union.
 *
 * Genuine external cancellation is excluded: `postJson` only ever produces
 * the exact suffix "call aborted" when the caller's own `AbortSignal` was
 * already aborted, and the loop's `throwIfAborted` already turns that into
 * the campaign's cancellation report.
 */
export function classifyOpenCodeServerError(error: string): NodeError | undefined {
  if (error.endsWith("call aborted")) return undefined;
  const provenance: Provenance = { tag: "claimed", claimant: "opencode-server-executor" };

  const timeoutFields = (elapsed_ms: number) => ({
    elapsed_ms,
    partial_output: null,
    usage: { kind: "unavailable" as const, reason: "opencode server transport was killed on timeout before usage was reported" },
  });
  const listeningMatch = error.match(/did not report listening within (\d+)ms/);
  if (listeningMatch) {
    return { kind: "timeout", provenance, message: error, ...timeoutFields(Number(listeningMatch[1])) };
  }
  const httpStatus = error.match(/^HTTP (\d+):/);
  if (httpStatus) {
    const status = Number(httpStatus[1]);
    if (status === 429) return { kind: "quota_exceeded", provenance, message: error };
    if (status === 408) return { kind: "timeout", provenance, message: error, ...timeoutFields(0) };
    if (status >= 500) return { kind: "transport_error", recoverable: FAULT_MATRIX.transport_error.recovery === "retry", provenance, message: error };
    return { kind: "internal_error", recoverable: FAULT_MATRIX.internal_error.recovery === "retry", provenance, message: error };
  }
  if (error.startsWith("fetch failed:")) {
    // Our own `timeoutMs` elapsed (the internal `controller.abort()` fired,
    // not the caller's signal — that case already returned above) versus a
    // genuine network-layer failure.
    return /abort/i.test(error)
      ? { kind: "timeout", provenance, message: error, ...timeoutFields(0) }
      : { kind: "transport_error", recoverable: FAULT_MATRIX.transport_error.recovery === "retry", provenance, message: error };
  }
  if (error === "empty response body" || error.startsWith("non-JSON response:")) {
    return { kind: "transport_error", recoverable: FAULT_MATRIX.transport_error.recovery === "retry", provenance, message: error };
  }
  if (error.startsWith("opencode serve spawn failed:") || /^opencode serve exited \d+ before it reported listening/.test(error)) {
    return { kind: "internal_error", recoverable: FAULT_MATRIX.internal_error.recovery === "retry", provenance, message: error };
  }
  return { kind: "internal_error", recoverable: false, provenance, message: error };
}

export { DEFAULT_SPECIALIST_MODEL, DEFAULT_CRITIC_MODEL };

export interface OpenCodeServerLoopExecutorOptions {
  /** Specialist model (OpenRouter by default — reuse its configured key). */
  specialistModel?: string;
  /** Critic model (Z.AI by default — reuse its configured key). */
  criticModel?: string;
  /** Path to the opencode binary. Default "opencode". */
  opencodeBin?: string;
  /** Per-call timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /** How long to wait for `opencode serve` to report it is listening. Default 15_000. */
  startupTimeoutMs?: number;
  /**
   * Optional verification command run in the worktree after a specialist. If it
   * exits 0, provenance is `!verified` (honest — evidence actually ran).
   */
  verificationCmd?: string;
  /**
   * Use an already-running server instead of spawning one. Set by tests (a
   * fake HTTP server) and by callers that want to share one long-lived
   * `opencode serve` across a whole campaign.
   */
  baseUrl?: string;
  /** Injectable fetch — defaults to the platform global. Tests stub this. */
  fetchImpl?: typeof fetch;
  /** Hostname to bind when spawning. Default "127.0.0.1". */
  hostname?: string;
  /** Port to bind when spawning. Default 0 (ephemeral — avoids port clashes). */
  port?: number;
}

// ============================================================
// JSON SCHEMA the critic verdict is constrained to. The server validates
// (and retries on failure) against this — see prompt.ts's
// STRUCTURED_OUTPUT_SYSTEM_PROMPT / toolChoice: "required" path.
// ============================================================
const CRITIC_VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    rationale: { type: "string" },
    root_cause: { type: "string" },
    measurement_validated: { type: "boolean" },
    guardrails_enforced: { type: "boolean" },
    introspection_passed: { type: "boolean" },
    stability_ok: { type: "boolean" },
    checks: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          name: { type: "string", enum: ["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"] },
          passed: { type: "boolean" },
          detail: { type: "string" },
        },
        required: ["name", "passed", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: ["approved", "rationale", "measurement_validated", "guardrails_enforced", "introspection_passed", "stability_ok", "checks"],
  additionalProperties: false,
} as const;

/** Split "provider/model/with/slashes" into { providerID, modelID } on the first slash. */
export function splitModelId(model: string): { providerID: string; modelID: string } {
  const idx = model.indexOf("/");
  if (idx < 0) return { providerID: model, modelID: model };
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

/** Map opencode's wire token shape onto the ledger's `TokenUsage`. Reasoning
 * tokens are folded into `output_tokens`: providers bill them as generated
 * output and `TokenUsage` has no separate slot for them. */
export function toTokenUsage(tokens: OpenCodeTokens): TokenUsage {
  return {
    input_tokens: tokens.input,
    output_tokens: tokens.output + tokens.reasoning,
    cached_input_tokens: tokens.cache.read,
    cache_write_input_tokens: tokens.cache.write,
    counter_source: "provider_counter",
  };
}

/** Read a structured critic verdict off `info.structured` — server-validated, not parsed. */
export function parseStructuredVerdict(structured: unknown, fallbackRaw: string, critic = "lenticel"): ParsedCriticVerdict {
  if (
    typeof structured === "object" &&
    structured !== null &&
    typeof (structured as Record<string, unknown>).approved === "boolean" &&
    typeof (structured as Record<string, unknown>).rationale === "string"
  ) {
    const s = structured as Record<string, unknown>;
    const names = ["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"] as const;
    if (!String(s.rationale).trim() || typeof s.measurement_validated !== "boolean" || typeof s.guardrails_enforced !== "boolean"
      || typeof s.introspection_passed !== "boolean" || typeof s.stability_ok !== "boolean"
      || !Array.isArray(s.checks) || s.checks.length !== names.length) return { kind: "unparseable", raw_hash: rawResponseHash(fallbackRaw) };
    const checks: CriticCheck[] = [];
    const seen = new Set<string>();
    for (const rawCheck of s.checks) {
      if (typeof rawCheck !== "object" || rawCheck === null) return { kind: "unparseable", raw_hash: rawResponseHash(fallbackRaw) };
      const check = rawCheck as Record<string, unknown>;
      if (!names.includes(check.name as typeof names[number]) || seen.has(check.name as string) || typeof check.passed !== "boolean"
        || typeof check.detail !== "string" || !check.detail.trim()) return { kind: "unparseable", raw_hash: rawResponseHash(fallbackRaw) };
      seen.add(check.name as string);
      checks.push({ name: check.name as CriticCheck["name"], passed: check.passed, detail: check.detail });
    }
    if (seen.size !== names.length || (s.approved === false && (typeof s.root_cause !== "string" || !s.root_cause.trim()))) {
      return { kind: "unparseable", raw_hash: rawResponseHash(fallbackRaw) };
    }
    const verdict: CriticVerdict = {
      approved: s.approved as boolean,
      critic,
      rationale: s.rationale as string,
      root_cause: typeof s.root_cause === "string" && s.root_cause.trim() ? s.root_cause : undefined,
      measurement_validated: s.measurement_validated as boolean,
      guardrails_enforced: s.guardrails_enforced as boolean,
      introspection_passed: s.introspection_passed as boolean,
      stability_ok: s.stability_ok as boolean,
      checks,
    };
    return {
      kind: "verdict",
      verdict,
    };
  }
  return { kind: "unparseable", raw_hash: rawResponseHash(fallbackRaw) };
}

// ============================================================
// WIRE TYPES — the slice of opencode's OpenAPI schema this transport reads.
// ============================================================
interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}
interface OpenCodeAssistantMessageInfo {
  id?: string;
  sessionID?: string;
  tokens?: OpenCodeTokens;
  cost?: number;
  structured?: unknown;
  finish?: string;
  error?: unknown;
}
interface OpenCodeMessagePart {
  type: string;
  text?: string;
}
interface OpenCodeMessageResponse {
  info: OpenCodeAssistantMessageInfo;
  parts: OpenCodeMessagePart[];
}
interface OpenCodeSession {
  id: string;
  directory?: string;
}

function extractText(parts: OpenCodeMessagePart[] | undefined): string {
  return (parts ?? []).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

// ============================================================
// SERVER LIFECYCLE — spawn `opencode serve` once, reuse across dispatches.
// ============================================================
interface ServerHandle {
  baseUrl: string;
  close(): void;
}

function spawnServer(opencodeBin: string, hostname: string, port: number, timeoutMs: number): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(opencodeBin, ["serve", `--hostname=${hostname}`, `--port=${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`opencode serve did not report listening within ${timeoutMs}ms. Output: ${output.slice(0, 500)}`));
    }, timeoutMs);
    const onData = (d: Buffer): void => {
      if (settled) return;
      output += String(d);
      const match = output.match(/opencode server listening on\s+(https?:\/\/\S+)/);
      if (match) {
        settled = true;
        clearTimeout(timer);
        resolve({
          baseUrl: match[1]!,
          close: () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } },
        });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (d) => { output += String(d); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`opencode serve spawn failed: ${e.message}`));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`opencode serve exited ${code} before it reported listening. Output: ${output.slice(0, 500)}`));
    });
    // Best-effort: don't leak a long-lived opencode process past our own exit.
    process.once("exit", () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  });
}

/**
 * Lazily start (or reuse) the backing `opencode serve` process for this
 * executor instance, and expose a matching `closeServer` so the caller can
 * release it.
 *
 * Root cause of the `--transport server` hang (2026-08-08): `getServer()`
 * used to be the ONLY thing this module exposed. `createOpenCodeServerLoopExecutor`
 * had no `close`/dispose member on its returned `LoopExecutor`, so the sole
 * caller (`runOneCampaign` in demo.ts) had no handle to release, ever — not
 * on success, not on error, not on abort. A `spawn()`'d child that is never
 * `.kill()`'d is an active libuv handle (`ProcessWrap`) plus its stdout/
 * stderr `PipeWrap`s; Node will not empty its event loop while those exist,
 * so the process (which exits via `process.exitCode`, never `process.exit()`
 * — see cli.ts's `main().then((code) => { process.exitCode = code; })`)
 * never exits on its own. The `process.once("exit", ...)` last-resort kill in
 * `spawnServer` below never fires either, because "exit" itself never fires
 * while the child keeps the loop alive — hang and leaked-process were one
 * causal loop, not two independent defects. Verified with a bounded, no-real-`opencode`
 * repro: a `spawn()`'d child left open kept a bare script alive for its full
 * lifetime with no work scheduled; killing it let the script exit in <1s.
 */
function makeServerProvider(
  options: OpenCodeServerLoopExecutorOptions,
): { getServer: () => Promise<ServerHandle>; closeServer: () => Promise<void> } {
  let handle: Promise<ServerHandle> | undefined;
  const getServer = (): Promise<ServerHandle> => {
    if (options.baseUrl) return Promise.resolve({ baseUrl: options.baseUrl, close: () => {} });
    if (!handle) {
      handle = spawnServer(
        options.opencodeBin ?? "opencode",
        options.hostname ?? "127.0.0.1",
        options.port ?? 0,
        options.startupTimeoutMs ?? 15_000,
      );
    }
    return handle;
  };
  const closeServer = async (): Promise<void> => {
    // Nothing was ever spawned (specialize/review never ran, or every call
    // failed before getServer() resolved) — nothing to release.
    if (!handle) return;
    try {
      const server = await handle;
      server.close();
    } catch {
      // getServer() rejected (spawn failed / startup timed out) — the child
      // is already gone or was never fully up; nothing to release.
    }
  };
  return { getServer, closeServer };
}

// ============================================================
// HTTP HELPERS
// ============================================================
type HttpResult<T> = { ok: true; body: T } | { ok: false; error: string };

async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<HttpResult<T>> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 500)}` };
    if (!text) return { ok: false, error: "empty response body" };
    try {
      return { ok: true, body: JSON.parse(text) as T };
    } catch {
      return { ok: false, error: `non-JSON response: ${text.slice(0, 300)}` };
    }
  } catch (e) {
    const aborted = signal?.aborted;
    return { ok: false, error: aborted ? "opencode-server-executor call aborted" : `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const ALLOW_ALL_PERMISSION = [{ permission: "*", pattern: "*", action: "allow" as const }];

/**
 * Build a LoopExecutor whose specialize + review call `opencode serve` over
 * HTTP, returning typed usage and a typed verdict instead of stdout text.
 */
export function createOpenCodeServerLoopExecutor(
  adapter: RuntimePortAdapter,
  devtoolsHook: (loop: unknown) => void,
  campaignId: string,
  options: OpenCodeServerLoopExecutorOptions = {},
): LoopExecutor & { close(): Promise<void> } {
  const specialistModel = options.specialistModel ?? DEFAULT_SPECIALIST_MODEL;
  const criticModel = options.criticModel ?? DEFAULT_CRITIC_MODEL;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const verificationCmd = options.verificationCmd;
  const fetchImpl = options.fetchImpl ?? fetch;
  const { getServer, closeServer } = makeServerProvider(options);

  const log = (event: LoopEvent): void => {
    devtoolsHook(event);
    const line: DevtoolsStreamLine = {
      seq: 0,
      ts: new Date().toISOString(),
      event_kind: `loop.${event.type}`,
      campaign_id: campaignId,
      node_id:
        "node_id" in event && typeof event.node_id === "string"
          ? event.node_id
          : "parent_id" in event && typeof event.parent_id === "string"
            ? event.parent_id
            : null,
      node_state: undefined,
      synthetic: false,
    };
    adapter.pushDevtoolsLine(line);
  };

  const noUsage = (reason: string) => ({ kind: "unavailable" as const, reason });

  const createSession = (baseUrl: string, directory: string | undefined, permission?: typeof ALLOW_ALL_PERMISSION) =>
    postJson<OpenCodeSession>(
      fetchImpl,
      `${baseUrl}/session${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`,
      permission ? { permission } : {},
      undefined,
      timeoutMs,
    );

  return {
    async specialize(params): Promise<SpecialistResult> {
      const hasWorktree = Boolean(params.worktree_path && params.worktree_path.length > 0);
      const botanicalPrompt = AGENT_PROMPTS[params.specialist_agent as keyof typeof AGENT_PROMPTS];
      const baseInstruction = botanicalPrompt
        ? `${botanicalPrompt()}\n\nTask context follows.`
        : "You are a specialist in revoy2. Read the task below.";
      const instruction = hasWorktree
        ? `${baseInstruction} You are working in an isolated git worktree at ${params.worktree_path}. Make the necessary file changes to complete the task. Use the edit/write/bash tools as needed. Output ONLY a summary of what you changed.\n\n${params.prompt}`
        : `${baseInstruction} Produce your deliverable (a plan/answer/summary). Do NOT modify or execute files. Output ONLY your deliverable text.\n\n${params.prompt}`;

      const { providerID, modelID } = splitModelId(specialistModel);
      const t0 = Date.now();

      let server: ServerHandle;
      try {
        server = await getServer();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const classified = classifyOpenCodeServerError(message);
        return {
          output: `[opencode-server error] ${message}`,
          provenance: { tag: "claimed", claimant: params.specialist_agent },
          token_usage: noUsage("opencode-server-executor: server failed to start; no message was ever sent"),
          ...(classified ? { error: classified } : {}),
        };
      }

      const sessionRes = await createSession(
        server.baseUrl,
        hasWorktree ? params.worktree_path : undefined,
        hasWorktree ? ALLOW_ALL_PERMISSION : undefined,
      );
      if (!sessionRes.ok) {
        const classified = classifyOpenCodeServerError(sessionRes.error);
        return {
          output: `[opencode-server error] session create failed: ${sessionRes.error}`,
          provenance: { tag: "claimed", claimant: params.specialist_agent },
          token_usage: noUsage("opencode-server-executor: session creation failed before any message was sent"),
          ...(classified ? { error: classified } : {}),
        };
      }

      const msgRes = await postJson<OpenCodeMessageResponse>(
        fetchImpl,
        `${server.baseUrl}/session/${sessionRes.body.id}/message`,
        {
          model: { providerID, modelID },
          parts: [{ type: "text", text: instruction }],
        },
        params.signal,
        timeoutMs,
      );
      const durationMs = Date.now() - t0;
      const output = msgRes.ok ? extractText(msgRes.body.parts).trim() : `[opencode-server error] ${msgRes.error}`;

      adapter.pushDevtoolsLine({
        seq: 0, ts: new Date().toISOString(),
        event_kind: "loop.tool_call",
        campaign_id: campaignId, node_id: params.node_id,
        synthetic: false,
        loop_event: {
          type: "tool_call",
          tool: "opencode.serve.session.prompt",
          args: `${params.specialist_agent} · ${specialistModel}`,
          ok: msgRes.ok,
          duration_ms: durationMs,
          stdout: output.slice(0, 300),
        } as never,
      });

      let changedFiles: SpecialistResult["changed_files"] = [];
      if (hasWorktree && params.worktree_path) {
        const [diff, changes] = await Promise.all([
          captureWorktreeDiff(params.worktree_path, timeoutMs),
          captureWorktreeChanges(params.worktree_path, timeoutMs),
        ]);
        changedFiles = changes.ok ? changes.files : [];
        if (diff.ok) {
          adapter.pushDevtoolsLine({
            seq: 0, ts: new Date().toISOString(),
            event_kind: "loop.diff",
            campaign_id: campaignId, node_id: params.node_id,
            synthetic: false,
            loop_event: {
              type: "diff",
              path: diff.paths.join(", "),
              additions: diff.additions,
              deletions: diff.deletions,
              diff: diff.text,
            } as never,
          });
        }
      }

      adapter.pushDevtoolsLine({
        seq: 0, ts: new Date().toISOString(),
        event_kind: "loop.inference_trace",
        campaign_id: campaignId, node_id: params.node_id,
        synthetic: false,
        loop_event: {
          type: "inference_trace",
          phase: "specialist",
          model: specialistModel,
          agent: params.specialist_agent,
          duration_ms: durationMs,
          ok: msgRes.ok,
          prompt_length: params.prompt.length,
          response_length: msgRes.ok ? output.length : 0,
          response_preview: output.slice(0, 500),
          response_full: output,
        } as never,
      });

      let provenance: Provenance;
      let verificationEvidence: string | undefined;
      if (verificationCmd && hasWorktree) {
        const verified = await runVerification(verificationCmd, params.worktree_path, timeoutMs);
        provenance = verified.ok
          ? { tag: "verified", cmd: verificationCmd, exit: 0, stdout_hash: verified.stdout_hash, check: { kind: "shell_command", breadth: "single" } }
          : { tag: "claimed", claimant: params.specialist_agent };
        if (verified.ok) verificationEvidence = `${verified.stdout}\nexit code 0`;
      } else {
        provenance = { tag: "claimed", claimant: params.specialist_agent };
      }

      const tokens = msgRes.ok ? msgRes.body.info.tokens : undefined;
      const specializeError = msgRes.ok ? undefined : classifyOpenCodeServerError(msgRes.error);
      return {
        output: output || `(no output from ${specialistModel})`,
        provenance,
        model_identity: specialistModel,
        ...(verificationEvidence === undefined ? {} : { verification_evidence: verificationEvidence }),
        token_usage: tokens
          ? toTokenUsage(tokens)
          : noUsage(
              msgRes.ok
                ? "opencode-server-executor: server response carried no tokens field"
                : `opencode-server-executor: dispatch failed (${msgRes.error})`,
            ),
        ...(changedFiles.length === 0 ? {} : { changed_files: changedFiles }),
        ...(specializeError ? { error: specializeError } : {}),
      };
    },

    async review(params): Promise<CriticResult> {
      const instruction =
        "You are Lenticel, an APPROVAL-BIASED critic in revoy2. Review the specialist output and task below. " +
        "Reject only verified blockers.\n\n" + params.prompt;
      const { providerID, modelID } = splitModelId(criticModel);
      const t0 = Date.now();

      let server: ServerHandle;
      try {
        server = await getServer();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const reason = `opencode-server-executor: server failed to start (${message})`;
        const classified = classifyOpenCodeServerError(message);
        return {
          approved: false,
          rationale: `Critic dispatch failed before any message was sent: ${reason}`,
          root_cause: classified ? classified.kind : "opencode_server_unavailable",
          critic_agent: "lenticel",
          measurement_validated: false,
          token_usage: noUsage(reason),
          model_identity: criticModel,
          ...(classified ? { error: classified } : {}),
        };
      }

      const sessionRes = await createSession(server.baseUrl, undefined);
      if (!sessionRes.ok) {
        const reason = `opencode-server-executor: session creation failed (${sessionRes.error})`;
        const classified = classifyOpenCodeServerError(sessionRes.error);
        return {
          approved: false,
          rationale: `Critic dispatch failed: ${reason}`,
          root_cause: classified ? classified.kind : "opencode_server_session_failed",
          critic_agent: "lenticel",
          measurement_validated: false,
          token_usage: noUsage(reason),
          model_identity: criticModel,
          ...(classified ? { error: classified } : {}),
        };
      }

      const msgRes = await postJson<OpenCodeMessageResponse>(
        fetchImpl,
        `${server.baseUrl}/session/${sessionRes.body.id}/message`,
        {
          model: { providerID, modelID },
          parts: [{ type: "text", text: instruction }],
          format: { type: "json_schema", schema: CRITIC_VERDICT_JSON_SCHEMA },
        },
        params.signal,
        timeoutMs,
      );
      const durationMs = Date.now() - t0;
      const rawText = msgRes.ok ? extractText(msgRes.body.parts) : msgRes.error;

      adapter.pushDevtoolsLine({
        seq: 0, ts: new Date().toISOString(),
        event_kind: "loop.tool_call",
        campaign_id: campaignId, node_id: params.node_id,
        synthetic: false,
        loop_event: {
          type: "tool_call",
          tool: "opencode.serve.session.prompt",
          args: `lenticel · ${criticModel}`,
          ok: msgRes.ok,
          duration_ms: durationMs,
          stdout: rawText.slice(0, 300),
        } as never,
      });

      adapter.pushDevtoolsLine({
        seq: 0, ts: new Date().toISOString(),
        event_kind: "loop.inference_trace",
        campaign_id: campaignId, node_id: params.node_id,
        synthetic: false,
        loop_event: {
          type: "inference_trace",
          phase: "critic",
          model: criticModel,
          agent: "lenticel",
          duration_ms: durationMs,
          ok: msgRes.ok,
          prompt_length: params.prompt.length,
          response_length: rawText.length,
          response_preview: rawText.slice(0, 500),
        } as never,
      });

      const tokens = msgRes.ok ? msgRes.body.info.tokens : undefined;
      const tokenUsage = tokens
        ? toTokenUsage(tokens)
        : noUsage(
            msgRes.ok
              ? "opencode-server-executor: server response carried no tokens field"
              : `opencode-server-executor: dispatch failed (${msgRes.error})`,
          );

      if (!msgRes.ok) {
        // Fail closed (G-15): a failed dispatch is absence of evidence, not
        // approval — same rule the subprocess transport follows.
        const classified = classifyOpenCodeServerError(msgRes.error);
        return {
          approved: false,
          rationale: `Critic dispatch failed: ${msgRes.error}`,
          root_cause: classified ? classified.kind : "opencode_server_dispatch_failed",
          critic_agent: "lenticel",
          measurement_validated: false,
          token_usage: tokenUsage,
          model_identity: criticModel,
          ...(classified ? { error: classified } : {}),
        };
      }

      const verdict = parseStructuredVerdict(msgRes.body.info.structured, rawText, "lenticel");
      if (verdict.kind === "verdict") {
        return {
          approved: verdict.verdict.approved,
          rationale: verdict.verdict.rationale,
          root_cause: verdict.verdict.root_cause,
          critic_agent: "lenticel",
          measurement_validated: verdict.verdict.measurement_validated,
          verdict: verdict.verdict,
          token_usage: tokenUsage,
          model_identity: criticModel,
        };
      }
      // The server enforces the JSON Schema server-side (with retries), so
      // this path should be rare — reached only if the model still produced
      // nothing that type-checks after retries. Fail closed exactly as the
      // subprocess transport does.
      return {
        approved: false,
        rationale: `Critic verdict unparseable (raw response ${verdict.raw_hash}): server returned no valid structured output`,
        root_cause: "unparseable_critic_verdict",
        critic_agent: "lenticel",
        measurement_validated: false,
        token_usage: tokenUsage,
        model_identity: criticModel,
      };
    },

    log,

    /**
     * Release the backing `opencode serve` child, if one was ever spawned.
     * The caller (`runOneCampaign` in demo.ts) MUST call this once the
     * campaign settles — success, error, or abort — or the child keeps the
     * event loop alive forever (see the block comment on `makeServerProvider`
     * above). A no-op when `baseUrl` was injected (test/shared-server mode:
     * this executor doesn't own that process's lifecycle) or when no
     * specialize/review call ever ran.
     */
    close: closeServer,
  };
}
