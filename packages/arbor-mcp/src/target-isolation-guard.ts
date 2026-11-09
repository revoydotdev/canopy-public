/**
 * Fail-closed target-isolation guard: decide whether ANY campaign — self-
 * hosting (`arbor selfhost`) or the generic `arbor task`/`arbor run` path —
 * may run its worktree/lease machinery directly against a given directory.
 *
 * Extracted out of `selfhost.ts` (which imports `createCliRuntime` from
 * `cli.ts`) so `cli.ts` can reuse the exact same guard `selfhost.ts` was
 * built around without a circular `cli.ts` <-> `selfhost.ts` import: this
 * module imports neither.
 *
 * `evaluateTargetSafety` is a pure decision core over an already-resolved
 * path and branch name — no filesystem or process access, so its refusal
 * logic is directly unit-testable. `checkTargetIsolationSafety` is the thin
 * IO shell (realpath + `git rev-parse`) that feeds it.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, resolve as resolvePath } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// ============================================================
// ISOLATION GUARD — checked before anything else exists.
// ============================================================

/**
 * The single production checkout a campaign must never mutate directly.
 *
 * DERIVED, not hardcoded. This was previously a literal absolute string
 * under one developer's home directory, which meant
 * this guard layer silently matched nothing on any other machine. A safety
 * check that quietly stops applying when the environment changes is worse
 * than no check, because the reader still counts it as protection. Found by
 * an independent audit.
 *
 * Every linked worktree shares one common git directory; the primary checkout
 * is its parent. `git rev-parse --git-common-dir` therefore identifies the
 * primary checkout from anywhere in the worktree set, on any machine.
 *
 * Returns null when it cannot be determined. Callers must treat null as
 * "this layer could not evaluate", never as "allowed" — the branch and
 * worker-checkout checks remain independent defenses either way.
 */
export function resolvePrimaryCheckout(from: string): string | null {
  try {
    const commonDir = execFileSync("git", ["-C", from, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!commonDir) return null;
    const absolute = isAbsolute(commonDir) ? commonDir : resolvePath(from, commonDir);
    // ".git" -> the checkout that owns it. A bare repo has no primary checkout.
    return basename(absolute) === ".git" ? dirname(absolute) : null;
  } catch {
    return null;
  }
}
/**
 * D2 (2026-08-24 selfhost dogfood): the default forbidden path used to be
 * `resolvePrimaryCheckout(process.cwd())` -- the primary checkout of
 * WHATEVER DIRECTORY THE PROCESS HAPPENS TO BE INVOKED FROM. That makes any
 * disposable clone "the primary checkout" of itself the moment selfhost is
 * invoked from inside it (the ordinary way to self-host a candidate build:
 * clone, build, run `arbor-mcp selfhost --target .` from within the clone),
 * so `forbidden_primary_checkout` fired unconditionally and selfhosting was
 * structurally unreachable without contorting the invocation to run from a
 * non-git directory.
 *
 * The hazard this guard exists to stop is the HARNESS'S OWN source
 * checkout -- the one live checkout whose `.arbor/` governance state and
 * uncommitted work a campaign must never touch -- not "whichever repo the
 * invoker happens to be standing in". `resolveHarnessSourceCheckout()`
 * derives that from where the RUNNING CODE was loaded from
 * (`import.meta.url`), independent of `process.cwd()`. A disposable clone
 * built and invoked from its own tree resolves its own primary checkout
 * here too (its running code genuinely lives inside it) -- correctly, since
 * a clone-of-the-harness invoked in place is exactly the case this default
 * must keep refusing on its own turf; the fix is for selfhosting to invoke
 * the harness binary from OUTSIDE the disposable clone (e.g. a linked
 * worktree of the real harness checkout, whose `resolveHarnessSourceCheckout`
 * resolves to the real primary via the shared git-common-dir, not to the
 * clone) with `--target <clone>`, which this default now permits.
 */
function primaryCheckoutPaths(): readonly string[] {
  const primary = resolveHarnessSourceCheckout();
  return primary ? [primary] : [];
}

export const FORBIDDEN_BRANCHES: readonly string[] = Object.freeze(["master", "main"]);
/** Sibling parallel-work worktrees (`revoy2-w4a`/`b`/`c`, ...) — also off-limits as a direct target. */
export const FORBIDDEN_WORKER_BASENAME_PATTERN = /^revoy2-w4/;

export type SelfhostGuardErrorKind =
  | "forbidden_branch"
  | "forbidden_primary_checkout"
  | "forbidden_worker_checkout"
  | "target_not_a_git_repo";

export interface SelfhostGuardError {
  readonly kind: SelfhostGuardErrorKind;
  readonly message: string;
  readonly target: string;
}

export interface IsolationGuardConfig {
  readonly forbiddenBranches?: readonly string[];
  readonly forbiddenPaths?: readonly string[];
  readonly forbiddenBasenamePattern?: RegExp;
}

interface ResolvedIsolationGuardConfig {
  readonly forbiddenBranches: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly forbiddenBasenamePattern: RegExp;
}

function resolveGuardConfig(config: IsolationGuardConfig): ResolvedIsolationGuardConfig {
  return {
    forbiddenBranches: config.forbiddenBranches ?? FORBIDDEN_BRANCHES,
    // Derived per call rather than from a module constant: the primary
    // checkout depends on where the process is running, and a stale module
    // constant is what made this layer inert off one machine. A null result
    // contributes no forbidden path — it never widens what is allowed,
    // because the branch and worker-checkout checks are independent.
    forbiddenPaths: config.forbiddenPaths ?? primaryCheckoutPaths(),
    forbiddenBasenamePattern: config.forbiddenBasenamePattern ?? FORBIDDEN_WORKER_BASENAME_PATTERN,
  };
}

/**
 * Pure decision core: given an already-resolved absolute path and its
 * current branch (or `null` when the branch could not be determined — e.g.
 * not a git repo, detached-with-no-name edge cases are handled by the IO
 * shell below), decide whether a campaign may target it directly.
 *
 * No filesystem or process access happens in this function — every branch is
 * driven purely by its inputs, so the refusal logic itself is exercised
 * without a real repo, real branch, or real path on disk.
 */
export function evaluateTargetSafety(
  input: { resolvedPath: string; branch: string | null },
  config: IsolationGuardConfig = {},
): { ok: true } | { ok: false; error: SelfhostGuardError } {
  const resolved = resolveGuardConfig(config);

  if (input.branch === null) {
    return {
      ok: false,
      error: {
        kind: "target_not_a_git_repo",
        target: input.resolvedPath,
        message: `${input.resolvedPath} does not resolve to a usable git repository (could not read HEAD)`,
      },
    };
  }
  if (resolved.forbiddenBranches.includes(input.branch)) {
    return {
      ok: false,
      error: {
        kind: "forbidden_branch",
        target: input.resolvedPath,
        message: `refusing: target is checked out on '${input.branch}', a forbidden branch (${resolved.forbiddenBranches.join(", ")})`,
      },
    };
  }
  if (resolved.forbiddenPaths.includes(input.resolvedPath)) {
    return {
      ok: false,
      error: {
        kind: "forbidden_primary_checkout",
        target: input.resolvedPath,
        message: `refusing to run directly against the primary checkout ${input.resolvedPath}`,
      },
    };
  }
  if (resolved.forbiddenBasenamePattern.test(basename(input.resolvedPath))) {
    return {
      ok: false,
      error: {
        kind: "forbidden_worker_checkout",
        target: input.resolvedPath,
        message: `refusing to run directly against a worker checkout ${input.resolvedPath}`,
      },
    };
  }
  return { ok: true };
}

/** Read a repo's current branch via `git rev-parse --abbrev-ref HEAD`, or `null` on any failure. */
export function readCurrentBranch(repoPath: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (result.status !== 0) return null;
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : null;
}

/**
 * IO shell around `evaluateTargetSafety`: resolves the real filesystem path
 * (following symlinks — a target reached via a different-looking path than
 * the forbidden constants must not slip through) and reads the current
 * branch, then applies the pure guard. This is the FIRST thing
 * `runSelfhostCampaign` calls — before a worktree is planned, before a
 * runtime is composed, before an executor exists — and (isolation-guard gap)
 * the FIRST thing the generic `arbor task`/`arbor run` production campaign
 * runner in `cli.ts` calls before it constructs its own cwd-rooted
 * `WorktreeManager`.
 */
export function checkTargetIsolationSafety(
  targetPath: string,
  config: IsolationGuardConfig = {},
): { ok: true; resolvedPath: string; branch: string } | { ok: false; error: SelfhostGuardError } {
  const requested = resolve(targetPath);
  if (!existsSync(requested)) {
    return {
      ok: false,
      error: { kind: "target_not_a_git_repo", target: requested, message: `${requested} does not exist` },
    };
  }
  const resolvedPath = realpathSync(requested);
  const branch = readCurrentBranch(resolvedPath);
  const decision = evaluateTargetSafety({ resolvedPath, branch }, config);
  if (!decision.ok) return decision;
  return { ok: true, resolvedPath, branch: branch! };
}

/**
 * The git checkout the RUNNING HARNESS's own source lives in, or null when
 * there is none. A dev-installed arbor runs from its source repo — that repo
 * is the self-hosting hazard the generic-path guard exists for. A packaged
 * install runs from node_modules; walking git metadata from there would find
 * the USER's repository and misidentify it as the harness's own, so a
 * node_modules location is treated as "no source checkout".
 */
export function resolveHarnessSourceCheckout(): string | null {
  const moduleDir = dirname(new URL(import.meta.url).pathname);
  if (moduleDir.split("/").includes("node_modules")) return null;
  return resolvePrimaryCheckout(moduleDir);
}

/**
 * Guard for the GENERIC `arbor task`/`arbor run` path. Running a campaign
 * from a repository's own live checkout is the product's normal daily-driver
 * flow — specialists work in isolated worktrees and adoption is fenced — so
 * an arbitrary target repo is NOT refused for being on master/main or for
 * being a primary checkout. (Wiring the full selfhost guard here refused
 * every ordinary repo; caught by the native e2e suite the same day it
 * landed.) The one hazard this path shares with `arbor selfhost` is the
 * recursion case: the target IS the harness's own source checkout, where
 * campaign writes and the harness's live `.arbor`/governance state collide.
 * Only that case gets the full selfhost strictness.
 */
export function checkGenericTargetSafety(
  targetPath: string,
  options: { readonly harnessCheckout?: string | null } = {},
): { ok: true } | { ok: false; error: SelfhostGuardError } {
  const harnessCheckout = options.harnessCheckout === undefined ? resolveHarnessSourceCheckout() : options.harnessCheckout;
  if (harnessCheckout === null) return { ok: true };
  const requested = resolve(targetPath);
  if (!existsSync(requested)) return { ok: true }; // downstream machinery reports the missing path in its own terms
  const resolvedPath = realpathSync(requested);
  if (resolvedPath !== harnessCheckout && resolvePrimaryCheckout(resolvedPath) !== harnessCheckout) return { ok: true };
  return checkTargetIsolationSafety(targetPath, { forbiddenPaths: [harnessCheckout] });
}
