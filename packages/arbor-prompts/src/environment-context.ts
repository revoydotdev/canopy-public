import { spawnSync } from "node:child_process";

/**
 * ADR-103: an arbor agent is TOLD its environment rather than left to infer
 * it — the same baseline parity Claude Code and Codex already give their
 * agents (cwd, platform, date, git status injected by default). This module
 * is the seam that composes that snapshot, mirroring
 * `repo-instructions.ts`'s call-time-resolution contract rather than
 * `foregroundFragment`'s pre-derived-and-passed-in shape: `resolveRepoInstructions`
 * is resolved fresh per call, never cached across a campaign, and this
 * module inherits that discipline for git status too. ADR-078 recorded that
 * this repository's normal operating mode is several agents committing into
 * one checkout — a git snapshot cached once per campaign and reused would
 * silently go stale exactly the way ADR-078's hashing incident did, so
 * `resolveEnvironmentSnapshot` resolves fresh at every call, never memoized.
 */

/** Ahead/behind counts relative to the tracked upstream, when one exists. */
export interface ArborGitAheadBehind {
  ahead: number;
  behind: number;
}

/**
 * Git status as observed by a single, bounded `git status --porcelain=v1
 * --branch` call. `branch` is the symbolic branch name, null when HEAD is
 * detached or the repository has no commits yet named in the header.
 * `head` is the raw descriptor `git` reports for HEAD itself — for a normal
 * branch this equals `branch`; for a detached HEAD it is the literal
 * `"HEAD"` marker so a detached checkout is still distinguishable from a
 * named branch even though a single porcelain v1 call carries no commit
 * SHA. `dirty` is true when the porcelain output has any line beyond the
 * `## ` branch header.
 */
export interface ArborGitStatusSnapshot {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  ahead_behind: ArborGitAheadBehind | null;
}

/**
 * `ADR-103`'s typed, timestamped environment snapshot. `date` is the
 * calendar fact the agent reasons with (matching Claude Code/Codex's date
 * injection); `observed_at` is the distinct provenance timestamp the
 * staleness-honesty requirement (Decision §4) reads — the rendered block
 * states `observed_at` inline rather than presenting `git` as current fact.
 * `git` is `null` exactly when the git read failed or the worktree is not a
 * repository — never a thrown error, and never a silently-reused prior
 * snapshot standing in for a failed read.
 */
export interface ArborEnvironmentSnapshot {
  cwd: string;
  platform: NodeJS.Platform;
  date: string;
  git: ArborGitStatusSnapshot | null;
  observed_at: string;
}

/**
 * Injectable seam for the actual `git` invocation. Returns the raw
 * `--porcelain=v1 --branch` stdout on success, `null` on any failure
 * (missing binary, timeout, non-repo cwd, non-zero exit). Production code
 * uses `defaultGitStatusRunner`; tests inject a fake so assertions stay
 * deterministic under this repository's own condition — several agents
 * committing into the same checkout concurrently (ADR-078) — rather than
 * racing the live checkout's real git status.
 */
export type GitStatusRunner = (worktreePath: string) => string | null;

/**
 * Mirrors `target-isolation-guard.ts`'s `readCurrentBranch`/
 * `resolvePrimaryCheckout` precedent (O2): a short-timeout, non-interactive
 * `spawnSync` whose failure resolves a typed `null`, never a thrown error.
 */
const GIT_STATUS_TIMEOUT_MS = 5_000;

function defaultGitStatusRunner(worktreePath: string): string | null {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--branch"], {
    cwd: worktreePath,
    stdio: "pipe",
    encoding: "utf-8",
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/** Parses a single `[ahead N] [behind M]` bracket body, when present. */
function parseAheadBehind(bracket: string): ArborGitAheadBehind | null {
  const aheadMatch = bracket.match(/ahead (\d+)/);
  const behindMatch = bracket.match(/behind (\d+)/);
  if (!aheadMatch && !behindMatch) return null;
  return {
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

/**
 * Parses the raw stdout of `git status --porcelain=v1 --branch` into a
 * typed snapshot. Exported because it is a pure, independently testable
 * function — the actual git invocation is the only IO-shell part of this
 * module.
 */
export function parseGitStatusPorcelain(raw: string): ArborGitStatusSnapshot {
  const lines = raw.split("\n");
  const headerLine = lines[0] ?? "";
  const dirty = lines.slice(1).some((line) => line.trim().length > 0);

  if (!headerLine.startsWith("## ")) return { branch: null, head: null, dirty, ahead_behind: null };
  const header = headerLine.slice(3);

  if (header === "HEAD (no branch)") return { branch: null, head: "HEAD", dirty, ahead_behind: null };

  const unbornMatch = header.match(/^No commits yet on (.+)$/);
  if (unbornMatch) return { branch: unbornMatch[1], head: null, dirty, ahead_behind: null };

  const bracketMatch = header.match(/^(.*)\s\[(.+)\]$/);
  const body = bracketMatch ? bracketMatch[1] : header;
  const ahead_behind = bracketMatch ? parseAheadBehind(bracketMatch[2]) : null;
  const branch = body.split("...")[0] || null;
  return { branch, head: branch, dirty, ahead_behind };
}

export interface ResolveEnvironmentSnapshotOptions {
  /** Injectable git runner — see `GitStatusRunner`. Defaults to a real bounded `spawnSync`. */
  runGitStatus?: GitStatusRunner;
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * Composes an `ArborEnvironmentSnapshot` fresh, at call time — never
 * cached. Decision §2/§4: a concurrent session mutating this checkout means
 * a snapshot resolved once and reused would go stale silently; callers
 * (e.g. the campaign runner composing a `PromptContext`) call this
 * immediately before composition, every time.
 *
 * A git read failure (missing binary, timeout, non-repo cwd, non-zero
 * exit, or a thrown error from an injected runner) resolves `git: null` —
 * explicitly absent, never a thrown error and never a stand-in for a prior
 * snapshot.
 */
export function resolveEnvironmentSnapshot(
  worktreePath: string,
  options: ResolveEnvironmentSnapshotOptions = {},
): ArborEnvironmentSnapshot {
  const now = options.now ?? (() => new Date());
  const runGitStatus = options.runGitStatus ?? defaultGitStatusRunner;
  const observedAt = now().toISOString();

  let git: ArborGitStatusSnapshot | null;
  try {
    const raw = runGitStatus(worktreePath);
    git = raw === null ? null : parseGitStatusPorcelain(raw);
  } catch {
    git = null;
  }

  return { cwd: worktreePath, platform: process.platform, date: observedAt, git, observed_at: observedAt };
}

/**
 * Byte budget for the rendered environment block, mirroring
 * `REPO_INSTRUCTIONS_BYTE_BUDGET`'s context-economy discipline. The
 * snapshot's fields are small and structured (no raw file lists), so this
 * budget is a defensive ceiling rather than one truncation is expected to
 * hit routinely.
 */
export const ENVIRONMENT_CONTEXT_BYTE_BUDGET = 2_000;

function describeGitStatus(git: ArborGitStatusSnapshot | null): string {
  if (!git) return "git: (unavailable — git status failed, timed out, or this is not a repository)";
  const branch = git.branch ?? "(detached or unknown)";
  const head = git.head ?? "(none)";
  const aheadBehind = git.ahead_behind ? `ahead ${git.ahead_behind.ahead}, behind ${git.ahead_behind.behind}` : "(no upstream)";
  return `git: branch=${branch} head=${head} dirty=${git.dirty} ahead_behind=${aheadBehind}`;
}

/**
 * Renders an `ArborEnvironmentSnapshot` into the text `environmentBlock`
 * frames in `index.ts`. Decision §4: the block always states its own
 * `observed_at` inline — staleness is a declared property of the snapshot,
 * not an implicit risk — and a `git: null` snapshot renders as an explicit
 * "unavailable" line, never silently omitted.
 */
export function formatEnvironmentSnapshot(
  snapshot: ArborEnvironmentSnapshot,
  byteBudget: number = ENVIRONMENT_CONTEXT_BYTE_BUDGET,
): string {
  if (!Number.isSafeInteger(byteBudget) || byteBudget <= 0) throw new Error("byteBudget must be a positive integer");
  const lines = [
    `cwd: ${snapshot.cwd}`,
    `platform: ${snapshot.platform}`,
    `date: ${snapshot.date}`,
    describeGitStatus(snapshot.git),
    `Environment observed at ${snapshot.observed_at}; may be stale if the repository has changed since.`,
  ];
  const text = lines.join("\n");
  const textBytes = Buffer.byteLength(text, "utf-8");
  if (textBytes <= byteBudget) return text;
  const buf = Buffer.from(text, "utf-8");
  return `${buf.subarray(0, byteBudget).toString("utf-8")}\n[environment context truncated at ${byteBudget} bytes]`;
}
