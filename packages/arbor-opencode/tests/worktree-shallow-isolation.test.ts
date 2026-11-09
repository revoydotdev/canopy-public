/**
 * Regression tests for two defects verified 2026-08-14 on a fresh
 * `git clone --depth 50` of fastify:
 *
 * B1 — a shallow `repoRoot` breaks worktree isolation. `detachObjectDatabase`
 * fetches the admitted commit FROM `repoRoot`; git refuses that fetch once
 * `repoRoot` is a shallow clone ("rejected <sha> because shallow roots are
 * not allowed to be updated"), even for a commit well within the shallow
 * window. `acquireLease` must fail fast with an actionable, shallow-specific
 * message instead of returning null with the isolation gate's generic
 * "worktree not isolated; starting commit mismatch".
 *
 * U4 — when `detachObjectDatabase` fails AFTER `git worktree add` has
 * already succeeded, cleanup must not leave debris behind. `git worktree
 * remove --force` fails on a checkout whose `.git` pointer file has already
 * been replaced by `detachObjectDatabase`'s `git init` (error code 10), which
 * used to leave the registered worktree and its `arbor/<campaign>/<node>`
 * branch behind forever.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { WorktreeManager } from "@arbor/campaign-support";

function makeOrigin(): string {
  const repo = mkdtempSync(join(tmpdir(), "arbor-wt-shallow-origin-"));
  spawnSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  for (const n of [1, 2, 3]) {
    writeFileSync(join(repo, `f${n}.txt`), `${n}\n`);
    spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "commit", "-qm", `c${n}`], { stdio: "ignore" });
  }
  return repo;
}

/** Git ignores --depth for a plain local-path clone; force the real shallow-clone transport via file://. */
function makeShallowClone(origin: string): string {
  const dir = mkdtempSync(join(tmpdir(), "arbor-wt-shallow-clone-"));
  const clone = spawnSync("git", ["clone", "--depth", "1", "-q", `file://${origin}`, dir], { stdio: "ignore" });
  expect(clone.status).toBe(0);
  spawnSync("git", ["-C", dir, "config", "user.email", "t@t"], { stdio: "ignore" });
  spawnSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
  return dir;
}

function worktreeList(repo: string): string {
  return execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
}

function branchExists(repo: string, branch: string): boolean {
  return spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", branch], { stdio: "ignore" }).status === 0;
}

function cleanupDir(dir: string): void {
  spawnSync("git", ["-C", dir, "worktree", "prune"], { stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true });
}

describe("WorktreeManager against a shallow repoRoot (B1)", () => {
  it("acquireLease fails fast with an actionable shallow-clone message, and leaves no worktree or branch debris (B1 + U4)", () => {
    const origin = makeOrigin();
    const shallow = makeShallowClone(origin);
    const manager = new WorktreeManager({ repoRoot: shallow });

    let thrown: unknown = null;
    try {
      manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/repository is a shallow clone/);
    expect((thrown as Error).message).toMatch(/fetch --unshallow/);

    // No lease file was written.
    expect(manager.isHeld("n1")).toBe(false);

    // No registered worktree and no branch survive the failed acquire (U4).
    const list = worktreeList(shallow);
    expect(list).not.toContain("c1-n1");
    expect(branchExists(shallow, "arbor/c1/n1")).toBe(false);
    expect(existsSync(join(shallow, ".worktrees", "c1-n1"))).toBe(false);

    cleanupDir(shallow);
    cleanupDir(origin);
  });

  it("does not create a worktree/branch at all — the shallow check runs before `git worktree add`", () => {
    const origin = makeOrigin();
    const shallow = makeShallowClone(origin);
    const manager = new WorktreeManager({ repoRoot: shallow });

    expect(() => manager.acquireLease({ campaign_id: "c2", node_id: "n2", specialist: "seed" })).toThrow();

    // A registration would prove `git worktree add` ran; the fix rejects
    // before that point, so the only entry is the main worktree itself.
    const list = worktreeList(shallow);
    const worktreeCount = (list.match(/^worktree /gm) ?? []).length;
    expect(worktreeCount).toBe(1);

    cleanupDir(shallow);
    cleanupDir(origin);
  });
});

describe("WorktreeManager cleanup robustness after a detached-worktree failure (U4)", () => {
  it("cleanupFailedAcquire removes a checkout whose .git pointer file has already been replaced by a real .git directory", () => {
    // Reproduce the exact debris shape `detachObjectDatabase` leaves behind
    // on failure: a registered worktree whose `.git` is a real directory
    // (from `git init`) rather than the linked-worktree pointer file. `git
    // worktree remove --force` refuses this ("... is not a .git file, error
    // code 10"); the fix must clean it up anyway.
    const origin = makeOrigin();
    const manager = new WorktreeManager({ repoRoot: origin }) as unknown as {
      cleanupFailedAcquire(path: string, branch: string): void;
    };

    const path = join(origin, ".worktrees", "c3-n3");
    const branch = "arbor/c3/n3";
    const add = spawnSync("git", ["-C", origin, "worktree", "add", "-b", branch, path, "HEAD"], { stdio: "ignore" });
    expect(add.status).toBe(0);

    // Simulate detachObjectDatabase having replaced the pointer file with a
    // real repository before it failed.
    rmSync(join(path, ".git"), { recursive: true, force: true });
    const init = spawnSync("git", ["-C", path, "init", "-q"], { stdio: "ignore" });
    expect(init.status).toBe(0);

    // Confirm the fragile path really does fail here, proving the
    // reproduction is faithful to the real defect.
    const fragileRemove = spawnSync("git", ["-C", origin, "worktree", "remove", "--force", path], { stdio: "pipe", encoding: "utf-8" });
    expect(fragileRemove.status).not.toBe(0);
    expect(existsSync(path)).toBe(true);

    manager.cleanupFailedAcquire(path, branch);

    expect(existsSync(path)).toBe(false);
    const list = worktreeList(origin);
    expect(list).not.toContain(path);
    expect(branchExists(origin, branch)).toBe(false);

    cleanupDir(origin);
  });
});

describe("WorktreeManager happy path on a full clone (regression guard)", () => {
  it("acquireLease yields an isolated worktree at the admitted commit; releaseLease cleans up fully", () => {
    const origin = makeOrigin();
    const manager = new WorktreeManager({ repoRoot: origin });
    const head = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

    const lease = manager.acquireLease({ campaign_id: "c4", node_id: "n4", specialist: "seed" });
    expect(lease).not.toBeNull();
    expect(lease!.active).toBe(true);
    expect(lease!.starting_commit).toBe(head);
    expect(existsSync(lease!.path)).toBe(true);

    const leaseHead = execFileSync("git", ["-C", lease!.path, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    expect(leaseHead).toBe(head);

    // Isolated: the worktree's .git is its own independent repository, not a
    // linked pointer into origin.
    expect(existsSync(join(lease!.path, ".git", "objects"))).toBe(true);

    expect(manager.releaseLease("n4")).toBe(true);
    expect(existsSync(lease!.path)).toBe(false);
    expect(branchExists(origin, lease!.branch)).toBe(false);
    const list = worktreeList(origin);
    expect(list).not.toContain("c4-n4");

    cleanupDir(origin);
  });
});
