/**
 * Where the stop guard's per-session state and release journal live.
 *
 * THIS IS A RELOCATION, NOT A NEW THING. `gate:stop-guard-releases` used to
 * `import { resolveStateDir } from "./hooks/stop-guard.mjs"` — a gate whose
 * whole job is auditing the breaker's releases was importing the breaker, and
 * deleting the breaker would have died with `ERR_MODULE_NOT_FOUND` at module
 * load and turned the stop tier red. The native replacement
 * (`packages/arbor-mcp/src/hooks/stop-battery.ts`) resolves the same directory,
 * so the path lives here instead: a module neither the gate nor the breaker
 * owns.
 *
 * The location itself is unchanged and deliberate: under the git COMMON dir,
 * shared across worktrees, never in the working tree. State in the working tree
 * would be committed, and a guard that dirties the tree it measures invalidates
 * its own cache — which is exactly the bug the native half's tests caught.
 */

import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

export const STATE_DIR_SEGMENTS = ["arbor", "stop-guard"];

/**
 * `ARBOR_STOP_GUARD_STATE_DIR` wins, exactly as the deleted module honoured
 * it — a test needs to redirect the state somewhere the repository does not
 * measure. Otherwise the git common dir resolves the location, falling back to
 * `.git` when git is unavailable rather than throwing: a guard that cannot
 * start is worse than one that starts in the default place.
 */
export function resolveStateDir(repoRoot, env = process.env) {
  const override = env.ARBOR_STOP_GUARD_STATE_DIR;
  if (override) return override;
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot, encoding: "utf-8" });
  const gitDir = result.status === 0 ? result.stdout.trim() : ".git";
  const abs = isAbsolute(gitDir) ? gitDir : resolvePath(repoRoot, gitDir);
  return join(abs, ...STATE_DIR_SEGMENTS);
}

/** The per-session state file, and the journal path, derived from one place. */
export const statePath = (stateDir, sessionId) => join(stateDir, `${sessionId}.json`);
export const releasesPath = (stateDir) => join(stateDir, "releases.jsonl");