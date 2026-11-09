/**
 * The durable half of the repository-session lifecycle: where a session record
 * lives, what states it may hold, and how the working tree splits into source and
 * evidence.
 *
 * WHY THE STORE IS HERE AND NOT UNDER THE WORKING TREE. State lives under the git
 * COMMON dir — `<common>/arbor/sessions/<sid>/state.json`, with `LATEST` naming the
 * current session — so a linked worktree sees the same record the main checkout
 * wrote, and a `git status` of this repository never shows the deferral machinery
 * that is deferring its own commits.
 *
 * A session is `open` (commits refused, gates advisory), `closing` (the commit
 * window is open), `closed` (a receipt exists), or `abandoned` (a window that was
 * never closed, retired by `reconcileStrandedWindow`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SESSION_STATUSES = ["open", "closing", "closed", "abandoned"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
/** Terminal: a later begin starts a fresh record rather than resuming. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = ["closed", "abandoned"];

/** How long a `closing` window may wait for an actor before it is presumed
 *  stranded. The close itself costs 8-12 minutes, so 24h is roughly 20x that: long
 *  past any plausible in-progress session, and strictly one-directional — it can
 *  only ever fire on a window that is already stuck, never one that is merely slow. */
export const STRANDED_WINDOW_TTL_MS = 24 * 3_600_000;

const MAX_SESSION_SCAN_ENTRIES = 4096;

/**
 * The whole-directory prefixes a session close may stage as evidence.
 *
 * NOT `scripts/lib/store-provenance.mjs`'s `GENERATED_EVIDENCE_PREFIXES`, which
 * answers a different question — "which store rebuilds must not invalidate which
 * other store" — and therefore splits `.visual-intelligence/` into observed/graph/
 * findings with a recorded reason. This list answers "what may be committed as the
 * close's evidence", which is a whole directory or nothing. The two are
 * deliberately not merged and deliberately not derived from one another.
 *
 * It IS a second hand-typed copy of the list `scripts/evidence-transaction.mjs`
 * exports as `EVIDENCE_PATH_PREFIXES`, because a package cannot import a script
 * and a subprocess per `git status` would be absurd. `repo-session-lifecycle.test.ts`
 * pins the two arrays equal by reading that file's source, so a divergence here is
 * a red test rather than a silent drift — which is the difference between the two.
 */
export const EVIDENCE_STORE_PREFIXES: readonly string[] = Object.freeze([
  ".visual-intelligence/",
  ".claim-ledger/",
  ".completion-depth/",
  ".determinism-baseline/",
]);

export interface CommitWindow { readonly opened_at: string; readonly head: string | null }
export interface SessionUnfinished { readonly status: SessionStatus; readonly source_paths: readonly string[] }
export interface SessionReceiptRef { readonly path: string; readonly ok: boolean; readonly status: string; readonly head: string | null }
export interface SessionRecord {
  readonly schema_version: 1;
  readonly kind: "revoy2.session";
  readonly session_id: string;
  readonly status: SessionStatus;
  readonly opened_at: string;
  readonly resumed_at?: string;
  readonly head_at_open: string | null;
  readonly commit_window: CommitWindow | null;
  readonly closed_at: string | null;
  readonly receipt: SessionReceiptRef | null;
  readonly ended_at?: string | null;
  readonly unfinished?: SessionUnfinished | null;
  readonly reopened_from?: string | null;
}
export interface TreePaths { readonly source: readonly string[]; readonly evidence: readonly string[] }

function git(repo: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** HEAD, or null where HEAD does not exist yet. Never throws: every caller has a
 *  defined answer for an unborn branch, and it is "no commit yet". */
export function head(repo: string): string | null {
  return git(repo, ["rev-parse", "HEAD"]).stdout.trim() || null;
}

export function sessionsDir(repo: string): string | null {
  const common = git(repo, ["rev-parse", "--git-common-dir"]);
  if (common.status !== 0) return null;
  return join(resolve(repo, common.stdout.trim()), "arbor", "sessions");
}

function latestSessionId(dir: string): string | null {
  const path = join(dir, "LATEST");
  return existsSync(path) ? readFileSync(path, "utf8").trim() || null : null;
}

export interface OpenSessionScan { readonly ids: readonly string[]; readonly complete: boolean }

/**
 * Every valid durable `open` session, without following links out of the store.
 *
 * The status whitelist is load-bearing twice over: a status this module does not
 * know marks the whole scan INCOMPLETE, and an incomplete scan REFUSES commits. A
 * new status that is not listed in `SESSION_STATUSES` therefore does not merely go
 * unrecognised — it locks the repository.
 */
export function openDurableSessions(dir: string): OpenSessionScan {
  let canonicalDir: string;
  try {
    if (!lstatSync(dir).isDirectory()) return { ids: [], complete: false };
    canonicalDir = realpathSync(dir);
  } catch (error) {
    // A missing store is the ordinary "no session has begun" case. A broken
    // symlink, unreadable path, or any other failure means the scan is unknown.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ids: [], complete: true };
    return { ids: [], complete: false };
  }

  const ids: string[] = [];
  let complete = true;
  let scanned = 0;
  let directory;
  try { directory = opendirSync(canonicalDir); } catch { return { ids, complete: false }; }
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) return { ids: ids.sort(), complete };
      scanned += 1;
      if (scanned > MAX_SESSION_SCAN_ENTRIES) return { ids: ids.sort(), complete: false };
      // Store metadata, not session IDs. Names outside the canonical ID grammar
      // are not candidates.
      if (entry.name === "LATEST" || entry.name === "receipts.jsonl" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.name)) continue;
      // Three verdicts, not two: a VALID record that is not `open` defers nothing
      // and marks nothing incomplete, which is the whole difference between a
      // closed session and a record this scan cannot vouch for.
      const verdict = sessionVerdict(join(canonicalDir, entry.name), entry);
      if (verdict === "invalid") complete = false;
      else if (verdict === "open") ids.push(entry.name);
    }
  } catch {
    return { ids: ids.sort(), complete: false };
  } finally {
    try { directory.closeSync(); } catch { /* already closed */ }
  }
}

function sessionVerdict(sessionPath: string, entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): "open" | "other" | "invalid" {
  try {
    // A canonical ID names a candidate regardless of its dirent type. This catches
    // symlinked session directories and files masquerading as directories instead
    // of silently dropping them from the scan.
    if (!entry.isDirectory() || entry.isSymbolicLink() || !lstatSync(sessionPath).isDirectory() || realpathSync(sessionPath) !== sessionPath) return "invalid";
    const statePath = join(sessionPath, "state.json");
    if (!lstatSync(statePath).isFile()) return "invalid";
    const state: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    if (state === null || typeof state !== "object") return "invalid";
    const record = state as Record<string, unknown>;
    if (record.schema_version !== 1 || record.kind !== "revoy2.session" || record.session_id !== entry.name) return "invalid";
    if (typeof record.status !== "string" || !(SESSION_STATUSES as readonly string[]).includes(record.status)) return "invalid";
    return record.status === "open" ? "open" : "other";
  } catch {
    // A candidate that cannot be fully validated makes the aggregate scan
    // incomplete; assertWindow then refuses to open the commit gate.
    return "invalid";
  }
}

export function readSession(repo: string, sessionId: string | null = null): SessionRecord | null {
  const dir = sessionsDir(repo);
  if (dir === null) return null;
  const id = sessionId ?? latestSessionId(dir);
  if (id === null) return null;
  const path = join(dir, id, "state.json");
  if (!existsSync(path)) return null;
  try {
    const state: unknown = JSON.parse(readFileSync(path, "utf8"));
    return state === null || typeof state !== "object" ? null : (state as SessionRecord);
  } catch { return null; }
}

export function writeSession(repo: string, state: SessionRecord): SessionRecord {
  const dir = sessionsDir(repo);
  if (dir === null) throw new Error("no durable session store: this path is not inside a Git worktree");
  const target = join(dir, state.session_id);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "LATEST"), `${state.session_id}\n`, "utf8");
  return state;
}

/** Working-tree paths split into source and evidence, as the close splits them. */
export function treePaths(repo: string): TreePaths {
  const records = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record === "") continue;
    const code = record.slice(0, 2);
    paths.push(record.slice(3));
    // A rename or copy is `R  <new>\0<old>\0`, so BOTH paths are pending work.
    if (code.includes("R") || code.includes("C")) paths.push(records[++index] ?? "");
  }
  const isEvidence = (path: string): boolean => EVIDENCE_STORE_PREFIXES.some((prefix) => path.replaceAll("\\", "/").startsWith(prefix));
  return { source: [...new Set(paths.filter((path) => !isEvidence(path)))].sort(), evidence: [...new Set(paths.filter(isEvidence))].sort() };
}