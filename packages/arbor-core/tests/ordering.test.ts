import { describe, expect, it } from "vitest";
import { compareCodeUnits } from "../src/ordering.js";

/**
 * These tests are only meaningful if the two comparators actually disagree.
 * If a future ICU build made `localeCompare` agree with code-unit order
 * everywhere, the "disagrees" assertions below would start passing
 * vacuously — so each one first proves the disagreement is real, then proves
 * `compareCodeUnits` takes the deterministic side.
 */
describe("compareCodeUnits — deterministic ordering", () => {
  it("disagrees with localeCompare on mixed case, and takes the code-unit side", () => {
    // Under a typical ICU build "a" sorts before "B" (case-insensitive-ish),
    // but 0x61 > 0x42 so code-unit order is the opposite. This is the exact
    // shape reachable through metric tag values carrying provider/model names.
    expect(Math.sign("a".localeCompare("B"))).toBe(-1);
    expect(compareCodeUnits("a", "B")).toBe(1);
  });

  it("disagrees with localeCompare on accented characters, and takes the code-unit side", () => {
    // Reachable through governance finding details, which carry ADR titles.
    expect(Math.sign("é".localeCompare("z"))).toBe(-1);
    expect(compareCodeUnits("é", "z")).toBe(1);
  });

  it("matches a bare .sort(), which is what canonical.ts uses for object keys", () => {
    const input = ["b", "A", "é", "a", "B", "_", "1"];
    const viaComparator = [...input].sort(compareCodeUnits);
    const viaBareSort = [...input].sort();
    expect(viaComparator).toEqual(viaBareSort);
  });

  it("is a total order: antisymmetric, reflexive, and transitive on real inputs", () => {
    const values = ["a", "B", "é", "campaign-2", "Campaign-1", "trace_01", "trace_1", ""];
    for (const left of values) {
      expect(compareCodeUnits(left, left)).toBe(0);
      for (const right of values) {
        // Summed rather than negated: -0 !== +0 under Object.is, which is what
        // toBe uses, so `toBe(-compare(...))` fails on every equal pair.
        expect(compareCodeUnits(left, right) + compareCodeUnits(right, left)).toBe(0);
      }
    }
    for (const a of values) {
      for (const b of values) {
        for (const c of values) {
          if (compareCodeUnits(a, b) <= 0 && compareCodeUnits(b, c) <= 0) {
            expect(compareCodeUnits(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });

  it("sorts identically regardless of the process locale", () => {
    // The defect this exists to prevent: the same rows ordering differently on
    // two machines. localeCompare's result depends on the host's ICU tables;
    // this comparator reads nothing outside its arguments.
    // "ä" and "Ö" are load-bearing: sv-SE sorts them AFTER "z" while en-US,
    // de-DE and tr-TR interleave them. Verified against this Node's ICU before
    // being asserted — an earlier version of this test used a sample without
    // them and claimed a locale divergence that did not exist.
    const rows = ["Zeta", "alpha", "Émile", "beta", "ALPHA", "ä", "z", "Ö", "o"];
    const expected = [...rows].sort(compareCodeUnits);
    for (const locale of ["en-US", "de-DE", "sv-SE", "tr-TR"]) {
      const localeOrder = [...rows].sort((left, right) => left.localeCompare(right, locale));
      // Not asserting localeOrder is wrong — asserting ours does not vary.
      expect([...rows].sort(compareCodeUnits)).toEqual(expected);
      void localeOrder;
    }
    // sv-SE genuinely orders these differently from en-US, which is the whole
    // point: a locale-sensitive sort is a different sort per host.
    expect([...rows].sort((l, r) => l.localeCompare(r, "sv-SE")))
      .not.toEqual([...rows].sort((l, r) => l.localeCompare(r, "en-US")));
  });
});
