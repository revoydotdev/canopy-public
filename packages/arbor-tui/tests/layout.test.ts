import { describe, expect, it } from "vitest";
import { computeShellLayout, focusZonesForShellLayout, type ShellLayout, type ShellLayoutRect } from "../src/layout.js";

function within(rect: ShellLayoutRect, columns: number, rows: number): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.columns >= 0 && rect.rows >= 0
    && rect.x + rect.columns <= columns && rect.y + rect.rows <= rows;
}

function overlaps(a: ShellLayoutRect, b: ShellLayoutRect): boolean {
  if (a.columns <= 0 || a.rows <= 0 || b.columns <= 0 || b.rows <= 0) return false;
  return a.x < b.x + b.columns && b.x < a.x + a.columns && a.y < b.y + b.rows && b.y < a.y + a.rows;
}

/** Every rect the layout paints, keyed by name, excluding the drawer overlay (which is allowed to overlap the transcript only). */
function paintedRects(layout: ShellLayout): Record<string, ShellLayoutRect | null> {
  return {
    header: layout.header,
    transcript: layout.transcript,
    composer: layout.composer,
    rail: layout.rail,
    warning: layout.warning,
  };
}

describe("computeShellLayout: property invariants (ui-spec §2.5)", () => {
  for (let columns = 1; columns <= 220; columns += 7) {
    for (let rows = 1; rows <= 70; rows += 5) {
      it(`in-bounds/non-overlap/deterministic at ${columns}x${rows}`, () => {
        const layout = computeShellLayout({ columns, rows });
        const rects = paintedRects(layout);
        for (const [name, rect] of Object.entries(rects)) {
          if (rect === null) continue;
          expect(within(rect, columns, rows), `${name} out of bounds`).toBe(true);
        }
        const named = Object.entries(rects).filter((entry): entry is [string, ShellLayoutRect] => entry[1] !== null);
        for (let i = 0; i < named.length; i += 1) {
          for (let j = i + 1; j < named.length; j += 1) {
            expect(overlaps(named[i]![1], named[j]![1]), `${named[i]![0]} overlaps ${named[j]![0]} at ${columns}x${rows}`).toBe(false);
          }
        }
        // The drawer/compressed overlay may only overlap the transcript, never the composer.
        if (layout.rail_overlay !== null) {
          expect(within(layout.rail_overlay, columns, rows)).toBe(true);
          expect(overlaps(layout.rail_overlay, layout.composer)).toBe(false);
        }
        if (rows >= 3) {
          expect(layout.composer.rows).toBeGreaterThanOrEqual(1);
          expect(layout.composer.columns).toBeGreaterThanOrEqual(1);
        }
        // Pure function: identical input, identical output.
        const again = computeShellLayout({ columns, rows });
        expect(again).toEqual(layout);
      });
    }
  }

  it("keeps the main region >= 72 columns whenever a docked rail is present", () => {
    for (let columns = 120; columns <= 220; columns += 3) {
      const layout = computeShellLayout({ columns, rows: 40 });
      if (layout.rail !== null) {
        expect(columns - layout.rail.columns).toBeGreaterThanOrEqual(72);
      }
    }
  });

  it("never opens the drawer/compressed overlay without an explicit request", () => {
    for (const [columns, rows] of [[100, 30], [70, 20]] as const) {
      expect(computeShellLayout({ columns, rows, rail: "auto" }).rail_overlay).toBeNull();
      expect(computeShellLayout({ columns, rows, rail: "closed" }).rail_overlay).toBeNull();
    }
  });
});

describe("computeShellLayout: exact viewports", () => {
  it("offers focus targets only for visible zones", () => {
    expect(focusZonesForShellLayout(computeShellLayout({ columns: 59, rows: 15, rail: "open" }))).toEqual(["composer", "transcript"]);
    expect(focusZonesForShellLayout(computeShellLayout({ columns: 80, rows: 24, rail: "open" }))).toEqual(["composer", "transcript", "rail", "graph"]);
  });
  it("160x48 -> docked, full header, 72+ main, docked rail", () => {
    const layout = computeShellLayout({ columns: 160, rows: 48 });
    expect(layout.layout_class).toBe("docked");
    expect(layout.header).toEqual({ x: 0, y: 0, columns: 160, rows: 12 });
    expect(layout.rail).not.toBeNull();
    expect(160 - layout.rail!.columns).toBeGreaterThanOrEqual(72);
    expect(layout.rail!.y).toBe(12);
    expect(layout.rail!.rows).toBe(48 - 12);
    expect(layout.composer.y + layout.composer.rows).toBe(48);
    expect(layout.transcript.y).toBe(12);
    expect(layout.transcript.rows + layout.composer.rows).toBe(48 - 12);
  });

  it("120x36 -> docked (cols>=120, rows>=24)", () => {
    const layout = computeShellLayout({ columns: 120, rows: 36 });
    expect(layout.layout_class).toBe("docked");
    expect(layout.header!.rows).toBe(12);
    expect(layout.rail).not.toBeNull();
    expect(120 - layout.rail!.columns).toBeGreaterThanOrEqual(72);
  });

  it("100x30 -> drawer (80<=cols<120, rows>=24), no docked rail", () => {
    const layout = computeShellLayout({ columns: 100, rows: 30 });
    expect(layout.layout_class).toBe("drawer");
    expect(layout.rail).toBeNull();
    expect(layout.header!.rows).toBe(10);
    expect(layout.composer.columns).toBe(100);
    expect(computeShellLayout({ columns: 100, rows: 30, rail: "open" }).rail_overlay).not.toBeNull();
  });

  it("80x24 -> drawer boundary (cols>=80, rows>=24)", () => {
    const layout = computeShellLayout({ columns: 80, rows: 24 });
    expect(layout.layout_class).toBe("drawer");
    expect(layout.header!.rows).toBe(8);
  });

  it("60x18 -> compressed (cols<80, rows in [16,24))", () => {
    const layout = computeShellLayout({ columns: 60, rows: 18 });
    expect(layout.layout_class).toBe("compressed");
    expect(layout.header!.rows).toBe(4);
    expect(layout.rail).toBeNull();
  });

  it("50x14 -> minimal, size warning row, composer >= 1 row", () => {
    const layout = computeShellLayout({ columns: 50, rows: 14 });
    expect(layout.layout_class).toBe("minimal");
    expect(layout.warning).toEqual({ x: 0, y: 0, columns: 50, rows: 1 });
    expect(layout.header).toBeNull();
    expect(layout.composer.rows).toBeGreaterThanOrEqual(1);
    expect(layout.transcript.y).toBe(1);
  });

  it("offers only painted focus zones at 59x15, and restores them after regrowth", () => {
    const minimal = computeShellLayout({ columns: 59, rows: 15, rail: "open" });
    expect(focusZonesForShellLayout(minimal)).toEqual(["composer", "transcript"]);
    const grown = computeShellLayout({ columns: 80, rows: 24, rail: "open" });
    expect(focusZonesForShellLayout(grown)).toEqual(["composer", "transcript", "rail", "graph"]);
  });

  it("recovers from minimal back to docked geometry on regrow (120x36)", () => {
    const shrunk = computeShellLayout({ columns: 50, rows: 14 });
    const recovered = computeShellLayout({ columns: 120, rows: 36 });
    expect(shrunk.layout_class).toBe("minimal");
    expect(recovered.layout_class).toBe("docked");
    expect(recovered).toEqual(computeShellLayout({ columns: 120, rows: 36 }));
  });
});

describe("computeShellLayout: header zone folding (ui-spec §2.2)", () => {
  it("folds left/right into the header's first interior row when graph < 24", () => {
    const layout = computeShellLayout({ columns: 60, rows: 18 });
    expect(layout.header_graph).not.toBeNull();
    // Folded: graph does not occupy the header's very first interior row.
    expect(layout.header_graph!.y).toBeGreaterThan(1);
  });

  it("keeps three independent zones at 160 columns", () => {
    const layout = computeShellLayout({ columns: 160, rows: 48 });
    expect(layout.header_left).not.toBeNull();
    expect(layout.header_graph).not.toBeNull();
    expect(layout.header_right).not.toBeNull();
    // +2 internal zone separators, +2 outer frame border columns (left/right).
    expect(layout.header_left!.columns + layout.header_graph!.columns + layout.header_right!.columns + 2 + 2).toBe(160);
    expect(layout.header_graph!.columns).toBeGreaterThanOrEqual(24);
  });
});
