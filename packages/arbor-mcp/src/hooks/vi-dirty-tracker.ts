/**
 * `observe.vi-dirty-tracker` — the native replacement for the deleted
 * `.claude/skills/repository-visual-intelligence/hooks/vi-dirty-track.sh`, and
 * the SOLE WRITER of `.visual-intelligence/.dirty`.
 *
 * WHY THIS FILE IS NOT OPTIONAL. `.dirty` remembers a path that was edited AND
 * THEN COMMITTED, which `git status` cannot show — that is its entire reason to
 * exist. Two read-side handlers depend on it (`inject.vi-freshness`'s
 * `dirty_count` and `inject.vi-graph-debt`'s debt count, which is why both
 * ask `dirtyIntersection` for it), and only `scripts/vi-refresh.mjs` clears it. So deleting the writer without this handler would not fail loudly:
 * both readers would go permanently blind and report "clean" forever, the exact
 * defect class this devolution exists to prevent. This repository has a recorded
 * instance of a hook emitting a confident fixed verdict for ~42 sessions after
 * it stopped measuring.
 *
 * WHY THE EVENT FIRES BEFORE THE CALL, NOT AFTER. The script was `PostToolUse`.
 * The `tool_write` observe event fires from the tool-INPUT side, in the bus's
 * preflight seam, because the post-execution audit path is content-free BY
 * DESIGN (`NativeToolAuditRecord` carries no path, and widening it to carry one
 * would break a deliberate privacy boundary). So `.dirty` records paths this
 * session ATTEMPTED — a superset of paths it changed. Both consumers intersect
 * with `git status`, so an attempt that then failed contributes nothing.
 *
 * EVERY SKIP RULE, PRESERVED. The graph's own output under
 * `.visual-intelligence/` is not drift; a path outside the repository is not
 * ours; and the whole handler is inert in a repository with no
 * `.visual-intelligence/`, which is what makes global installation safe. All
 * three are silent, exactly as the script's `quiet` was.
 *
 * WHAT WAS DROPPED, DELIBERATELY. The script's payload chain was
 * `.file_path // .notebook_path // .path`. There is no native `notebook_path`:
 * `file.write` and `file.patch` are the only path-carrying write tools this
 * host has, and neither declares that field. The case is dropped rather than
 * given an invented equivalent, because a fallback key no tool populates is a
 * branch that can never be exercised and so can never be verified.
 *
 * THE WRITE IS APPEND-ONLY AND SYNC. One `appendFileSync` guarded by a
 * read-then-compare, so a path is recorded at most once and never re-sorted.
 * That matches the readers, which count non-empty lines and intersect with
 * `git status`, and it keeps the handler synchronous: the observe lane measures
 * a sync handler after return, which is a real bound for two small file
 * operations and would be a lie for anything larger.
 */
import { appendFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HookObserveContext, HookObserveHandler } from "./contracts.js";
import { HOOK_MAX_DETAIL_VALUE_BYTES } from "./contracts.js";
import { currentGovernedRoot } from "./governance-tropisms.js";

const VI_DIR = ".visual-intelligence";
const DIRTY_FILE = ".dirty";

/** The script's `realpath -m`: resolve symlinks in what exists, normalise lexically what does not. */
const realpathOrResolve = (target: string): string => {
  try { return realpathSync.native(target); } catch { return resolve(target); }
};

/**
 * The script's repo-relative POSIX path, or `null` for a target that is the
 * graph's own output or lies outside the repository.
 *
 * Containment is tested on the RELATIVE form rather than by stripping a `$cwd/`
 * prefix, so a path that escapes through `..` reads as outside instead of
 * passing as a relative path — the string-prefix form would classify
 * `<repo>/../elsewhere.md` as repo-relative after `realpath -m` had already
 * resolved it outside.
 */
const repoRelativeTarget = (root: string, target: string): string | null => {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  if (rel === VI_DIR || rel.startsWith(`${VI_DIR}${sep}`)) return null;
  return rel.split(sep).join("/");
};

export const viDirtyTracker: HookObserveHandler = (context: HookObserveContext): void => {
  const path = context.detail.path;
  if (context.event !== "tool_write" || path === undefined || path === "") return;
  // A path sitting exactly AT the bound may be a head slice rather than the
  // whole value. Recording a truncated path is worse than recording nothing:
  // it can never intersect `git status`, so it is drift that reports as
  // permanent cleanliness. The file tools refuse a `path` this long, so this is
  // the belt to that braces, and the honest direction is to drop what cannot be
  // vouched for.
  if (path.length >= HOOK_MAX_DETAIL_VALUE_BYTES) return;
  const root = currentGovernedRoot();
  if (statSync(join(root, VI_DIR), { throwIfNoEntry: false })?.isDirectory() !== true) return;
  const rel = repoRelativeTarget(root, realpathOrResolve(isAbsolute(path) ? path : join(root, path)));
  if (rel === null) return;
  const dirty = join(root, VI_DIR, DIRTY_FILE);
  let existing = "";
  try { existing = readFileSync(dirty, "utf8"); } catch { existing = ""; }
  if (existing.split("\n").includes(rel)) return;
  appendFileSync(dirty, `${rel}\n`, "utf8");
};
