/**
 * worktree-lease-claim.test.ts — crash-safety and failure-cleanup guarantees
 * for `WorktreeManager.acquireLease`'s atomic slot claim (item 1 hardening),
 * plus the per-slot mutex (`<node_id>.lock`) that replaced the earlier
 * unlink-then-create inactive-slot replacement after an orchestrator review
 * found it allowed a double-win (P2's `unlinkSync` deletes whatever is AT
 * THE PATH, including P1's freshly-created active claim, not the specific
 * inactive record P2 inspected).
 *
 * Properties this file proves against a real git repo/filesystem:
 *   1. A malformed/partial lease file is never silently claimed over — the
 *      acquire fails closed instead of clobbering something that might be a
 *      genuinely live lease mid-write.
 *   2. A failed acquire (dependency install failure, or the `git worktree
 *      add` retry both failing) removes the claim file it created — no
 *      phantom "held" lease survives a failure.
 *   3. An inactive (released/deactivated) lease record IS safely reclaimable
 *      by a fresh acquire — the claim mechanism must not turn every
 *      previously-used node_id into a permanent dead slot.
 *   4. The slot mutex genuinely serializes occupied-slot mutation: a lock
 *      externally held by a live process makes `acquireLease` fail "busy"
 *      within its bounded wait (never hangs, never races past it), and a
 *      lock whose holder is provably dead AND stale is broken automatically.
 *   5. `reconcileLeases` never deactivates an in-flight claim whose owner is
 *      alive, but does deactivate one whose owner is provably dead.
 *
 * The genuine two-OS-process race (including one that starts from a
 * pre-existing inactive record) lives in worktree-lease-race.test.ts —
 * this file covers the deterministic, single-process-controlled cases that
 * would be flaky or slow to force via real process timing.
 */
import { describe, it, expect } from "vitest";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { WorktreeManager } from "@arbor/campaign-support";

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "arbor-wt-claim-"));
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  writeFileSync(join(repo, "x.txt"), "hi\n");
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });
  return repo;
}

function cleanupRepo(repo: string): void {
  spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
  rmSync(repo, { recursive: true, force: true });
}

describe("acquireLease — malformed lease file is never silently overwritten", () => {
  it("fails closed against a truncated/partial lease file instead of claiming over it", () => {
    const repo = makeRepo();
    const leaseFile = join(repo, ".arbor", "leases", "n1.json");
    mkdirSync(join(repo, ".arbor", "leases"), { recursive: true });
    // The shape a crash mid-`writeFileSync` (or a corrupted disk read) could
    // leave behind: valid JSON prefix, cut off before it closes.
    writeFileSync(leaseFile, '{"node_id":"n1","campaign_id":"c1","branch":"arbor/c1/n1","path":"/tm', "utf-8");

    const manager = new WorktreeManager({ repoRoot: repo });
    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });

    expect(lease).toBeNull();
    expect(manager.lastAcquireFailure).toMatch(/does not parse as a valid lease record|fail closed/);
    // The malformed content is untouched — not replaced by a claim record.
    expect(readFileSync(leaseFile, "utf-8")).toBe('{"node_id":"n1","campaign_id":"c1","branch":"arbor/c1/n1","path":"/tm');
    // No worktree/branch was created off the back of a refused claim.
    expect(existsSync(join(repo, ".worktrees", "c1-n1"))).toBe(false);

    cleanupRepo(repo);
  });

  it("fails closed against completely non-JSON garbage in the lease slot", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".arbor", "leases"), { recursive: true });
    const leaseFile = join(repo, ".arbor", "leases", "n1.json");
    writeFileSync(leaseFile, "not json at all\0\0\0", "utf-8");

    const manager = new WorktreeManager({ repoRoot: repo });
    expect(manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" })).toBeNull();
    expect(readFileSync(leaseFile, "utf-8")).toBe("not json at all\0\0\0");

    cleanupRepo(repo);
  });
});

describe("acquireLease — a failed acquisition never leaves a phantom held lease", () => {
  it("removes the claim file when git worktree add fails (target path already occupied by a non-empty, non-worktree directory)", () => {
    const repo = makeRepo();
    const manager = new WorktreeManager({ repoRoot: repo });

    // `git worktree add` refuses to use a non-empty target directory it did
    // not create itself, and (since no branch named arbor/c1/n1 exists yet)
    // the `-b` create is the only attempt made — both it and the fallback
    // retry (which also targets the same occupied path) fail deterministically.
    const targetPath = join(repo, ".worktrees", "c1-n1");
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(join(targetPath, "blocker.txt"), "occupied\n");

    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(lease).toBeNull();
    expect(manager.lastAcquireFailure).toContain("git worktree creation failed");

    // The claim this manager created for n1 must be gone — not left behind
    // as a phantom active lease that would wedge every future acquire.
    const leaseFile = join(repo, ".arbor", "leases", "n1.json");
    expect(existsSync(leaseFile)).toBe(false);
    expect(manager.isHeld("n1")).toBe(false);

    cleanupRepo(repo);
  });

  it("removes the claim file when dependency provisioning fails, leaving no worktree/branch/lease behind", () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-wt-claim-provision-fail-"));
    spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
    // A lockfile referencing a sibling package absent from the repo entirely
    // makes the install deterministically fail offline (same fixture shape
    // as worktree-dependency-provisioning.test.ts).
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

    expect(existsSync(join(repo, ".arbor", "leases", "n1.json"))).toBe(false);
    expect(existsSync(join(repo, ".worktrees", "c1-n1"))).toBe(false);
    const branchList = spawnSync("git", ["-C", repo, "branch", "--list", "arbor/c1/n1"], { encoding: "utf-8" });
    expect(branchList.stdout.trim()).toBe("");

    cleanupRepo(repo);
  });

  it("a failed acquire leaves the leases directory otherwise empty — no orphaned temp files from the atomic-write machinery", () => {
    const repo = makeRepo();
    const manager = new WorktreeManager({ repoRoot: repo });
    const targetPath = join(repo, ".worktrees", "c1-n1");
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(join(targetPath, "blocker.txt"), "occupied\n");

    expect(manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" })).toBeNull();

    const leasesDir = join(repo, ".arbor", "leases");
    expect(existsSync(leasesDir) ? readdirSync(leasesDir) : []).toEqual([]);

    cleanupRepo(repo);
  });
});

describe("acquireLease — reclaiming an inactive lease slot", () => {
  it("safely replaces a deactivated (released) lease record with a fresh claim", () => {
    const repo = makeRepo();
    const manager = new WorktreeManager({ repoRoot: repo });
    const first = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(first).not.toBeNull();
    expect(manager.releaseLease("n1")).toBe(true);

    // releaseLease drops the file entirely rather than deactivating it, so
    // synthesize the "stale, deactivated but still present" shape that
    // `reconcileLeases` produces for a lease whose worktree vanished out from
    // under it — the actual origin of an inactive-but-present lease file.
    const leaseFile = join(repo, ".arbor", "leases", "n1.json");
    mkdirSync(join(repo, ".arbor", "leases"), { recursive: true });
    writeFileSync(leaseFile, JSON.stringify({
      node_id: "n1", campaign_id: "c1", branch: "arbor/c1/n1", path: join(repo, ".worktrees", "c1-n1"),
      acquired_at: new Date(Date.now() - 60_000).toISOString(), acquired_by: "seed", starting_commit: "HEAD", active: false,
    }), "utf-8");

    const second = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "heartwood" });
    expect(second).not.toBeNull();
    expect(second!.active).toBe(true);
    expect(second!.acquired_by).toBe("heartwood");
    expect(manager.isHeld("n1")).toBe(true);

    cleanupRepo(repo);
  });
});

/** Externally create `<leasesDir>/<node_id>.lock` the way `acquireSlotLock` would, simulating a concurrent holder. */
function seedLock(leasesDir: string, node_id: string, holder: { pid: number; created_at: string }): void {
  mkdirSync(leasesDir, { recursive: true });
  const fd = openSync(join(leasesDir, `${node_id}.lock`), "wx");
  try {
    writeSync(fd, JSON.stringify(holder));
  } finally {
    closeSync(fd);
  }
}

function seedInactiveLease(repo: string, node_id: string, campaign_id: string): void {
  const leaseFile = join(repo, ".arbor", "leases", `${node_id}.json`);
  mkdirSync(join(repo, ".arbor", "leases"), { recursive: true });
  writeFileSync(leaseFile, JSON.stringify({
    node_id, campaign_id, branch: `arbor/${campaign_id}/${node_id}`, path: join(repo, ".worktrees", `${campaign_id}-${node_id}`),
    acquired_at: new Date(Date.now() - 60_000).toISOString(), acquired_by: "seed", starting_commit: "HEAD", active: false,
  }), "utf-8");
}

/** Spawn and immediately kill a real child process, returning a PID that is guaranteed dead right now. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise<void>((resolveReady) => child.once("spawn", () => resolveReady()));
  const pid = child.pid!;
  child.kill("SIGKILL");
  await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
  return pid;
}

describe("acquireLease — the per-slot mutex genuinely serializes an occupied slot (closes the double-win)", () => {
  it("fails 'busy' within the bounded wait when the slot lock is externally held by a live process, and succeeds once released", () => {
    const repo = makeRepo();
    seedInactiveLease(repo, "n1", "c1");
    const leasesDir = join(repo, ".arbor", "leases");
    // Our own live pid stands in for "a concurrent process is mid-replace" —
    // acquireSlotLock has no way to distinguish that from a real second
    // process, which is exactly the point: the lock, not process identity,
    // is what prevents the double-win.
    seedLock(leasesDir, "n1", { pid: process.pid, created_at: new Date().toISOString() });

    const manager = new WorktreeManager({ repoRoot: repo });
    const started = Date.now();
    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    const elapsedMs = Date.now() - started;

    expect(lease).toBeNull();
    expect(manager.lastAcquireFailure).toContain("busy");
    // Bounded wait, not an infinite hang: comfortably under the ~2s budget
    // plus test/process overhead.
    expect(elapsedMs).toBeLessThan(5_000);
    // No corrupted/duplicated lease slot from a race that slipped past the lock.
    expect(existsSync(join(leasesDir, "n1.json"))).toBe(true);
    const stillInactive = JSON.parse(readFileSync(join(leasesDir, "n1.json"), "utf-8"));
    expect(stillInactive.active).toBe(false);

    unlinkSync(join(leasesDir, "n1.lock"));
    const second = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(second).not.toBeNull();
    expect(second!.active).toBe(true);

    cleanupRepo(repo);
  });

  it("breaks a stale lock whose recorded holder is provably dead, then succeeds", async () => {
    const repo = makeRepo();
    seedInactiveLease(repo, "n1", "c1");
    const leasesDir = join(repo, ".arbor", "leases");
    const pid = await deadPid();
    // Older than the ~10s staleness threshold.
    seedLock(leasesDir, "n1", { pid, created_at: new Date(Date.now() - 15_000).toISOString() });

    const manager = new WorktreeManager({ repoRoot: repo });
    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });

    expect(lease).not.toBeNull();
    expect(lease!.active).toBe(true);
    expect(existsSync(join(leasesDir, "n1.lock"))).toBe(false);

    cleanupRepo(repo);
  });

  it("does NOT break a lock that is old but whose holder is alive, nor one that is fresh but whose holder is dead", async () => {
    const repo = makeRepo();
    const leasesDir = join(repo, ".arbor", "leases");

    // Old + alive: must stay busy.
    seedInactiveLease(repo, "n1", "c1");
    seedLock(leasesDir, "n1", { pid: process.pid, created_at: new Date(Date.now() - 15_000).toISOString() });
    const manager = new WorktreeManager({ repoRoot: repo });
    expect(manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" })).toBeNull();
    expect(manager.lastAcquireFailure).toContain("busy");
    unlinkSync(join(leasesDir, "n1.lock"));

    // Fresh + dead: must stay busy (not old enough to break yet).
    seedInactiveLease(repo, "n2", "c1");
    const pid = await deadPid();
    seedLock(leasesDir, "n2", { pid, created_at: new Date().toISOString() });
    expect(manager.acquireLease({ campaign_id: "c1", node_id: "n2", specialist: "seed" })).toBeNull();
    expect(manager.lastAcquireFailure).toContain("busy");

    cleanupRepo(repo);
  });
});

describe("reconcileLeases — an in-flight claim is never mistaken for a stale lease", () => {
  function seedPendingClaim(repo: string, node_id: string, campaign_id: string, owner_pid: number): void {
    const leaseFile = join(repo, ".arbor", "leases", `${node_id}.json`);
    mkdirSync(join(repo, ".arbor", "leases"), { recursive: true });
    writeFileSync(leaseFile, JSON.stringify({
      node_id, campaign_id, branch: `arbor/${campaign_id}/${node_id}`, path: join(repo, ".worktrees", `${campaign_id}-${node_id}`),
      acquired_at: new Date().toISOString(), acquired_by: "", starting_commit: "", active: true,
      owner_pid, claim_token: "test-claim-token", claim_pending: true,
    }), "utf-8");
  }

  it("leaves a pending claim with a live owner untouched (not deactivated as stale)", () => {
    const repo = makeRepo();
    seedPendingClaim(repo, "n1", "c1", process.pid);

    const manager = new WorktreeManager({ repoRoot: repo });
    const result = manager.reconcileLeases();

    expect(result.outcomes).toContainEqual(expect.objectContaining({ node_id: "n1", status: "claim_pending" }));
    expect(result.outcomes.some((o) => o.node_id === "n1" && o.status === "stale")).toBe(false);
    const stillPending = JSON.parse(readFileSync(join(repo, ".arbor", "leases", "n1.json"), "utf-8"));
    expect(stillPending.active).toBe(true);

    cleanupRepo(repo);
  });

  it("deactivates a pending claim once its recorded owner is provably dead", async () => {
    const repo = makeRepo();
    const pid = await deadPid();
    seedPendingClaim(repo, "n1", "c1", pid);

    const manager = new WorktreeManager({ repoRoot: repo });
    const result = manager.reconcileLeases();

    expect(result.outcomes).toContainEqual(expect.objectContaining({ node_id: "n1", status: "stale" }));
    const deactivated = JSON.parse(readFileSync(join(repo, ".arbor", "leases", "n1.json"), "utf-8"));
    expect(deactivated.active).toBe(false);

    cleanupRepo(repo);
  });
});
