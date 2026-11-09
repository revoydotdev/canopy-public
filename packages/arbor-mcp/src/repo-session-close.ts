/**
 * Canopy's native repository-session lifecycle entry points.
 *
 * This targets a REPOSITORY session, not a model/campaign session. Campaign
 * `session_end` remains an observation (`hooks/contracts.ts`: observe-only, never
 * veto-capable); the repository close is a different lifecycle and is the operator's
 * to run.
 *
 * THREE ENTRY POINTS, TWO SURFACES. `repo-session <begin|status|open|close|abort>`
 * is the operator surface and is the whole of it. `repo-session-assert-window` and
 * `repo-session-reconcile` are internal: one is called by the pre-commit hook, which
 * needs an exit code rather than a report, and the other is the remedy this
 * lifecycle's own messages print, so a stranded window has a real command to retire
 * it. Neither is a verb, which is why the operator surface stays five.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { Writable } from "node:stream";
import { isGovernedRun } from "@arbor/core";
import { EXIT_CODES } from "./exit-codes.js";
import { abortWindow, assertWindow, beginSession, closeSession, openWindow, reconcileStrandedWindow, statusReport, type CloseReceipt, type ReconcileResult, type StatusReport } from "./repo-session-lifecycle.js";

export interface RepoSessionEnvironment {
  readonly cwd: string;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const ACTIONS = ["begin", "status", "open", "close", "abort"] as const;
type Action = (typeof ACTIONS)[number];

const USAGE = "Usage: arbor repo-session <begin|status|open|close|abort> [options]\n";

function usageOptions(action: string): string {
  switch (action) {
    case "begin": return " [--session <id>] [--json]";
    case "status": return " [--json]";
    case "open": return " [--session <id>]";
    case "close": return " [--session <id>] [--label <text>] [--json]";
    case "abort": return " [--session <id>]";
    default: return "";
  }
}

/** The Git worktree the session record belongs to, or null when there is none. */
function gitRoot(cwd: string): string | null {
  const result = spawnSync("git", ["-C", resolve(cwd), "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout.trim() === "" ? null : result.stdout.trim();
}

interface Options { readonly session: string | null; readonly label: string | null; readonly json: boolean }
type Parsed = Readonly<{ ok: true; options: Options }> | Readonly<{ ok: false; message: string }>;

/** Flags an action accepts, and which of them take a value. Anything else is a
 *  usage error: an unknown flag that is silently ignored would make a typo look
 *  like the command it was not. */
function parseFlags(action: Action, flags: readonly string[]): Parsed {
  const json = action === "begin" || action === "status" || action === "close";
  const session = action !== "status";
  const label = action === "close";
  let sessionId: string | null = null;
  let labelText: string | null = null;
  let wantsJson = false;
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index] ?? "";
    if (seen.has(flag)) return { ok: false, message: `${flag} may be supplied only once\n` };
    seen.add(flag);
    if (flag === "--json" && json) { wantsJson = true; continue; }
    if (flag !== "--session" && flag !== "--label") return { ok: false, message: `Unknown repo-session ${action} argument: ${flag}\n` };
    if ((flag === "--session" && !session) || (flag === "--label" && !label)) return { ok: false, message: `Unknown repo-session ${action} argument: ${flag}\n` };
    const value = flags[++index];
    if (value === undefined || value.startsWith("--")) return { ok: false, message: `${flag} requires a value\n` };
    if (flag === "--session") sessionId = value;
    else labelText = value;
  }
  return { ok: true, options: { session: sessionId, label: labelText, json: wantsJson } };
}

function formatStatus(report: StatusReport): string {
  const session = report.session;
  const lines: string[] = [session === null
    ? "session: none (run begin; the session_start hook does this)"
    : `session: ${session.session_id} · ${session.status} · opened ${session.opened_at}${session.receipt === null ? "" : ` · last receipt ${session.receipt.ok ? "green" : `red (${session.receipt.status})`} at ${session.receipt.head?.slice(0, 8)}`}`];
  lines.push(`window: ${report.window.state} — ${report.window.detail}`);
  if (report.plan.source.length === 0) lines.push("source tree: clean");
  else {
    lines.push(`uncommitted source paths: ${report.plan.source.length}`);
    for (const group of report.plan.groups) {
      lines.push(`  ${group.trailer}`);
      for (const path of group.paths) lines.push(`    ${path}`);
    }
  }
  if (report.plan.evidence.length > 0) lines.push(`uncommitted evidence paths: ${report.plan.evidence.length} (the close commits these)`);
  return lines.join("\n");
}

function formatReceipt(receipt: CloseReceipt): string {
  const lines = [`session close: ${receipt.ok ? "GREEN" : `RED (${receipt.status})`} · ${receipt.session_id} · HEAD ${receipt.head?.slice(0, 8)}`];
  for (const step of receipt.steps ?? []) lines.push(`  ${step.ok ? "ok " : "RED"} ${step.label} (${(step.duration_ms / 1000).toFixed(1)}s)${step.ok ? "" : `\n${step.tail.split("\n").map((line) => `      ${line}`).join("\n")}`}`);
  if (receipt.source_paths !== undefined) {
    lines.push("  uncommitted source paths:");
    for (const path of receipt.source_paths) lines.push(`    ${path}`);
  }
  if (receipt.decision_queue !== undefined) lines.push(`  decision queue: ${JSON.stringify(receipt.decision_queue)}`);
  if (receipt.remedy !== undefined) lines.push(`Next: ${receipt.remedy}`);
  if (receipt.next !== undefined) lines.push(`Next: ${receipt.next}`);
  return lines.join("\n");
}

function isAction(value: string): value is Action { return (ACTIONS as readonly string[]).includes(value); }

export function repoSessionLifecycleCommand(args: readonly string[], environment: RepoSessionEnvironment): number {
  const [action = "status", ...flags] = args;
  if (!isAction(action)) {
    environment.stderr.write(`Unknown repo-session action: ${action}\n${USAGE}`);
    return EXIT_CODES.USAGE;
  }
  const root = gitRoot(environment.cwd);
  if (root === null) {
    environment.stderr.write("repo-session requires the current directory to be inside a Git worktree\n");
    return EXIT_CODES.USAGE;
  }
  const parsed = parseFlags(action, flags);
  if (!parsed.ok) {
    environment.stderr.write(`${parsed.message}${USAGE}  arbor repo-session ${action}${usageOptions(action)}\n`);
    return EXIT_CODES.USAGE;
  }
  const { session, label, json } = parsed.options;

  try {
    if (action === "begin") {
      const previous = statusReport(root).session;
      const state = beginSession(root, session ?? `manual-${Date.now().toString(36)}`);
      const notes: string[] = [];
      if (previous !== null && previous.receipt !== null && previous.session_id !== state.session_id) notes.push(`last close: ${previous.receipt.ok ? "green" : `red (${previous.receipt.status})`} at ${previous.receipt.head?.slice(0, 8)} (session ${previous.session_id})`);
      if (previous?.unfinished != null) notes.push(`previous session ${previous.session_id} ended ${previous.status} with ${previous.unfinished.source_paths.length} uncommitted source path(s).`);
      environment.stdout.write(`${json ? JSON.stringify(state) : [...notes, `session ${state.session_id}: ${state.status}`].join("\n")}\n`);
      return EXIT_CODES.SUCCESS;
    }
    if (action === "open") {
      const state = openWindow(root, session);
      const report = statusReport(root);
      environment.stdout.write(`${json ? JSON.stringify(report, null, 2) : `commit window open (session ${state.session_id}).\n${formatStatus(report)}`}\n`);
      return EXIT_CODES.SUCCESS;
    }
    if (action === "abort") {
      abortWindow(root, session);
      environment.stdout.write("commit window closed; session open.\n");
      return EXIT_CODES.SUCCESS;
    }
    if (action === "close") {
      const receipt = closeSession({ repo: root, sessionId: session, label });
      environment.stdout.write(`${json ? JSON.stringify(receipt, null, 2) : formatReceipt(receipt)}\n`);
      return receipt.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
    }
    const report = statusReport(root);
    environment.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatStatus(report)}\n`);
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    environment.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.FAILURE;
  }
}

/** Internal. The pre-commit hook's whole question, answered as an exit code. */
export function repoSessionAssertWindowCommand(environment: RepoSessionEnvironment): number {
  const env = { ...process.env, ...(environment.env ?? {}) };
  // ADR-177: the commit window governs Canopy harness runs only. The shell hook
  // checks the same marker before calling here; this entry applies it itself
  // so no other caller can make it refuse a host-agent or human commit.
  if (!isGovernedRun(env)) return EXIT_CODES.SUCCESS;
  const root = gitRoot(environment.cwd);
  if (root === null) return EXIT_CODES.SUCCESS;
  const verdict = assertWindow(root, env);
  if (!verdict.allowed) {
    environment.stderr.write(`pre-commit refused: ${verdict.reason}\n`);
    return EXIT_CODES.FAILURE;
  }
  if (verdict.reason.startsWith("ARBOR_COMMIT_WINDOW")) environment.stderr.write(`pre-commit: commit allowed via ${verdict.reason}\n`);
  return EXIT_CODES.SUCCESS;
}

/** Internal. The remedy `windowState` and `assertWindow` print for a stranded
 *  window: retire it, without running the close it never received. */
export function repoSessionReconcileCommand(args: readonly string[], environment: RepoSessionEnvironment): number {
  const root = gitRoot(environment.cwd);
  if (root === null) {
    environment.stderr.write("repo-session requires the current directory to be inside a Git worktree\n");
    return EXIT_CODES.USAGE;
  }
  const json = args.includes("--json");
  const index = args.indexOf("--session");
  const result: ReconcileResult = reconcileStrandedWindow({ repo: root, sessionId: index === -1 ? null : args[index + 1] ?? null });
  const text = result.changed
    ? `session ${result.receipt.session_id} window abandoned (no live actor); status abandoned.\n${formatReceipt(result.receipt)}`
    : `nothing to reconcile: ${result.reason}`;
  environment.stdout.write(`${json ? JSON.stringify(result, null, 2) : text}\n`);
  // Exit 0 either way: this reports whether the state machine was completed, not
  // whether the close it never ran would have passed.
  return EXIT_CODES.SUCCESS;
}