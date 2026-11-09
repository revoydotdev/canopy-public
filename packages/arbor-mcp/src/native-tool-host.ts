/**
 * Revoy-owned repository tool ports for the native harness.
 *
 * This is intentionally a narrow host: requests are structured, roots are
 * canonicalized at every boundary, command execution never uses a shell, and
 * audit material is redacted before it leaves this module.  It is not a
 * campaign authority and it does not persist credentials or raw tool output.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { withGovernedRun } from "@arbor/core";
import { closeSync, existsSync, globSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { NativeModelAdapterToolDefinition, NativeToolActionScopeEvidence, NativeToolEffect, NativeToolExecutionEvidence, NativeToolPort, NativeToolRequest, NativeToolResponse, NativeToolRisk } from "@arbor/harness";
import type { NodeCommunication, UserInputOption } from "@arbor/audit";
import { createSandboxBroker } from "./sandbox/sandbox-broker.js";
import type { SandboxBroker, SandboxedCommandResult, ConfinementGrade } from "./sandbox/contracts.js";
import { runWorkspaceFileOperation } from "./sandbox/workspace-file.js";
import { boundRecoveryFailureEvidence, type RecoveryFailureEvidence } from "./recovery/contracts.js";
import { RepositoryGraphIndex } from "./repository-graph.js";
import { runEvidenceRefresh, EVIDENCE_STORE_NAMES, type EvidenceRefreshScope, type EvidenceStoreName } from "./native-tools/evidence-refresh.js";
import type { NativeBusThreadRouter, NativeBusThreadScope, NativeBusThreadToolOptions } from "./native-bus-thread-contracts.js";
import type { ValidatedSkill } from "./skills/catalog.js";
import { NATIVE_TOOL_RISK_MANIFEST } from "./native-capability-manifest.js";
import { projectGateRefusal, type GateRefusalProjection } from "./gate-refusal-projection.js";
import {
  NATIVE_REPOSITORY_TOOL_RISKS,
  NATIVE_DOCUMENTATION_WRITE_PATH_POLICY,
  enforcesDocumentationWritePaths,
  AUTHORITY_DESCRIPTION_ITEM_LIMIT,
  describeAuthorizedWritePaths,
  describeAuthorizedCommands,
  isMinedHighRiskScope,
  type NativeRepositoryToolDescriptor,
  type NativeRepositoryToolHostOptions,
  type NativeToolAuditRecord,
  type NativeToolFilesystemPolicy,
  type NativeToolIntent,
  type NativeHighRiskToolScope,
  type NativeToolOutcome,
  type NativeToolOutcomeStage,
  type NativeWritePathPolicy,
} from "./native-tools/contracts.js";

export { NATIVE_REPOSITORY_TOOL_RISKS } from "./native-tools/contracts.js";
export { NATIVE_DOCUMENTATION_WRITE_PATH_POLICY, enforcesDocumentationWritePaths } from "./native-tools/contracts.js";
export { AUTHORITY_DESCRIPTION_ITEM_LIMIT, describeAuthorizedWritePaths, describeAuthorizedCommands } from "./native-tools/contracts.js";
export type {
  NativeRepositoryToolDescriptor,
  NativeRepositoryToolHostOptions,
  NativeToolAuditRecord,
  NativeToolFilesystemPolicy,
  NativeToolIntent,
  NativeHighRiskToolScope,
  NativeHighRiskScopeDenialReason,
  NativeToolOutcome,
  NativeToolOutcomeStage,
  NativeWritePathPolicy,
} from "./native-tools/contracts.js";

const DEFAULT_READ_BYTES = 64 * 1024;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_COMMAND_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/**
 * evidence.refresh's own steps (a full vitest run, `vi:observe`, etc.) can
 * legitimately produce far more output than the generic shell.execute cap
 * (`commandOutputBytes`, 64KB default). Using that cap here would make an
 * honest green-but-verbose suite run look "output_limited" and get reported
 * as an unproven suite state — worse than the truth. `evidence-refresh.ts`
 * only reads a bounded preview of this anyway (`OUTPUT_PREVIEW_BYTES`), so
 * this only widens the sandbox's own capture buffer, not what leaves the tool.
 */
const EVIDENCE_REFRESH_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/**
 * H5: `repository.search` streams each file through a bounded line reader
 * instead of skipping any file over a size threshold. These are the bounds;
 * hitting any of them is reported to the model (`truncated: true`, the
 * reasons, and the files skipped or cut short), never absorbed silently.
 * The per-search budget keeps the old worst case (1,000 files of at most
 * 128 KiB, i.e. 125 MiB) as an upper envelope rather than widening it.
 */
const SEARCH_FILE_SCAN_BYTES = 8 * 1024 * 1024;
const SEARCH_TOTAL_SCAN_BYTES = 64 * 1024 * 1024;
const SEARCH_CHUNK_BYTES = 64 * 1024;
/** The longest single line matched; the rest of a longer line is not searched and the file is reported. */
const SEARCH_LINE_BYTES = 64 * 1024;
/** How many skipped or cut-short files are listed by path; the remainder is counted. */
const SEARCH_SKIPPED_FILE_LIST_LIMIT = 50;
const SEARCH_MATCH_TEXT_CHARS = 512;
const SEARCH_FILE_LIMIT = 1_000;
const SEARCH_MATCH_LIMIT = 100;
const SEARCH_TRUNCATION_REMEDIATION = "These results are incomplete; truncation_reasons and skipped_files say what was not searched. Narrow `path` to the directory or file you need, or make `query` more specific. To read a file that was cut short, page through it with file.read `start_line`/`max_lines` or `offset`.";
/**
 * ADR-105 O2: a regex `query` compiles from model input, so its length is
 * bounded independently of the general 512-char string-field cap — this is
 * the "bounded pattern-length guard" the decision names to partially bound
 * the cost of an adversarial (catastrophic-backtracking) pattern. The other
 * half is the per-line `signal.aborted` check in `scanFile`.
 */
const SEARCH_REGEX_MAX_LENGTH = 256;
/** ADR-105 O2: "Two lines of context ... capped at 5". */
const SEARCH_MAX_CONTEXT_LINES = 5;
const LIST_ENTRY_LIMIT = 500;
const GLOB_MATCH_LIMIT = 500;
/**
 * ADR-105 item 2: a bounded in-process job table for `shell.execute`'s
 * `background: true` mode. Bounded, not unlimited — an adversarial or
 * careless model spamming background starts cannot grow unbounded host
 * state; the oldest already-terminal (non-running) job is evicted to make
 * room before a new one is refused outright.
 */
const MAX_BACKGROUND_JOBS = 8;
const TODO_MAX_ITEMS = 200;
const TODO_TEXT_MAX_LENGTH = 2_000;
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const REDACTED = "[REDACTED]";
const MIN_MODEL_OUTPUT_BYTES = 512;
const SENSITIVE_BASENAME = /^(?:\.env(?:\..*)?|id_[a-z0-9_-]+|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const SECRET_VALUE = /(?:bearer\s+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*)([A-Za-z0-9_\-]{8,})/gi;

interface HostLimits {
  readonly readBytes: number;
  readonly outputBytes: number;
  readonly commandOutputBytes: number;
  readonly commandTimeoutMs: number;
}

interface ToolFailure {
  readonly outcome: Exclude<NativeToolOutcome, "succeeded">;
  readonly stage: NativeToolOutcomeStage;
  readonly code: string;
  readonly summary: string;
  /**
   * Bounded, secret-redacted evidence of a real failed command, so
   * `native-agent-executor.ts`'s recovery checkpoint (`observeRecoveryTool`)
   * has something to act on instead of only the bare `command_exit_nonzero`
   * code. Only ever set by `command()` for an actually-executed, nonzero-exit
   * shell/verification command — never fabricated for a refusal that never
   * ran.
   */
  readonly failure_evidence?: RecoveryFailureEvidence;
}

interface ToolSuccess {
  readonly payload: Record<string, unknown>;
  readonly summary: string;
  readonly effect: NativeToolEffect;
  readonly confinement?: ConfinementGrade;
}

type BackgroundJobStatus = "running" | "exited" | "cancelled" | "timed_out" | "output_limited" | "spawn_failed" | "network_isolation_unavailable";

/** One `shell.execute(background: true)` job. Session-scoped, in-process, never persisted. */
interface BackgroundJobEntry {
  readonly job_id: string;
  readonly argv: readonly string[];
  readonly started_at: string;
  status: BackgroundJobStatus;
  exit_code: number | null;
  output: string;
  confinement: ConfinementGrade | null;
  ended_at: string | null;
  /** Owns the job's process lifetime; aborting it is how `shell.stop` and session-end teardown both terminate the process. */
  readonly controller: AbortController;
}

type TodoStatus = "pending" | "in_progress" | "completed";

/** One `todo.write`/`todo.read` item. Model scratch state only — see ADR-105 O4. */
interface TodoItem {
  readonly id: string;
  readonly text: string;
  readonly status: TodoStatus;
}

class NativeRepositoryToolHost {
  private readonly repositoryGraph: RepositoryGraphIndex;
  private readonly filesystem: NativeToolFilesystemPolicy;
  private readonly admittedRoots: readonly string[] | null;
  private readonly resolveIntent: NativeRepositoryToolHostOptions["resolve_intent"];
  private readonly resolveHighRiskScope: NativeRepositoryToolHostOptions["resolve_high_risk_scope"];
  private readonly resolveHighRiskScopeDenialReason: NativeRepositoryToolHostOptions["resolve_high_risk_scope_denial_reason"];
  private readonly onAudit: ((record: NativeToolAuditRecord) => void) | undefined;
  private readonly commands: ReadonlySet<string>;
  private readonly limits: HostLimits;
  private readonly writePathPolicy: NativeWritePathPolicy | undefined;
  private readonly sandbox: SandboxBroker;
  /** ADR-105 item 2: bounded, session-scoped background `shell.execute` jobs. */
  private readonly backgroundJobs = new Map<string, BackgroundJobEntry>();
  /** ADR-105 item 3: bounded, session-scoped, ordered todo list — `todo.write` replaces it wholesale. */
  private todoItems: readonly TodoItem[] = Object.freeze([]);
  /**
   * ADR-119: intents this host instance (one per specialize() session) has
   * already bound to a literal argv, keyed by `bind_id`. Monotonic and
   * single-shot: once a `bind_id` appears here, every later call under it is
   * checked byte-exact against the recorded argv via `sameArgv`, exactly
   * like a literal declaration — never the prefix again. `resolveHighRiskScope`
   * returns the SAME snapshot for every call in this session, so this map is
   * the one place "already bound this session" actually lives.
   */
  private readonly boundIntents = new Map<number, readonly string[]>();
  /**
   * No-progress breaker state: the distinct high-risk call ids this session's
   * host has refused, keyed by `refusalLoopKey` (tool + canonical input, with a command's
   * root `cwd` spellings normalized). A refusal here is deterministic for the session -- the scope,
   * allowlist and roots it was judged against are fixed at composition -- so
   * re-proposing the identical call can never succeed. Only `refused`
   * outcomes count: a command that ran and exited non-zero is `failed`, and
   * re-running it after an edit is legitimate progress.
   */
  private readonly refusedCalls = new Map<string, Set<string>>();

  constructor(options: NativeRepositoryToolHostOptions, repositoryGraph: RepositoryGraphIndex = new RepositoryGraphIndex()) {
    this.repositoryGraph = repositoryGraph;
    this.filesystem = options.filesystem;
    this.admittedRoots = options.workspace_roots === undefined ? null : canonicalRoots(options.workspace_roots);
    this.resolveIntent = options.resolve_intent;
    this.resolveHighRiskScope = options.resolve_high_risk_scope;
    this.resolveHighRiskScopeDenialReason = options.resolve_high_risk_scope_denial_reason;
    this.onAudit = options.on_audit;
    this.commands = new Set(options.allowed_commands ?? []);
    if (options.write_path_policy !== undefined && !enforcesDocumentationWritePaths(options.write_path_policy)) {
      throw new Error("write_path_policy must be the system-owned documentation policy");
    }
    this.writePathPolicy = options.write_path_policy;
    this.sandbox = options.sandbox_broker ?? createSandboxBroker({ confinement_level: options.sandbox_confinement_level });
    this.limits = Object.freeze({
      readBytes: bounded(options.max_read_bytes, DEFAULT_READ_BYTES, "max_read_bytes"),
      outputBytes: boundedAtLeast(options.max_output_bytes, DEFAULT_OUTPUT_BYTES, "max_output_bytes", MIN_MODEL_OUTPUT_BYTES),
      commandOutputBytes: bounded(options.max_command_output_bytes, DEFAULT_COMMAND_OUTPUT_BYTES, "max_command_output_bytes"),
      commandTimeoutMs: bounded(options.max_command_timeout_ms, DEFAULT_COMMAND_TIMEOUT_MS, "max_command_timeout_ms"),
    });
  }

  descriptors(): readonly NativeRepositoryToolDescriptor[] {
    return Object.entries(NATIVE_REPOSITORY_TOOL_RISKS).map(([tool, risk]) => {
      const port: NativeToolPort = Object.freeze({
        tool,
        recovery_protection: (request: NativeToolRequest) => repositoryRecoveryProtection(tool, request),
        preflight: (request: NativeToolRequest) => this.preflight(tool, risk, request),
        execute: (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => this.execute(tool, risk, request, signal),
      });
      return Object.freeze({ tool, risk, port });
    });
  }

  private async execute(tool: string, risk: NativeToolRisk, request: NativeToolRequest, signal: AbortSignal): Promise<NativeToolResponse> {
    let intent: NativeToolIntent | null;
    try {
      intent = this.intentFor(request);
    } catch {
      return this.refusal(tool, risk, request, null, { outcome: "failed", stage: "audit", code: "intent_resolution_failed", summary: "execution refused: trusted intent evidence could not be resolved" });
    }
    if (intent === null) return this.refusal(tool, risk, request, null, { outcome: "refused", stage: "audit", code: "missing_trusted_intent", summary: "execution refused: no trusted provenance-backed intent" });
    if (signal.aborted) return this.refusal(tool, risk, request, intent, { outcome: "cancelled", stage: "execution", code: "cancelled_before_start", summary: "execution cancelled before start" });
    let roots: readonly string[];
    try {
      roots = this.rootsFor(request);
    } catch (error) {
      return this.refusal(tool, risk, request, intent, asFailure(error));
    }
    const scopeFailure = this.highRiskScopeFailure(tool, risk, request, roots, true);
    if (scopeFailure !== null) return this.refusal(tool, risk, request, intent, scopeFailure);
    try {
      const success = await this.perform(tool, request, roots, signal);
      return this.respond(tool, risk, request, intent, "succeeded", "execution", "ok", success.summary, success.payload, success.effect, success.confinement ?? "application_validated");
    } catch (error) {
      return this.refusal(tool, risk, request, intent, asFailure(error));
    }
  }

  /** This runs in the worker before approval, and is repeated at dispatch to close TOCTOU gaps. */
  private preflight(tool: string, risk: NativeToolRisk, request: NativeToolRequest): import("@arbor/harness").NativeToolPreflightResult {
    if (risk !== "high") return Object.freeze({ allowed: true });
    // The code is deliberately NOT one of the worker's recoverable preflight
    // codes, so this terminates the session (ADR-117 §2 shape) rather than
    // handing the model a fourth copy of a refusal it has already ignored.
    const loopKey = refusalLoopKey(tool, request.input);
    if ((this.refusedCalls.get(loopKey)?.size ?? 0) >= NATIVE_TOOL_REFUSAL_LOOP_LIMIT) {
      const remedy = projectToolRefusalLoop(tool);
      const evidence = this.evidence(tool, risk, request, "refused", "audit", NATIVE_TOOL_REFUSAL_LOOP_CODE, "none");
      this.audit(tool, risk, request, null, evidence, remedy.summary);
      return Object.freeze({ allowed: false, code: NATIVE_TOOL_REFUSAL_LOOP_CODE, reason: `${remedy.summary} ${remedy.remediation}`, evidence, remedy });
    }
    let intent: NativeToolIntent | null;
    try { intent = this.intentFor(request); } catch { intent = null; }
    if (intent === null) return this.preflightRefusal(tool, risk, request, null, "missing_trusted_intent", "execution refused: no trusted provenance-backed intent");
    let roots: readonly string[];
    try { roots = this.rootsFor(request); } catch (error) {
      const rejected = asFailure(error);
      return this.preflightRefusal(tool, risk, request, intent, rejected.code, rejected.summary);
    }
    const rejected = this.highRiskScopeFailure(tool, risk, request, roots, false);
    if (rejected !== null) return this.preflightRefusal(tool, risk, request, intent, rejected.code, rejected.summary);
    return Object.freeze({ allowed: true });
  }

  private preflightRefusal(tool: string, risk: NativeToolRisk, request: NativeToolRequest, intent: NativeToolIntent | null, code: string, reason: string): import("@arbor/harness").NativeToolPreflightResult {
    const evidence = this.evidence(tool, risk, request, "refused", "audit", code, "none");
    this.audit(tool, risk, request, intent, evidence, reason);
    return Object.freeze({ allowed: false, code, reason, evidence });
  }

  private intentFor(request: NativeToolRequest): NativeToolIntent | null {
    const intent = this.resolveIntent(request);
    if (intent === null || intent.purpose.trim().length === 0 || !isProvenance(intent.provenance)) return null;
    return intent;
  }

  private highRiskScopeFailure(tool: string, risk: NativeToolRisk, request: NativeToolRequest, roots: readonly string[], bind: boolean): ToolFailure | null {
    if (risk !== "high") return null;
    const scope = this.resolveHighRiskScope?.(request) ?? null;
    if (!validHighRiskScope(scope, request, roots)) {
      // Same code either way (existing callers, and the harness's
      // `RECOVERABLE_PREFLIGHT_CODES` allowlist, assert on `code`), but the
      // message must not conflate two different causes (S02): `scope ===
      // null` used to always claim "the plan declared none" — false exactly
      // when `resolveHighRiskScopeDenialReason` reports the action DID
      // declare a scope and the campaign's governance TIER refused it.
      // Composition-supplied and content-free; never widens what is
      // authorized, only names why it wasn't.
      const denialReason = scope === null ? this.resolveHighRiskScopeDenialReason?.(request) ?? null : null;
      return failure(
        "audit",
        "action_scope_missing_or_stale",
        scope === null
          ? denialReason === "tier_forbids_declared_scope"
            ? "execution refused: the action declared a high-risk scope, but this campaign's governance tier does not permit that declaration shape (tier policy, not a missing declaration)"
            : denialReason === "declared_scope_invalid"
              ? "execution refused: the action's declared high-risk scope is structurally invalid"
              : "execution refused: no high-risk action scope is authorized for this action (the plan declared none, and none could be derived from the task's declared write paths or commands)"
          : "execution refused: high-risk action scope is stale or cross-session",
      );
    }
    // `scope.write_paths`/`scope.command_argv` are canonical-relative
    // declarations against `scope.worktree_root` specifically (contracts.ts
    // :16-19), not bare strings valid under any admitted root. `roots` may
    // legitimately admit more than one workspace; without pinning the
    // selected root to the scope's own worktree, a request naming a
    // different admitted root with a coincidentally-identical relative path
    // (or argv, for a shared allowlisted command) would be authorized by a
    // scope that never granted anything under that root.
    let worktree: string;
    try { worktree = realpathSync(scope.worktree_root); } catch (error) { return asFailure(error); }
    try {
      if (tool === "file.write" || tool === "file.patch") {
        const value = record(request.input);
        const root = selectRoot(roots, optionalString(value, "workspace_root"));
        if (root !== worktree) return failure("audit", "action_scope_missing_or_stale", "execution refused: high-risk action scope is bound to a different workspace root than the one requested");
        const target = resolveRelative(root, stringField(value, "path", 1, 1_024));
        const relativePath = relative(root, target).split(sep).join("/");
        // Y-1 / ADR-065 graduated enforcement, applied at the host as it
        // already is at the verifier: a MINED scope binds in the audit tier.
        // An undeclared write under it is journaled as a scope observation
        // by the verifier and weighed at adoption; it is not refused here,
        // because a scope guessed from task text cannot know the task's
        // tests and siblings. An AUTHORED scope refuses exactly as before.
        if (!scope.write_paths.includes(relativePath) && !isMinedHighRiskScope(scope)) return failure("audit", "action_scope_path_denied", `execution refused: write path exceeds the system-owned action scope; ${describeAuthorizedWritePaths(scope.write_paths)}`);
        // This intersection is checked here (before approval) as well as at
        // final filesystem dispatch, preserving the documentation-role guard.
        this.assertWritePathAllowed(root, target);
      } else if (tool === "shell.execute" || tool === "verification.run") {
        const value = record(request.input);
        const root = selectRoot(roots, optionalString(value, "workspace_root"));
        if (root !== worktree) return failure("audit", "action_scope_missing_or_stale", "execution refused: high-risk action scope is bound to a different workspace root than the one requested");
        const argv = argvField(value);
        // sameArgv's own comparison logic is unchanged (ADR-119 O1): this
        // literal pool is exactly `scope.command_argv` plus this SESSION's
        // own already-bound intents (any bind_id in `boundIntents`), so
        // every call after a bind is checked byte-exact against the exact
        // argv that bound it — never the prefix again.
        const boundLiteral = [...scope.command_argv, ...this.boundIntents.values()];
        if (boundLiteral.some((allowed) => sameArgv(allowed, argv))) {
          // already authorized, either as a literal declaration or a prior bind
        } else {
          const candidate = (scope.command_intents ?? []).find((entry) => !this.boundIntents.has(entry.bind_id) && isArgvPrefix(entry.intent.argv_prefix, argv));
          if (candidate === undefined) {
            return failure("audit", "action_scope_command_denied", `execution refused: command argv exceeds the system-owned action scope; ${describeAuthorizedCommands(scope.command_argv)}${describeUnboundIntents(scope.command_intents, this.boundIntents)}`);
          }
          if (bind) {
            // ADR-119 Decision §2: the bind must be journaled the moment it
            // happens, before this call returns a result. No durable sink
            // (`bind_intent` absent) or an explicit refusal (a governed
            // session, or a slot already bound elsewhere) both fail closed —
            // the call is never authorized without a durable trace of it.
            const bound = scope.bind_intent?.({ bind_id: candidate.bind_id, argv }) ?? false;
            if (!bound) return failure("audit", "action_scope_command_denied", `execution refused: command argv matches declared intent ${JSON.stringify(candidate.intent.argv_prefix)} but the bind could not be durably recorded`);
            this.boundIntents.set(candidate.bind_id, Object.freeze([...argv]));
          }
          // preflight (bind === false): a genuine prefix match is a real
          // preview of what execute() will do — report allowed without
          // mutating local state; execute() performs the actual bind.
        }
      }
    } catch (error) { return asFailure(error); }
    return null;
  }

  private rootsFor(request: NativeToolRequest): readonly string[] {
    const roots = canonicalRoots(request.workspace_roots);
    if (this.admittedRoots !== null && (roots.length !== this.admittedRoots.length || roots.some((root, index) => root !== this.admittedRoots![index]))) {
      throw failure("sandbox", "workspace_roots_mismatch", "execution refused: workspace roots differ from admission");
    }
    return roots;
  }

  private async perform(tool: string, request: NativeToolRequest, roots: readonly string[], signal: AbortSignal): Promise<ToolSuccess> {
    switch (tool) {
      case "repository.search": return this.search(request.input, roots, signal);
      case "repository.graph": return this.graph(request.input, roots, signal);
      case "repository.list": return this.list(request.input, roots, signal);
      case "repository.glob": return this.glob(request.input, roots, signal);
      case "file.read": return this.read(request.input, roots, signal);
      case "file.write": return this.write(request.input, roots, signal);
      case "file.patch": return this.patch(request.input, roots, signal);
      case "shell.execute": return this.command(request.input, roots, request.network_allowed, signal, false);
      case "verification.run": return this.command(request.input, roots, request.network_allowed, signal, true);
      case "shell.poll": return this.pollBackgroundJob(request.input);
      case "shell.stop": return this.stopBackgroundJob(request.input);
      case "git.status": return this.git(["status", "--short", "--branch"], roots, signal, "git status");
      case "git.diff": return this.git(["-c", "diff.external=", "diff", "--no-ext-diff", "--no-textconv", "--"], roots, signal, "git diff");
      case "evidence.refresh": return this.evidenceRefresh(request.input, roots, request.network_allowed, signal);
      case "todo.write": return this.todoWrite(request.input);
      case "todo.read": return this.todoRead();
      default: throw failure("semantic", "unknown_tool", "execution refused: tool is not implemented by this host");
    }
  }

  /**
   * ADR-105 item 1: an owned in-process regex engine, not a shell-out to
   * `ripgrep` (see the ADR's "Alternatives / Roads not taken" — this
   * repository ships no external runtime dependency and `rg` is not
   * guaranteed on every deployment target). `query` stays literal-by-default;
   * `regex: true` switches to bounded `RegExp` compilation; `case_sensitive`
   * (default true) controls flags either way.
   *
   * H5 (Stage 0 re-pilot, 2026-10-07): every file is scanned with a bounded
   * streaming line reader (`scanSearchFile`) instead of being read whole, so a
   * large file is searched rather than silently skipped. Every bound — per
   * file, per search, per line, matches, files — that stops a file short or
   * ends the walk is reported: `truncated: true`, the reasons, and the files
   * skipped or cut short. A file is never counted as scanned unless it was
   * read, and never reported as fully searched when it was not.
   */
  private search(input: unknown, roots: readonly string[], signal: AbortSignal): ToolSuccess {
    const value = record(input);
    const query = stringField(value, "query", 1, 512);
    const root = selectRoot(roots, optionalString(value, "workspace_root"));
    const path = optionalRepositoryLocation(value, "path");
    const useRegex = optionalBoolean(value, "regex") ?? false;
    const caseSensitive = optionalBoolean(value, "case_sensitive") ?? true;
    const contextLines = optionalBoundedInteger(value, "context_lines", 0, SEARCH_MAX_CONTEXT_LINES) ?? 0;
    const matches = compileSearchMatcher(query, useRegex, caseSensitive);
    // `path` may name a directory OR a single file. A model naturally searches
    // "within cli.ts", and rejecting a file path (path_kind_invalid) made it
    // burn its turn budget retrying; a grep-shaped tool accepts both. Sandbox
    // and sensitivity checks are identical on either branch.
    const start = path === undefined ? root : existingPath(root, path, "any");
    const state: SearchState = { results: [], visited: 0, scanned: 0, bytes: 0, reasons: new Set(), skipped: [], skippedOmitted: 0, budgetExhausted: false };
    const scanFile = (child: string): void => {
      state.visited += 1;
      scanSearchFile(child, relativeRepositoryPath(root, child), matches, contextLines, state, signal);
    };
    const walk = (dir: string): void => {
      if (signal.aborted) throw failure("execution", "cancelled", "search cancelled");
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
        // A remaining entry the walk will not visit is only reported when it
        // exists: reaching a limit exactly at the last entry is not a cut.
        if (state.results.length >= SEARCH_MATCH_LIMIT) { state.reasons.add("match_limit"); return; }
        if (state.budgetExhausted) { state.reasons.add("search_byte_budget"); return; }
        if (state.visited >= SEARCH_FILE_LIMIT) { state.reasons.add("file_limit"); return; }
        const child = resolve(dir, entry.name);
        if (!inside(root, child)) throw failure("sandbox", "path_outside_workspace", "search encountered a path outside its workspace");
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile()) scanFile(child);
      }
    };
    if (statSync(start).isDirectory()) walk(start);
    else if (statSync(start).isFile()) scanFile(start);
    else throw failure("semantic", "search_path_not_searchable", "search path must be a file or directory");
    if (state.results.length >= SEARCH_MATCH_LIMIT) state.reasons.add("match_limit");
    const reasons = [...state.reasons].sort();
    const truncated = reasons.length > 0;
    return {
      summary: `repository search completed: ${state.results.length} matches${truncated ? ` (incomplete: ${reasons.join(", ")})` : ""}`,
      payload: {
        matches: state.results,
        files_scanned: state.scanned,
        bytes_scanned: state.bytes,
        truncated,
        truncation_reasons: reasons,
        skipped_files: state.skipped,
        ...(state.skippedOmitted === 0 ? {} : { skipped_files_omitted: state.skippedOmitted }),
        ...(truncated ? { remediation: SEARCH_TRUNCATION_REMEDIATION } : {}),
      },
      effect: "observed",
    };
  }

  private graph(input: unknown, roots: readonly string[], signal: AbortSignal): ToolSuccess {
    if (signal.aborted) throw failure("execution", "cancelled", "repository graph query cancelled");
    const value = record(input);
    const root = selectRoot(roots, optionalString(value, "workspace_root"));
    const requestedPath = optionalString(value, "path");
    const requestedSymbol = optionalString(value, "symbol");
    if ((requestedPath === undefined) === (requestedSymbol === undefined)) {
      throw failure("semantic", "graph_query_invalid", "repository.graph requires exactly one of path or symbol");
    }
    const path = requestedPath === undefined ? undefined : relativeRepositoryPath(root, existingPath(root, requestedPath, "any"));
    const depth = optionalPositive(value, "depth");
    const result = this.repositoryGraph.query(root, {
      ...(path === undefined ? {} : { path }),
      ...(requestedSymbol === undefined ? {} : { symbol: requestedSymbol }),
      ...(depth === undefined ? {} : { depth }),
    });
    return {
      summary: `repository graph returned ${result.nodes.length} node(s) from ${result.files_indexed} indexed file(s)${result.cache_hit ? " (cache hit)" : ""}`,
      payload: { ...result },
      effect: "observed",
    };
  }

  private list(input: unknown, roots: readonly string[], signal: AbortSignal): ToolSuccess {
    if (signal.aborted) throw failure("execution", "cancelled", "list cancelled");
    const value = record(input);
    const root = selectRoot(roots, optionalString(value, "workspace_root"));
    const path = optionalRepositoryLocation(value, "path");
    // `path` is an optional directory; omit it to enumerate the workspace root.
    // A model needs to discover what exists before reading — without this it
    // guesses paths and burns turns on path_kind_invalid. `.git`/`node_modules`
    // are elided like `search` does; symlinks are reported but never followed.
    const start = path === undefined ? root : existingPath(root, path, "directory");
    const named = readdirSync(start, { withFileTypes: true })
      .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
      .sort((a, b) => a.name.localeCompare(b.name));
    const truncated = named.length > LIST_ENTRY_LIMIT;
    const entries = named.slice(0, LIST_ENTRY_LIMIT).map((entry) => {
      const child = resolve(start, entry.name);
      if (entry.isSymbolicLink() || !inside(root, child)) return { name: entry.name, kind: "other" as const, bytes: null };
      if (entry.isDirectory()) return { name: entry.name, kind: "directory" as const, bytes: null };
      if (entry.isFile()) return { name: entry.name, kind: "file" as const, bytes: statSync(child).size };
      return { name: entry.name, kind: "other" as const, bytes: null };
    });
    const relativePath = relativeRepositoryPath(root, start);
    return { summary: `listed ${relativePath || "."} (${entries.length}${truncated ? `/${named.length}` : ""} entries)`, payload: { path: relativePath, entries, truncated }, effect: "observed" };
  }

  private glob(input: unknown, roots: readonly string[], signal: AbortSignal): ToolSuccess {
    if (signal.aborted) throw failure("execution", "cancelled", "glob cancelled");
    const value = record(input);
    const root = selectRoot(roots, optionalString(value, "workspace_root"));
    const pattern = stringField(value, "pattern", 1, 512);
    // `..` in a pattern could climb out of the base before globbing; refuse it
    // up front. `globSync` itself does not descend into symlinked directories,
    // and every match is re-checked `inside(root)` and required to be a real
    // file (lstat, so a symlink is never reported as its target) below.
    if (pattern.split(/[\\/]/).includes("..")) throw failure("sandbox", "path_traversal", "glob pattern may not contain a '..' segment");
    const base = optionalRepositoryLocation(value, "path");
    const cwd = base === undefined ? root : existingPath(root, base, "directory");
    const raw = globSync(pattern, { cwd, exclude: (candidate) => candidate.split(/[\\/]/).some((part) => part === ".git" || part === "node_modules") });
    const matches: string[] = [];
    let truncated = false;
    for (const rel of [...raw].sort()) {
      if (signal.aborted) throw failure("execution", "cancelled", "glob cancelled");
      if (matches.length >= GLOB_MATCH_LIMIT) { truncated = true; break; }
      const child = resolve(cwd, rel);
      if (!inside(root, child) || !existsSync(child) || !lstatSync(child).isFile()) continue;
      matches.push(relativeRepositoryPath(root, child));
    }
    return { summary: `glob '${pattern}' matched ${matches.length}${truncated ? "+" : ""} file(s)`, payload: { pattern, matches, truncated }, effect: "observed" };
  }

  /**
   * `file.read` returns one bounded window of a file. With no window
   * arguments it is the head; `offset` (bytes) or `start_line` (1-based)
   * pages forward, and `max_bytes`/`max_lines` shorten the window. The
   * per-call bound (`limits.readBytes`) is unchanged. A window that is not
   * the whole file says so (`truncated`), states where it starts and ends,
   * how much remains, and the exact `next_window` arguments for the next
   * page. A window that does not reach the end of the file ends on a line
   * boundary when it holds one, otherwise on a UTF-8 character boundary, and
   * is further shortened so the serialized result fits the model output
   * bound instead of being cut into a head/tail projection.
   */
  private async read(input: unknown, roots: readonly string[], signal: AbortSignal): Promise<ToolSuccess> {
    if (signal.aborted) throw failure("execution", "cancelled", "read cancelled");
    const value = record(input);
    const root = selectRoot(roots, optionalString(value, "workspace_root"));
    const target = existingPath(root, stringField(value, "path", 1, 1_024), "file");
    if (sensitive(target)) throw failure("sandbox", "sensitive_path_denied", "read refused for a sensitive file class");
    const requested = optionalPositive(value, "max_bytes");
    const requestedOffset = optionalBoundedInteger(value, "offset", 0, Number.MAX_SAFE_INTEGER);
    const requestedLine = optionalPositive(value, "start_line");
    const maxLines = optionalPositive(value, "max_lines");
    if (requestedOffset !== undefined && requestedLine !== undefined) throw failure("semantic", "read_window_invalid", "file.read accepts either offset or start_line, not both");
    const limit = Math.min(this.limits.readBytes, requested ?? this.limits.readBytes);
    const path = relativeRepositoryPath(root, target);
    const operation = { kind: "read" as const, path, max_bytes: limit, ...(requestedOffset === undefined ? {} : { offset: requestedOffset }), ...(requestedLine === undefined ? {} : { start_line: requestedLine }) };
    const result = await runWorkspaceFileOperation({ broker: this.sandbox, root, writable: false, operation, signal, max_output_bytes: this.limits.readBytes * 2 + 4_096 });
    if (!result.ok) {
      if (result.code === "read_window_out_of_range") throw failure("semantic", result.code, requestedLine === undefined ? "file.read offset is past the end of the file" : "file.read start_line is past the last line of the file");
      if (result.code === "read_line_seek_limit") throw failure("semantic", result.code, `file.read start_line lies beyond the first ${READ_LINE_SEEK_BYTES} bytes of the file; page with offset instead`);
      throw failure("sandbox", result.code, "read failed inside the workspace boundary");
    }
    const raw = Buffer.from(String(result.value.content_base64 ?? ""), "base64");
    const total = Number(result.value.total_bytes);
    const offset = safeIntegerOr(result.value.offset, requestedOffset ?? 0);
    const startLine = result.value.start_line === null ? null : safeIntegerOr(result.value.start_line, requestedLine ?? (offset === 0 ? 1 : null));
    const shape = (bytes: Buffer): Record<string, unknown> => readWindowPayload(path, bytes, offset, startLine, total, { lineMode: requestedLine !== undefined, maxBytes: requested, maxLines });
    let bytes = windowCut(raw, offset, total, maxLines);
    let payload = shape(bytes);
    // Keep the whole result inside the model output bound: shrink the window
    // (keeping its line alignment) rather than let `boundedToolModelOutput`
    // replace it with a head/tail projection that loses the paging hints.
    for (let serialized = readResultBytes(payload); serialized > this.limits.outputBytes && bytes.length > 0; serialized = readResultBytes(payload)) {
      const fit = Math.max(0, Math.floor(bytes.length * (this.limits.outputBytes / serialized) * 0.95) - 64);
      bytes = fit === 0 ? bytes.subarray(0, 0) : alignWindowEnd(bytes, fit);
      payload = shape(bytes);
    }
    const span = payload.truncated === true ? `bytes ${offset}-${offset + bytes.length} of ${total}` : `${bytes.length}/${total} bytes`;
    return { summary: `read ${path} (${span}${payload.truncated === true ? ", partial" : ""})`, payload, effect: "observed", confinement: result.confinement };
  }

  private async write(input: unknown, roots: readonly string[], signal: AbortSignal): Promise<ToolSuccess> {
    this.assertWritable();
    if (signal.aborted) throw failure("execution", "cancelled", "write cancelled");
    const value = record(input);
    const root = selectRoot(roots, optionalString(value, "workspace_root"));
    const path = stringField(value, "path", 1, 1_024);
    const content = stringField(value, "content", 0, this.limits.readBytes);
    const create = optionalBoolean(value, "create") ?? false;
    const expected = optionalSha256(value, "expected_sha256");
    if (create && expected !== undefined) throw failure("semantic", "write_mode_invalid", "create writes must omit expected_sha256");
    if (!create && expected === undefined) throw failure("semantic", "expected_sha256_required", "updates require expected_sha256 from a complete file.read");
    const target = writablePath(root, path, create);
    this.assertWritePathAllowed(root, target);
    if (sensitive(target)) throw failure("sandbox", "sensitive_path_denied", "write refused for a sensitive file class");
    if (existsSync(target) && create) throw failure("semantic", "file_exists", "write requested creation but target already exists");
    if (expected !== undefined && (!existsSync(target) || sha256(readFileSync(target)) !== expected)) throw failure("audit", "stale_write", "write refused: expected content hash did not match");
    const relativePath = relativeRepositoryPath(root, target);
    const result = await runWorkspaceFileOperation({ broker: this.sandbox, root, writable: true, operation: { kind: "write", path: relativePath, content_base64: Buffer.from(content).toString("base64"), create, ...(expected === undefined ? {} : { expected_sha256: expected }) }, signal, max_output_bytes: 4_096 });
    if (!result.ok) throw failure(result.code === "stale_write" ? "audit" : "sandbox", result.code, "write failed inside the workspace boundary");
    return { summary: `wrote ${relativePath} (${Buffer.byteLength(content)} bytes)`, payload: { path: relativePath, bytes: Buffer.byteLength(content), sha256: result.value.sha256 }, effect: "applied", confinement: result.confinement };
  }

  private async patch(input: unknown, roots: readonly string[], signal: AbortSignal): Promise<ToolSuccess> {
    this.assertWritable();
    if (signal.aborted) throw failure("execution", "cancelled", "patch cancelled");
    const value = record(input);
    const root = selectRoot(roots, optionalString(value, "workspace_root"));
    const target = existingPath(root, stringField(value, "path", 1, 1_024), "file");
    this.assertWritePathAllowed(root, target);
    if (sensitive(target)) throw failure("sandbox", "sensitive_path_denied", "patch refused for a sensitive file class");
    const expected = stringField(value, "expected", 1, this.limits.readBytes);
    const replacement = stringField(value, "replacement", 0, this.limits.readBytes);
    const text = readFileSync(target, "utf8");
    const first = text.indexOf(expected);
    if (first < 0) throw failure("audit", "patch_precondition_missing", "patch refused: expected text was not present");
    if (text.indexOf(expected, first + expected.length) >= 0) throw failure("audit", "patch_precondition_ambiguous", "patch refused: expected text matched more than once");
    const relativePath = relativeRepositoryPath(root, target);
    const result = await runWorkspaceFileOperation({ broker: this.sandbox, root, writable: true, operation: { kind: "patch", path: relativePath, expected, replacement }, signal, max_output_bytes: 4_096 });
    if (!result.ok) throw failure("audit", result.code, "patch failed inside the workspace boundary");
    return { summary: `patched ${relativePath}`, payload: { path: relativePath, sha256: result.value.sha256 }, effect: "applied", confinement: result.confinement };
  }

  private async command(input: unknown, roots: readonly string[], networkAllowed: boolean, signal: AbortSignal, verification: boolean): Promise<ToolSuccess> {
    const value = record(input);
    const argv = argvField(value);
    const root = selectRoot(roots, optionalString(value, "workspace_root"));
    const cwd = commandCwd(root, value);
    if (!this.commands.has(argv[0]!)) throw failure("sandbox", "command_not_allowlisted", "command refused: executable is not allowlisted");
    const timeout = Math.min(this.limits.commandTimeoutMs, optionalPositive(value, "timeout_ms") ?? this.limits.commandTimeoutMs);
    const background = optionalBoolean(value, "background") ?? false;
    if (background) {
      // ADR-105 item 2: verification.run's result is gating evidence for a
      // caller waiting synchronously on pass/fail; a background mode with no
      // immediate exit code would make that evidence meaningless. Only
      // shell.execute gains background mode.
      if (verification) throw failure("semantic", "verification_background_unsupported", "verification.run does not support background execution");
      return this.startBackgroundJob(argv, root, cwd, networkAllowed, timeout, signal);
    }
    const result = await this.sandbox.run({ argv: argv as [string, ...string[]], cwd, workspace_root: root, workspace_writable: this.filesystem === "workspace_write", network_denied: !networkAllowed, timeout_ms: timeout, max_output_bytes: this.limits.commandOutputBytes, signal });
    if (result.kind === "network_isolation_unavailable") throw failure("sandbox", "network_isolation_unavailable", "command refused: network prohibition cannot be enforced by the available sandbox");
    if (result.kind === "cancelled") throw failure("execution", "cancelled", "command cancelled");
    if (result.kind === "timed_out") {
      // No exit code exists for a process that never returned one; model that
      // honestly (`exit_code: null`) rather than inventing a sentinel.
      throw {
        ...failure("execution", "timeout", `command exceeded ${timeout} ms`),
        failure_evidence: boundRecoveryFailureEvidence({ command_argv: argv, exit_code: null, stderr: redact(result.stderr.toString("utf8")) }),
      };
    }
    if (result.kind === "output_limited") {
      throw {
        ...failure("execution", "command_output_limit", "command exceeded output byte limit"),
        failure_evidence: boundRecoveryFailureEvidence({ command_argv: argv, exit_code: null, stderr: redact(result.stderr.toString("utf8")) }),
      };
    }
    if (result.kind === "spawn_failed") {
      // The process never started: no stdout/stderr was ever produced and no
      // exit code exists. Capture the argv the caller attempted so a retry
      // still learns what was tried, without fabricating output.
      throw {
        ...failure("execution", "command_spawn_failed", "command could not be started"),
        failure_evidence: boundRecoveryFailureEvidence({ command_argv: argv, exit_code: null, stderr: null }),
      };
    }
    const output = redact(Buffer.concat([result.stdout, result.stderr]).toString("utf8"));
    const kind = verification ? "verification" : "command";
    if (result.exit !== 0) {
      throw {
        ...failure("execution", "command_exit_nonzero", `${kind} exited ${result.exit}`),
        failure_evidence: boundRecoveryFailureEvidence({ command_argv: argv, exit_code: result.exit, stderr: redact(result.stderr.toString("utf8")) }),
      };
    }
    return { summary: `${kind} exited ${result.exit}`, payload: { argv, exit_code: result.exit, output, success: true, confinement: result.confinement }, effect: "unknown", confinement: result.confinement };
  }

  /**
   * ADR-105 item 2: `background: true` spawns through the same
   * `SandboxBroker.run` as the synchronous path — no new sandbox primitive —
   * but does not await it. The call returns immediately with a `job_id`;
   * `shell.poll` reads the bounded, ring-buffered-equivalent output once the
   * broker settles it, and `shell.stop` sends the sandbox's own cancellation
   * signal. `callerSignal` is the signal this very call received from its
   * owning session — the exact same forwarding path a synchronous command's
   * cancellation already uses — so when the session ends (or is otherwise
   * aborted) the job's process is force-terminated and, deliberately, its
   * table entry is removed synchronously in the same tick: a job whose
   * session has closed must never again be visible to `shell.poll`/`shell.stop`.
   */
  private startBackgroundJob(argv: readonly string[], root: string, cwd: string, networkAllowed: boolean, timeoutMs: number, callerSignal: AbortSignal): ToolSuccess {
    this.evictTerminalBackgroundJob();
    if (this.backgroundJobs.size >= MAX_BACKGROUND_JOBS) throw failure("execution", "background_job_limit_exceeded", `at most ${MAX_BACKGROUND_JOBS} background job(s) may be tracked per session`);
    const jobId = randomUUID();
    const controller = new AbortController();
    const entry: BackgroundJobEntry = { job_id: jobId, argv, started_at: new Date().toISOString(), status: "running", exit_code: null, output: "", confinement: null, ended_at: null, controller };
    this.backgroundJobs.set(jobId, entry);
    const onCallerAbort = (): void => {
      controller.abort();
      this.backgroundJobs.delete(jobId);
    };
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    this.sandbox
      .run({ argv: argv as [string, ...string[]], cwd, workspace_root: root, workspace_writable: this.filesystem === "workspace_write", network_denied: !networkAllowed, timeout_ms: timeoutMs, max_output_bytes: this.limits.commandOutputBytes, signal: controller.signal })
      .then((result) => this.settleBackgroundJob(jobId, result))
      .catch(() => this.settleBackgroundJob(jobId, { kind: "spawn_failed", confinement: "application_validated" }))
      .finally(() => callerSignal.removeEventListener("abort", onCallerAbort));
    return { summary: `background command started: job ${jobId}`, payload: { job_id: jobId, argv, status: "running" as const }, effect: "unknown" };
  }

  private settleBackgroundJob(jobId: string, result: SandboxedCommandResult): void {
    const entry = this.backgroundJobs.get(jobId);
    // Already gone: the owning session ended (or the job was evicted) before
    // the sandbox settled. Never resurrect a torn-down job's table entry.
    if (entry === undefined) return;
    entry.ended_at = new Date().toISOString();
    if (result.kind === "exited") {
      entry.status = "exited";
      entry.exit_code = result.exit;
      entry.output = redact(Buffer.concat([result.stdout, result.stderr]).toString("utf8"));
      entry.confinement = result.confinement;
    } else if (result.kind === "cancelled" || result.kind === "timed_out" || result.kind === "output_limited") {
      entry.status = result.kind;
      entry.output = redact(Buffer.concat([result.stdout, result.stderr]).toString("utf8"));
      entry.confinement = result.confinement;
    } else if (result.kind === "network_isolation_unavailable") {
      entry.status = "network_isolation_unavailable";
      entry.confinement = result.confinement;
    } else {
      entry.status = "spawn_failed";
      entry.confinement = result.confinement;
    }
  }

  /** Bounded table: evict the oldest already-terminal job before refusing a new one. Never evicts a still-running job. */
  private evictTerminalBackgroundJob(): void {
    if (this.backgroundJobs.size < MAX_BACKGROUND_JOBS) return;
    for (const [jobId, entry] of this.backgroundJobs) {
      if (entry.status !== "running") { this.backgroundJobs.delete(jobId); return; }
    }
  }

  /** ADR-105 item 2: `shell.poll` — bounded read of one background job's current status and output. */
  private pollBackgroundJob(input: unknown): ToolSuccess {
    const value = record(input);
    const jobId = stringField(value, "job_id", 1, 128);
    const entry = this.backgroundJobs.get(jobId);
    if (entry === undefined) throw failure("semantic", "background_job_not_found", "background job id is not known to this session (it may never have existed, already been evicted, or its session has ended)");
    return {
      summary: `background job ${jobId} is ${entry.status}`,
      payload: { job_id: jobId, argv: entry.argv, status: entry.status, exit_code: entry.exit_code, output: entry.output, started_at: entry.started_at, ended_at: entry.ended_at },
      effect: "observed",
    };
  }

  /** ADR-105 item 2: `shell.stop` — sends the sandbox's own cancellation signal to a still-running background job. Idempotent on an already-terminal job. */
  private stopBackgroundJob(input: unknown): ToolSuccess {
    const value = record(input);
    const jobId = stringField(value, "job_id", 1, 128);
    const entry = this.backgroundJobs.get(jobId);
    if (entry === undefined) throw failure("semantic", "background_job_not_found", "background job id is not known to this session (it may never have existed, already been evicted, or its session has ended)");
    const wasRunning = entry.status === "running";
    if (wasRunning) entry.controller.abort();
    return { summary: `background job ${jobId} stop requested (was ${entry.status})`, payload: { job_id: jobId, status: entry.status }, effect: wasRunning ? "applied" : "observed" };
  }

  /**
   * ADR-105 item 3: `todo.write` replaces the whole session-scoped list, the
   * same shipped shape `skill.load`/`skill.list` established for a small,
   * bounded, model-callable read/write pair. This is deliberately NOT routed
   * through `@arbor/governance` — no obligation, waiver, or gate reads this
   * state (ADR-105 O4): it is model scratch state, always risk "low", never
   * consulted by `resolve_high_risk_scope`.
   */
  private todoWrite(input: unknown): ToolSuccess {
    const value = record(input);
    const rawItems = value.items;
    if (!Array.isArray(rawItems) || rawItems.length > TODO_MAX_ITEMS) throw failure("semantic", "todo_items_invalid", `items must be an array of at most ${TODO_MAX_ITEMS} entries`);
    const seen = new Set<string>();
    const items: TodoItem[] = rawItems.map((raw) => {
      const item = record(raw);
      const id = stringField(item, "id", 1, 128);
      const text = stringField(item, "text", 1, TODO_TEXT_MAX_LENGTH);
      const status = stringField(item, "status", 1, 32);
      if (!TODO_STATUSES.has(status)) throw failure("semantic", "todo_status_invalid", `status must be one of ${[...TODO_STATUSES].join(", ")}`);
      if (seen.has(id)) throw failure("semantic", "todo_id_duplicate", "todo item id must be unique within one write");
      seen.add(id);
      return { id, text, status: status as TodoStatus };
    });
    this.todoItems = Object.freeze(items);
    return { summary: `todo list updated: ${items.length} item(s)`, payload: { items }, effect: "applied" };
  }

  /** ADR-105 item 3: `todo.read` — bounded read of the current session-scoped todo list. */
  private todoRead(): ToolSuccess {
    return { summary: `${this.todoItems.length} todo item(s)`, payload: { items: this.todoItems }, effect: "observed" };
  }

  private async git(args: readonly string[], roots: readonly string[], signal: AbortSignal, label: string): Promise<ToolSuccess> {
    if (signal.aborted) throw failure("execution", "cancelled", `${label} cancelled`);
    const root = selectRoot(roots, undefined);
    const result = await run(["git", ...args], root, this.limits.commandTimeoutMs, this.limits.commandOutputBytes, signal, { GIT_CONFIG_NOSYSTEM: "1", HOME: "", PATH: process.env.PATH ?? "" });
    if (result.cancelled) throw failure("execution", "cancelled", `${label} cancelled`);
    if (result.timedOut) throw failure("execution", "timeout", `${label} timed out`);
    if (result.outputLimited) throw failure("execution", "command_output_limit", `${label} exceeded output byte limit`);
    if (result.exitCode !== 0) throw failure("execution", "git_failed", `${label} failed with exit ${result.exitCode}`);
    return { summary: `${label} completed`, payload: { output: redact(result.output), exit_code: result.exitCode }, effect: "observed" };
  }

  /**
   * `evidence.refresh` — see `native-tools/evidence-refresh.ts` for the two
   * ordering constraints this enforces. Every command it runs (the freshness
   * gate, the four store refreshers, the single-pass suite-green check) is a
   * fixed, tool-owned argv — never user input — so it is dispatched straight
   * through the sandbox broker rather than through the generic allowlisted
   * `shell.execute` path.
   */
  private async evidenceRefresh(input: unknown, roots: readonly string[], networkAllowed: boolean, signal: AbortSignal): Promise<ToolSuccess> {
    const value = record(input);
    const root = selectRoot(roots, optionalString(value, "workspace_root"));
    const scope = evidenceRefreshScope(value);
    const dryRun = optionalBoolean(value, "dry_run") ?? false;
    const runner = async (argv: readonly [string, ...string[]], timeoutMs: number) => {
      if (signal.aborted) throw failure("execution", "cancelled", "evidence refresh cancelled");
      // evidence.refresh's own steps (freshness gate, refreshers, suite check)
      // legitimately run minutes longer than the generic shell.execute
      // timeout, so this uses the module's own per-step budgets rather than
      // `this.limits.commandTimeoutMs`, which governs shell.execute/verification.run only.
      const result = await this.sandbox.run({ argv, cwd: root, workspace_root: root, workspace_writable: this.filesystem === "workspace_write", network_denied: !networkAllowed, timeout_ms: timeoutMs, max_output_bytes: EVIDENCE_REFRESH_MAX_OUTPUT_BYTES, signal });
      if (result.kind === "network_isolation_unavailable") throw failure("sandbox", "network_isolation_unavailable", "evidence refresh refused: network prohibition cannot be enforced by the available sandbox");
      if (result.kind === "cancelled") throw failure("execution", "cancelled", "evidence refresh cancelled");
      if (result.kind === "spawn_failed") throw failure("execution", "command_spawn_failed", `evidence refresh step could not be started: ${argv.join(" ")}`);
      // timed_out and output_limited are reported as an honest step failure
      // rather than aborting the whole call — a stuck refresher must not
      // silently swallow the outcome of the steps that already ran.
      const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
      if (result.kind === "timed_out") return { ok: false, exit_code: -1, output: `${redact(output)}\n[timed out after ${timeoutMs}ms]` };
      if (result.kind === "output_limited") return { ok: false, exit_code: -1, output: `${redact(output)}\n[output exceeded ${EVIDENCE_REFRESH_MAX_OUTPUT_BYTES} bytes]` };
      return { ok: result.exit === 0, exit_code: result.exit, output: redact(output) };
    };
    if (this.filesystem !== "workspace_write" && !dryRun) throw failure("sandbox", "filesystem_read_only", "evidence refresh refused by the immutable filesystem policy (dry_run is still permitted)");
    const outcome = await runEvidenceRefresh({ scope, dry_run: dryRun }, { run: runner });
    if (outcome.error !== null) throw failure("execution", "evidence_refresh_planning_failed", outcome.error);
    const refreshedCount = outcome.stores.filter((s) => s.action === "refreshed").length;
    return {
      summary: dryRun
        ? `evidence refresh dry run: ${outcome.stores.filter((s) => s.action === "would_refresh").length} store(s) would run`
        : `evidence refresh: ${refreshedCount} refreshed, ${outcome.stores.filter((s) => s.action === "refused").length} refused, ${outcome.stores.filter((s) => s.action === "failed").length} failed`,
      payload: { ...outcome },
      effect: !dryRun && refreshedCount > 0 ? "applied" : "observed",
    };
  }

  private assertWritable(): void {
    if (this.filesystem !== "workspace_write") throw failure("sandbox", "filesystem_read_only", "write refused by the immutable filesystem policy");
  }

  /** Apply a role-derived path-class restriction after canonical path checks. */
  private assertWritePathAllowed(root: string, target: string): void {
    if (this.writePathPolicy !== NATIVE_DOCUMENTATION_WRITE_PATH_POLICY) return;
    const path = relativeRepositoryPath(root, target);
    const permitted = path === "README.md"
      || path === "CHANGELOG.md"
      || /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(path)
      || /^\.arbor\/(?:[^/]+\/)*[^/]+\.md$/.test(path);
    if (!permitted) {
      throw failure("sandbox", "documentation_path_denied", "write refused: documentation role may only modify admitted documentation paths");
    }
  }

  private refusal(tool: string, risk: NativeToolRisk, request: NativeToolRequest, intent: NativeToolIntent | null, error: ToolFailure): NativeToolResponse {
    const response = this.respond(tool, risk, request, intent, error.outcome, error.stage, error.code, error.summary, {}, error.outcome === "refused" ? "none" : "unknown");
    // Carried as an extra, untyped property (same pattern as the
    // `model_definition` sideband elsewhere in this file) rather than
    // widening the shared `@arbor/harness` `NativeToolResponse` contract:
    // `observeRecoveryTool` (native-agent-executor.ts) reads it back off the
    // in-process response object to populate the recovery checkpoint's
    // `failure_evidence`.
    return error.failure_evidence === undefined ? response : Object.freeze({ ...response, failure_evidence: error.failure_evidence }) as NativeToolResponse;
  }

  private respond(tool: string, risk: NativeToolRisk, request: NativeToolRequest, intent: NativeToolIntent | null, outcome: NativeToolOutcome, stage: NativeToolOutcomeStage, code: string, summary: string, payload: Record<string, unknown>, effect: NativeToolEffect, confinement: ConfinementGrade = "application_validated"): NativeToolResponse {
    const evidence = this.evidence(tool, risk, request, outcome, stage, code, effect, confinement);
    this.audit(tool, risk, request, intent, evidence, summary);
    const modelOutput = boundedToolModelOutput({ outcome, stage, code, ...payload }, this.limits.outputBytes, tool);
    return Object.freeze({ result_summary: redact(summary).slice(0, 512), model_output: modelOutput, evidence });
  }

  private evidence(_tool: string, risk: NativeToolRisk, request: NativeToolRequest, outcome: NativeToolOutcome, stage: NativeToolOutcomeStage, code: string, effect: NativeToolEffect, confinement: ConfinementGrade = "application_validated"): NativeToolExecutionEvidence {
    return Object.freeze({ outcome, stage, code, effect, confinement, action_scope: this.actionScopeEvidence(risk, request) });
  }

  private actionScopeEvidence(risk: NativeToolRisk, request: NativeToolRequest): NativeToolActionScopeEvidence {
    if (risk !== "high") return Object.freeze({ status: "not_required" });
    let scope: NativeHighRiskToolScope | null;
    try { scope = this.resolveHighRiskScope?.(request) ?? null; } catch { return Object.freeze({ status: "invalid" }); }
    if (scope === null) return Object.freeze({ status: "absent" });
    const provenance_tag = isProvenance(scope.provenance) ? scope.provenance.tag : undefined;
    const scope_id_hash = `sha256:${createHash("sha256").update(scope.scope_id).digest("hex")}`;
    try {
      const roots = this.rootsFor(request);
      return validHighRiskScope(scope, request, roots)
        ? Object.freeze({ status: "bound", scope_id_hash, ...(provenance_tag === undefined ? {} : { provenance_tag }) })
        : Object.freeze({ status: "invalid", ...(provenance_tag === undefined ? {} : { provenance_tag }) });
    } catch {
      return Object.freeze({ status: "invalid", ...(provenance_tag === undefined ? {} : { provenance_tag }) });
    }
  }

  private audit(tool: string, risk: NativeToolRisk, request: NativeToolRequest, intent: NativeToolIntent | null, evidence: NativeToolExecutionEvidence, summary: string): void {
    // Every host refusal -- preflight or dispatch -- passes through here, so
    // this is the one place the no-progress breaker can count them. Keyed by
    // call id so a call refused at preflight and re-checked at dispatch
    // counts once. Only high-risk tools count: their refusals are denials of
    // authority the planner sets, which is what the breaker's remedy names. A
    // low-risk refusal (a read of a path that does not exist yet) can stop
    // being refused once the session itself creates the path.
    if (risk === "high" && evidence.outcome === "refused" && evidence.code !== NATIVE_TOOL_REFUSAL_LOOP_CODE) {
      const key = refusalLoopKey(tool, request.input);
      const calls = this.refusedCalls.get(key) ?? new Set<string>();
      calls.add(request.call_id);
      this.refusedCalls.set(key, calls);
    }
    const auditSummary = redact(summary).slice(0, 512);
    this.onAudit?.(Object.freeze({ session_id: request.session_id, call_id: request.call_id, tool, risk, intent: intent === null ? null : Object.freeze({ purpose: redact(intent.purpose).slice(0, 256), provenance_tag: intent.provenance.tag }), action_scope: evidence.action_scope, outcome: evidence.outcome, stage: evidence.stage, code: evidence.code, effect: evidence.effect, confinement: evidence.confinement ?? "application_validated", summary: auditSummary }));
  }
}

function repositoryRecoveryProtection(tool: string, request: NativeToolRequest): ReturnType<NonNullable<NativeToolPort["recovery_protection"]>> {
  if (["repository.search", "repository.graph", "repository.list", "repository.glob", "file.read", "git.status", "git.diff", "todo.read"].includes(tool)) return Object.freeze({ effect_kind: "read_only", repeatable: true, idempotency_key_hash: null, acknowledged_by: null });
  // Polling observes a live process. The same job id can have a different
  // output on the next turn, so it must not be served from the exact-read
  // memo even though it cannot mutate repository state. Mark it non-repeatable
  // to invalidate prior read references before the host observes it again.
  if (tool === "shell.poll") return Object.freeze({ effect_kind: "read_only", repeatable: false, idempotency_key_hash: null, acknowledged_by: null });
  if (tool === "file.write") return Object.freeze({
    effect_kind: "file_write", repeatable: true,
    // The native repository host acknowledges the canonical full-write
    // semantics, not a session/call identity. The one-way key can therefore
    // match the same write after a restart without persisting path/content.
    idempotency_key_hash: sha256(stableRecoveryJson(request.input)),
    acknowledged_by: "revoy-native-repository-tool:file.write:v1",
  });
  if (tool === "file.patch") return Object.freeze({ effect_kind: "file_patch", repeatable: false, idempotency_key_hash: null, acknowledged_by: null });
  if (tool === "shell.execute" || tool === "verification.run") return Object.freeze({ effect_kind: "shell", repeatable: false, idempotency_key_hash: null, acknowledged_by: null });
  // Stopping an already-terminal (or already-stopped) job is a safe no-op —
  // unlike starting a command, repeating "stop" never has a new effect.
  if (tool === "shell.stop") return Object.freeze({ effect_kind: "shell", repeatable: true, idempotency_key_hash: null, acknowledged_by: null });
  // ADR-105 O4: todo.write's idempotency mirrors file.write's canonical
  // full-replace pattern above — same list content hashes to the same key —
  // but note this key is a recovery-checkpoint convenience only. Unlike
  // file.write, todo state is in-process scratch state with no durable
  // governance identity of its own.
  if (tool === "todo.write") return Object.freeze({ effect_kind: "external", repeatable: true, idempotency_key_hash: sha256(stableRecoveryJson(request.input)), acknowledged_by: "revoy-native-repository-tool:todo.write:v1" });
  // A dry-run evidence.refresh is read-only and repeatable; a real one runs
  // refresh scripts (and, for determinism-baseline, the test suite itself)
  // with no safe generic replay semantics, same as shell.execute.
  if (tool === "evidence.refresh") return Object.freeze({ effect_kind: "shell", repeatable: false, idempotency_key_hash: null, acknowledged_by: null });
  return Object.freeze({ effect_kind: "external", repeatable: false, idempotency_key_hash: null, acknowledged_by: null });
}

function stableRecoveryJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableRecoveryJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableRecoveryJson(record[key])}`).join(",")}}`;
}

/**
 * How many times one session's host refuses the identical high-risk call
 * (same tool, same canonical input) before the next identical proposal ends the session.
 * The 2026-10-06 native cohort recorded specialists re-proposing a refused
 * `npm test` more than a hundred times in one session, spending most of the
 * run's turns and tokens on a refusal that could not change.
 */
export const NATIVE_TOOL_REFUSAL_LOOP_LIMIT = 3;
/** Terminal preflight code the no-progress breaker returns; never recoverable. */
export const NATIVE_TOOL_REFUSAL_LOOP_CODE = "tool_refusal_loop";

/**
 * The typed remedy (ADR-179's v2 refusal contract) for a session stopped by
 * the no-progress breaker. Every host refusal it counts is a deterministic
 * denial of something the session was not authorized for -- a command argv
 * or write path the plan did not declare, an executable no authority named,
 * an input the host's bounds reject -- and the session's authority is fixed
 * at composition, so neither the specialist nor a plain retry can clear it.
 * The actor that can is the one who sets that authority: the admission
 * authority's campaign planner, by repairing the plan's declared scope or the
 * project's `verification.acceptance_commands`.
 */
export function projectToolRefusalLoop(tool: string): GateRefusalProjection {
  return projectGateRefusal({
    gate: "admission",
    code: NATIVE_TOOL_REFUSAL_LOOP_CODE,
    summary: `session stopped: the specialist proposed the same refused ${tool.slice(0, 64)} call ${NATIVE_TOOL_REFUSAL_LOOP_LIMIT} times without progress.`,
    remediation: "Declare the exact command argv or write path this node needs in its plan (command_argv / write_paths), or add the command to verification.acceptance_commands in arbor.jsonc, or revise the task so it does not need the call; then retry the node.",
  });
}

/**
 * Identity of a call for the no-progress breaker: the tool plus its whole
 * canonical input. Every field can decide a refusal -- a command's `cwd` and
 * `workspace_root` as much as its argv -- so a call that changes any of them
 * is a correction, not a repeat. Keying commands by argv alone counted a
 * specialist that fixed only a refused `cwd` as re-proposing the same call
 * and ended the session on the attempt that would have run (UCT Stage 0,
 * 2026-10-07). A command's `cwd` is normalized so every spelling of the
 * workspace root (omitted, `.`, `./`, empty) is one call.
 */
function refusalLoopKey(tool: string, input: unknown): string {
  let keyed = input;
  if ((tool === "shell.execute" || tool === "verification.run") && input !== null && typeof input === "object" && !Array.isArray(input)) {
    const { cwd, ...rest } = input as Record<string, unknown>;
    keyed = typeof cwd === "string" && WORKSPACE_ROOT_SPELLINGS.has(cwd) ? rest : input;
  }
  return `${tool}\u0000${stableRecoveryJson(keyed)}`;
}

/**
 * The executables a session's own high-risk scope names: `argv[0]` of every
 * literal `command_argv` entry and of every ADR-119 intent prefix. This is
 * the session's executable allowlist. It never widens authority: a command
 * reaches the allowlist check only after `highRiskScopeFailure` has matched
 * its whole argv byte-exact against the same scope (or bound an intent
 * prefix), so admitting `npm` here admits exactly the `npm ...` argv the
 * scope already authorized, and nothing else that starts with `npm`.
 */
export function nativeSessionCommandExecutables(scope: NativeHighRiskToolScope | null): readonly string[] {
  if (scope === null) return Object.freeze([]);
  const executables = new Set<string>();
  for (const argv of scope.command_argv) if (argv.length > 0 && argv[0]!.length > 0) executables.add(argv[0]!);
  for (const entry of scope.command_intents ?? []) {
    const head = entry.intent.argv_prefix[0];
    if (head !== undefined && head.length > 0) executables.add(head);
  }
  return Object.freeze([...executables]);
}

/** Create all native repository ports plus trustworthy, composition-visible risk metadata. */
export function createNativeRepositoryToolHost(options: NativeRepositoryToolHostOptions, repositoryGraph?: RepositoryGraphIndex): readonly NativeRepositoryToolDescriptor[] {
  return new NativeRepositoryToolHost(options, repositoryGraph).descriptors();
}

/** Convenience projection for `NativeHarnessWorker`'s injected `tools` port. */
export function nativeRepositoryToolPorts(options: NativeRepositoryToolHostOptions, repositoryGraph?: RepositoryGraphIndex): readonly NativeToolPort[] {
  return createNativeRepositoryToolHost(options, repositoryGraph).map((descriptor) => descriptor.port);
}

const BUS_THREAD_MESSAGE_KINDS = new Set<NodeCommunication["kind"]>(["delegate", "report", "retract", "steer", "reply", "clarify", "promote"]);
const BUS_THREAD_INTENTS = new Set<NonNullable<NodeCommunication["intent"]>>(["request", "response", "notify", "needs_attention"]);
const BUS_THREAD_OUTPUT_BYTES = 16 * 1024;

/**
 * Child→parent conversation ports for one dispatched native child session —
 * the missing return path (parent→child dispatch already exists via
 * `NativeAgentExecutor.specialize`). These are a native-tool-port facade
 * over the *already-existing* `bus.thread.send` / `bus.thread.ack` /
 * `sibling.status` runtime-catalog kinds (dispatched by
 * `RuntimeCatalogRouter`, see `parent-child-thread-contracts.ts` and
 * `sibling-contracts.ts`) — not a second message path, not a new store.
 *
 * Scope narrowing is the whole point. `options.resolve_scope` names the
 * *one* parent/child edge this session was actually dispatched on — a host
 * fact resolved from the campaign graph, never taken from model input (the
 * same non-negotiable pattern `resolve_high_risk_scope` already uses for
 * `write_paths`/`command_argv` above). A model may optionally name
 * campaign/parent/child ids in its call for clarity, but any value that
 * disagrees with the resolved scope is refused with `bus_thread_scope_denied`
 * — never silently redirected to the real edge. `sibling.spawn` and
 * `subagent.execute` have no port here at all: the router is only ever
 * invoked with a `bus.thread.send` / `bus.thread.ack` / `sibling.status`
 * envelope this module constructs itself from the trusted scope; nothing in
 * the model's input can change that discriminant.
 */
export function createNativeBusThreadToolPorts(options: NativeBusThreadToolOptions): readonly NativeToolPort[] {
  const now = options.now ?? (() => new Date());
  const randomId = options.random_id ?? (() => createHash("sha256").update(`${Date.now()}:${Math.random()}:${Math.random()}`).digest("hex").slice(0, 32));
  return Object.freeze([
    Object.freeze({
      tool: "bus.thread.send",
      recovery_protection: () => Object.freeze({ effect_kind: "external" as const, repeatable: false, idempotency_key_hash: null, acknowledged_by: null }),
      execute: (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => busThreadSend(options, request, now, randomId, signal),
    }),
    Object.freeze({
      tool: "bus.thread.ack",
      recovery_protection: () => Object.freeze({ effect_kind: "external" as const, repeatable: false, idempotency_key_hash: null, acknowledged_by: null }),
      execute: (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => busThreadAck(options, request, now, randomId, signal),
    }),
    Object.freeze({
      tool: "sibling.status",
      recovery_protection: () => Object.freeze({ effect_kind: "read_only" as const, repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      execute: (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => siblingStatus(options, request, signal),
    }),
  ]) as readonly NativeToolPort[];
}

const CLARIFY_DEFAULT_TIMEOUT_MS = 5_000;
const CLARIFY_MAX_TIMEOUT_MS = 30_000;

/**
 * Model-facing schema for `bus.thread.clarify`. `expected_thread_version` is
 * deliberately not exposed: the host reads the current version itself (see
 * `clarifyParent`), because the model has no way to learn it.
 */
export const NATIVE_BUS_THREAD_CLARIFY_MODEL_DEFINITION: NativeModelAdapterToolDefinition = Object.freeze({
  name: "bus.thread.clarify",
  description: "Ask your parent one blocking clarification question on this session's own dispatched parent-edge thread and wait a bounded time for its reply. The question is recorded durably whether or not a reply arrives; a timeout is an honest result, not a failure of the question. Do not use it for operator questions (use userinput.ask).",
  parameters: Object.freeze({
    type: "object",
    properties: {
      question: { type: "string" },
      timeout_ms: { type: "integer", minimum: 1, maximum: CLARIFY_MAX_TIMEOUT_MS },
    },
    required: ["question"],
    additionalProperties: false,
  }),
  risk: "low",
}) as NativeModelAdapterToolDefinition;

/**
 * One bounded child→parent clarification call over the existing thread
 * ledger.  It deliberately reuses `bus.thread.send`'s trusted edge and
 * `clarify`/`reply` vocabulary; there is no second question store or a
 * model-selected recipient.  A missing reply is an honest timeout, never an
 * indefinitely suspended native session.
 */
export function createNativeClarificationToolPort(options: NativeBusThreadToolOptions): NativeToolPort {
  const now = options.now ?? (() => new Date());
  const randomId = options.random_id ?? (() => createHash("sha256").update(`${Date.now()}:${Math.random()}:${Math.random()}`).digest("hex").slice(0, 32));
  let inFlight: string | null = null;
  const completed = new Map<string, { readonly fingerprint: string; readonly response: NativeToolResponse }>();
  return Object.freeze({
    tool: "bus.thread.clarify",
    // Advertised through the port itself (the `peer.*` pattern): the executor
    // collects `model_definition` from every admitted extension tool, so a
    // composed clarify port can no longer be hollow. Risk mirrors
    // `bus.thread.send`, which this call wraps.
    model_definition: NATIVE_BUS_THREAD_CLARIFY_MODEL_DEFINITION,
    recovery_protection: (request: NativeToolRequest) => Object.freeze({ effect_kind: "external" as const, repeatable: true, idempotency_key_hash: clarificationRequestFingerprint(request), acknowledged_by: "revoy-native-bus-thread-clarify:v1" }),
    async execute(request: NativeToolRequest, _secret: string | null, signal: AbortSignal): Promise<NativeToolResponse> {
      const key = `${request.session_id}:${request.call_id}`;
      const fingerprint = clarificationRequestFingerprint(request);
      const replay = completed.get(key);
      if (replay !== undefined) {
        if (replay.fingerprint === fingerprint) return replay.response;
        const scope = options.resolve_scope({ session_id: request.session_id });
        return busThreadFailureResponse("bus.thread.clarify", failure("audit", "clarify_idempotency_collision", "execution refused: call identity was replayed with different clarification input"), scope === null ? Object.freeze({ status: "absent" }) : busThreadActionScope(scope));
      }
      const scope = options.resolve_scope({ session_id: request.session_id });
      if (scope !== null && inFlight !== null && inFlight !== key) return busThreadFailureResponse("bus.thread.clarify", failure("execution", "clarify_in_flight", "one clarification is already awaiting a parent reply for this session"), busThreadActionScope(scope));
      inFlight = key;
      try {
        const response = await clarifyParent(options, request, now, randomId, signal);
        completed.set(key, Object.freeze({ fingerprint, response }));
        return response;
      } finally {
        if (inFlight === key) inFlight = null;
      }
    },
  }) as NativeToolPort;
}

/** The recovery key and in-memory replay fingerprint intentionally match. */
function clarificationRequestFingerprint(request: NativeToolRequest): `sha256:${string}` {
  return sha256(stableRecoveryJson({ session_id: request.session_id, call_id: request.call_id, input: request.input })) as `sha256:${string}`;
}

async function clarifyParent(options: NativeBusThreadToolOptions, request: NativeToolRequest, now: () => Date, randomId: () => string, signal: AbortSignal): Promise<NativeToolResponse> {
  const scope = options.resolve_scope({ session_id: request.session_id });
  if (scope === null) return busThreadFailureResponse("bus.thread.clarify", failure("audit", "missing_bus_thread_scope", "execution refused: no trusted parent-edge scope for this session"), Object.freeze({ status: "absent" }));
  const actionScope = busThreadActionScope(scope);
  if (actionScope.status !== "bound") return busThreadFailureResponse("bus.thread.clarify", failure("audit", "bus_thread_scope_invalid", "execution refused: trusted parent-edge scope has invalid provenance"), actionScope);
  if (signal.aborted) return busThreadFailureResponse("bus.thread.clarify", failure("execution", "cancelled", "clarification cancelled before start"), actionScope);
  try {
    const value = record(request.input);
    const mismatch = busThreadScopeMismatch(value, scope);
    if (mismatch !== null) return busThreadFailureResponse("bus.thread.clarify", failure("audit", "bus_thread_scope_denied", `execution refused: ${mismatch}`), Object.freeze({ status: "invalid" }));
    const question = stringField(value, "question", 1, 8_192);
    // The model has no tool to read the thread version, so a model-facing call
    // omits it and the host reads the current version for the trusted edge. A
    // caller that does name one still gets the compare-and-swap check.
    const expectedThreadVersion = optionalString(value, "expected_thread_version") ?? ((): string => {
      const current = options.router.executeQuery({ schema_version: 1, query_id: `native-bus-thread-clarify-version:${request.session_id}:${request.call_id}`, query: { kind: "bus.thread.history", campaign_id: scope.campaign_id, parent_node_id: scope.parent_node_id, child_node_id: scope.child_node_id, limit: 1 } });
      if (!current.ok) throw failure("execution", "clarify_history_failed", current.error.summary);
      return (current.value as { version: string }).version;
    })();
    const requestedTimeout = optionalNumber(value, "timeout_ms");
    if (requestedTimeout !== undefined && (!Number.isInteger(requestedTimeout) || requestedTimeout < 1 || requestedTimeout > CLARIFY_MAX_TIMEOUT_MS)) throw failure("semantic", "clarify_timeout_invalid", `timeout_ms must be an integer from 1 to ${CLARIFY_MAX_TIMEOUT_MS}`);
    let postedMessageId: string | null = null;
    const posted = await busThreadSend(
      options,
      { ...request, input: { ...value, content: question, message_kind: "clarify", intent: "needs_attention", expected_thread_version: expectedThreadVersion, ack_required: false } },
      now,
      randomId,
      signal,
      (messageId) => { postedMessageId = messageId; },
    );
    if (posted.evidence.outcome !== "succeeded") return posted;
    if (postedMessageId === null) throw failure("execution", "clarify_message_missing", "clarification message was accepted without an id");
    const deadline = Date.now() + (requestedTimeout ?? CLARIFY_DEFAULT_TIMEOUT_MS);
    while (true) {
      if (signal.aborted) return busThreadFailureResponse("bus.thread.clarify", failure("execution", "cancelled", "clarification cancelled while awaiting parent reply"), actionScope);
      const history = options.router.executeQuery({ schema_version: 1, query_id: `native-bus-thread-clarify:${request.session_id}:${request.call_id}`, query: { kind: "bus.thread.history", campaign_id: scope.campaign_id, parent_node_id: scope.parent_node_id, child_node_id: scope.child_node_id, limit: 200 } });
      if (!history.ok) throw failure("execution", "clarify_history_failed", history.error.summary);
      const reply = (history.value as { messages?: readonly Record<string, unknown>[] }).messages?.find((message) => message.kind === "reply" && message.author_node_id === scope.parent_node_id && message.reply_to_communication_id === postedMessageId);
      if (reply !== undefined) return busThreadSuccess("bus.thread.clarify", "parent clarification reply received", { question_message_id: postedMessageId, reply: reply.payload_preview }, "applied", actionScope);
      if (Date.now() >= deadline) return busThreadFailureResponse("bus.thread.clarify", failure("execution", "clarify_timeout", "clarification timed out waiting for parent reply"), actionScope);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, Math.min(50, deadline - Date.now())));
    }
  } catch (error) {
    return busThreadFailureResponse("bus.thread.clarify", asFailure(error), actionScope);
  }
}

/** Any optional campaign/parent/child id the model named must agree with the trusted scope, or the call is denied. */
function busThreadScopeMismatch(value: Record<string, unknown>, scope: NativeBusThreadScope): string | null {

  const campaignId = optionalString(value, "campaign_id");
  if (campaignId !== undefined && campaignId !== scope.campaign_id) return "campaign_id does not match this session's dispatched edge";
  const parentNodeId = optionalString(value, "parent_node_id");
  if (parentNodeId !== undefined && parentNodeId !== scope.parent_node_id) return "parent_node_id does not match this session's dispatched edge";
  const childNodeId = optionalString(value, "child_node_id");
  if (childNodeId !== undefined && childNodeId !== scope.child_node_id) return "child_node_id does not match this session's dispatched edge";
  return null;
}

function optionalEvidenceRefs(value: Record<string, unknown>): readonly string[] | undefined {
  const field = value.evidence_refs;
  if (field === undefined) return undefined;
  if (!Array.isArray(field) || field.length > 32 || field.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512)) {
    throw failure("semantic", "evidence_refs_invalid", "evidence_refs must contain at most 32 bounded non-empty references");
  }
  return Object.freeze(field.slice() as string[]);
}

function busThreadEvidence(outcome: NativeToolOutcome, stage: NativeToolOutcomeStage, code: string, effect: NativeToolEffect, actionScope: NativeToolActionScopeEvidence): NativeToolExecutionEvidence {
  return Object.freeze({ outcome, stage, code, effect, confinement: "application_validated", action_scope: actionScope });
}

function busThreadFailureResponse(tool: string, failed: ToolFailure, actionScope: NativeToolActionScopeEvidence): NativeToolResponse {
  const evidence = busThreadEvidence(failed.outcome, failed.stage, failed.code, failed.outcome === "refused" ? "none" : "unknown", actionScope);
  return Object.freeze({
    result_summary: redact(failed.summary).slice(0, 512),
    model_output: boundedToolModelOutput({ outcome: evidence.outcome, stage: evidence.stage, code: evidence.code }, BUS_THREAD_OUTPUT_BYTES, tool),
    evidence,
  });
}

function busThreadSuccess(tool: string, summary: string, payload: Record<string, unknown>, effect: NativeToolEffect, actionScope: NativeToolActionScopeEvidence): NativeToolResponse {
  const evidence = busThreadEvidence("succeeded", "execution", "ok", effect, actionScope);
  return Object.freeze({
    result_summary: redact(summary).slice(0, 512),
    model_output: boundedToolModelOutput({ outcome: evidence.outcome, stage: evidence.stage, code: evidence.code, ...payload }, BUS_THREAD_OUTPUT_BYTES, tool),
    evidence,
  });
}

/**
 * `bus.thread.send` and `bus.thread.ack` mutate an external parent/child
 * channel. Bind their evidence to the host-resolved edge, never call input.
 * The hash keeps the edge identity out of session events while preserving a
 * stable correlation point for audit and recovery.
 */
function busThreadActionScope(scope: NativeBusThreadScope): NativeToolActionScopeEvidence {
  if (!isProvenance(scope.provenance)) return Object.freeze({ status: "invalid" });
  const scopeId = JSON.stringify([scope.campaign_id, scope.parent_node_id, scope.child_node_id]);
  return Object.freeze({
    status: "bound",
    scope_id_hash: `sha256:${createHash("sha256").update(scopeId).digest("hex")}`,
    provenance_tag: scope.provenance.tag,
  });
}

const BUS_THREAD_READ_ACTION_SCOPE: NativeToolActionScopeEvidence = Object.freeze({ status: "not_required" });

async function busThreadSend(
  options: NativeBusThreadToolOptions,
  request: NativeToolRequest,
  now: () => Date,
  randomId: () => string,
  signal: AbortSignal,
  onAccepted?: (messageId: string) => void,
): Promise<NativeToolResponse> {
  const scope = options.resolve_scope({ session_id: request.session_id });
  if (scope === null) return busThreadFailureResponse("bus.thread.send", failure("audit", "missing_bus_thread_scope", "execution refused: no trusted parent-edge scope for this session"), Object.freeze({ status: "absent" }));
  const actionScope = busThreadActionScope(scope);
  if (actionScope.status !== "bound") return busThreadFailureResponse("bus.thread.send", failure("audit", "bus_thread_scope_invalid", "execution refused: trusted parent-edge scope has invalid provenance"), actionScope);
  if (signal.aborted) return busThreadFailureResponse("bus.thread.send", failure("execution", "cancelled", "bus thread send cancelled before start"), actionScope);
  try {
    const value = record(request.input);
    const mismatch = busThreadScopeMismatch(value, scope);
    if (mismatch !== null) return busThreadFailureResponse("bus.thread.send", failure("audit", "bus_thread_scope_denied", `execution refused: ${mismatch}`), Object.freeze({ status: "invalid" }));
    const messageKind = stringField(value, "message_kind", 1, 32);
    if (!BUS_THREAD_MESSAGE_KINDS.has(messageKind as NodeCommunication["kind"])) throw failure("semantic", "message_kind_invalid", "message_kind must be a valid bus message kind");
    const intent = optionalString(value, "intent");
    if (intent !== undefined && !BUS_THREAD_INTENTS.has(intent as NonNullable<NodeCommunication["intent"]>)) throw failure("semantic", "intent_invalid", "intent must be a valid transport intent");
    const content = stringField(value, "content", 1, 8_192);
    const expectedThreadVersion = stringField(value, "expected_thread_version", 1, 256);
    const evidenceRefs = optionalEvidenceRefs(value);
    const ackRequired = optionalBoolean(value, "ack_required") ?? false;
    const deadlineAt = optionalString(value, "deadline_at");
    if (deadlineAt !== undefined && Number.isNaN(Date.parse(deadlineAt))) throw failure("semantic", "deadline_at_invalid", "deadline_at must be ISO-parseable");
    const callKey = `native-bus-thread-send:${request.session_id}:${request.call_id}`;
    const envelope = {
      schema_version: 1 as const,
      metadata: {
        operation_id: `${callKey}:${randomId()}`.slice(0, 200),
        idempotency_key: callKey,
        correlation_id: request.session_id,
        actor_id: scope.child_node_id,
        requested_at: now().toISOString(),
      },
      command: {
        kind: "bus.thread.send" as const,
        campaign_id: scope.campaign_id,
        parent_node_id: scope.parent_node_id,
        child_node_id: scope.child_node_id,
        from_node_id: scope.child_node_id,
        expected_thread_version: expectedThreadVersion,
        message_kind: messageKind as NodeCommunication["kind"],
        ...(intent === undefined ? {} : { intent: intent as NonNullable<NodeCommunication["intent"]> }),
        content,
        ...(evidenceRefs === undefined ? {} : { evidence_refs: evidenceRefs }),
        provenance: scope.provenance,
        capability_tier: scope.capability_tier,
        acknowledges_communication_id: optionalString(value, "acknowledges_communication_id") ?? null,
        retracts_communication_id: optionalString(value, "retracts_communication_id") ?? null,
        parent_communication_id: optionalString(value, "parent_communication_id") ?? null,
        reply_to_communication_id: optionalString(value, "reply_to_communication_id") ?? null,
        ack_required: ackRequired,
        deadline_at: deadlineAt ?? null,
      },
    };
    const result = await options.router.dispatchCommand(envelope);
    if (!result.ok) throw failure("audit", "bus_thread_send_rejected", result.error.summary);
    const outcome = result.value as { accepted: boolean; message_id?: string; thread_id?: string; error?: { summary?: string } };
    if (!outcome.accepted) throw failure("execution", "bus_thread_send_failed", outcome.error?.summary ?? "bus thread send failed");
    if (typeof outcome.message_id !== "string") throw failure("execution", "bus_thread_send_missing_id", "bus thread send was accepted without a message id");
    onAccepted?.(outcome.message_id);
    return busThreadSuccess("bus.thread.send", `message posted on parent-child thread ${outcome.thread_id ?? ""}`, { message_id: outcome.message_id, thread_id: outcome.thread_id }, "applied", actionScope);
  } catch (error) {
    return busThreadFailureResponse("bus.thread.send", asFailure(error), Object.freeze({ status: "invalid" }));
  }
}

async function busThreadAck(options: NativeBusThreadToolOptions, request: NativeToolRequest, now: () => Date, randomId: () => string, signal: AbortSignal): Promise<NativeToolResponse> {
  const scope = options.resolve_scope({ session_id: request.session_id });
  if (scope === null) return busThreadFailureResponse("bus.thread.ack", failure("audit", "missing_bus_thread_scope", "execution refused: no trusted parent-edge scope for this session"), Object.freeze({ status: "absent" }));
  const actionScope = busThreadActionScope(scope);
  if (actionScope.status !== "bound") return busThreadFailureResponse("bus.thread.ack", failure("audit", "bus_thread_scope_invalid", "execution refused: trusted parent-edge scope has invalid provenance"), actionScope);
  if (signal.aborted) return busThreadFailureResponse("bus.thread.ack", failure("execution", "cancelled", "bus thread ack cancelled before start"), actionScope);
  try {
    const value = record(request.input);
    const mismatch = busThreadScopeMismatch(value, scope);
    if (mismatch !== null) return busThreadFailureResponse("bus.thread.ack", failure("audit", "bus_thread_scope_denied", `execution refused: ${mismatch}`), Object.freeze({ status: "invalid" }));
    const messageId = stringField(value, "message_id", 1, 256);
    const expectedThreadVersion = stringField(value, "expected_thread_version", 1, 256);
    const callKey = `native-bus-thread-ack:${request.session_id}:${request.call_id}`;
    const envelope = {
      schema_version: 1 as const,
      metadata: {
        operation_id: `${callKey}:${randomId()}`.slice(0, 200),
        idempotency_key: callKey,
        correlation_id: request.session_id,
        actor_id: scope.child_node_id,
        requested_at: now().toISOString(),
      },
      command: {
        kind: "bus.thread.ack" as const,
        campaign_id: scope.campaign_id,
        parent_node_id: scope.parent_node_id,
        child_node_id: scope.child_node_id,
        from_node_id: scope.child_node_id,
        expected_thread_version: expectedThreadVersion,
        message_id: messageId,
        provenance: scope.provenance,
        capability_tier: scope.capability_tier,
      },
    };
    const result = await options.router.dispatchCommand(envelope);
    if (!result.ok) throw failure("audit", "bus_thread_ack_rejected", result.error.summary);
    const outcome = result.value as { accepted: boolean; message_id?: string; thread_id?: string; error?: { summary?: string } };
    if (!outcome.accepted) throw failure("execution", "bus_thread_ack_failed", outcome.error?.summary ?? "bus thread ack failed");
    return busThreadSuccess("bus.thread.ack", `acknowledged ${messageId} on parent-child thread ${outcome.thread_id ?? ""}`, { message_id: outcome.message_id, thread_id: outcome.thread_id }, "applied", actionScope);
  } catch (error) {
    return busThreadFailureResponse("bus.thread.ack", asFailure(error), Object.freeze({ status: "invalid" }));
  }
}

async function siblingStatus(options: NativeBusThreadToolOptions, request: NativeToolRequest, signal: AbortSignal): Promise<NativeToolResponse> {
  const scope = options.resolve_scope({ session_id: request.session_id });
  if (scope === null) return busThreadFailureResponse("sibling.status", failure("audit", "missing_bus_thread_scope", "execution refused: no trusted parent-edge scope for this session"), Object.freeze({ status: "absent" }));
  if (signal.aborted) return busThreadFailureResponse("sibling.status", failure("execution", "cancelled", "sibling status cancelled before start"), BUS_THREAD_READ_ACTION_SCOPE);
  try {
    const value = request.input === undefined ? {} : record(request.input);
    const campaignId = optionalString(value, "campaign_id");
    if (campaignId !== undefined && campaignId !== scope.campaign_id) throw failure("audit", "bus_thread_scope_denied", "execution refused: campaign_id does not match this session's dispatched edge");
    const nodeId = optionalString(value, "node_id");
    if (nodeId !== undefined && nodeId !== scope.child_node_id) throw failure("audit", "bus_thread_scope_denied", "execution refused: node_id does not match this session's dispatched edge");
    const envelope = { schema_version: 1 as const, query_id: `native-sibling-status:${request.session_id}:${request.call_id}`, query: { kind: "sibling.status" as const, campaign_id: scope.campaign_id, node_id: scope.child_node_id } };
    const result = options.router.executeQuery(envelope);
    if (!result.ok) throw failure("execution", "sibling_status_failed", result.error.summary);
    return busThreadSuccess("sibling.status", "sibling status returned", result.value as Record<string, unknown>, "observed", BUS_THREAD_READ_ACTION_SCOPE);
  } catch (error) {
    return busThreadFailureResponse("sibling.status", asFailure(error), Object.freeze({ status: "invalid" }));
  }
}

/**
 * Trusted, host-resolved identity for one currently dispatched native
 * session's own governed user-input channel — never taken from model input
 * (see `native-agent-executor.ts`'s `user_input_for_session`).
 */
export interface NativeUserInputToolOptions {
  readonly router: NativeBusThreadRouter;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly session_id: string;
  readonly now?: () => Date;
  readonly random_id?: () => string;
}

/**
 * Typed risk classification for the `userinput.ask` port, mirroring
 * `NATIVE_REPOSITORY_TOOL_RISKS` for a tool hosted outside
 * `NativeRepositoryToolHost` — the same role `NATIVE_BUS_THREAD_MODEL_TOOLS`
 * fills for the bus-thread ports. `cli.ts`'s advertised definition and this
 * map are bound together by a parity test.
 */
export const NATIVE_USERINPUT_TOOL_RISKS = NATIVE_TOOL_RISK_MANIFEST.userinput satisfies Record<string, NativeToolRisk>;

const USERINPUT_ASK_OUTPUT_BYTES = 4 * 1024;
const USERINPUT_ASK_MAX_QUESTION_LENGTH = 4_096;
const USERINPUT_ASK_DEFAULT_OPTION_ID = "provide-answer";
const USERINPUT_ASK_MAX_OPTIONS = 12;
const USERINPUT_ASK_MAX_OPTION_ID_LENGTH = 64;
const USERINPUT_ASK_MAX_OPTION_TEXT_LENGTH = 512;

/**
 * The operator-facing choices for one question.
 *
 * WHY THIS EXISTS. `RequestUserInput` has carried real `options` since ADR-019,
 * the TUI compose overlay reads them, and its answer path matches a typed
 * option id (or a `id, note` prefix) and refuses free text unless some option
 * declares `is_other`. Every layer supported a multiple-choice question except
 * this port, which hardcoded a single `provide-answer` free-text option — so a
 * model could only ever ask the operator an essay question, and the governance
 * interview (`revoy2-interview`, which requires a MULTIPLE-CHOICE surface and
 * says so) could not be conducted natively at all.
 *
 * WHAT IS DELIBERATELY NOT EXPOSED. `question.blocking` stays pinned to
 * `"async"`. The field is validated in two places and rendered as a column in
 * the interviews screen, but NOTHING consumes it to halt a session: a
 * repository-wide search finds only its validators and its display. Advertising
 * a `blocking` parameter would offer a model a halt that does not happen, which
 * is worse than not offering it. A model that genuinely cannot proceed uses the
 * existing `request_human_input` halting convention, and the tool description
 * says so.
 */
function userInputOptions(value: Record<string, unknown>): readonly UserInputOption[] {
  const raw = value.options;
  if (raw === undefined) {
    // Backward compatible: a question with no declared choices keeps the
    // free-text shape every existing caller and test already depends on.
    return Object.freeze([{ id: USERINPUT_ASK_DEFAULT_OPTION_ID, text: "Provide an answer", is_other: true }]);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw failure("semantic", "options_invalid", "options must be a non-empty array when provided");
  }
  if (raw.length > USERINPUT_ASK_MAX_OPTIONS) {
    throw failure("semantic", "options_invalid", `options must declare at most ${USERINPUT_ASK_MAX_OPTIONS} choices`);
  }
  const seen = new Set<string>();
  const parsed = raw.map((entry, index) => {
    const option = record(entry);
    const id = stringField(option, "id", 1, USERINPUT_ASK_MAX_OPTION_ID_LENGTH);
    // The TUI matches a typed answer against the id case-insensitively, so ids
    // that differ only in case are indistinguishable to the operator and the
    // wrong one would be recorded. Refuse rather than pick.
    const key = id.toLocaleLowerCase();
    if (seen.has(key)) throw failure("semantic", "options_invalid", `options[${index}].id duplicates an earlier id (case-insensitively): ${id}`);
    seen.add(key);
    const text = stringField(option, "text", 1, USERINPUT_ASK_MAX_OPTION_TEXT_LENGTH);
    const isOther = option.is_other;
    if (isOther !== undefined && typeof isOther !== "boolean") {
      throw failure("semantic", "options_invalid", `options[${index}].is_other must be a boolean when provided`);
    }
    return Object.freeze({ id, text, is_other: isOther === true });
  });
  return Object.freeze(parsed);
}

/**
 * The model-callable ask-operator tool (parity gap #6). It is deliberately
 * distinct from the existing child→parent `clarify` bus message (a
 * dispatched-child-to-dispatching-parent conversation) and from the existing
 * halting `request_human_input` convention (which ends the current turn and
 * awaits a fresh continuation, `native-agent-executor.ts`'s
 * `human_input_for_session`): this port submits a durable, async
 * `RequestUserInput` question through the *existing* ADR-019 ledger
 * machinery — the same `userinput.ask` catalog command `RuntimeCatalogRouter`
 * already dispatches for every other caller (`runtime-catalog.ts`), reached
 * here exactly the way `bus.thread.send` reaches `bus.thread.send` above —
 * and returns its durable record id immediately so the session can keep
 * working. No parallel question queue; no in-session answer.
 */
export function createNativeUserInputToolPort(options: NativeUserInputToolOptions): NativeToolPort {
  return Object.freeze({
    tool: "userinput.ask",
    recovery_protection: () => Object.freeze({ effect_kind: "external" as const, repeatable: false, idempotency_key_hash: null, acknowledged_by: null }),
    execute: (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => userInputAsk(options, request, signal),
  }) as NativeToolPort;
}

const USERINPUT_ASK_ACTION_SCOPE: NativeToolActionScopeEvidence = Object.freeze({ status: "not_required" });

function userInputResponse(outcome: NativeToolOutcome, stage: NativeToolOutcomeStage, code: string, summary: string, effect: NativeToolEffect, payload: Record<string, unknown> = {}): NativeToolResponse {
  const evidence: NativeToolExecutionEvidence = Object.freeze({ outcome, stage, code, effect, confinement: "application_validated", action_scope: USERINPUT_ASK_ACTION_SCOPE });
  return Object.freeze({
    result_summary: redact(summary).slice(0, 512),
    model_output: boundedToolModelOutput({ outcome, stage, code, ...payload }, USERINPUT_ASK_OUTPUT_BYTES, "userinput.ask"),
    evidence,
  });
}

async function userInputAsk(options: NativeUserInputToolOptions, request: NativeToolRequest, signal: AbortSignal): Promise<NativeToolResponse> {
  if (signal.aborted) return userInputResponse("cancelled", "execution", "cancelled", "userinput.ask cancelled before start", "none");
  try {
    const value = record(request.input);
    const question = stringField(value, "question", 1, USERINPUT_ASK_MAX_QUESTION_LENGTH);
    const askOptions = userInputOptions(value);
    const now = options.now ?? (() => new Date());
    const randomId = options.random_id ?? (() => createHash("sha256").update(`${Date.now()}:${Math.random()}:${Math.random()}`).digest("hex").slice(0, 32));
    const callKey = `native-userinput-ask:${request.session_id}:${request.call_id}`;
    const nowIso = now().toISOString();
    const envelope = {
      schema_version: 1 as const,
      metadata: {
        operation_id: `${callKey}:${randomId()}`.slice(0, 200),
        idempotency_key: callKey,
        correlation_id: request.session_id,
        actor_id: options.node_id,
        requested_at: nowIso,
      },
      command: {
        kind: "userinput.ask" as const,
        campaign_id: options.campaign_id,
        node_id: options.node_id,
        question: {
          operation_id: `${callKey}:${randomId()}`.slice(0, 200),
          question,
          options: askOptions,
          authority: "delegated_needs_input" as const,
          blocking: "async" as const,
          requester_role: "native-model",
          origin_session_id: request.session_id,
          idempotency_key: callKey,
          as_of: nowIso,
        },
      },
    };
    const result = await options.router.dispatchCommand(envelope);
    if (!result.ok) throw failure("audit", "userinput_ask_rejected", result.error.summary);
    const outcome = result.value as { accepted: boolean; record_id?: string; error?: { summary?: string } };
    if (!outcome.accepted) throw failure("execution", "userinput_ask_failed", outcome.error?.summary ?? "userinput.ask failed");
    return userInputResponse("succeeded", "execution", "ok", "governed user-input question recorded", "applied", { record_id: outcome.record_id });
  } catch (error) {
    const failed = asFailure(error);
    return userInputResponse(failed.outcome, failed.stage, failed.code, failed.summary, failed.outcome === "refused" ? "none" : "unknown");
  }
}

/**
 * Trusted, host-resolved read-only skill-catalog view for `skill.load` /
 * `skill.list` — the model-callable parity point ADR-087 item 3/4 names
 * (`packages/arbor-mcp/src/skills/catalog.ts`'s `SkillCatalog.resolve`/
 * `list`, unchanged). A skill pack carries NO authority of its own: the
 * resolved descriptor's `allowed_tools`/`write_path_patterns` can only ever
 * NARROW what `native-role-composer.ts` already admitted for this session
 * (see its `skillTools` intersection and `skillPatternMatches` there) at
 * *dispatch* time, before this session's tool surface was ever fixed.
 * `skill.load` here runs strictly AFTER that surface is fixed: it returns
 * bounded instructions text for the model to follow mid-session and nothing
 * else — no tool is added, removed, or reconfigured by calling it.
 */
export interface NativeSkillCatalogPort {
  resolve(skill_id: string, version: string): ValidatedSkill | null;
  list(): readonly ValidatedSkill[];
}

/**
 * Typed risk classification for the `skill.load`/`skill.list` ports,
 * mirroring `NATIVE_USERINPUT_TOOL_RISKS` for tools hosted outside
 * `NativeRepositoryToolHost`. `cli.ts`'s advertised definitions and this map
 * are bound together by a parity test (house rule from commit a8733329:
 * advertised risk must READ this map, never repeat a literal).
 */
export const NATIVE_SKILL_TOOL_RISKS = NATIVE_TOOL_RISK_MANIFEST.skill satisfies Record<string, NativeToolRisk>;

const SKILL_LOAD_OUTPUT_BYTES = 20 * 1024;
const SKILL_LIST_OUTPUT_BYTES = 8 * 1024;
const SKILL_LIST_MAX_NAMES = 64;
const SKILL_TOOL_ACTION_SCOPE: NativeToolActionScopeEvidence = Object.freeze({ status: "not_required" });

function skillToolResponse(tool: string, maxBytes: number, outcome: NativeToolOutcome, stage: NativeToolOutcomeStage, code: string, summary: string, effect: NativeToolEffect, payload: Record<string, unknown> = {}): NativeToolResponse {
  const evidence: NativeToolExecutionEvidence = Object.freeze({ outcome, stage, code, effect, confinement: "application_validated", action_scope: SKILL_TOOL_ACTION_SCOPE });
  return Object.freeze({
    result_summary: redact(summary).slice(0, 512),
    model_output: boundedToolModelOutput({ outcome, stage, code, ...payload }, maxBytes, tool),
    evidence,
  });
}

function skillNames(catalog: NativeSkillCatalogPort): readonly string[] {
  return catalog.list().slice(0, SKILL_LIST_MAX_NAMES).map((skill) => `${skill.skill_id}@${skill.version}`);
}

/**
 * Model-callable `skill.load` (ADR-087 item 3): resolves one catalog
 * descriptor by exact skill_id/version and returns its instructions as
 * bounded tool output. An unknown skill is a typed refusal that lists the
 * currently loadable names, so the model can retry with a real one instead
 * of guessing blind.
 */
async function skillLoad(catalog: NativeSkillCatalogPort, request: NativeToolRequest, signal: AbortSignal): Promise<NativeToolResponse> {
  if (signal.aborted) return skillToolResponse("skill.load", SKILL_LOAD_OUTPUT_BYTES, "cancelled", "execution", "cancelled", "skill.load cancelled before start", "none");
  try {
    const value = record(request.input);
    const skillId = stringField(value, "skill_id", 1, 64);
    const version = stringField(value, "version", 1, 128);
    const skill = catalog.resolve(skillId, version);
    if (skill === null) throw failure("semantic", "skill_not_found", `skill ${skillId}@${version} is not in the loadable catalog`);
    return skillToolResponse("skill.load", SKILL_LOAD_OUTPUT_BYTES, "succeeded", "execution", "ok", `loaded skill ${skillId}@${version}`, "observed", {
      skill_id: skill.skill_id, version: skill.version, role: skill.role, instruction: skill.instruction,
      descriptor_hash: `sha256:${skill.descriptor_hash}`,
      bundle: skill.bundle,
      declared_inputs: skill.bundle_files,
      declared_tools: skill.allowed_tools,
      declared_write_paths: skill.write_path_patterns,
      structured_output: skill.structured_output,
    });
  } catch (error) {
    const failed = asFailure(error);
    const available = failed.code === "skill_not_found" ? { available_skills: skillNames(catalog) } : {};
    return skillToolResponse("skill.load", SKILL_LOAD_OUTPUT_BYTES, failed.outcome, failed.stage, failed.code, failed.summary, failed.outcome === "refused" ? "none" : "unknown", available);
  }
}

/** Model-callable `skill.list` (ADR-087 item 4): bounded discovery for skill.load. */
async function skillList(catalog: NativeSkillCatalogPort, signal: AbortSignal): Promise<NativeToolResponse> {
  if (signal.aborted) return skillToolResponse("skill.list", SKILL_LIST_OUTPUT_BYTES, "cancelled", "execution", "cancelled", "skill.list cancelled before start", "none");
  const skills = catalog.list().slice(0, SKILL_LIST_MAX_NAMES).map((skill) => ({ skill_id: skill.skill_id, version: skill.version, role: skill.role }));
  return skillToolResponse("skill.list", SKILL_LIST_OUTPUT_BYTES, "succeeded", "execution", "ok", `${skills.length} loadable skill(s)`, "observed", { skills });
}

export function createNativeSkillToolPorts(options: { readonly skill_catalog: NativeSkillCatalogPort }): readonly NativeToolPort[] {
  return Object.freeze([
    Object.freeze({
      tool: "skill.load",
      recovery_protection: () => Object.freeze({ effect_kind: "read_only" as const, repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      execute: (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => skillLoad(options.skill_catalog, request, signal),
    }),
    Object.freeze({
      tool: "skill.list",
      recovery_protection: () => Object.freeze({ effect_kind: "read_only" as const, repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      execute: (_request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => skillList(options.skill_catalog, signal),
    }),
  ]) as readonly NativeToolPort[];
}

/**
 * Model-callable mid-session governed image discovery/attach (the last
 * native tool-surface parity gap: ADR-087 O3 wired governed image DELIVERY
 * at dispatch — pre-campaign attachments folding into the first request —
 * but a running native specialist had no way to pull a *later* campaign-held
 * image into a subsequent turn). The model may only reference an image the
 * CAMPAIGN ITSELF already holds (the exact catalog `governed_artifacts_for_campaign`
 * resolves at dispatch, `task-attachment-store.ts`'s content-addressed
 * store): it can never fetch an arbitrary URL or filesystem path as an
 * image — that would bypass the governed-media boundary `web.fetch` and the
 * repository file tools already enforce separately, and never send image
 * bytes through a non-consuming connector (the README invariant). A request
 * for an unknown id is a typed refusal, not a silent no-op.
 *
 * `image.list` returns bounded metadata only (never raw bytes). `image.attach`
 * folds the resolved artifact onto `NativeToolResponse.governed_artifact_attached`;
 * `NativeHarnessWorker.executeTool` (native-worker.ts) is the only place that
 * artifact is trusted and appended to the session's governed context, so
 * every subsequent turn resends it through the exact same image content-block
 * path `openai-compatible.ts`/`anthropic-messages.ts`'s `governedImages()`
 * already builds for dispatch-time images — no second image encoder.
 */
export interface NativeGovernedImageCatalogPort {
  /** Bounded, campaign-scoped, already-resolved image artifacts only — never documents, never an arbitrary fetch. */
  images(): readonly import("@arbor/harness").NativeGovernedArtifact[];
}

/**
 * Typed risk classification for `image.attach`/`image.list`, mirroring
 * `NATIVE_SKILL_TOOL_RISKS` for tools hosted outside `NativeRepositoryToolHost`.
 * `cli.ts`'s advertised definitions and this map are bound together by a
 * parity test (house rule from commit a8733329: advertised risk must READ
 * this map, never repeat a literal). Both are "low": neither tool has a
 * filesystem, shell, or network effect — they only re-surface content the
 * campaign already authorized and this session's dispatch could already see.
 */
export const NATIVE_IMAGE_TOOL_RISKS = NATIVE_TOOL_RISK_MANIFEST.image satisfies Record<string, NativeToolRisk>;

const IMAGE_LIST_OUTPUT_BYTES = 8 * 1024;
const IMAGE_ATTACH_OUTPUT_BYTES = 2 * 1024;
/** Mirrors `TASK_ATTACHMENT_MAX_COUNT` (task-attachment-store.ts): the same bound on how much governed image material one session may carry. */
export const NATIVE_IMAGE_ATTACH_MAX_PER_SESSION = 4;
const IMAGE_TOOL_ACTION_SCOPE: NativeToolActionScopeEvidence = Object.freeze({ status: "not_required" });

function imageToolResponse(tool: string, maxBytes: number, outcome: NativeToolOutcome, stage: NativeToolOutcomeStage, code: string, summary: string, effect: NativeToolEffect, payload: Record<string, unknown> = {}): NativeToolResponse {
  const evidence: NativeToolExecutionEvidence = Object.freeze({ outcome, stage, code, effect, confinement: "application_validated", action_scope: IMAGE_TOOL_ACTION_SCOPE });
  return Object.freeze({
    result_summary: redact(summary).slice(0, 512),
    model_output: boundedToolModelOutput({ outcome, stage, code, ...payload }, maxBytes, tool),
    evidence,
  });
}

function imageNames(catalog: NativeGovernedImageCatalogPort): readonly string[] {
  return catalog.images().map((artifact) => artifact.artifact_id);
}

/** Model-callable `image.list`: bounded discovery for `image.attach`. Metadata only — id/media_type/byte_length, never raw image bytes. */
async function imageList(catalog: NativeGovernedImageCatalogPort, signal: AbortSignal): Promise<NativeToolResponse> {
  if (signal.aborted) return imageToolResponse("image.list", IMAGE_LIST_OUTPUT_BYTES, "cancelled", "execution", "cancelled", "image.list cancelled before start", "none");
  const images = catalog.images().map((artifact) => ({
    artifact_id: artifact.artifact_id,
    media_type: artifact.media_type,
    byte_length: artifact.encoding === "base64" ? Buffer.from(artifact.content, "base64").byteLength : Buffer.byteLength(artifact.content, "utf8"),
  }));
  return imageToolResponse("image.list", IMAGE_LIST_OUTPUT_BYTES, "succeeded", "execution", "ok", `${images.length} governed image(s) available`, "observed", { images });
}

/**
 * Model-callable `image.attach`: folds one campaign-held governed image into
 * this session's governed context so it reaches the NEXT model turn's
 * content blocks exactly like a dispatch-time attachment (see
 * `NativeHarnessWorker.attachGovernedArtifact`). Attaching the same image
 * twice is idempotent — it does not consume a second slot of the
 * per-session cap. An unknown `artifact_id` or an exhausted cap is a typed
 * refusal that lists what is currently attachable, never a silent drop.
 */
function imageAttach(catalog: NativeGovernedImageCatalogPort, attached: Set<string>, maxAttachments: number, request: NativeToolRequest, signal: AbortSignal): NativeToolResponse {
  if (signal.aborted) return imageToolResponse("image.attach", IMAGE_ATTACH_OUTPUT_BYTES, "cancelled", "execution", "cancelled", "image.attach cancelled before start", "none");
  try {
    const value = record(request.input);
    const artifactId = stringField(value, "artifact_id", 1, 256);
    const found = catalog.images().find((artifact) => artifact.artifact_id === artifactId);
    if (found === undefined) throw failure("semantic", "image_not_found", `image ${artifactId} is not a governed image this campaign holds`);
    if (!attached.has(artifactId) && attached.size >= maxAttachments) throw failure("semantic", "image_attach_limit_exceeded", `at most ${maxAttachments} governed image(s) may be attached per session`);
    attached.add(artifactId);
    const base = imageToolResponse("image.attach", IMAGE_ATTACH_OUTPUT_BYTES, "succeeded", "execution", "ok", `attached governed image ${artifactId}`, "applied", { artifact_id: artifactId, media_type: found.media_type });
    return Object.freeze({ ...base, governed_artifact_attached: found });
  } catch (error) {
    const failed = asFailure(error);
    const available = failed.code === "image_not_found" ? { available_images: imageNames(catalog) } : {};
    return imageToolResponse("image.attach", IMAGE_ATTACH_OUTPUT_BYTES, failed.outcome, failed.stage, failed.code, failed.summary, failed.outcome === "refused" ? "none" : "unknown", available);
  }
}

/**
 * Composition seam: only ever constructed when the session's provider is
 * image-capable AND governed-artifact transport is authorized (mirrors
 * `web.fetch`/`web.search`'s deny-by-default composition gate in `cli.ts`
 * and `skill_catalog`'s always-present-but-role-intersected pattern) — an
 * unauthorized or non-image-capable session's `specialist_tools` factory
 * simply never calls this, so `image.attach`/`image.list` are absent from
 * its candidate tool set entirely, not merely denied at execution.
 * `attached` is a fresh closure per call (one call per session, from
 * `specialist_tools`), so the per-session cap is never shared cross-session.
 */
export function createNativeImageToolPorts(options: { readonly image_catalog: NativeGovernedImageCatalogPort; readonly max_attachments?: number }): readonly NativeToolPort[] {
  const attached = new Set<string>();
  const maxAttachments = options.max_attachments ?? NATIVE_IMAGE_ATTACH_MAX_PER_SESSION;
  return Object.freeze([
    Object.freeze({
      tool: "image.list",
      recovery_protection: () => Object.freeze({ effect_kind: "read_only" as const, repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      execute: (_request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => imageList(options.image_catalog, signal),
    }),
    Object.freeze({
      tool: "image.attach",
      recovery_protection: () => Object.freeze({ effect_kind: "read_only" as const, repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      execute: async (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => imageAttach(options.image_catalog, attached, maxAttachments, request, signal),
    }),
  ]) as readonly NativeToolPort[];
}

function canonicalRoots(roots: readonly string[]): readonly string[] {
  if (roots.length === 0) throw failure("sandbox", "workspace_roots_missing", "execution refused: no workspace roots were supplied");
  const canonical = roots.map((root) => {
    if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) throw failure("sandbox", "workspace_root_invalid", "execution refused: workspace roots must be absolute paths");
    const value = realpathSync(root);
    if (!statSync(value).isDirectory()) throw failure("sandbox", "workspace_root_invalid", "execution refused: workspace root is not a directory");
    return value;
  });
  if (new Set(canonical).size !== canonical.length) throw failure("sandbox", "workspace_root_duplicate", "execution refused: workspace roots must be unique");
  return Object.freeze(canonical.sort());
}

function selectRoot(roots: readonly string[], requested: string | undefined): string {
  if (requested === undefined) {
    if (roots.length !== 1) throw failure("semantic", "workspace_root_required", "multiple workspace roots require an explicit workspace_root");
    return roots[0]!;
  }
  if (!isAbsolute(requested)) throw failure("semantic", "workspace_root_invalid", "workspace_root must be a canonical admitted absolute path");
  const canonical = realpathSync(requested);
  if (!roots.includes(canonical)) throw failure("sandbox", "workspace_root_not_admitted", "workspace_root is outside the admitted set");
  return canonical;
}

function existingPath(root: string, path: string, expected: "file" | "directory" | "any"): string {
  // A directory (or either-kind) lookup may name the workspace root itself; a
  // file lookup never can, so it keeps the strict spelling.
  const candidate = resolveRelative(root, path, expected !== "file");
  if (!existsSync(candidate)) throw failure("semantic", "path_not_found", "requested path does not exist");
  const canonical = realpathSync(candidate);
  if (!inside(root, canonical)) throw failure("sandbox", "symlink_escape", "requested path resolves outside its workspace");
  const info = statSync(canonical);
  if ((expected === "file" && !info.isFile()) || (expected === "directory" && !info.isDirectory())) throw failure("semantic", "path_kind_invalid", `requested path is not a ${expected}`);
  return canonical;
}

function writablePath(root: string, path: string, create: boolean): string {
  const target = resolveRelative(root, path);
  const parent = dirname(target);
  let probe = parent;
  while (!existsSync(probe)) {
    const next = dirname(probe);
    if (next === probe) throw failure("sandbox", "path_outside_workspace", "write target is outside its workspace");
    probe = next;
  }
  ensureCanonicalParent(root, probe);
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw failure("sandbox", "symlink_escape", "write refused through a symbolic link");
    const canonical = realpathSync(target);
    if (!inside(root, canonical)) throw failure("sandbox", "symlink_escape", "write target resolves outside its workspace");
  } else if (!create) {
    throw failure("semantic", "path_not_found", "write target does not exist; set create to true for a new file");
  }
  return target;
}

function ensureCanonicalParent(root: string, parent: string): void {
  const canonical = realpathSync(parent);
  if (!inside(root, canonical)) throw failure("sandbox", "symlink_escape", "parent directory resolves outside its workspace");
}

/**
 * The spellings a model uses for "the workspace root itself". `.` is a path
 * segment the traversal rule below refuses, so before this was accepted a
 * `cwd: "."` -- the commonest way to say "run it here" -- was refused as
 * `path_traversal` (UCT Stage 0, 2026-10-07).
 */
const WORKSPACE_ROOT_SPELLINGS: ReadonlySet<string> = new Set(["", ".", "./"]);

/**
 * The directory a command runs in. `cwd` is optional; omitted or a root
 * spelling means the workspace root, a relative path must name an existing
 * directory inside it, and an absolute path is admitted only when it
 * canonicalizes to an existing directory inside the workspace root -- the
 * model-visible tool description promises exactly "must resolve inside the
 * workspace root", and an absolute spelling of the worktree is how models
 * most often say it.
 */
function commandCwd(root: string, value: Record<string, unknown>): string {
  const field = value.cwd;
  if (field === undefined) return root;
  if (typeof field !== "string" || field.length > 1_024 || field.includes("\u0000")) throw failure("semantic", "cwd_invalid", "cwd must be a bounded string");
  if (WORKSPACE_ROOT_SPELLINGS.has(field)) return root;
  if (!isAbsolute(field)) return existingPath(root, field, "directory");
  if (!existsSync(field)) throw failure("semantic", "path_not_found", "requested path does not exist");
  const canonical = realpathSync(field);
  if (!inside(root, canonical)) throw failure("sandbox", "path_outside_workspace", "cwd is outside its workspace");
  if (!statSync(canonical).isDirectory()) throw failure("semantic", "path_kind_invalid", "requested path is not a directory");
  return canonical;
}

function resolveRelative(root: string, path: string, allowRoot = false): string {
  if (allowRoot && typeof path === "string" && WORKSPACE_ROOT_SPELLINGS.has(path)) return root;
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) throw failure("semantic", "path_invalid", "path must be a non-empty relative path");
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) throw failure("sandbox", "path_traversal", "path traversal is not permitted");
  const candidate = resolve(root, path);
  if (!inside(root, candidate)) throw failure("sandbox", "path_outside_workspace", "path is outside its workspace");
  return candidate;
}

function inside(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

/** Provider/model-visible repository paths use one portable canonical spelling. */
function relativeRepositoryPath(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

function sensitive(path: string): boolean { return SENSITIVE_BASENAME.test(basename(path)); }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw failure("semantic", "input_invalid", "tool input must be an object");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, min: number, max: number): string {
  const field = value[key];
  if (typeof field !== "string" || field.length < min || field.length > max) throw failure("semantic", key + "_invalid", key + " must be a bounded string");
  return field;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.length === 0 || field.length > 1_024) throw failure("semantic", key + "_invalid", key + " must be a non-empty string");
  return field;
}

function optionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) throw failure("semantic", `${key}_invalid`, `${key} must be a finite number`);
  return candidate;
}

/**
 * Discovery tools are already confined to an admitted workspace, so common
 * model spellings for "the repository root" are safe aliases for an omitted
 * path. Keep this deliberately separate from file reads/writes and authority
 * scopes, where `/`, `\\`, and `.` must remain invalid exact file paths.
 */
function optionalRepositoryLocation(value: Record<string, unknown>, key: string): string | undefined {
  // JSON-schema tool callers commonly materialize an optional string as "".
  // For discovery only, that has the same confined meaning as omitting the
  // location: the already-admitted repository root. Do not route this through
  // optionalString: exact file and authority paths remain non-empty.
  if (value[key] === "") return undefined;
  const field = optionalString(value, key);
  return field === "." || field === "/" || field === "\\" ? undefined : field;
}

function optionalSha256(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || !/^sha256:[a-f0-9]{64}$/.test(field)) throw failure("semantic", key + "_invalid", key + " must be a sha256: prefix followed by 64 lowercase hex characters");
  return field;
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "boolean") throw failure("semantic", key + "_invalid", key + " must be a boolean");
  return field;
}

function optionalPositive(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field <= 0) throw failure("semantic", key + "_invalid", key + " must be a positive safe integer");
  return field;
}

function optionalBoundedInteger(value: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "number" || !Number.isInteger(field) || field < min || field > max) throw failure("semantic", key + "_invalid", `${key} must be an integer between ${min} and ${max}`);
  return field;
}

/** How far into a file `file.read` will count lines to find `start_line`; beyond it, page with `offset`. Mirrored in workspace-file.ts. */
const READ_LINE_SEEK_BYTES = 64 * 1024 * 1024;

function safeIntegerOr<T>(value: unknown, fallback: T): number | T {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** Applies `max_lines`, then line-aligns a window that stops before the end of the file. */
function windowCut(bytes: Buffer, offset: number, total: number, maxLines: number | undefined): Buffer {
  let end = bytes.length;
  if (maxLines !== undefined) {
    let seen = 0;
    for (let index = bytes.indexOf(0x0a); index !== -1; index = bytes.indexOf(0x0a, index + 1)) {
      seen += 1;
      if (seen === maxLines) { end = index + 1; break; }
    }
  }
  if (offset + end >= total || (maxLines !== undefined && end < bytes.length)) return bytes.subarray(0, end);
  return alignWindowEnd(bytes, end);
}

/**
 * Cut `bytes` at or before `end`: after the last LF when the window holds
 * one, otherwise (a single line longer than the window) on a UTF-8
 * character boundary, so the next window never starts mid-character.
 */
function alignWindowEnd(bytes: Buffer, end: number): Buffer {
  const newline = bytes.lastIndexOf(0x0a, end - 1);
  if (newline >= 0) return bytes.subarray(0, newline + 1);
  let lead = end - 1;
  while (lead > 0 && (bytes[lead]! & 0xc0) === 0x80) lead -= 1;
  const first = bytes[lead] ?? 0;
  const width = first < 0x80 ? 1 : first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
  return bytes.subarray(0, lead + width > end ? lead : end);
}

function countLineFeeds(bytes: Buffer): number {
  let count = 0;
  for (let index = bytes.indexOf(0x0a); index !== -1; index = bytes.indexOf(0x0a, index + 1)) count += 1;
  return count;
}

function readWindowPayload(path: string, bytes: Buffer, offset: number, startLine: number | null, total: number, request: { readonly lineMode: boolean; readonly maxBytes: number | undefined; readonly maxLines: number | undefined }): Record<string, unknown> {
  const endOffset = offset + bytes.length;
  const remaining = Math.max(0, total - endOffset);
  const complete = offset === 0 && remaining === 0;
  const feeds = countLineFeeds(bytes);
  const endsOnLine = bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
  const endLine = startLine === null || bytes.length === 0 ? null : startLine + feeds - (endsOnLine ? 1 : 0);
  const nextStartLine = startLine === null || !endsOnLine ? null : startLine + feeds;
  const sizing = { ...(request.maxBytes === undefined ? {} : { max_bytes: request.maxBytes }), ...(request.maxLines === undefined ? {} : { max_lines: request.maxLines }) };
  const nextWindow = remaining === 0 ? null : request.lineMode && nextStartLine !== null ? { path, start_line: nextStartLine, ...sizing } : { path, offset: endOffset, ...sizing };
  return {
    path,
    content: redact(bytes.toString("utf8")),
    bytes: bytes.length,
    total_bytes: total,
    offset,
    end_offset: endOffset,
    start_line: bytes.length === 0 ? null : startLine,
    end_line: endLine,
    remaining_bytes: remaining,
    truncated: !complete,
    next_window: nextWindow,
    content_sha256: complete ? sha256(bytes) : null,
  };
}

function readResultBytes(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify({ outcome: "succeeded", stage: "execution", code: "ok", ...payload }), "utf8");
}

type SearchSkipReason = "file_byte_limit" | "search_byte_budget" | "line_byte_limit" | "match_limit" | "read_failed" | "sensitive_path_denied";

interface SearchSkippedFile {
  readonly path: string;
  readonly bytes: number;
  /** Bytes of the file actually read; 0 when the file was not opened at all. */
  readonly scanned_bytes: number;
  readonly reason: SearchSkipReason;
}

interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly context_before: string[];
  readonly context_after: string[];
}

interface SearchState {
  readonly results: SearchMatch[];
  /** Files the walk reached (bounded by SEARCH_FILE_LIMIT), scanned or not. */
  visited: number;
  /** Files actually opened and read, fully or in part. */
  scanned: number;
  bytes: number;
  readonly reasons: Set<SearchSkipReason | "file_limit">;
  readonly skipped: SearchSkippedFile[];
  skippedOmitted: number;
  budgetExhausted: boolean;
}

function noteSearchSkip(state: SearchState, entry: SearchSkippedFile): void {
  // A sensitive file is a policy exclusion, not a bound: it is listed so the
  // model is never told it was searched, but it does not make the result
  // incomplete with respect to what this tool may search.
  if (entry.reason !== "sensitive_path_denied") state.reasons.add(entry.reason);
  if (state.skipped.length < SEARCH_SKIPPED_FILE_LIST_LIMIT) state.skipped.push(Object.freeze(entry));
  else state.skippedOmitted += 1;
}

function searchText(line: string): string { return redact(line).slice(0, SEARCH_MATCH_TEXT_CHARS); }

/**
 * H5: scan one file with a bounded streaming line reader. Lines split on the
 * LF byte (safe in UTF-8) with a trailing CR dropped, which reproduces the
 * old `split(/\r?\n/)` numbering. At most SEARCH_FILE_SCAN_BYTES of one file
 * and SEARCH_TOTAL_SCAN_BYTES across the search are read; a file stopped by
 * either bound, by an over-long line, or by the match limit is recorded in
 * `state.skipped` with the bytes actually read.
 */
function scanSearchFile(child: string, path: string, matches: (line: string) => boolean, contextLines: number, state: SearchState, signal: AbortSignal): void {
  let size: number;
  try { size = statSync(child).size; } catch { noteSearchSkip(state, { path, bytes: 0, scanned_bytes: 0, reason: "read_failed" }); return; }
  if (sensitive(child)) { noteSearchSkip(state, { path, bytes: size, scanned_bytes: 0, reason: "sensitive_path_denied" }); return; }
  const budget = SEARCH_TOTAL_SCAN_BYTES - state.bytes;
  if (budget <= 0) {
    state.budgetExhausted = true;
    noteSearchSkip(state, { path, bytes: size, scanned_bytes: 0, reason: "search_byte_budget" });
    return;
  }
  const fileBound = Math.min(SEARCH_FILE_SCAN_BYTES, budget);
  let fd: number;
  try { fd = openSync(child, "r"); } catch { noteSearchSkip(state, { path, bytes: size, scanned_bytes: 0, reason: "read_failed" }); return; }
  state.scanned += 1;
  const before: string[] = [];
  const pending: Array<{ entry: SearchMatch; remaining: number }> = [];
  let carry: Buffer[] = [];
  let carryBytes = 0;
  let lineCut = false;
  let lineNumber = 0;
  let position = 0;
  let consumed = 0;
  let stopped = false;
  const append = (piece: Buffer): void => {
    const room = SEARCH_LINE_BYTES - carryBytes;
    if (piece.length > room) lineCut = true;
    const kept = piece.length > room ? piece.subarray(0, Math.max(0, room)) : piece;
    if (kept.length > 0) { carry.push(Buffer.from(kept)); carryBytes += kept.length; }
  };
  const emit = (): void => {
    if (signal.aborted) throw failure("execution", "cancelled", "search cancelled");
    let line = (carry.length === 1 ? carry[0]! : Buffer.concat(carry, carryBytes)).toString("utf8");
    carry = [];
    carryBytes = 0;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    lineNumber += 1;
    for (const open of pending) { if (open.remaining > 0) { open.entry.context_after.push(searchText(line)); open.remaining -= 1; } }
    while (pending.length > 0 && pending[0]!.remaining === 0) pending.shift();
    // A pathological regex can make one line's test expensive; cancellation
    // is checked per line (above), not just per directory.
    if (state.results.length < SEARCH_MATCH_LIMIT && matches(line)) {
      const entry: SearchMatch = { path, line: lineNumber, text: searchText(line), context_before: before.map(searchText), context_after: [] };
      state.results.push(entry);
      if (contextLines > 0) pending.push({ entry, remaining: contextLines });
    }
    if (contextLines > 0) { before.push(line); if (before.length > contextLines) before.shift(); }
    // At the match limit, read on only far enough to fill the last match's
    // trailing context, then stop this file.
    if (state.results.length >= SEARCH_MATCH_LIMIT && pending.length === 0) stopped = true;
  };
  let complete = false;
  try {
    const buffer = Buffer.allocUnsafe(SEARCH_CHUNK_BYTES);
    reading: while (position < fileBound) {
      const read = readSync(fd, buffer, 0, Math.min(SEARCH_CHUNK_BYTES, fileBound - position), position);
      if (read === 0) { complete = true; break; }
      const chunk = buffer.subarray(0, read);
      let from = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, from);
        if (newline === -1) { append(chunk.subarray(from)); break; }
        append(chunk.subarray(from, newline));
        emit();
        from = newline + 1;
        consumed = position + from;
        if (stopped) break reading;
      }
      position += read;
      consumed = position;
    }
    // The bound landed exactly on the end of the file: probe for one more byte.
    if (!complete && !stopped && position >= fileBound) complete = readSync(fd, Buffer.allocUnsafe(1), 0, 1, position) === 0;
    // The last line has no terminating LF (or is empty after a final LF, as
    // `split` reports it). A line cut by a byte bound is still searched as
    // far as it was read.
    if (!stopped) emit();
  } catch (error) {
    if (isFailure(error)) throw error;
    noteSearchSkip(state, { path, bytes: size, scanned_bytes: consumed, reason: "read_failed" });
    state.bytes += consumed;
    return;
  } finally {
    closeSync(fd);
  }
  state.bytes += consumed;
  if (stopped && consumed < size) noteSearchSkip(state, { path, bytes: size, scanned_bytes: consumed, reason: "match_limit" });
  else if (!stopped && !complete) {
    const reason = fileBound < SEARCH_FILE_SCAN_BYTES ? "search_byte_budget" : "file_byte_limit";
    if (reason === "search_byte_budget") state.budgetExhausted = true;
    noteSearchSkip(state, { path, bytes: size, scanned_bytes: consumed, reason });
  } else if (lineCut) noteSearchSkip(state, { path, bytes: size, scanned_bytes: consumed, reason: "line_byte_limit" });
}

/**
 * ADR-105 item 1: `query` is literal-by-default; `regex: true` compiles a
 * bounded `RegExp` (length-guarded above) instead. Compilation failure
 * surfaces as a typed `search_pattern_invalid` refusal, never a raw
 * exception — the caller gets an actionable code, not a crash.
 */
function compileSearchMatcher(query: string, useRegex: boolean, caseSensitive: boolean): (line: string) => boolean {
  if (!useRegex) {
    if (caseSensitive) return (line) => line.includes(query);
    const needle = query.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  if (query.length > SEARCH_REGEX_MAX_LENGTH) throw failure("semantic", "search_pattern_invalid", `regex query exceeds ${SEARCH_REGEX_MAX_LENGTH} characters`);
  let pattern: RegExp;
  try {
    pattern = new RegExp(query, caseSensitive ? "" : "i");
  } catch {
    throw failure("semantic", "search_pattern_invalid", "regex query failed to compile");
  }
  return (line) => pattern.test(line);
}

function argvField(value: Record<string, unknown>): readonly string[] {
  const argv = value.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 32 || argv.some((item) => typeof item !== "string" || item.length === 0 || item.length > 4_096 || item.includes("\u0000"))) {
    throw failure("semantic", "argv_invalid", "argv must be a non-empty bounded string array");
  }
  return Object.freeze(argv.slice() as string[]);
}

function evidenceRefreshScope(value: Record<string, unknown>): EvidenceRefreshScope {
  const field = value.scope;
  if (field === undefined) return "auto";
  if (field === "auto" || field === "all") return field;
  if (!Array.isArray(field) || field.length === 0 || field.some((item) => typeof item !== "string")) {
    throw failure("semantic", "scope_invalid", 'scope must be "auto", "all", or a non-empty array of evidence store names');
  }
  const names = field as string[];
  const unknown = names.filter((name) => !(EVIDENCE_STORE_NAMES as readonly string[]).includes(name));
  if (unknown.length > 0) throw failure("semantic", "scope_invalid", `scope named unknown store(s): ${unknown.join(", ")}. Known stores: ${EVIDENCE_STORE_NAMES.join(", ")}`);
  return Object.freeze(names as EvidenceStoreName[]);
}

function validHighRiskScope(scope: NativeHighRiskToolScope | null, request: NativeToolRequest, roots: readonly string[]): scope is NativeHighRiskToolScope {
  if (scope === null || typeof scope.scope_id !== "string" || scope.scope_id.trim().length === 0 || typeof scope.campaign_id !== "string" || scope.campaign_id.trim().length === 0 || typeof scope.node_id !== "string" || scope.node_id.trim().length === 0 || scope.session_id !== request.session_id || !isProvenance(scope.provenance)) return false;
  let worktree: string;
  try { worktree = realpathSync(scope.worktree_root); } catch { return false; }
  if (!roots.includes(worktree)) return false;
  if (!Array.isArray(scope.write_paths) || !Array.isArray(scope.command_argv)) return false;
  if (scope.command_intents !== undefined && (!Array.isArray(scope.command_intents)
    || !scope.command_intents.every((entry) => Number.isSafeInteger(entry.bind_id) && entry.bind_id >= 0
      && Array.isArray(entry.intent.argv_prefix) && entry.intent.argv_prefix.length > 0
      && entry.intent.argv_prefix.length <= 32
      && entry.intent.argv_prefix.every((item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 4_096 && !item.includes("\u0000"))
      && typeof entry.intent.purpose === "string" && entry.intent.purpose.trim().length > 0))) return false;
  try {
    return scope.write_paths.every((path) => typeof path === "string" && normalizeScopePath(path) === path)
      && scope.command_argv.every((argv) => Array.isArray(argv) && argv.length > 0 && argv.every((item) => typeof item === "string" && item.length > 0 && item.length <= 4_096 && !item.includes("\u0000")));
  } catch { return false; }
}

function normalizeScopePath(path: string): string {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) throw new Error("scope path must be relative");
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) throw new Error("scope path must be canonical relative");
  return parts.join("/");
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/**
 * ADR-118: an unbound intent is authority the actor still holds, so a refusal
 * that named only the literal pool understated what it may do. Bounded by the
 * same limit the literal describer uses.
 */
function describeUnboundIntents(
  intents: readonly { readonly bind_id: number; readonly intent: { readonly argv_prefix: readonly string[]; readonly purpose: string } }[] | undefined,
  bound: ReadonlyMap<number, readonly string[]>,
): string {
  const open = (intents ?? []).filter((entry) => !bound.has(entry.bind_id));
  if (open.length === 0) return "";
  const shown = open.slice(0, AUTHORITY_DESCRIPTION_ITEM_LIMIT);
  const remainder = open.length - shown.length;
  const rendered = shown.map((entry) => `${entry.intent.argv_prefix.join(" ")}... (${entry.intent.purpose})`).join("; ");
  return `; unbound command intents still available (the first matching call binds one exactly): ${rendered}${remainder > 0 ? ` (+${remainder} more, not listed)` : ""}`;
}

/** ADR-119: true iff `prefix` is a positional prefix of `argv` — every token matches, in order, from index 0. */
function isArgvPrefix(prefix: readonly string[], argv: readonly string[]): boolean {
  return prefix.length <= argv.length && prefix.every((part, index) => part === argv[index]);
}

function bounded(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function boundedAtLeast(value: number | undefined, fallback: number, label: string, minimum: number): number {
  const result = bounded(value, fallback, label);
  if (result < minimum) throw new Error(`${label} must be at least ${minimum} bytes`);
  return result;
}

/**
 * Deterministic, evidence-addressed head/tail projection for oversized tool
 * results. It preserves the real execution outcome plus a digest and byte
 * accounting, avoiding both unlimited history growth and the old generic
 * marker that discarded every useful clue and encouraged blind re-runs.
 */
export function boundedToolModelOutput(value: Record<string, unknown>, maxBytes: number, tool: string): string {
  const serialized = JSON.stringify(value);
  const original = Buffer.from(serialized, "utf8");
  if (original.byteLength <= maxBytes) return serialized;
  const digest = `sha256:${createHash("sha256").update(original).digest("hex")}`;
  let previewBytes = Math.max(0, maxBytes - 384);
  for (;;) {
    const headBytes = Math.floor(previewBytes * 0.7);
    const tailBytes = previewBytes - headBytes;
    const retained = Math.min(original.byteLength, headBytes + tailBytes);
    const candidate = JSON.stringify({
      outcome: value.outcome,
      stage: value.stage,
      code: value.code,
      truncated: true,
      original_bytes: original.byteLength,
      retained_bytes: retained,
      omitted_bytes: original.byteLength - retained,
      content_sha256: digest,
      head: original.subarray(0, headBytes).toString("utf8"),
      tail: original.subarray(Math.max(0, original.byteLength - tailBytes)).toString("utf8"),
      remediation: outputProjectionRemediation(tool),
    });
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
    previewBytes = Math.max(0, previewBytes - 32);
  }
}

/**
 * What a model can actually do about a projected (head/tail) result. Only
 * `file.read` takes a window; telling any other tool's caller to "request a
 * smaller byte range" names an argument that does not exist.
 */
function outputProjectionRemediation(tool: string): string {
  if (tool === "file.read") return "Read a smaller window: lower `max_bytes` or set `max_lines`, and page with `start_line` or `offset`; do not repeat the same broad call.";
  if (tool === "repository.search") return "Narrow repository.search with a more specific `query` or a `path` to one directory or file, or lower `context_lines`; do not repeat the same broad call.";
  return `Narrow ${tool} inputs so the result is smaller; do not repeat the same broad call.`;
}

function failure(stage: NativeToolOutcomeStage, code: string, summary: string): ToolFailure {
  return {
    outcome: stage === "execution" ? (code === "cancelled" ? "cancelled" : "failed") : "refused",
    stage,
    code,
    summary,
  };
}

function asFailure(error: unknown): ToolFailure {
  if (isFailure(error)) return error;
  return { outcome: "failed", stage: "execution", code: "internal_error", summary: "tool execution failed without exposing internal details" };
}

function isFailure(value: unknown): value is ToolFailure {
  return typeof value === "object" && value !== null && "stage" in value && "code" in value && "summary" in value && "outcome" in value;
}

function isProvenance(value: NativeToolIntent["provenance"]): boolean {
  return value.tag === "verified" || value.tag === "claimed" || value.tag === "critic_approved" || value.tag === "generated";
}

function sha256(value: string | Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

function redact(value: string): string { return value.replace(SECRET_VALUE, (_whole, secret: string) => REDACTED.repeat(Math.max(1, Math.ceil(secret.length / REDACTED.length)))); }

interface ProcessResult { readonly exitCode: number; readonly output: string; readonly timedOut: boolean; readonly cancelled: boolean; readonly outputLimited: boolean; }

async function run(argv: readonly string[], cwd: string, timeoutMs: number, outputLimit: number, signal: AbortSignal, env?: Record<string, string>): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let cancelled = signal.aborted;
    let outputLimited = false;
    let output = "";
    let size = 0;
    const child = spawn(argv[0]!, argv.slice(1), { cwd, shell: false, windowsHide: true, env: withGovernedRun(env ?? { PATH: process.env.PATH ?? "" }), stdio: ["ignore", "pipe", "pipe"] });
    const finish = (result: ProcessResult): void => { if (!settled) { settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolveResult(result); } };
    const stop = (): void => { if (!child.killed) child.kill("SIGTERM"); };
    const append = (chunk: Buffer): void => { size += chunk.length; if (size > outputLimit) { outputLimited = true; stop(); return; } output += chunk.toString("utf8"); };
    const abort = (): void => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", () => finish({ exitCode: -1, output: "", timedOut, cancelled, outputLimited }));
    child.once("close", (code) => finish({ exitCode: code ?? -1, output, timedOut, cancelled, outputLimited }));
    if (cancelled) abort();
  });
}
