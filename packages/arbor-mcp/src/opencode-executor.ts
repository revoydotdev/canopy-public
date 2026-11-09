/**
 * Real-LLM loop executor for `arbor demo` — reuses the opencode CLI's configured
 * providers (OpenRouter + Z.AI keys) by shelling out to `opencode run`, exactly
 * as the external headless observer does.
 *
 * This is the "the driver itself is genuinely LLM-driven" half of the demo. The
 * deterministic executor in `demo.ts` remains for the hermetic test suite (no
 * network / no keys in tests); this executor is the default for `arbor demo`.
 *
 * Provenance honesty (Commandment I): a real-LLM result is `!claimed` — no
 * verification command has actually run. It only becomes `!verified` if an
 * explicit `verificationCmd` is provided AND that command exits 0 in the
 * worktree. We never launder an LLM answer into verified evidence.
 */
import { spawn } from "node:child_process";
import { trackChild } from "./child-registry.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { CriticCheck, CriticVerdict, NodeError, Provenance } from "@arbor/core";
import type { ChangedFile, LoopExecutor, LoopEvent, SpecialistResult, CriticResult, ReviewerRunner, ReviewerVerdict } from "@arbor/opencode";
import { FAULT_MATRIX, sanitizedGitEnv } from "@arbor/opencode";
import { AGENT_PROMPTS } from "@arbor/prompts";
import { loadConfigWithProvenance } from "@arbor/config";
import type { RuntimePortAdapter, DevtoolsStreamLine } from "./tui-adapter.js";
import { EVIDENCE_BOUND_CRITIC_POLICY } from "./critic-review-policy.js";
import { ARBOR_CRITIC_TRANSPORT_ENV, type NativeCriticPort } from "./native-critic-transport.js";
import { NATIVE_CRITIC_MALFORMED_VERDICT, nativeCriticVerdictPlaceholderField } from "./native-critic-contract.js";
import type { ContinuationCapableExecutor } from "./recovery/continuation-plan.js";
import { parseOpenCodeEventStream } from "./opencode-event-stream.js";
import {
  admitRepoFlightProviderLaunch,
  boundedHookReason,
  repoFlightProviderLaunchContext,
  reportRepoFlightProviderError,
  type RepoFlightProviderChildContext,
  type RepoFlightProviderHookLaunchContext,
  type RepoFlightProviderLifecycleHook,
} from "./integrations/repo-flight-provider-hook.js";

/**
 * WA-18: `LoopExecutor.specialize` (`@arbor/opencode`'s `loop.ts`) carries no
 * continuation/`admitted_context` parameter at all — only
 * `native-agent-executor.ts`'s own broader class queries continuation data,
 * through composition options private to that class. This executor shells
 * out to `opencode run` with a fresh prompt file per call and has no such
 * side-channel, so honestly declaring `"unsupported"` here (rather than
 * silently re-running the raw prompt and reporting `accepted: true`) is what
 * lets `RecoveryService`'s continuation dispatch (`recovery-service.ts`)
 * refuse before ever admitting a continuation that would only run through
 * this connector.
 */
export const OPENCODE_LOOP_EXECUTOR_CONNECTOR_ID = "opencode-cli-loop-executor";

export const DEFAULT_SPECIALIST_MODEL = "openrouter/~deepseek/deepseek-v4-flash-latest";
export const DEFAULT_CRITIC_MODEL = "openrouter/~openai/gpt-mini-latest";

function opencodeFlightInvocation(
  hook: RepoFlightProviderLifecycleHook | undefined,
  input: {
    readonly mode: "specialist" | "read_only" | "planner" | "critic";
    readonly cwd: string;
    readonly model: string;
    readonly campaign_id: string | null;
    readonly node_id: string | null;
    readonly task_id: string | null;
    readonly write_paths?: readonly string[];
    readonly command_argv?: readonly (readonly string[])[] | null;
  },
): { readonly hook: RepoFlightProviderLifecycleHook; readonly context: RepoFlightProviderHookLaunchContext } | undefined {
  if (hook === undefined) return undefined;
  return {
    hook,
    context: repoFlightProviderLaunchContext("opencode", {
      mode: input.mode,
      cwd: input.cwd,
      model: input.model,
      flight_governance: {
        campaign_id: input.campaign_id,
        node_id: input.node_id,
        task_id: input.task_id,
        write_paths: input.write_paths ?? [],
        command_argv: input.command_argv ?? [],
      },
    }),
  };
}

function declaredOpenCodeActionAuthority(action: unknown): {
  readonly write_paths: readonly string[];
  readonly command_argv: readonly (readonly string[])[] | null;
} {
  const record = typeof action === "object" && action !== null ? action as { high_risk_tool_scope?: unknown } : {};
  const scope = typeof record.high_risk_tool_scope === "object" && record.high_risk_tool_scope !== null
    ? record.high_risk_tool_scope as { write_paths?: unknown; command_argv?: unknown }
    : {};
  const write_paths = Array.isArray(scope.write_paths) && scope.write_paths.every((path) => typeof path === "string")
    ? scope.write_paths
    : [];
  const command_argv = Array.isArray(scope.command_argv) && scope.command_argv.every((argv) => Array.isArray(argv) && argv.every((part) => typeof part === "string"))
    ? scope.command_argv as readonly (readonly string[])[]
    : null;
  return { write_paths, command_argv };
}

async function waitForRepoFlightStoppedChild(pid: number): Promise<void> {
  // `SIGCONT` must be delivered only after the shell has executed its own
  // stop. Sending it immediately after spawn can arrive before `kill -STOP
  // $$`, leaving the subsequently-stopped child wedged forever. Linux gives
  // us the kernel process state directly; without it we refuse this guarded
  // path rather than claim an enrollment barrier we cannot observe.
  if (process.platform !== "linux") throw new Error("OpenCode Flight Control needs observable Linux process-stop state");
  const statPath = `/proc/${pid}/stat`;
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      const stat = readFileSync(statPath, "utf8");
      const closing = stat.lastIndexOf(")");
      if (closing >= 0 && stat[closing + 2] === "T") return;
    } catch {
      throw new Error("OpenCode Flight Control child exited before enrollment barrier engaged");
    }
    await new Promise<void>((resume) => setTimeout(resume, 5));
  }
  throw new Error("OpenCode Flight Control child did not reach enrollment barrier");
}

/**
 * Host fact used by both dispatch and the deployment-truth projection.  The
 * guarded OpenCode lane relies on Linux's observable stopped-process state;
 * merely having a POSIX-looking platform or shell is not enough to claim the
 * PID enrollment barrier is available.
 */
export function repoFlightOpenCodeEnrollmentBarrierAvailable(): boolean {
  return process.platform === "linux" && existsSync("/bin/sh") && existsSync("/proc/self/stat");
}

/**
 * G-33 (narrowed, wave 3): resolve `agentName`'s model from `arbor.jsonc`'s
 * `agents.*.model` (the same config key + `"auto"` sentinel semantics
 * `@arbor/opencode`'s `agents.ts`'s `resolveModel` already applies to the
 * plugin-composed opencode agents), falling back to `fallback` when no real
 * override is configured. This is the executor's own instance of the
 * resolveModel pattern — it cannot import `@arbor/opencode`'s internal
 * `resolveModel` (that package's public surface is `index.ts`, which this
 * lane does not own and which does not export it), so it reads the same
 * underlying `@arbor/config` source directly, exactly as `arbor-opencode`'s
 * `plugin.ts` does for the opencode-plugin composition root. `configDir`
 * defaults to `process.cwd()` — the same "repo root the CLI was invoked
 * from" convention `demo.ts`/`cli.ts` already use for `resolvePersistenceDir`.
 *
 * A missing `arbor.jsonc`, or a directory with none, is not an error —
 * `loadConfigWithProvenance` returns the built-in `DEFAULT_CONFIG` (every
 * agent at `"auto"`), which resolves to `fallback` here, exactly as it did
 * before this function existed.
 */
export function resolveConfiguredModel(agentName: string, configDir: string, fallback: string): string {
  const { effective } = loadConfigWithProvenance(configDir);
  const configured = effective.agents[agentName]?.model;
  return configured && configured !== "auto" ? configured : fallback;
}

export interface OpenCodeLoopExecutorOptions {
  /**
   * Specialist model. Explicit and wins over everything else (a caller's
   * deliberate runtime choice, e.g. selfhost.ts's per-plan model). Absent an
   * explicit value, the live path resolves `arbor.jsonc`'s
   * `agents.<specialist_agent>.model` (see `resolveConfiguredModel`) per
   * dispatched agent, falling back to `DEFAULT_SPECIALIST_MODEL` (OpenRouter
   * — reuses its configured key) only when neither is set.
   */
  specialistModel?: string;
  /**
   * Critic model. Same precedence as `specialistModel`, resolved against
   * `agents.lenticel.model` (the critic is always Lenticel), falling back to
   * `DEFAULT_CRITIC_MODEL` (a stable OpenRouter alias).
   */
  criticModel?: string;
  /** Path to the opencode binary. Default "opencode". */
  opencodeBin?: string;
  /** Per-call timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /**
   * Optional verification command run in the worktree after a specialist. If it
   * exits 0, provenance is `!verified` (honest — evidence actually ran).
   */
  verificationCmd?: string;
  /**
   * D4: ordered, fail-fast staged verification — each entry is one shell
   * command run in sequence, each on its own `timeoutMs` budget, stopping at
   * the first non-zero exit (mirrors `WorktreeMachineVerifier.runPlan`'s
   * staged semantics, adapted to this executor's plain shell-string
   * interface rather than its argv-only sandboxed command port — see
   * `selfhost.ts`'s `--verification-cmd` doc for why). When set, this takes
   * precedence over `verificationCmd`; a single-entry array reproduces
   * `verificationCmd`'s exact prior behavior byte-for-byte.
   */
  verificationCmds?: readonly string[];
  /**
   * Per-stage timeout for verification, independent of the specialist's own
   * budget. Verification shared `timeoutMs` — a 900s ceiling sized for a
   * model turn, not for a build. A verification command that hangs should be
   * cut off on its own terms rather than being allowed the whole specialist
   * budget a second time. Default 300s per stage.
   */
  verificationTimeoutMs?: number;
  /**
   * Directory `arbor.jsonc` is read from for `agents.*.model` overrides.
   * Default `process.cwd()` — the CLI's own working directory, same
   * convention `resolvePersistenceDir` callers already rely on.
   */
  configDir?: string;
  /**
   * Optional Repo Flight Control lifecycle hook. When supplied, every real
   * OpenCode provider child is admitted before spawn, stopped before `exec`,
   * enrolled with the exact OS PID, and only then resumed. This is deliberately
   * a subprocess boundary rather than a post-hoc event observer.
   */
  repo_flight_hook?: RepoFlightProviderLifecycleHook;
}

export interface BuildArgsInput {
  model: string;
  worktree: string | undefined;
  promptFile: string;
  instruction: string;
  opencodeBin: string;
  agent?: string;
  auto?: boolean;
  pure?: boolean;
  format?: "default" | "json";
}

/**
 * Pure, testable builder for the `opencode run` argv. Kept separate so the test
 * suite can assert the invocation without ever calling the network.
 */
export function buildOpenCodeArgs(input: BuildArgsInput): string[] {
  const args = ["run", "-m", input.model];
  if (input.pure) args.push("--pure");
  if (input.format) args.push("--format", input.format);
  if (input.worktree) args.push("--dir", input.worktree);
  if (input.auto) args.push("--auto");
  if (input.agent) args.push("--agent", input.agent);
  args.push("-f", input.promptFile, "--", input.instruction);
  return args;
}

/** Strip ANSI escape sequences from an opencode/terminal response. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Every child this module has spawned and not yet settled. `trackChild`
 * populates it at spawn time; each child's own `exit`/`error` drains its
 * entry. A single process-wide `exit` listener (installed once, lazily)
 * force-kills whatever remains.
 *
 * This is the parent-process-terminates safety net that `runOpenCode`'s own
 * timeout/abort kill logic cannot provide on its own, because both depend on
 * this process's event loop staying alive to run the timer/listener callback.
 * Verified empirically (2026-08-08, spawn with no `detached`, matching this
 * file's spawn calls exactly): a `spawn()`ed child with zero exit/signal
 * handlers registered on the parent is reparented to PID 1 and keeps running
 * forever when the parent is killed via SIGTERM, SIGINT, *or* SIGKILL. A bare
 * `process.once("exit", ...)` handler (no distinct SIGTERM/SIGINT listener)
 * closes none of those three — Node's `exit` event does not fire when a
 * process dies from an unhandled signal, only from `process.exit()` or a
 * drained event loop.
 *
 * So this registry-plus-`exit`-hook closes the "someone eventually calls
 * `process.exit()` (or the loop drains) while a child is still in flight"
 * gap — the case a single per-spawn `process.once("exit", ...)` handler
 * would also need N of, one per dispatch, which is both a listener leak
 * across a many-dispatch campaign and no more effective than one shared
 * hook. It does **not** and cannot close: (a) the parent being SIGKILLed —
 * no process can intercept SIGKILL, by kernel design; (b) a raw SIGTERM/
 * SIGINT delivered where *no* listener exists anywhere in the process — that
 * remains Node's fatal default disposition with no `exit` event. Production
 * campaign entry points (demo.ts, selfhost.ts) already forward SIGINT/SIGTERM
 * into a cooperative `AbortSignal` threaded through `params.signal`, which
 * `runOpenCode`'s own abort listener kills promptly — this registry is
 * defense-in-depth alongside that, not a replacement for it. Whatever still
 * gets through (SIGKILL, or a caller that wires neither) is what
 * `scripts/reap-orphaned-opencode.mjs` exists to report and, on explicit
 * request, reclaim.
 */
// Child lifetimes are owned by `child-registry.ts`, shared with the other two
// `opencode` spawn sites (opencode-server-executor.ts's `serve`, cli.ts's
// capability probe). All three leaked the same way; one registry means one
// exit/signal hook and one answer to "what is still running", rather than
// three private copies drifting apart.
/**
 * Run `opencode run` once and capture stdout. The long prompt is written to a
 * temp file (attached via `-f`), so we avoid fragile argv quoting. The child is
 * killed on `signal` abort and bounded by `timeoutMs`.
 */
export async function runOpenCode(params: {
  opencodeBin: string;
  args: string[];
  signal?: AbortSignal;
  /** `null` means operator-controlled: completion or AbortSignal ends it. */
  timeoutMs?: number | null;
  /** Actual working directory of this provider invocation, if distinct from the host CWD. */
  cwd?: string;
  /** A composed lifecycle hook makes admission and PID enrollment fail closed. */
  flight?: {
    readonly hook: RepoFlightProviderLifecycleHook;
    readonly context: RepoFlightProviderHookLaunchContext;
  };
}): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const timeoutMs = params.timeoutMs === undefined ? 120_000 : params.timeoutMs;
  if (params.flight !== undefined) {
    try {
      await admitRepoFlightProviderLaunch(params.flight.hook, params.flight.context);
    } catch (error) {
      const reason = boundedHookReason(error instanceof Error ? error.message : "OpenCode flight admission failed");
      const notificationError = await reportRepoFlightProviderError(params.flight.hook, {
        ...params.flight.context,
        stage: "pre_launch",
        pid: null,
        error: reason,
      });
      return {
        ok: false,
        error: `OpenCode flight admission refused: ${reason}${notificationError === null ? "" : `; flight error notification failed: ${notificationError}`}`,
      };
    }
    // A stopped shell preserves its PID across `exec`, so enrollment sees the
    // real PID that will become OpenCode while the provider has not yet read
    // the prompt file. There is no equivalent portable pre-exec stop on
    // hosts without observable Linux process-stop state; claim neither
    // partial enforcement nor a best-effort fallback.
    if (!repoFlightOpenCodeEnrollmentBarrierAvailable()) {
      const reason = "OpenCode Flight Control requires an observable Linux pre-exec enrollment barrier";
      const notificationError = await reportRepoFlightProviderError(params.flight.hook, {
        ...params.flight.context,
        stage: "pre_launch",
        pid: null,
        error: reason,
      });
      return { ok: false, error: `${reason}${notificationError === null ? "" : `; flight error notification failed: ${notificationError}`}` };
    }
  }
  const isolatedConfigDir = mkdtempSync(join(tmpdir(), "arbor-opencode-config-"));
  return await new Promise((resolve) => {
    const gated = params.flight !== undefined;
    const child = gated
      ? spawn("/bin/sh", ["-c", "kill -STOP $$; exec \"$@\"", "repo-flight-opencode-gate", params.opencodeBin, ...params.args], {
          cwd: params.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, OPENCODE_CONFIG_DIR: isolatedConfigDir },
        })
      : spawn(params.opencodeBin, params.args, {
          stdio: ["ignore", "pipe", "pipe"],
          // Provider credentials live in OpenCode's data store, not its config
          // directory. Keep authentication, but exclude user/global agents,
          // instructions, and plugins from governed Revoy roles.
          env: { ...process.env, OPENCODE_CONFIG_DIR: isolatedConfigDir },
        });
    trackChild(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let enrolled = !gated;
    let terminalReported = false;
    let abortReported = false;
    let closedBeforeEnrollment = false;
    const settle = (r: { ok: true; stdout: string } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      rmSync(isolatedConfigDir, { recursive: true, force: true });
      resolve(r);
    };
    const reportError = (stage: "post_spawn" | "spawn" | "terminal", error: string): void => {
      if (params.flight === undefined) return;
      void reportRepoFlightProviderError(params.flight.hook, {
        ...params.flight.context,
        stage,
        pid: child.pid ?? null,
        error,
      });
    };
    const reportAbort = (reason: "caller_abort" | "timeout" | "output_limit" | "admission_refused"): void => {
      if (params.flight === undefined || abortReported) return;
      abortReported = true;
      const pid = child.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return;
      const context: RepoFlightProviderChildContext = { ...params.flight.context, pid };
      void Promise.resolve(params.flight.hook.abort?.({ ...context, reason })).catch(() => {});
    };
    const reportTerminal = async (code: number | null, signal: string | null): Promise<string | null> => {
      if (params.flight === undefined || terminalReported) return null;
      terminalReported = true;
      const pid = child.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return "OpenCode terminal child PID was unavailable";
      try {
        await params.flight.hook.terminal?.({ ...params.flight.context, pid, code, signal });
        return null;
      } catch (error) {
        return boundedHookReason(error instanceof Error ? error.message : "OpenCode flight terminal notification failed");
      }
    };
    child.stdout?.on("data", (d) => { stdout += String(d); });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    const timer = timeoutMs === null ? null : setTimeout(() => {
      reportAbort("timeout");
      reportError("post_spawn", `OpenCode execution timed out after ${timeoutMs}ms`);
      child.kill("SIGKILL");
      settle({ ok: false, error: `opencode run timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    const onAbort = (): void => {
      reportAbort("caller_abort");
      reportError("post_spawn", "OpenCode execution was cancelled");
      child.kill("SIGKILL");
      settle({ ok: false, error: "opencode run aborted" });
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      if (timer !== null) clearTimeout(timer);
      reportAbort("admission_refused");
      reportError("spawn", `OpenCode spawn failed: ${e.message}`);
      settle({ ok: false, error: `opencode spawn failed: ${e.message}` });
    });
    child.on("close", (code, signal) => {
      if (timer !== null) clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
      if (!enrolled) closedBeforeEnrollment = true;
      void (async () => {
        const terminalError = await reportTerminal(code, signal);
        if (terminalError !== null) {
          reportError("terminal", `OpenCode flight terminal notification failed: ${terminalError}`);
          settle({ ok: false, error: `OpenCode flight terminal notification failed: ${terminalError}` });
        } else if (!enrolled) {
          settle({ ok: false, error: "OpenCode exited before Flight Control enrollment completed" });
        } else if (code !== 0) {
          settle({ ok: false, error: `opencode run exited ${code}: ${stripAnsi(stderr).slice(0, 300)}` });
        } else {
          settle({ ok: true, stdout: stripAnsi(stdout) });
        }
      })();
    });
    if (params.flight !== undefined) {
      const flight = params.flight;
      void (async () => {
        const pid = child.pid;
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
          const reason = "OpenCode spawn did not expose an OS child PID";
          reportError("spawn", reason);
          try { child.kill("SIGKILL"); } catch { /* process was never killable */ }
          settle({ ok: false, error: reason });
          return;
        }
        try {
          await waitForRepoFlightStoppedChild(pid);
          await flight.hook.enroll_child?.({ ...flight.context, pid });
          if (settled || closedBeforeEnrollment) {
            try { child.kill("SIGKILL"); } catch { /* process already ended */ }
            settle({ ok: false, error: "OpenCode exited before Flight Control enrollment completed" });
            return;
          }
          enrolled = true;
          if (!child.kill("SIGCONT")) throw new Error("OpenCode Flight Control could not resume the enrolled child");
        } catch (error) {
          const reason = boundedHookReason(error instanceof Error ? error.message : "OpenCode flight enrollment failed");
          reportAbort("admission_refused");
          reportError("post_spawn", `OpenCode flight enrollment refused: ${reason}`);
          try { child.kill("SIGKILL"); } catch { /* process already ended */ }
          settle({ ok: false, error: `OpenCode flight enrollment refused: ${reason}` });
        }
      })();
    }
  });
}

/** Write the prompt to a temp file; returns { path, cleanup }. */
function tempPromptFile(prompt: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "arbor-demo-prompt-"));
  const path = join(dir, "prompt.txt");
  writeFileSync(path, prompt, "utf8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Closed result of parsing a critic's response: a real verdict, or a typed absence of one. */
export type ParsedCriticVerdict =
  | { kind: "verdict"; verdict: CriticVerdict }
  | { kind: "unparseable"; raw_hash: string }
  /** Verdict-shaped but its prose is placeholder/template text (ADR-184): malformed output, never a rejection of the work. */
  | { kind: "malformed"; field: string; raw_hash: string };

/** Content hash of a raw critic response, used to anchor an unparseable verdict without approving it. */
export function rawResponseHash(raw: string): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/**
 * Classify a failed `runOpenCode` result into the closed `NodeError` union
 * (G-08). Before this, a spawn error, a timeout, and a non-zero exit were all
 * flattened into the same `[opencode error] ...` text glued onto `output` —
 * none of the six operational `NodeErrorKind`s (besides
 * `context_window_exceeded`, built elsewhere) had a production construction
 * site. This is that site for the subprocess transport.
 *
 * `externalSignalAborted` excludes genuine cancellation: the loop's own
 * `throwIfAborted` already turns an external abort into the campaign's
 * cancellation report, so classifying it again here would double-report the
 * same event as a fabricated operational error.
 */
export function classifyOpenCodeError(error: string, externalSignalAborted: boolean): NodeError | undefined {
  if (externalSignalAborted || error === "opencode run aborted") return undefined;
  const provenance: Provenance = { tag: "claimed", claimant: "opencode-executor" };
  const timeoutMatch = error.match(/^opencode run timed out after (\d+)ms$/);
  if (timeoutMatch) {
    return {
      kind: "timeout", provenance, message: error,
      elapsed_ms: Number(timeoutMatch[1]),
      partial_output: null,
      usage: { kind: "unavailable", reason: "opencode subprocess was killed on timeout before usage was reported" },
    };
  }
  if (error.startsWith("opencode spawn failed:")) {
    return { kind: "internal_error", recoverable: FAULT_MATRIX.internal_error.recovery === "retry", provenance, message: error };
  }
  const exitMatch = error.match(/^opencode run exited (-?\d+): ([\s\S]*)$/);
  if (exitMatch) {
    const stderrExcerpt = exitMatch[2] ?? "";
    if (/rate.?limit|quota|429|too many requests/i.test(stderrExcerpt)) {
      return { kind: "quota_exceeded", provenance, message: error };
    }
    if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network error|socket hang up/i.test(stderrExcerpt)) {
      return { kind: "transport_error", recoverable: FAULT_MATRIX.transport_error.recovery === "retry", provenance, message: error };
    }
    return { kind: "internal_error", recoverable: FAULT_MATRIX.internal_error.recovery === "retry", provenance, message: error };
  }
  // Unrecognized process failure shape — still a real, typed absence rather
  // than silent text, but with no basis to claim recoverability either way.
  return { kind: "internal_error", recoverable: false, provenance, message: error };
}

/**
 * The review result for a placeholder-text verdict. It carries `error`, so the
 * loop parks the node `awaiting_review` with the candidate kept instead of
 * recording the work as rejected; the root cause names it as malformed output.
 */
export function malformedCriticVerdictFailure(criticName: string, verdict: Extract<ParsedCriticVerdict, { kind: "malformed" }>): { approved: false; rationale: string; root_cause: string; severity: "high"; error: NodeError } {
  const message = `${criticName} verdict malformed: ${verdict.field} holds placeholder or template text (raw response ${verdict.raw_hash})`;
  return {
    approved: false,
    rationale: message,
    root_cause: NATIVE_CRITIC_MALFORMED_VERDICT,
    severity: "high",
    error: { kind: "internal_error", recoverable: false, provenance: { tag: "claimed", claimant: "opencode-executor" }, message },
  };
}

/**
 * Parse a strict JSON verdict from a critic's response. An unparseable
 * response is absence of evidence, not approval (G-15): the caller must fail
 * closed, never default to `approved: true`.
 */
export function parseCriticVerdict(raw: string, critic = "lenticel"): ParsedCriticVerdict {
  const cleaned = stripAnsi(raw);
  const start = cleaned.indexOf("{");
  if (start < 0) return { kind: "unparseable", raw_hash: rawResponseHash(raw) };
  const end = cleaned.lastIndexOf("}");
  if (end <= start) return { kind: "unparseable", raw_hash: rawResponseHash(raw) };
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const checkNames = ["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"] as const;
    // X-2 (bench v4 regression): `completeness` is an OPTIONAL sixth check —
    // the instruction invites it, so a critic that complies must not have
    // its whole verdict thrown away by a hard `length === 5`. The five
    // canonical mandates stay required; this mirrors the native contract's
    // own optional-check handling exactly.
    const optionalCheckNames = ["completeness"] as const;
    const allowedCheckNames: readonly string[] = [...checkNames, ...optionalCheckNames];
    if (typeof parsed.approved !== "boolean" || typeof parsed.rationale !== "string" || !parsed.rationale.trim()
      || typeof parsed.measurement_validated !== "boolean" || typeof parsed.guardrails_enforced !== "boolean"
      || typeof parsed.introspection_passed !== "boolean" || typeof parsed.stability_ok !== "boolean"
      || !Array.isArray(parsed.checks) || parsed.checks.length < checkNames.length
      || parsed.checks.length > checkNames.length + optionalCheckNames.length) {
      return { kind: "unparseable", raw_hash: rawResponseHash(raw) };
    }
    const checks: CriticCheck[] = [];
    const seen = new Set<string>();
    for (const rawCheck of parsed.checks) {
      if (typeof rawCheck !== "object" || rawCheck === null) return { kind: "unparseable", raw_hash: rawResponseHash(raw) };
      const check = rawCheck as Record<string, unknown>;
      if (!allowedCheckNames.includes(check.name as string) || seen.has(check.name as string)
        || typeof check.passed !== "boolean" || typeof check.detail !== "string" || !check.detail.trim()) {
        return { kind: "unparseable", raw_hash: rawResponseHash(raw) };
      }
      seen.add(check.name as string);
      checks.push({ name: check.name as CriticCheck["name"], passed: check.passed, detail: check.detail });
    }
    if (!checkNames.every((name) => seen.has(name)) || (parsed.approved === false && (typeof parsed.root_cause !== "string" || !parsed.root_cause.trim()))) {
      return { kind: "unparseable", raw_hash: rawResponseHash(raw) };
    }
    // Same classifier as the native contract (ADR-184), not a copy of its word list.
    const placeholderField = nativeCriticVerdictPlaceholderField(parsed);
    if (placeholderField !== null) return { kind: "malformed", field: placeholderField, raw_hash: rawResponseHash(raw) };
    return {
      kind: "verdict",
      verdict: {
        approved: parsed.approved,
        critic,
        rationale: parsed.rationale,
        root_cause: typeof parsed.root_cause === "string" && parsed.root_cause.trim() ? parsed.root_cause : undefined,
        measurement_validated: parsed.measurement_validated,
        guardrails_enforced: parsed.guardrails_enforced,
        introspection_passed: parsed.introspection_passed,
        stability_ok: parsed.stability_ok,
        checks,
      },
    };
  } catch {
    return { kind: "unparseable", raw_hash: rawResponseHash(raw) };
  }
}

/**
 * Build the real subprocess-backed reviewer adapter used by every production
 * panel.  This lives beside the single-critic executor so panel reviewers use
 * the same argv construction, response parser, failure classification, child
 * lifecycle, and configured Lenticel model as a normal critic dispatch.
 *
 * The loop gives panel reviewers bounded action and captured candidate evidence.
 * This adapter never treats the specialist summary as verification. A
 * failed or unparseable reviewer response is a high-severity rejection, never
 * an approval-by-default.
 */
export function createOpenCodePanelReviewer(
  adapter: RuntimePortAdapter,
  campaignId: string,
  options: {
    criticModel?: string;
    opencodeBin?: string;
    timeoutMs?: number;
    configDir?: string;
    /** A distinct marker keeps deterministic demo evidence separate from real dispatch evidence. */
    devtoolsTool?: string;
    /**
     * PERF: same single-call native fast path claude-code-campaign.ts wires
     * for its critic (see native-critic-transport.ts) — gated on the same
     * `ARBOR_CRITIC_TRANSPORT=native` env var and `.ready`, with the same
     * fallback-on-error contract: absent, not ready, or an erroring native
     * call all fall back to the unchanged `opencode run` dispatch below.
     */
    native_critic?: NativeCriticPort;
    /** Optional fail-closed Repo Flight Control lifecycle seam. */
    repo_flight_hook?: RepoFlightProviderLifecycleHook;
  } = {},
): ReviewerRunner {
  const opencodeBin = options.opencodeBin ?? "opencode";
  const timeoutMs = options.timeoutMs ?? 120_000;
  const configDir = options.configDir ?? process.cwd();
  const devtoolsTool = options.devtoolsTool ?? "opencode.panel_review";
  const useNativeCritic = process.env[ARBOR_CRITIC_TRANSPORT_ENV]?.trim() === "native";
  const nativeCritic = options.native_critic;
  return async (criticName, ctx): Promise<ReviewerVerdict> => {
    // Abstract panel catalog hints are not provider-qualified integration
    // identities. Resolve every independent reviewer session through the
    // OpenCode integration's configured critic model instead of passing a
    // potentially unavailable `anthropic/...` hint to the selected provider.
    const model = options.criticModel ?? resolveConfiguredModel("lenticel", configDir, DEFAULT_CRITIC_MODEL);
    const candidatePatch = ctx.worktree_path === undefined
      ? "unavailable"
      : await captureWorktreeDiff(ctx.worktree_path, Math.min(timeoutMs, 30_000)).then((diff) => diff.ok
          ? `${diff.text.slice(0, 65_536)}${diff.text.length > 65_536 ? "\n[patch truncated by harness at 65536 characters]" : ""}`
          : "unavailable");
    const reviewInstruction =
      `You are the ${criticName} reviewer on revoy2's panel of critics. You are approval-biased but evidence-bound. Review the action described below for ${criticName}-domain concerns. ${EVIDENCE_BOUND_CRITIC_POLICY} Do not call tools. ` +
      `Apply each mandate check for relevance: when a check is not applicable to this action and risk level, mark it passed and explain why it is not applicable. Security and stability checks require additional proof only when the action is high-stakes or a concrete risk in the supplied change makes them relevant. A rejection must set root_cause to the specific observed defect or requirement gap; vague requests for more assurance are not a valid rejection. Respond with ONLY a JSON object: ` +
      '{"approved":true|false,"rationale":"...","root_cause":"required non-empty on rejection","measurement_validated":true|false,"guardrails_enforced":true|false,"introspection_passed":true|false,"stability_ok":true|false,"checks":[{"name":"root_cause","passed":true|false,"detail":"..."},{"name":"measurement_validation","passed":true|false,"detail":"..."},{"name":"guardrail_enforcement","passed":true|false,"detail":"..."},{"name":"introspection","passed":true|false,"detail":"..."},{"name":"stability_monitoring","passed":true|false,"detail":"..."}]}.';
    const reviewBody = `Action category: ${ctx.action_category}\nHigh stakes: ${ctx.high_stakes}\nDescription: ${ctx.description}\nSpecialist candidate:\n${ctx.specialist_output ?? "unavailable"}\nCandidate patch (harness-captured, bounded):\n${candidatePatch}\nMachine verification:\n${ctx.verification_note || "not observed"}`;
    if (useNativeCritic && nativeCritic !== undefined && nativeCritic.ready) {
      const t0 = Date.now();
      const result = await nativeCritic.call(`${reviewInstruction}\n\n${reviewBody}`);
      const durationMs = Date.now() - t0;
      if (result.ok) {
        adapter.pushDevtoolsLine({
          seq: 0, ts: new Date().toISOString(), event_kind: "loop.tool_call",
          campaign_id: campaignId, node_id: null, synthetic: false,
          loop_event: { type: "tool_call", tool: devtoolsTool, args: `${criticName} · native/${nativeCritic.model_id ?? "unknown"}`, ok: true, duration_ms: durationMs, stdout: result.text.slice(0, 300) } as never,
        });
        const verdict = parseCriticVerdict(result.text, criticName);
        if (verdict.kind === "verdict") {
          return { approved: verdict.verdict.approved, rationale: verdict.verdict.rationale, root_cause: verdict.verdict.root_cause, verdict: verdict.verdict };
        }
        if (verdict.kind === "malformed") return malformedCriticVerdictFailure(criticName, verdict);
        // Same rule as the CLI arm below: an unreadable answer is a typed
        // absence of a verdict, never a rejection of the work.
        return {
          approved: false,
          rationale: `${criticName} native verdict unparseable (raw response ${verdict.raw_hash})`,
          root_cause: "unparseable_critic_verdict",
          severity: "high",
          error: {
            kind: "internal_error",
            recoverable: false,
            provenance: { tag: "claimed", claimant: "opencode-executor" },
            message: `${criticName} native verdict unparseable (raw response ${verdict.raw_hash})`,
          },
        };
      }
      // Fall back to the CLI critic path below; never fail a review because the fast path errored.
    }
    const { path, cleanup } = tempPromptFile(reviewBody);
    try {
      const args = buildOpenCodeArgs({
        model,
        worktree: undefined,
        promptFile: path,
        instruction: reviewInstruction,
        opencodeBin,
        pure: true,
      });
      const t0 = Date.now();
      const res = await runOpenCode({
        opencodeBin,
        args,
        timeoutMs,
        cwd: ctx.worktree_path ?? configDir,
        flight: opencodeFlightInvocation(options.repo_flight_hook, {
          mode: "critic",
          cwd: ctx.worktree_path ?? configDir,
          model,
          campaign_id: campaignId,
          node_id: null,
          task_id: null,
        }),
      });
      const durationMs = Date.now() - t0;
      adapter.pushDevtoolsLine({
        seq: 0, ts: new Date().toISOString(), event_kind: "loop.tool_call",
        campaign_id: campaignId, node_id: null, synthetic: false,
        loop_event: {
          type: "tool_call", tool: devtoolsTool, args: `${criticName} · ${model}`,
          ok: res.ok, duration_ms: durationMs,
          stdout: (res.ok ? res.stdout : res.error).slice(0, 300),
        } as never,
      });
      const verdict = parseCriticVerdict(res.ok ? res.stdout : res.error, criticName);
      if (verdict.kind === "verdict") {
        return {
          approved: verdict.verdict.approved,
          rationale: verdict.verdict.rationale,
          root_cause: verdict.verdict.root_cause,
          verdict: verdict.verdict,
        };
      }
      if (verdict.kind === "malformed") return malformedCriticVerdictFailure(criticName, verdict);
      // Neither of these is a verdict, and returning one as `approved: false`
      // was recording a network failure as "the critic reviewed this and
      // rejected it". Report the typed absence instead and let the loop's
      // containment path park the node `awaiting_review` with the
      // specialist's candidate intact.
      //
      // The two arms are distinguished because they are different failures:
      // the transport never reached the critic, versus the critic answered
      // and the harness could not read it. Both are operational, neither is
      // a judgement about the work.
      const classifiedError = res.ok ? undefined : classifyOpenCodeError(res.error, false);
      if (classifiedError !== undefined) {
        return {
          approved: false,
          rationale: `${criticName} dispatch failed (${classifiedError.kind}): ${classifiedError.message}`,
          root_cause: classifiedError.kind,
          severity: "high",
          error: classifiedError,
        };
      }
      return {
        approved: false,
        rationale: `${criticName} verdict unparseable (raw response ${verdict.raw_hash})`,
        root_cause: "unparseable_critic_verdict",
        severity: "high",
        error: {
          kind: "internal_error",
          recoverable: false,
          provenance: { tag: "claimed", claimant: "opencode-executor" },
          message: `${criticName} verdict unparseable (raw response ${verdict.raw_hash})`,
        },
      };
    } finally {
      cleanup();
    }
  };
}

/**
 * Build a LoopExecutor whose specialize + review call real opencode agents,
 * reusing the opencode config's OpenRouter / Z.AI credentials.
 */
export function createOpenCodeLoopExecutor(
  adapter: RuntimePortAdapter,
  devtoolsHook: (loop: unknown) => void,
  campaignId: string,
  options: OpenCodeLoopExecutorOptions & {
    opencodeBin?: string;
    timeoutMs?: number;
    verificationCmd?: string;
  } = {},
): LoopExecutor & ContinuationCapableExecutor {
  const opencodeBin = options.opencodeBin ?? "opencode";
  const configDir = options.configDir ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 120_000;
  // Interactive specialists run like a normal harness: no arbitrary provider
  // deadline. Explicit callers can still supply a bounded timeoutMs, and the
  // enclosing native session remains cooperatively abortable.
  const specialistTimeoutMs = options.timeoutMs ?? null;
  const verificationTimeoutMs = options.verificationTimeoutMs ?? 300_000;
  // D4: verificationCmds (repeatable) takes precedence; a bare verificationCmd
  // degrades to a one-stage array, reproducing prior behavior exactly.
  const verificationCmds = options.verificationCmds ?? (options.verificationCmd ? [options.verificationCmd] : undefined);

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

  return {
    connector_id: OPENCODE_LOOP_EXECUTOR_CONNECTOR_ID,
    continuation_support: "unsupported",
    async specialize(params): Promise<SpecialistResult> {
      const { path, cleanup } = tempPromptFile(params.prompt);
      try {
        const specialistModel =
          options.specialistModel ??
          resolveConfiguredModel(params.specialist_agent, configDir, DEFAULT_SPECIALIST_MODEL);
        const hasWorktree = params.worktree_path && params.worktree_path.length > 0;
        const botanicalPrompt = AGENT_PROMPTS[params.specialist_agent as keyof typeof AGENT_PROMPTS];
        const baseInstruction = botanicalPrompt
          ? `${botanicalPrompt()}\n\nTask context is in the attached file.`
          : "You are a specialist in revoy2. Read the task in the attached file.";
        const instruction = hasWorktree
          ? `${baseInstruction} You are working in an isolated git worktree at ${params.worktree_path}. Make the necessary file changes to complete the task. Use the edit/write/bash tools as needed. Output ONLY a summary of what you changed.`
          : `${baseInstruction} Produce your deliverable (a plan/answer/summary). Do NOT modify or execute files. Output ONLY your deliverable text.`;

        const args = buildOpenCodeArgs({
          model: specialistModel,
          worktree: params.worktree_path || undefined,
          auto: hasWorktree ? true : undefined,
          promptFile: path,
          instruction,
          opencodeBin,
          pure: true,
          // Ask for the raw event stream rather than the rendered transcript.
          // With `--format default` the whole specialist turn was opaque: the
          // harness saw one blob of stdout after exit and could not name a
          // single command the agent ran, which is why the cockpit showed no
          // commands at all. The stream carries each tool call with its
          // input, exit code and timing.
          format: "json",
        });
        const t0 = Date.now();
        const authority = declaredOpenCodeActionAuthority(params.action);
        const providerCwd = params.worktree_path || configDir;
        const res = await runOpenCode({
          opencodeBin,
          args,
          signal: params.signal,
          timeoutMs: specialistTimeoutMs,
          cwd: providerCwd,
          flight: opencodeFlightInvocation(options.repo_flight_hook, {
            mode: hasWorktree ? "specialist" : "read_only",
            cwd: providerCwd,
            model: specialistModel,
            campaign_id: campaignId,
            node_id: params.node_id,
            task_id: params.node_id,
            ...authority,
          }),
        });
        const durationMs = Date.now() - t0;

        // Switching formats also changes where the deliverable lives: it is
        // no longer the raw stdout but the stream's `text` parts. A response
        // that is not an event stream at all — an older binary, a changed
        // format, a plain error dump — falls back to the previous behaviour
        // rather than parsing a real answer into nothing.
        const stream = res.ok ? parseOpenCodeEventStream(res.stdout) : undefined;
        const parsedAnswer = stream !== undefined && stream.eventCount > 0
          ? stream.answerText
          : undefined;
        const output = res.ok
          ? (parsedAnswer !== undefined && parsedAnswer !== ""
              ? parsedAnswer
              : (stream !== undefined && stream.eventCount > 0
                  // A turn that only ran tools and said nothing is a real
                  // outcome, not an empty result with no explanation.
                  ? `(no summary text; ${stream.commands.length} tool call(s) observed)`
                  : res.stdout.trim()))
          : `[opencode error] ${res.error}`;

        // One ledger line per command the agent actually ran, reusing the
        // existing `loop.tool_call` shape so every current consumer keeps
        // working; `exit` and `command` are additive.
        for (const command of stream?.commands ?? []) {
          adapter.pushDevtoolsLine({
            seq: 0,
            ts: new Date(command.startedAtMs ?? Date.now()).toISOString(),
            event_kind: "loop.tool_call",
            campaign_id: campaignId, node_id: params.node_id, synthetic: false,
            loop_event: {
              type: "tool_call",
              tool: command.tool,
              args: command.summary,
              ok: command.ok ?? undefined,
              duration_ms: command.durationMs ?? 0,
              stdout: command.output.slice(0, 300),
              exit: command.exit,
              command: command.input,
            } as never,
          });
        }

        adapter.pushDevtoolsLine({
          seq: 0, ts: new Date().toISOString(),
          event_kind: "loop.tool_call",
          campaign_id: campaignId, node_id: params.node_id,
          synthetic: false,
          loop_event: {
            type: "tool_call",
            tool: "opencode.run",
            args: `${params.specialist_agent} · ${specialistModel}`,
            ok: res.ok,
            duration_ms: durationMs,
            stdout: output.slice(0, 300),
          } as never,
        });

        // 4F.12: capture the specialist's worktree edits as a real git diff so
        // the operator SEES the code changes the agent made, not just a summary.
        let observedPaths: string[] = [];
        let changedFiles: readonly ChangedFile[] = [];
        if (hasWorktree && params.worktree_path) {
          const [diff, changes] = await Promise.all([
            captureWorktreeDiff(params.worktree_path, timeoutMs),
            captureWorktreeChanges(params.worktree_path, timeoutMs),
          ]);
          changedFiles = changes.ok ? changes.files : [];
          if (diff.ok) {
            observedPaths = diff.paths;
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
            ok: res.ok,
            prompt_length: params.prompt.length,
            response_length: res.ok ? res.stdout.length : 0,
            response_preview: output.slice(0, 500),
            response_full: output,
          } as never,
        });

        let provenance: Provenance;
        let verificationEvidence: string | undefined;
        if (verificationCmds && verificationCmds.length > 0 && hasWorktree) {
          const verified = await runStagedVerification(verificationCmds, params.worktree_path, verificationTimeoutMs);
          provenance = verified.ok
            // The exit code is read from the last stage that actually ran,
            // not hardcoded: a provenance field naming an exit code must be
            // evidence of that exit code.
            ? { tag: "verified", cmd: verified.combinedCmd, exit: verified.stageResults.at(-1)?.exit ?? 0, stdout_hash: verified.stdout_hash, check: { kind: "shell_command", breadth: verified.stageResults.length > 1 ? "subset" : "single" } }
            : { tag: "claimed", claimant: params.specialist_agent };
          if (verified.ok) {
            const stageSummary = verified.stageResults.map((s) => `[stage ${s.kind} exit=${s.exit} ${s.duration_ms}ms] ${s.display}`).join("\n");
            verificationEvidence = `${stageSummary}\n${verified.stdout}\n${verified.stderr}\n${observedPaths.join("\n")}\nexit code ${verified.stageResults.at(-1)?.exit ?? 0}`;
          }
        } else {
          provenance = { tag: "claimed", claimant: params.specialist_agent };
        }
        const error = res.ok ? undefined : classifyOpenCodeError(res.error, Boolean(params.signal?.aborted));
        return {
          output: output || `(no output from ${specialistModel})`,
          provenance,
          model_identity: specialistModel,
          ...(verificationEvidence === undefined ? {} : { verification_evidence: verificationEvidence }),
          token_usage: { kind: "unavailable", reason: "opencode-executor shells out to `opencode run`; provider usage cannot be recovered from stdout" },
          ...(changedFiles.length === 0 ? {} : { changed_files: changedFiles }),
          ...(error ? { error } : {}),
        };
      } finally {
        cleanup();
      }
    },

    async review(params): Promise<CriticResult> {
      const { path, cleanup } = tempPromptFile(params.prompt);
      try {
        const criticModel =
          options.criticModel ?? resolveConfiguredModel("lenticel", configDir, DEFAULT_CRITIC_MODEL);
        const args = buildOpenCodeArgs({
          model: criticModel,
          worktree: undefined,
          promptFile: path,
          instruction:
            "You are Lenticel, an APPROVAL-BIASED critic in revoy2. Review the specialist output and task in " +
            "the attached file. Respond with ONLY a JSON object: " +
            '{"approved":true|false,"rationale":"...","root_cause":"required non-empty on rejection","measurement_validated":true|false,"guardrails_enforced":true|false,"introspection_passed":true|false,"stability_ok":true|false,"checks":[{"name":"root_cause","passed":true|false,"detail":"..."},{"name":"measurement_validation","passed":true|false,"detail":"..."},{"name":"guardrail_enforcement","passed":true|false,"detail":"..."},{"name":"introspection","passed":true|false,"detail":"..."},{"name":"stability_monitoring","passed":true|false,"detail":"..."}]}. ' +
            "Reject only verified blockers.",
          opencodeBin,
          pure: true,
        });
        const t0 = Date.now();
        const res = await runOpenCode({
          opencodeBin,
          args,
          signal: params.signal,
          timeoutMs,
          cwd: configDir,
          flight: opencodeFlightInvocation(options.repo_flight_hook, {
            mode: "critic",
            cwd: configDir,
            model: criticModel,
            campaign_id: campaignId,
            node_id: params.node_id,
            task_id: params.node_id,
          }),
        });
        const durationMs = Date.now() - t0;

        adapter.pushDevtoolsLine({
          seq: 0, ts: new Date().toISOString(),
          event_kind: "loop.tool_call",
          campaign_id: campaignId, node_id: params.node_id,
          synthetic: false,
          loop_event: {
            type: "tool_call",
            tool: "opencode.run",
            args: `lenticel · ${criticModel}`,
            ok: res.ok,
            duration_ms: durationMs,
            stdout: (res.ok ? res.stdout : res.error).slice(0, 300),
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
            ok: res.ok,
            prompt_length: params.prompt.length,
            response_length: res.ok ? res.stdout.length : 0,
            response_preview: (res.ok ? res.stdout : res.error).slice(0, 500),
          } as never,
        });

        const verdict = parseCriticVerdict(res.ok ? res.stdout : res.error, "lenticel");
        const noUsage = { kind: "unavailable" as const, reason: "opencode-executor shells out to `opencode run`; provider usage cannot be recovered from stdout" };
        if (verdict.kind === "verdict") {
          return {
            approved: verdict.verdict.approved,
            rationale: verdict.verdict.rationale,
            root_cause: verdict.verdict.root_cause,
            critic_agent: "lenticel",
            measurement_validated: verdict.verdict.measurement_validated,
            verdict: verdict.verdict,
            token_usage: noUsage,
            model_identity: criticModel,
          };
        }
        if (verdict.kind === "malformed") {
          const failure = malformedCriticVerdictFailure("Critic", verdict);
          return { approved: false, rationale: failure.rationale, root_cause: failure.root_cause, critic_agent: "lenticel", measurement_validated: false, token_usage: noUsage, model_identity: criticModel, error: failure.error };
        }
        // Fail closed (G-15): an unparseable verdict is absence of evidence, not
        // approval. The prior "approval-biased fallback" inverted evidence-before
        // -state; a critic that cannot be read must reject, not wave the node through.
        // G-08: when the dispatch itself failed (not merely an unparseable but
        // present response), classify it into the closed NodeError union
        // instead of the generic "unparseable_critic_verdict" mislabel — the
        // critic was never reached at all, which is a different fact than
        // "it answered but not in the expected shape".
        const classifiedError = res.ok ? undefined : classifyOpenCodeError(res.error, Boolean(params.signal?.aborted));
        return {
          approved: false,
          rationale: classifiedError
            ? `Critic dispatch failed (${classifiedError.kind}): ${classifiedError.message}`
            : `Critic verdict unparseable (raw response ${verdict.raw_hash}): ${res.ok ? "no JSON verdict in response" : res.error}`,
          root_cause: classifiedError ? classifiedError.kind : "unparseable_critic_verdict",
          critic_agent: "lenticel",
          measurement_validated: false,
          token_usage: noUsage,
          model_identity: criticModel,
          ...(classifiedError ? { error: classifiedError } : {}),
        };
      } finally {
        cleanup();
      }
    },

    log,
  };
}

/**
 * How a verification attempt ended.
 *
 * Only `failed` says anything about the specialist's work. The other three
 * are harness conditions: the command could not be started, it never
 * finished, or the worktree it was supposed to run in was gone. Collapsing
 * all four into one `{ ok: false }` — as this did — made a broken harness
 * indistinguishable from a failing test suite, and both of them silently
 * indistinguishable from a run where verification was never configured.
 */
export type VerificationOutcomeKind = "passed" | "failed" | "spawn_failed" | "timed_out" | "worktree_missing";

export interface VerificationOutcome {
  /** True only for `passed`. Retained so existing call sites read unchanged. */
  readonly ok: boolean;
  readonly kind: VerificationOutcomeKind;
  /** The process's real exit code, or null when it never produced one. */
  readonly exit: number | null;
  readonly stdout_hash: string;
  readonly stdout: string;
  /** Captured separately: most toolchains report their diagnostics here. */
  readonly stderr: string;
  readonly duration_ms: number;
  /** Populated for the three non-`failed` failure kinds. */
  readonly message?: string;
}

/**
 * Cap on captured output per stream. A verification command is expected to
 * report a result, not stream a corpus; an unbounded capture let a runaway
 * command hold megabytes of text alive per stage (empirically 5MB in one
 * test) purely to be hashed and discarded. Truncation is recorded in the
 * captured text so the hash anchors something whose boundary is visible.
 */
const VERIFICATION_OUTPUT_LIMIT_BYTES = 1_000_000;

/**
 * Run a verification command in a worktree. Captures stdout so a genuine
 * `verified` claim can carry a real content anchor (`stdout_hash`) instead of
 * an unhashed pass/fail boolean, and stderr so a failure carries a readable
 * reason.
 *
 * Draining stderr is not merely for diagnostics: it was piped and never read,
 * so once the OS pipe buffer filled, a chatty command blocked on write and
 * only the timeout ended it — a verification that "hung" because the harness
 * stopped listening.
 */
export async function runVerification(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<VerificationOutcome> {
  const started = Date.now();
  // A non-empty string is not a worktree. `WorktreeMachineVerifier` already
  // validates existence before spawning; this path checked only for a
  // non-empty string, so a worktree removed between dispatch and
  // verification produced an ENOENT that collapsed into a bare failure.
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return {
      ok: false, kind: "worktree_missing", exit: null,
      stdout_hash: `sha256:${createHash("sha256").update("").digest("hex")}`,
      stdout: "", stderr: "", duration_ms: Date.now() - started,
      message: `verification worktree does not exist: ${cwd}`,
    };
  }
  return await new Promise((resolve) => {
    const child = spawn(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: true });
    trackChild(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current: string, chunk: string): string =>
      current.length >= VERIFICATION_OUTPUT_LIMIT_BYTES
        ? current
        : (current + chunk).slice(0, VERIFICATION_OUTPUT_LIMIT_BYTES);
    const hashOf = (): string => `sha256:${createHash("sha256").update(stdout).digest("hex")}`;
    const settle = (kind: VerificationOutcomeKind, exit: number | null, message?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: kind === "passed", kind, exit, stdout_hash: hashOf(), stdout, stderr,
        duration_ms: Date.now() - started, ...(message === undefined ? {} : { message }),
      });
    };
    child.stdout?.on("data", (d) => { stdout = append(stdout, String(d)); });
    child.stderr?.on("data", (d) => { stderr = append(stderr, String(d)); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle("timed_out", null, `verification command exceeded ${timeoutMs}ms: ${cmd}`);
    }, timeoutMs);
    child.on("error", (err) => { settle("spawn_failed", null, `verification command could not be spawned: ${err.message}`); });
    // `shell: true` means the shell always starts, so a missing binary never
    // reaches the `error` handler above — it comes back as the shell's own
    // exit 127. POSIX shells reserve 127 for "command not found", and a
    // verification command is harness-configured, so a typo in
    // `--verification-cmd` reading as "the code failed verification" would be
    // a false accusation against the specialist's work. Classified as a
    // harness fault instead. (A suite that itself exits 127 is
    // indistinguishable here; that is a limit of running a shell string, and
    // the stderr capture above is what makes it diagnosable.)
    child.on("close", (code) => {
      if (code === 0) return settle("passed", code);
      if (code === 127) return settle("spawn_failed", code, `verification command not found: ${cmd}`);
      settle("failed", code);
    });
  });
}

/** One stage's outcome from {@link runStagedVerification} — same evidence shape as `WorktreeMachineVerifier`'s `VerificationStageResult`, adapted to a plain shell-string command (no argv split, no sandboxed command port). */
export interface ShellVerificationStageResult {
  readonly display: string;
  /** The stage's real exit code. Was hardcoded `0`/`null` — a field that was not evidence of what it named. */
  readonly exit: number | null;
  readonly duration_ms: number;
  /** Why the stage ended, so a broken harness is distinguishable from a failing suite. */
  readonly kind: VerificationOutcomeKind;
}

/**
 * D4: ordered, fail-fast staged verification for a plain shell-string
 * `--verification-cmd` list — the same semantics `WorktreeMachineVerifier
 * .runPlan` gives the sandboxed argv-only command port (ordered, fail-fast,
 * one independent timeout budget per stage), implemented directly against
 * `runVerification`'s existing shell-string contract instead of migrating
 * `--verification-cmd` onto the argv-only sandboxed port (a breaking change
 * to an interface that today accepts compound shell strings like `bun test
 * && bun build`). A single-element `cmds` reproduces the pre-D4 single-
 * command call exactly: same `runVerification` call, same timeout, same
 * `stdout_hash`/`cmd` shape once combined below.
 */
export async function runStagedVerification(
  cmds: readonly string[],
  cwd: string,
  timeoutMsPerStage: number,
): Promise<{ ok: boolean; combinedCmd: string; stdout_hash: string; stdout: string; stderr: string; stageResults: readonly ShellVerificationStageResult[] }> {
  const stageResults: ShellVerificationStageResult[] = [];
  let combinedStdout = "";
  let combinedStderr = "";
  const finish = (ok: boolean): { ok: boolean; combinedCmd: string; stdout_hash: string; stdout: string; stderr: string; stageResults: readonly ShellVerificationStageResult[] } => ({
    ok,
    combinedCmd: cmds.join(" && "),
    stdout_hash: `sha256:${createHash("sha256").update(combinedStdout).digest("hex")}`,
    stdout: combinedStdout,
    stderr: combinedStderr,
    stageResults,
  });
  for (const cmd of cmds) {
    const result = await runVerification(cmd, cwd, timeoutMsPerStage);
    combinedStdout += result.stdout;
    combinedStderr += result.stderr;
    stageResults.push({ display: cmd, exit: result.exit, duration_ms: result.duration_ms, kind: result.kind });
    if (!result.ok) return finish(false);
  }
  return finish(true);
}

export interface WorktreeDiff {
  readonly ok: boolean;
  readonly text: string;
  readonly paths: string[];
  readonly additions: number;
  readonly deletions: number;
}

export interface WorktreeChanges {
  readonly ok: boolean;
  readonly files: readonly ChangedFile[];
}

const MAX_CHANGED_FILES = 32;
const MAX_DELTA_BYTES = 1_048_576;

interface CapturedProcess {
  readonly ok: boolean;
  readonly stdout: Buffer;
  /**
   * True when stdout hit MAX_DELTA_BYTES and further bytes were dropped.
   * `ok` alone cannot express this — the process can still exit 0 while its
   * output was cut mid-stream, and a caller that only checks `ok` would
   * silently treat a truncated capture as a complete one. Every caller must
   * decide explicitly what truncation means for its own contract (see
   * captureWorktreeChanges's per-file delta, which is intentionally bounded
   * and unaffected, vs. captureWorktreeDiff's numstat/patch calls, which are
   * not).
   */
  readonly truncated: boolean;
}

function captureProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  extraEnv?: Readonly<Record<string, string>>,
): Promise<CapturedProcess> {
  return new Promise((resolveResult) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ ok, stdout: Buffer.concat(chunks), truncated });
    };
    // Every git spawn in these capture helpers runs inside a worktree that
    // must be diffed on its own terms. A leaked GIT_DIR/GIT_INDEX_FILE/etc.
    // from the parent process would silently redirect git's repo discovery
    // to a different repository (see @arbor/campaign-support's
    // sanitizedGitEnv doc comment) — strip that class of env var before
    // every spawn here, not just the ones that build the diff.
    const env = { ...sanitizedGitEnv(), ...extraEnv };
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    trackChild(child);
    child.stdout?.on("data", (value: Buffer | string) => {
      if (bytes >= MAX_DELTA_BYTES) { truncated = true; return; }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const kept = chunk.subarray(0, MAX_DELTA_BYTES - bytes);
      if (kept.length < chunk.length) truncated = true;
      chunks.push(kept);
      bytes += kept.length;
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(false); }, timeoutMs);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

function safeWorktreePath(cwd: string, path: string): string | null {
  if (!path || isAbsolute(path) || path.includes("\0")) return null;
  const absolute = resolve(cwd, path);
  const inside = relative(resolve(cwd), absolute);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.split("\\").join("/") : null;
}

/**
 * Capture only bounded structural change metadata for retry context. The raw
 * delta contributes to a digest and is discarded before this function returns.
 */
export async function captureWorktreeChanges(cwd: string, timeoutMs: number): Promise<WorktreeChanges> {
  const status = await captureProcess("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd, timeoutMs);
  if (!status.ok) return Object.freeze({ ok: false, files: Object.freeze([]) });
  const fields = status.stdout.toString("utf8").split("\0");
  const rows: Array<{ path: string; kind: ChangedFile["changeKind"]; status: string }> = [];
  for (let index = 0; index < fields.length && rows.length < MAX_CHANGED_FILES; index++) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const code = field.slice(0, 2);
    const rawPath = field.slice(3);
    const renamed = code.includes("R") || code.includes("C");
    // In porcelain -z format a rename/copy record is followed by its original
    // pathname. The first pathname is the destination, which is what a retry
    // needs to inspect.
    if (renamed) index++;
    const path = safeWorktreePath(cwd, rawPath);
    if (path === null) continue;
    const kind: ChangedFile["changeKind"] = code === "??" || code.includes("A")
      ? "added"
      : code.includes("D")
        ? "deleted"
        : renamed
          ? "renamed"
          : "modified";
    rows.push({ path, kind, status: code });
  }
  const captured = await Promise.all(rows.map(async (row): Promise<ChangedFile | null> => {
    let delta: Buffer;
    if (row.status === "??") {
      try { delta = readFileSync(resolve(cwd, row.path)).subarray(0, MAX_DELTA_BYTES); }
      catch { return null; }
    } else {
      const result = await captureProcess("git", ["diff", "HEAD", "--binary", "--", row.path], cwd, timeoutMs);
      if (!result.ok) return null;
      // `result.truncated` is deliberately ignored: this function's contract
      // (see its docstring) is a bounded digest of the change, not the
      // change itself, so a large file's delta being capped at
      // MAX_DELTA_BYTES before hashing is by design, exactly like the `??`
      // (untracked) branch above which applies the same bound to the raw
      // file content.
      delta = result.stdout;
    }
    const deltaDigest = createHash("sha256")
      .update(`worktree-change-v1\0${row.kind}\0${row.path}\0`)
      .update(delta)
      .digest("hex");
    return Object.freeze({ path: row.path, changeKind: row.kind, deltaDigest, summary: `${row.kind} ${row.path}` });
  }));
  if (captured.some((change) => change === null)) return Object.freeze({ ok: false, files: Object.freeze([]) });
  return Object.freeze({ ok: true, files: Object.freeze(captured as ChangedFile[]) });
}

// The canonical hash of the empty tree object. Git special-cases this exact
// SHA-1 in tree lookups (has done since 1.6.x) so it resolves even in a
// brand-new repository whose object database never actually stored it — the
// standard trick for diffing "the whole worktree" against an unborn HEAD.
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Deterministic output regardless of the repo's/user's git config. Verified
// against the installed git 2.55.0 (`git diff -h`, `git help diff`):
//   --no-ext-diff     ignores diff.external / a per-path external driver
//   --no-color        ignores color.ui=always / color.diff (ANSI would break
//                      the +/- accounting if we ever parsed patch lines again)
//   --no-textconv     ignores textconv filters that rewrite blob content
//   --no-relative     ignores diff.relative (paths always repo-root-relative)
//   --src-prefix/--dst-prefix
//                     ignores diff.noprefix / diff.mnemonicPrefix / diff.srcPrefix
// `--binary` keeps binary files in the captured patch (matches the per-file
// helper in captureWorktreeChanges above). Renames are not requested (no -M)
// so numstat/paths report the plain add+delete pair, matching this file's
// other capture helper.
const DETERMINISTIC_DIFF_FLAGS = [
  "--no-ext-diff",
  "--no-color",
  "--no-textconv",
  "--no-relative",
] as const;

/**
 * Capture everything the specialist changed in a worktree relative to its
 * starting commit (HEAD): staged + unstaged + untracked (non-ignored) files,
 * all in one patch — never just `git diff`'s "unstaged vs index" slice.
 *
 * Approach: build a *temporary* index (`GIT_INDEX_FILE` pointed at a scratch
 * file) seeded from HEAD, `git add -A` the real working tree into that
 * scratch index, then diff the scratch index against HEAD. This reaches the
 * same worktree content `git add -A && git diff --cached` would show, without
 * ever touching the worktree's real index — the real index is never read as
 * a base (we seed from the HEAD tree, not from it) and never written to,
 * so a concurrent `git status`/`git add` on the real repo sees no effect and
 * `git add -N` (intent-to-add), which *does* mutate the real index, is not
 * used anywhere in this path. The scratch index file is removed afterward
 * regardless of outcome.
 */
export async function captureWorktreeDiff(cwd: string, timeoutMs: number): Promise<WorktreeDiff> {
  const failure: WorktreeDiff = Object.freeze({ ok: false, text: "", paths: [], additions: 0, deletions: 0 });
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());

  const tmpIndex = join(tmpdir(), `arbor-diff-index-${randomBytes(16).toString("hex")}`);
  const indexEnv = { GIT_INDEX_FILE: tmpIndex };
  try {
    // 1. Resolve the base tree. A brand-new worktree can have an unborn HEAD
    //    (no commits yet) — that is still a valid "starting commit" to diff
    //    against, it is just the empty tree.
    if (remaining() <= 0) return failure;
    const headCheck = await captureProcess("git", ["rev-parse", "--verify", "-q", "HEAD"], cwd, remaining());
    const base = headCheck.ok ? "HEAD" : EMPTY_TREE_SHA;

    // 2. Seed the scratch index from the base tree.
    if (remaining() <= 0) return failure;
    const readTree = await captureProcess("git", ["read-tree", base], cwd, remaining(), indexEnv);
    if (!readTree.ok) return failure;

    // 3. Snapshot the real working tree (staged + unstaged + untracked,
    //    respecting .gitignore) into the scratch index. This is the step
    //    that makes untracked new files and already-staged changes show up —
    //    `git diff`'s "unstaged vs index" alone omits both.
    if (remaining() <= 0) return failure;
    const addAll = await captureProcess("git", ["add", "-A"], cwd, remaining(), indexEnv);
    if (!addAll.ok) return failure;

    // 4. Machine-readable numstat (NUL-terminated so paths with spaces or
    //    other whitespace round-trip exactly, and so quoting config can't
    //    mangle them). Additions/deletions come from here, not from counting
    //    +/- lines in the patch text (binary files report "-" in numstat and
    //    would otherwise be silently skipped or miscounted).
    if (remaining() <= 0) return failure;
    const numstat = await captureProcess(
      "git",
      ["diff", "--cached", "--numstat", "-z", ...DETERMINISTIC_DIFF_FLAGS, base],
      cwd,
      remaining(),
      indexEnv,
    );
    // A truncated numstat means an unknown suffix of `paths` (and their
    // additions/deletions) never arrived — `paths` feeds observedPaths and
    // scope checks downstream, so a partial list must not masquerade as a
    // complete one. Unlike the patch text below, there is no meaningful
    // "truncated" marker to splice into a list of paths, so this is a hard
    // failure rather than a degraded-but-honest result.
    if (!numstat.ok || numstat.truncated) return failure;

    // 5. The human/critic-facing patch text itself. Reuses the same
    // MAX_DELTA_BYTES cap as everything else captureProcess bounds, rather
    // than a dedicated larger one: the critic caller (candidatePatch, ~line
    // 651) truncates this text again at 65,536 characters before it ever
    // reaches a model, and the only other consumer (the `loop.diff`
    // devtools push, ~line 932) is an operator-facing log, not something
    // that needs byte-for-byte completeness — an explicit truncation marker
    // is enough for both. A patch this large is also already an unusual
    // worktree state a specialist should not be leaving behind.
    if (remaining() <= 0) return failure;
    const patch = await captureProcess(
      "git",
      ["diff", "--cached", "--binary", ...DETERMINISTIC_DIFF_FLAGS, "--src-prefix=a/", "--dst-prefix=b/", base],
      cwd,
      remaining(),
      indexEnv,
    );
    if (!patch.ok) return failure;

    const paths: string[] = [];
    let additions = 0;
    let deletions = 0;
    const numstatFields = numstat.stdout.toString("utf8").split("\0").filter((field) => field.length > 0);
    for (const field of numstatFields) {
      // Each record is `<added>\t<deleted>\t<path>`; binary files report
      // "-" for both counts instead of a number.
      const firstTab = field.indexOf("\t");
      const secondTab = field.indexOf("\t", firstTab + 1);
      if (firstTab < 0 || secondTab < 0) continue;
      const addedField = field.slice(0, firstTab);
      const deletedField = field.slice(firstTab + 1, secondTab);
      const path = field.slice(secondTab + 1);
      if (!path) continue;
      paths.push(path);
      const added = Number.parseInt(addedField, 10);
      const deleted = Number.parseInt(deletedField, 10);
      if (Number.isFinite(added)) additions += added;
      if (Number.isFinite(deleted)) deletions += deleted;
    }

    const patchText = patch.stdout.toString("utf8");
    // Honest-but-degraded, mirroring the critic caller's own 65,536-char
    // truncation marker (~line 651): the patch was cut mid-stream, but the
    // numstat-derived paths/additions/deletions above are still complete
    // (they came from a separate, independently-bounded capture), so `ok`
    // stays true and only `text` carries the caveat.
    const text = patch.truncated
      ? `${patchText}\n[patch truncated by harness at ${MAX_DELTA_BYTES} bytes]\n`
      : patchText;

    return Object.freeze({ ok: true, text, paths, additions, deletions });
  } finally {
    try { rmSync(tmpIndex, { force: true }); } catch { /* best-effort cleanup of the scratch index */ }
  }
}
