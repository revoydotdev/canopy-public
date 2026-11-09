/**
 * Generic post-worktree dependency provisioning.
 *
 * `git worktree add` creates an empty checkout with no installed
 * dependencies. Any verification command run inside it (a specialist's
 * acceptance command, a selfhost campaign's own build/test/gate lane) dies
 * on missing `node_modules` unless something installs them first -- the
 * repo's `.gitignore` header once floated a node_modules-symlink idea for
 * this and never implemented it. This module is that implementation, shared
 * by every worktree-creating caller (`WorktreeManager.acquireLease`'s
 * per-node leases here, `arbor-mcp`'s selfhost outer worktree) so the logic
 * lives once rather than drifting between them.
 *
 * Generic by construction: the ecosystem is detected from the worktree's OWN
 * lockfile, never assumed from the host repo (revoy2 happens to use bun, but
 * a worktree created against some other target repo may not).
 *
 * Absence and failure are both typed results, never silence: a worktree with
 * no recognized lockfile is a `"skipped"` outcome, not a swallowed no-op, and
 * a failed install is a `"failed"` outcome that callers must treat as fatal
 * to worktree setup -- never left as a half-usable worktree that merely
 * lacks dependencies.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type PackageEcosystem = "bun" | "npm" | "pnpm" | "yarn";

/** Lockfile -> ecosystem -> install command, checked in this order (first match wins). */
const ECOSYSTEMS: readonly { readonly ecosystem: PackageEcosystem; readonly lockfile: string; readonly argv: readonly [string, ...string[]] }[] = [
  { ecosystem: "bun", lockfile: "bun.lock", argv: ["bun", "install", "--frozen-lockfile"] },
  { ecosystem: "bun", lockfile: "bun.lockb", argv: ["bun", "install", "--frozen-lockfile"] },
  { ecosystem: "npm", lockfile: "package-lock.json", argv: ["npm", "ci"] },
  { ecosystem: "pnpm", lockfile: "pnpm-lock.yaml", argv: ["pnpm", "install", "--frozen-lockfile"] },
  { ecosystem: "yarn", lockfile: "yarn.lock", argv: ["yarn", "install", "--frozen-lockfile"] },
];

/** Generous for a cold cache, but bounded so a hung installer can never wedge worktree creation forever. */
export const DEFAULT_PROVISION_TIMEOUT_MS = 10 * 60 * 1000;

export interface DependencyProvisioningOptions {
  /** Opt out entirely. Still returns a typed `"disabled"` outcome rather than silently no-op'ing. */
  readonly enabled?: boolean;
  readonly timeoutMs?: number;
}

export type DependencyProvisioningOutcome =
  | { readonly status: "disabled" }
  | { readonly status: "skipped"; readonly reason: "no_lockfile" }
  | { readonly status: "installed"; readonly ecosystem: PackageEcosystem; readonly argv: readonly string[]; readonly duration_ms: number }
  | {
      readonly status: "failed";
      readonly ecosystem: PackageEcosystem;
      readonly argv: readonly string[];
      readonly duration_ms: number;
      readonly exit: number | null;
      readonly timed_out: boolean;
      readonly detail: string;
    };

function detectEcosystem(worktreePath: string): { ecosystem: PackageEcosystem; argv: readonly [string, ...string[]] } | null {
  for (const candidate of ECOSYSTEMS) {
    if (existsSync(join(worktreePath, candidate.lockfile))) return { ecosystem: candidate.ecosystem, argv: candidate.argv };
  }
  return null;
}

/**
 * Install a worktree's dependencies from its own lockfile. Never throws --
 * every branch (disabled, no lockfile, installed, failed) is a typed value so
 * a caller can decide, honestly, whether a failed install should fail
 * worktree setup outright (it should: a worktree nothing can verify inside is
 * not usably created).
 */
export function provisionWorktreeDependencies(
  worktreePath: string,
  options: DependencyProvisioningOptions = {},
): DependencyProvisioningOutcome {
  if (options.enabled === false) return { status: "disabled" };
  const detected = detectEcosystem(worktreePath);
  if (detected === null) return { status: "skipped", reason: "no_lockfile" };

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
  const startedAt = Date.now();
  const result = spawnSync(detected.argv[0], detected.argv.slice(1), {
    cwd: worktreePath,
    stdio: "pipe",
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  const duration_ms = Date.now() - startedAt;

  if (result.error) {
    // node sets `error.code === "ETIMEDOUT"` and kills the child when the
    // `timeout` option fires; any other `error` is a spawn failure (e.g. the
    // package manager binary is not installed in this environment).
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      status: "failed", ecosystem: detected.ecosystem, argv: detected.argv, duration_ms,
      exit: null, timed_out: timedOut,
      detail: timedOut ? `dependency install timed out after ${timeoutMs}ms` : result.error.message,
    };
  }
  if (result.status !== 0) {
    return {
      status: "failed", ecosystem: detected.ecosystem, argv: detected.argv, duration_ms,
      exit: result.status, timed_out: false,
      detail: (result.stderr || result.stdout || `${detected.argv.join(" ")} exited ${result.status}`).toString().trim().slice(0, 4_096),
    };
  }
  return { status: "installed", ecosystem: detected.ecosystem, argv: detected.argv, duration_ms };
}
