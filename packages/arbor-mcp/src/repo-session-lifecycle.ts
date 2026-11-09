/**
 * The repository-session lifecycle, native.
 *
 *   arbor repo-session begin     # open a session record (the session_start hook does this)
 *   arbor repo-session status    # where this session stands
 *   arbor repo-session open      # open the commit window; print the commit plan
 *   arbor repo-session close     # rebind -> store commit -> stop tier -> full tier -> queue report -> receipt
 *   arbor repo-session abort     # close the window without finishing
 *
 * WHY THIS EXISTS. The governance chain this repository built is correct and
 * expensive in the wrong places. `evidence:rebind` costs eight to twelve minutes
 * per source commit series and holds a lease that fails every pre-commit gate
 * while it runs; the stop-tier battery ran at every turn boundary (ADR-074), so a
 * working session paid for drift it was still in the middle of causing; and the
 * pre-push battery ran again on top of both. Measured on 2026-09-03: three
 * rebinds in one session, one of them wasted by a commit that landed during it.
 *
 * The operator's instruction (2026-09-03) was direct: defer every commit to a
 * durable session-end signal, then run the rebind and the gates once, at the
 * end, as a single contiguous process; interviews for any decision the session
 * authored happen after that, before the push. This module is that signal and
 * that process.
 *
 * WHAT IT COMPOSES, AND WHAT IT DOES NOT OWN. Every step of the close is a
 * separate authority that already exists — `evidence:rebind`, the store-only
 * commit, `gate:all --tier stop`, `gate:all --tier full`, `decision-queue` — and
 * this module owns only the ORDER, the durable state, and the receipt. Those
 * authorities are still SUBPROCESSED rather than reimplemented, which is the
 * whole reason there is one implementation of each of them: a second one would
 * drift silently, and nothing would say so.
 *
 * `close` DOES NOT write commit messages: the source series is the author's, made
 * inside the window before the close runs. It does not accept decisions or write
 * the interview ledger: it reports what the decision queue owes and leaves the
 * interview to the operator. It does not push.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVIDENCE_STORE_PREFIXES,
  STRANDED_WINDOW_TTL_MS,
  TERMINAL_STATUSES,
  head,
  openDurableSessions,
  readSession,
  sessionsDir,
  treePaths,
  writeSession,
  type SessionRecord,
  type SessionStatus,
} from "./repo-session-store.js";

export type WindowStateName = "none" | "open" | "closing" | "closing-stale" | "closed-green" | "closed-red";

export interface WindowState {
  readonly state: WindowStateName;
  readonly detail: string;
  readonly session_id?: string;
}

export interface CommitGroup { readonly trailer: string; readonly paths: readonly string[] }
export interface CommitPlan {
  readonly source: readonly string[];
  readonly evidence: readonly string[];
  readonly governed?: boolean;
  readonly groups: readonly CommitGroup[];
}

interface AdrCandidate { readonly adr: number; readonly score: number }
interface AdrPathEntry { readonly path: string; readonly governed: boolean; readonly candidates: readonly AdrCandidate[] }
interface AdrResolution {
  readonly governed: boolean;
  readonly confident_score: number;
  readonly per_path: readonly AdrPathEntry[];
}

/** One subprocess step of the close. Injected by tests so the ORDER is provable
 *  without a ten-minute rebind; production runs the real authorities. */
export type CloseStep = (label: string, argv: readonly string[], env?: Readonly<Record<string, string>>) => { readonly label: string; readonly ok: boolean; readonly status: number; readonly duration_ms: number; readonly tail: string; readonly json?: string };

export interface CloseReceipt {
  readonly schema_version: 1;
  readonly kind: "revoy2.session_close_receipt";
  readonly session_id: string;
  readonly ok: boolean;
  readonly status: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly head: string | null;
  readonly label?: string | null;
  readonly steps?: readonly { readonly label: string; readonly ok: boolean; readonly status: number; readonly duration_ms: number; readonly tail: string }[];
  readonly remedy?: string;
  readonly next?: string;
  readonly source_paths?: readonly string[];
  readonly plan?: CommitPlan;
  readonly decision_queue?: Record<string, unknown>;
  readonly push_allowed?: boolean;
  readonly stranded?: { readonly window_opened_at: string | null; readonly session_ended_at: string | null };
}

const now = (): string => new Date().toISOString();

// ---------------------------------------------------------------- the states

export function beginSession(repo: string, sessionId: string, at: string = now()): SessionRecord {
  const existing = readSession(repo, sessionId);
  if (existing !== null && !TERMINAL_STATUSES.includes(existing.status)) return writeSession(repo, { ...existing, resumed_at: at });
  return writeSession(repo, {
    schema_version: 1,
    kind: "revoy2.session",
    session_id: sessionId,
    opened_at: at,
    status: "open",
    head_at_open: head(repo),
    commit_window: null,
    closed_at: null,
    receipt: null,
    ...(existing !== null ? { reopened_from: existing.closed_at } : {}),
  });
}

export function openWindow(repo: string, sessionId: string | null = null, at: string = now()): SessionRecord {
  const state = readSession(repo, sessionId);
  if (state === null) throw new Error("no session record; run `arbor repo-session begin` first (the session_start hook does this)");
  if (state.status === "closing") return state;
  return writeSession(repo, { ...state, status: "closing", commit_window: { opened_at: at, head: head(repo) }, closed_at: null, receipt: null });
}

export function abortWindow(repo: string, sessionId: string | null = null): SessionRecord {
  const state = readSession(repo, sessionId);
  if (state === null) throw new Error("no session record");
  return writeSession(repo, { ...state, status: "open", commit_window: null });
}

/** Record the end of a session and what it left unfinished.
 *
 *  THE WHOLE OF WHAT A SESSION-END PATH MAY DO. It never reaches `closeSession`,
 *  and that is not an omission: a close rebinds evidence for eight to twelve
 *  minutes, and the host hooks this replaces fire on exit under a timeout pinned
 *  to three seconds. A session end that closed would either be killed mid-rebind
 *  or would have to be given a timeout no host grants it. */
export function sessionEnd(repo: string, sessionId: string | null = null, at: string = now()): SessionRecord | null {
  const state = readSession(repo, sessionId);
  if (state === null) return null;
  const { source } = treePaths(repo);
  return writeSession(repo, { ...state, ended_at: at, unfinished: state.status !== "closed" || source.length > 0 ? { status: state.status, source_paths: source } : null });
}

// ---------------------------------------------------------------- the plan

/**
 * Which decision governs each uncommitted source path, from the resolver that
 * already answers it for the commit-msg guard and `gate:adr-trace`.
 *
 * SUBPROCESSED, and deliberately: the resolver is 275 lines over the ADR trace
 * index and the project profile, and two of its callers are gates. Reimplementing
 * it here would be a second implementation of an enforced invariant whose drift is
 * silent — the interview would be owed and nothing would say so. So the
 * confidence THRESHOLD travels with it in the `--json` payload rather than being
 * copied as a second `3` that nothing would keep in step.
 */
function resolveAdrsForPaths(repo: string, paths: readonly string[]): AdrResolution {
  const empty: AdrResolution = { governed: false, confident_score: 3, per_path: paths.map((path) => ({ path, governed: false, candidates: [] })) };
  if (paths.length === 0) return empty;
  const result = spawnSync("bun", ["scripts/adr-resolve.mjs", "--json", "--repo", repo, ...paths], { cwd: repo, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  try {
    const parsed: unknown = JSON.parse(result.stdout ?? "");
    if (parsed === null || typeof parsed !== "object") return empty;
    const resolution = parsed as Partial<AdrResolution>;
    if (typeof resolution.governed !== "boolean" || typeof resolution.confident_score !== "number" || !Array.isArray(resolution.per_path)) return empty;
    return { governed: resolution.governed, confident_score: resolution.confident_score, per_path: resolution.per_path };
  } catch { return empty; }
}

/** The plan for the source series: uncommitted source paths grouped by the
 *  decision the resolver names for each, so the author commits by concern with
 *  the trailer already known. Ungoverned paths form their own group. */
export function commitPlan(repo: string): CommitPlan {
  const { source, evidence } = treePaths(repo);
  if (source.length === 0) return { source: [], evidence, groups: [] };
  const resolution = resolveAdrsForPaths(repo, source);
  const groups = new Map<string, string[]>();
  for (const entry of resolution.per_path) {
    const top = entry.candidates[0];
    const leaders = top === undefined ? [] : entry.candidates.filter((candidate) => candidate.score === top.score);
    const key = !entry.governed ? "ungoverned"
      : top === undefined ? "governed, no candidate (allocate a record or cite by hand)"
      : top.score >= resolution.confident_score && leaders.length <= 2 ? `ADR: ${leaders.map((candidate) => String(candidate.adr).padStart(3, "0")).join(", ")}`
      : `governed, weak evidence — candidates ${entry.candidates.slice(0, 3).map((candidate) => `ADR-${String(candidate.adr).padStart(3, "0")} (${candidate.score.toFixed(1)})`).join(", ")}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry.path]);
    else group.push(entry.path);
  }
  return { source, evidence, governed: resolution.governed, groups: [...groups.entries()].map(([trailer, paths]) => ({ trailer, paths })) };
}

// ---------------------------------------------------------------- the close

function defaultRunner(repo: string): CloseStep {
  return (label, argv, env = {}) => {
    const started = Date.now();
    const result = spawnSync(argv[0] as string, argv.slice(1), { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return {
      label, ok: result.status === 0, status: result.status ?? -1, duration_ms: Date.now() - started,
      tail: output.split("\n").filter(Boolean).slice(-40).join("\n"),
      ...(label === "decision-queue" ? { json: result.stdout ?? "" } : {}),
    };
  };
}

function writeReceipt(repo: string, state: SessionRecord, receipt: CloseReceipt, nextStatus: SessionStatus): CloseReceipt {
  const dir = sessionsDir(repo);
  if (dir === null) throw new Error("no durable session store: this path is not inside a Git worktree");
  const target = join(dir, state.session_id);
  mkdirSync(target, { recursive: true });
  const path = join(target, `receipt-${receipt.finished_at.replace(/[:.]/gu, "-")}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  appendFileSync(join(dir, "receipts.jsonl"), `${JSON.stringify({ session_id: state.session_id, ok: receipt.ok, status: receipt.status, head: receipt.head, finished_at: receipt.finished_at, path })}\n`, "utf8");
  writeSession(repo, { ...state, status: nextStatus, closed_at: receipt.ok ? receipt.finished_at : null, receipt: { path, ok: receipt.ok, status: receipt.status, head: receipt.head } });
  return receipt;
}

export interface CloseOptions {
  readonly repo: string;
  readonly sessionId?: string | null;
  readonly label?: string | null;
  readonly run?: CloseStep;
  readonly log?: (line: string) => void;
}

/** The single contiguous process. Every step is a separate authority already in
 *  the repository; this only orders them and refuses to skip one. */
export function closeSession({ repo, sessionId = null, label = null, run = defaultRunner(repo), log = (line: string): void => { process.stderr.write(`${line}\n`); } }: CloseOptions): CloseReceipt {
  let state = readSession(repo, sessionId);
  if (state === null) throw new Error("no session record; run `arbor repo-session begin` first");
  if (state.status !== "closing") state = openWindow(repo, state.session_id);
  const { source } = treePaths(repo);
  if (source.length > 0) {
    return { schema_version: 1, kind: "revoy2.session_close_receipt", session_id: state.session_id, ok: false, status: "source_commit_required", started_at: now(), finished_at: now(), head: head(repo), source_paths: source, remedy: "Commit every listed source path (by concern, with its trailer) inside the window, then rerun `arbor repo-session close`.", plan: commitPlan(repo) };
  }
  const startedAt = now();
  const window = { ARBOR_COMMIT_WINDOW: "1" };
  const steps: { label: string; ok: boolean; status: number; duration_ms: number; tail: string }[] = [];
  const step = (label: string, argv: readonly string[]): { label: string; ok: boolean; status: number; duration_ms: number; tail: string; json?: string } => {
    log(`[repo-session] ${label} …`);
    const outcome = run(label, argv, window);
    const row = { label, ok: outcome.ok, status: outcome.status, duration_ms: outcome.duration_ms, tail: outcome.tail };
    steps.push(row);
    log(`[repo-session] ${label}: ${outcome.ok ? "ok" : `FAILED (${outcome.status})`} in ${(outcome.duration_ms / 1000).toFixed(1)}s`);
    return { ...row, ...(outcome.json === undefined ? {} : { json: outcome.json }) };
  };
  const fail = (status: string, remedy: string): CloseReceipt => {
    const receipt: CloseReceipt = { schema_version: 1, kind: "revoy2.session_close_receipt", session_id: state.session_id, ok: false, status, started_at: startedAt, finished_at: now(), head: head(repo), steps, remedy };
    return writeReceipt(repo, state, receipt, "closing");
  };

  // 1. Evidence rebind — refuses a dirty tree itself; ours is clean of source.
  if (!step("evidence:rebind", ["bun", "run", "evidence:rebind"]).ok) return fail("rebind_failed", "Inspect `bun run evidence:status`; recover the lease with `bun run evidence:recover` if it was left held, then rerun the close.");

  // 2. Store-only commit of exactly the evidence prefixes, nothing else.
  const after = treePaths(repo);
  if (after.source.length > 0) return fail("source_dirtied_by_rebind", `The rebind left source paths dirty: ${after.source.join(", ")}. That is a producer defect; do not commit them as evidence.`);
  if (after.evidence.length > 0) {
    const staged = EVIDENCE_STORE_PREFIXES.filter((prefix) => existsSync(join(repo, prefix)));
    if (!step("git add (evidence)", ["git", "add", "--", ...staged]).ok) return fail("evidence_stage_failed", "Re-run the close after resolving what blocked staging the evidence stores.");
    const range = `${state.commit_window?.head?.slice(0, 8) ?? "?"}..${head(repo)?.slice(0, 8) ?? "?"}`;
    if (!step("git commit (evidence)", ["git", "commit", "-q", "-m", `chore(evidence): bind stores at session close${label === null ? "" : ` — ${label}`}\n\nSession ${state.session_id}; source series ${range}.`]).ok) return fail("evidence_commit_failed", "Inspect `git status` and re-run the close; the evidence commit did not land.");
  } else {
    steps.push({ label: "git commit (evidence)", ok: true, status: 0, duration_ms: 0, tail: "no evidence path changed" });
  }

  // 3. The battery: the cheap tier first (it names drift), then the cumulative
  //    one. gate:decision-queue is advisory HERE and only here: the interview for
  //    a record this session authored comes after the close and before the push
  //    (ADR-160 §5), so a close that vetoed itself on its own Proposed record
  //    could never finish. The queue is still run, still printed, and reported in
  //    the receipt as `push_allowed`; pre-push keeps it hard-blocking.
  if (!step("gate:all --tier stop", ["bun", "scripts/gate-all.mjs", "--tier", "stop", "--advisory", "gate:decision-queue"]).ok) return fail("stop_tier_red", "Apply each red gate's remedy, commit inside the window, then rerun the close.");
  if (!step("gate:all --tier full", ["bun", "scripts/gate-all.mjs", "--tier", "full", "--advisory", "gate:decision-queue"]).ok) return fail("battery_red", "Apply each red gate's remedy, commit inside the window, then rerun the close.");

  // 4. What the operator still owes before a push: interviews. Reported, never decided.
  const queue = step("decision-queue", ["bun", "scripts/decision-queue.mjs", "--json"]);
  let owed: Record<string, unknown> = { ok: queue.ok };
  try {
    const parsed: unknown = JSON.parse(queue.json ?? "");
    const record = parsed as Record<string, unknown>;
    owed = { lapsed: record.lapsed, due_soon: record.due_soon, hazards: record.hazards, flagged_proposed: record.flagged_proposed, operator_calls: record.operator_calls, ok: record.ok };
  } catch { /* an unreadable queue report is reported as owed, not as empty */ }

  const pushAllowed = owed.ok === true;
  const receipt: CloseReceipt = {
    schema_version: 1, kind: "revoy2.session_close_receipt", session_id: state.session_id, ok: true, status: "closed",
    started_at: startedAt, finished_at: now(), head: head(repo), label, steps, decision_queue: owed,
    push_allowed: pushAllowed,
    next: pushAllowed ? "Push when ready." : "Interviews are owed before a push: ask the operator through the native question tool (`bun run interview:pack` → AskUserQuestion, or `arbor interview`), record with `bun run interview:record`, then `bun run adr:accept <n>` per accepted record.",
  };
  return writeReceipt(repo, state, receipt, "closed");
}

// ------------------------------------------------- the terminator for `closing`

/**
 * Is this `closing` window stranded — open with no live actor left to close it?
 *
 * ADR-160 made the deferral total over states but not over time: nothing
 * terminates a window except a human running the close, so a window whose actor
 * never returns keeps the session `closing` forever, and because `closing` is
 * neither `open` nor `closed-green` the stop battery runs in full and vetoes,
 * every turn, indefinitely. The two real ways that happens:
 *
 *  1. The session ENDED with the window open. `ended_at` is only evidence of that
 *     when it is at-or-after `commit_window.opened_at` — and it must be COMPARED,
 *     not merely tested for presence. `openWindow` spreads the prior record, so a
 *     window opened on an already-ended session carries an `ended_at` from a
 *     previous life that predates it; that window was opened deliberately and is
 *     not abandoned. Presence alone would retire live work.
 *  2. The window is simply old — generous by design, and only reachable when the
 *     session never ended.
 *
 * A live session — window open, no session end, inside the TTL — is never
 * stranded, which is the property that keeps this from closing a real window.
 */
export function isStranded(state: SessionRecord, at: string): boolean {
  if (state.status !== "closing") return false;
  const openedAt = Date.parse(state.commit_window?.opened_at ?? "");
  // A window with no parsable open time is unknown, not abandoned.
  if (Number.isNaN(openedAt)) return false;
  const endedAt = Date.parse(state.ended_at ?? "");
  if (!Number.isNaN(endedAt) && endedAt >= openedAt) return true;
  return Date.parse(at) - openedAt > STRANDED_WINDOW_TTL_MS;
}

export type ReconcileResult = { readonly changed: false; readonly reason: string } | { readonly changed: true; readonly receipt: CloseReceipt };

/**
 * Give a stranded window a terminal successor. Deliberately does NOT run the
 * close: ADR-160 rejected an automatic close (a ten-minute rebind is not something
 * a hook or a sweep may trigger on a machine nobody is watching), and this keeps
 * that rejection. It only records the truth — this window was never closed, and
 * here is what remains owed — so `closing` stops being a state the state machine
 * can rest in. The red receipt keeps `windowState` reporting `closed-red`, so the
 * stop battery is still owed; this terminates the deferral, it does not discharge
 * the debt.
 */
export function reconcileStrandedWindow({ repo, sessionId = null, at = now() }: { readonly repo: string; readonly sessionId?: string | null; readonly at?: string }): ReconcileResult {
  const state = readSession(repo, sessionId);
  if (state === null) return { changed: false, reason: "no session record" };
  if (!isStranded(state, at)) {
    return { changed: false, reason: state.status === "abandoned" ? `session ${state.session_id} is already retired as abandoned` : `session ${state.session_id} is ${state.status} with a live actor to close it` };
  }
  const receipt: CloseReceipt = {
    schema_version: 1, kind: "revoy2.session_close_receipt", session_id: state.session_id, ok: false, status: "window_abandoned",
    started_at: at, finished_at: at, head: head(repo), steps: [],
    stranded: { window_opened_at: state.commit_window?.opened_at ?? null, session_ended_at: state.ended_at ?? null },
    remedy: `The commit window for session ${state.session_id} was never closed. Reopen it and close when you are back: \`arbor repo-session open --session ${state.session_id}\`, commit the source by concern, then \`arbor repo-session close --session ${state.session_id}\`. Until then the evidence stores stay bound to an older revision and the pre-push battery is owed.`,
    plan: commitPlan(repo),
  };
  return { changed: true, receipt: writeReceipt(repo, state, receipt, "abandoned") };
}

// ---------------------------------------------------------------- the views

/** For the turn boundary: is the battery owed now, or deferred to the close? */
export function windowState(repo: string, at: string = now()): WindowState {
  const state = readSession(repo);
  if (state === null) return { state: "none", detail: "no session record" };
  if (state.status === "open") {
    const { source } = treePaths(repo);
    return { state: "open", detail: `${source.length} uncommitted source path(s); commits and gates are deferred to the session close`, session_id: state.session_id };
  }
  if (state.status === "closing") {
    if (isStranded(state, at)) return { state: "closing-stale", detail: `commit window open since ${state.commit_window?.opened_at ?? "unknown"} with no live actor to close it; \`arbor repo-session close --session ${state.session_id}\` finishes it or \`bun run repo-session:reconcile --session ${state.session_id}\` retires it`, session_id: state.session_id };
    return { state: "closing", detail: "commit window open", session_id: state.session_id };
  }
  const current = head(repo);
  const green = state.receipt?.ok === true && state.receipt?.head === current;
  return { state: green ? "closed-green" : "closed-red", detail: green ? `close receipt green at ${current?.slice(0, 8)}` : "closed, but HEAD moved or the receipt is red", session_id: state.session_id };
}

export interface WindowVerdict { readonly allowed: boolean; readonly reason: string }

/** For pre-commit: `allowed: false` refuses the commit. */
export function assertWindow(repo: string, env: Readonly<Record<string, string | undefined>> = process.env, at: string = now()): WindowVerdict {
  if (env.ARBOR_COMMIT_WINDOW === "1") return { allowed: true, reason: "ARBOR_COMMIT_WINDOW=1 (explicit escape; logged)" };
  const dir = sessionsDir(repo);
  if (dir !== null) {
    const scan = openDurableSessions(dir);
    if (scan.ids.length > 0) return { allowed: false, reason: `open session${scan.ids.length === 1 ? "" : "s"} ${scan.ids.join(", ")} still defer commits until the session close. Open the relevant session window with \`arbor repo-session open --session <ID>\` (then commit by concern and run \`arbor repo-session close\`), or set ARBOR_COMMIT_WINDOW=1 for a commit that cannot wait.` };
    if (!scan.complete) return { allowed: false, reason: "could not complete the durable session scan (limit 4096 entries or session store unavailable); commits remain deferred until the session store can be checked." };
  }
  const state = readSession(repo);
  if (state === null) return { allowed: true, reason: "no agent session record; commits are not deferred here" };
  // Still allowed. Only `open` defers, so a stranded window ALREADY releases the
  // commit gate; retiring it must not turn that release into a refusal, or every
  // stranded session on the machine locks the repository at once.
  if (isStranded(state, at)) return { allowed: true, reason: `commit window open (session ${state.session_id}, closing with no live actor; commits are allowed and the battery is still owed — \`bun run repo-session:reconcile --session ${state.session_id}\` retires the window)` };
  return { allowed: true, reason: `commit window open (session ${state.session_id}, ${state.status})` };
}

export interface StatusReport { readonly session: SessionRecord | null; readonly window: WindowState; readonly plan: CommitPlan }

export function statusReport(repo: string): StatusReport {
  return { session: readSession(repo), window: windowState(repo), plan: commitPlan(repo) };
}