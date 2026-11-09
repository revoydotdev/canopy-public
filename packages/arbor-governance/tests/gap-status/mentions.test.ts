import { describe, expect, it } from "vitest";
import { findGapStatusMentions } from "../../src/gap-status/mentions.js";

describe("findGapStatusMentions — checklist rule", () => {
  it("reads a checked item as a closed assertion", () => {
    const mentions = findGapStatusMentions("- [x] G-36: fixed and verified.\n", "doc.md");
    expect(mentions).toEqual([expect.objectContaining({ id: 36, assertion: "closed", line: 1 })]);
  });

  it("reads an unchecked item as an open assertion", () => {
    const mentions = findGapStatusMentions("- [ ] G-09: soak test still pending.\n", "doc.md");
    expect(mentions).toEqual([expect.objectContaining({ id: 9, assertion: "open", line: 1 })]);
  });

  it("only attributes the checklist status to the item's OWN (first) id, not every id it names — modeled on docs/release-readiness.md's real four-id line", () => {
    const line =
      "- [x] G-07 (per-knob config provenance), G-10 (repo-instructions scope, ADR-022), " +
      "G-11 (`kb.backend` threading), G-31 (TUI tasks/campaigns screen contracts) closed this " +
      "wave; G-32 (TUI read-side wiring) narrowed to three residual screens.\n";
    const mentions = findGapStatusMentions(line, "doc.md");
    const ids = mentions.map((m) => m.id);
    expect(ids).toEqual([7]); // the checklist's own subject, and nothing else
    expect(mentions[0].assertion).toBe("closed");
    // G-10/G-11/G-31/G-32 are each followed by their own parenthetical
    // aside before any status word, so adjacency correctly declines all
    // four rather than guessing which of "closed this wave" or "narrowed"
    // belongs to which id.
  });
});

describe("findGapStatusMentions — adjacency rule", () => {
  it("matches a direct linking-verb assertion", () => {
    const mentions = findGapStatusMentions("**G-36 is closed** — the fix landed.\n", "doc.md");
    expect(mentions).toContainEqual(expect.objectContaining({ id: 36, assertion: "closed" }));
  });

  it("matches a direct 'remains open' assertion", () => {
    const mentions = findGapStatusMentions("G-09 remains open by design, still not exercised live.\n", "doc.md");
    expect(mentions).toContainEqual(expect.objectContaining({ id: 9, assertion: "open" }));
  });

  it("tolerates a possessive 's directly on the id", () => {
    const mentions = findGapStatusMentions("G-09's closed as of this wave.\n", "doc.md");
    expect(mentions).toContainEqual(expect.objectContaining({ id: 9, assertion: "closed" }));
  });

  it("matches bare adjacency with no linking verb", () => {
    const mentions = findGapStatusMentions("G-11 closed (wave 3); other prose.\n", "doc.md");
    expect(mentions).toContainEqual(expect.objectContaining({ id: 11, assertion: "closed" }));
  });

  it("declines a status word separated from the id by descriptive words in between (conservative miss, not a false positive)", () => {
    // Modeled on real ROADMAP.md prose: "G-12's CI half closed" — the words
    // "'s CI half" sit between the id and "closed", so this module declines
    // rather than guessing the words in between don't matter.
    expect(findGapStatusMentions("G-12's CI half closed.\n", "doc.md")).toEqual([]);
  });

  it("correctly splits a list where two ids share one clause, attributing only the unambiguous ends", () => {
    // The real ROADMAP.md sentence this is modeled on: "G-15 closed;
    // G-02/G-09 open" — G-15 is unambiguous; of G-02/G-09, only G-09 sits
    // directly next to "open" with no other id between it and the word, so
    // only G-09 is reported. G-02 is silently declined rather than guessed.
    const mentions = findGapStatusMentions("G-15 closed; G-02/G-09 open\n", "doc.md");
    const byId = new Map(mentions.map((m) => [m.id, m.assertion]));
    expect(byId.get(15)).toBe("closed");
    expect(byId.get(9)).toBe("open");
    expect(byId.has(2)).toBe(false);
  });

  it("does not flag a negated assertion as positive", () => {
    const mentions = findGapStatusMentions("This is not G-09 closed reasoning, contrived as it is.\n", "doc.md");
    expect(mentions.find((m) => m.id === 9)).toBeUndefined();
  });
});

describe("findGapStatusMentions — no false positives on bare references", () => {
  it("does not flag 'prevents recurrence of G-09'", () => {
    expect(findGapStatusMentions("This change prevents recurrence of G-09.\n", "doc.md")).toEqual([]);
  });

  it("does not flag 'itemised as G-01 through G-09'", () => {
    expect(findGapStatusMentions("The findings are itemised as G-01 through G-09.\n", "doc.md")).toEqual([]);
  });

  it("does not flag a status word separated from the id by an unrelated parenthetical (the audit/10-gap-register.md shape)", () => {
    const line =
      "| G-07 (per-knob config provenance) | **OPEN**, \"genuinely unbuilt\" | **CLOSED** (2026-08-04, wave 3) |\n";
    expect(findGapStatusMentions(line, "doc.md")).toEqual([]);
  });

  // The next three cases are real false positives this module produced
  // against the live repository during development, each fixed by a named
  // guard once found — kept as regression tests rather than only fixed.

  it("does not flag 'closed/open AS A <classification>' as a status assertion (ROADMAP.md's real Hollow-shape prose)", () => {
    const line =
      "G-04, G-09 — both closed as a Hollow shape by wave 5 (real capability behind G-09 remains absent; see its register row)\n";
    expect(findGapStatusMentions(line, "doc.md")).toEqual([]);
  });

  it("does not flag the closing id of an ellipsised range as an individual assertion (audit/00-scope.md's real task-statement prose)", () => {
    const line = "every G-01…G-30: open, genuinely closed, or mis-stated. Five waves closed a large fraction.\n";
    expect(findGapStatusMentions(line, "doc.md")).toEqual([]);
  });

  it("does not let adjacency cross a newline into an unrelated bulleted list item (audit/10-gap-register.md's real tally shape)", () => {
    const text = "- NARROWED: 3 (G-08, G-10, G-12)\n- OPEN: 2 (G-07, G-11)\n";
    // G-12 is the last id on the NARROWED line; without a same-line
    // restriction, the filler used to cross the newline straight into the
    // next line's "OPEN" and misread it as "G-12 ... open".
    expect(findGapStatusMentions(text, "doc.md").find((m) => m.id === 12)).toBeUndefined();
  });
});

describe("findGapStatusMentions — excludeLineRange", () => {
  it("skips mentions inside the excluded range (the register's own body)", () => {
    const text = ["line 1", "G-01 is closed on line 2", "line 3"].join("\n");
    expect(findGapStatusMentions(text, "doc.md", [2, 3])).toEqual([]);
    expect(findGapStatusMentions(text, "doc.md", [3, 4])).toContainEqual(
      expect.objectContaining({ id: 1, assertion: "closed", line: 2 }),
    );
  });
});
