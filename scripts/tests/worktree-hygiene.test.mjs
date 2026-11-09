import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "worktree-hygiene.mjs");

let repo;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runGate({ prune = false } = {}) {
  const result = spawnSync("node", [GATE, "--repo", repo, "--json", ...(prune ? ["--prune"] : [])], { encoding: "utf-8" });
  return { code: result.status, report: JSON.parse(result.stdout) };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "worktree-hygiene-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "f.txt"), "base\n");
  git("add", "f.txt");
  git("commit", "-q", "-m", "base");
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe("worktree-hygiene gate", () => {
  it("reports nothing to prune and no stale locks in a clean repo", () => {
    const { code, report } = runGate();
    expect(code).toBe(0);
    expect(report.pruned_count).toBe(0);
    expect(report.stale_locks).toEqual([]);
  });

  it("reports a prunable registration without mutating shared Git administration", () => {
    const wtPath = join(repo, ".worktrees", "gone");
    mkdirSync(dirname(wtPath), { recursive: true });
    git("worktree", "add", "-b", "arbor/c1/n1", wtPath, "HEAD");
    rmSync(wtPath, { recursive: true, force: true }); // simulate the recovery-roundtrip incident: dir deleted, registration left behind

    const before = git("worktree", "list", "--porcelain");
    expect(before).toContain("prunable");

    const { code, report } = runGate();
    expect(code).toBe(0);
    expect(report).toMatchObject({ mode: "check", prunable_count: 1, pruned_count: 0 });
    expect(report.prunable[0]).toContain("gone");

    const after = git("worktree", "list", "--porcelain");
    expect(after).toContain("prunable");
  });

  it("prunes only through the explicit maintenance mode", () => {
    const wtPath = join(repo, ".worktrees", "gone-maintenance");
    mkdirSync(dirname(wtPath), { recursive: true });
    git("worktree", "add", "-b", "arbor/c1/prune", wtPath, "HEAD");
    rmSync(wtPath, { recursive: true, force: true });
    const { report } = runGate({ prune: true });
    expect(report).toMatchObject({ mode: "maintenance", prunable_count: 1, pruned_count: 1 });
    expect(git("worktree", "list", "--porcelain")).not.toContain("prunable");
  });

  it("reports a locked worktree whose recorded PID is dead, but never removes it", () => {
    const wtPath = join(repo, ".worktrees", "locked-dead");
    mkdirSync(dirname(wtPath), { recursive: true });
    git("worktree", "add", "-b", "arbor/c1/n2", wtPath, "HEAD");
    // A PID that cannot plausibly be alive: PID 1 exists (init), so pick a
    // huge, almost-certainly-unallocated PID instead.
    const deadPid = 999999;
    git("worktree", "lock", wtPath, "--reason", `claude session fixture (pid ${deadPid} start 0)`);

    const { code, report } = runGate();
    expect(code).toBe(0);
    expect(report.stale_locks).toHaveLength(1);
    expect(report.stale_locks[0].path).toContain("locked-dead");
    expect(report.stale_locks[0].pid).toBe(deadPid);

    // Never removed or unlocked — still registered and locked afterward.
    const after = git("worktree", "list", "--porcelain");
    expect(after).toContain("locked-dead");
    expect(after).toContain("locked");
  });

  it("does not report a locked worktree whose recorded PID is alive", () => {
    const wtPath = join(repo, ".worktrees", "locked-alive");
    mkdirSync(dirname(wtPath), { recursive: true });
    git("worktree", "add", "-b", "arbor/c1/n3", wtPath, "HEAD");
    git("worktree", "lock", wtPath, "--reason", `claude session fixture (pid ${process.pid} start 0)`);

    const { report } = runGate();
    expect(report.stale_locks).toEqual([]);
  });
});
