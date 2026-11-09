import { describe, it, expect } from "vitest";
import { stackHorizontal, type RegionSpec } from "../src/screens/region.js";
import { ANSI, spliceAnsiColumn, stripAnsi } from "../src/player-piano.js";

describe("stackHorizontal", () => {
  it("composes columns side by side, padding every column but the last", () => {
    const regions: RegionSpec[] = [
      { id: "left", lines: ["hi"], weight: 0.62 },
      { id: "right", lines: ["there"], weight: 0.38 },
    ];
    const out = stackHorizontal(regions, { total_width: 20, color: false });
    expect(out.length).toBe(1);
    expect(out[0]).toContain("hi");
    expect(out[0]).toContain("there");
    expect(out[0]!.length).toBeLessThanOrEqual(20);
  });

  it("is ANSI-safe: an SGR-colored column still measures and clips by display width, not byte length", () => {
    const colored = `${ANSI.reset}\x1b[33mwarn\x1b[0m`; // display width 4 ("warn")
    const regions: RegionSpec[] = [
      { id: "left", lines: [colored], weight: 1 },
      { id: "right", lines: ["ok"], weight: 1 },
    ];
    const out = stackHorizontal(regions, { total_width: 40, color: true });
    expect(out.length).toBe(1);
    // The right column's content must not have been eaten by the left
    // column's escape bytes being counted as real display width.
    expect(out[0]).toContain("ok");
    // The escape sequences themselves must survive un-mangled (clipAnsi,
    // not clipDisplay, was used).
    expect(out[0]).toContain("\x1b[33m");
  });

  it("clips a too-long combined row to total_width using ANSI-aware clipping", () => {
    const regions: RegionSpec[] = [
      { id: "left", lines: ["x".repeat(50)], weight: 1 },
      { id: "right", lines: ["y".repeat(50)], weight: 1 },
    ];
    const out = stackHorizontal(regions, { total_width: 30, color: false });
    expect(out[0]!.length).toBeLessThanOrEqual(30);
  });

  it("returns one row per the tallest column's natural height, not padded to a fixed height", () => {
    const regions: RegionSpec[] = [
      { id: "left", lines: ["l1", "l2", "l3"], weight: 1 },
      { id: "right", lines: ["r1"], weight: 1 },
    ];
    const out = stackHorizontal(regions, { total_width: 20, color: false });
    expect(out.length).toBe(3);
    expect(out[2]).toContain("l3");
  });
});

describe("spliceAnsiColumn (cell-accurate overwrite of an ANSI-colored row)", () => {
  it("overwrites the correct plain-text column when there is no SGR at all", () => {
    expect(spliceAnsiColumn("abcdef", 2, "X")).toBe("abXdef");
  });

  it("overwrites the visible column, not the raw string index, when SGR precedes it", () => {
    // Visible text is "abcdef"; column 2 is "c". A naive `string[index] = X`
    // splice on this same string (treating the escape as ordinary
    // characters) would hit an escape byte instead.
    const colored = `ab${ANSI.red}cdef${ANSI.reset}`;
    const spliced = spliceAnsiColumn(colored, 2, "X");
    expect(stripAnsi(spliced)).toBe("abXdef");
    // Naive index splice on the raw string lands inside the escape sequence.
    const naive = colored.split("");
    naive[2] = "X";
    expect(stripAnsi(naive.join(""))).not.toBe("abXdef");
  });

  it("splices past multiple preceding escapes at the correct visible column", () => {
    const colored = `${ANSI.bold}${ANSI.red}hello${ANSI.reset} ${ANSI.green}world${ANSI.reset}`;
    // "hello world": column 5 is the space between "hello" and "world".
    expect(stripAnsi(spliceAnsiColumn(colored, 5, "|"))).toBe("hello|world");
    // Column 8 lands inside "world" (after the second color escape run starts).
    expect(stripAnsi(spliceAnsiColumn(colored, 8, "|"))).toBe("hello wo|ld");
  });

  it("appends the replacement, padded, when the row is shorter than the target column", () => {
    expect(spliceAnsiColumn("ab", 5, "X")).toBe("ab   X");
  });
});
