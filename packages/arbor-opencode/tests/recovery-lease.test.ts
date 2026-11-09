import { describe, expect, it } from "vitest";
import { OpenCodeRecoveryLeaseAdapter } from "@arbor/campaign-support";
import { WorktreeManager } from "@arbor/campaign-support";

const now = () => new Date("2026-08-01T12:00:00.000Z");

describe("OpenCodeRecoveryLeaseAdapter", () => {
  it("blocks an ambiguous legacy lease instead of inferring ownership", () => {
    const worktrees = new WorktreeManager({}, true);
    const legacy = worktrees.acquireLease({ campaign_id: "campaign", node_id: "node", specialist: "seed" });
    if (legacy === null) throw new Error("fixture lease was not acquired");
    delete legacy.owner_pid;
    const adapter = new OpenCodeRecoveryLeaseAdapter(worktrees, { clock: now });
    expect(adapter.resolveOldLease({ campaign_id: "campaign", node_id: "node", prior_operation_id: "old-op" })).toBe("ambiguous");
  });

  it("acquires a fresh operation-scoped lease and proves isolation from its exact identity", () => {
    const worktrees = new WorktreeManager({}, true);
    const adapter = new OpenCodeRecoveryLeaseAdapter(worktrees, { clock: now, lease_duration_ms: 60_000 });
    expect(adapter.resolveOldLease({ campaign_id: "campaign", node_id: "node", prior_operation_id: "old-op" })).toBe("inactive");
    const first = adapter.acquireFresh({ campaign_id: "campaign", node_id: "node", operation_id: "new-op" });
    expect(first).toEqual({ ok: true, lease_id: "recovery:new-op" });
    if (!first.ok) throw new Error("expected fresh lease");
    expect(worktrees.readLease("node")).toMatchObject({ operation_id: "new-op", lease_id: first.lease_id, expires_at: "2026-08-01T12:01:00.000Z" });
    expect(adapter.checkIsolation({ campaign_id: "campaign", node_id: "node", operation_id: "new-op", lease_id: first.lease_id })).toEqual({ worktree_isolated: true, starting_commit_correct: true });
    expect(adapter.checkIsolation({ campaign_id: "campaign", node_id: "node", operation_id: "wrong-op", lease_id: first.lease_id })).toEqual({ worktree_isolated: false, starting_commit_correct: false });
  });

  it("releases a fresh lease on a failed isolation path and gives the next operation a different identity", () => {
    const worktrees = new WorktreeManager({}, true);
    const adapter = new OpenCodeRecoveryLeaseAdapter(worktrees, { clock: now });
    const first = adapter.acquireFresh({ campaign_id: "campaign", node_id: "node", operation_id: "attempt-1" });
    if (!first.ok) throw new Error("expected first lease");
    // A caller that sees a false isolation proof must execute this cleanup.
    expect(adapter.checkIsolation({ campaign_id: "campaign", node_id: "node", operation_id: "wrong", lease_id: first.lease_id }).worktree_isolated).toBe(false);
    adapter.releaseFresh(first.lease_id, "fresh isolation check failed");
    expect(worktrees.isHeld("node")).toBe(false);
    const second = adapter.acquireFresh({ campaign_id: "campaign", node_id: "node", operation_id: "attempt-2" });
    expect(second).toEqual({ ok: true, lease_id: "recovery:attempt-2" });
    expect(second).not.toEqual(first);
  });

  it("uses non-destructive reconciliation at startup", () => {
    const worktrees = new WorktreeManager({}, true);
    worktrees.acquireLease({ campaign_id: "campaign", node_id: "node", specialist: "seed" });
    const adapter = new OpenCodeRecoveryLeaseAdapter(worktrees, { clock: now });
    const reconciliation = adapter.reconcileStartup();
    expect(reconciliation.live).toHaveLength(1);
    expect(worktrees.isHeld("node")).toBe(true);
  });
});

describe("OpenCodeRecoveryLeaseAdapter — owner identity (item 4, PID-reuse hardening)", () => {
  it("treats a legacy lease (no recorded identity) as active on a merely-alive PID, unchanged from PID-only behaviour", () => {
    const worktrees = new WorktreeManager({}, true);
    const lease = worktrees.acquireLease({ campaign_id: "campaign", node_id: "node", specialist: "seed" });
    if (lease === null) throw new Error("fixture lease was not acquired");
    delete lease.owner_start_ticks;
    delete lease.owner_boot_id;
    const adapter = new OpenCodeRecoveryLeaseAdapter(worktrees, {
      clock: now,
      process_alive: () => true,
      process_identity: () => { throw new Error("must not be consulted when the lease recorded no identity"); },
    });
    expect(adapter.resolveOldLease({ campaign_id: "campaign", node_id: "node", prior_operation_id: "crash-op" })).toBe("active");
  });

  it("fences a lease whose PID is alive but whose recorded start time no longer matches (PID reused after a crash)", () => {
    const worktrees = new WorktreeManager({}, true);
    const lease = worktrees.acquireLease({ campaign_id: "campaign", node_id: "node", specialist: "seed" });
    if (lease === null) throw new Error("fixture lease was not acquired");
    lease.owner_start_ticks = "111111";
    lease.owner_boot_id = "boot-a";
    const adapter = new OpenCodeRecoveryLeaseAdapter(worktrees, {
      clock: now,
      process_alive: () => true, // the pid exists...
      process_identity: () => ({ start_ticks: "222222", boot_id: "boot-a" }), // ...but it's a different process now
    });
    expect(adapter.resolveOldLease({ campaign_id: "campaign", node_id: "node", prior_operation_id: "crash-op" })).toBe("released");
  });

  it("fences a lease whose boot id no longer matches (host rebooted since acquisition)", () => {
    const worktrees = new WorktreeManager({}, true);
    const lease = worktrees.acquireLease({ campaign_id: "campaign", node_id: "node", specialist: "seed" });
    if (lease === null) throw new Error("fixture lease was not acquired");
    lease.owner_start_ticks = "111111";
    lease.owner_boot_id = "boot-a";
    const adapter = new OpenCodeRecoveryLeaseAdapter(worktrees, {
      clock: now,
      process_alive: () => true,
      process_identity: () => ({ start_ticks: "111111", boot_id: "boot-b" }), // same ticks, but a different boot
    });
    expect(adapter.resolveOldLease({ campaign_id: "campaign", node_id: "node", prior_operation_id: "crash-op" })).toBe("released");
  });

  it("keeps a lease active when the recorded identity matches exactly", () => {
    const worktrees = new WorktreeManager({}, true);
    const lease = worktrees.acquireLease({ campaign_id: "campaign", node_id: "node", specialist: "seed" });
    if (lease === null) throw new Error("fixture lease was not acquired");
    lease.owner_start_ticks = "111111";
    lease.owner_boot_id = "boot-a";
    const adapter = new OpenCodeRecoveryLeaseAdapter(worktrees, {
      clock: now,
      process_alive: () => true,
      process_identity: () => ({ start_ticks: "111111", boot_id: "boot-a" }),
    });
    expect(adapter.resolveOldLease({ campaign_id: "campaign", node_id: "node", prior_operation_id: "crash-op" })).toBe("active");
  });

  it("fails safe: keeps a lease active when identity was recorded but /proc is unreadable now (never reports a live owner as dead)", () => {
    const worktrees = new WorktreeManager({}, true);
    const lease = worktrees.acquireLease({ campaign_id: "campaign", node_id: "node", specialist: "seed" });
    if (lease === null) throw new Error("fixture lease was not acquired");
    lease.owner_start_ticks = "111111";
    lease.owner_boot_id = "boot-a";
    const adapter = new OpenCodeRecoveryLeaseAdapter(worktrees, {
      clock: now,
      process_alive: () => true,
      process_identity: () => null, // e.g. non-Linux, or a transient read failure
    });
    expect(adapter.resolveOldLease({ campaign_id: "campaign", node_id: "node", prior_operation_id: "crash-op" })).toBe("active");
  });

  it("dead PID is still dead regardless of identity fields", () => {
    const worktrees = new WorktreeManager({}, true);
    const lease = worktrees.acquireLease({ campaign_id: "campaign", node_id: "node", specialist: "seed" });
    if (lease === null) throw new Error("fixture lease was not acquired");
    lease.owner_start_ticks = "111111";
    lease.owner_boot_id = "boot-a";
    const adapter = new OpenCodeRecoveryLeaseAdapter(worktrees, {
      clock: now,
      process_alive: () => false,
      process_identity: () => { throw new Error("must not be consulted once the pid itself is confirmed dead"); },
    });
    expect(adapter.resolveOldLease({ campaign_id: "campaign", node_id: "node", prior_operation_id: "crash-op" })).toBe("released");
  });

  it("real WorktreeManager (non-dry-run) records owner_start_ticks/owner_boot_id on acquire using the real /proc reader", () => {
    const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const repo = mkdtempSync(join(tmpdir(), "arbor-wt-identity-"));
    spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"], { stdio: "ignore" });

    const manager = new WorktreeManager({ repoRoot: repo });
    const lease = manager.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(lease).not.toBeNull();
    if (process.platform === "linux") {
      expect(lease!.owner_start_ticks).toMatch(/^\d+$/);
      expect(lease!.owner_boot_id).toBeTruthy();
    }
    manager.releaseLease("n1");
    rmSync(repo, { recursive: true, force: true });
  });
});
