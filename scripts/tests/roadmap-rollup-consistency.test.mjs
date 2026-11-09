import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * scripts/tests/roadmap-rollup-consistency.test.mjs — a summary line may not
 * contradict the register row it cites.
 *
 * WHY THIS EXISTS. ROADMAP.md's phase table said "SQLite backend still
 * unreached (G-11)" for fifteen days after G-11's own gap-register row said
 * "CLOSED (2026-08-04, wave 3)" and named the commit that closed it. Both
 * sentences lived in the same file. The rollup was read aloud as a real
 * remaining gap during a session on 2026-08-19 and acted on.
 *
 * `gate:docs-truth` cannot catch it, and says so in its own output: "leaf
 * claims only; rollups skipped". That loophole is itself recorded as G-27 —
 * the rollup check asks whether ANY descendant is still open, which a
 * hand-written summary line is not.
 *
 * WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT. Only STATUS-TABLE ROWS
 * — a table row carrying a status marker that cites `G-NN` while asserting
 * incompleteness about it, where that row is CLOSED. Line 96 was exactly that
 * shape: a phase-status row presented as current state.
 *
 * The first version of this check scanned every line and produced 14 hits, of
 * which roughly 12 were legitimate: dated narration like "**Caveats
 * (2026-08-04).** ... the flag has no reader (**G-11**)", and a historical
 * table row that cites five gaps and then says in the same sentence that they
 * closed. A regex cannot tell a dated snapshot from a live claim, which is the
 * same undecidability `gate:docs-truth` reports when it says "rollups skipped".
 *
 * So the scope is deliberately small. An over-firing check gets waived, and a
 * waived check is worth less than none — this repository has already narrowed
 * one detector today for exactly that reason. Prose elsewhere in the document
 * is NOT policed, and dated historical narration is legitimate by design.
 */

const NEGATIVE = /\b(still|not yet|unreached|unbuilt|never|remains?\s+(open|unbuilt|unreached))\b/i;

function roadmap() {
  return readFileSync(join(REPO, "ROADMAP.md"), "utf8");
}

/** Gap-register rows and whether each is closed, read from the register table. */
function registerStatus(text) {
  const status = new Map();
  for (const match of text.matchAll(/^\|\s*\*\*(G-\d+)\*\*\s*\|\s*([^|]*)/gm)) {
    status.set(match[1], /CLOSED|RESOLVED|RETIRED/i.test(match[2]));
  }
  return status;
}

describe("a ROADMAP line may not contradict the gap-register row it cites", () => {
  const text = roadmap();
  const status = registerStatus(text);

  it("the register itself parses, so the check is not vacuous", () => {
    // Guards the guard: a regex that silently matches nothing would make every
    // assertion below pass for the wrong reason.
    expect(status.size).toBeGreaterThan(20);
    expect([...status.values()].filter(Boolean).length).toBeGreaterThan(10);
  });

  it("no line calls a CLOSED gap still open", () => {
    const offenders = [];
    for (const [index, line] of text.split("\n").entries()) {
      // The register row itself legitimately narrates the closed problem in
      // past tense; only lines OUTSIDE the register are summaries.
      if (/^\|\s*\*\*G-\d+\*\*/.test(line)) continue;
      // Status-table rows only: a row carrying a ✅/🟡/❌ marker is presented as
      // CURRENT state, which is what makes it checkable. Narrative prose and
      // dated snapshots are not, and are deliberately out of scope.
      if (!/^\|/.test(line) || !/[✅🟡❌]/.test(line)) continue;
      if (!NEGATIVE.test(line)) continue;
      for (const match of line.matchAll(/\bG-\d+\b/g)) {
        const cited = match[0];
        // A row may legitimately cite a closed gap AND say so — "G-12 closed,
        // wave 2". Scope that exemption to the citation it follows, never to
        // the whole line: the first version of this check tested the line and
        // was thereby defeated by the very defect it exists for, because the
        // stale "G-11 still unreached" row also mentioned "G-12 closed".
        const trailing = line.slice(match.index + cited.length, match.index + cited.length + 40);
        if (/\bclosed\b/i.test(trailing)) continue;
        if (status.get(cited) === true) {
          offenders.push(`ROADMAP.md:${index + 1} calls ${cited} unfinished, but its register row is CLOSED — ${line.trim().slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
