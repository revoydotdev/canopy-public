import { describe, expect, it } from "vitest";
import { StdoutRenderer, type RenderedFrame } from "../src/index.js";

/**
 * A live terminal resize is an out-of-band event: the physical terminal
 * reflows or clears its own screen buffer independent of any byte
 * `StdoutRenderer` ever wrote. Its row-diff cache (`this.previous`) only
 * knows what *this renderer* last sent — after a resize, that cache no
 * longer describes what is actually on screen, so a row whose freshly
 * computed text coincidentally matches the prior frame's text at the same
 * index must still be repainted (real defect, found via the tui-pilot
 * `resize` scenario against a real pty + `@xterm/headless`: shrinking then
 * growing the terminal produced fully blank captured frames because the
 * diff cache suppressed rewriting rows whose text had not changed, even
 * though the physical screen had already been reset by the resize itself).
 */
function frame(columns: number, rows: readonly string[]): RenderedFrame {
  return Object.freeze({
    text: rows.join("\n"),
    scene: Object.freeze({ columns, rows: Object.freeze(rows), panes: Object.freeze([]), status_row: null }),
  });
}

describe("StdoutRenderer resize repaint", () => {
  it("repaints every row after a geometry change even when the row text is byte-identical to the last frame", () => {
    const out: string[] = [];
    const renderer = new StdoutRenderer({ write: (v: string) => { out.push(v); } }, { clear_screen: false });
    renderer.render(frame(10, ["same-row-0", "same-row-1"]));
    out.length = 0;
    // Same text at every row index, but a narrower terminal (a resize, not a
    // no-op redraw) -- the naive row-by-row diff sees no textual change
    // anywhere and would write nothing at all.
    renderer.render(frame(5, ["same-row-0", "same-row-1"]));
    const written = out.join("");
    expect(written).not.toBe("");
    expect(written).toContain("same-row-0");
    expect(written).toContain("same-row-1");
  });

  it("clears the screen before repainting on a resize (alt-screen/clear_screen enabled)", () => {
    const out: string[] = [];
    const renderer = new StdoutRenderer({ write: (v: string) => { out.push(v); } });
    renderer.render(frame(10, ["row-a", "row-b"]));
    out.length = 0;
    renderer.render(frame(4, ["row-a", "row-b"]));
    expect(out.join("")).toContain("[2J[H");
  });

  it("does not clear or force a repaint when geometry is unchanged and content is identical (no resize regression)", () => {
    const out: string[] = [];
    const renderer = new StdoutRenderer({ write: (v: string) => { out.push(v); } }, { clear_screen: false });
    renderer.render(frame(10, ["row-a", "row-b"]));
    out.length = 0;
    renderer.render(frame(10, ["row-a", "row-b"]));
    expect(out.join("")).toBe("");
  });

  it("a real content change at stable geometry still only rewrites the changed row (diffing is preserved)", () => {
    const out: string[] = [];
    const renderer = new StdoutRenderer({ write: (v: string) => { out.push(v); } }, { clear_screen: false });
    renderer.render(frame(10, ["row-a", "row-b", "row-c"]));
    out.length = 0;
    renderer.render(frame(10, ["row-a", "CHANGED", "row-c"]));
    const written = out.join("");
    expect(written).not.toContain("[2J[H");
    expect(written).toContain("[2;1H");
    expect(written).toContain("CHANGED");
  });
});
