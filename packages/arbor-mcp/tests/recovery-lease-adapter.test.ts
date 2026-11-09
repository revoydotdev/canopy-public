import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "@arbor/opencode";
import { createWorktreeRecoveryLeaseAuthority } from "../src/recovery-lease-adapter.js";

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
}

describe("createWorktreeRecoveryLeaseAuthority (G-03)", () => {
  it("wraps a real git-backed WorktreeManager: resolves no old lease, acquires a fresh one, and proves isolation", () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-recovery-lease-"));
    try {
      initRepo(repo);
      const authority = createWorktreeRecoveryLeaseAuthority({ repo_root: repo });

      expect(authority.resolveOldLease({ campaign_id: "campaign", node_id: "node", prior_operation_id: "prior-op" })).toBe("inactive");

      const acquired = authority.acquireFresh({ campaign_id: "campaign", node_id: "node", operation_id: "recover-op" });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;

      const isolation = authority.checkIsolation({ campaign_id: "campaign", node_id: "node", operation_id: "recover-op", lease_id: acquired.lease_id });
      expect(isolation).toEqual({ worktree_isolated: true, starting_commit_correct: true });

      // A real git worktree now exists at .worktrees/campaign-node.
      const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf-8" });
      expect(worktrees).toContain(join(repo, ".worktrees", "campaign-node"));

      authority.releaseFresh(acquired.lease_id, "test cleanup");
      const worktreesAfterRelease = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf-8" });
      expect(worktreesAfterRelease).not.toContain(join(repo, ".worktrees", "campaign-node"));
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("scopes the worktree/lease directories under repo_root and honours overrides", () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-recovery-lease-scoped-"));
    try {
      initRepo(repo);
      const authority = createWorktreeRecoveryLeaseAuthority({ repo_root: repo, worktrees_dir: join(repo, "custom-worktrees"), leases_dir: join(repo, "custom-leases") });
      const acquired = authority.acquireFresh({ campaign_id: "campaign", node_id: "node", operation_id: "op-1" });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf-8" });
      expect(worktrees).toContain(join(repo, "custom-worktrees", "campaign-node"));
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("blocks an ambiguous legacy lease instead of inferring ownership", () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-recovery-lease-legacy-"));
    try {
      initRepo(repo);
      // A pre-ADR-012 lease (no operation_id/lease_id/expires_at) at the same
      // canonical path the authority would use — this is what a lease taken
      // out before the recovery machinery existed looks like on disk.
      const lease = new WorktreeManager({ repoRoot: repo }).acquireLease({ campaign_id: "campaign", node_id: "node", specialist: "seed" });
      if (lease === null) throw new Error("fixture lease was not acquired");
      const { owner_pid: _owner, ...legacyLease } = lease;
      writeFileSync(join(repo, ".arbor", "leases", "node.json"), JSON.stringify(legacyLease, null, 2));
      const authority = createWorktreeRecoveryLeaseAuthority({ repo_root: repo });
      expect(authority.resolveOldLease({ campaign_id: "campaign", node_id: "node", prior_operation_id: "prior-op" })).toBe("ambiguous");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("fences a provably dead owner and preserves its isolated worktree during takeover", () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-recovery-lease-dead-owner-"));
    try {
      initRepo(repo);
      const worktrees = new WorktreeManager({ repoRoot: repo });
      const old = worktrees.acquireLease({ campaign_id: "campaign", node_id: "node", specialist: "seed" });
      expect(old).not.toBeNull();
      const authority = createWorktreeRecoveryLeaseAuthority({ repo_root: repo, process_alive: () => false });
      expect(authority.resolveOldLease({ campaign_id: "campaign", node_id: "node", prior_operation_id: "crash-op" })).toBe("released");
      const acquired = authority.acquireFresh({ campaign_id: "campaign", node_id: "node", operation_id: "recover-op" });
      expect(acquired).toEqual({ ok: true, lease_id: "recovery:recover-op" });
      expect(worktrees.readLease("node")).toMatchObject({ path: old?.path, operation_id: "recover-op", lease_id: "recovery:recover-op", acquired_by: "recovery", active: true });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("keeps a lease fenced while its recorded owner is live", () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-recovery-lease-live-owner-"));
    try {
      initRepo(repo);
      new WorktreeManager({ repoRoot: repo }).acquireLease({ campaign_id: "campaign", node_id: "node", specialist: "seed" });
      const authority = createWorktreeRecoveryLeaseAuthority({ repo_root: repo, process_alive: () => true });
      expect(authority.resolveOldLease({ campaign_id: "campaign", node_id: "node", prior_operation_id: "crash-op" })).toBe("active");
      expect(authority.acquireFresh({ campaign_id: "campaign", node_id: "node", operation_id: "recover-op" })).toEqual({ ok: false, detail: "unable to acquire a fresh exclusive worktree lease" });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("fails a fresh acquisition when the node's current lease is still held", () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-recovery-lease-held-"));
    try {
      initRepo(repo);
      new WorktreeManager({ repoRoot: repo }).acquireLease({ campaign_id: "campaign", node_id: "node", specialist: "seed" });
      const authority = createWorktreeRecoveryLeaseAuthority({ repo_root: repo });
      const acquired = authority.acquireFresh({ campaign_id: "campaign", node_id: "node", operation_id: "op-1" });
      expect(acquired).toEqual({ ok: false, detail: "unable to acquire a fresh exclusive worktree lease" });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("fails isolation once the fresh lease's lease_duration_ms has elapsed on the injected clock", () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-recovery-lease-expiry-"));
    try {
      initRepo(repo);
      let now = new Date("2026-08-01T00:00:00.000Z");
      const authority = createWorktreeRecoveryLeaseAuthority({ repo_root: repo, clock: () => now, lease_duration_ms: 1000 });
      const acquired = authority.acquireFresh({ campaign_id: "campaign", node_id: "node", operation_id: "op-1" });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      expect(authority.checkIsolation({ campaign_id: "campaign", node_id: "node", operation_id: "op-1", lease_id: acquired.lease_id }).worktree_isolated).toBe(true);
      now = new Date(now.getTime() + 2000);
      expect(authority.checkIsolation({ campaign_id: "campaign", node_id: "node", operation_id: "op-1", lease_id: acquired.lease_id })).toEqual({ worktree_isolated: false, starting_commit_correct: false });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
