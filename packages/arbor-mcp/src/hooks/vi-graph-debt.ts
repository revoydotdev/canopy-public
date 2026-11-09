/**
 * `inject.vi-graph-debt` — the native replacement for the deleted
 * `.claude/skills/repository-visual-intelligence/hooks/vi-graph-debt.sh`, and
 * the per-turn report of graph debt accrued during the session.
 *
 * ============================================================================
 * THIS LANE, AND WHY IT IS THE ONLY ONE THAT COULD CARRY THIS. The script's
 * whole product was prose printed to the MODEL at Stop time. `HookObserveOutcome`
 * has no model-facing field, so on the `turn_end` observe lane that prose became
 * a ledger row — and `harness-session-journal.hookInvocations()` was its only
 * reader, with no production caller at all. A note nobody reads is not a
 * de-graded report; it is a missing one, and this handler's own header claimed
 * an operator read it, which was false.
 *
 * `HOOK_INJECT_EVENTS` now carries `turn_end` (it is the same second binding of
 * an event the bus already dispatches that `session_start` has always been:
 * lifecycle_start + lifecycle_observe + inject), so this handler returns a
 * `Tropism` and the worker's turn loop carries it into the NEXT turn's prompt.
 * It is ADVISORY in the strict sense: `Tropism` carries no decision field, so
 * this handler cannot deny a turn, grant a capability, or satisfy a predicate —
 * `HOOK_LIFECYCLE_VETO_EVENT` is still the single value `session_start`, and
 * `turn_end` is still absent from `HOOK_VETO_EVENTS` and `HOOK_LIFECYCLE_EVENTS`.
 *
 * IT ALSO KEEPS THE LEDGER ROW. The `inject` lane records
 * `turn_end injected=vi-graph-debt lane=ADVISORY` with the handler's
 * `derived_from`, so the audit field the observe lane carried survives the move.
 *
 * WHAT THE SIBLING DOES NOT COVER. `inject.vi-freshness` (descriptor
 * `session-graph-freshness`) reports the same `.dirty ∩ git status` intersection
 * at SessionStart, but SCOPED to the graphed domain and only once. This reports
 * the UNSCOPED set — so a `docs/` or `notes/` edit the graph would have to be
 * re-derived from is visible too — and does so every turn rather than once a
 * session.
 *
 * ============================================================================
 * WHY THE DERIVATION IS THE POINT, NOT A FIELD. This repository has a recorded
 * ~42-session instance of a hook emitting `DIVERGED — 42 uncommitted path(s)`
 * against a tree with zero uncommitted paths (ADR-032). The native form of that
 * failure on the INJECT lane is worse than a false alarm: §5.3 rule 2 dedupes a
 * body whose `derived_from` did not move, so a handler that stopped measuring
 * goes SILENT, and silence is indistinguishable from a healthy repository. The
 * guarantee is therefore carried by the derivation itself: the report is
 * recomputed from the live intersection on every single firing, and its
 * derivation is a hash of the intersected path SET and its COUNT — exactly the
 * inputs the text is a function of. Two consecutive turns over identical state
 * must produce identical derivations (and the second is deduped, which is the
 * lane being affordable), and a changed set must change it (and render again).
 * A handler that answered from memory would fail both.
 *
 * THE INTERSECTION IS SHARED, NOT REIMPLEMENTED. `dirtyIntersection` is the one
 * `.dirty ∩ git status --porcelain [scope]` helper (extracted by
 * `vi-freshness-tropism.ts` for this purpose), and this passes an EMPTY scope:
 * the script's `git status --porcelain` was unscoped and deliberately so. A
 * debt report that hid `docs/` edits would under-report the debt it exists to
 * show, and the under-count would read as "the graph is clean".
 *
 * EVERY SILENCE IS THE SCRIPT'S OWN, and there are exactly the same five: no
 * `.dirty` (which is also what makes global installation safe in a repository
 * that does not use the skill), an empty worktree listing, an empty
 * intersection, a zero count, and a `.dirty` with no live paths in it. Silence
 * is `null` rather than an empty body, so a healthy turn costs one ledger row
 * and no prompt bytes.
 *
 * ONE ADAPTATION, DECLARED. The script's sample is `head -5`, four spaces per
 * row. Rows are therefore shed from the END of the sample until the whole
 * message fits its bound, and what is no longer shown is counted in the
 * `... and N more` row, which is exactly what that row is for. The header's
 * count is never reduced, so the number reported is always the true one, and the
 * remedy is never shed, because a head slice that cuts the actionable line
 * leaves a report nobody can act on.
 */
import { createHash } from "node:crypto";
import type { Tropism } from "@arbor/prompts";
import type { HookInjectHandler } from "./contracts.js";
import { HOOK_MAX_NOTE_BYTES } from "./contracts.js";
import { currentGovernedRoot } from "./governance-tropisms.js";
import { GitAdapter } from "../git-workspace-projection.js";
import { dirtyIntersection } from "./vi-freshness-tropism.js";

/** The script's `head -5`. */
const SAMPLE_ROWS = 5;
const HEADER = (count: number): string => `repository-visual-intelligence — graph debt: ${count} path(s) changed, graph not refreshed`;
const MORE = (hidden: number): string => `    ... and ${hidden} more`;
/** The script's closing line, verbatim, two-space indent and all. */
const REMEDY = "  Refresh with maintenance mode, or clear .visual-intelligence/.dirty if the changes are irrelevant to the graph.";

/** The script's UNSCOPED read. See the file header: an empty scope is the unscoped `git status --porcelain`. */
const ALL_PATHS: readonly string[] = Object.freeze([]);

/** Matches the session-start tropisms: long enough that a model which skims the first read still has it. */
const REPORT_TTL_TURNS = 3;

/**
 * The report's own byte bound, and deliberately NOT the lane's.
 *
 * The observe lane sliced this text to `HOOK_MAX_NOTE_BYTES`; the inject lane
 * would let it grow to `TROPISM_BYTE_BUDGET` (4_000). It does not need to: the
 * actionable part of a report is its count and its remedy line, the sample is
 * capped at five rows by the script anyway, and eight times the budget buys
 * eight times the sample and no more information. Keeping the tighter line also
 * preserves the shedding behaviour the deleted script's shape depended on.
 */
const REPORT_BODY_BYTES = HOOK_MAX_NOTE_BYTES;

/**
 * The tropism for the currently live graph debt, or `null` for the script's
 * five silences. `null` rather than an empty body so a healthy turn costs no
 * prompt bytes at all.
 */
export function viGraphDebtTropism(root: string): Tropism | null {
  let git: GitAdapter;
  try { git = new GitAdapter(root); } catch { return null; }
  // The shared helper reads the same file and applies the same line shapes as
  // the script: first three characters stripped, an `R` arrow resolved to the
  // new path, blank lines dropped, survivors matched WHOLE-LINE.
  const live = dirtyIntersection(git, root, ALL_PATHS);
  if (live.length === 0) return null;
  return Object.freeze({
    // Opens with a noun phrase, which is what §5.3's advisory-imperative lint
    // requires: a body that opens must/shall/should/never/always/do-not is
    // REFUSED as `advisory_imperative`, because an ADVISORY tropism may not ask
    // for behaviour. The remedy line inside the body still reads as an
    // instruction — that is the script's own wording, and the lint is
    // deliberately anchored to the first token rather than to the whole body.
    id: "vi-graph-debt", trigger: "turn_end", lane: "ADVISORY", provenance: "generated",
    derived_from: Object.freeze([`graph-debt:${createHash("sha256").update(JSON.stringify(live)).digest("hex").slice(0, 16)}`]),
    body: compose(live.length, live), expires_after_turns: REPORT_TTL_TURNS, enforcing_ref: null,
  });
}

/** Header, up to `SAMPLE_ROWS` indented rows, the hidden-count row, the remedy — in the script's order. */
function compose(count: number, live: readonly string[]): string {
  const header = HEADER(count);
  let shown = Math.min(SAMPLE_ROWS, count);
  const note = (rows: number): string => [header, ...live.slice(0, rows).map((path) => `    ${path}`), ...(count > rows ? [MORE(count - rows)] : []), REMEDY].join("\n");
  while (shown > 0 && note(shown).length > REPORT_BODY_BYTES) shown -= 1;
  return note(shown);
}

/**
 * The turn-boundary half. The `git` work happens inside a `setImmediate`, not in
 * the handler body, and that is the whole point:
 *
 *  - an `async` wrapper is NOT deferral. `(async () => syncWork())()` runs
 *    `syncWork` on whoever called it, and the observe lane dispatches handlers
 *    inside a SYNCHRONOUS `runBounded`, so the promise deferred the LEDGER ROW
 *    and left three `git` processes (13-17 ms measured) on the turn boundary's
 *    own stack. That cost took the native production e2e from 4/4 to 2/4.
 *  - `setImmediate` defers past the loop's poll phase, so a caller's next
 *    event-loop turn — and the provider round trip it is usually waiting on —
 *    completes before this blocks. `spawnSync` cannot be made concurrent, so
 *    "out of band" means off the critical path, not parallel; what is bought is
 *    that the turn boundary never waits on it and the loop has had its chance
 *    to do I/O first.
 */
export const viGraphDebt: HookInjectHandler = () => new Promise<Tropism | null>((resolve) => {
  setImmediate(() => { resolve(viGraphDebtTropism(currentGovernedRoot())); });
});
