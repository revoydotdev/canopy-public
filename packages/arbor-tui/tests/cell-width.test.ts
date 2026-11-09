import { describe, expect, it } from "vitest";
import { createNavigation, displayCells, displayWidth, initialModel, type RenderProjection } from "../src/index.js";
import { renderTerminalFrame } from "./support/render-harness.js";

function projection(columns: number, rows: number, output: string, title = "Output"): RenderProjection {
  return {
    app: initialModel(), output,
    navigation: createNavigation({
      id: "main", route: "/", split: "horizontal", ratio: 0.5,
      panes: [{ id: "output", title }],
    }, { columns, rows }),
  };
}

/** Every bordered row of a frame must occupy exactly the same display width. */
function borderedRowWidths(frame: string): number[] {
  return frame.split("\n").filter((row) => /[│┐┘|+]$/u.test(row)).map((row) => displayWidth(row));
}

describe("4F.9 cell-width correctness", () => {
  it("CJK pane content occupies two cells per glyph without pushing the right border", () => {
    const frame = renderTerminalFrame(projection(24, 6, "漢字テスト"));
    expect(frame).toContain("漢字テスト");
    const widths = borderedRowWidths(frame);
    expect(widths.length).toBeGreaterThan(0);
    expect(new Set(widths).size).toBe(1);
    for (const row of frame.split("\n")) expect(displayWidth(row)).toBeLessThanOrEqual(24);
  });

  it("clips overflowing wide content by display width, keeping the border intact", () => {
    const frame = renderTerminalFrame(projection(12, 5, "漢字漢字漢字漢字漢字漢字"));
    for (const row of frame.split("\n")) expect(displayWidth(row)).toBeLessThanOrEqual(12);
    const bordered = frame.split("\n").filter((row) => row.startsWith("│"));
    expect(bordered.length).toBeGreaterThan(0);
    for (const row of bordered) expect(row.endsWith("│")).toBe(true);
  });

  it("CJK pane titles clip by display width in the border row", () => {
    const frame = renderTerminalFrame(projection(20, 5, "body", "日本語タイトル"));
    const widths = borderedRowWidths(frame);
    expect(new Set(widths).size).toBe(1);
    for (const row of frame.split("\n")) expect(displayWidth(row)).toBeLessThanOrEqual(20);
  });

  it("combining marks fold into their base cell", () => {
    const frame = renderTerminalFrame(projection(24, 5, "xͤy"));
    expect(frame).toContain("xͤy");
    const widths = borderedRowWidths(frame);
    expect(new Set(widths).size).toBe(1);
  });

  it("emoji and ZWJ sequences stay inside the grid", () => {
    const frame = renderTerminalFrame(projection(24, 5, "🔥 fire 👨‍👩‍👧"));
    const widths = borderedRowWidths(frame);
    expect(new Set(widths).size).toBe(1);
    for (const row of frame.split("\n")) expect(displayWidth(row)).toBeLessThanOrEqual(24);
  });

  it("displayCells: wide glyphs yield head + empty continuation; folds match displayWidth", () => {
    expect(displayCells("ab")).toEqual(["a", "b"]);
    expect(displayCells("漢")).toEqual(["漢", ""]);
    expect(displayCells("xͤy")).toEqual(["xͤ", "y"]);
    for (const value of ["hello", "漢字テスト", "xͤy", "🔥 fire", "👨‍👩‍👧", "ﾊﾝｶｸ", ""]) {
      expect(displayCells(value).length).toBe(displayWidth(value));
    }
  });

  // Defect (tui-overhaul m2 reel): typing "café 👩‍💻 漢字" disagreed with the
  // terminal's own cursor math because the old code point loop counted each
  // half of a ZWJ sequence as its own double-width glyph (width 4 for one
  // glyph a terminal paints at width 2), leaving stray border glyphs/blank
  // cells beside the emoji.
  it("a ZWJ emoji sequence (woman technologist) is ONE double-width glyph, not two", () => {
    expect(displayWidth("👩‍💻")).toBe(2);
    expect(displayCells("👩‍💻")).toEqual(["👩‍💻", ""]);
  });

  it("a combining acute accent (decomposed e + U+0301) folds into its base, matching precomposed é", () => {
    expect(displayWidth("é")).toBe(1);
    expect(displayCells("é")).toHaveLength(1);
    expect(displayWidth("é")).toBe(displayWidth("é"));
  });

  it("a regional-indicator flag pair is one double-width glyph, not two single-width symbols", () => {
    const usFlag = "\u{1F1FA}\u{1F1F8}"; // US flag: REGIONAL INDICATOR U + S
    expect(displayWidth(usFlag)).toBe(2);
    expect(displayCells(usFlag)).toEqual([usFlag, ""]);
  });

  it("CJK ideographs stay two independent double-width glyphs (not merged by clustering)", () => {
    expect(displayWidth("漢字")).toBe(4);
    expect(displayCells("漢字")).toEqual(["漢", "", "字", ""]);
  });

  it("a full composer draft mixing combining marks, ZWJ, and CJK renders inside the grid", () => {
    const frame = renderTerminalFrame(projection(40, 6, "café 👩‍💻 漢字"));
    const widths = borderedRowWidths(frame);
    expect(new Set(widths).size).toBe(1);
    for (const row of frame.split("\n")) expect(displayWidth(row)).toBeLessThanOrEqual(40);
  });
});
