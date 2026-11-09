/**
 * `veto.vi-readonly-guard` — the native replacement for the deleted
 * `.claude/skills/repository-visual-intelligence/hooks/vi-readonly-guard.sh`.
 *
 * WHY IT EXISTS. That skill diagnoses the repository graph; it does not repair
 * it. While an extraction run is ARMED, anything the run itself wrote under
 * `.visual-intelligence/` must be untouchable by hand, or the graph the
 * operator is reading stops being the graph the tooling derived.
 *
 * ARMED MEANS A SENTINEL. `.visual-intelligence/.vi-active` existing is the
 * whole predicate. That is what makes the guard safe to install globally: a
 * repository that never runs the skill has no sentinel, so this handler
 * returns `allow` on every call and costs one `stat`.
 *
 * WHY IT FAILS OPEN, AND WHERE. Four conditions allow unconditionally: the
 * repository does not use the skill, the sentinel is absent, the sentinel is
 * STALE, and the bus could not read a path. The stale case is the important
 * one. A leaked sentinel bricks all editing in the repository until a human
 * finds a dotfile they have no reason to suspect, and a leaked sentinel is the
 * EXPECTED failure rather than an exotic one — the sentinel is removed at P14,
 * which a crashed, cancelled or context-limited run never reaches. Nothing else
 * in the skill would report it, because the guard's own refusal reads exactly
 * like the guard working. So the sentinel expires and debris is ignored.
 *
 * WHAT THE DELETED SCRIPT COULD DO AND A HANDLER CANNOT. The script could exit
 * non-zero, and it could exit non-zero ACCIDENTALLY: three unguarded `cat`/`jq`
 * calls sat under `set -euo pipefail`, so a malformed payload or a jq that
 * vanished mid-run turned a no-op into a hard failure with no decision in it.
 * A handler has no exit code to get wrong — it returns `{allow}` or a refusal,
 * and the bus decides what to do with an exception. That failure mode is gone
 * by construction rather than by having found and fixed all three sites.
 *
 * CONTAINMENT. Both sides are resolved before they are compared, so `..` and a
 * symlinked `.visual-intelligence` are caught rather than prefix-matched. The
 * bus hands the path over already normalised to a repository-relative one, but
 * a payload can still carry a traversal the TOOL will later reject, and a guard
 * that stopped resolving would read one as "inside the protected directory".
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HookVetoDecision, HookVetoHandler } from "./contracts.js";
import { currentGovernedRoot } from "./governance-tropisms.js";

const VI_DIR = ".visual-intelligence";
const VI_ACTIVE = ".vi-active";

/** Four hours, overridable by the same environment variable the script read. */
export const VI_SENTINEL_STALE_SECONDS = 14400;

const staleAfterSeconds = (): number => {
  const configured = Number(process.env.VI_SENTINEL_STALE_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : VI_SENTINEL_STALE_SECONDS;
};

/** The script's `realpath -m`: resolve what exists, normalise lexically what does not. */
const realpathOrResolve = (target: string): string => {
  try { return realpathSync.native(target); } catch { return resolve(target); }
};

/** True when `path` is the protected directory or inside it. */
const isProtected = (root: string, path: string): boolean => {
  const dir = realpathOrResolve(join(root, VI_DIR));
  const target = realpathOrResolve(isAbsolute(path) ? path : join(root, path));
  const rel = relative(dir, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const ARMED_REASON =
  "repository-visual-intelligence read-only guard is active (.visual-intelligence/.vi-active present). " +
  "This skill diagnoses; it does not repair. Writes are restricted to .visual-intelligence/ during a run. " +
  "To make an authorized source change, remove .visual-intelligence/.vi-active first (disarm the guard).";

export const viReadOnlyGuard: HookVetoHandler = (context): HookVetoDecision => {
  const path = context.tool_input.path;
  if (path === "") return { allow: true };
  const root = currentGovernedRoot();
  if (statSync(join(root, VI_DIR), { throwIfNoEntry: false })?.isDirectory() !== true) return { allow: true };
  const armedAtMs = statSync(join(root, VI_DIR, VI_ACTIVE), { throwIfNoEntry: false })?.mtimeMs;
  if (armedAtMs === undefined) return { allow: true };
  if (Date.now() / 1000 - armedAtMs / 1000 > staleAfterSeconds()) return { allow: true };
  return isProtected(root, path) ? { allow: true } : { allow: false, reason: ARMED_REASON };
};
