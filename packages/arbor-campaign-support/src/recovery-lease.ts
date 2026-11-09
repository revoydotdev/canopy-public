import type { LeaseReconciliationResult, WorktreeLease } from "./worktree.js";
import { readProcessIdentity, isProcessAlive, identityStillMatches, type ProcessIdentity } from "./process-identity.js";

/** Structural equivalent of arbor-mcp's RecoveryLeaseAuthority; no mcp import. */
export interface RecoveryLeaseManagerPort {
  reconcileLeases(): LeaseReconciliationResult;
  readLease(nodeId: string): WorktreeLease | null;
  acquireLease(input: { campaign_id: string; node_id: string; specialist: string; operation_id?: string; lease_id?: string; expires_at?: string }): WorktreeLease | null;
  takeoverLease(input: { campaign_id: string; node_id: string; expected_acquired_at: string; specialist: string; operation_id: string; lease_id: string; expires_at: string }): WorktreeLease | null;
  releaseLease(nodeId: string, expected?: { operation_id: string; lease_id: string }): boolean;
}

export interface OpenCodeRecoveryLeaseOptions {
  clock?: () => Date;
  lease_duration_ms?: number;
  /** Injectable only for deterministic tests; production checks the recorded owner PID. */
  process_alive?: (pid: number) => boolean;
  /**
   * Injectable only for deterministic tests; production reads the real
   * `/proc` identity (start time + boot id) of a live PID, used to detect
   * PID reuse after a crash. See ADR-012 and `process-identity.ts`.
   */
  process_identity?: (pid: number) => ProcessIdentity | null;
}

/**
 * ADR-012 bridge from recovery to OpenCode worktree leases. It matches the MCP
 * port structurally, avoiding an OpenCode→MCP dependency. Startup reconciliation
 * only delegates to WorktreeManager's non-destructive inspection.
 */
export class OpenCodeRecoveryLeaseAdapter {
  private readonly fresh = new Map<string, { readonly node_id: string; readonly operation_id: string }>;
  private readonly clock: () => Date;
  private readonly durationMs: number;
  private readonly processAlive: (pid: number) => boolean;
  private readonly processIdentity: (pid: number) => ProcessIdentity | null;
  private readonly reclaimable = new Map<string, { readonly campaign_id: string; readonly acquired_at: string }>();

  // No default here on purpose: a bare `new WorktreeManager()` fallback
  // resolves repoRoot from process.cwd(), silently scoping every real git
  // worktree/branch operation to whatever directory the process happens to
  // be launched from. Every current caller already supplies an explicitly
  // repoRoot-scoped port (recovery-lease-adapter.ts, the test suite); a
  // missing port here should fail loudly, not pick a repo by accident.
  constructor(private readonly worktrees: RecoveryLeaseManagerPort, options: OpenCodeRecoveryLeaseOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.durationMs = options.lease_duration_ms ?? 15 * 60 * 1000;
    this.processAlive = options.process_alive ?? isProcessAlive;
    this.processIdentity = options.process_identity ?? readProcessIdentity;
    if (!Number.isSafeInteger(this.durationMs) || this.durationMs < 1) throw new Error("lease_duration_ms must be a positive safe integer");
  }

  /**
   * Whether `lease`'s recorded owner PID is plausibly still the process that
   * acquired it. PID existence alone (`processAlive`) cannot rule out reuse:
   * after a crash and reboot (or a long-running host's PID counter
   * wrapping), an unrelated process can be assigned the exact same PID and
   * would otherwise look like a live owner forever, wedging recovery. When
   * the lease recorded a start-time/boot-id identity AND both are readable
   * right now, a different boot id proves the machine rebooted since
   * acquisition (the old owner cannot possibly still be running), and a
   * matching PID with a different start time proves the PID was reused by a
   * different process. Absent identity (legacy records) or an unreadable
   * `/proc` (non-Linux, or transient read failure) falls back to the
   * PID-only check — fail safe, so this never reports a genuinely live
   * owner as dead.
   */
  private ownerAppearsLive(lease: WorktreeLease): boolean {
    const pid = lease.owner_pid;
    if (pid === undefined) return true; // caller handles the undefined-pid case separately
    return identityStillMatches(pid, { start_ticks: lease.owner_start_ticks, boot_id: lease.owner_boot_id }, { processAlive: this.processAlive, processIdentity: this.processIdentity });
  }

  reconcileStartup(): LeaseReconciliationResult { return this.worktrees.reconcileLeases(); }

  resolveOldLease(input: { campaign_id: string; node_id: string; prior_operation_id: string }): "inactive" | "released" | "active" | "ambiguous" {
    const reconciliation = this.reconcileStartup();
    if (reconciliation.outcomes.some((outcome) => outcome.status === "unavailable" || (outcome.node_id === input.node_id && (outcome.status === "malformed" || outcome.status === "unrelated")))) return "ambiguous";
    const lease = this.worktrees.readLease(input.node_id);
    if (!lease || !lease.active) return "inactive";
    if (lease.campaign_id !== input.campaign_id) return "ambiguous";
    // A slot-claim record mid-`acquireLease` (see `worktree.ts`'s
    // `claimLeaseSlot`) is structurally "active" with no operation_id, so it
    // would otherwise fall straight into the owner-liveness branch below and
    // — if judged dead — get treated as a reclaimable RELEASED lease. That
    // would hand a claim's half-initialized record (empty starting_commit,
    // possibly no worktree on disk yet) to `takeoverLease`. A pending claim
    // is never a reclaimable released lease: the manager's own claim/lock
    // machinery is the only thing allowed to resolve it (finalize it, or
    // have `reconcileLeases` deactivate it once its owner is provably dead).
    // Report "ambiguous" here regardless of owner liveness so recovery
    // cannot short-circuit that machinery.
    if ((lease as WorktreeLease & { claim_token?: unknown }).claim_token !== undefined) return "ambiguous";
    if (lease.operation_id !== input.prior_operation_id || !lease.lease_id || !lease.expires_at) {
      if (lease.owner_pid === undefined) return "ambiguous";
      if (this.ownerAppearsLive(lease)) return "active";
      this.reclaimable.set(input.node_id, { campaign_id: input.campaign_id, acquired_at: lease.acquired_at });
      return "released";
    }
    // An unexpired record could represent a live worker. Expiry does not prove
    // safety either: an operator must resolve/release it explicitly.
    return Date.parse(lease.expires_at) > this.clock().getTime() ? "active" : "ambiguous";
  }

  acquireFresh(input: { campaign_id: string; node_id: string; operation_id: string }): { ok: true; lease_id: string } | { ok: false; detail: string } {
    const leaseId = `recovery:${input.operation_id}`;
    const expiresAt = new Date(this.clock().getTime() + this.durationMs).toISOString();
    const reclaimable = this.reclaimable.get(input.node_id);
    const lease = reclaimable?.campaign_id === input.campaign_id
      ? this.worktrees.takeoverLease({ campaign_id: input.campaign_id, node_id: input.node_id, expected_acquired_at: reclaimable.acquired_at, specialist: "recovery", operation_id: input.operation_id, lease_id: leaseId, expires_at: expiresAt })
      : this.worktrees.acquireLease({ campaign_id: input.campaign_id, node_id: input.node_id, specialist: "recovery", operation_id: input.operation_id, lease_id: leaseId, expires_at: expiresAt });
    this.reclaimable.delete(input.node_id);
    if (!lease) return { ok: false, detail: "unable to acquire a fresh exclusive worktree lease" };
    this.fresh.set(leaseId, { node_id: input.node_id, operation_id: input.operation_id });
    return { ok: true, lease_id: leaseId };
  }

  checkIsolation(input: { campaign_id: string; node_id: string; operation_id: string; lease_id: string }): { worktree_isolated: boolean; starting_commit_correct: boolean } {
    const lease = this.worktrees.readLease(input.node_id);
    const matches = lease?.active === true && lease.campaign_id === input.campaign_id && lease.node_id === input.node_id
      && lease.operation_id === input.operation_id && lease.lease_id === input.lease_id
      && this.fresh.get(input.lease_id)?.node_id === input.node_id
      && this.fresh.get(input.lease_id)?.operation_id === input.operation_id
      && lease.expires_at !== undefined && Date.parse(lease.expires_at) > this.clock().getTime();
    return { worktree_isolated: matches, starting_commit_correct: matches && lease !== undefined && lease.starting_commit.trim().length > 0 };
  }

  releaseFresh(leaseId: string, _reason: string): void {
    const ownership = this.fresh.get(leaseId);
    if (ownership === undefined) return;
    // `releaseLease` can fail transiently when the worktree slot lock is
    // contended. Keep the exact fenced handle in `fresh` so the caller can
    // retry this cleanup. Deleting it on a false result would make the lease
    // impossible to release through this adapter; the manager's operation +
    // lease id fencing keeps a later retry from releasing a replacement.
    if (!this.worktrees.releaseLease(ownership.node_id, { operation_id: ownership.operation_id, lease_id: leaseId })) {
      throw new Error(`unable to release recovery lease ${leaseId}; ownership retained for retry`);
    }
    this.fresh.delete(leaseId);
  }
}
