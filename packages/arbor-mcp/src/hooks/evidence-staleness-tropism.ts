/**
 * `inject.evidence-staleness` — the native replacement for the deleted
 * `scripts/hooks/evidence-staleness-nudge.{sh,mjs}`.
 *
 * WHY IT EXISTS. The single most repeated friction in this repository's own
 * history is "rebind after a source change": after a commit touching
 * `packages/**` or `decisions/**` the four evidence stores are DEFINITIONALLY
 * stale — their content hash covers the changed source — and
 * `gate:store-freshness` goes red, but nothing said so in the moment. The
 * ordering itself was never missing (`bun run evidence:rebind` already runs
 * the producer chain in the required order); the gap was purely "the agent
 * must KNOW to run it, and WHEN". This closes that gap deterministically: no
 * judgement, just a check.
 *
 * THE CONDITION IS TWO-PART and both parts are load-bearing:
 *
 *   1. HEAD's own commit touches `packages/` or `decisions/`. A commit that
 *      missed the graphed domain cannot have staled a store whose content hash
 *      covers it, so mentioning it would cry wolf.
 *   2. `scripts/store-freshness-gate.mjs` — the SAME check
 *      `gate:store-freshness` and the stop tier already trust — reports at
 *      least one store not `ok`.
 *
 * That gate is SUBPROCESSED rather than reimplemented, for the same reason
 * `operator-decision-queue.ts` subprocesses `decision-queue.mjs`: a second
 * freshness verdict would be a second implementation of an invariant a gate
 * owns, and its drift would be silent.
 *
 * WHAT CHANGED, STATED RATHER THAN HIDDEN. The deleted pair was a PostToolUse
 * hook: the `.sh` wrapper decoded a Claude Code payload, tested that the tool
 * was a `Bash` call running `git commit` (with `git-write-guard.sh`'s own
 * `git` anchoring, so "gitcommit-thing" never matched), and handed off. Parts 1
 * and 2 above ARE that decision. The Bash-call trigger was a HOST detail, and
 * revoy2 does not own the host's tool-call boundary; the native seam is the
 * turn boundary, so the nudge lands on the NEXT prompt rather than immediately
 * after the commit. The consequence is stated honestly: a run that commits and
 * then ends its turn without another turn will not see the nudge, where the
 * shell hook would have spoken inside the same turn.
 *
 * WHAT DID NOT CHANGE, and matters more: it is purely ADVISORY. The hook had no
 * veto in its host contract, and this handler's return type carries no decision
 * field, so nothing becomes unenforced either way — `gate:store-freshness` still
 * blocks the push. And it still never runs the rebind itself: `evidence:rebind`
 * takes minutes and holds the evidence lease, which is exactly why this is a
 * nudge and not automation.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Tropism } from "@arbor/prompts";
import { GitAdapter } from "../git-workspace-projection.js";

export const EVIDENCE_STALENESS_REMEDY = "bun run evidence:rebind";

/**
 * The evidence-graphed domain: the source the stores' content hash covers. An
 * edit outside it invalidates no store, so it must not raise a nudge. Scoped
 * identically to `inject.vi-freshness`'s `GRAPHED_DOMAIN`, because both ask the
 * same question of the same repository.
 */
const GRAPHED_DOMAIN: readonly string[] = Object.freeze(["packages/", "decisions/"]);

/**
 * git's empty tree, so a repository's FIRST commit — which has no parent to
 * diff against, and is the commit most likely to have staled everything — is
 * measured rather than skipped. The deleted script carried this same constant.
 */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Long enough that a model which skims the first read still has it in context. */
const NUDGE_TTL_TURNS = 3;

/**
 * This handler's declared wall-clock bound.
 *
 * DERIVED, not chosen, and it is larger than its session-start sibling's
 * because the measured work is: 520-866 ms over three runs of the real
 * `store-freshness-gate.mjs` on this repository, against 57-62 ms for
 * `decision-queue.mjs`, because the freshness gate reads four evidence stores
 * and the queue reads decision records. 4 s clears the measured cost several
 * times over while staying BELOW the turn loop's `TURN_INJECT_SETTLE_MS` (5 s)
 * — that relationship is load-bearing in both directions. Too small and the
 * tropism is dropped with `hook_timeout_exceeded`; larger than the settle
 * window and a handler that used its whole budget would instead be dropped by
 * the worker as `turn_injection_dropped`. One cost, two different names, and
 * only one of them points at the handler.
 */
export const EVIDENCE_STALENESS_HANDLER_BOUND_MS = 4_000;

export interface StoreFreshnessReport {
  readonly ok?: boolean;
  readonly stores?: readonly Readonly<{ readonly name?: unknown; readonly state?: unknown }>[];
}

interface HeadState {
  readonly head: string;
  readonly base: string;
  readonly touches_domain: boolean;
}

/**
 * The `git` port, memoized per repository. Constructing one costs TWO `git`
 * processes (`rev-parse --show-toplevel` and `--git-common-dir`), and this
 * handler runs at every turn boundary, so rebuilding it per turn is two spawns
 * spent to learn a fact that cannot have changed for a given path. Bounded by
 * repositories, exactly like `reportCache` below.
 */
const gitPorts = new Map<string, GitAdapter>();
const headStates = new Map<string, HeadState>();

function gitPort(root: string): GitAdapter | null {
  const memo = gitPorts.get(root);
  if (memo !== undefined) return memo;
  try {
    const git = new GitAdapter(root);
    gitPorts.set(root, git);
    return git;
  } catch { return null; }
}

/**
 * HEAD's own oid, the commit its diff is measured against (`HEAD~1`, or git's
 * empty tree for a first commit), and whether that commit touches
 * `packages/`/`decisions/` — resolved in ONE pass and memoized per
 * `(root, HEAD oid)`.
 *
 * WHY THE MEMOIZATION IS NOT OPTIONAL. `HEAD~1` and the domain diff are
 * functions of HEAD's own oid, so at an unchanged HEAD they are the same answer
 * every turn. Unmemoized this handler asked git ELEVEN times per turn — two
 * `GitAdapter` constructions, `rev-parse HEAD` and `rev-parse HEAD~1` computed
 * TWICE (once for the head/base pair and again for the domain test), and two
 * diffs — while
 * the 53897b9e cache covered only the ~896 ms subprocess. Measured 11-13 ms per
 * turn on the caller's critical path, and no faster on the second turn than the
 * first, because the thing being repeated was never the subprocess. After it,
 * one `rev-parse HEAD` per turn, which is the floor: detecting that HEAD moved is
 * the one question a cached answer cannot answer.
 *
 * WHAT IS DELIBERATELY *NOT* MEMOIZED, and the reason this key is HEAD and not
 * anything wider. The freshness gate compares COMMITTED store bytes to the
 * WORKING TREE, so editing a store with no commit changes the verdict at an
 * unchanged HEAD. A key including a working-tree status of the four store
 * directories would capture that — and it BROKE `evidence-staleness-tropism.test.ts`'s
 * "the derivation moves when the stale set moves at the same HEAD" case, which
 * was right and the key was wrong in principle. A repository with no commit yet
 * answers `null`, and `null` is never memoized: caching it would leave a
 * repository that later gains its first commit permanently silent, which is the
 * one repository most likely to have staled everything.
 *
 * A `null` return is "not a git repository with a commit", which is also what
 * makes the handler inert outside one.
 */
function readHeadState(root: string): HeadState | null {
  const git = gitPort(root);
  if (git === null) return null;
  const head = git.run(["-C", root, "rev-parse", "HEAD"]);
  if (!head.ok) return null;
  const oid = head.stdout.trim();
  if (oid === "") return null;
  const memo = headStates.get(root);
  if (memo !== undefined && memo.head === oid) return memo;
  const parent = git.run(["-C", root, "rev-parse", "HEAD~1"]);
  const base = parent.ok && parent.stdout.trim() !== "" ? parent.stdout.trim() : EMPTY_TREE;
  const diff = git.run(["-C", root, "diff", "--name-only", base, oid, "--", ...GRAPHED_DOMAIN]);
  // A diff that FAILED leaves this true, not false: an empty stdout from a
  // failed command is not evidence of an empty diff, and defaulting the other
  // way would turn a broken check into silence.
  const state: HeadState = Object.freeze({ head: oid, base, touches_domain: !diff.ok || diff.stdout.trim() !== "" });
  headStates.set(root, state);
  return state;
}

/**
 * Runs the freshness gate and returns its parsed report, or `null` when it
 * could not be run or parsed. Fail-silent is the deleted script's own rule: a
 * broken check must not become a bogus nudge. `gateScript` is overridable so a
 * test can point this at a fixture without four real evidence stores on disk.
 */
export function runStoreFreshness(root: string, gateScript: string = join(root, "scripts", "store-freshness-gate.mjs")): StoreFreshnessReport | null {
  if (!existsSync(gateScript)) return null;
  const result = spawnSync("bun", [gateScript, "--json"], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (typeof result.stdout !== "string" || result.stdout.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return typeof parsed === "object" && parsed !== null ? (parsed as StoreFreshnessReport) : null;
  } catch { return null; }
}

/** Pure formatting — the script's nudge text verbatim, given the stale store names. */
export function buildStalenessNudge(staleNames: readonly string[]): string {
  return `evidence stores are stale after this commit (it touched packages/ or decisions/): ${staleNames.join(", ") || "unknown"}.

ONE rebind covers every source commit you have made since the last one. \`evidence:rebind\`
  regenerates against HEAD, so it does not matter whether one commit or six preceded it — run it
  when this run of source commits is FINISHED, not after each one. Rebinding mid-series is pure
  waste: the next source commit moves HEAD and invalidates the pass you just paid ~6 minutes for.

When you are done committing source:
  \`${EVIDENCE_STALENESS_REMEDY}\`  then commit the refreshed stores in a SEPARATE, store-only commit.

Order still matters within that: source commits -> rebind -> rebind commit. Do not skip the
  rebind commit; a rebind that runs but is never committed is invisible to everyone else.

This does not auto-run: \`evidence:rebind\` takes minutes and holds the evidence lease, so it is
  a deliberate step, not something a hook should fire unattended.`;
}

/**
 * The nudge, or `null` — which is both "the condition does not hold" and "it
 * could not be established". Those two share a shape on purpose: an
 * unestablished condition is not a violated one, and `gate:store-freshness`
 * still blocks the push either way.
 *
 * `derived_from` hashes BOTH the commit and the stale set, because both change
 * the body: a HEAD that moved re-opens the question even when the same stores
 * are stale, and a different set of stale stores is a different message. §5.3
 * rule 2 dedupes a scope whose derivation did not move, so a constant here
 * would make the nudge permanently SILENT — and a nudge that vanishes is
 * indistinguishable from a repository with nothing stale, which is the failure
 * mode this lane is most able to hide.
 */
/**
 * Last report per repository, keyed by the HEAD it was measured at. Bounded by
 * repositories, not commits.
 *
 * Uncached, this spawns store-freshness-gate.mjs on EVERY turn boundary: 57-62
 * ms per turn, measured, and it took the native production e2e from 4/4 to 3/4.
 * Only the default runner is cached — an injected one is the caller's own
 * measurement, and caching someone else's function is not ours to do.
 *
 * KNOWN LIMIT, stated rather than hidden. The gate compares committed store
 * bytes to the WORKING TREE, so a store edited with no commit can change its
 * answer while this key stands; the nudge may then outlive the staleness by one
 * commit. Closing that needs the four store paths in the key, and there are
 * already two hand-typed copies of that list in scripts/ that differ on
 * purpose — a third would be the drift class this effort keeps hitting, for a
 * strictly advisory signal. gate:store-freshness is the authority; this is the
 * reminder.
 */
const reportCache = new Map<string, { readonly head: string; readonly report: StoreFreshnessReport | null }>();

function cachedReport(root: string, head: string, run: (repo: string) => StoreFreshnessReport | null): StoreFreshnessReport | null {
  if (run !== runStoreFreshness) return run(root);
  const hit = reportCache.get(root);
  if (hit !== undefined && hit.head === head) return hit.report;
  const report = run(root);
  reportCache.set(root, { head, report });
  return report;
}

export function evidenceStalenessTropism(root: string, run: (repo: string) => StoreFreshnessReport | null = runStoreFreshness): Tropism | null {
  const state = readHeadState(root);
  if (state === null) return null;
  if (!state.touches_domain) return null;
  const report = cachedReport(root, state.head, run);
  if (report === null || report.ok === true) return null;
  const stale = (report.stores ?? [])
    .filter((store) => store.state !== "ok")
    .map((store) => (typeof store.name === "string" ? store.name : "unknown"));
  const derivation = Object.freeze({ head: state.head, stale: [...stale].sort() });
  return Object.freeze({
    id: "evidence-staleness", trigger: "turn_end", lane: "ADVISORY", provenance: "generated",
    derived_from: Object.freeze([`store-staleness:${createHash("sha256").update(JSON.stringify(derivation)).digest("hex").slice(0, 16)}`]),
    body: buildStalenessNudge(stale), expires_after_turns: NUDGE_TTL_TURNS, enforcing_ref: null,
  });
}
