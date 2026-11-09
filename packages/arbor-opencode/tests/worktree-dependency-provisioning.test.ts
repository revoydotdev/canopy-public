/**
 * `WorktreeManager.acquireLease` provisions a leased worktree's dependencies
 * from its OWN lockfile before handing the lease back -- a fresh `git
 * worktree add` has no `node_modules`, and every verification command a
 * specialist runs inside its lease would otherwise die on that. Real git
 * repos + real `bun install`, no network (fixtures use `file:`-referenced
 * sibling packages), matching `worktree-shallow-isolation.test.ts`'s style
 * for this file.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "@arbor/campaign-support";

function makeRepoWithBunProject(): string {
  const repo = mkdtempSync(join(tmpdir(), "arbor-wt-provision-"));
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });

  // `local-pkg` sits alongside the repo's OWN root as a real dependency the
  // repo's package.json references via `file:`, so the lease's detached,
  // fetched-at-a-commit checkout can resolve it purely from what the commit
  // itself carries -- no network, no path outside the admitted commit.
  mkdirSync(join(repo, "local-pkg"), { recursive: true });
  writeFileSync(join(repo, "local-pkg", "package.json"), JSON.stringify({ name: "local-pkg", version: "1.0.0" }));
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "proj", version: "1.0.0", dependencies: { "local-pkg": "file:./local-pkg" },
  }));
  writeFileSync(join(repo, "bun.lock"), JSON.stringify({
    lockfileVersion: 1, configVersion: 1,
    workspaces: { "": { name: "proj", dependencies: { "local-pkg": "file:./local-pkg" } } },
    packages: { "local-pkg": ["local-pkg@file:./local-pkg", {}] },
  }));
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });
  return repo;
}

function cleanupRepo(repo: string): void {
  spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
  rmSync(repo, { recursive: true, force: true });
}

describe("WorktreeManager — dependency provisioning (specialist worktree path)", () => {
  it("installs the leased worktree's own dependencies, and reports it via lastDependencyProvisioning", () => {
    const repo = makeRepoWithBunProject();
    const manager = new WorktreeManager({ repoRoot: repo });

    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });

    expect(lease).not.toBeNull();
    expect(existsSync(join(lease!.path, "node_modules", "local-pkg"))).toBe(true);
    expect(manager.lastDependencyProvisioning).toMatchObject({ status: "installed", ecosystem: "bun" });

    manager.releaseLease("n1");
    cleanupRepo(repo);
  });

  it("skips (typed, not silent) when the worktree has no recognized lockfile", () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-wt-provision-none-"));
    spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "no lockfile here\n");
    spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });

    const manager = new WorktreeManager({ repoRoot: repo });
    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });

    expect(lease).not.toBeNull();
    expect(manager.lastDependencyProvisioning).toEqual({ status: "skipped", reason: "no_lockfile" });

    manager.releaseLease("n1");
    cleanupRepo(repo);
  });

  it("does not install when dependencyProvisioning is disabled", () => {
    const repo = makeRepoWithBunProject();
    const manager = new WorktreeManager({ repoRoot: repo, dependencyProvisioning: { enabled: false } });

    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });

    expect(lease).not.toBeNull();
    expect(existsSync(join(lease!.path, "node_modules"))).toBe(false);
    expect(manager.lastDependencyProvisioning).toEqual({ status: "disabled" });

    manager.releaseLease("n1");
    cleanupRepo(repo);
  });

  it("fails the acquire honestly (never a half-usable lease) when the install fails, cleaning up the worktree and branch", () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-wt-provision-fail-"));
    spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
    // References a sibling package absent from the repo entirely -- the
    // install deterministically fails, offline, with no fixture flakiness.
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "proj", version: "1.0.0", dependencies: { "missing-pkg": "file:./missing-pkg" },
    }));
    writeFileSync(join(repo, "bun.lock"), JSON.stringify({
      lockfileVersion: 1, configVersion: 1,
      workspaces: { "": { name: "proj", dependencies: { "missing-pkg": "file:./missing-pkg" } } },
      packages: { "missing-pkg": ["missing-pkg@file:./missing-pkg", {}] },
    }));
    spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });

    const manager = new WorktreeManager({ repoRoot: repo });
    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });

    expect(lease).toBeNull();
    expect(manager.lastAcquireFailure).toContain("dependency install failed");
    expect(manager.lastDependencyProvisioning?.status).toBe("failed");

    // Honest failure: no orphaned worktree directory, no orphaned branch.
    expect(existsSync(join(repo, ".worktrees", "c1-n1"))).toBe(false);
    const branchList = spawnSync("git", ["-C", repo, "branch", "--list", "arbor/c1/n1"], { encoding: "utf-8" });
    expect(branchList.stdout.trim()).toBe("");

    cleanupRepo(repo);
  });
});
