/**
 * worktree-preservation.test.ts — `releaseLease`/`reconcileLeases({ sweep })`
 * must never destroy un-integrated work: dirty and/or unmerged content is
 * preserved under `.arbor/preserved/` BEFORE the worktree/branch are
 * removed, and if preservation itself cannot succeed the worktree and
 * branch are retained rather than destroyed. All against real git repos.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { WorktreeManager } from "@arbor/campaign-support";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    // A locked-down `.arbor/preserved` directory from the permission-failure
    // test must be restored to removable before cleanup.
    spawnSync("chmod", ["-R", "u+rwx", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git -C ${cwd} ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arbor-wt-preserve-"));
  scratch.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "x.txt"), "hi\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

function preservedManifestPath(repo: string, campaignId: string, nodeId: string): string {
  return join(repo, ".arbor", "preserved", campaignId, nodeId, "manifest.json");
}

describe("releaseLease — preserve before destroy", () => {
  it("clean, fully-integrated worktree: removed outright, nothing preserved", () => {
    const repo = makeRepo();
    const wt = new WorktreeManager({ repoRoot: repo });
    const lease = wt.acquireLease({ campaign_id: "c1", node_id: "clean", specialist: "seed" });
    expect(lease).not.toBeNull();

    expect(wt.releaseLease("clean")).toBe(true);
    const outcome = wt.lastReleaseOutcome;
    expect(outcome?.status).toBe("removed_integrated");
    expect(existsSync(lease!.path)).toBe(false);
    expect(existsSync(preservedManifestPath(repo, "c1", "clean"))).toBe(false);
  });

  it("dirty worktree (untracked new file + modified tracked file): preserved, manifest verifies, patch reproduces both files byte-for-byte, then removed", () => {
    const repo = makeRepo();
    const wt = new WorktreeManager({ repoRoot: repo });
    const lease = wt.acquireLease({ campaign_id: "c1", node_id: "dirty", specialist: "seed" });
    expect(lease).not.toBeNull();
    const path = lease!.path;
    const startingCommit = lease!.starting_commit;

    writeFileSync(join(path, "x.txt"), "hi, modified\n");
    writeFileSync(join(path, "new-file.txt"), "brand new untracked content\n");

    expect(wt.releaseLease("dirty")).toBe(true);
    const outcome = wt.lastReleaseOutcome;
    expect(outcome?.status).toBe("removed_after_preservation");
    expect(existsSync(path)).toBe(false);

    const manifestPath = (outcome as { manifest_path: string }).manifest_path;
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.node_id).toBe("dirty");
    expect(manifest.campaign_id).toBe("c1");
    expect(manifest.starting_commit).toBe(startingCommit);
    expect(manifest.artifacts.patch).not.toBeNull();

    const patchPath = join(join(manifestPath, ".."), manifest.artifacts.patch.file);
    const patchBytes = readFileSync(patchPath);
    expect(patchBytes.length).toBe(manifest.artifacts.patch.bytes);
    const crypto = require("node:crypto");
    expect(crypto.createHash("sha256").update(patchBytes).digest("hex")).toBe(manifest.artifacts.patch.sha256);

    // Apply the preserved patch to a fresh checkout of starting_commit and
    // confirm it reproduces both files byte-for-byte.
    const freshDir = mkdtempSync(join(tmpdir(), "arbor-wt-preserve-apply-"));
    scratch.push(freshDir);
    git(freshDir, ["clone", "-q", repo, "."]);
    git(freshDir, ["checkout", "-q", startingCommit]);
    const apply = spawnSync("git", ["-C", freshDir, "apply", patchPath], { encoding: "utf-8" });
    expect(apply.status).toBe(0);
    expect(readFileSync(join(freshDir, "x.txt"), "utf-8")).toBe("hi, modified\n");
    expect(readFileSync(join(freshDir, "new-file.txt"), "utf-8")).toBe("brand new untracked content\n");
  });

  it("committed-but-unmerged work: bundle verifies and contains the commits, then removed", () => {
    const repo = makeRepo();
    const wt = new WorktreeManager({ repoRoot: repo });
    const lease = wt.acquireLease({ campaign_id: "c1", node_id: "unmerged", specialist: "seed" });
    expect(lease).not.toBeNull();
    const path = lease!.path;
    const startingCommit = lease!.starting_commit;

    // Expansion checkouts detach their own object database (`git init`
    // inside the worktree), so they never inherit the parent repo's
    // config — commit identity must be set here too.
    git(path, ["config", "user.email", "t@t"]);
    git(path, ["config", "user.name", "t"]);
    writeFileSync(join(path, "feature.txt"), "unmerged feature\n");
    git(path, ["add", "-A"]);
    git(path, ["commit", "-qm", "feature commit never merged into main"]);
    const headCommit = git(path, ["rev-parse", "HEAD"]);
    expect(headCommit).not.toBe(startingCommit);

    expect(wt.releaseLease("unmerged")).toBe(true);
    const outcome = wt.lastReleaseOutcome;
    expect(outcome?.status).toBe("removed_after_preservation");
    expect(existsSync(path)).toBe(false);

    const manifestPath = (outcome as { manifest_path: string }).manifest_path;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.artifacts.bundle).not.toBeNull();
    const bundlePath = join(join(manifestPath, ".."), manifest.artifacts.bundle.file);
    expect(existsSync(bundlePath)).toBe(true);

    // `repo` still holds `startingCommit` reachable from its own HEAD, so
    // bundle verify (which checks the bundle's prerequisites) can run there.
    const verify = spawnSync("git", ["-C", repo, "bundle", "verify", bundlePath], { encoding: "utf-8" });
    expect(verify.status).toBe(0);

    const heads = git(repo, ["bundle", "list-heads", bundlePath]);
    expect(heads).toContain(headCommit);

    // Restore into a fresh repo by fetching every ref the bundle carries
    // (its tip is recorded under a scratch ref name, deleted from the
    // worktree once the bundle was built — irrelevant to a restorer, who
    // only needs the objects and the commit id from the manifest).
    const restoreDir = mkdtempSync(join(tmpdir(), "arbor-wt-preserve-bundle-"));
    scratch.push(restoreDir);
    // The bundle only carries `startingCommit..headCommit`; a restorer needs
    // `startingCommit` itself as a prerequisite, exactly as a real recovery
    // would clone the product repo first and then apply the bundle on top.
    git(restoreDir, ["clone", "-q", repo, "."]);
    git(restoreDir, ["fetch", "-q", bundlePath, "+refs/*:refs/bundle/*"]);
    expect(spawnSync("git", ["-C", restoreDir, "cat-file", "-e", `${headCommit}^{commit}`], { stdio: "pipe" }).status).toBe(0);
    const log = git(restoreDir, ["log", "--format=%H", headCommit]);
    expect(log.split("\n")).toContain(headCommit);
  });

  it("preservation failure (unwritable .arbor/preserved): worktree and branch are retained, not destroyed", () => {
    const repo = makeRepo();
    const wt = new WorktreeManager({ repoRoot: repo });
    const lease = wt.acquireLease({ campaign_id: "c1", node_id: "locked", specialist: "seed" });
    expect(lease).not.toBeNull();
    const path = lease!.path;
    const branch = lease!.branch;

    writeFileSync(join(path, "new-file.txt"), "content that must not be lost\n");

    const preservedRoot = join(repo, ".arbor", "preserved");
    mkdirSync(preservedRoot, { recursive: true });
    chmodSync(preservedRoot, 0o500); // read+execute only: mkdirSync of a new campaign subdir fails with EACCES

    try {
      expect(wt.releaseLease("locked")).toBe(true);
      const outcome = wt.lastReleaseOutcome;
      expect(outcome?.status).toBe("retained_preservation_failed");
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(path, "new-file.txt"))).toBe(true);
      const branchStillExists = spawnSync(
        "git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        { stdio: "pipe" },
      );
      expect(branchStillExists.status).toBe(0);
      // Freed for bookkeeping (deactivated), but not destroyed.
      expect(wt.isHeld("locked")).toBe(false);
    } finally {
      chmodSync(preservedRoot, 0o700);
    }
  });

  it("TOCTOU: an already-dirty file edited AGAIN between preservation and the re-check is never lost (content identity, not just dirty+HEAD)", () => {
    const repo = makeRepo();
    let injected = false;
    // Test-only seam (see `WorktreeManagerOptions._testOnly_afterPreserveHook`):
    // lands a second edit to x.txt in the exact synchronous window between
    // "preservation snapshot captured" and "TOCTOU re-check", which is
    // otherwise impossible to hit deterministically from a test.
    const wt = new WorktreeManager({
      repoRoot: repo,
      _testOnly_afterPreserveHook: (worktreePath) => {
        if (injected) return;
        injected = true;
        writeFileSync(join(worktreePath, "x.txt"), "hi, modified AGAIN after preservation\n");
      },
    });
    const lease = wt.acquireLease({ campaign_id: "c1", node_id: "raced", specialist: "seed" });
    expect(lease).not.toBeNull();
    const path = lease!.path;

    writeFileSync(join(path, "x.txt"), "hi, modified\n");

    expect(wt.releaseLease("raced")).toBe(true);
    expect(injected).toBe(true); // sanity: the injection window was actually hit
    const outcome = wt.lastReleaseOutcome;

    if (outcome?.status === "removed_after_preservation") {
      // Re-preserved: the manifest/patch must reflect the LATEST content —
      // never the first, now-stale snapshot dirty+HEAD alone would have
      // accepted.
      const manifest = JSON.parse(readFileSync(outcome.manifest_path, "utf-8"));
      const patchPath = join(join(outcome.manifest_path, ".."), manifest.artifacts.patch.file);
      const patchContent = readFileSync(patchPath, "utf-8");
      expect(patchContent).toContain("modified AGAIN after preservation");
    } else {
      // Retained rather than destroyed with the late edit unpreserved.
      expect(outcome?.status).toBe("retained_raced");
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(join(path, "x.txt"), "utf-8")).toBe("hi, modified AGAIN after preservation\n");
    }
  });
});

describe("reconcileLeases({ sweep }) — orphan sweep preserves before destroying", () => {
  it("an orphaned worktree with dirty, un-integrated content is preserved before removal", () => {
    const repo = makeRepo();
    const first = new WorktreeManager({ repoRoot: repo });
    const lease = first.acquireLease({ campaign_id: "c1", node_id: "orphan1", specialist: "seed" });
    expect(lease).not.toBeNull();
    const path = lease!.path;
    const branch = lease!.branch;

    // Simulate a crash: the lease file is gone but the worktree/branch are
    // still registered with git — exactly the "orphaned managed worktree"
    // state `reconcileLeases` is documented to detect.
    rmSync(join(first.leasesPath, "orphan1.json"), { force: true });
    writeFileSync(join(path, "orphan-work.txt"), "work that would otherwise be lost\n");

    const manager = new WorktreeManager({ repoRoot: repo });
    const firstPass = manager.reconcileLeases({ sweep: true, orphanGraceMs: 0 });
    expect(firstPass.outcomes.some((o) => o.status === "orphaned_worktree")).toBe(true);

    const secondPass = manager.reconcileLeases({ sweep: true, orphanGraceMs: 0 });
    const swept = secondPass.outcomes.find((o) => o.path === path);
    expect(swept?.status).toBe("reclaimed_after_preservation");
    expect(existsSync(path)).toBe(false);

    const manifestPath = preservedManifestPath(repo, "c1", "orphan1");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.artifacts.patch).not.toBeNull();

    const branchGone = spawnSync(
      "git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { stdio: "pipe" },
    );
    expect(branchGone.status).not.toBe(0);
  });

  it("orphan sweep also retains (not destroys) when preservation fails", () => {
    const repo = makeRepo();
    const first = new WorktreeManager({ repoRoot: repo });
    const lease = first.acquireLease({ campaign_id: "c1", node_id: "orphan2", specialist: "seed" });
    expect(lease).not.toBeNull();
    const path = lease!.path;
    const branch = lease!.branch;
    rmSync(join(first.leasesPath, "orphan2.json"), { force: true });
    writeFileSync(join(path, "orphan-work.txt"), "must not be destroyed\n");

    const preservedRoot = join(repo, ".arbor", "preserved");
    mkdirSync(preservedRoot, { recursive: true });
    chmodSync(preservedRoot, 0o500);

    try {
      const manager = new WorktreeManager({ repoRoot: repo });
      manager.reconcileLeases({ sweep: true, orphanGraceMs: 0 });
      const swept = manager.reconcileLeases({ sweep: true, orphanGraceMs: 0 });
      const outcome = swept.outcomes.find((o) => o.path === path);
      expect(outcome?.status).toBe("reclaim_retained_preservation_failed");
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(path, "orphan-work.txt"))).toBe(true);
      const branchStillExists = spawnSync(
        "git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        { stdio: "pipe" },
      );
      expect(branchStillExists.status).toBe(0);
    } finally {
      chmodSync(preservedRoot, 0o700);
    }
  });
});
