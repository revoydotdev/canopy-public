import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { WorktreeManager } from "@arbor/campaign-support";

describe("WorktreeManager (dry-run)", () => {
  it("acquires a lease and marks it active", () => {
    const wt = new WorktreeManager({}, true);
    const lease = wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(lease).not.toBeNull();
    expect(lease!.active).toBe(true);
    expect(lease!.node_id).toBe("n1");
    expect(lease!.campaign_id).toBe("c1");
    expect(lease!.branch).toBe("arbor/c1/n1");
    expect(wt.isHeld("n1")).toBe(true);
  });

  it("refuses to re-acquire an active lease", () => {
    const wt = new WorktreeManager({}, true);
    wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    const second = wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "heartwood" });
    expect(second).toBeNull();
    expect(wt.isHeld("n1")).toBe(true);
  });

  it("releases a lease and frees it for re-acquisition", () => {
    const wt = new WorktreeManager({}, true);
    wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(wt.releaseLease("n1")).toBe(true);
    expect(wt.isHeld("n1")).toBe(false);

    // Can re-acquire after release.
    const again = wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(again).not.toBeNull();
  });

  it("releaseLease on a never-held node returns false", () => {
    const wt = new WorktreeManager({}, true);
    expect(wt.releaseLease("never-held")).toBe(false);
  });

  it("lists active leases only", () => {
    const wt = new WorktreeManager({}, true);
    wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    wt.acquireLease({ campaign_id: "c1", node_id: "n2", specialist: "seed" });
    wt.acquireLease({ campaign_id: "c1", node_id: "n3", specialist: "heartwood" });
    wt.releaseLease("n2");

    const active = wt.listActive();
    expect(active.map((l) => l.node_id).sort()).toEqual(["n1", "n3"]);
  });
});

describe("WorktreeManager (real git repo)", () => {
  it("canonicalizes a symlinked repository root before creating worktrees", () => {
    const { rmSync, symlinkSync } = require("node:fs");
    const repo = makeRepo();
    const alias = `${repo}-alias`;
    symlinkSync(repo, alias, "dir");

    const manager = new WorktreeManager({ repoRoot: alias });
    const lease = manager.acquireLease({ campaign_id: "alias", node_id: "n1", specialist: "seed" });

    expect(lease).not.toBeNull();
    expect(lease!.path.startsWith(repo)).toBe(true);
    expect(lease!.path.startsWith(alias)).toBe(false);
    expect(manager.releaseLease("n1")).toBe(true);

    rmSync(alias);
    cleanupRepo(repo);
  });

  it("creates and removes a git worktree with a lease", () => {
    // Build a throwaway bare-ish repo in a temp dir via git init.
    const { mkdtempSync, writeFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const { spawnSync } = require("node:child_process");

    const repo = mkdtempSync(join(tmpdir(), "arbor-wt-"));
    spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
    writeFileSync(join(repo, "x.txt"), "hi\n");
    spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });

    const wt = new WorktreeManager({ repoRoot: repo });
    const lease = wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });

    expect(lease).not.toBeNull();
    expect(lease!.starting_commit).not.toBe("HEAD"); // real sha from rev-parse
    expect(spawnSync("git", ["-C", lease!.path, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim()).toBe(lease!.starting_commit);
    expect(wt.isHeld("n1")).toBe(true);

    // The worktree dir should exist on disk with the tracked file.
    const worktreePath = lease!.path;
    const { existsSync } = require("node:fs");
    expect(existsSync(join(worktreePath, "x.txt"))).toBe(true);

    expect(wt.releaseLease("n1")).toBe(true);
    expect(wt.isHeld("n1")).toBe(false);

    // Clean up the temp repo (worktree + git metadata).
    spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
    require("node:fs").rmSync(repo, { recursive: true, force: true });
  });

  it("refuses a stale HEAD when the operator workspace has uncommitted product changes", () => {
    const repo = makeRepo();
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    writeFileSync(join(repo, "x.txt"), "operator change\n");
    const manager = new WorktreeManager({ repoRoot: repo });
    expect(manager.acquireLease({ campaign_id: "dirty", node_id: "n1", specialist: "seed" })).toBeNull();
    expect(manager.lastAcquireFailure).toContain("uncommitted product changes");
    expect(manager.lastAcquireFailure).toContain("x.txt");
    cleanupRepo(repo);
  });

  it("ignores declared Revoy persistence without excusing adjacent product changes", () => {
    const repo = makeRepo();
    const { mkdirSync, writeFileSync } = require("node:fs");
    const persistence = join(repo, ".arbor-evidence");
    mkdirSync(persistence);
    writeFileSync(join(persistence, "audit.jsonl"), "runtime evidence\n");

    const clean = new WorktreeManager({ repoRoot: repo, operationalPaths: [persistence] });
    const lease = clean.acquireLease({ campaign_id: "evidence", node_id: "n1", specialist: "seed" });
    expect(lease).not.toBeNull();
    expect(clean.releaseLease("n1")).toBe(true);

    writeFileSync(join(repo, ".arbor-evidence-adjacent.txt"), "product change\n");
    const dirty = new WorktreeManager({ repoRoot: repo, operationalPaths: [persistence] });
    expect(dirty.acquireLease({ campaign_id: "dirty", node_id: "n2", specialist: "seed" })).toBeNull();
    expect(dirty.lastAcquireFailure).toContain(".arbor-evidence-adjacent.txt");
    cleanupRepo(repo);
  });

  it("does not expose commits created after the admitted starting commit", () => {
    const repo = makeRepo();
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { spawnSync } = require("node:child_process");
    const admitted = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();

    writeFileSync(join(repo, "future.txt"), "hidden fix\n");
    spawnSync("git", ["-C", repo, "add", "future.txt"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "commit", "-qm", "future fix"], { stdio: "ignore" });
    const future = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
    spawnSync("git", ["-C", repo, "reset", "--hard", admitted], { stdio: "ignore" });

    const manager = new WorktreeManager({ repoRoot: repo });
    const lease = manager.acquireLease({ campaign_id: "future", node_id: "n1", specialist: "seed" });
    expect(lease).not.toBeNull();
    expect(lease!.starting_commit).toBe(admitted);
    expect(spawnSync("git", ["-C", lease!.path, "cat-file", "-e", `${future}^{commit}`], { stdio: "ignore" }).status).not.toBe(0);
    expect(spawnSync("git", ["-C", lease!.path, "rev-list", "--all"], { encoding: "utf-8" }).stdout.trim().split("\n")).not.toContain(future);

    expect(manager.releaseLease("n1")).toBe(true);
    cleanupRepo(repo);
  });

  it("releaseLease deletes the branch, not just the worktree (regression: campaigns leaked one arbor/* branch per node)", () => {
    // Measured incident: a hygiene pass found 306 orphaned arbor/* branches
    // against only 6 orphaned worktrees — because `git worktree remove`
    // never deletes the branch it was checked out on, releaseLease() was
    // reclaiming the worktree directory but leaving its branch behind on
    // EVERY node, crash or not. This proves both halves are reclaimed.
    const repo = makeRepo();
    const wt = new WorktreeManager({ repoRoot: repo });
    const lease = wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(lease).not.toBeNull();
    expect(lease!.branch).toBe("arbor/c1/n1");

    const { spawnSync } = require("node:child_process");
    const branchExistsBefore = spawnSync(
      "git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${lease!.branch}`],
      { stdio: "pipe" },
    );
    expect(branchExistsBefore.status).toBe(0); // branch was created by acquireLease

    expect(wt.releaseLease("n1")).toBe(true);

    const branchExistsAfter = spawnSync(
      "git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${lease!.branch}`],
      { stdio: "pipe" },
    );
    expect(branchExistsAfter.status).not.toBe(0); // branch must be gone after release

    const { existsSync } = require("node:fs");
    expect(existsSync(lease!.path)).toBe(false); // worktree dir must be gone too

    cleanupRepo(repo);
  });

  it("keeps a registered lease live during startup reconciliation", () => {
    const repo = makeRepo();
    const manager = new WorktreeManager({ repoRoot: repo });
    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(lease).not.toBeNull();

    const restarted = new WorktreeManager({ repoRoot: repo });
    const result = restarted.reconcileLeases();
    expect(result.live.map((entry) => entry.node_id)).toEqual(["n1"]);
    expect(result.outcomes).toContainEqual(expect.objectContaining({ status: "live", node_id: "n1" }));
    expect(restarted.isHeld("n1")).toBe(true);

    cleanupRepo(repo);
  });

  it("deactivates a stale lease but never removes a worktree itself", () => {
    const repo = makeRepo();
    const manager = new WorktreeManager({ repoRoot: repo });
    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(lease).not.toBeNull();
    require("node:fs").rmSync(lease!.path, { recursive: true, force: true });
    require("node:child_process").spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });

    const restarted = new WorktreeManager({ repoRoot: repo });
    const result = restarted.reconcileLeases();
    expect(result.outcomes).toContainEqual(expect.objectContaining({ status: "stale", node_id: "n1" }));
    expect(restarted.isHeld("n1")).toBe(false);
    const persisted = JSON.parse(require("node:fs").readFileSync(join(repo, ".arbor", "leases", "n1.json"), "utf-8"));
    expect(persisted.active).toBe(false);

    cleanupRepo(repo);
  });

  it("reports malformed lease files without changing them", () => {
    const repo = makeRepo();
    const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
    const leaseFile = join(repo, ".arbor", "leases", "broken.json");
    mkdirSync(require("node:path").dirname(leaseFile), { recursive: true });
    writeFileSync(leaseFile, "{not json", "utf-8");

    const result = new WorktreeManager({ repoRoot: repo }).reconcileLeases();
    expect(result.outcomes).toContainEqual(expect.objectContaining({ status: "malformed", lease_file: "broken.json" }));
    expect(readFileSync(leaseFile, "utf-8")).toBe("{not json");

    cleanupRepo(repo);
  });

  it("reports unrelated leases without treating their paths as disposable", () => {
    const repo = makeRepo();
    const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
    const leaseFile = join(repo, ".arbor", "leases", "foreign.json");
    const foreignPath = join(repo, "outside-managed-worktrees");
    const record = {
      node_id: "foreign",
      campaign_id: "c1",
      branch: "arbor/c1/foreign",
      path: foreignPath,
      acquired_at: new Date().toISOString(),
      acquired_by: "seed",
      starting_commit: "HEAD",
      active: true,
    };
    mkdirSync(require("node:path").dirname(leaseFile), { recursive: true });
    writeFileSync(leaseFile, JSON.stringify(record), "utf-8");

    const result = new WorktreeManager({ repoRoot: repo }).reconcileLeases();
    expect(result.outcomes).toContainEqual(expect.objectContaining({ status: "unrelated", lease_file: "foreign.json" }));
    expect(JSON.parse(readFileSync(leaseFile, "utf-8"))).toEqual(record);

    cleanupRepo(repo);
  });
});

describe("WorktreeManager — reclaiming orphaned managed worktrees", () => {
  /**
   * Produce a genuine orphan the way the code actually produces one:
   * `releaseLease` drops the lease file unconditionally after two best-effort
   * git calls, so a failed `git worktree remove` leaves the worktree
   * registered, its branch alive, and no lease pointing at either.
   */
  function orphan(repo: string): { path: string; branch: string } {
    const manager = new WorktreeManager({ repoRoot: repo });
    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(lease).not.toBeNull();
    require("node:fs").rmSync(join(manager.leasesPath, "n1.json"), { force: true });
    return { path: lease!.path, branch: lease!.branch };
  }

  function registered(repo: string, path: string): boolean {
    const listed = require("node:child_process")
      .spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { stdio: "pipe", encoding: "utf-8" }).stdout;
    return listed.split(/\r?\n/).some((line: string) => line === `worktree ${path}`);
  }

  function branchExists(repo: string, branch: string): boolean {
    return require("node:child_process")
      .spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { stdio: "pipe" })
      .status === 0;
  }

  const LATER = (ms: number): Date => new Date(Date.now() + ms);

  it("WITHOUT sweeping, an orphan survives unbounded passes — the defect this closes", () => {
    // This is the pre-fix behaviour, kept as the control: it is exactly what
    // let orphaned worktrees accumulate, since nothing else ever reclaims them.
    const repo = makeRepo();
    const { path, branch } = orphan(repo);

    for (let pass = 0; pass < 3; pass += 1) {
      const result = new WorktreeManager({ repoRoot: repo }).reconcileLeases({ now: LATER(pass * 86_400_000) });
      expect(result.outcomes).toContainEqual(expect.objectContaining({ status: "orphaned_worktree", path }));
      expect(result.outcomes.some((outcome) => outcome.status === "reclaimed")).toBe(false);
    }
    expect(registered(repo, path)).toBe(true);
    expect(branchExists(repo, branch)).toBe(true);

    cleanupRepo(repo);
  });

  it("WITH sweeping, an orphan observed twice across the grace period is reclaimed — worktree AND branch", () => {
    const repo = makeRepo();
    const { path, branch } = orphan(repo);
    const { existsSync } = require("node:fs");

    // Pass 1 only marks; a fresh manager each pass proves the mark is durable
    // rather than living in one process's memory.
    const first = new WorktreeManager({ repoRoot: repo }).reconcileLeases({ sweep: true, orphanGraceMs: 1000 });
    expect(first.outcomes).toContainEqual(expect.objectContaining({ status: "orphaned_worktree", path }));
    expect(registered(repo, path)).toBe(true);

    const second = new WorktreeManager({ repoRoot: repo })
      .reconcileLeases({ sweep: true, orphanGraceMs: 1000, now: LATER(60_000) });
    expect(second.outcomes).toContainEqual(expect.objectContaining({ status: "reclaimed", path }));

    expect(registered(repo, path)).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(branchExists(repo, branch)).toBe(false);
    // The mark is consumed, not left behind to accuse a path that no longer exists.
    expect(existsSync(join(repo, ".arbor", "orphan-marks.json"))).toBe(false);

    cleanupRepo(repo);
  });

  it("NEVER sweeps on first observation, even with a zero grace period", () => {
    // The half of the rule that protects an in-flight acquireLease: between
    // `git worktree add` and the lease write, the worktree IS orphaned by
    // every available signal. One observation must never be enough.
    const repo = makeRepo();
    const { path } = orphan(repo);

    const result = new WorktreeManager({ repoRoot: repo })
      .reconcileLeases({ sweep: true, orphanGraceMs: 0, now: LATER(86_400_000) });
    expect(result.outcomes).toContainEqual(expect.objectContaining({ status: "orphaned_worktree", path }));
    expect(registered(repo, path)).toBe(true);

    cleanupRepo(repo);
  });

  it("drops the mark when a path stops being orphaned, so a slow acquire is never swept later", () => {
    const repo = makeRepo();
    const { path, branch } = orphan(repo);
    const { existsSync, writeFileSync, mkdirSync } = require("node:fs");

    const manager = new WorktreeManager({ repoRoot: repo });
    manager.reconcileLeases({ sweep: true, orphanGraceMs: 1000 });
    expect(existsSync(join(repo, ".arbor", "orphan-marks.json"))).toBe(true);

    // The acquire that was in flight finishes and writes its lease.
    mkdirSync(manager.leasesPath, { recursive: true });
    writeFileSync(join(manager.leasesPath, "n1.json"), JSON.stringify({
      node_id: "n1", campaign_id: "c1", branch, path,
      acquired_at: new Date().toISOString(), acquired_by: "seed", starting_commit: "HEAD", active: true,
    }), "utf-8");

    const after = new WorktreeManager({ repoRoot: repo })
      .reconcileLeases({ sweep: true, orphanGraceMs: 1000, now: LATER(86_400_000) });
    expect(after.outcomes).toContainEqual(expect.objectContaining({ status: "live", node_id: "n1" }));
    expect(after.outcomes.some((outcome) => outcome.status === "reclaimed")).toBe(false);
    expect(registered(repo, path)).toBe(true);
    expect(existsSync(join(repo, ".arbor", "orphan-marks.json"))).toBe(false);

    cleanupRepo(repo);
  });

  it("never touches a worktree that holds a live lease, however old", () => {
    const repo = makeRepo();
    const manager = new WorktreeManager({ repoRoot: repo });
    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(lease).not.toBeNull();

    for (let pass = 0; pass < 2; pass += 1) {
      const result = new WorktreeManager({ repoRoot: repo })
        .reconcileLeases({ sweep: true, orphanGraceMs: 0, now: LATER(pass * 86_400_000) });
      expect(result.outcomes.some((outcome) => outcome.status === "reclaimed")).toBe(false);
    }
    expect(registered(repo, lease!.path)).toBe(true);
    expect(branchExists(repo, lease!.branch)).toBe(true);

    cleanupRepo(repo);
  });

  it("reclaims the worktree but keeps a branch it did not create", () => {
    const repo = makeRepo();
    const { spawnSync } = require("node:child_process");
    const { existsSync } = require("node:fs");
    const path = join(repo, ".worktrees", "hand-made");
    spawnSync("git", ["-C", repo, "worktree", "add", "-b", "someone-elses-work", path, "HEAD"], { stdio: "ignore" });
    expect(registered(repo, path)).toBe(true);

    new WorktreeManager({ repoRoot: repo }).reconcileLeases({ sweep: true, orphanGraceMs: 0 });
    const swept = new WorktreeManager({ repoRoot: repo })
      .reconcileLeases({ sweep: true, orphanGraceMs: 0, now: LATER(86_400_000) });

    expect(swept.outcomes).toContainEqual(expect.objectContaining({ status: "reclaimed", path }));
    expect(existsSync(path)).toBe(false);
    // Reclaiming a directory must not destroy work under a name this manager
    // could never have produced.
    expect(branchExists(repo, "someone-elses-work")).toBe(true);

    cleanupRepo(repo);
  });

  it("shares fetched objects across nodes in the same campaign via git alternates instead of re-fetching per node", () => {
    const repo = makeRepo();
    const manager = new WorktreeManager({ repoRoot: repo });
    const first = manager.acquireLease({ campaign_id: "shared", node_id: "n1", specialist: "seed" });
    const second = manager.acquireLease({ campaign_id: "shared", node_id: "n2", specialist: "seed" });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const { existsSync, readFileSync } = require("node:fs");
    const { spawnSync } = require("node:child_process");
    const cachePath = join(repo, ".arbor", "object-cache", `admitted-${first!.starting_commit}.git`);
    expect(existsSync(cachePath)).toBe(true);
    expect(
      spawnSync("git", ["-C", cachePath, "cat-file", "-e", `${first!.starting_commit}^{commit}`], { stdio: "ignore" }).status,
    ).toBe(0);

    // Every node — not just the second — references the shared store rather
    // than carrying its own private full fetch of the ancestor set.
    for (const lease of [first!, second!]) {
      const alternatesFile = join(lease.path, ".git", "objects", "info", "alternates");
      expect(existsSync(alternatesFile)).toBe(true);
      expect(readFileSync(alternatesFile, "utf-8")).toContain(join(cachePath, "objects"));
      // The admitted object is addressed directly through alternates; a
      // redundant per-node transport fetch would create FETCH_HEAD here.
      expect(existsSync(join(lease.path, ".git", "FETCH_HEAD"))).toBe(false);
    }

    // Working tree/index isolation is unaffected: each node still has its
    // own independent git dir, refs, and checked-out files.
    expect(existsSync(join(first!.path, "x.txt"))).toBe(true);
    expect(existsSync(join(second!.path, "x.txt"))).toBe(true);
    expect(first!.path).not.toBe(second!.path);

    manager.releaseLease("n1");
    manager.releaseLease("n2");
    cleanupRepo(repo);
  });

  it("reuses the immutable admitted-commit cache across different campaigns", () => {
    const repo = makeRepo();
    const manager = new WorktreeManager({ repoRoot: repo });
    const first = manager.acquireLease({ campaign_id: "campaign-a", node_id: "n1", specialist: "seed" });
    const second = manager.acquireLease({ campaign_id: "campaign-b", node_id: "n2", specialist: "seed" });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.starting_commit).toBe(second!.starting_commit);

    const { existsSync, readFileSync, readdirSync } = require("node:fs");
    const cachePath = join(repo, ".arbor", "object-cache", `admitted-${first!.starting_commit}.git`);
    expect(existsSync(cachePath)).toBe(true);
    expect(readdirSync(join(repo, ".arbor", "object-cache"))).toEqual([`admitted-${first!.starting_commit}.git`]);
    for (const lease of [first!, second!]) {
      expect(readFileSync(join(lease.path, ".git", "objects", "info", "alternates"), "utf-8")).toContain(join(cachePath, "objects"));
    }

    manager.releaseLease("n1");
    manager.releaseLease("n2");
    cleanupRepo(repo);
  });

  it("preflight rejects ANY target commit against a shallow repoRoot, including one present in its shallow history (defect #5 / B1)", () => {
    // A shallow repoRoot cannot serve as a fetch SOURCE at all — git refuses
    // with "rejected <sha> because shallow roots are not allowed to be
    // updated" even for a commit well within the shallow window (e.g. HEAD
    // itself), and that fetch exits 0 despite the rejection, only failing
    // several steps later at `update-ref`/`reset --hard` deep inside
    // `detachObjectDatabase`. A narrower preflight that only checked whether
    // `commit` was reachable via `cat-file -e` in `repoRoot` passed for HEAD
    // in exactly this failing scenario and never caught it (verified
    // 2026-08-14 against a real shallow clone of fastify). The preflight
    // must therefore reject on shallowness alone, regardless of which
    // commit is requested.
    const origin = makeRepo();
    const { execFileSync, spawnSync } = require("node:child_process");
    const { writeFileSync, mkdtempSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const firstSha = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    writeFileSync(join(origin, "y.txt"), "second\n");
    spawnSync("git", ["-C", origin, "add", "-A"], { stdio: "ignore" });
    spawnSync("git", ["-C", origin, "commit", "-qm", "second"], { stdio: "ignore" });

    const shallowDir = mkdtempSync(join(tmpdir(), "arbor-wt-shallow-"));
    // Git ignores --depth for a plain local-path clone (it hardlinks the
    // full object store); an explicit file:// URL forces the real
    // shallow-clone transport so `.git/shallow` is actually written.
    const clone = spawnSync("git", ["clone", "--depth", "1", "-q", `file://${origin}`, shallowDir], { stdio: "ignore" });
    expect(clone.status).toBe(0);

    const manager = new WorktreeManager({ repoRoot: shallowDir }) as unknown as {
      assertCommitAvailableForWorktree(commit: string): void;
    };
    // Out-of-window commit: still rejected.
    expect(() => manager.assertCommitAvailableForWorktree(firstSha)).toThrow(/repository is a shallow clone/);

    // In-window commit (HEAD itself): also rejected — this is the case the
    // narrower cat-file-based check used to miss.
    const shallowHead = execFileSync("git", ["-C", shallowDir, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    expect(() => manager.assertCommitAvailableForWorktree(shallowHead)).toThrow(/repository is a shallow clone/);
    expect(() => manager.assertCommitAvailableForWorktree(shallowHead)).toThrow(/fetch --unshallow/);

    cleanupRepo(origin);
    rmSync(shallowDir, { recursive: true, force: true });
  });

  it("preflight does not run against a non-shallow repoRoot (defect #5, negative case)", () => {
    const repo = makeRepo();
    const manager = new WorktreeManager({ repoRoot: repo }) as unknown as {
      assertCommitAvailableForWorktree(commit: string): void;
    };
    // A non-shallow repo is never blocked by this check, even for a commit
    // sha that doesn't exist at all — that is a different failure class,
    // already surfaced by the ordinary fetch failure path.
    expect(() => manager.assertCommitAvailableForWorktree("0".repeat(40))).not.toThrow();
    cleanupRepo(repo);
  });

  it("ignores an inherited GIT_DIR/GIT_WORK_TREE pointing at a different repo (regression: cross-worktree commit corruption)", () => {
    // Root-cause hardening: a concurrent process's exported GIT_DIR/GIT_WORK_TREE,
    // inherited by this process's env, would silently override every `cwd`-scoped
    // git call below and redirect worktree/branch operations at the wrong repo —
    // exactly the shape of a real incident where campaign-node worktree branches
    // ended up rooted in a completely unrelated repo's history. Every WorktreeManager
    // git invocation strips these vars from the child env (see worktree.ts's
    // sanitizedGitEnv) so `repoRoot` can never be defeated by ambient process.env.
    const repo = makeRepo();
    const decoy = makeRepo();
    const { spawnSync, execFileSync } = require("node:child_process");
    // Give the decoy a distinct commit so its HEAD can never coincidentally
    // hash-collide with `repo`'s (makeRepo() produces identical content/
    // metadata, so two calls in the same second can otherwise land on the
    // exact same commit SHA and defeat this assertion).
    require("node:fs").writeFileSync(join(decoy, "decoy-marker.txt"), "decoy\n");
    spawnSync("git", ["-C", decoy, "add", "-A"], { stdio: "ignore" });
    spawnSync("git", ["-C", decoy, "commit", "-qm", "decoy marker"], { stdio: "ignore" });
    // Read both repos' HEADs and the decoy's worktree count with a clean env,
    // BEFORE poisoning process.env — every verification call below must not
    // itself be redirected by the poison it's trying to detect.
    const decoyHead = execFileSync("git", ["-C", decoy, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const repoHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const decoyWorktreesBefore = spawnSync("git", ["-C", decoy, "worktree", "list", "--porcelain"], { encoding: "utf-8" }).stdout;

    const saved: Record<string, string | undefined> = {};
    const poison = { GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy };
    for (const key of Object.keys(poison)) saved[key] = process.env[key];
    Object.assign(process.env, poison);
    let lease: ReturnType<WorktreeManager["acquireLease"]>;
    try {
      const wt = new WorktreeManager({ repoRoot: repo });
      lease = wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    } finally {
      for (const key of Object.keys(poison)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }

    expect(lease).not.toBeNull();
    // The lease's starting commit must come from `repo`, not the poisoned decoy.
    expect(lease!.starting_commit).not.toBe(decoyHead);
    expect(lease!.starting_commit).toBe(repoHead);
    // The decoy repo must be completely untouched — no branch, no worktree.
    const decoyWorktreesAfter = spawnSync("git", ["-C", decoy, "worktree", "list", "--porcelain"], { encoding: "utf-8" }).stdout;
    expect(decoyWorktreesAfter).toBe(decoyWorktreesBefore);
    expect(branchExists(decoy, lease!.branch)).toBe(false);
    expect(branchExists(repo, lease!.branch)).toBe(true);

    cleanupRepo(repo);
    cleanupRepo(decoy);
  });

  it("refuses a campaign_id/node_id whose worktree path escapes worktreesDir, and creates no directory outside it", () => {
    // Path traversal audit finding: `path` is built by literal string
    // interpolation of caller-supplied campaign_id/node_id
    // (join(worktreesDir, `${campaign_id}-${node_id}`)) with no confinement
    // check before `mkdirSync(dirname(path), { recursive: true })` runs.
    // campaign_id is caller-controlled (WorktreeManager.acquireLease is
    // called with values threaded from manager.startCampaign/admitCampaignPlan,
    // which accept any non-empty string id) so a ".." segment must never be
    // able to create filesystem state outside the managed worktrees dir, even
    // though `git worktree add` itself would separately fail on the resulting
    // invalid ref name.
    const repo = makeRepo();
    const wt = new WorktreeManager({ repoRoot: repo });
    const markerName = `poc-escape-${process.pid}-${Date.now()}`;
    const escapeMarker = join(repo, "..", markerName);
    require("node:fs").rmSync(escapeMarker, { recursive: true, force: true });

    const lease = wt.acquireLease({
      // The trailing "/sub" component matters: it forces
      // `dirname(join(worktreesDir, campaign_id-node_id))` to be a directory
      // that does not exist yet, so `mkdirSync(dirname(path), { recursive:
      // true })` actually creates new filesystem state outside worktreesDir
      // rather than resolving to an already-existing ancestor.
      campaign_id: `../../${markerName}/sub`,
      node_id: "x",
      specialist: "seed",
    });

    expect(lease).toBeNull();
    expect(wt.lastAcquireFailure).toMatch(/escape|outside|confine/i);
    expect(existsSync(escapeMarker)).toBe(false);

    cleanupRepo(repo);
    require("node:fs").rmSync(escapeMarker, { recursive: true, force: true });
  });

  it("releaseLease drops the lease file even when the worktree contains a file it cannot remove", () => {
    // Audit finding: releaseLease's `rmSync(lease.path, { recursive: true,
    // force: true })` is NOT wrapped in try/catch, even though the method's
    // own doc comment promises "we still always drop the lease file so a
    // failed cleanup can never leave a node stuck 'held' forever." fs.rmSync's
    // `force` option only suppresses ENOENT; a permission error inside the
    // tree (EACCES) still throws, which would propagate out of releaseLease,
    // skip the branch delete AND the lease-file removal, and (in loop.ts)
    // escape a `finally` block uncaught — the exact "stuck held forever"
    // scenario the comment claims cannot happen.
    const repo = makeRepo();
    const wt = new WorktreeManager({ repoRoot: repo });
    const lease = wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(lease).not.toBeNull();

    const { mkdirSync, writeFileSync, chmodSync } = require("node:fs") as typeof import("node:fs");
    const lockedDir = join(lease!.path, "locked");
    mkdirSync(lockedDir);
    writeFileSync(join(lockedDir, "f.txt"), "x");
    chmodSync(lockedDir, 0o555); // no write bit: unlinking a child fails EACCES

    let released: boolean | undefined;
    let threw: unknown;
    try {
      released = wt.releaseLease("n1");
    } catch (error) {
      threw = error;
    } finally {
      chmodSync(lockedDir, 0o755); // restore so cleanupRepo can actually remove it
    }

    expect(threw).toBeUndefined();
    expect(released).toBe(true);
    expect(wt.isHeld("n1")).toBe(false);
    expect(existsSync(wt.leasesPath + "/n1.json")).toBe(false);

    cleanupRepo(repo);
  });
});

function makeRepo(): string {
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { spawnSync } = require("node:child_process");
  const repo = mkdtempSync(join(tmpdir(), "arbor-wt-reconcile-"));
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  writeFileSync(join(repo, "x.txt"), "hi\n");
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });
  return repo;
}

function cleanupRepo(repo: string): void {
  const { spawnSync } = require("node:child_process");
  spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
  require("node:fs").rmSync(repo, { recursive: true, force: true });
}
