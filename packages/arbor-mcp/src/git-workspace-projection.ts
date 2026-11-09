/**
 * Bounded, structured Git read model used by the live-view surfaces.
 *
 * This module is deliberately a small adapter around the repository's existing
 * WorktreeManager.  It never interprets porcelain as presentation text, never
 * uses a shell, and keeps the inspected checkout separate from the checkout
 * leased to a running campaign.
 */
import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { sanitizedGitEnv, WorktreeManager, type WorktreeLease } from "@arbor/opencode";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface GitCommandResult {
  readonly ok: boolean;
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
}

export interface GitPathChange {
  readonly path: string;
  readonly original_path: string | null;
  readonly index: string;
  readonly worktree: string;
  readonly kind: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "ignored" | "conflict" | "unknown";
}

export interface GitStatusProjection {
  readonly branch: string | null;
  readonly head: string | null;
  readonly detached: boolean;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly dirty: boolean;
  readonly conflicted: boolean;
  readonly changes: readonly GitPathChange[];
}

export interface GitWorktreeProjection {
  readonly id: string;
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly current: boolean;
}

export interface GitBranchProjection {
  readonly name: string;
  readonly oid: string;
  readonly current: boolean;
}

export interface GitAncestryEntry {
  readonly oid: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly authored_at: string;
  readonly subject: string;
}

export interface GitDiffProjection {
  readonly cached: boolean;
  readonly text: string;
  readonly truncated: boolean;
  readonly files: readonly { path: string; original_path: string | null; additions: number | null; deletions: number | null }[];
}

export interface GitWorkspaceProjection {
  readonly identity: string;
  readonly repository_root: string;
  readonly common_dir: string;
  readonly inspected_path: string;
  readonly status: GitStatusProjection;
  readonly worktrees: readonly GitWorktreeProjection[];
  readonly branches: readonly GitBranchProjection[];
  readonly ancestry: readonly GitAncestryEntry[];
  readonly diff: GitDiffProjection;
  readonly refreshed_at: string;
}

export class GitAdapterError extends Error {
  readonly result: GitCommandResult;
  constructor(message: string, result: GitCommandResult) { super(message); this.name = "GitAdapterError"; this.result = result; }
}

export interface GitAdapterOptions { readonly timeout_ms?: number; readonly output_bytes?: number; }

/** Structured Git adapter. All calls are direct argv calls with bounded output and time. */
export class GitAdapter {
  readonly inspected_path: string;
  readonly repository_root: string;
  readonly common_dir: string;
  private readonly timeoutMs: number;
  private readonly outputBytes: number;

  constructor(path: string, options: GitAdapterOptions = {}) {
    this.inspected_path = canonical(path);
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.outputBytes = options.output_bytes ?? DEFAULT_OUTPUT_BYTES;
    this.repository_root = canonical(this.required(["-C", this.inspected_path, "rev-parse", "--show-toplevel"]));
    this.common_dir = canonical(this.required(["-C", this.inspected_path, "rev-parse", "--path-format=absolute", "--git-common-dir"]));
  }

  run(args: readonly string[]): GitCommandResult {
    const result: SpawnSyncReturns<string> = spawnSync("git", [...args], {
      cwd: this.repository_root, encoding: "utf8", env: sanitizedGitEnv(), shell: false,
      timeout: this.timeoutMs, maxBuffer: this.outputBytes,
    });
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const timedOut = errorCode === "ETIMEDOUT";
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    return Object.freeze({ ok: result.status === 0 && !result.error, exit_code: result.status, stdout, stderr: timedOut ? `${stderr}\ngit command timed out after ${this.timeoutMs}ms`.trim() : stderr, timed_out: timedOut });
  }

  status(): GitStatusProjection {
    const result = this.requiredResult(["-C", this.inspected_path, "status", "--porcelain=v2", "--branch", "-z"]);
    return parseStatus(result.stdout);
  }

  worktrees(): readonly GitWorktreeProjection[] {
    const result = this.requiredResult(["-C", this.repository_root, "worktree", "list", "--porcelain", "-z"]);
    return parseWorktrees(result.stdout, this.inspected_path);
  }

  branches(): readonly GitBranchProjection[] {
    const result = this.requiredResult(["-C", this.inspected_path, "for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(HEAD)%00", "refs/heads"]);
    const fields = result.stdout.split("\0"); const rows: GitBranchProjection[] = [];
    for (let i = 0; i + 2 < fields.length; i += 3) if (fields[i]) rows.push(Object.freeze({ name: fields[i]!, oid: fields[i + 1]!, current: fields[i + 2] === "*" }));
    return rows;
  }

  ancestry(limit = 100): readonly GitAncestryEntry[] {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    const result = this.requiredResult(["-C", this.inspected_path, "log", `-${bounded}`, "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00", "--no-decorate"]);
    const fields = result.stdout.split("\0"); const rows: GitAncestryEntry[] = [];
    for (let i = 0; i + 4 < fields.length; i += 5) if (fields[i]) rows.push(Object.freeze({ oid: fields[i]!, parents: fields[i + 1] ? fields[i + 1]!.split(" ") : [], author: fields[i + 2]!, authored_at: fields[i + 3]!, subject: fields[i + 4]! }));
    return rows;
  }

  diff(cached = false): GitDiffProjection {
    const prefix = ["-C", this.inspected_path, "-c", "diff.external=", "diff", "--no-ext-diff", "--no-textconv", ...(cached ? ["--cached"] : [])];
    const stat = this.requiredResult([...prefix, "--numstat", "-z", "--"]);
    const files: { path: string; original_path: string | null; additions: number | null; deletions: number | null }[] = [];
    const fields = stat.stdout.split("\0");
    for (let i = 0; i < fields.length; i += 1) {
      const record = fields[i]!; if (!record) continue;
      const tab = record.split("\t"); if (tab.length < 3) continue;
      const [add, del, path] = tab;
      files.push({ path: path!, original_path: null, additions: add === "-" ? null : Number(add), deletions: del === "-" ? null : Number(del) });
    }
    const patch = this.requiredResult([...prefix, "--binary", "--",]);
    const truncated = Buffer.byteLength(patch.stdout) >= this.outputBytes;
    return Object.freeze({ cached, text: truncated ? `${patch.stdout}\n[truncated]` : patch.stdout, truncated, files: Object.freeze(files) });
  }

  snapshot(options: { readonly ancestry_limit?: number; readonly cached_diff?: boolean } = {}): GitWorkspaceProjection {
    const status = this.status();
    return Object.freeze({ identity: gitWorkspaceIdentity(this.repository_root, this.inspected_path), repository_root: this.repository_root, common_dir: this.common_dir, inspected_path: this.inspected_path, status, worktrees: this.worktrees(), branches: this.branches(), ancestry: this.ancestry(options.ancestry_limit ?? 100), diff: this.diff(options.cached_diff ?? false), refreshed_at: new Date().toISOString() });
  }

  private required(args: readonly string[]): string { return this.requiredResult(args).stdout.trim(); }
  private requiredResult(args: readonly string[]): GitCommandResult { const result = this.run(args); if (!result.ok) throw new GitAdapterError(`git ${args[0] ?? "command"} failed`, result); return result; }
}

export function gitWorkspaceIdentity(repositoryRoot: string, inspectedPath: string): string {
  return `gitws:v1:${createHash("sha256").update(`${canonical(repositoryRoot)}\0${canonical(inspectedPath)}`).digest("hex")}`;
}

/** Bounded refresh coordinator: at most one pending timer and one refresh callback. */
export class GitProjectionWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private watchers: FSWatcher[] = [];
  private lastStatusFingerprint: string | null = null;
  constructor(private readonly adapter: GitAdapter, private readonly onRefresh: (projection: GitWorkspaceProjection) => void, private readonly debounceMs = 100) {}
  watch(): void {
    if (this.closed || this.watchers.length > 0) return;
    const paths = [this.adapter.repository_root, existsSync(join(this.adapter.common_dir, "index")) ? join(this.adapter.common_dir, "index") : this.adapter.common_dir];
    for (const path of paths) try { this.watchers.push(watch(path, () => this.schedule())); } catch { /* a read-only projection remains usable */ }
    this.lastStatusFingerprint = this.statusFingerprint();
    // fs.watch on a repository root does not report edits in nested tracked
    // files (and recursive watches are not portable across supported hosts).
    // A bounded status poll closes that gap; it runs only git status, and
    // snapshots/listeners are refreshed only when the semantic status changes.
    this.poller = setInterval(() => {
      const fingerprint = this.statusFingerprint();
      if (fingerprint === null || fingerprint === this.lastStatusFingerprint) return;
      this.lastStatusFingerprint = fingerprint;
      this.schedule();
    }, 500);
    this.poller.unref?.();
    this.schedule();
  }
  notify(): void { this.schedule(); }
  flush(): void { if (this.closed) return; if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; } this.onRefresh(this.adapter.snapshot()); }
  close(): void { this.closed = true; if (this.timer !== null) clearTimeout(this.timer); if (this.poller !== null) clearInterval(this.poller); this.poller = null; for (const watcher of this.watchers) watcher.close(); this.watchers = []; }
  private statusFingerprint(): string | null { try { return JSON.stringify(this.adapter.status()); } catch { return null; } }
  private schedule(): void { if (this.closed || this.timer !== null) return; this.timer = setTimeout(() => { this.timer = null; try { this.onRefresh(this.adapter.snapshot()); } catch { /* next filesystem event retries; readers retain last good state */ } }, this.debounceMs); }
}

export interface GovernedCleanupOptions { readonly authorized?: boolean; readonly active_run?: boolean; }
export interface GovernedWorktreeResult { readonly ok: boolean; readonly lease?: WorktreeLease; readonly reason?: string; readonly diagnostic?: string; }

/** Mutation seam shared by operator menus and command transports. */
export class GovernedWorktreeOperations {
  constructor(readonly manager: WorktreeManager, readonly adapter: GitAdapter) {}
  create(input: { readonly campaign_id: string; readonly node_id: string; readonly specialist: string }): GovernedWorktreeResult {
    const lease = this.manager.acquireLease(input);
    return lease ? { ok: true, lease } : { ok: false, reason: "worktree_unavailable", diagnostic: this.manager.lastAcquireFailure ?? "worktree acquisition failed" };
  }
  inspect(): GitWorkspaceProjection { return this.adapter.snapshot(); }
  cleanup(nodeId: string, options: GovernedCleanupOptions = {}): GovernedWorktreeResult {
    const lease = this.manager.readLease(nodeId);
    if (!lease?.active) return { ok: false, reason: "not_found", diagnostic: `active worktree lease ${nodeId} was not found` };
    if (options.active_run === true && options.authorized !== true) return { ok: false, reason: "active_worktree", diagnostic: "refusing cleanup while a run is active; use the authorized cleanup workflow" };
    try {
      const status = new GitAdapter(lease.path).status();
      if (status.dirty && options.authorized !== true) return { ok: false, reason: "dirty_worktree", diagnostic: "refusing cleanup of a dirty worktree; preserve or authorize cleanup explicitly" };
    } catch (error) { return { ok: false, reason: "inspect_failed", diagnostic: error instanceof Error ? error.message : String(error) }; }
    return this.manager.releaseLease(nodeId) ? { ok: true } : { ok: false, reason: "cleanup_failed", diagnostic: this.manager.lastReleaseOutcome ? JSON.stringify(this.manager.lastReleaseOutcome) : "cleanup was not performed" };
  }
}

/** Composition seam for the runtime catalog: reads may select a checkout while
 * mutations always use the one manager-owned repository. */
export class GitWorkspaceService {
  private currentAdapter: GitAdapter;
  private watcher: GitProjectionWatcher | null = null;
  private readonly subscribers = new Set<(projection: GitWorkspaceProjection) => void>();
  private started = false;
  constructor(readonly adapter: GitAdapter, readonly operations: GovernedWorktreeOperations = new GovernedWorktreeOperations(new WorktreeManager({ repoRoot: adapter.repository_root }), adapter)) { this.currentAdapter = adapter; }
  /** Runtime lifecycle hook. Reads stay synchronous and authoritative; the
   * watcher exists only to refresh subscribers after filesystem changes. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.openWatcher();
  }
  close(): void {
    this.started = false;
    this.watcher?.close();
    this.watcher = null;
    this.subscribers.clear();
  }
  subscribe(listener: (projection: GitWorkspaceProjection) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
  /** Called only after the governed command route reports a committed Git
   * mutation. Failed/refused commands therefore cannot publish phantom state. */
  notifyMutation(): void { this.watcher?.notify(); }
  inspect(path?: string, options: { readonly ancestry_limit?: number; readonly cached_diff?: boolean } = {}): GitWorkspaceProjection {
    if (path !== undefined && canonical(path) !== this.currentAdapter.inspected_path) return new GitAdapter(path).snapshot(options);
    return this.currentAdapter.snapshot(options);
  }
  switch(path: string, activeRun = false): GovernedWorktreeResult {
    if (activeRun) return { ok: false, reason: "active_worktree", diagnostic: "refusing to retarget the inspected worktree while a run is active" };
    let requested: string;
    try { requested = canonical(path); } catch (error) { return { ok: false, reason: "not_found", diagnostic: error instanceof Error ? error.message : String(error) }; }
    const known = this.currentAdapter.worktrees().some((worktree) => worktree.path === requested);
    if (!known) return { ok: false, reason: "not_found", diagnostic: `worktree ${requested} is not registered by Git` };
    try {
      const nextAdapter = new GitAdapter(requested);
      this.watcher?.close();
      this.currentAdapter = nextAdapter;
      this.openWatcher();
      return { ok: true };
    }
    catch (error) { return { ok: false, reason: "inspect_failed", diagnostic: error instanceof Error ? error.message : String(error) }; }
  }
  private openWatcher(): void {
    if (!this.started) return;
    this.watcher = new GitProjectionWatcher(this.currentAdapter, (projection) => {
      for (const listener of this.subscribers) {
        try { listener(projection); } catch { /* one observer cannot block another */ }
      }
    });
    this.watcher.watch();
  }
}

function canonical(path: string): string { return realpathSync(resolve(path)); }
function parseStatus(raw: string): GitStatusProjection {
  const fields = raw.split("\0"); let branch: string | null = null; let head: string | null = null; let ahead: number | null = null; let behind: number | null = null; const changes: GitPathChange[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!; if (!field) continue;
    if (field.startsWith("# branch.head ")) { branch = field.slice(14) === "(detached)" ? null : field.slice(14); continue; }
    if (field.startsWith("# branch.oid ")) { head = field.slice(13) === "(initial)" ? null : field.slice(13); continue; }
    if (field.startsWith("# branch.ab ")) { const match = field.match(/^# branch\.ab \+(-?\d+) -(-?\d+)$/); if (match) { ahead = Number(match[1]); behind = Number(match[2]); } continue; }
    const code = field[0];
    if (code === "?" || code === "!") { changes.push({ path: field.slice(2), original_path: null, index: code, worktree: code, kind: code === "?" ? "untracked" : "ignored" }); continue; }
    if (code === "1" || code === "u") { const parts = field.split(" "); const xy = parts[1] ?? "??"; const path = parts.slice(code === "u" ? 10 : 8).join(" "); changes.push(change(path, null, xy[0] ?? "?", xy[1] ?? "?", code === "u" ? "conflict" : undefined)); continue; }
    if (code === "2") { const parts = field.split(" "); const xy = parts[1] ?? "??"; const path = parts.slice(9).join(" "); const original = fields[++i] ?? null; changes.push(change(path, original, xy[0] ?? "?", xy[1] ?? "?", "renamed")); }
  }
  return Object.freeze({ branch, head, detached: branch === null, ahead, behind, dirty: changes.some((item) => item.kind !== "ignored"), conflicted: changes.some((item) => item.kind === "conflict"), changes: Object.freeze(changes) });
}
function change(path: string, original: string | null, index: string, worktree: string, forced?: GitPathChange["kind"]): GitPathChange { const kind = forced ?? (index === "A" || worktree === "A" ? "added" : index === "D" || worktree === "D" ? "deleted" : index === "R" || worktree === "R" ? "renamed" : index === "M" || worktree === "M" ? "modified" : "unknown"); return { path, original_path: original, index, worktree, kind }; }
function parseWorktrees(raw: string, inspected: string): readonly GitWorktreeProjection[] { type Mutable = { path?: string; head?: string; branch?: string; detached?: boolean; locked?: boolean; prunable?: boolean }; const rows: GitWorktreeProjection[] = []; let current: Mutable = {}; const finish = (): void => { if (typeof current.path !== "string") return; const path = current.path; rows.push(Object.freeze({ id: gitWorkspaceIdentity(path, path), path, head: current.head ?? null, branch: current.branch ?? null, detached: current.detached ?? false, locked: current.locked ?? false, prunable: current.prunable ?? false, current: path === inspected })); current = {}; }; for (const field of raw.split("\0")) { if (field === "") { finish(); continue; } if (field.startsWith("worktree ")) { finish(); current.path = field.slice(9); } else if (field.startsWith("HEAD ")) current.head = field.slice(5); else if (field.startsWith("branch ")) current.branch = field.slice(7).replace(/^refs\/heads\//, ""); else if (field === "detached") current.detached = true; else if (field === "locked" || field.startsWith("locked ")) current.locked = true; else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = true; } finish(); return Object.freeze(rows); }
