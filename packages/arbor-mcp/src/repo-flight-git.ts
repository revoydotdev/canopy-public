import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { RepoFlightCandidateBinding } from "./repo-flight-authority.js";
import type { RepoFlightGateCommand, RepoFlightGateExecutionMode, RepoFlightGateRunnerResult, RepoFlightSnapshotHandle } from "./repo-flight-gates.js";

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export interface RepoFlightGitCandidate extends RepoFlightCandidateBinding {
  readonly repository_root: string;
  readonly git_common_dir: string;
}

export interface RepoFlightQuiescentConfinementProbe {
  readonly available: boolean;
  readonly reason: string;
}

export interface RepoFlightProvisionedWorkspaceClaim {
  readonly campaign_id: string | null;
  readonly node_id: string | null;
  readonly base_oid: string;
}

/**
 * Recognize a Revoy-owned detached-object worktree without equating an
 * arbitrary clone that happens to contain the same commit with this repo.
 * WorktreeManager deliberately replaces the linked worktree's .git pointer,
 * so its git-common-dir no longer matches the parent. Admission therefore
 * requires all three independent bindings that operation leaves behind:
 * exact managed-path containment, an active durable campaign lease, and the
 * parent repository's live `git worktree list` registration.
 */
export function isRepoFlightProvisionedWorkspace(
  repositoryRoot: string,
  workspaceRoot: string,
  claim: RepoFlightProvisionedWorkspaceClaim,
): boolean {
  if (claim.campaign_id === null || claim.node_id === null) return false;
  let repository: string, workspace: string;
  try { repository = realpathSync(repositoryRoot); workspace = realpathSync(workspaceRoot); }
  catch { return false; }
  const managedRoot = resolve(repository, ".worktrees");
  if (!inside(managedRoot, workspace) || workspace === managedRoot) return false;

  const leases = resolve(repository, ".arbor", "leases");
  if (!existsSync(leases)) return false;
  let matched = false;
  try {
    for (const file of readdirSync(leases)) {
      if (!file.endsWith(".json")) continue;
      const path = resolve(leases, file);
      if (!inside(leases, path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue;
      const stat = lstatSync(path);
      if (stat.size > 64 * 1024) continue;
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (value.active !== true || value.campaign_id !== claim.campaign_id || value.node_id !== claim.node_id || value.starting_commit !== claim.base_oid || typeof value.path !== "string") continue;
      let leasedPath: string;
      try { leasedPath = realpathSync(value.path); } catch { continue; }
      if (leasedPath === workspace) { matched = true; break; }
    }
  } catch { return false; }
  if (!matched) return false;

  try {
    const listed = git(repository, ["worktree", "list", "--porcelain", "-z"]);
    return listed.split("\0").some((field) => field === `worktree ${workspace}`);
  } catch { return false; }
}

/**
 * Prove that the host can actually create the read-only, network-isolated
 * bubble used by quiescent gates. Merely finding a `bwrap` binary is not
 * enough: distributions commonly disable the user namespaces it needs.
 */
export function probeRepoFlightQuiescentConfinement(): RepoFlightQuiescentConfinementProbe {
  if (process.platform !== "linux") return Object.freeze({ available: false, reason: "bubblewrap confinement is supported only on Linux" });
  const probe = spawnSync("bwrap", [
    "--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--proc", "/proc",
    "--dev-bind", "/dev", "/dev", "--tmpfs", "/tmp", "--unshare-net", "--", "true",
  ], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, shell: false });
  if (probe.error) return Object.freeze({ available: false, reason: `bubblewrap probe failed: ${probe.error.message.slice(0, 512)}` });
  if (probe.status !== 0) return Object.freeze({ available: false, reason: `bubblewrap probe exited ${probe.status}: ${(probe.stderr || "no diagnostic").trim().slice(0, 512)}` });
  return Object.freeze({ available: true, reason: "bubblewrap read-only and network-isolation probe passed" });
}

/** Resolve and hash the exact committed, staged, modified, and untracked candidate without mutating Git. */
export function probeRepoFlightGitCandidate(repositoryRoot: string, baseOid?: string): RepoFlightGitCandidate {
  const repository = realpathSync(repositoryRoot);
  const top = realpathSync(git(repository, ["rev-parse", "--show-toplevel"]).trim());
  if (top !== repository) throw new Error(`repository root must be the canonical Git top-level (${top})`);
  const head = git(repository, ["rev-parse", "HEAD"]).trim();
  const base = baseOid ?? head;
  if (!gitOid(base) || !gitOid(head)) throw new Error("Git candidate has a malformed base or HEAD object id");
  git(repository, ["cat-file", "-e", `${base}^{commit}`]);
  const commonRaw = git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  const common = realpathSync(commonRaw);
  const status = gitBuffer(repository, ["status", "--porcelain=v2", "--untracked-files=all", "-z"]);
  // A generated evidence refresh can legitimately exceed spawnSync's output
  // buffer by hundreds of megabytes. Hash the patch through a temporary file
  // so candidate admission remains constant-memory instead of failing ENOBUFS.
  const worktreeDiff = gitOutputDigest(repository, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const stagedDiff = gitOutputDigest(repository, ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const index = gitBuffer(repository, ["ls-files", "--stage", "-z"]);
  const untracked = gitBuffer(repository, ["ls-files", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean).sort();
  const treeHash = createHash("sha256").update(status).update(worktreeDiff).update(stagedDiff);
  for (const relative of untracked) {
    const absolute = resolve(repository, relative);
    if (!inside(repository, absolute)) throw new Error("Git reported an untracked path outside the repository");
    const stat = lstatSync(absolute);
    treeHash.update(relative).update("\0").update(stat.isSymbolicLink() ? `symlink:${readlinkSync(absolute)}` : stat.isFile() ? readFileSync(absolute) : `mode:${stat.mode}`);
  }
  const indexHash = createHash("sha256").update(index).update(stagedDiff).digest("hex");
  return Object.freeze({ base_oid: base, head_oid: head, tree_digest: `sha256:${treeHash.digest("hex")}`, index_digest: `sha256:${indexHash}`, repository_root: repository, git_common_dir: common });
}

/** Copy the already-bound workspace to a private temporary root for snapshot gates. */
export function createRepoFlightWorkspaceSnapshot(repositoryRoot: string, expected: RepoFlightCandidateBinding): RepoFlightSnapshotHandle {
  const before = probeRepoFlightGitCandidate(repositoryRoot, expected.base_oid);
  if (!sameCandidate(before, expected)) throw new Error("repository candidate changed before snapshot construction");
  const parent = mkdtempSync(join(tmpdir(), "revoy2-flight-snapshot-"));
  const snapshot = join(parent, basename(before.repository_root));
  try {
    const cloned = spawnSync("git", ["clone", "--shared", "--no-hardlinks", "--no-checkout", before.repository_root, snapshot], { encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT, shell: false });
    if (cloned.error) throw cloned.error;
    if (cloned.status !== 0) throw new Error(`snapshot Git clone failed (${cloned.status}): ${cloned.stderr.slice(0, 2048)}`);
    git(snapshot, ["checkout", "--detach", expected.head_oid]);
    for (const entry of readdirSync(snapshot)) if (entry !== ".git") rmSync(join(snapshot, entry), { recursive: true, force: true });
    for (const entry of readdirSync(before.repository_root)) if (entry !== ".git") cpSync(join(before.repository_root, entry), join(snapshot, entry), { recursive: true, dereference: false, preserveTimestamps: true, errorOnExist: true });
    const after = probeRepoFlightGitCandidate(repositoryRoot, expected.base_oid);
    if (!sameCandidate(after, expected)) throw new Error("repository candidate changed during snapshot construction");
  } catch (error) { rmSync(parent, { recursive: true, force: true }); throw error; }
  let cleaned = false;
  return Object.freeze({ root: snapshot, cleanup: () => { if (cleaned) return; cleaned = true; if (!parent.startsWith(`${tmpdir()}${sep}revoy2-flight-snapshot-`)) throw new Error("refusing to clean an unrecognized snapshot root"); rmSync(parent, { recursive: true, force: true }); } });
}

/** Execute argv directly under a process-group timeout; no shell expansion is possible. */
export function runRepoFlightGateCommand(root: string, command: RepoFlightGateCommand, mode: RepoFlightGateExecutionMode = "snapshot"): RepoFlightGateRunnerResult {
  const started = performance.now();
  const timeout = `${(command.timeout_ms / 1_000).toFixed(3)}s`;
  const executable = mode === "quiescent" ? "bwrap" : "timeout";
  const argv = mode === "quiescent"
    ? ["--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--proc", "/proc", "--dev-bind", "/dev", "/dev", "--tmpfs", "/tmp", "--unshare-net", "--chdir", root, "--", "timeout", "--signal=TERM", "--kill-after=5s", timeout, ...command.argv]
    : ["--signal=TERM", "--kill-after=5s", timeout, ...command.argv];
  const result = spawnSync(executable, argv, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false, windowsHide: true });
  const duration = Math.max(0, Math.round(performance.now() - started));
  const timedOut = result.status === 124 || result.status === 137;
  if (result.error && !timedOut) throw result.error;
  return Object.freeze({ exit_code: result.status, signal: result.signal, duration_ms: duration, stdout: boundedOutput(result.stdout), stderr: boundedOutput(result.stderr), timed_out: timedOut });
}

function git(root: string, argv: readonly string[]): string { return gitBuffer(root, argv).toString("utf8"); }
function gitBuffer(root: string, argv: readonly string[]): Buffer { const result = spawnSync("git", argv, { cwd: root, encoding: "buffer", maxBuffer: MAX_GIT_OUTPUT, shell: false }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`git ${argv[0] ?? "command"} failed (${result.status}): ${Buffer.from(result.stderr ?? "").toString("utf8").slice(0, 2048)}`); return Buffer.from(result.stdout ?? ""); }
function gitOutputDigest(root: string, argv: readonly string[]): string {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "revoy2-flight-git-output-"));
  const output = join(temporaryRoot, "output");
  try {
    git(root, [argv[0] ?? "", `--output=${output}`, ...argv.slice(1)]);
    return git(root, ["hash-object", "--no-filters", output]).trim();
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
function boundedOutput(value: string | Buffer | null | undefined): string { const text = typeof value === "string" ? value : value ? value.toString("utf8") : ""; return Buffer.byteLength(text) <= 8 * 1024 * 1024 ? text : `${text.slice(0, 8 * 1024 * 1024)}\n[truncated]`; }
function inside(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}${sep}`); }
function gitOid(value: string): boolean { return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
function sameCandidate(left: RepoFlightCandidateBinding, right: RepoFlightCandidateBinding): boolean { return left.base_oid === right.base_oid && left.head_oid === right.head_oid && left.tree_digest === right.tree_digest && (left.index_digest ?? null) === (right.index_digest ?? null); }
