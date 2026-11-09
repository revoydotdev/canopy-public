/**
 * arbor-opencode/worktree — git worktree + lease management for isolated Seeds.
 *
 * Per ADR-001 (isolation): every Seed runs in its own git worktree with an
 * exclusive lease. The lease store lives in `.arbor/leases/` so it survives
 * process restarts (Phase 1.3 directory layout) and prevents two specialists
 * from colliding on the same worktree.
 *
 * This module is intentionally thin and dependency-free: it shells out to `git`
 * for worktree creation and reads/writes JSON lease files. The loop controller
 * (`loop.ts`) is what sequences these calls.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, realpathSync, unlinkSync,
  openSync, closeSync, writeSync, fsyncSync, renameSync, linkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rankByFrecency, resolvePersistenceDir } from "@arbor/core";
import { provisionWorktreeDependencies, type DependencyProvisioningOptions, type DependencyProvisioningOutcome } from "./dependency-provisioning.js";
import { readProcessIdentity, isProcessAlive, identityStillMatches } from "./process-identity.js";
import { checkIntegration, type IntegrationClassification } from "./integration-check.js";
import { preserveWork, computeWorkingTreeSnapshotId } from "./preservation.js";

/**
 * Env vars that redirect git's repo/work-tree discovery away from `-C`/`cwd`.
 * A leaked `GIT_DIR`/`GIT_WORK_TREE` inherited from a parent process (a shell
 * export, another tool's subprocess spawner) silently overrides every
 * `cwd`-scoped git call below, so every worktree operation strips them from
 * the child's env explicitly rather than trusting the ambient process.env.
 * This is what makes "isolated worktree" actually isolated in an environment
 * that runs many concurrent git-shelling processes against the same checkout.
 */
export const GIT_SCOPE_ENV_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"] as const;

export function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_SCOPE_ENV_VARS) delete env[key];
  return env;
}

/**
 * Per-slot mutex tuning (`<leasesDir>/<node_id>.lock`, guarding every
 * mutation of an OCCUPIED lease slot — see `claimLeaseSlot`'s class doc).
 * Contention is expected to resolve in single-digit milliseconds (these are
 * small synchronous file ops, never git/provisioning work), so the bounded
 * wait is generous relative to real contention and short relative to a
 * caller's patience.
 */
const SLOT_LOCK_WAIT_STEP_MS = 20;
const SLOT_LOCK_WAIT_TOTAL_MS = 2_000;
/** A lock older than this AND whose recorded holder is provably dead may be broken. */
const SLOT_LOCK_STALE_MS = 10_000;

/** Synchronously block the thread for `ms`. Used only for the slot lock's bounded wait. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

/** Lease record for one node's worktree. */
export interface WorktreeLease {
  node_id: string;
  campaign_id: string;
  branch: string;
  path: string;
  acquired_at: string;
  acquired_by: string; // specialist agent name
  starting_commit: string;
  active: boolean;
  /** Process that acquired the lease. A live or unverifiable owner fences recovery takeover. */
  owner_pid?: number;
  /**
   * `owner_pid`'s process identity at acquisition time (start time in clock
   * ticks since boot, plus the boot id) — see `process-identity.ts`. Present
   * together or not at all; absent on legacy records, which fall back to a
   * PID-only liveness check (see `recovery-lease.ts`'s `ownerAppearsLive`).
   * Lets a dead-owner check survive PID reuse after a crash/reboot instead
   * of mistaking an unrelated process that inherited the same PID for the
   * original lease owner.
   */
  owner_start_ticks?: string;
  owner_boot_id?: string;
  /** ADR-012 fields; absent records are legacy and cannot prove recovery ownership. */
  operation_id?: string;
  lease_id?: string;
  expires_at?: string;
}

/**
 * The shape `claimLeaseSlot` writes into a lease slot before any git/
 * filesystem work: a `WorktreeLease` with `active: true` (so a racing
 * claimant's own read sees it as occupied) but `starting_commit`/
 * `acquired_by` still empty, plus `claim_token`/`claim_pending` marking it
 * as in-flight rather than a finalized lease. `claim_token` alone (present
 * only on this shape, never on a finalized lease) is what every reader in
 * this file and `recovery-lease.ts` uses to recognize a pending claim.
 */
type PendingClaim = WorktreeLease & { claim_token: string; claim_pending: true };

function pendingClaimToken(value: WorktreeLease | null | undefined): string | undefined {
  if (!value) return undefined;
  const token = (value as WorktreeLease & { claim_token?: unknown }).claim_token;
  return typeof token === "string" ? token : undefined;
}

/** A non-destructive result from inspecting persisted leases at startup. */
export interface LeaseReconciliationOutcome {
  /** The lease file name, when this outcome originated from a lease. */
  lease_file?: string;
  node_id?: string;
  campaign_id?: string;
  path: string;
  /**
   * `stale` leases are deactivated, never removed. `reclaimed` and
   * `reclaim_failed` are the ONLY destructive outcomes, and they appear only
   * when the caller explicitly opts into sweeping. Every other outcome is
   * diagnostic-only. `claim_pending` is an `acquireLease` slot claim
   * (`claimLeaseSlot`) caught mid-flight — no registered worktree yet, but
   * its recorded owner is provably alive, so it is left untouched rather
   * than being deactivated as `stale` (which would falsely open the slot to
   * a second claimant while the first is still doing its git/dependency
   * work). A pending claim whose owner is provably dead IS deactivated, as
   * `stale`, same as any other lease with no live owner.
   */
  status:
    | "live"
    | "stale"
    | "malformed"
    | "unrelated"
    | "orphaned_worktree"
    | "reclaimed"
    | "reclaim_failed"
    | "unavailable"
    | "claim_pending"
    /**
     * Additive (data-safety hardening): the orphan held un-integrated work
     * (dirty and/or unmerged commits per `integration-check.ts`), so it was
     * preserved under `.arbor/preserved/` before the worktree/branch were
     * removed. `detail` names the manifest path.
     */
    | "reclaimed_after_preservation"
    /**
     * Additive: the orphan held un-integrated work but preservation itself
     * failed, so — per the data-safety principle a failed release that
     * keeps data beats a "successful" one that destroys it — NOTHING was
     * removed. The worktree and its branch are left exactly as found.
     */
    | "reclaim_retained_preservation_failed";
  detail: string;
}

/** The rung/classification recorded on a release outcome that involved an integration check, for audit. */
export type ReleaseIntegrationRung = IntegrationClassification;

/**
 * Structured, readable result of the most recent `releaseLease` call — like
 * `lastAcquireFailure`, but always populated (never merely a boolean),
 * because "released" now has more than one honest meaning: a lease that was
 * never held, a clean worktree removed outright, un-integrated work that was
 * preserved and then removed, or un-integrated work that could not be safely
 * preserved and so was retained untouched.
 */
export type ReleaseOutcome =
  | { status: "not_held" }
  | { status: "removed_integrated"; rung: ReleaseIntegrationRung }
  | { status: "removed_after_preservation"; manifest_path: string; rung: ReleaseIntegrationRung }
  | { status: "retained_preservation_failed"; reason: string }
  | { status: "retained_raced"; reason: string };

/**
 * Internal result of `decideAndPreserve`: whether it is safe to destroy the
 * inspected path, distinct from `ReleaseOutcome` because it never performs
 * (or reports) the actual removal — that stays each caller's own job, since
 * `releaseLease` and the orphan sweep verify/perform it differently.
 */
type PreserveDecision =
  | { safe: true; rung: ReleaseIntegrationRung }
  | { safe: true; rung: ReleaseIntegrationRung; manifest_path: string }
  | { safe: false; raced: boolean; reason: string };

export interface LeaseReconciliationResult {
  outcomes: LeaseReconciliationOutcome[];
  /** Active, manager-owned leases confirmed by git after reconciliation. */
  live: WorktreeLease[];
}

/** How long an orphan must have been continuously observed before it may be swept. */
export const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

export interface LeaseReconciliationOptions {
  /**
   * Opt in to reclaiming orphaned managed worktrees. Defaults to false, so
   * reconciliation stays non-destructive for every caller that does not ask
   * (notably `OpenCodeRecoveryLeaseAdapter.reconcileStartup`, whose contract
   * is inspection only).
   */
  sweep?: boolean;
  /** Grace period for the second-observation rule. Defaults to one hour. */
  orphanGraceMs?: number;
  /** Injectable clock; defaults to now. */
  now?: Date;
}

/**
 * Ceiling for a single git subprocess. Generous relative to real git work in
 * this repository (a local worktree add measures in fractions of a second),
 * because the purpose is to break a wedged process, not to police slowness.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export interface WorktreeManagerOptions {
  /** Repo root. Defaults to the cwd. */
  repoRoot?: string;
  /**
   * Per-invocation ceiling for every git subprocess this manager spawns.
   * Default {@link DEFAULT_GIT_TIMEOUT_MS}.
   *
   * These calls are SYNCHRONOUS (`spawnSync`), so an unbounded one does not
   * merely leave a promise pending — it blocks the single JS thread and stops
   * every other timer in the process from firing at all. A one-hour capture
   * once recorded a single `loop.specialist_dispatched` and then nothing:
   * every async budget in the dispatch path was correct and none of them ran,
   * because `acquireLease` runs synchronously before dispatch is logged and a
   * git process under lock contention never returned. `dependency-provisioning.ts`
   * in this same package already bounded its own `spawnSync`; this is the same
   * discipline applied to the git helpers.
   */
  gitTimeoutMs?: number;
  /** Directory holding the worktrees (default `.worktrees/` at repo root). */
  worktreesDir?: string;
  /** Directory holding lease files (default `<persistenceDir>/leases/`). */
  leasesDir?: string;
  /**
   * The guarded persistence root campaign data is written into (default
   * `<repoRoot>/.arbor`). Leases, orphan marks, the object cache and preserved
   * trees are all built from this and never from `repoRoot`, so a configured
   * `ARBOR_PERSISTENCE_DIR` receives them. A root outside the repository is
   * refused by the same guard the CLI uses.
   */
  persistenceDir?: string;
  /**
   * Where first-observation marks for orphaned worktrees are persisted
   * (default `.arbor/orphan-marks.json` at repo root). Deliberately NOT
   * inside `leasesDir`: reconciliation parses every `*.json` there as a lease
   * and would report this file as malformed.
   */
  orphanMarksFile?: string;
  /**
   * In-repository runtime state that is owned by Revoy rather than by the
   * product checkout (for example an explicitly configured persistence
   * directory). Only exact descendants are ignored by the clean-HEAD
   * isolation check; the repository root is never accepted here.
   */
  operationalPaths?: readonly string[];
  /**
   * A fresh `git worktree add` has no installed dependencies, so any
   * verification command run inside it dies on missing `node_modules`
   * unless something installs them first. Configurable/opt-outable per
   * manager (default: enabled, ecosystem auto-detected from the worktree's
   * own lockfile — see `dependency-provisioning.ts`); pass
   * `{ enabled: false }` for a caller that provisions dependencies itself
   * (e.g. via a shared cache) or never needs to run anything inside the
   * lease.
   */
  dependencyProvisioning?: DependencyProvisioningOptions;
  /**
   * TEST-ONLY. Invoked from `decideAndPreserve` immediately after a
   * preservation snapshot is captured, before the TOCTOU re-check that
   * decides whether it is safe to remove the worktree. Exists solely
   * because there is no other way to deterministically land a write inside
   * that synchronous window from a test — no production caller has a
   * legitimate reason to set this, and it is never read outside that one
   * call site.
   */
  _testOnly_afterPreserveHook?: (worktreePath: string, attempt: number) => void;
}

/**
 * Manages git worktrees and their exclusive leases. Each call is safe to run
 * with a real repo OR in dry-run mode (for tests). When `dryRun` is true, no
 * git commands or filesystem writes occur — leases are tracked in memory.
 */
export class WorktreeManager {
  private repoRoot: string;
  private worktreesDir: string;
  private leasesDir: string;
  private orphanMarksFile: string;
  /** Guarded persistence root every campaign-data path is built from. */
  private persistenceDir: string;
  /**
   * Commit-scoped shared object stores (one bare repo per immutable admitted
   * commit), fetched from `repoRoot` at most once across campaigns. Every
   * node's detached object database references a store here via git
   * alternates instead of re-fetching the full ancestor set from `repoRoot`
   * on every node — see `detachObjectDatabase`.
   */
  private objectCacheDir: string;
  private ignoredDirtyRoots: string[];
  private dryRun: boolean;
  private acquireFailure: string | null = null;
  /** Outcome of the most recent `releaseLease` call. `null` only before any call has ever been made on this manager instance. */
  private releaseOutcome: ReleaseOutcome | null = null;
  private dependencyProvisioning: DependencyProvisioningOptions;
  /** Outcome of the most recent lease's dependency install, so a caller can inspect it without it living on the persisted lease record. */
  private lastProvisioning: DependencyProvisioningOutcome | null = null;
  /** In-memory lease map for dry-run mode. */
  private memoryLeases: Map<string, WorktreeLease> = new Map();
  /** TEST-ONLY. See `WorktreeManagerOptions._testOnly_afterPreserveHook`. */
  private readonly testOnlyAfterPreserveHook: ((worktreePath: string, attempt: number) => void) | undefined;

  private readonly gitTimeoutMs: number;
  private readonly asyncWorkerOptions: WorktreeManagerOptions;

  constructor(options: WorktreeManagerOptions = {}, dryRun = false) {
    const requestedRoot = resolve(options.repoRoot ?? process.cwd());
    // Git records worktrees by their canonical filesystem path. Keeping a
    // symlinked repo root here gives the same checkout two path identities:
    // `git -C` discovers the canonical main worktree, while the paths passed
    // to `git worktree add` live under the alias. Canonicalize an existing
    // root once so leases, worktrees, and Git's registration agree.
    const root = realpathSync.native(requestedRoot);
    this.repoRoot = root;
    this.gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    // The one place `.arbor` is resolved. Every campaign-data path below is
    // built from this, so a configured persistence root is honoured and cannot
    // be swapped for a sibling `repoRoot`-relative path.
    this.persistenceDir = resolvePersistenceDir(root, options.persistenceDir);
    this.worktreesDir = resolve(options.worktreesDir ?? join(root, ".worktrees"));
    this.leasesDir = resolve(options.leasesDir ?? join(this.persistenceDir, "leases"));
    this.orphanMarksFile = resolve(options.orphanMarksFile ?? join(this.persistenceDir, "orphan-marks.json"));
    this.objectCacheDir = resolve(join(this.persistenceDir, "object-cache"));
    this.ignoredDirtyRoots = [
      this.persistenceDir,
      join(root, ".worktrees"),
      // The lease slot claim (`claimLeaseSlot`) now writes into `leasesDir`
      // BEFORE the dirty-workspace check runs below, so a caller-supplied
      // `leasesDir`/`worktreesDir` outside the default `.arbor`/`.worktrees`
      // layout must be excluded explicitly too — otherwise the claim file
      // this manager just created would itself trip its own "uncommitted
      // product changes" refusal.
      this.worktreesDir,
      this.leasesDir,
      ...(options.operationalPaths ?? []).map((path) => resolve(path)),
    ].filter((path, index, paths) => path !== root && isInside(root, path) && paths.indexOf(path) === index);
    this.dryRun = dryRun;
    this.dependencyProvisioning = options.dependencyProvisioning ?? {};
    this.testOnlyAfterPreserveHook = options._testOnly_afterPreserveHook;
    this.asyncWorkerOptions = {
      repoRoot: root,
      gitTimeoutMs: this.gitTimeoutMs,
      // The child rebuilds every path from these options. Omitting
      // `persistenceDir` here would make it re-derive the `.arbor` default and
      // write outside the configured root — the escape this todo closes, one
      // process boundary away.
      persistenceDir: this.persistenceDir,
      worktreesDir: this.worktreesDir,
      leasesDir: this.leasesDir,
      orphanMarksFile: this.orphanMarksFile,
      operationalPaths: [...this.ignoredDirtyRoots],
      dependencyProvisioning: this.dependencyProvisioning,
    };
  }

  /** Absolute path to the leases directory. */
  get leasesPath(): string {
    return this.leasesDir;
  }

  /** Absolute path to the orphan-marks file. */
  get orphanMarksPath(): string {
    return this.orphanMarksFile;
  }

  /** Absolute path to the shared admitted-commit object cache. */
  get objectCachePath(): string {
    return this.objectCacheDir;
  }

  /** Absolute path to the preserved-worktree root. */
  get preservedRoot(): string {
    return join(this.persistenceDir, "preserved");
  }

  /**
   * The options the async worker child is constructed with. Exposed so the
   * cross-process half of the containment property is assertable: vitest runs
   * under Node, where `acquireLeaseAsync` takes the synchronous path, so the
   * child that would silently re-derive `.arbor` is never spawned in this lane.
   */
  get asyncWorkerPathOptions(): WorktreeManagerOptions {
    return { ...this.asyncWorkerOptions };
  }

  /** Actionable reason the most recent real lease acquisition was refused. */
  get lastAcquireFailure(): string | null {
    return this.acquireFailure;
  }

  /** Structured outcome of the most recent `releaseLease` call. See {@link ReleaseOutcome}. */
  get lastReleaseOutcome(): ReleaseOutcome | null {
    return this.releaseOutcome;
  }

  /**
   * Typed outcome of the most recent lease's dependency install (`disabled`,
   * `skipped` for no recognized lockfile, `installed`, or `failed`) — never
   * silence. `null` only before any real (non-dry-run) lease has ever been
   * acquired by this manager instance.
   */
  get lastDependencyProvisioning(): DependencyProvisioningOutcome | null {
    return this.lastProvisioning;
  }

  /**
   * Name a timeout in the result's own stderr, so every existing call site's
   * failure message says the budget expired instead of reporting an empty
   * "git ... failed". A killed `spawnSync` returns `status: null` with no
   * captured output at all, which every `status !== 0` branch here would
   * otherwise render as an unexplained failure — precisely the silence this
   * bound exists to end.
   */
  private annotateTimeout(result: SpawnSyncReturns<string>, args: readonly string[]): SpawnSyncReturns<string> {
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    if (!timedOut) return result;
    return { ...result, stderr: `git ${args.join(" ")} timed out after ${this.gitTimeoutMs}ms` };
  }

  /** Every git invocation goes through here so `cwd` scoping can never be defeated by an inherited GIT_DIR/GIT_WORK_TREE. */
  private git(args: string[]): SpawnSyncReturns<string> {
    return this.annotateTimeout(spawnSync("git", args, { cwd: this.repoRoot, stdio: "pipe", encoding: "utf-8", env: sanitizedGitEnv(), timeout: this.gitTimeoutMs }), args);
  }

  /** Run git against an expansion checkout after its object database is detached from the parent. */
  private gitAt(path: string, args: string[], input?: string): SpawnSyncReturns<string> {
    return this.annotateTimeout(spawnSync("git", ["-C", path, ...args], { stdio: "pipe", encoding: "utf-8", env: sanitizedGitEnv(), timeout: this.gitTimeoutMs, input }), args);
  }

  /**
   * Acquire an exclusive lease for a node, creating its git worktree.
   * Returns the lease on success, or null if the lease is already held
   * (another specialist holds it) or the worktree cannot be created.
   */
  acquireLease(params: {
    campaign_id: string;
    node_id: string;
    specialist: string;
    operation_id?: string;
    lease_id?: string;
    expires_at?: string;
  }): WorktreeLease | null {
    const { campaign_id, node_id } = params;
    this.acquireFailure = null;
    if ((params.operation_id !== undefined || params.lease_id !== undefined || params.expires_at !== undefined)
      && (!params.operation_id?.trim() || !params.lease_id?.trim() || !params.expires_at || Number.isNaN(Date.parse(params.expires_at)))) {
      throw new Error("operation_id, lease_id, and expires_at must be supplied together for an ADR-012 lease");
    }

    const branch = `arbor/${campaign_id}/${node_id}`;
    const path = join(this.worktreesDir, `${campaign_id}-${node_id}`);

    // campaign_id/node_id are caller-supplied (threaded from
    // manager.startCampaign/admitCampaignPlan, which accept any non-empty
    // string id), not manager-generated like `objectCacheDir`'s sanitized
    // names. A ".." segment in either would make `path` resolve outside
    // `worktreesDir`, and `mkdirSync(dirname(path), { recursive: true })`
    // below runs unconditionally before any other check — so refuse before
    // any filesystem write rather than relying on git's branch-name
    // validation (which happens to reject the same input, but only after
    // directories may already have been created).
    if (!isInside(this.worktreesDir, path)) {
      this.acquireFailure = `campaign_id/node_id would escape the managed worktrees directory (${path}); refusing to create any path outside ${this.worktreesDir}`;
      return null;
    }

    if (this.dryRun) {
      // dryRun keeps its original, purely in-memory check-then-act: there is
      // no filesystem/process race to defend against when nothing but this
      // one process's Map is involved.
      const existing = this.memoryLeases.get(node_id);
      if (existing?.active) return null;
      const lease = this.buildLease(params, branch, path, "HEAD");
      this.memoryLeases.set(node_id, lease);
      return lease;
    }

    mkdirSync(this.leasesDir, { recursive: true });

    // Claim the lease slot BEFORE any other git/filesystem work. This is the
    // sole exclusivity primitive for real acquisitions — the old
    // `readLease().active` check-then-act below this point only ever held
    // incidentally, because `git worktree add` happens to refuse a second
    // branch/path collision; two racing processes could otherwise both pass
    // the read, both do the (expensive) git/dependency work, and both
    // "win" the eventual plain `writeFileSync`. See `claimLeaseSlot` for the
    // exclusivity argument.
    const claim = this.claimLeaseSlot(node_id, campaign_id, path, branch);
    if ("failure" in claim) {
      this.acquireFailure = claim.failure;
      return null;
    }
    const claimToken = claim.token;

    // Every exit below this point — a normal `return null` OR an uncaught
    // throw (`assertCommitAvailableForWorktree` throws rather than
    // returning) — must release the claim it created, and ONLY that claim
    // (verified by token; see `releaseClaim`). `committed` is flipped true
    // only immediately before the final, successful lease write, so the
    // `finally` below is the single place that decides whether to clean up.
    let committed = false;
    try {
      const status = this.git(["status", "--porcelain=v1", "--untracked-files=all"]);
      if (status.status !== 0) {
        this.acquireFailure = `repository status could not be inspected before isolation: ${(status.stderr || status.stdout).trim() || "git status failed"}`;
        return null;
      }
      const dirtyPaths = status.stdout.split("\n").filter(Boolean).map((line) => line.slice(3).split(" -> ").at(-1) ?? "").filter((path) => {
        const absolute = resolve(this.repoRoot, path);
        return !this.ignoredDirtyRoots.some((root) => absolute === root || isInside(root, absolute));
      });
      if (dirtyPaths.length > 0) {
        this.acquireFailure = `repository has uncommitted product changes that are absent from HEAD (${dirtyPaths.slice(0, 8).join(", ")}${dirtyPaths.length > 8 ? ", …" : ""}); commit, stash, or revert them before starting an isolated campaign`;
        return null;
      }
      // Ensure the base dir exists.
      mkdirSync(dirname(path), { recursive: true });

      const startingCommit = this.revParse("HEAD");
      // Fail fast and clearly, before any worktree/branch is created or any
      // network fetch is attempted: `detachObjectDatabase` below fetches
      // `startingCommit` FROM `repoRoot`. If `repoRoot` itself is a shallow
      // clone that doesn't have `startingCommit` in its shallow history (for
      // example, a recovered lease pinned to a commit that has since aged
      // out of a shallow window), that fetch fails deep in the worktree-
      // creation call chain — after a campaign has already paid for
      // planning. Surface the real, actionable cause here instead.
      this.assertCommitAvailableForWorktree(startingCommit);

      // Create a registered worktree first so existing lease reconciliation
      // and cleanup keep their durable Git bookkeeping. A linked worktree's
      // `.git` file exposes every parent ref and object, however, including
      // commits after the admitted starting point. Replace that pointer with
      // an independent repository fetched at exactly the admitted commit.
      const create = this.git(["worktree", "add", "-b", branch, path, startingCommit]);
      if (create.status !== 0) {
        // If the branch already exists, try adding without -b.
        const retry = this.git(["worktree", "add", path, branch]);
        if (retry.status !== 0) {
          this.acquireFailure = `git worktree creation failed: ${(retry.stderr || retry.stdout).trim() || "unknown git error"}`;
          return null;
        }
      }
      if (!this.detachObjectDatabase(path, branch, startingCommit)) {
        this.cleanupFailedAcquire(path, branch);
        this.acquireFailure = "isolated object database could not be detached at the admitted commit";
        return null;
      }

      // A worktree with no installed dependencies is not usably created: any
      // verification command a specialist runs inside it dies on missing
      // node_modules. Fail the acquire honestly (same cleanup path as a
      // failed detach) rather than handing back a lease nothing can verify
      // against.
      this.lastProvisioning = provisionWorktreeDependencies(path, this.dependencyProvisioning);
      if (this.lastProvisioning.status === "failed") {
        this.cleanupFailedAcquire(path, branch);
        this.acquireFailure = `dependency install failed (${this.lastProvisioning.ecosystem} via ${this.lastProvisioning.argv.join(" ")}): ${this.lastProvisioning.detail}`;
        return null;
      }

      // Finalize is a compare-and-swap on the claim, not a blind write: it
      // re-reads the slot and confirms it still carries THIS claim's token
      // before writing the real lease, and both the re-read and the write
      // happen while holding the slot lock — so there is no window between
      // them for a competing process to interleave (the lock IS what closes
      // that window; every other mutator of an occupied slot takes the same
      // lock before touching it — see `claimLeaseSlot`). In ordinary
      // operation this can only ever confirm what is already true (this
      // process is alive, so nothing could have judged its claim dead and
      // reclaimed it); it exists as a belt-and-suspenders guard against that
      // invariant ever being violated, and to give an honest, specific
      // failure (with worktree/branch rolled back) on the rare occasion the
      // slot lock itself could not be acquired within its bounded wait.
      const finalized = this.finalizeClaim(node_id, claimToken, () => this.buildLease(params, branch, path, startingCommit));
      if (finalized === null) {
        this.cleanupFailedAcquire(path, branch);
        this.acquireFailure = "lease claim could not be finalized (the slot lock was unavailable, or the claim was no longer present); the worktree/branch this acquire created have been rolled back";
        return null;
      }
      committed = true;
      return finalized;
    } finally {
      if (!committed) this.releaseClaim(node_id, claimToken);
    }
  }

  /**
   * Event-loop-safe acquisition for interactive campaign drivers. The
   * synchronous API remains the deterministic primitive used by recovery,
   * stress tools, and Node tests; under the Bun product runtime this method
   * executes that exact primitive in a worker thread so local Git packing and
   * dependency provisioning cannot stop terminal input or animation.
   */
  async acquireLeaseAsync(params: {
    campaign_id: string;
    node_id: string;
    specialist: string;
    operation_id?: string;
    lease_id?: string;
    expires_at?: string;
  }, signal?: AbortSignal): Promise<WorktreeLease | null> {
    const bunRuntime = typeof (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun === "string";
    if (this.dryRun || !bunRuntime) return this.acquireLease(params);
    if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error("worktree acquisition cancelled");
    const moduleUrl = import.meta.url;
    const childSource = `
      const payload = JSON.parse(process.argv[1]);
      import(payload.moduleUrl).then(({ WorktreeManager }) => {
        const manager = new WorktreeManager(payload.options);
        const lease = manager.acquireLease(payload.params);
        process.stdout.write(JSON.stringify({ lease, failure: manager.lastAcquireFailure, provisioning: manager.lastDependencyProvisioning }));
      }).catch((error) => {
        process.stdout.write(JSON.stringify({ worker_error: error instanceof Error ? error.message : String(error) }));
        process.exitCode = 1;
      });
    `;
    return await new Promise<WorktreeLease | null>((resolveLease, rejectLease) => {
      const child = spawn(process.execPath, ["-e", childSource, JSON.stringify({ moduleUrl, options: this.asyncWorkerOptions, params })], {
        cwd: this.repoRoot,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      let stdout = "";
      let stderr = "";
      const terminateTree = (processToStop: ChildProcess): void => {
        if (processToStop.pid === undefined) return;
        try {
          if (process.platform === "win32") processToStop.kill("SIGTERM");
          else process.kill(-processToStop.pid, "SIGTERM");
        } catch { /* already exited */ }
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        terminateTree(child);
        const killTimer = setTimeout(() => {
          if (child.pid === undefined) return;
          try {
            if (process.platform === "win32") child.kill("SIGKILL");
            else process.kill(-child.pid, "SIGKILL");
          } catch { /* already exited */ }
        }, 1_000);
        killTimer.unref?.();
        signal?.removeEventListener("abort", onAbort);
        rejectLease(signal?.reason instanceof Error ? signal.reason : new Error("worktree acquisition cancelled"));
      };
      const settle = (lease: WorktreeLease | null, failure: string | null, provisioning: DependencyProvisioningOutcome | null): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.acquireFailure = failure;
        this.lastProvisioning = provisioning;
        resolveLease(lease);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer | string) => { if (stdout.length < 1024 * 1024) stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer | string) => { if (stderr.length < 64 * 1024) stderr += chunk.toString(); });
      child.once("error", (error) => settle(null, `worktree acquisition worker failed: ${error.message}`, null));
      child.once("close", (code) => {
        if (settled) return;
        let message: unknown;
        try { message = JSON.parse(stdout); }
        catch {
          settle(null, `worktree acquisition worker exited ${code ?? "unknown"} without a readable result${stderr.trim().length === 0 ? "" : `: ${stderr.trim()}`}`, null);
          return;
        }
        const result = typeof message === "object" && message !== null ? message as {
          lease?: WorktreeLease | null;
          failure?: string | null;
          provisioning?: DependencyProvisioningOutcome | null;
          worker_error?: string;
        } : {};
        if (typeof result.worker_error === "string") settle(null, `worktree acquisition worker failed: ${result.worker_error}`, null);
        else settle(result.lease ?? null, result.failure ?? null, result.provisioning ?? null);
      });
    });
  }

  /**
   * Fence a lease whose recorded owner is known dead while retaining the
   * isolated checkout and any partial work it contains. The acquired_at
   * witness and exclusive lock make this a compare-and-swap, not a blind
   * overwrite of a lease that another process may have renewed.
   */
  takeoverLease(input: {
    campaign_id: string;
    node_id: string;
    expected_acquired_at: string;
    specialist: string;
    operation_id: string;
    lease_id: string;
    expires_at: string;
  }): WorktreeLease | null {
    const replace = (): WorktreeLease | null => {
      const current = this.readLease(input.node_id);
      if (!current?.active || current.campaign_id !== input.campaign_id || current.acquired_at !== input.expected_acquired_at) return null;
      if (!existsSync(current.path) || !isInside(this.worktreesDir, current.path)) return null;
      // Drop the previous owner's identity fields explicitly rather than
      // carrying them forward via `...current`: they describe a different
      // process than the new `owner_pid` below, and a stale start-time/
      // boot-id pair compared against the WRONG pid would corrupt the next
      // dead-owner check instead of merely being absent from it.
      const { owner_start_ticks: _staleTicks, owner_boot_id: _staleBootId, ...currentWithoutIdentity } = current;
      const identity = readProcessIdentity(process.pid);
      const lease: WorktreeLease = {
        ...currentWithoutIdentity,
        acquired_at: new Date().toISOString(),
        acquired_by: input.specialist,
        owner_pid: process.pid,
        ...(identity ? { owner_start_ticks: identity.start_ticks, owner_boot_id: identity.boot_id } : {}),
        operation_id: input.operation_id,
        lease_id: input.lease_id,
        expires_at: input.expires_at,
      };
      if (this.dryRun) this.memoryLeases.set(input.node_id, lease);
      else this.writeLeaseFile(input.node_id, lease);
      return lease;
    };
    if (this.dryRun) return replace();
    // Shares the exact same per-slot mutex `claimLeaseSlot`/`finalizeClaim`/
    // `reconcileLeases` use, rather than a separate takeover-only lock:
    // two independent locks over the same slot would let a takeover and an
    // inactive-slot reclaim interleave freely, reopening the double-win
    // hazard the shared mutex exists to close.
    if (!this.acquireSlotLock(input.node_id)) {
      this.acquireFailure = "lease slot busy";
      return null;
    }
    try {
      return replace();
    } finally {
      this.releaseSlotLock(input.node_id);
    }
  }

  /**
   * Release a lease, removing both the worktree AND the branch created for
   * it in `acquireLease`. Used after a node is verified, fails, or is
   * pruned. Returns true if a lease was released.
   *
   * Mirrors `selfhost.ts`'s `removeSelfhostWorktree`: a worktree without its
   * branch is only half reclaimed. `git worktree remove` never deletes the
   * branch it was checked out on, so leaving out the `git branch -D` here
   * was the root cause of every campaign run leaking one `arbor/*` branch
   * per node it ever expanded — a leak that fired on every clean node, not
   * just on a crash. Both calls are best-effort (git may already agree the
   * branch/worktree are gone). The slot lock remains held from ownership
   * check through cleanup so a replacement lease cannot be removed midway.
   */
  releaseLease(node_id: string, expected?: { operation_id: string; lease_id: string }): boolean {
    // Recovery releases carry the identity they acquired. Serialize the
    // ownership check and cleanup with every other slot mutation so a stale
    // recovery adapter cannot release a replacement lease for this node.
    if (!this.dryRun && !this.acquireSlotLock(node_id)) {
      this.releaseOutcome = { status: "retained_raced", reason: "lease slot busy; release ownership was not changed" };
      return false;
    }
    try {
      const lease = this.readLease(node_id);
      if (expected !== undefined && (lease?.operation_id !== expected.operation_id || lease.lease_id !== expected.lease_id)) {
        this.releaseOutcome = { status: "not_held" };
        return false;
      }
      if (!lease?.active) {
        this.releaseOutcome = { status: "not_held" };
        return false;
      }

    if (!this.dryRun) {
      const worktreePresent = isInside(this.worktreesDir, lease.path) && existsSync(lease.path);
      const decision: PreserveDecision = worktreePresent
        ? this.decideAndPreserve({
            path: lease.path,
            branch: lease.branch,
            campaign_id: lease.campaign_id,
            node_id: lease.node_id,
            starting_commit: lease.starting_commit,
          })
        : { safe: true, rung: "same_commit" }; // nothing on disk to preserve or destroy

      if (!decision.safe) {
        this.releaseOutcome = { status: decision.raced ? "retained_raced" : "retained_preservation_failed", reason: decision.reason };
        // A retained worktree/branch keeps its data, but the SLOT must still
        // be freed: leaving `active: true` forever would wedge the node (no
        // future acquire, no future reconciliation) exactly the way an
        // unconditional lease-file drop used to prevent. Deactivating
        // (never deleting) the lease record here is what "inactive is
        // fine" means — the worktree stays discoverable by
        // campaign_id/node_id from the lease's own history, and a later
        // orphan sweep re-runs this exact same preserve-before-destroy
        // check, so retained data is never at risk of a second, unchecked
        // pass silently destroying it.
        this.writeLeaseFile(node_id, { ...lease, active: false });
        return true;
      }

      // Same best-effort semantics as before this hardening: git may already
      // agree the branch/worktree are gone, and these three calls run
      // unconditionally once `decision.safe` has cleared removal.
      if (isInside(this.worktreesDir, lease.path)) bestEffortRemove(lease.path);
      this.git(["worktree", "prune"]);
      this.git(["branch", "-D", lease.branch]);
      this.releaseOutcome = "manifest_path" in decision
        ? { status: "removed_after_preservation", manifest_path: decision.manifest_path, rung: decision.rung }
        : { status: "removed_integrated", rung: decision.rung };

      bestEffortRemove(this.leaseFile(node_id));
    } else {
      this.memoryLeases.delete(node_id);
      this.releaseOutcome = { status: "removed_integrated", rung: "same_commit" };
    }
      return true;
    } finally {
      if (!this.dryRun) this.releaseSlotLock(node_id);
    }
  }

  /**
   * Decide whether `path`'s content is safe to destroy, and if it is not,
   * actually preserve it — WITHOUT deleting or removing anything itself.
   * Shared by `releaseLease` and the orphan sweep (`reclaimOrphan`), since
   * both destroy a worktree/branch and both must honor the same "preserve
   * before destroy" contract, but they differ in how (and whether) they
   * verify and perform the actual removal afterward, so removal stays each
   * caller's own responsibility.
   *
   * TOCTOU: `preserveWork` captures a snapshot, but the worktree is real
   * filesystem state another process could still be writing to. A dirty
   * flag and HEAD alone are not enough proof of "nothing changed": a file
   * that was ALREADY dirty can be edited again without moving either of
   * them, so the re-check instead compares a content identity — the tree id
   * of a scratch-index snapshot (`computeWorkingTreeSnapshotId`) — against
   * the identity `preserveWork` reports it actually preserved. Any failure
   * to compute an identity, on either side, is treated as "changed" (fail
   * closed): it is never used as proof of "unchanged". If the identity (or
   * HEAD) moved, this re-preserves (bounded retries) rather than ever
   * telling a caller it is safe to remove content a moment too early.
   */
  private decideAndPreserve(params: {
    path: string;
    branch: string;
    campaign_id: string;
    node_id: string;
    starting_commit: string;
  }): PreserveDecision {
    const targetRes = this.git(["rev-parse", "HEAD"]);
    const targetSha = targetRes.status === 0 ? targetRes.stdout.trim() : null;
    if (targetSha !== null) {
      // Best-effort: the worktree's object database is detached from
      // `repoRoot` (see `detachObjectDatabase`), so it may not already have
      // `repoRoot`'s current HEAD reachable. A failed fetch here just means
      // the integration check below can't resolve the target either, which
      // it already treats as `unknown` — fail closed, not a hard error.
      this.gitAt(params.path, ["fetch", "--quiet", "--no-tags", this.repoRoot, targetSha]);
    }

    const assess = (): { dirty: boolean; headSha: string | null; rung: IntegrationClassification; workingTreeId: string | null } => {
      const statusRes = this.gitAt(params.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      // Fail closed: if dirtiness can't even be inspected, assume dirty
      // rather than risk treating unreadable state as "nothing to lose".
      const dirty = statusRes.status === 0 ? statusRes.stdout.length > 0 : true;
      const headRes = this.gitAt(params.path, ["rev-parse", "HEAD"]);
      const headSha = headRes.status === 0 ? headRes.stdout.trim() : null;
      const check = targetSha !== null && headSha !== null
        ? checkIntegration({ cwd: params.path, branch: headSha, target: targetSha, gitTimeoutMs: this.gitTimeoutMs })
        : ({ status: "unknown" as const, detail: "worktree HEAD or the release target could not be resolved" });
      const rung: IntegrationClassification = check.status === "integrated" ? check.rung : check.status;
      const workingTreeId = computeWorkingTreeSnapshotId(params.path, this.gitTimeoutMs);
      return { dirty, headSha, rung, workingTreeId };
    };

    const first = assess();
    const needsPreservation = first.dirty || first.rung === "not_integrated" || first.rung === "unknown";

    if (!needsPreservation) return { safe: true, rung: first.rung };

    const preservedRoot = this.preservedRoot;
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const state = attempt === 0 ? first : assess();
      if (state.headSha === null) {
        return { safe: false, raced: false, reason: "worktree HEAD could not be resolved; retaining rather than destroying unverified content" };
      }
      const result = preserveWork({
        worktreePath: params.path,
        preservedRoot,
        campaignId: params.campaign_id,
        nodeId: params.node_id,
        branch: params.branch,
        startingCommit: params.starting_commit,
        headCommit: state.headSha,
        integrationRung: state.rung,
        gitTimeoutMs: this.gitTimeoutMs,
      });
      if (!result.ok) return { safe: false, raced: false, reason: result.reason };

      // TEST-ONLY: lets a test land a write in the exact synchronous window
      // between "preservation captured" and "TOCTOU re-check" that this
      // hardening exists to close — there is no other way to hit that
      // window deterministically. No production caller sets this.
      this.testOnlyAfterPreserveHook?.(params.path, attempt);

      // TOCTOU re-check: proof of "unchanged" is the PRESERVED snapshot's
      // own content identity (as `preserveWork` actually captured it)
      // matching a FRESH identity taken right now, plus HEAD not having
      // moved. Never proof by dirty-flag/HEAD alone — see the class doc.
      const recheck = assess();
      const unchanged = result.workingTreeId !== null
        && recheck.workingTreeId !== null
        && recheck.workingTreeId === result.workingTreeId
        && recheck.headSha === state.headSha;
      if (unchanged) return { safe: true, rung: recheck.rung, manifest_path: result.manifestPath };
      if (attempt === maxAttempts - 1) {
        return {
          safe: false,
          raced: true,
          reason: `worktree kept changing while it was being preserved (checked ${maxAttempts} times); retaining rather than risk removing content the last preservation pass never captured`,
        };
      }
    }
    // Unreachable, but keeps the return type total without a non-null assertion.
    return { safe: false, raced: false, reason: "preservation loop exited without a decision" };
  }

  /** Check whether a node currently holds an active lease. */
  isHeld(node_id: string): boolean {
    return this.readLease(node_id)?.active ?? false;
  }

  /** Read the current lease for a node, or null. */
  readLease(node_id: string): WorktreeLease | null {
    if (this.dryRun) return this.memoryLeases.get(node_id) ?? null;
    const file = this.leaseFile(node_id);
    if (!existsSync(file)) return null;
    return this.parseLeaseFile(file);
  }

  /** List all active leases. */
  listActive(): WorktreeLease[] {
    if (this.dryRun) {
      return [...this.memoryLeases.values()].filter((l) => l.active);
    }
    if (!existsSync(this.leasesDir)) return [];
    const files = readDirNames(this.leasesDir);
    const leases: WorktreeLease[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const nodeId = f.replace(/\.json$/, "");
      const lease = this.readLease(nodeId);
      if (lease?.active) leases.push(lease);
    }
    return leases;
  }

  /**
   * Inspect persisted leases against `git worktree list` after a restart.
   *
   * A missing registered worktree is the only condition that makes an owned
   * lease stale. It is made inactive (rather than deleted) so the recovery is
   * auditable. A registered worktree is retained even when its creating
   * process is gone: a git registration is the durable fact, while this lease
   * format intentionally does not claim to identify a running worker process.
   * Malformed or foreign records are reported without changing them.
   *
   * ORPHANED MANAGED WORKTREES (`options.sweep`). A worktree registered inside
   * `.worktrees/` with no active canonical lease was previously reported and
   * left forever, so it could never be reclaimed by anything. That state is
   * reachable on a normal failure: `releaseLease` drops the lease file
   * unconditionally after two best-effort git calls, so a failed
   * `git worktree remove` leaves a registered worktree with no lease and no
   * future owner. With `sweep`, such a worktree is reclaimed — but only under
   * a two-phase rule, because a single observation cannot distinguish
   * abandoned debris from an in-flight `acquireLease` that has created its
   * worktree and not yet written its lease:
   *
   *   1. the orphan must have been recorded as orphaned by an EARLIER call
   *      (a path first seen in this pass is only ever marked, never swept), and
   *   2. that first observation must be older than `orphanGraceMs`.
   *
   * A healthy acquire writes its lease microseconds after `git worktree add`,
   * so it can never satisfy both. Marks are persisted, so the grace period
   * survives a restart rather than resetting on every startup, and a path that
   * stops being orphaned loses its mark.
   */
  reconcileLeases(options: LeaseReconciliationOptions = {}): LeaseReconciliationResult {
    const now = options.now ?? new Date();
    const graceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
    const sweep = options.sweep ?? false;

    if (this.dryRun) {
      const live = rankByFrecency(this.listActive(), (lease) => ({ frequency: 1, last_used_at: lease.acquired_at }), now);
      return {
        live,
        outcomes: live.map((lease) => ({
          lease_file: `${lease.node_id}.json`,
          node_id: lease.node_id,
          campaign_id: lease.campaign_id,
          path: lease.path,
          status: "live" as const,
          detail: "dry-run lease retained in memory",
        })),
      };
    }

    const registered = this.registeredWorktrees();
    if (registered === null) {
      return {
        live: [],
        outcomes: [{
          path: this.repoRoot,
          status: "unavailable",
          detail: "could not inspect git worktree registration; no leases were changed",
        }],
      };
    }

    const outcomes: LeaseReconciliationOutcome[] = [];
    const live: WorktreeLease[] = [];
    const leasedPaths = new Set<string>();
    if (existsSync(this.leasesDir)) {
      for (const file of readDirNames(this.leasesDir)) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(this.leasesDir, file);
        const parsed = this.parseLeaseFile(filePath);
        if (!parsed) {
          outcomes.push({
            lease_file: file,
            path: filePath,
            status: "malformed",
            detail: "lease file is not a valid WorktreeLease record",
          });
          continue;
        }
        if (!parsed.active) continue;

        const expectedPath = resolve(this.worktreesDir, `${parsed.campaign_id}-${parsed.node_id}`);
        const expectedBranch = `arbor/${parsed.campaign_id}/${parsed.node_id}`;
        if (
          file !== `${parsed.node_id}.json` ||
          resolve(parsed.path) !== expectedPath ||
          parsed.branch !== expectedBranch ||
          !isInside(this.worktreesDir, expectedPath)
        ) {
          outcomes.push({
            lease_file: file,
            node_id: parsed.node_id,
            campaign_id: parsed.campaign_id,
            path: parsed.path,
            status: "unrelated",
            detail: "lease is not owned by this manager's canonical worktree layout; left unchanged",
          });
          continue;
        }

        leasedPaths.add(expectedPath);
        if (registered.has(expectedPath) && existsSync(expectedPath)) {
          live.push(parsed);
          outcomes.push({
            lease_file: file,
            node_id: parsed.node_id,
            campaign_id: parsed.campaign_id,
            path: parsed.path,
            status: "live",
            detail: "git still registers the leased worktree",
          });
          continue;
        }

        // A slot claim (`claimLeaseSlot`) is written BEFORE `git worktree
        // add` runs, so it is indistinguishable from a genuinely stale lease
        // by the `registered.has(...)` check above: neither has a
        // registered worktree yet. Deactivating it here as "stale" would
        // hand the slot to a second claimant while the first is still doing
        // its git/dependency work. Only deactivate a pending claim once its
        // recorded owner is provably dead — same rule `claimLeaseSlot`
        // itself applies when deciding whether an occupied slot is
        // reclaimable.
        const claimToken = pendingClaimToken(parsed);
        if (claimToken !== undefined) {
          const ownerLive = parsed.owner_pid === undefined
            || identityStillMatches(parsed.owner_pid, { start_ticks: parsed.owner_start_ticks, boot_id: parsed.owner_boot_id }, { processAlive: isProcessAlive, processIdentity: readProcessIdentity });
          if (ownerLive) {
            outcomes.push({
              lease_file: file,
              node_id: parsed.node_id,
              campaign_id: parsed.campaign_id,
              path: parsed.path,
              status: "claim_pending",
              detail: "a lease acquisition is in flight (claimed, git worktree not yet registered) and its owner process is alive; left untouched",
            });
            continue;
          }
        }

        // Every write to an occupied slot — including this deactivation —
        // goes through the same per-slot mutex `claimLeaseSlot` uses, so it
        // can never interleave with a concurrent claim/finalize/takeover on
        // this exact node_id. If the lock is unavailable within its bounded
        // wait, this pass simply leaves the record untouched; reconciliation
        // is safe to retry (it is non-destructive by design) rather than
        // forcing an unguarded write here.
        if (!this.acquireSlotLock(parsed.node_id)) {
          // Reuses "claim_pending" rather than the whole-pass "unavailable"
          // status: "unavailable" is read elsewhere (`OpenCodeRecoveryLeaseAdapter
          // .resolveOldLease`) as "the ENTIRE reconciliation pass could not
          // be trusted" and makes every node's lease ambiguous, regardless
          // of node_id — one busy lock on an unrelated node must not corrupt
          // resolution for every other node in the same pass.
          outcomes.push({
            lease_file: file,
            node_id: parsed.node_id,
            campaign_id: parsed.campaign_id,
            path: parsed.path,
            status: "claim_pending",
            detail: "lease slot was busy; left unchanged for a future reconciliation pass",
          });
          continue;
        }
        try {
          const inactive = { ...parsed, active: false };
          this.writeLeaseFile(parsed.node_id, inactive);
        } finally {
          this.releaseSlotLock(parsed.node_id);
        }
        outcomes.push({
          lease_file: file,
          node_id: parsed.node_id,
          campaign_id: parsed.campaign_id,
          path: parsed.path,
          status: "stale",
          detail: claimToken !== undefined
            ? "a lease acquisition's claim was found with no live owner; deactivated as stale"
            : "git no longer registers an existing worktree; lease was deactivated without removing files",
        });
      }
    }

    const marks = this.readOrphanMarks();
    const retained = new Map<string, string>();
    const nowIso = now.toISOString();
    for (const [path, branch] of registered) {
      if (!isInside(this.worktreesDir, path) || leasedPaths.has(path)) continue;

      const firstSeen = marks.get(path);
      // An unmarked path is being seen orphaned for the first time: record it
      // and report only. This is the first half of the two-phase rule, and it
      // holds even when the grace period is zero.
      if (firstSeen === undefined) {
        retained.set(path, nowIso);
        outcomes.push({
          path,
          status: "orphaned_worktree",
          detail: "managed worktree has no active canonical lease; first observation recorded, left untouched",
        });
        continue;
      }

      const observedMs = now.getTime() - Date.parse(firstSeen);
      if (!sweep || observedMs < graceMs) {
        retained.set(path, firstSeen);
        outcomes.push({
          path,
          status: "orphaned_worktree",
          detail: sweep
            ? `managed worktree has no active canonical lease; orphaned since ${firstSeen}, within the ${graceMs}ms grace period`
            : `managed worktree has no active canonical lease; orphaned since ${firstSeen}, sweeping not requested`,
        });
        continue;
      }

      const reclamation = this.reclaimOrphan(path, branch);
      if (!reclamation.removed) retained.set(path, firstSeen);
      outcomes.push({
        path,
        status: reclamation.removed
          ? (reclamation.preserved ? "reclaimed_after_preservation" : "reclaimed")
          : (reclamation.retainedForSafety ? "reclaim_retained_preservation_failed" : "reclaim_failed"),
        detail: reclamation.detail,
      });
    }
    this.writeOrphanMarks(retained);
    return { outcomes, live: rankByFrecency(live, (lease) => ({ frequency: 1, last_used_at: lease.acquired_at }), now) };
  }

  // --- Internal ---

  private leaseFile(node_id: string): string {
    return join(this.leasesDir, `${node_id}.json`);
  }

  /** Build the final lease record shared by `acquireLease`'s dry-run and real paths. */
  private buildLease(
    params: { campaign_id: string; node_id: string; specialist: string; operation_id?: string; lease_id?: string; expires_at?: string },
    branch: string,
    path: string,
    startingCommit: string,
  ): WorktreeLease {
    const identity = readProcessIdentity(process.pid);
    return {
      node_id: params.node_id,
      campaign_id: params.campaign_id,
      branch,
      path,
      acquired_at: new Date().toISOString(),
      acquired_by: params.specialist,
      starting_commit: startingCommit,
      active: true,
      owner_pid: process.pid,
      ...(identity ? { owner_start_ticks: identity.start_ticks, owner_boot_id: identity.boot_id } : {}),
      ...(params.operation_id === undefined ? {} : { operation_id: params.operation_id, lease_id: params.lease_id!, expires_at: params.expires_at! }),
    };
  }

  /**
   * Claim node_id's lease slot exclusively, before any other git/filesystem
   * work in `acquireLease`. Returns a random token identifying THIS claim
   * (verified by `finalizeClaim`/`releaseClaim` before ever touching the
   * file again), or a human-readable failure.
   *
   * INVARIANT: the slot is absent only immediately after a genuine
   * `releaseLease`; every other transition on an OCCUPIED slot is an atomic
   * replace-in-place under the per-slot mutex (`acquireSlotLock`/
   * `<node_id>.lock`), never an unlink-then-create. That invariant is what
   * makes the two cases below jointly exhaustive and mutually safe:
   *
   *   FAST PATH (slot absent): a single `open(path, O_CREAT | O_EXCL)`
   *   (`createExclusiveFile`). The OS guarantees at most one caller can ever
   *   observe that call succeed against a given path, and per the invariant
   *   above the slot can only BE absent right after a release — so no lock
   *   is required here at all.
   *
   *   SLOT-OCCUPIED PATH: everything happens under `acquireSlotLock`. This
   *   closes the double-win this method used to have: an earlier version
   *   cleared an inactive slot with `unlinkSync` (which deletes whatever is
   *   AT THE PATH right now, not the specific record a racer inspected) and
   *   then re-created it — so a second racer's `unlinkSync` could delete the
   *   FIRST racer's brand-new active claim before the first racer ever wrote
   *   anything else, and both racers' subsequent `O_CREAT|O_EXCL` could each
   *   succeed in turn. Serializing every occupied-slot mutation behind one
   *   mutex removes that interleaving entirely: only the lock holder may
   *   inspect-then-replace, so "inspect" and "replace" are indivisible from
   *   every other claimant's point of view, and the replace itself is an
   *   atomic `renameSync` over the slot (never an unlink) — so the slot is
   *   never transiently absent for a second `O_CREAT|O_EXCL` racer to win.
   */
  private claimLeaseSlot(node_id: string, campaign_id: string, path: string, branch: string): { token: string } | { failure: string } {
    const file = this.leaseFile(node_id);
    const token = randomBytes(16).toString("hex");
    const identity = readProcessIdentity(process.pid);
    const claimRecord: PendingClaim = {
      node_id,
      campaign_id,
      branch,
      path,
      acquired_at: new Date().toISOString(),
      acquired_by: "",
      starting_commit: "",
      active: true,
      owner_pid: process.pid,
      ...(identity ? { owner_start_ticks: identity.start_ticks, owner_boot_id: identity.boot_id } : {}),
      claim_token: token,
      claim_pending: true,
    };
    const content = JSON.stringify(claimRecord, null, 2);

    // Fast path — see the invariant in the doc comment above.
    if (createExclusiveFile(file, content)) return { token };

    // Slot occupied: every inspection and mutation from here on happens
    // under the slot lock.
    if (!this.acquireSlotLock(node_id)) return { failure: "lease slot busy" };
    try {
      // Re-check under the lock: the fast-path creator above could have
      // raced us between our failed O_EXCL and acquiring the lock, or the
      // lock holder we just waited out could have released the slot.
      if (createExclusiveFile(file, content)) return { token };

      // A file that doesn't even parse as a WorktreeLease could be a lease
      // mid-write by an implementation that predates this hardening, or
      // genuine corruption — either way it must never be silently replaced
      // (fail closed) rather than risk clobbering a real, live lease.
      const existing = this.parseLeaseFile(file);
      if (existing === null) {
        return { failure: `lease file ${file} exists but does not parse as a valid lease record; refusing to claim over a file that may be a live or partially written lease (fail closed)` };
      }
      if (existing.active) {
        const existingClaimToken = pendingClaimToken(existing);
        // A plain active lease (no claim_token) is genuinely held — not
        // reclaimable here. A PENDING claim is reclaimable only when its
        // recorded owner is provably dead; a live or unverifiable owner
        // means someone else's `acquireLease` is still in flight.
        const reclaimableClaim = existingClaimToken !== undefined
          && existing.owner_pid !== undefined
          && !identityStillMatches(existing.owner_pid, { start_ticks: existing.owner_start_ticks, boot_id: existing.owner_boot_id }, { processAlive: isProcessAlive, processIdentity: readProcessIdentity });
        if (!reclaimableClaim) return { failure: "lease already held" };
      }

      // Replace atomically: write a sibling temp file, fsync, then
      // `renameSync` it over the slot. The slot is never transiently absent
      // here — see the class doc's invariant.
      atomicWriteFile(file, content);
      return { token };
    } finally {
      this.releaseSlotLock(node_id);
    }
  }

  /**
   * Compare-and-swap the slot's finalized lease into place. Re-reads the
   * slot under the same lock `claimLeaseSlot` uses and confirms it still
   * carries `token` before writing, so a caller only ever observes success
   * when its OWN claim is what actually got finalized — see the long
   * comment at the `acquireLease` call site for why this can only be a
   * defensive check in ordinary operation, not a real race resolver.
   */
  private finalizeClaim(node_id: string, token: string, buildFinal: () => WorktreeLease): WorktreeLease | null {
    if (!this.acquireSlotLock(node_id)) return null;
    try {
      const current = this.parseLeaseFile(this.leaseFile(node_id));
      if (pendingClaimToken(current) !== token) return null;
      const lease = buildFinal();
      this.writeLeaseFile(node_id, lease);
      return lease;
    } finally {
      this.releaseSlotLock(node_id);
    }
  }

  /**
   * Remove a claim file this manager created, but ONLY if it still holds
   * the exact token this call created it with — never a lease another
   * process may have since written into the same slot. Runs under the same
   * slot lock as every other occupied-slot mutation. If the lock cannot be
   * acquired within its bounded wait, this is best-effort and gives up
   * silently: the caller (an already-failed `acquireLease`) has nothing
   * further to roll back here, and the claim (still tagged with THIS
   * process's live pid/identity) is safely left for a future
   * `reconcileLeases`/`claimLeaseSlot` to resolve once it can prove this
   * process is actually gone.
   */
  private releaseClaim(node_id: string, token: string): void {
    if (!this.acquireSlotLock(node_id)) return;
    try {
      const file = this.leaseFile(node_id);
      const current = this.parseLeaseFile(file);
      if (pendingClaimToken(current) !== token) return;
      try {
        unlinkSync(file);
      } catch {
        // Best-effort: if it's already gone, there's nothing left to clean up.
      }
    } finally {
      this.releaseSlotLock(node_id);
    }
  }

  private lockFile(node_id: string): string {
    return join(this.leasesDir, `${node_id}.lock`);
  }

  /**
   * Take the per-slot mutex with a bounded synchronous wait (no infinite
   * spin): retry `O_CREAT|O_EXCL` on the lock file every
   * `SLOT_LOCK_WAIT_STEP_MS`, attempting to break a stale lock on every
   * contended attempt, until `SLOT_LOCK_WAIT_TOTAL_MS` elapses. Returns
   * false ("busy") rather than blocking forever — every call site treats
   * that as an honest, specific failure.
   */
  private acquireSlotLock(node_id: string): boolean {
    const lockPath = this.lockFile(node_id);
    const identity = readProcessIdentity(process.pid);
    const holder = JSON.stringify({
      pid: process.pid,
      start_ticks: identity?.start_ticks,
      boot_id: identity?.boot_id,
      created_at: new Date().toISOString(),
    });
    const deadline = Date.now() + SLOT_LOCK_WAIT_TOTAL_MS;
    for (;;) {
      if (createExclusiveFile(lockPath, holder)) return true;
      if (this.tryBreakStaleLock(lockPath)) continue; // slot freed; retry the create immediately
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      sleepSync(Math.min(SLOT_LOCK_WAIT_STEP_MS, remaining));
    }
  }

  private releaseSlotLock(node_id: string): void {
    try {
      unlinkSync(this.lockFile(node_id));
    } catch {
      // Best-effort: if it's already gone, there's nothing left to clean up.
    }
  }

  /**
   * Break a stale slot lock: only when it is both older than
   * `SLOT_LOCK_STALE_MS` AND its recorded holder is provably dead (PID gone,
   * or alive-but-different-identity — the same fail-safe check used
   * elsewhere; never breaks a lock whose liveness cannot be disproven).
   *
   * Broken by renaming the lock file aside, re-reading what was actually
   * moved, and comparing it byte-for-byte against what was read before the
   * rename. `renameSync` only ever moves whatever is AT THE PATH at the
   * instant it runs, which is not necessarily the exact stale record just
   * inspected (the true holder could have released it, and a different
   * process could have taken the lock, in between). If the moved content
   * doesn't match, this is not the lock that was judged dead: put it back
   * with `linkSync` (creating a second name for the same inode, so the
   * original holder — if it's still validly there — sees an unbroken lock)
   * and report "did not break it, still busy" rather than destroying
   * someone else's live lock.
   *
   * Residual window: between reading `raw` and calling `renameSync`,
   * another process could release-and-reacquire the SAME lock content
   * (same pid/identity/created_at) purely by coincidence — astronomically
   * unlikely given `created_at` has millisecond resolution and a fresh
   * random claim token differs, and bounded further by the fact that a
   * dead PID cannot legitimately reacquire anything. This is a defensive
   * comparison, not a cryptographic guarantee, and is documented here
   * rather than silently assumed.
   */
  private tryBreakStaleLock(lockPath: string): boolean {
    let raw: string;
    try {
      raw = readFileSync(lockPath, "utf-8");
    } catch {
      return false; // already gone; the caller's own create retry will succeed
    }
    let holder: { pid?: unknown; start_ticks?: unknown; boot_id?: unknown; created_at?: unknown };
    try {
      holder = JSON.parse(raw);
    } catch {
      return false; // unparseable lock: never touched, always reported busy
    }
    if (typeof holder.created_at !== "string" || typeof holder.pid !== "number") return false;
    const age = Date.now() - Date.parse(holder.created_at);
    if (!(age > SLOT_LOCK_STALE_MS)) return false;
    const startTicks = typeof holder.start_ticks === "string" ? holder.start_ticks : undefined;
    const bootId = typeof holder.boot_id === "string" ? holder.boot_id : undefined;
    const dead = !identityStillMatches(holder.pid, { start_ticks: startTicks, boot_id: bootId }, { processAlive: isProcessAlive, processIdentity: readProcessIdentity });
    if (!dead) return false;

    const movedPath = `${lockPath}.stale-${randomBytes(4).toString("hex")}`;
    try {
      renameSync(lockPath, movedPath);
    } catch {
      return false; // someone else already acted on it (or it's simply gone now)
    }
    let movedRaw: string | null;
    try {
      movedRaw = readFileSync(movedPath, "utf-8");
    } catch {
      return true; // it's gone entirely; the slot is free either way
    }
    if (movedRaw !== raw) {
      // Not the holder judged dead — restore it and report busy.
      try {
        linkSync(movedPath, lockPath);
      } catch {
        // lockPath may already have been recreated by its rightful owner;
        // either way there is nothing more to restore.
      }
      try {
        unlinkSync(movedPath);
      } catch {
        // Best-effort.
      }
      return false;
    }
    try {
      unlinkSync(movedPath);
    } catch {
      // Best-effort: the important part (freeing lockPath) already happened.
    }
    return true;
  }

  private writeLeaseFile(node_id: string, lease: WorktreeLease): void {
    atomicWriteFile(this.leaseFile(node_id), JSON.stringify(lease, null, 2));
  }

  private parseLeaseFile(file: string): WorktreeLease | null {
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf-8"));
      return isWorktreeLease(value) ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Registered worktree path -> the branch checked out there (null when
   * detached). The branch comes from git rather than being reconstructed from
   * the directory name: `<campaign_id>-<node_id>` cannot be split back apart
   * unambiguously when a campaign id contains a hyphen, and a swept branch
   * name must never be guessed.
   */
  private registeredWorktrees(): Map<string, string | null> | null {
    const result = this.git(["worktree", "list", "--porcelain"]);
    if (result.status !== 0) return null;
    const worktrees = new Map<string, string | null>();
    let current: string | null = null;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        current = resolve(line.slice("worktree ".length));
        worktrees.set(current, null);
        continue;
      }
      if (current !== null && line.startsWith("branch ")) {
        worktrees.set(current, line.slice("branch ".length).replace(/^refs\/heads\//, ""));
      }
    }
    return worktrees;
  }

  /**
   * First-observation marks for orphaned worktrees, keyed by absolute path.
   *
   * A corrupt or unreadable marks file reads as empty rather than throwing:
   * losing the marks costs one extra observation cycle before a sweep, while
   * throwing would break startup reconciliation entirely. Entries whose value
   * is not a parseable timestamp are dropped for the same reason.
   */
  private readOrphanMarks(): Map<string, string> {
    const marks = new Map<string, string>();
    if (!existsSync(this.orphanMarksFile)) return marks;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.orphanMarksFile, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return marks;
      for (const [path, seen] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof seen === "string" && !Number.isNaN(Date.parse(seen))) marks.set(resolve(path), seen);
      }
    } catch {
      return new Map();
    }
    return marks;
  }

  private writeOrphanMarks(marks: Map<string, string>): void {
    if (marks.size === 0) {
      if (existsSync(this.orphanMarksFile)) rmSync(this.orphanMarksFile, { force: true });
      return;
    }
    mkdirSync(dirname(this.orphanMarksFile), { recursive: true });
    const ordered: Record<string, string> = {};
    for (const path of [...marks.keys()].sort()) ordered[path] = marks.get(path)!;
    atomicWriteFile(this.orphanMarksFile, JSON.stringify(ordered, null, 2));
  }

  /**
   * Derive a campaign_id/node_id for an orphan (no lease record exists —
   * that is precisely why it is orphaned) from its branch name, the same
   * `arbor/<campaign_id>/<node_id>` convention `acquireLease` writes. A
   * campaign_id containing `/` is out of scope (unambiguous parsing isn't
   * possible from the branch string alone, same limitation the class doc
   * on `registeredWorktrees` already notes for the directory-name form);
   * falls back to the worktree's own directory name under a synthetic
   * `_orphan` campaign so preservation still has somewhere durable to go.
   */
  private orphanIdentity(path: string, branch: string | null): { campaign_id: string; node_id: string } {
    if (branch !== null && branch.startsWith("arbor/")) {
      const rest = branch.slice("arbor/".length);
      const slash = rest.indexOf("/");
      if (slash > 0) return { campaign_id: rest.slice(0, slash), node_id: rest.slice(slash + 1) };
    }
    return { campaign_id: "_orphan", node_id: basename(path) };
  }

  /**
   * An orphan has no lease record, so there is no authoritative
   * `starting_commit` to diff a preservation patch against. Best available
   * baseline, in order: (1) the merge-base of the orphan's HEAD and the
   * current release target (what "un-integrated since" should mean for a
   * normal lease too), (2) the orphan branch's own root commit (still
   * correct — a full-history patch — just not minimal), (3) fail closed:
   * return "HEAD" itself, which makes `preserveWork` see an empty
   * patch/bundle and report failure, so `decideAndPreserve` RETAINS the
   * orphan instead of ever destroying it without a real baseline.
   */
  private approximateOrphanStartingCommit(path: string): string {
    const targetRes = this.git(["rev-parse", "HEAD"]);
    if (targetRes.status === 0) {
      const targetSha = targetRes.stdout.trim();
      this.gitAt(path, ["fetch", "--quiet", "--no-tags", this.repoRoot, targetSha]);
      const mb = this.gitAt(path, ["merge-base", targetSha, "HEAD"]);
      if (mb.status === 0) {
        const sha = mb.stdout.trim();
        if (sha) return sha;
      }
    }
    const root = this.gitAt(path, ["rev-list", "--max-parents=0", "HEAD"]);
    if (root.status === 0) {
      const first = root.stdout.split("\n").map((line) => line.trim()).find(Boolean);
      if (first) return first;
    }
    return "HEAD";
  }

  /**
   * Reclaim one orphaned managed worktree and its `arbor/*` branch — after
   * preserving any un-integrated work it holds. Same "preserve before
   * destroy" contract as `releaseLease` (`decideAndPreserve`), just without
   * a lease record to source identity/starting_commit from (see
   * `orphanIdentity`/`approximateOrphanStartingCommit`).
   *
   * Removal success is confirmed by re-querying git rather than trusting an
   * exit status: `git worktree remove` fails when the directory has already
   * been deleted by hand, which `git worktree prune` is what actually
   * clears.
   */
  private reclaimOrphan(path: string, branch: string | null): { removed: boolean; preserved: boolean; retainedForSafety: boolean; detail: string } {
    let preserved = false;
    let manifestNote = "";
    if (existsSync(path)) {
      const identity = this.orphanIdentity(path, branch);
      const startingCommit = this.approximateOrphanStartingCommit(path);
      const decision = this.decideAndPreserve({
        path,
        branch: branch ?? `(detached:${identity.node_id})`,
        campaign_id: identity.campaign_id,
        node_id: identity.node_id,
        starting_commit: startingCommit,
      });
      if (!decision.safe) {
        return { removed: false, preserved: false, retainedForSafety: true, detail: `orphan retained rather than destroyed: ${decision.reason}` };
      }
      if ("manifest_path" in decision) {
        preserved = true;
        manifestNote = `; un-integrated work preserved at ${decision.manifest_path}`;
      }
    }

    if (isInside(this.worktreesDir, path)) bestEffortRemove(path);
    this.git(["worktree", "prune"]);
    if (this.registeredWorktrees()?.has(path) !== false) {
      return { removed: false, preserved, retainedForSafety: false, detail: "git still registers the worktree after remove and prune; left in place" };
    }
    // Only ever a branch this manager could have created. A worktree that
    // someone checked a real branch out into must not lose that branch.
    if (branch !== null && branch.startsWith("arbor/")) {
      this.git(["branch", "-D", branch]);
      return { removed: true, preserved, detail: `worktree and branch ${branch} reclaimed after the orphan grace period${manifestNote}`, retainedForSafety: false };
    }
    return {
      removed: true,
      preserved,
      retainedForSafety: false,
      detail: branch === null
        ? `worktree reclaimed after the orphan grace period (detached HEAD; no branch to delete)${manifestNote}`
        : `worktree reclaimed after the orphan grace period; branch ${branch} is not an arbor/* branch and was kept${manifestNote}`,
    };
  }

  /**
   * U4: cleanup after a failed `detachObjectDatabase` call, once `git
   * worktree add` has already succeeded. `detachObjectDatabase` always
   * replaces the linked worktree's `.git` pointer FILE with a real `.git`
   * DIRECTORY (via `git init`) before it can fail on the fetch/update-ref/
   * reset steps that follow, so by the time this runs the checkout is no
   * longer a linked worktree Git recognizes as removable: `git worktree
   * remove --force <path>` then fails with "validation failed, cannot
   * remove working tree: '<path>/.git' is not a .git file, error code 10",
   * leaving the registered worktree and its `arbor/<campaign>/<node>`
   * branch behind forever (a subsequent `git branch -D` also fails, since
   * the branch is still "used by worktree"). Removing the directory
   * directly and pruning git's stale registration before deleting the
   * branch — the same sequence `releaseLease`/`reclaimOrphan` already use
   * for detached checkouts — succeeds regardless of whether `.git` is a
   * pointer file or a real directory. Best-effort: git may already agree
   * the branch doesn't exist (e.g. `worktree add` itself failed to detach).
   */
  private cleanupFailedAcquire(path: string, branch: string): void {
    if (isInside(this.worktreesDir, path)) bestEffortRemove(path);
    this.git(["worktree", "prune"]);
    this.git(["branch", "-D", branch]);
  }

  private revParse(ref: string): string {
    const res = this.git(["rev-parse", ref]);
    return res.status === 0 ? res.stdout.trim() : ref;
  }

  /**
   * Defect #5 / B1 (shallow-clone preflight): `detachObjectDatabase` fetches
   * `commit` FROM `repoRoot` (directly, and indirectly via
   * `ensureCommitObjectCache`'s fetch of the admitted-commit object store). Git
   * refuses to serve as a fetch SOURCE at all once it is a shallow clone —
   * "rejected <sha> because shallow roots are not allowed to be updated" —
   * even for a commit that is well within its shallow window (e.g. HEAD
   * itself). That fetch exits 0 despite the rejection (only a warning is
   * printed) and leaves FETCH_HEAD empty, so the failure only actually
   * surfaces several steps later as an opaque `update-ref`/`reset --hard`
   * failure deep in worktree creation, after a worktree and branch have
   * already been created. An earlier, narrower version of this check only
   * verified that `commit` itself was reachable via `cat-file -e` in
   * `repoRoot` — which passes for HEAD in exactly this failing scenario, so
   * it never caught it. Any shallow `repoRoot` is unusable as a fetch
   * source, independent of which commit is requested, so check shallowness
   * alone and fail fast with an actionable message before any worktree or
   * branch is created.
   */
  private assertCommitAvailableForWorktree(commit: string): void {
    const shallow = this.git(["rev-parse", "--is-shallow-repository"]);
    if (shallow.status !== 0 || shallow.stdout.trim() !== "true") return;
    throw new Error(
      `arbor worktree: repository is a shallow clone; worktree isolation cannot fetch the admitted commit ${commit} — run \`git -C ${this.repoRoot} fetch --unshallow\` and retry`,
    );
  }

  private commitObjectCachePath(commit: string): string {
    // The caller normally supplies a full object id. Keep the path confined
    // even when a test or recovery caller supplies a symbolic revision.
    const safe = commit.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return join(this.objectCacheDir, `admitted-${safe}.git`);
  }

  /**
   * Defect #6 (~1.3GB/node object duplication): one shared, commit-scoped
   * bare object store, fetched from `repoRoot` at most once per distinct
   * admitted commit, instead of every node re-fetching the full ancestor set
   * from `repoRoot` over git's transport. Returns the store's path on
   * success, or null to fall back to a direct `repoRoot` fetch (this is an
   * optimization; its failure must never block worktree creation).
   *
   * Isolation note: each store only ever holds the ancestry of the one
   * immutable commit named in its path after that commit was admitted — never
   * arbitrary `repoRoot` refs, sibling branches, or future commits.
   * That is the same bound `detachObjectDatabase`'s per-node fetch already
   * enforced. Reuse across campaigns at the exact same object id widens no
   * visibility: every consumer could already fetch that identical ancestry.
   * A node's refs, index, and working tree remain exclusively its own;
   * alternates grant no visibility into those. This therefore does not reopen
   * the original linked-worktree vulnerability (exposure to the live upstream
   * ref/object graph).
   */
  private ensureCommitObjectCache(commit: string): string | null {
    const cachePath = this.commitObjectCachePath(commit);
    if (!existsSync(cachePath)) {
      try {
        mkdirSync(dirname(cachePath), { recursive: true });
      } catch {
        return null;
      }
      if (this.git(["init", "--bare", "-q", cachePath]).status !== 0) return null;
    }
    if (this.gitAt(cachePath, ["cat-file", "-e", `${commit}^{commit}`]).status === 0) return cachePath;
    const fetched = this.gitAt(cachePath, ["fetch", "--quiet", "--no-tags", this.repoRoot, commit]);
    // A local upload-pack can finish writing and indexing the complete pack
    // yet fail to exit before the subprocess ceiling (observed on this repo's
    // 180 MB admitted ancestry). Treat the object database as authoritative:
    // if the exact commit is now readable, keep the completed cache instead
    // of immediately repeating the same expensive transfer from repoRoot.
    if (fetched.status !== 0 && this.gitAt(cachePath, ["cat-file", "-e", `${commit}^{commit}`]).status !== 0) return null;
    // Keep the fetched commit reachable via a real ref so a future `git gc`
    // in the shared store cannot collect it before another node references
    // it (a bare fetch alone leaves the commit only under FETCH_HEAD, which
    // the next fetch overwrites).
    if (this.gitAt(cachePath, ["update-ref", `refs/arbor-cache/${commit}`, commit]).status !== 0) return null;
    return cachePath;
  }

  private detachObjectDatabase(path: string, branch: string, startingCommit: string): boolean {
    const gitPointer = join(path, ".git");
    try {
      if (!existsSync(gitPointer)) return false;
      unlinkSync(gitPointer);
    } catch {
      return false;
    }
    if (this.gitAt(path, ["init", "-q"]).status !== 0) return false;
    // Reference the admitted commit's shared object store (when available) via git
    // alternates before fetching, so objects it already holds are recognized
    // and never re-written into this node's own store — see
    // `ensureCommitObjectCache`'s isolation note. A cache-setup failure
    // just falls back to fetching directly from `repoRoot`, exactly as
    // before this optimization existed.
    const cachePath = this.ensureCommitObjectCache(startingCommit);
    let cacheAttached = false;
    if (cachePath !== null) {
      try {
        mkdirSync(join(path, ".git", "objects", "info"), { recursive: true });
        writeFileSync(join(path, ".git", "objects", "info", "alternates"), `${join(cachePath, "objects")}\n`, "utf-8");
        cacheAttached = true;
      } catch {
        // Alternates are an optimization; the direct fetch below still works.
      }
    }
    if (cacheAttached) {
      // The exact admitted commit and its ancestry are already addressable via
      // alternates. A second `git fetch` only recreates FETCH_HEAD and can
      // repeat the full transfer under lock contention; point the isolated
      // branch directly at that immutable object instead.
      if (this.gitAt(path, ["update-ref", `refs/heads/${branch}`, startingCommit]).status !== 0) return false;
      if (this.gitAt(path, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]).status !== 0) return false;
      if (this.gitAt(path, ["reset", "--hard", "-q", startingCommit]).status !== 0) return false;
      const observedHead = this.gitAt(path, ["rev-parse", "HEAD"]);
      return observedHead.status === 0 && observedHead.stdout.trim() === startingCommit;
    }
    const fetchSource = this.repoRoot;
    // A one-ref fetch transfers the admitted commit and its ancestors, but no
    // sibling/future refs. `--no-tags` prevents tags from reopening that path.
    // With alternates wired above, any object already visible through them is
    // skipped rather than duplicated on disk, so this is cheap for every node
    // after the first one in a campaign.
    if (this.gitAt(path, ["fetch", "--quiet", "--no-tags", fetchSource, startingCommit]).status !== 0) return false;
    if (this.gitAt(path, ["update-ref", `refs/heads/${branch}`, "FETCH_HEAD"]).status !== 0) return false;
    if (this.gitAt(path, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]).status !== 0) return false;
    if (this.gitAt(path, ["reset", "--hard", "-q", "FETCH_HEAD"]).status !== 0) return false;
    // A lease is evidence that the checkout starts at the admitted commit,
    // not merely that the fetch/reset commands returned zero. Verify the
    // resulting object identity before allowing the isolation gate to pass.
    const observedHead = this.gitAt(path, ["rev-parse", "HEAD"]);
    return observedHead.status === 0 && observedHead.stdout.trim() === startingCommit;
  }
}

/**
 * Exclusively create `path` with `content`, fsync'd before the descriptor is
 * closed. Returns false (rather than throwing) only on EEXIST, since that is
 * the one outcome every caller needs to branch on; every other error
 * (EACCES, ENOSPC, …) propagates, since silently treating those as "someone
 * else has it" would misreport a real environmental failure as lease
 * contention.
 */
function createExclusiveFile(path: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Write `content` to `targetPath` crash-safely: a sibling temp file (never
 * ending in `.json`, so `reconcileLeases`'s `*.json` scan can never parse a
 * half-written temp file as a lease) is written, fsync'd, and closed, THEN
 * renamed over the target. `rename(2)` within the same directory is atomic,
 * so a reader can never observe a partially written target file, and a
 * process that crashes mid-write leaves only an orphaned temp file (cleaned
 * up here on any failure) instead of a truncated lease/marks file.
 */
function atomicWriteFile(targetPath: string, content: string): void {
  const dir = dirname(targetPath);
  const tmp = join(dir, `.${basename(targetPath)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  let renamed = false;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, targetPath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup of a failed write; nothing to unwind further.
      }
    }
  }
}

function isWorktreeLease(value: unknown): value is WorktreeLease {
  if (!value || typeof value !== "object") return false;
  const lease = value as Record<string, unknown>;
  const legacyShape = ["node_id", "campaign_id", "branch", "path", "acquired_at", "acquired_by", "starting_commit"].every(
    (key) => typeof lease[key] === "string",
  ) && typeof lease.active === "boolean";
  if (!legacyShape) return false;
  const hasRecoveryFields = lease.operation_id !== undefined || lease.lease_id !== undefined || lease.expires_at !== undefined;
  const validOwner = lease.owner_pid === undefined || (Number.isSafeInteger(lease.owner_pid) && (lease.owner_pid as number) > 0);
  const validIdentity = (lease.owner_start_ticks === undefined || typeof lease.owner_start_ticks === "string")
    && (lease.owner_boot_id === undefined || typeof lease.owner_boot_id === "string");
  return validOwner && validIdentity && (!hasRecoveryFields || (typeof lease.operation_id === "string" && lease.operation_id.length > 0
    && typeof lease.lease_id === "string" && lease.lease_id.length > 0
    && typeof lease.expires_at === "string" && !Number.isNaN(Date.parse(lease.expires_at))));
}

/**
 * Best-effort recursive remove: swallows any error, not only ENOENT.
 * `fs.rmSync`'s `force` option only suppresses "path does not exist" — a
 * permission error (EACCES) on a file left behind inside a worktree (a
 * read-only artifact from a build tool, a locked file, an unusual mount)
 * still throws. Every call site that removes a manager-owned worktree
 * directory documents itself as "best-effort" and promises the lease file is
 * always dropped afterward regardless of whether the directory actually went
 * away; an uncaught exception here would break that promise silently (and,
 * for `releaseLease` specifically, escape a caller's `finally` block
 * uncaught). Callers that need to know whether removal actually succeeded
 * already re-verify via git registration or `existsSync`, never by trusting
 * that this function didn't throw.
 */
function bestEffortRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort by design; see doc comment above.
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

/** Read directory entry names (no full readdir needed). */
function readDirNames(dir: string): string[] {
  return readdirSync(dir);
}
