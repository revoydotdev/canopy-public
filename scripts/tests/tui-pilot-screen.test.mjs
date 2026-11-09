/**
 * scripts/tests/tui-pilot-screen.test.mjs — the emulator snapshot is the
 * terminal's grid, with its colour.
 *
 * Two properties matter for evidence. First, stale cells survive: a shorter
 * repaint over a longer row leaves the old tail on screen exactly as a real
 * terminal would, which is the class of defect `createTestRenderer` cannot
 * show (EC-030). Second, SGR attributes reach the SVG, so contrast and
 * emphasis are reviewable — the old `magick label:` PNGs discarded them.
 */
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { renderSvg, snapshotScreen, sha256 } from "../tui-pilot/lib/screen.mjs";

const ESC = "\u001b";
const write = (term, text) => new Promise((resolve) => term.write(text, resolve));

describe("snapshotScreen", () => {
  it("reads text, trims the right edge, and keeps the padded row", async () => {
    const term = new Terminal({ cols: 20, rows: 3, allowProposedApi: true });
    await write(term, `${ESC}[H${ESC}[2Jhello${ESC}[2;3Hworld`);
    const snap = snapshotScreen(term);
    expect(snap.lines).toEqual(["hello", "  world", ""]);
    expect(snap.padded[1]).toBe("  world".padEnd(20));
    expect(snap.sha256).toBe(sha256("hello\n  world\n"));
  });

  it("keeps stale cells a shorter repaint never wrote", async () => {
    const term = new Terminal({ cols: 30, rows: 2, allowProposedApi: true });
    await write(term, `${ESC}[H${ESC}[2JEnter focus · Ctrl+P palette`);
    // A styled repaint that writes each word at its column and skips the
    // spaces between them (the EC-030 emission shape): whatever was in the
    // skipped cells stays.
    await write(term, `${ESC}[1;1HXXXXX${ESC}[1;7HYYYYY`);
    expect(snapshotScreen(term).lines[0]).toBe("XXXXX YYYYY · Ctrl+P palette");
  });

  it("carries RGB and palette colour, bold and inverse into runs", async () => {
    const term = new Terminal({ cols: 20, rows: 1, allowProposedApi: true });
    await write(term, `${ESC}[H${ESC}[38;2;10;200;100mab${ESC}[0m${ESC}[1;31mc${ESC}[0m${ESC}[7md${ESC}[0m`);
    const [row] = snapshotScreen(term).runs;
    expect(row[0]).toMatchObject({ x: 0, t: "ab", fg: "#0ac864", b: false });
    expect(row[1]).toMatchObject({ x: 2, t: "c", fg: "#e06c75", b: true });
    // Inverse swaps default fg/bg so the run renders as a highlighted cell.
    expect(row[2]).toMatchObject({ x: 3, t: "d", bg: "#d9e3e8" });
  });

  it("renders the SVG with the run's colour and a caption", async () => {
    const term = new Terminal({ cols: 10, rows: 1, allowProposedApi: true });
    await write(term, `${ESC}[H${ESC}[38;2;255;0;0mred${ESC}[0m <tag>`);
    const svg = renderSvg(snapshotScreen(term), { caption: "f0001 test" });
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain("&lt;tag&gt;");
    expect(svg).toContain("f0001 test");
  });
});
