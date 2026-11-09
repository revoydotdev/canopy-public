/**
 * mentions.ts — find G-NN status *assertions* in prose, as distinct from
 * bare G-NN references.
 *
 * Conservatism is the whole point, same discipline as counts/check.ts's
 * SUR-05: a false positive here ("this document contradicts the register"
 * when it does not) poisons trust in the gate faster than a missed
 * contradiction does. So this module only recognizes two narrow,
 * high-confidence shapes:
 *
 *   1. A markdown task-list checkbox whose FIRST token is the gap id —
 *      `- [x] G-36: ...` (closed) / `- [ ] G-09: ...` (open). The checkbox
 *      is deliberately required to be the item's own subject, not merely
 *      present somewhere on a line that happens to mention several ids
 *      (`docs/release-readiness.md`'s "G-07 ..., G-10 ..., G-31 ... closed
 *      this wave; G-32 ... narrowed" line names four ids under one `[x]` —
 *      only the first, G-07, is this checkbox's actual subject; the other
 *      three fall through to rule 2 below, which correctly declines all of
 *      them because more than one id shares the clause).
 *
 *   2. A direct linking-verb or immediate-adjacency phrase — "G-36 is
 *      closed", "G-11 closed (wave 3)", "G-04, G-09 — both closed..." — but
 *      ONLY when the status word is the very next thing after the id (after
 *      a short, punctuation-only filler), and only when no OTHER G-id token
 *      sits between this id and the status word. That second guard is what
 *      keeps a list like "G-15 closed; G-02/G-09 open" from misattributing
 *      "open" to G-02 (another id, G-09, sits between G-02 and the word) —
 *      it still correctly attributes "closed" to G-15 and "open" to G-09,
 *      the two unambiguous ends of that sentence, and silently declines G-02
 *      rather than guess. Missing a claim is the safe failure here; a
 *      misattributed one is not.
 *
 * A HUGE range of true prose is deliberately NOT matched: "prevents
 * recurrence of G-09", "itemised as G-01 through G-09", "G-11
 * (`kb.backend` threading) | **OPEN**, as the register (then) said" (the
 * status word is separated from the id by an unrelated parenthetical, not
 * adjacent to it — this is `audit/10-gap-register.md`'s own explicitly
 * `HISTORICAL SNAPSHOT — superseded` table, and the adjacency requirement
 * is what keeps this module from reading its deliberately-dated verdicts as
 * live contradictions, with no special-case file exclusion needed). Missing
 * these is correct: none of them asserts a status against a specific,
 * unambiguous id in a way a human reader would call a claim.
 */

import type { GapStatus } from "./register.js";

export interface GapMention {
  readonly id: number;
  readonly assertion: GapStatus;
  /** Repo-relative path supplied by the caller (this module does no I/O). */
  readonly document: string;
  /** 1-based line number. */
  readonly line: number;
  /** Trimmed snippet of the matched text, for finding detail. */
  readonly context: string;
}

const GAP_TOKEN_RE = /G-(\d{2,3})\b/g;
const CHECKLIST_LINE_RE = /^\s*-\s*\[([ xX])\]\s*G-(\d{2,3})\b/;

// Punctuation-and-connective filler tolerated between a G-id and its status
// word: an optional possessive "'s" directly on the id, then
// dashes/em-dash/en-dash, parens, colon, comma, HORIZONTAL whitespace only
// (deliberately not `\n` — see below), and the words "both"/"all" plus an
// optional linking verb ("is"/"was"/"remains"/"stays") or "still".
// Deliberately excludes letters outside that closed set, which is what
// makes "G-07 (per-knob config provenance) | **OPEN**" fail to match:
// "per-knob config provenance)" is not filler.
//
// Newline is excluded from the filler class on purpose (found empirically,
// not designed up front): `audit/10-gap-register.md`'s own tally —
//   "- NARROWED: 3 (G-08, G-10, G-12)
//    - OPEN: 2 (G-07, G-11)"
// — is two separate bulleted lines, and `\s` (which matches `\n`) let the
// filler cross from "G-12)" on the NARROWED line straight into "OPEN" on
// the UNRELATED next line, misreading it as "G-12 ... open". Restricting
// the filler to same-line whitespace makes adjacency same-line-only, which
// is a real loss of reach (a status word wrapped onto the next physical
// line by hard-wrapping is missed) but the safe direction: a same-line
// requirement cannot bridge two different list items the way `\n` inside
// `\s` did.
const CLOSED_AFTER_RE = /^(?:'s)?[ \t:(),—–-]{0,10}(?:both[ \t]+|all[ \t]+)?(?:(?:is|was|are|were|remains?|stays?)[ \t]+)?closed\b/i;
const OPEN_AFTER_RE = /^(?:'s)?[ \t:(),—–-]{0,10}(?:both[ \t]+|all[ \t]+)?(?:(?:is|was|are|were|remains?|stays?|still)[ \t]+)?open\b/i;

// A short backward look for negation immediately before the id, so "not
// G-09 closed" (contrived, but the same discipline as docs-truth.mjs's
// NEGATION_RE) does not get read as a positive assertion.
const NEGATION_BEFORE_RE = /\b(?:not|never|isn't|wasn't|aren't|weren't|doesn't|didn't|n't)\s*$/i;

// Also found empirically: `audit/00-scope.md`'s "every G-01…G-30: open,
// genuinely closed, or mis-stated" is the audit's OWN TASK STATEMENT (settle
// each id's status), not an assertion that G-30 specifically is open — the
// id is the closing end of an ellipsised range ("G-01…G-30"), and the words
// after the colon are a disjunction of possible outcomes, not one claim. An
// ellipsis (or "..") immediately before an id is the range signal this
// module can cheaply detect; a range-endpoint id is declined outright rather
// than trusting the adjacency match that follows it.
const RANGE_ENDPOINT_BEFORE_RE = /(?:…|\.\.)\s*$/;

const ADJACENT_WINDOW = 40;

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function inRange(line: number, range: readonly [number, number] | undefined): boolean {
  if (!range) return false;
  const [start, end] = range;
  return line >= start && line < end;
}

/** Rule 1: checklist items whose own subject is the gap id. */
function findChecklistMentions(text: string, document: string, excludeLineRange: readonly [number, number] | undefined): GapMention[] {
  const mentions: GapMention[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    if (inRange(lineNo, excludeLineRange)) continue;
    const m = CHECKLIST_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const checked = m[1].trim().length > 0;
    mentions.push({
      id: Number(m[2]),
      assertion: checked ? "closed" : "open",
      document,
      line: lineNo,
      context: lines[i].trim().slice(0, 120),
    });
  }
  return mentions;
}

/** Rule 2: direct adjacency, one id at a time, guarded against negation and against another id sitting in the way. */
function findAdjacencyMentions(text: string, document: string, excludeLineRange: readonly [number, number] | undefined): GapMention[] {
  const mentions: GapMention[] = [];
  const all: Array<{ id: number; start: number; end: number }> = [];
  GAP_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GAP_TOKEN_RE.exec(text))) {
    all.push({ id: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < all.length; i++) {
    const { id, start, end } = all[i];
    const lineNo = lineNumberAt(text, start);
    if (inRange(lineNo, excludeLineRange)) continue;

    const before = text.slice(Math.max(0, start - 20), start);
    if (NEGATION_BEFORE_RE.test(before)) continue;
    if (RANGE_ENDPOINT_BEFORE_RE.test(before)) continue;

    const nextIdStart = i + 1 < all.length ? all[i + 1].start : text.length;
    const windowEnd = Math.min(end + ADJACENT_WINDOW, nextIdStart);
    const after = text.slice(end, windowEnd);

    let closedMatch = CLOSED_AFTER_RE.exec(after);
    let openMatch = OPEN_AFTER_RE.exec(after);
    // "closed/open AS A <classification>" names which DEFECT SHAPE a gap was
    // filed under (e.g. ROADMAP.md's "G-04, G-09 — both closed as a Hollow
    // shape by wave 5 (real capability behind G-09 remains absent; see its
    // register row)" — the parenthetical right there says G-09 itself is
    // NOT closed). It is a classification, not a status assertion — decline.
    if (closedMatch && /^\s*as\s+a\b/i.test(after.slice(closedMatch[0].length))) closedMatch = null;
    if (openMatch && /^\s*as\s+a\b/i.test(after.slice(openMatch[0].length))) openMatch = null;
    // Both matching (never expected given the two words are mutually
    // exclusive in the pattern) would be genuinely ambiguous — decline.
    if (closedMatch && !openMatch) {
      mentions.push({ id, assertion: "closed", document, line: lineNo, context: text.slice(start, end + closedMatch[0].length).trim() });
    } else if (openMatch && !closedMatch) {
      mentions.push({ id, assertion: "open", document, line: lineNo, context: text.slice(start, end + openMatch[0].length).trim() });
    }
  }
  return mentions;
}

/**
 * Find every status assertion for a G-id in `text`. `excludeLineRange`, when
 * given (1-based [start, end)), is skipped entirely — pass the register's
 * own `bodyRange` when scanning the document the register was parsed from,
 * so a row is never compared against itself.
 */
export function findGapStatusMentions(
  text: string,
  document: string,
  excludeLineRange?: readonly [number, number],
): GapMention[] {
  const combined = [
    ...findChecklistMentions(text, document, excludeLineRange),
    ...findAdjacencyMentions(text, document, excludeLineRange),
  ];
  // Rule 1 and rule 2 can both fire on the same checklist line (e.g. "- [x]
  // G-36 ... is closed"); collapse to one mention per (line, id, assertion)
  // rather than reporting — or double-counting a violation on — it twice.
  const seen = new Set<string>();
  const deduped: GapMention[] = [];
  for (const mention of combined) {
    const key = `${mention.line} ${mention.id} ${mention.assertion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(mention);
  }
  return deduped;
}
