import { spawn } from "node:child_process";
import type { CriticVerdict, DecomposerPort, NodeError, TokenUsageResult } from "@arbor/core";
import type { ConnectorDescriptor } from "@arbor/harness";
import type { CriticResult, LoopExecutor, ReviewerRunner, SpecialistResult } from "@arbor/opencode";
import { trackChild } from "../child-registry.js";
import type { CampaignHarnessIntegration, CampaignHarnessIntegrationInput } from "../campaign-harness-integration.js";
import { malformedCriticVerdictFailure, parseCriticVerdict } from "../opencode-executor.js";
import { parseDecompositionResponse } from "../opencode-decomposer.js";
import type { TaskComposerPlannerPort } from "../task-composer.js";
import { NATIVE_TASK_PLAN_CONTRACT, NATIVE_TASK_PLAN_SCHEMA, normalizeProviderPlan } from "../native-task-plan-contract.js";
import { NATIVE_CRITIC_VERDICT_SCHEMA, extractCriticConfidence, nativeCriticVerdictInstruction } from "../native-critic-contract.js";
import { ARBOR_CRITIC_TRANSPORT_ENV, type NativeCriticPort } from "../native-critic-transport.js";
import type { SpecialistWorktreeVerificationPort } from "../worktree-machine-verifier.js";
import { buildRepositoryContextCapsule } from "../native-agent-executor.js";
import { RepositoryGraphIndex } from "../repository-graph.js";
import { EVIDENCE_BOUND_CRITIC_POLICY } from "../critic-review-policy.js";
import { postConnectorBusThreadReport, resolveConnectorBusThreadEdge } from "../native-bus-thread-contracts.js";
import {
  admitRepoFlightProviderLaunch,
  boundedHookReason,
  repoFlightProviderLaunchContext,
  reportRepoFlightProviderError,
  type RepoFlightProviderChildContext,
  type RepoFlightProviderGovernanceMetadata,
  type RepoFlightProviderLifecycleHook,
} from "./repo-flight-provider-hook.js";

export const CLAUDE_CODE_HARNESS_CONNECTOR_ID = "claude-code-plugin";

export interface ClaudeCodeCall {
  readonly prompt: string;
  readonly cwd: string;
  readonly model: string;
  readonly mode: "specialist" | "read_only" | "planner" | "critic";
  readonly signal?: AbortSignal;
  readonly max_turns?: number;
  /**
   * Pre-computed, bounded repository-graph context (see
   * `buildRepositoryContextCapsule` in native-agent-executor.ts). Prepended
   * to the prompt so this connector gets the same task-ranked retrieval
   * grounding as the native execution path, without granting live tool
   * access or paying live-traversal latency.
   */
  readonly context_capsule?: string;
  /** Resume an existing Claude Code session instead of starting a fresh one. */
  readonly session_id?: string;
  /** Bounded campaign authority for optional Repo Flight Control admission. */
  readonly flight_governance?: RepoFlightProviderGovernanceMetadata;
}

export type ClaudeCodeCallResult =
  | { readonly ok: true; readonly text: string; readonly usage: TokenUsageResult; readonly session_id?: string | null }
  | {
      readonly ok: false;
      readonly error: string;
      /**
       * Only populated on the timeout path: real work salvaged before the
       * kill, so a 90%-complete investigation doesn't lose everything. See
       * `processError`, which threads these into `NodeError`'s `timeout`
       * variant.
       */
      readonly elapsed_ms?: number;
      readonly partial_output?: string | null;
      readonly usage?: TokenUsageResult;
    };

export interface ClaudeCodeCampaignOptions {
  readonly claude_bin?: string;
  /** Optional arguments inserted before Claude's own CLI arguments. */
  readonly claude_args?: readonly string[];
  readonly model?: string;
  readonly timeout_ms?: number;
  readonly run?: (input: ClaudeCodeCall) => Promise<ClaudeCodeCallResult>;
  /**
   * The same independent machine-verification boundary the native executor
   * uses. Run only after a successful specialist call, on the admitted
   * worktree; a `null` result (or no port at all) leaves provenance at
   * `claimed` rather than being silently upgraded.
   */
  readonly specialist_verification?: SpecialistWorktreeVerificationPort;
  /**
   * Shared repository-graph indexer used to build bounded context capsules
   * for planning and specialist prompts. Omitted means no capsule is
   * injected (prompts fall back to plain text, as before).
   */
  readonly repository_graph?: RepositoryGraphIndex;
  /**
   * PERF: single-call native transport for critic/review dispatch (see
   * `native-critic-transport.ts`). Used only when `ARBOR_CRITIC_TRANSPORT=native`
   * AND this port reports itself ready (native provider selection complete,
   * same readiness check `arbor doctor` uses). Absent, not ready, or an
   * erroring call all fall back to the unchanged CLI critic path below --
   * the fast path never costs a review its result.
   */
  readonly native_critic?: NativeCriticPort;
  /** Provider identity used by the shared governed campaign adapter. */
  readonly identity_namespace?: string;
  /** Human-readable provider name used in operator-facing diagnostics. */
  readonly transport_label?: string;
  /**
   * Optional Repo Flight Control child-lifecycle seam. Absent preserves the
   * existing direct Claude Code process behavior.
   */
  readonly repo_flight_hook?: RepoFlightProviderLifecycleHook;
}

export interface ClaudeCodeTaskPlannerOptions extends ClaudeCodeCampaignOptions {
  readonly cwd: string;
  readonly planning_prompt: (input: Parameters<TaskComposerPlannerPort["plan"]>[0]) => string;
}

function unavailableUsage(reason: string): TokenUsageResult {
  return { kind: "unavailable", reason };
}

function accumulateCallUsage(first: TokenUsageResult, second: TokenUsageResult): TokenUsageResult {
  if ("kind" in first || "kind" in second || first.counter_source !== second.counter_source) {
    return unavailableUsage("semantic plan repair usage is incomplete or uses incompatible counter sources");
  }
  return {
    input_tokens: first.input_tokens + second.input_tokens,
    output_tokens: first.output_tokens + second.output_tokens,
    cached_input_tokens: first.cached_input_tokens + second.cached_input_tokens,
    cache_write_input_tokens: first.cache_write_input_tokens + second.cache_write_input_tokens,
    counter_source: first.counter_source,
  };
}

function parseClaudeJson(stdout: string): ClaudeCodeCallResult {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return { ok: false, error: "Claude Code returned invalid JSON" }; }
  if (typeof value !== "object" || value === null) return { ok: false, error: "Claude Code returned a non-object result" };
  const record = value as Record<string, unknown>;
  const resultText = typeof record.result === "string"
    ? record.result
    : record.structured_output !== undefined ? JSON.stringify(record.structured_output) : null;
  if (resultText === null) return { ok: false, error: "Claude Code result text was absent" };
  const usage = typeof record.usage === "object" && record.usage !== null ? record.usage as Record<string, unknown> : null;
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  const cacheRead = usage?.cache_read_input_tokens;
  const cacheWrite = usage?.cache_creation_input_tokens;
  return {
    ok: true,
    text: resultText,
    usage: [input, output, cacheRead, cacheWrite].every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)
      ? {
          input_tokens: input as number,
          output_tokens: output as number,
          cached_input_tokens: cacheRead as number,
          cache_write_input_tokens: cacheWrite as number,
          counter_source: "provider_counter",
        }
      : unavailableUsage("Claude Code did not report a complete non-negative token counter"),
    session_id: typeof record.session_id === "string" && record.session_id.trim().length > 0 ? record.session_id : null,
  };
}

const SPECIALIST_MAX_TURNS_DEFAULT = 32;
const SPECIALIST_MAX_TURNS_MIN = 8;
const SPECIALIST_MAX_TURNS_MAX = 128;
const REVIEWER_MAX_TURNS = "24";

/**
 * OPT-5: reviewer/critic turn ceiling override. The default 24-turn grant
 * exists so the critic can independently re-establish evidence; when the
 * loop's verification-informed critic note is in play (machine verification
 * already ran), a much smaller ceiling (e.g. 8) cuts the critic's wall time
 * and token spend without weakening review — the evidence it would have
 * spent turns reproducing is already in its prompt.
 */
function resolveReviewerMaxTurns(): string {
  const raw = process.env.ARBOR_CLAUDE_CODE_CRITIC_MAX_TURNS?.trim();
  if (raw === undefined || raw === "") return REVIEWER_MAX_TURNS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 2 && parsed <= 64 ? String(parsed) : REVIEWER_MAX_TURNS;
}

/**
 * E-1 (arXiv 2602.11988 / 2607.27250) capsule ablation: set to "off" to
 * skip building and injecting repository context capsules into planning
 * and specialist prompts, so the bench can measure whether the capsule
 * actually pays for its tokens. Any other value (or unset) keeps the
 * capsule on — the current default.
 */
export const ARBOR_CONTEXT_CAPSULE_ENV = "ARBOR_CONTEXT_CAPSULE";

function contextCapsuleDisabled(): boolean {
  return process.env[ARBOR_CONTEXT_CAPSULE_ENV]?.trim() === "off";
}

/**
 * E-2 (arXiv 2607.13034, manifest item E3): precedence is
 * `ARBOR_CLAUDE_CODE_MAX_TURNS` env override > the arbiter's per-tier
 * `turn_budget_estimate` > the existing model-tier default -- identical to
 * the env-over-default precedence that existed before this estimate did.
 */
function resolveSpecialistMaxTurns(modelTier?: "economical" | "balanced" | "capable", turnBudgetEstimate?: number): number {
  const raw = process.env.ARBOR_CLAUDE_CODE_MAX_TURNS;
  if (raw === undefined || raw.trim() === "") {
    if (turnBudgetEstimate !== undefined && Number.isSafeInteger(turnBudgetEstimate)
      && turnBudgetEstimate >= SPECIALIST_MAX_TURNS_MIN && turnBudgetEstimate <= SPECIALIST_MAX_TURNS_MAX) {
      return turnBudgetEstimate;
    }
    return modelTier === "economical" ? 16 : modelTier === "capable" ? 48 : SPECIALIST_MAX_TURNS_DEFAULT;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= SPECIALIST_MAX_TURNS_MIN && parsed <= SPECIALIST_MAX_TURNS_MAX
    ? parsed
    : SPECIALIST_MAX_TURNS_DEFAULT;
}

/**
 * Bounded, non-empty diagnostic for a nonzero exit. Prefers stderr, then any
 * error/result text Claude Code's own JSON stdout carries, then raw stdout;
 * only length is truncated so no error content is silently redacted.
 */
function nonzeroExitDiagnostic(code: number | null, stdout: string, stderr: string): string {
  const trimmedStderr = stderr.trim();
  if (trimmedStderr.length > 0) return `Claude Code exited ${code}: ${trimmedStderr.slice(0, 500)}`;
  const trimmedStdout = stdout.trim();
  if (trimmedStdout.length > 0) {
    try {
      const value = JSON.parse(trimmedStdout) as unknown;
      if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        const detail = typeof record.error === "string"
          ? record.error
          : typeof record.result === "string" ? record.result : null;
        if (detail !== null && detail.trim().length > 0) return `Claude Code exited ${code}: ${detail.slice(0, 500)}`;
      }
    } catch { /* not JSON; fall through to raw stdout below */ }
    return `Claude Code exited ${code}: ${trimmedStdout.slice(0, 500)}`;
  }
  return `Claude Code exited ${code} with no stdout or stderr output`;
}

/**
 * Env vars the Claude Code CLI itself needs to run and authenticate
 * (locale/proxy plumbing, its own config/keychain lookup, PATH resolution).
 * The connector spawns this subprocess against arbitrary, potentially
 * untrusted repository content; inheriting the operator's *entire* shell
 * environment would hand that subprocess every unrelated credential sitting
 * in it (cloud keys, other services' tokens, etc.) for no operational
 * benefit. Only this explicit allowlist crosses the boundary.
 */
const CLAUDE_CODE_SUBPROCESS_ENV_ALLOWLIST = [
  "PATH", "HOME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM",
  "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
] as const;

function claudeCodeSubprocessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CLAUDE_CODE_SUBPROCESS_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Timeout ceiling resolution, extracted as a pure function so this exact
 * decision (fix G-08/#1: `read_only` gets the specialist ceiling, not the
 * short reviewer one) is directly unit-testable without waiting out a real
 * multi-minute timer. `read_only` is genuine investigation/analysis work
 * (auth, email relay, defect analysis, etc. in the pilot run) that can
 * legitimately run as long as a mutating specialist call — only
 * `critic`/reviewer-style calls are short-lived by design. Pinning
 * `read_only` to the 180s reviewer ceiling caused three real pilot-run
 * timeouts on read-only investigations.
 */
export function resolveClaudeCodeTimeoutMs(
  mode: "specialist" | "read_only" | "planner" | "critic",
  explicitTimeoutMs: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = Number(env.ARBOR_CLAUDE_CODE_TIMEOUT_MS);
  const specialistTimeout = Number.isSafeInteger(configured) && configured >= 30_000 && configured <= 3_600_000 ? configured : 900_000;
  return explicitTimeoutMs ?? (mode === "specialist" || mode === "read_only" ? specialistTimeout : 180_000);
}

function createClaudeCodeRunner(options: ClaudeCodeCampaignOptions): (input: ClaudeCodeCall) => Promise<ClaudeCodeCallResult> {
  const claudeBin = options.claude_bin ?? "claude";
  return async (input) => {
    const flightContext = repoFlightProviderLaunchContext("claude", input);
    try {
      await admitRepoFlightProviderLaunch(options.repo_flight_hook, flightContext);
    } catch (error) {
      const reason = boundedHookReason(error instanceof Error ? error.message : "provider launch admission failed");
      const notificationError = await reportRepoFlightProviderError(options.repo_flight_hook, {
        ...flightContext, stage: "pre_launch", pid: null, error: reason,
      });
      return { ok: false, error: `Claude Code flight admission refused: ${reason}${notificationError === null ? "" : `; flight error notification failed: ${notificationError}`}` };
    }
    return await new Promise((resolve) => {
    const timeoutMs = resolveClaudeCodeTimeoutMs(input.mode, options.timeout_ms);
    const args = [
      ...(options.claude_args ?? []),
      "-p",
      "--output-format", "json",
      // Never let this subprocess discover or apply the target repository's
      // (or the operator's) own CLAUDE.md, skills, plugins, hooks, MCP
      // servers, custom commands/agents, or other customizations. Verified
      // against `claude --help`: "--safe-mode  Start with all customizations
      // (CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and
      // agents, output styles, workflows, custom themes, keybindings, and
      // more) disabled ... Auth, model selection, built-in tools, and
      // permissions work normally." This is the load-bearing fix for the
      // pilot incident where a read-only Q&A call read a target repo's
      // secret-bearing CLAUDE.md.
      "--safe-mode",
      // The connector's declared tool policy is the complete capability
      // surface. Inheriting a user's global Claude MCP catalog would both
      // widen that surface and pay startup cost for unrelated servers on
      // every specialist/reviewer invocation.
      "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}',
      "--model", input.model,
      "--max-turns", input.mode === "planner" ? "1" : input.max_turns !== undefined ? String(input.max_turns) : input.mode === "specialist" ? String(resolveSpecialistMaxTurns()) : resolveReviewerMaxTurns(),
      "--permission-mode", input.mode === "specialist" ? "acceptEdits" : "plan",
      "--allowedTools", input.mode === "specialist" ? "Read,Edit,Write,Bash,Glob,Grep" : input.mode === "read_only" || input.mode === "critic" ? "Read,Glob,Grep" : "",
    ];
    if (input.mode === "planner") args.push("--json-schema", JSON.stringify(NATIVE_TASK_PLAN_SCHEMA.schema));
    if (input.mode === "critic") args.push("--json-schema", JSON.stringify(NATIVE_CRITIC_VERDICT_SCHEMA.schema));
    if (input.session_id !== undefined) args.push("--resume", input.session_id);
    const child = spawn(claudeBin, args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"], env: claudeCodeSubprocessEnv() });
    trackChild(child);
    const childPid = child.pid;
    if (typeof childPid !== "number" || !Number.isSafeInteger(childPid) || childPid <= 0) {
      child.once("error", () => {});
      try { child.kill("SIGKILL"); } catch { /* process never became killable */ }
      void reportRepoFlightProviderError(options.repo_flight_hook, {
        ...flightContext, stage: "spawn", pid: null, error: "Claude Code spawn did not expose an OS child PID",
      }).then((notificationError) => resolve({
        ok: false,
        error: `Claude Code spawn did not expose an OS child PID${notificationError === null ? "" : `; flight error notification failed: ${notificationError}`}`,
      }));
      return;
    }
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let ending = false;
    let enrolled = false;
    let terminalReported = false;
    let abortReported = false;
    let pendingClose: { readonly code: number | null; readonly signal: string | null } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const childContext: RepoFlightProviderChildContext = Object.freeze({ ...flightContext, pid: childPid });
    const finish = (result: ClaudeCodeCallResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const notifyAbort = async (reason: "caller_abort" | "timeout" | "output_limit" | "admission_refused"): Promise<string | null> => {
      if (abortReported) return null;
      abortReported = true;
      try { await options.repo_flight_hook?.abort?.({ ...childContext, reason }); return null; }
      catch (error) { return boundedHookReason(error instanceof Error ? error.message : "provider lifecycle abort hook rejected notification"); }
    };
    const fail = async (
      error: string,
      stage: "post_spawn" | "spawn" | "terminal",
      abortReason?: "caller_abort" | "timeout" | "output_limit" | "admission_refused",
      details?: Pick<Extract<ClaudeCodeCallResult, { readonly ok: false }>, "elapsed_ms" | "partial_output" | "usage">,
    ): Promise<void> => {
      if (settled || ending) return;
      ending = true;
      if (abortReason !== undefined) {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }
      const abortError = abortReason === undefined ? null : await notifyAbort(abortReason);
      const notificationError = await reportRepoFlightProviderError(options.repo_flight_hook, {
        ...flightContext, stage, pid: child.pid ?? null, error,
      });
      finish({
        ok: false,
        error: `${error}${abortError === null ? "" : `; flight abort notification failed: ${abortError}`}${notificationError === null ? "" : `; flight error notification failed: ${notificationError}`}`,
        ...details,
      });
    };
    const reportTerminal = async (code: number | null, signal: string | null): Promise<void> => {
      if (terminalReported) return;
      terminalReported = true;
      try {
        await options.repo_flight_hook?.terminal?.({ ...childContext, code, signal });
      } catch (error) {
        await fail(`Claude Code flight terminal notification failed: ${boundedHookReason(error instanceof Error ? error.message : "provider lifecycle terminal hook rejected notification")}`, "terminal");
      }
    };
    const settleClose = async (code: number | null, signal: string | null): Promise<void> => {
      await reportTerminal(code, signal);
      if (settled || ending) return;
      if (!enrolled) { pendingClose = { code, signal }; return; }
      finish(code === 0 ? parseClaudeJson(stdout) : { ok: false, error: nonzeroExitDiagnostic(code, stdout, stderr) });
    };
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const startTimer = () => { timer = setTimeout(() => {
      // Capture everything real before the kill: accumulated stdout as
      // partial output, actual wall-clock elapsed (not just the configured
      // ceiling, in case the timer fired slightly late), and usage salvaged
      // only if stdout happened to already be a complete JSON response —
      // Claude Code's --output-format json typically only emits usage in a
      // complete response, so a mid-stream kill honestly reports usage as
      // unavailable rather than fabricating zeros.
      const elapsed_ms = Date.now() - startedAt;
      const partial_output = stdout.length > 0 ? stdout : null;
      const salvaged = parseClaudeJson(stdout);
      const usage = salvaged.ok ? salvaged.usage : unavailableUsage("process killed on timeout before usage was reported");
      void fail(`Claude Code timed out after ${timeoutMs}ms`, "post_spawn", "timeout", { elapsed_ms, partial_output, usage });
    }, timeoutMs); };
    const abort = (): void => { void fail("Claude Code call aborted", "post_spawn", "caller_abort"); };
    input.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => { void fail(`Claude Code spawn failed: ${error.message}`, "spawn", "admission_refused"); });
    child.on("close", (code, signal) => { void settleClose(code, signal); });
    void (async () => {
      try {
        await options.repo_flight_hook?.enroll_child?.(childContext);
        if (pendingClose !== null) {
          await fail("Claude Code exited before flight enrollment completed", "post_spawn", "admission_refused");
          return;
        }
        if (ending || settled) return;
        enrolled = true;
        child.stdin?.end(input.context_capsule === undefined ? input.prompt : `${input.context_capsule}\n\n${input.prompt}`);
        startTimer();
      } catch (error) {
        await fail(`Claude Code flight enrollment refused: ${boundedHookReason(error instanceof Error ? error.message : "provider lifecycle enrollment failed")}`, "post_spawn", "admission_refused");
      }
    })();
    });
  };
}

/**
 * Builds the classified `NodeError` for a failed Claude Code call. Takes the
 * whole `!ok` result (not just its message) so the timeout path can thread
 * through the real `elapsed_ms`/`partial_output`/`usage` salvaged before the
 * kill (see the timeout handler in `createClaudeCodeRunner`) instead of
 * discarding them. These three fields are the frozen addition to
 * `NodeError`'s `"timeout"` variant landed by the core-state remediation
 * bucket; until that lands in this branch, TypeScript will flag them as
 * excess properties here — expected and safe to ignore pending integration.
 */
function processError(result: Extract<ClaudeCodeCallResult, { ok: false }>): NodeError {
  const provenance = { tag: "claimed" as const, claimant: "claude-code-plugin" };
  const message = result.error;
  if (/timed out/.test(message)) {
    return {
      kind: "timeout",
      provenance,
      message,
      elapsed_ms: result.elapsed_ms ?? 0,
      partial_output: result.partial_output ?? null,
      usage: result.usage ?? unavailableUsage("elapsed time and usage were not observed for this timeout"),
    };
  }
  if (/aborted/.test(message)) return { kind: "transport_error", recoverable: false, provenance, message };
  return { kind: "internal_error", recoverable: true, provenance, message };
}

export function createClaudeCodeHarnessConnectorDescriptor(observedAt = new Date().toISOString()): ConnectorDescriptor {
  const support = (capability: "interruption" | "tool_policy" | "workspace_isolation" | "usage_reporting", grade: "governed" | "observed", detail: string) => ({
    capability,
    grade,
    evidence: { implementation_id: "revoy2-claude-code-integration", observed_at: observedAt, detail },
  });
  return {
    connector_id: CLAUDE_CODE_HARNESS_CONNECTOR_ID,
    implementation_version: "1",
    supported_upstream_range: "claude-code-cli",
    health: "healthy",
    capabilities: [
      support("interruption", "governed", "Revoy owns the subprocess signal and bounded timeout"),
      support("tool_policy", "governed", "Revoy supplies role-specific Claude Code tool and permission flags"),
      support("workspace_isolation", "governed", "Specialist calls run only in the Revoy-leased worktree"),
      support("usage_reporting", "observed", "Claude Code JSON counters are retained when complete"),
    ],
  };
}

/** Claude Code subprocess integration. Authentication remains wholly owned by Claude Code. */
export function createClaudeCodeCampaignIntegration(options: ClaudeCodeCampaignOptions = {}): CampaignHarnessIntegration {
  const run = options.run ?? createClaudeCodeRunner(options);
  const model = options.model ?? (process.env.ARBOR_CLAUDE_CODE_MODEL?.trim() || "sonnet");
  const identityNamespace = options.identity_namespace ?? "claude-code";
  const transportLabel = options.transport_label ?? "Claude Code";
  const transportRootCause = `${identityNamespace.replace(/-/g, "_")}_transport`;
  // OPT-2 (verifier-tier routing): the critic may run on a cheaper/faster
  // model than the specialist — the weak-verifier/strong-generator result
  // from the routing literature, and a different-model critic is if anything
  // MORE independent of the proposer. Defaults to the specialist model.
  const criticModel = process.env.ARBOR_CLAUDE_CODE_CRITIC_MODEL?.trim() || model;
  // PERF: native critic transport is opt-in (measured ~20s/$0.11 CLI floor
  // regardless of model/turn cap -- the floor is the CLI process itself, not
  // the review work). Read once at composition time, mirroring how `model`
  // and `criticModel` above are resolved once rather than per call.
  const useNativeCritic = process.env[ARBOR_CRITIC_TRANSPORT_ENV]?.trim() === "native";
  const nativeCritic = options.native_critic;
  // E-3 (arXiv 2607.05391): merge a best-effort self-reported confidence
  // into an already-parsed verdict. `parseCriticVerdict` (opencode-executor)
  // is the authority for the verdict shape itself; this is a lenient,
  // independent second pass over the SAME raw text that only ever ADDS
  // `confidence`/`confidence_source` -- absent or malformed confidence
  // leaves the verdict byte-identical to today's behavior.
  const withConfidence = (verdict: CriticVerdict, raw: string): CriticVerdict => {
    const extraction = extractCriticConfidence(raw);
    return extraction === null ? verdict : { ...verdict, ...extraction };
  };
  const runNativeCritic = async (prompt: string, signal?: AbortSignal): Promise<CriticResult | null> => {
    if (!useNativeCritic || nativeCritic === undefined || !nativeCritic.ready) return null;
    const result = await nativeCritic.call(prompt, signal);
    const modelIdentity = `native/${nativeCritic.model_id ?? "unknown"}`;
    if (!result.ok) return null; // fall back to the CLI critic path below; never fail a review because the fast path errored
    const parsed = parseCriticVerdict(result.text, "lenticel");
    if (parsed.kind === "malformed") return { ...malformedCriticVerdictFailure("lenticel", parsed), token_usage: result.usage, model_identity: modelIdentity };
    if (parsed.kind !== "verdict") {
      return { approved: false, rationale: `Native critic response was unparseable (${parsed.raw_hash})`, root_cause: "unparseable_critic_verdict", token_usage: result.usage, model_identity: modelIdentity };
    }
    const verdict = withConfidence(parsed.verdict, result.text);
    return { approved: verdict.approved, rationale: verdict.rationale, root_cause: verdict.root_cause, critic_agent: "lenticel", measurement_validated: verdict.measurement_validated, verdict, token_usage: result.usage, model_identity: modelIdentity };
  };
  const critic = async (prompt: string, cwd: string, signal?: AbortSignal): Promise<CriticResult> => {
    const native = await runNativeCritic(prompt, signal);
    if (native !== null) return native;
    const result = await run({ prompt: `${prompt}\n\n${nativeCriticVerdictInstruction()}`, cwd, model: criticModel, mode: "critic", ...(signal === undefined ? {} : { signal }) });
    const usage = result.ok ? result.usage : result.usage ?? unavailableUsage(result.error);
    if (!result.ok) return { approved: false, rationale: result.error, root_cause: transportRootCause, token_usage: usage, error: processError(result) };
    const parsed = parseCriticVerdict(result.text, "lenticel");
    if (parsed.kind === "malformed") return { ...malformedCriticVerdictFailure("lenticel", parsed), token_usage: usage, model_identity: `${identityNamespace}/${model}` };
    if (parsed.kind !== "verdict") return { approved: false, rationale: `${transportLabel} critic response was unparseable (${parsed.raw_hash})`, root_cause: "unparseable_critic_verdict", token_usage: usage };
    const verdict = withConfidence(parsed.verdict, result.text);
    return { approved: verdict.approved, rationale: verdict.rationale, root_cause: verdict.root_cause, critic_agent: "lenticel", measurement_validated: verdict.measurement_validated, verdict, token_usage: usage, model_identity: `${identityNamespace}/${model}` };
  };
  // Cross-lane bus relay (ADR-083, extended across lanes -- see
  // native-bus-thread-contracts.ts): best-effort, host-driven, never
  // reads a target edge from the connector subprocess's output. A
  // failure here is logged to devtools and never fails the specialist
  // call whose result it is reporting.
  const reportToParent = async (
    runtime: CampaignHarnessIntegrationInput["runtime"],
    adapter: CampaignHarnessIntegrationInput["adapter"],
    campaignId: string,
    nodeId: string,
    content: string,
  ): Promise<void> => {
    const edge = resolveConnectorBusThreadEdge(runtime, { campaign_id: campaignId, node_id: nodeId }, identityNamespace);
    if (edge === null) return; // root node, or campaign tree lookup failed -- nobody to report to
    const posted = await postConnectorBusThreadReport(runtime, edge, {
      message_kind: "report",
      content,
      correlation_id: `${identityNamespace}:${campaignId}:${nodeId}`,
    });
    if (!posted.ok) {
      adapter.pushDevtoolsLine({
        seq: 0, ts: new Date().toISOString(), event_kind: "loop.bus_thread_report_failed",
        campaign_id: campaignId, node_id: nodeId, synthetic: false,
        loop_event: { type: "bus_thread_report_failed", reason: posted.reason } as never,
      });
    }
  };
  return {
    createExecutor: ({ runtime, adapter, campaign_id, cwd }): LoopExecutor => ({
      log: (event) => {
        const transition = event as { readonly type: string; readonly node_id?: string; readonly campaign_id?: string };
        adapter.pushDevtoolsLine({
          seq: 0,
          ts: new Date().toISOString(),
          event_kind: `loop.${transition.type}`,
          campaign_id: transition.campaign_id ?? campaign_id,
          node_id: transition.node_id ?? null,
          synthetic: false,
          // Preserve observability identity while deliberately omitting
          // arbitrary loop payloads from the DevTools projection.
          loop_event: {
            type: transition.type,
            campaign_id: transition.campaign_id ?? campaign_id,
            node_id: transition.node_id,
            // Exact reverse topology is operator evidence, not arbitrary
            // specialist output. Keep null for root backtracks as well.
            ...(event.type === "backtracked" ? { parent_id: event.parent_id } : {}),
          } as never,
        });
      },
      async specialize(params): Promise<SpecialistResult> {
        const maxTurns = resolveSpecialistMaxTurns(params.routing?.model_tier, params.turn_budget_estimate);
        // The manager's own authorization convention (see cli.ts's
        // high_risk_tool_scope authoring guidance and native-tool-host.ts's
        // scope enforcement): an action with neither writes nor declared
        // commands is genuinely read-only. Read-only repository inspection
        // may still use non-mutating commands; a command-only validation node
        // needs the executable transport even though it may not edit files.
        const scope = params.action.high_risk_tool_scope;
        const writePaths = scope?.write_paths ?? [];
        const commandArgv = scope?.command_argv ?? [];
        const hasWrites = writePaths.length > 0;
        const hasCommands = commandArgv.length > 0;
        const readOnly = !hasWrites && !hasCommands;
        // X-3 (turn-efficiency #2+#3, arXiv 2503.09567, 2503.16419): split the
        // same turn budget into an exploration sub-cap (before the first
        // material edit) and a reflection remainder (fix/verify), instead of
        // one advisory "search allowance" number. The exploration cap is
        // phrased as a hard ceiling with a named consequence, matching the
        // bench finding that advisory phrasing alone did not compress
        // exploration wall time.
        const explorationCap = Math.ceil(maxTurns / 3);
        const reflectionRemainder = maxTurns - explorationCap;
        const authorityPrompt = readOnly
          ? "This is a read-only inspection/analysis action: you have no write or mutating-command authority for this task. You may use non-mutating repository inspection commands and read-only tools. Do not edit, create, or delete any file. Investigate and summarize your findings."
          : !hasWrites
            ? "This is a command-only validation action. Execute only the declared validation commands and report their observed results. Do not edit, create, or delete repository files."
            : `Work only in the current isolated worktree. Your exact write authority is ${JSON.stringify(writePaths)}. Every other repository path is immutable; in particular, do not add, edit, replace, or delete tests unless their exact paths appear in that list. Your exact effectful and validation command authority is ${JSON.stringify(commandArgv)}; do not run any other mutating or validation command. Complete the task within those bounds, inspect your changes, and summarize the result. You have a ${maxTurns}-turn budget split into two phases: exploration is capped at ${explorationCap} turns before your first material edit — exploration turns beyond ${explorationCap} before the first material edit will be scored as inefficiency by the reviewer; make the first material edit within that ceiling. The remaining ${reflectionRemainder} turns are your reflection allowance for fixing, verifying, and finalizing the change.`;
        const prompt = `${params.prompt}\n\n${authorityPrompt}`;
        const started = Date.now();
        const worktreePath = params.worktree_path || cwd;
        const capsule = options.repository_graph === undefined || contextCapsuleDisabled()
          ? null
          : buildRepositoryContextCapsule(options.repository_graph, worktreePath, params.prompt);
        const result = await run({
          prompt, cwd: worktreePath, model, mode: readOnly ? "read_only" : "specialist", max_turns: maxTurns,
          flight_governance: {
            campaign_id,
            node_id: params.node_id,
            task_id: params.node_id,
            write_paths: writePaths,
            // An unresolved intent is not an exact command clearance. The
            // flight authority must deny or wait for binding rather than
            // silently treating a prefix as unrestricted execution.
            command_argv: commandArgv.every(Array.isArray) ? commandArgv.map((argv) => [...argv]) : null,
          },
          ...(capsule === null ? {} : { context_capsule: capsule.text }),
          ...(params.signal === undefined ? {} : { signal: params.signal }),
        });
        adapter.pushDevtoolsLine({ seq: 0, ts: new Date().toISOString(), event_kind: "loop.tool_call", campaign_id, node_id: params.node_id, synthetic: false, loop_event: { type: "tool_call", tool: `${identityNamespace}.print`, args: `${params.specialist_agent} · ${model}`, ok: result.ok, duration_ms: Date.now() - started, stdout: (result.ok ? result.text : result.error).slice(0, 300) } as never });
        if (!result.ok) {
          await reportToParent(runtime, adapter, campaign_id, params.node_id, `[${identityNamespace}] specialist failed: ${result.error}`);
          return {
            // A timed-out call may have salvaged real partial findings — surface
            // them in the output alongside the error, not just the error string.
            output: result.partial_output ? `[${identityNamespace} error] ${result.error}\n\nPartial output before timeout:\n${result.partial_output}` : `[${identityNamespace} error] ${result.error}`,
            provenance: { tag: "claimed", claimant: params.specialist_agent },
            token_usage: result.usage ?? unavailableUsage(result.error),
            error: processError(result),
          };
        }
        // The connector's own text is never trusted as evidence of success;
        // only the injected verifier's observed zero exit can upgrade
        // provenance. No port, or a `null` verify result, stays `claimed`.
        // OPT-1 (pipelined verification): the verification subprocess and the
        // critic call are independent consumers of the same finished
        // specialist output, so this STARTS the verification and hands the
        // loop a settled-later promise instead of serially awaiting it here —
        // the loop overlaps it with critic dispatch and applies the upgrade
        // at recordResult. The promise never rejects (catch → null: any
        // verification failure honestly leaves provenance at `claimed`).
        const verificationPort = options.specialist_verification;
        const verificationInput = {
          campaign_id, node_id: params.node_id, specialist_agent: params.specialist_agent,
          session_id: `${identityNamespace}:${campaign_id}:${params.node_id}`,
          worktree_path: worktreePath, final_message: result.text,
          // Claude Code's CLI exposes no native conversation history to this
          // connector; an empty immutable history is honest, not omitted.
          history: [],
        };
        const verificationSignal = params.signal ?? new AbortController().signal;
        // E-2: prefer the richer `verifyOutcome` (distinguishes a real
        // attempted-and-failed verification from "nothing was attempted")
        // when the port implements it; fall back to `verify()`'s
        // null-collapsing shape otherwise -- `WorktreeMachineVerifier` is
        // the only production port and implements both today.
        type DeferredVerification = NonNullable<Awaited<NonNullable<SpecialistResult["deferred_verification"]>>> | null;
        // E-7c (ADR-063): the verification actually ran against THIS call's
        // own campaign/node target (`verificationInput` above is built from
        // the same `campaign_id`/`params.node_id` this specialize() call is
        // scoped to) -- carry that identity through so the loop can echo it
        // into `recordResult`'s `verification_source` instead of the
        // connector silently discarding it, which is what left the manager's
        // evidence-replay check permanently unexercised by any real caller.
        const verificationSource = { campaign_id, node_id: params.node_id };
        const deferred: Promise<DeferredVerification> | undefined = verificationPort === undefined ? undefined : (
          verificationPort.verifyOutcome
            ? verificationPort.verifyOutcome(verificationInput, verificationSignal).then((outcome): DeferredVerification =>
                // Y-1: an audit-tier scope mismatch rides along on whichever
                // outcome the verification produced, so the loop can journal
                // it without the observation ever changing the outcome.
                outcome.outcome === "verified" ? { provenance: outcome.provenance, verification_command_argv: outcome.command_argv, verification_source: verificationSource, ...(outcome.out_of_scope_observation === undefined ? {} : { scope_observation: outcome.out_of_scope_observation }) }
                  : outcome.outcome === "failed" ? { attempted: true, failed: true, ...(outcome.code === undefined ? {} : { code: outcome.code }), ...(outcome.exit === undefined ? {} : { exit: outcome.exit }), ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }), ...(outcome.out_of_scope_observation === undefined ? {} : { scope_observation: outcome.out_of_scope_observation }), ...(outcome.stages === undefined ? {} : { stages: outcome.stages }) }
                  : null)
            : verificationPort.verify(verificationInput, verificationSignal).then((verification): DeferredVerification =>
                verification === null ? null : { provenance: verification.provenance, verification_command_argv: verification.command_argv, verification_source: verificationSource })
        ).catch(() => ({ attempted: true, failed: true, code: "verification_exception" }));
        await reportToParent(runtime, adapter, campaign_id, params.node_id, `[${identityNamespace}] specialist completed:\n${result.text}`);
        return {
          output: result.text,
          provenance: { tag: "claimed", claimant: params.specialist_agent },
          ...(deferred === undefined ? {} : { deferred_verification: deferred }),
          token_usage: result.usage,
          model_identity: `${identityNamespace}/${model}`,
        };
      },
      review: (params) => critic(`${params.prompt}\n\nSpecialist output:\n${params.specialist_output}\n\nReview policy:\n${EVIDENCE_BOUND_CRITIC_POLICY}\n\nReturn only the required critic verdict JSON.`, cwd, params.signal),
    }),
    createReviewer: ({ cwd }): ReviewerRunner => async (criticName, context) => {
      const result = await critic(`Act as the independent ${criticName} panel reviewer. Review this bounded action and its captured candidate evidence:\n${JSON.stringify(context)}\nReview policy:\n${EVIDENCE_BOUND_CRITIC_POLICY}\nReturn only the required critic verdict JSON.`, context.worktree_path ?? cwd);
      // TEL-1 (ab3 bench): the reviewer's measured usage must survive into
      // the panel vote or the review's spend never reaches the audit ledger.
      const measuredUsage = result.token_usage !== undefined && !("kind" in result.token_usage) ? result.token_usage : undefined;
      return { approved: result.approved, rationale: result.rationale, ...(measuredUsage === undefined ? {} : { token_usage: measuredUsage }), ...(result.model_identity === undefined ? {} : { model_identity: result.model_identity }), ...(result.root_cause === undefined ? {} : { root_cause: result.root_cause }), ...(result.verdict === undefined ? {} : { verdict: result.verdict }) };
    },
    createDecomposer: ({ cwd }): DecomposerPort => ({
      async decompose(request) {
        const result = await run({ prompt: `Decompose this action into small independently verifiable child actions. Return only a raw JSON array of Action objects.\n${JSON.stringify(request.action)}`, cwd, model, mode: "read_only", ...(request.signal === undefined ? {} : { signal: request.signal }) });
        if (!result.ok) return { ok: false, reason: result.error };
        const parsed = parseDecompositionResponse(result.text);
        return parsed.kind === "children" ? { ok: true, children: parsed.children } : { ok: false, reason: `${parsed.detail} (${parsed.raw_hash})` };
      },
    }),
  };
}

/**
 * Explicit operator topology is authoritative. Providers often reflexively
 * turn a vertical slice into a checklist even when the task says it must
 * remain one atomic action; that changes campaign semantics and can exhaust
 * the wall-clock budget between partial nodes. Preserve the provider's
 * complete root scope but collapse the executable frontier when the operator
 * was unambiguous. `task` is omitted for a patch call, which has no fresh
 * operator task text to re-check against.
 */
type NormalizedPlanText = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string; readonly reason: string };

function normalizeClaudePlanText(raw: string, task?: string): string {
  const normalized = normalizeAndValidatePlanText(raw, task);
  return normalized.text;
}

function normalizeAndValidatePlanText(raw: string, task?: string): NormalizedPlanText {
  try {
    const plan = normalizeProviderPlan(JSON.parse(raw));
    if (task !== undefined && /\b(?:one atomic|single atomic|single action|do not split)\b/i.test(task)
      && typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
      const record = plan as Record<string, unknown>;
      if (typeof record.root_action === "object" && record.root_action !== null) {
        record.actions = [record.root_action];
        const rootDescription = (record.root_action as Record<string, unknown>).description;
        if (typeof rootDescription === "string" && Array.isArray(record.acceptance_checks) && record.acceptance_checks.every((criterion) => typeof criterion === "string")) {
          record.acceptance_mapping = record.acceptance_checks.map((criterion) => ({ criterion, action_descriptions: [rootDescription] }));
        }
      }
    }
    const text = JSON.stringify(plan);
    const validation = NATIVE_TASK_PLAN_CONTRACT.validate(plan);
    return validation.valid ? { ok: true, text } : { ok: false, text, reason: validation.reason };
  } catch (error) {
    return { ok: false, text: raw, reason: error instanceof Error ? error.message : String(error) };
  }
}

function hasCompletePlanEnvelope(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && ["summary", "assumptions", "questions", "root_action", "actions", "acceptance_checks", "acceptance_mapping", "risk_notes"].every((key) => key in value);
  } catch { return false; }
}

/** Read-only task-composer planning through Claude Code's own OAuth boundary. */
export function createClaudeCodeTaskPlanner(options: ClaudeCodeTaskPlannerOptions) {
  const run = options.run ?? createClaudeCodeRunner(options);
  const model = options.model ?? (process.env.ARBOR_CLAUDE_CODE_MODEL?.trim() || "sonnet");
  const identityNamespace = options.identity_namespace ?? "claude-code";
  const transportLabel = options.transport_label ?? "Claude Code";
  return {
    async plan(input: Parameters<TaskComposerPlannerPort["plan"]>[0]) {
      if ((input.attachments?.length ?? 0) > 0) throw new Error(`${transportLabel} task planning cannot prove governed image consumption; select a direct native image-capable provider`);
      const capsule = options.repository_graph === undefined || contextCapsuleDisabled() ? null : buildRepositoryContextCapsule(options.repository_graph, options.cwd, input.task);
      // Grounded repository signal replaces live tool access for planning:
      // the capsule (when available) IS the repository context, so the
      // planner still never inspects the repository or calls tools itself —
      // it just isn't planning blind anymore.
      const planningInstruction = capsule === null
        ? "Planning latency contract: no repository context capsule is available for this task; do not inspect the repository or call tools in this pre-campaign step. Propose bounded actions from the operator request; the admitted specialist owns repository discovery."
        : "Planning latency contract: the repository context capsule above is your grounded repository signal for this pre-campaign step. Treat it as authoritative; do not inspect the repository or call tools yourself. The admitted specialist owns any further repository discovery.";
      const result = await run({
        prompt: `${options.planning_prompt(input)}\n\n${planningInstruction}`,
        cwd: options.cwd, model, mode: "planner", signal: input.signal,
        ...(capsule === null ? {} : { context_capsule: capsule.text }),
      });
      if (!result.ok) throw new Error(result.error);
      let finalResult = result;
      let finalUsage = result.usage;
      let normalized = normalizeAndValidatePlanText(result.text, input.task);
      if (!normalized.ok && hasCompletePlanEnvelope(result.text)) {
        const repairPrompt = [
          "Your prior task-composer proposal was structurally complete but failed the harness semantic contract.",
          `Validator feedback: ${normalized.reason}`,
          ...(result.session_id == null ? [`Prior proposal:\n${result.text}`] : []),
          "Return one corrected, complete raw JSON task-composer proposal. Preserve the requested scope. Every acceptance criterion must map to one or more exact action description strings, dependencies must name exact sibling action descriptions, and declared effects must remain least-authority. Do not inspect the repository or call tools.",
        ].join("\n\n");
        const repaired = await run({
          prompt: repairPrompt, cwd: options.cwd, model, mode: "planner", signal: input.signal,
          ...(result.session_id == null ? {} : { session_id: result.session_id }),
          ...(capsule === null ? {} : { context_capsule: capsule.text }),
        });
        if (repaired.ok) {
          finalResult = repaired;
          finalUsage = accumulateCallUsage(result.usage, repaired.usage);
          normalized = normalizeAndValidatePlanText(repaired.text, input.task);
        }
      }
      return {
        raw_proposal: normalized.text,
        session_id: finalResult.session_id ?? result.session_id ?? `${identityNamespace}:${input.draft_id}`,
        model_identity: `${identityNamespace}/${model}`,
        usage: finalUsage,
      };
    },
    /**
     * Cheap clarification patching: resume the planner's own Claude Code
     * session (when one was returned by `plan()`) instead of paying for a
     * full fresh `plan()` call. Falls back to a fresh session when no prior
     * session id is available.
     */
    async patch(input: {
      readonly draft_id: string;
      readonly session_id: string | null;
      readonly prior_proposal: string;
      readonly answers: Readonly<Record<string, string>>;
      readonly newly_answered: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
    }) {
      // A resumed session (`--resume <session_id>`) already carries the full
      // prior proposal and prompt in its own Claude Code transcript —
      // re-pasting `input.prior_proposal` into every patch prompt was pure
      // context bloat (one of the pilot report's amplification sources).
      // Only a fresh (no prior session) patch needs it restated, since there
      // is no resumed history to draw it from.
      const resuming = input.session_id !== null;
      const prompt = [
        "Clarification answers were received for the prior task-composer proposal.",
        ...(resuming ? [] : [`Prior proposal:\n${input.prior_proposal}`]),
        `Newly answered questions:\n${JSON.stringify(input.newly_answered)}`,
        `All answers so far:\n${JSON.stringify(input.answers)}`,
        resuming
          ? "Update the task-composer proposal already in this session's history to incorporate these newly answered questions. Return only the updated raw JSON task-composer proposal. Do not inspect the repository or call tools."
          : "Return only the updated raw JSON task-composer proposal, incorporating these answers. Do not inspect the repository or call tools.",
      ].join("\n\n");
      const result = await run({
        prompt, cwd: options.cwd, model, mode: "planner", signal: input.signal,
        ...(input.session_id === null ? {} : { session_id: input.session_id }),
      });
      if (!result.ok) throw new Error(result.error);
      return {
        raw_proposal: normalizeClaudePlanText(result.text),
        session_id: result.session_id ?? input.session_id,
        model_identity: `${identityNamespace}/${model}`,
        usage: result.usage,
      };
    },
  };
}
