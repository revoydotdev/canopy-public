/**
 * `inject.vi-freshness` — the native replacement for the deleted
 * `.claude/skills/repository-visual-intelligence/hooks/vi-freshness.sh`, and the
 * SessionStart report of how much of the committed graph can still be believed.
 *
 * WHY THE VERDICT MUST BE A FUNCTION OF ITS INPUTS, WHICH IS NOT A STYLE NOTE.
 * The bus dedupes an injection on `derived_from` (proposal §5.3 rule 2), so a
 * tropism whose derivation does not move is not re-injected — it goes SILENT.
 * That is the anti-lie property working correctly, and it is also this hook's
 * sharpest failure mode: a freshness report that stops measuring does not lie,
 * it disappears, and nothing downstream can tell the difference from a healthy
 * repository. This repository has the recorded precedent for both halves of
 * that — the shell hook that cried `DIVERGED — 42 uncommitted path(s)` at every
 * session start for ~42 sessions against a tree with zero uncommitted paths
 * (ADR-032), and `gate:hook-liveness`, which exists because a hook here once
 * emitted a confident fixed verdict for dozens of sessions after it stopped
 * measuring. So the derivation is built from EVERY input the ladder reads —
 * including `tree_state` and the unavailable-plane list, which both change the
 * body without moving a revision — and a test asserts it moves.
 *
 * ============================================================================
 * THIS REPORTS COMMIT DISTANCE. `inject.governance-orient` DELIBERATELY DOES
 * NOT. THE TWO DIFFERENCES ARE CORRECT AND MUST NOT BE UNIFIED.
 * ============================================================================
 * `governanceOrientTropism`'s own comment (in `governance-tropisms.ts`):
 *   "Plain commit distance from the graph is deliberately not reported: the
 *    healthy state directly after a rebind is already graph=N, HEAD=N+1, so
 *    reporting distance cries wolf against a fully green battery on every
 *    correctly finished cycle. Divergence ... is the condition with no partial
 *    repair, so only that is named."
 *
 * Those are different questions with different costs, and a reader who
 * "fixes" either one to match the other reintroduces a real defect:
 *
 *   - Orientation suppresses distance because distance is EXPECTED and benign
 *     between rebinds. Naming it there trains the reader to skim past the one
 *     session where a graph is genuinely 40 commits behind.
 *   - Freshness reports distance because distance IS the finding. This hook's
 *     entire product is a `behind` count; a version of it that suppressed
 *     distance the way its sibling does would report "stale" forever with no
 *     magnitude, and the reader could not judge whether the committed views are
 *     still worth citing. Suppressing it the other way — reporting distance
 *     from orientation — makes a green post-rebind battery look like drift at
 *     every single session start.
 *
 * Neither is the other one's bug. The difference is: orientation answers "is
 * there damage with no partial repair?", freshness answers "how far behind is
 * the thing I am about to cite?". Do not make them agree.
 *
 * WHAT `dirty_count` IS, AND WHAT IT IS NOT. It is NOT a git-status count. It
 * is the size of the intersection of the append-only session tracker
 * (`.visual-intelligence/.dirty`, written by `observe.vi-dirty-tracker`) with
 * the ACTUAL working tree, scoped to the graphed domain. A tracked-but-since-
 * committed path is not drift; counting the tracker's lines directly is what
 * produced the 42-path false alarm above. It is deliberately NOT
 * `readGovernedPosture`'s `governed_dirty`, which is git status alone and is a
 * different number that would restore the false alarm the intersection removes.
 *
 * EVERY SILENCE IS A VERDICT, AND EVERY SILENCE IS THE SCRIPT'S. This hook
 * says nothing in exactly three states: before it has a manifest to read
 * (`quiet` — also what makes global installation safe outside a repository that
 * uses the skill), on `CURRENT`, and on a `STALE` whose commits missed the
 * graphed domain. The first two are in the ladder; the third is a check after
 * it, because it is a property of the drift rather than of the ladder.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tropism } from "@arbor/prompts";
import { GitAdapter } from "../git-workspace-projection.js";

const VI_DIR = ".visual-intelligence";
const DIRTY_FILE = ".dirty";
const EMPTY: readonly string[] = Object.freeze([]);

/**
 * The graphed domain: the source the graph MODELS and the ADRs it cites. An
 * edit outside it invalidates no structural claim in the committed graph, so
 * it must not raise a `DIVERGED` verdict nor keep a `STALE` one alive.
 */
const GRAPHED_DOMAIN: readonly string[] = Object.freeze(["packages/", "decisions/"]);

/** Matches the sibling session-start tropisms: long enough to survive a skim. */
const SESSION_START_TTL_TURNS = 3;

/**
 * The size of `.dirty` ∩ `git status --porcelain [scope]`, which is what
 * `vi-freshness.sh` and `vi-graph-debt.sh` each computed for themselves, and
 * what their two native replacements compute today.
 *
 * EXTRACTED ONCE, PARAMETERISED BY SCOPE, because the two readers ask
 * different questions of the same file: freshness scopes to the graphed domain
 * (a `docs/` edit is not graph drift), while graph-debt takes everything (a
 * debt report that hid `docs/` edits would under-report the debt it exists to
 * show). An empty `scope` is the unscoped read, and that is the one
 * `inject.vi-graph-debt` passes.
 *
 * The line shapes are the script's exactly: `git status --porcelain`'s first
 * three characters are stripped, an `R` arrow is resolved to the NEW path
 * (`s/.* -> //`, greedy, so the last arrow wins), blank lines are dropped
 * (`grep -ve '^[[:space:]]*$'`), and a survivor must equal a tracked path
 * WHOLE-LINE (`grep -qxF`). Lines are compared untrimmed, because a whole-line
 * fixed match does not ignore trailing whitespace and silently tolerating it
 * would count a path the script would not have.
 */
export function dirtyIntersection(git: GitAdapter, root: string, scope: readonly string[]): readonly string[] {
  const dirtyFile = join(root, VI_DIR, DIRTY_FILE);
  if (!existsSync(dirtyFile)) return EMPTY;
  const tracked = new Set(
    git.run(["-C", root, "status", "--porcelain", "--", ...scope])
      .stdout.split("\n")
      .map((line) => line.slice(3).replace(/^.* -> /u, ""))
      .filter((path) => path !== ""),
  );
  if (tracked.size === 0) return EMPTY;
  return Object.freeze(
    readFileSync(dirtyFile, "utf8")
      .split("\n")
      .filter((line) => !/^\s*$/u.test(line) && tracked.has(line)),
  );
}

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** `.planes` keys the extraction could not establish — `jq '[.planes // {} | to_entries[] | select(.value.status == "unavailable") | .key]'`, in manifest order. */
function unavailablePlanes(planes: unknown): readonly string[] {
  if (typeof planes !== "object" || planes === null) return EMPTY;
  return Object.freeze(
    Object.entries(planes as Record<string, unknown>)
      .filter(([, value]) => typeof value === "object" && value !== null && (value as { readonly status?: unknown }).status === "unavailable")
      .map(([key]) => key),
  );
}

interface Measurement {
  readonly verdict: string;
  readonly detail: string;
  /**
   * Every input the ladder read, and therefore everything the body is a
   * function of. `graph_domain_changed` and `tree_state` are here because both
   * change the verdict without moving a revision: a tree_state that flips
   * `clean`→`dirty`, and a drift set that empties out, would each be deduped
   * into silence if the derivation tracked only the two revisions.
   */
  readonly derivation: unknown;
}

function measure(git: GitAdapter, root: string, graphRev: string, headRev: string, treeState: string | null, planes: readonly string[]): Measurement | null {
  const dirtyCount = dirtyIntersection(git, root, GRAPHED_DOMAIN).length;

  const count = graphRev === headRev ? "0" : (() => {
    const result = git.run(["-C", root, "rev-list", "--count", `${graphRev}..${headRev}`]);
    const total = result.stdout.trim();
    return result.ok && /^\d+$/u.test(total) ? total : "?";
  })();

  // Defaults to TRUE and is only ever narrowed by a MEASURED empty diff over a
  // MEASURED distance. `?` is left at the default on purpose: an unmeasurable
  // distance is unknown, and the honest reading of unknown is "warn", because
  // the failure this hook exists to prevent is a graph quietly describing a
  // tree no commit has. A diff that FAILED also leaves it true — an empty
  // stdout from a failed command is not evidence of an empty diff.
  const domainChanged = count === "?" || count === "0"
    || git.run(["-C", root, "diff", "--name-only", `${graphRev}..${headRev}`, "--", ...GRAPHED_DOMAIN]).stdout.trim() !== "";
  const derivation = Object.freeze({ graph_rev: graphRev, head_rev: headRev, dirty_count: dirtyCount, behind: count, graph_domain_changed: domainChanged, tree_state: treeState, unavailable_planes: planes });

  // First match wins, in the script's order.
  if (treeState === "dirty") {
    return Object.freeze({
      verdict: "UNCOMMITTED-BASIS",
      detail: `the graph was built from a DIRTY working tree — its recorded revision ${graphRev.slice(0, 8)} describes a state no commit has, so nothing can check it. \`gate:vi-freshness\` fails on this. Commit the source, then re-run \`bun run vi:refresh\``,
      derivation,
    });
  }
  // Rung 2 and silencer 1 together: at HEAD with nothing uncommitted there is
  // nothing worth spending context on, which is this hook's resting state.
  if (graphRev === headRev && dirtyCount === 0) return null;
  if (dirtyCount > 0 && count !== "0") {
    return Object.freeze({
      verdict: "DIVERGED",
      // BOTH facts, always. The previous ladder tested dirtiness first and
      // returned early, so a DIVERGED verdict hid how far behind the graph was;
      // the two conditions are independent and a reader needs both.
      detail: `${dirtyCount} uncommitted path(s) touched since extraction, AND the graph is ${count} commit(s) behind HEAD — do not cite the committed views until refreshed`,
      derivation,
    });
  }
  if (dirtyCount > 0) {
    return Object.freeze({ verdict: "DIVERGED", detail: `${dirtyCount} uncommitted path(s) touched since extraction — do not cite the committed views until refreshed`, derivation });
  }
  // Rung 5, and silencer 2: a stale graph describing untouched code is still
  // accurate, so stay quiet rather than cry wolf at every commit that moved a
  // README. This is checked AFTER the ladder because it is a property of the
  // drift, not a rung in it.
  if (!domainChanged) return null;
  return Object.freeze({
    verdict: "STALE",
    detail: `graph is ${count} commit(s) behind HEAD, and those commits touched the graphed domain (packages/ or decisions/) — refresh before citing the committed views`,
    derivation,
  });
}

export function viFreshnessTropism(root: string): Tropism | null {
  const manifestPath = join(root, VI_DIR, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    manifest = parsed as Record<string, unknown>;
  } catch { return null; }
  const graphRev = readString(manifest.repo_revision);
  if (graphRev === null) return null;

  let git: GitAdapter;
  try { git = new GitAdapter(root); } catch { return null; }
  const headResult = git.run(["-C", root, "rev-parse", "HEAD"]);
  const headRev = headResult.ok ? headResult.stdout.trim() : "";
  if (headRev === "") return null;

  const planes = unavailablePlanes(manifest.planes);
  const measurement = measure(git, root, graphRev, headRev, readString(manifest.tree_state), planes);
  if (measurement === null) return null;

  return Object.freeze({
    id: "vi-freshness", trigger: "session_start", lane: "ADVISORY", provenance: "generated",
    // The hash of every input above. A constant here would make this handler
    // permanently deduped — invisible rather than wrong, which is worse.
    derived_from: Object.freeze([`graph-freshness:${createHash("sha256").update(JSON.stringify(measurement.derivation)).digest("hex").slice(0, 16)}`]),
    body: [
      `repository-visual-intelligence — graph freshness: ${measurement.verdict}`,
      `  ${measurement.detail}`,
      // Eight characters of each revision, separated by three spaces: the
      // script's own widths. `scripts/vi-freshness-gate.mjs` prints twelve and
      // is a different surface over the same store — the two are NOT unified.
      `  graph revision: ${graphRev.slice(0, 8)}   HEAD: ${headRev.slice(0, 8)}`,
      ...(planes.length > 0 ? [`  planes UNAVAILABLE in this graph: ${planes.join(", ")} (comparisons using them were never made)`] : []),
      "  Run the repository-visual-intelligence skill in maintenance mode to refresh.",
    ].join("\n"),
    expires_after_turns: SESSION_START_TTL_TURNS,
    enforcing_ref: null,
  });
}
