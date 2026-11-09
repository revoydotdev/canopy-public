import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorDescriptor } from "@arbor/harness";
import type { CampaignHarnessIntegration } from "../campaign-harness-integration.js";
import { trackChild } from "../child-registry.js";
import { NATIVE_CRITIC_VERDICT_SCHEMA } from "../native-critic-contract.js";
import { NATIVE_TASK_PLAN_SCHEMA } from "../native-task-plan-contract.js";
import {
  createClaudeCodeCampaignIntegration,
  createClaudeCodeHarnessConnectorDescriptor,
  createClaudeCodeTaskPlanner,
  type ClaudeCodeCall,
  type ClaudeCodeCallResult,
  type ClaudeCodeCampaignOptions,
  type ClaudeCodeTaskPlannerOptions,
} from "./claude-code-campaign.js";
import {
  admitRepoFlightProviderLaunch,
  boundedHookReason,
  repoFlightProviderLaunchContext,
  reportRepoFlightProviderError,
  type RepoFlightProviderChildContext,
  type RepoFlightProviderLifecycleHook,
} from "./repo-flight-provider-hook.js";

export const CODEX_HARNESS_CONNECTOR_ID = "codex-cli";

const MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MODEL = "default";
const TERMINATION_GRACE_MS = 100;
const TERMINATION_FINAL_FALLBACK_MS = 1_000;
type CodexUsage = Extract<ClaudeCodeCallResult, { readonly ok: true }>["usage"];
const CODEX_ENV_ALLOWLIST = [
  "PATH", "HOME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "USER", "LOGNAME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "OPENAI_API_KEY",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
] as const;

export interface CodexCampaignOptions {
  readonly codex_bin?: string;
  /** Optional fixed arguments for an operator-owned wrapper binary. */
  readonly codex_args?: readonly string[];
  readonly model?: string;
  readonly timeout_ms?: number;
  readonly max_output_bytes?: number;
  readonly specialist_verification?: ClaudeCodeCampaignOptions["specialist_verification"];
  /**
   * PERF: same single-call native critic fast path claude-code-campaign.ts
   * wires (see `native-critic-transport.ts`); forwarded unchanged into
   * `createClaudeCodeCampaignIntegration`, which already gates it on
   * `ARBOR_CRITIC_TRANSPORT=native` and `.ready` with fallback-on-error.
   */
  readonly native_critic?: ClaudeCodeCampaignOptions["native_critic"];
  /** Optional, fail-closed Repo Flight Control child lifecycle seam. */
  readonly repo_flight_hook?: RepoFlightProviderLifecycleHook;
}

export type CodexTaskPlannerOptions = Omit<ClaudeCodeTaskPlannerOptions, "claude_bin" | "claude_args" | "model" | "timeout_ms" | "run"> & CodexCampaignOptions;

function unavailableUsage(reason: string): ClaudeCodeCallResult {
  return { ok: false, error: reason };
}

function codexEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function boundedUsage(value: unknown): CodexUsage {
  if (typeof value !== "object" || value === null) return { kind: "unavailable", reason: "Codex did not emit token usage" };
  const usage = value as Record<string, unknown>;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const cached = usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_write_input_tokens ?? usage.cache_creation_input_tokens ?? 0;
  if (![input, output, cached, written].every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)) {
    return { kind: "unavailable", reason: "Codex emitted incomplete token usage" };
  }
  return { input_tokens: input as number, output_tokens: output as number, cached_input_tokens: cached as number, cache_write_input_tokens: written as number, counter_source: "provider_counter" };
}

function parseCodexJsonl(stdout: string): ClaudeCodeCallResult {
  let sessionId: string | null = null;
  let text: string | null = null;
  let usage: CodexUsage = { kind: "unavailable", reason: "Codex did not emit token usage" };
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return unavailableUsage("Codex emitted no JSONL events");
  for (const line of lines) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { return unavailableUsage("Codex emitted malformed JSONL"); }
    if (typeof event !== "object" || event === null) return unavailableUsage("Codex emitted a non-object JSONL event");
    const record = event as Record<string, unknown>;
    if (record.type === "thread.started" && typeof record.thread_id === "string" && record.thread_id.trim().length > 0) sessionId = record.thread_id;
    if (record.type === "item.completed" && typeof record.item === "object" && record.item !== null) {
      const item = record.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") text = item.text;
    }
    if (record.type === "turn.completed") usage = boundedUsage(record.usage);
  }
  if (text === null) return unavailableUsage("Codex emitted no completed agent message");
  return { ok: true, text, usage, session_id: sessionId };
}

function schemaFor(mode: ClaudeCodeCall["mode"]): Record<string, unknown> | null {
  if (mode === "planner") return NATIVE_TASK_PLAN_SCHEMA.schema;
  if (mode === "critic") return NATIVE_CRITIC_VERDICT_SCHEMA.schema;
  return null;
}

function boundedDiagnostic(code: number | null, stdout: string, stderr: string): string {
  const detail = stderr.trim() || stdout.trim();
  return detail.length > 0 ? `Codex exited ${code}: ${detail.slice(0, 500)}` : `Codex exited ${code} with no stdout or stderr output`;
}

/**
 * Owns one non-interactive Codex invocation. Prompt bytes always travel on
 * stdin, never through a shell or an argv interpolation path. The documented
 * `--ignore-*` switches and explicit sandbox keep repository/user ambient
 * configuration from widening the governed capability grant.
 */
export function createCodexCodeRunner(options: CodexCampaignOptions = {}): (input: ClaudeCodeCall) => Promise<ClaudeCodeCallResult> {
  const codexBin = options.codex_bin ?? "codex";
  const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.max_output_bytes ?? MAX_OUTPUT_BYTES;
  return async (input) => {
    const flightContext = repoFlightProviderLaunchContext("codex", input);
    try {
      await admitRepoFlightProviderLaunch(options.repo_flight_hook, flightContext);
    } catch (error) {
      const reason = boundedHookReason(error instanceof Error ? error.message : "provider launch admission failed");
      const notificationError = await reportRepoFlightProviderError(options.repo_flight_hook, { ...flightContext, stage: "pre_launch", pid: null, error: reason });
      return { ok: false, error: `Codex flight admission refused: ${reason}${notificationError === null ? "" : `; flight error notification failed: ${notificationError}`}` };
    }
    return await new Promise((resolve) => {
    const schema = schemaFor(input.mode);
    const schemaDir = schema === null ? null : mkdtempSync(join(tmpdir(), "arbor-codex-schema-"));
    const schemaPath = schemaDir === null ? null : join(schemaDir, "response-schema.json");
    if (schemaPath !== null) writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    const args = [
      ...(options.codex_args ?? []),
      "exec",
      "--json",
      "--strict-config",
      "--ignore-user-config",
      "--ignore-rules",
      // `--approve-for-me` already selects the workspace-write sandbox and
      // Codex rejects it when combined with an explicit `--sandbox` flag.
      ...(input.mode === "specialist" ? ["--approve-for-me"] : ["--sandbox", "read-only"]),
      ...(input.model === DEFAULT_MODEL ? [] : ["--model", input.model]),
      ...(schemaPath === null ? [] : ["--output-schema", schemaPath]),
      ...(input.session_id === undefined ? [] : ["resume", input.session_id]),
      "-",
    ];
    const child = spawn(codexBin, args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"], env: codexEnv(), shell: false });
    trackChild(child);
    const childPid = child.pid;
    if (typeof childPid !== "number" || !Number.isSafeInteger(childPid) || childPid <= 0) {
      child.once("error", () => {});
      try { child.kill("SIGKILL"); } catch { /* process never became killable */ }
      void reportRepoFlightProviderError(options.repo_flight_hook, {
        ...flightContext, stage: "spawn", pid: null, error: "Codex spawn did not expose an OS child PID",
      }).then((notificationError) => resolve({
        ok: false,
        error: `Codex spawn did not expose an OS child PID${notificationError === null ? "" : `; flight error notification failed: ${notificationError}`}`,
      }));
      return;
    }
    const childContext: RepoFlightProviderChildContext = Object.freeze({ ...flightContext, pid: childPid });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminating = false;
    let terminationResult: ClaudeCodeCallResult | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let finalFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let enrolled = false;
    let terminalReported = false;
    let abortReported = false;
    const clean = () => {
      if (timer !== null) clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (finalFallbackTimer !== null) clearTimeout(finalFallbackTimer);
      input.signal?.removeEventListener("abort", onAbort);
      if (schemaDir !== null) rmSync(schemaDir, { recursive: true, force: true });
    };
    const finish = (result: ClaudeCodeCallResult) => {
      if (settled) return;
      settled = true;
      clean();
      resolve(result);
    };
    const notifyAbort = (reason: "caller_abort" | "timeout" | "output_limit" | "admission_refused") => {
      if (abortReported) return;
      abortReported = true;
      void Promise.resolve(options.repo_flight_hook?.abort?.({ ...childContext, reason })).catch(() => {});
    };
    const reportError = (stage: "post_spawn" | "spawn" | "terminal", error: string) => {
      void reportRepoFlightProviderError(options.repo_flight_hook, { ...flightContext, stage, pid: child.pid ?? null, error });
    };
    const terminate = (result: ClaudeCodeCallResult) => {
      if (settled || terminating) return;
      terminating = true;
      terminationResult = result;
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, TERMINATION_GRACE_MS);
      // A broken platform process handle must not pin a campaign forever. This
      // is deliberately longer than the SIGTERM-to-SIGKILL escalation and is
      // only a final settlement fallback; normal completion waits for close so
      // schema material and child tracking remain live until reaping.
      finalFallbackTimer = setTimeout(() => finish(result), TERMINATION_FINAL_FALLBACK_MS);
    };
    const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
      if (settled) return;
      const used = kind === "stdout" ? stdoutBytes : stderrBytes;
      const retained = chunk.subarray(0, Math.max(0, maxOutputBytes - used));
      if (kind === "stdout") { stdoutBytes += chunk.length; stdout += retained.toString(); }
      else { stderrBytes += chunk.length; stderr += retained.toString(); }
      if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
        notifyAbort("output_limit");
        reportError("post_spawn", "Codex output exceeded the configured safety bound");
        terminate({ ok: false, error: "Codex output exceeded the configured safety bound" });
      }
    };
    const onAbort = () => {
      notifyAbort("caller_abort");
      reportError("post_spawn", "Codex execution was cancelled");
      terminate({ ok: false, error: "Codex execution was cancelled" });
    };
    const startTimer = () => { timer = setTimeout(() => {
      notifyAbort("timeout");
      reportError("post_spawn", `Codex execution timed out after ${timeoutMs}ms`);
      terminate({ ok: false, error: `Codex execution timed out after ${timeoutMs}ms`, elapsed_ms: timeoutMs, partial_output: stdout.length === 0 ? null : stdout });
    }, timeoutMs); };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      // An argument/configuration failure can close stdin before the prompt
      // buffer is flushed. Preserve the process's bounded stderr diagnostic;
      // do not leak a secondary EPIPE into the TUI event loop.
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
      notifyAbort("admission_refused");
      reportError("post_spawn", `Codex stdin failed: ${error.message}`);
      terminate({ ok: false, error: `Codex stdin failed: ${error.message}` });
    });
    child.on("error", (error) => {
      notifyAbort("admission_refused");
      reportError("spawn", `Codex spawn failed: ${error.message}`);
      finish({ ok: false, error: `Codex spawn failed: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      void (async () => {
        if (!terminalReported) {
          terminalReported = true;
          try {
            await options.repo_flight_hook?.terminal?.({ ...childContext, code, signal });
          } catch (error) {
            const message = `Codex flight terminal notification failed: ${boundedHookReason(error instanceof Error ? error.message : "provider lifecycle terminal hook rejected notification")}`;
            reportError("terminal", message);
            finish({ ok: false, error: message });
            return;
          }
        }
        finish(terminating
          ? terminationResult!
          : !enrolled ? { ok: false, error: "Codex exited before flight enrollment completed" }
          : code === 0 ? parseCodexJsonl(stdout) : { ok: false, error: boundedDiagnostic(code, stdout, stderr) });
      })();
    });
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    void (async () => {
      try {
        await options.repo_flight_hook?.enroll_child?.(childContext);
        if (settled || terminating || child.exitCode !== null) return;
        enrolled = true;
        child.stdin?.end(input.context_capsule === undefined ? input.prompt : `${input.context_capsule}\n\n${input.prompt}`);
        startTimer();
      } catch (error) {
        const message = `Codex flight enrollment refused: ${boundedHookReason(error instanceof Error ? error.message : "provider lifecycle enrollment failed")}`;
        notifyAbort("admission_refused");
        reportError("post_spawn", message);
        terminate({ ok: false, error: message });
      }
    })();
    });
  };
}

export function createCodexHarnessConnectorDescriptor(observedAt = new Date().toISOString()): ConnectorDescriptor {
  const claude = createClaudeCodeHarnessConnectorDescriptor(observedAt);
  return Object.freeze({
    ...claude,
    connector_id: CODEX_HARNESS_CONNECTOR_ID,
    supported_upstream_range: "codex-cli exec",
    capabilities: Object.freeze(claude.capabilities.map((capability) => Object.freeze({
      ...capability,
      evidence: Object.freeze({
        ...capability.evidence,
        implementation_id: CODEX_HARNESS_CONNECTOR_ID,
        detail: `Codex exec documented ${capability.capability} contract; Revoy composes it with explicit argv, sandbox, and environment policy`,
      }),
    }))),
  });
}

/** Codex uses the same Revoy-owned plan/critic parsers; only the process bridge differs. */
export function createCodexCampaignIntegration(options: CodexCampaignOptions = {}): CampaignHarnessIntegration {
  return createClaudeCodeCampaignIntegration({
    model: options.model ?? (process.env.ARBOR_CODEX_MODEL?.trim() || DEFAULT_MODEL),
    run: createCodexCodeRunner(options),
    identity_namespace: "codex",
    transport_label: "Codex",
    ...(options.specialist_verification === undefined ? {} : { specialist_verification: options.specialist_verification }),
    ...(options.native_critic === undefined ? {} : { native_critic: options.native_critic }),
  });
}

export function createCodexTaskPlanner(options: CodexTaskPlannerOptions) {
  return createClaudeCodeTaskPlanner({
    ...options,
    model: options.model ?? (process.env.ARBOR_CODEX_MODEL?.trim() || DEFAULT_MODEL),
    run: createCodexCodeRunner(options),
    identity_namespace: "codex",
    transport_label: "Codex",
  });
}
