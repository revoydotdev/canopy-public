/**
 * uct-header-fan.test.ts — the sibling fan, and the threshold where it hands
 * over to the braille field.
 *
 * The header's job is to show that this is a SEARCH: several candidate actions
 * considered from one decision point. Per-edge strokes cannot say that — three
 * diverging diagonals read as three unrelated relationships — so a fan gets one
 * spine in the interstitial column right of its parent.
 *
 * The two things that must hold no matter how crowded the tree gets:
 *   1. a spine is drawn only when every sibling is actually plotted in one
 *      column, because a partial spine claims a narrower fan than the search
 *      really opened; and
 *   2. `fan_max` reports the real branching factor at EVERY encoding, including
 *      the ones where no spine can be drawn at all. The fan is the fact; the
 *      spine is one way of showing it.
 */
import { describe, expect, it } from "vitest";
import { projectUctHeader } from "../src/uct-header.js";

const node = (id: string, parent: string | null, state: string) => ({ id, parent_id: parent, state });
const render = (nodes: readonly ReturnType<typeof node>[], width = 60, height = 9) =>
  projectUctHeader({ nodes }, { width, height });
const body = (lines: readonly string[]) => lines.slice(1, -1).join("\n");

/** One root with `count` children — drives a single rank's population up. */
const fanOf = (count: number) => [
  node("r", null, "claimed"),
  ...Array.from({ length: count }, (_, i) => node(`c${i}`, "r", ["verified", "pending", "expanding", "failed"][i % 4]!)),
];

describe("node glyphs", () => {
  it("does not draw work in progress as finished work", () => {
    // `expanding` and `verified` were both "●", separated only by tone — and
    // colour is optional. Frame p040 of the 2026-08-29 reel shows the header
    // reading `◉───●` while the campaign reported `nodes 0/2` verified. No
    // existing test caught it, which is why it survived.
    const expanding = body(render([node("r", null, "claimed"), node("a", "r", "expanding")]).lines);
    const verified = body(render([node("r", null, "claimed"), node("a", "r", "verified")]).lines);
    expect(expanding).not.toBe(verified);
    expect(expanding).toContain("◐");
    expect(expanding).not.toContain("●");
  });
});

describe("sibling fan spine", () => {
  it("draws one spine for a fan, not several diverging strokes", () => {
    const text = body(render(fanOf(3)).lines);
    expect(text).toContain("┬");
    expect(text).toContain("├");
    expect(text).toContain("└");
    // The diagonals are what the spine replaces; a fan drawn as a spine must
    // not also be drawn as loose strokes on top of it.
    expect(text).not.toContain("╲");
    expect(text).not.toContain("╱");
  });

  it("leaves a single child as an ordinary edge", () => {
    const text = body(render([node("r", null, "claimed"), node("a", "r", "expanding")]).lines);
    expect(text).not.toContain("┬");
    expect(text).toContain("─");
  });

  it("refuses a spine when siblings wrap out of one column, rather than narrowing the fan", () => {
    // At this height the rank cannot hold three siblings, so `directPositions`
    // wraps the surplus into the next column. A spine through only the ones
    // that fit would show a two-way branch where the search made a three-way
    // one — so it must fall back to per-edge strokes.
    const short = render(fanOf(3), 60, 4);
    const text = body(short.lines);
    expect(text).not.toContain("├");
    // ...and the real branching factor still gets reported as a number.
    expect(short.metrics.fan_max).toBe(3);
  });
});

describe("fan_max survives every encoding", () => {
  it("reports the branching factor when the spine is drawn", () => {
    const result = render(fanOf(3));
    expect(result.metrics.encoding).toBe("direct");
    expect(result.metrics.fan_max).toBe(3);
  });

  it("reports it in the braille field, where no spine is possible", () => {
    const result = render(fanOf(40), 60, 6);
    expect(result.metrics.encoding).toBe("braille");
    expect(result.metrics.fan_max).toBe(40);
  });

  it("reports it even when nodes are being elided", () => {
    const result = render(fanOf(300), 60, 6);
    expect(result.metrics.encoding).toBe("elided");
    expect(result.metrics.fan_max).toBe(300);
    // Elision is never silent: what was dropped is counted.
    expect(result.metrics.elided_node_count).toBeGreaterThan(0);
    expect(result.metrics.rendered_node_count + result.metrics.elided_node_count)
      .toBe(result.metrics.node_count);
  });
});

describe("the direct → braille threshold", () => {
  it("stays direct while the fan can still be drawn as a fan", () => {
    // Three siblings at rowSpacing 2 need six rows; this pane has them.
    expect(render(fanOf(3), 60, 8).metrics.encoding).toBe("direct");
  });

  it("compresses the row spacing to keep a fan drawable before giving up on it", () => {
    // Six siblings span eleven rows at the airy spacing and six at the tight
    // one. The airy spacing is a preference, not a requirement, and spending it
    // on blank rows while the fan gets bounced to the braille field has the
    // priority backwards — the spine is the thing worth keeping.
    const result = render(fanOf(6), 60, 8);
    expect(result.metrics.encoding).toBe("direct");
    expect(body(result.lines)).toContain("├");
  });

  it("hands over only when even the tight spacing cannot show the branching", () => {
    // Six siblings need six rows however tightly they are packed; this pane has
    // four. Now the field says more than a tangle of diagonals would.
    expect(render(fanOf(6), 60, 6).metrics.encoding).toBe("braille");
  });

  it("is geometry-relative, not a fixed node count", () => {
    // The same fan that cannot be drawn in a short header is drawn in a taller
    // one. The threshold is about available rows, never a magic number.
    expect(render(fanOf(5), 40, 6).metrics.encoding).toBe("braille");
    expect(render(fanOf(5), 40, 16).metrics.encoding).toBe("direct");
  });

  it("hands over when a rank cannot fit its column", () => {
    expect(render(fanOf(40), 60, 6).metrics.encoding).toBe("braille");
  });

  it("hands over when the canvas is too crowded, even though every rank fits", () => {
    // A deep, narrow tree: each rank holds one node, so the per-rank capacity
    // test passes at ANY size. 121 nodes at 60x6 kept rendering "direct" and
    // produced a wall of glyphs with no room for the edges and spines that
    // carry the meaning — the interstices are the first thing crowding
    // destroys, so density is its own reason to hand over.
    const deep = [node("r", null, "claimed")];
    for (let i = 0; i < 120; i += 1) deep.push(node(`d${i}`, i === 0 ? "r" : `d${i - 1}`, "verified"));
    const result = render(deep, 60, 6);
    expect(result.metrics.encoding).toBe("braille");
    // The handover is a change of instrument, not a loss: everything is shown.
    expect(result.metrics.elided_node_count).toBe(0);
  });

  it("keeps every row inside the requested width at the crossover", () => {
    for (const count of [6, 40, 300]) {
      for (const line of render(fanOf(count), 60, 6).lines) {
        expect(line.length).toBeLessThanOrEqual(60);
      }
    }
  });
});
