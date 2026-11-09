/**
 * ADR-012 `RecoveryLeaseAuthority` backed by real git worktrees (G-03).
 *
 * `RecoveryService` (`./recovery-service.js`) needs a lease authority that
 * proves old-lease disposition, acquires a fresh exclusive lease, and checks
 * isolation before a retry can be authorized. The only implementation of
 * that contract over the actual worktree/lease store lives in
 * `@arbor/opencode`'s `OpenCodeRecoveryLeaseAdapter`
 * (`packages/arbor-opencode/src/recovery-lease.ts`), already built and
 * tested against the real `WorktreeManager`
 * (`packages/arbor-opencode/src/worktree.ts`). It is structurally identical
 * to `RecoveryLeaseAuthority` — reimplementing the same lease bookkeeping
 * here would duplicate tested logic for no benefit, so this file composes
 * the existing adapter into what `@arbor/mcp`'s composition root
 * (`cli.ts`'s `createCliRuntime`) needs, keeping the one `@arbor/opencode`
 * value import isolated to this file. This mirrors the precedent already
 * set by `demo.ts`, which depends on `@arbor/opencode` at the CLI leaf
 * rather than inside the shared runtime core (see `runtime.ts`,
 * `loop-adapters.ts`, `loop-ports-helper.ts`, `agent-registry.ts` — all of
 * which deliberately stay opencode-free).
 */
import { OpenCodeRecoveryLeaseAdapter, WorktreeManager, type OpenCodeRecoveryLeaseOptions } from "@arbor/opencode";
import type { RecoveryLeaseAuthority } from "./recovery-service.js";

export interface WorktreeRecoveryLeaseOptions extends OpenCodeRecoveryLeaseOptions {
  /** Repo root whose git worktrees back the lease store. */
  repo_root: string;
  /** Directory holding the worktrees (default `.worktrees/` under repo_root). */
  worktrees_dir?: string;
  /** Directory holding lease files (default `<persistence_dir>/leases/`). */
  leases_dir?: string;
  /** Guarded persistence root campaign data is written into (default `<repo_root>/.arbor`). */
  persistence_dir?: string;
}

/** Compose a real, git-worktree-backed `RecoveryLeaseAuthority` for one repo root. */
export function createWorktreeRecoveryLeaseAuthority(options: WorktreeRecoveryLeaseOptions): RecoveryLeaseAuthority {
  const { repo_root, worktrees_dir, leases_dir, persistence_dir, ...leaseOptions } = options;
  const worktrees = new WorktreeManager({ repoRoot: repo_root, worktreesDir: worktrees_dir, leasesDir: leases_dir, persistenceDir: persistence_dir });
  return new OpenCodeRecoveryLeaseAdapter(worktrees, leaseOptions);
}
