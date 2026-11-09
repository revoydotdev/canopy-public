/**
 * renderer-synchronized-output.test.ts — a frame reaches a real terminal as one
 * atomic update, and a captured stream stays byte-clean.
 *
 * WHY. `StdoutRenderer` repaints by seeking to each changed row and writing it.
 * Painted incrementally, a fast update can be observed mid-repaint: the tearing
 * that reads as flicker. DEC private mode 2026 asks the terminal to buffer
 * everything between `?2026h` and `?2026l` and present it in one update, which
 * is the actual mechanism that removes the tearing — no widget, layout, or
 * frame-rate change above this layer can substitute for it.
 *
 * It must not be unconditional. A piped or recorded stdout is not a terminal,
 * and these bytes would contaminate a golden frame or a tmux acceptance
 * recording with escape sequences the operator never sees. So the markers are
 * opt-in, and the tests below pin BOTH directions: present when enabled, and
 * entirely absent otherwise.
 *
 * Escape sequences are built from `String.fromCharCode(27)` rather than written
 * as literal escape bytes, matching theme.ts's existing convention.
 */
import { describe, it, expect } from "vitest";
import { StdoutRenderer } from "../src/renderer.js";
import { textOnlyFrame } from "./support/render-harness.js";

const CSI = String.fromCharCode(27) + "[";
const BEGIN_SYNC = `${CSI}?2026h`;
const END_SYNC = `${CSI}?2026l`;
const ERASE_LINE = `${CSI}K`;

function recorder(): { writes: string[]; stream: never } {
  const writes: string[] = [];
  return { writes, stream: { write: (value: string) => { writes.push(value); return true; } } as never };
}

describe("DEC synchronized output", () => {
  it("brackets the first full frame when enabled", () => {
    const { writes, stream } = recorder();
    const renderer = new StdoutRenderer(stream, { clear_screen: false, synchronized_output: true });
    renderer.render(textOnlyFrame("row0\nrow1"));
    expect(writes).toHaveLength(1);
    expect(writes[0].startsWith(BEGIN_SYNC)).toBe(true);
    expect(writes[0].endsWith(END_SYNC)).toBe(true);
  });

  it("brackets a diffed repaint as a single atomic write", () => {
    const { writes, stream } = recorder();
    const renderer = new StdoutRenderer(stream, { clear_screen: false, synchronized_output: true });
    renderer.render(textOnlyFrame("row0\nrow1\nrow2"));
    writes.length = 0;
    renderer.render(textOnlyFrame("row0\nCHANGED\nALSO"));
    // One write, not one per changed row — the whole repaint is the atom.
    expect(writes).toHaveLength(1);
    expect(writes[0].startsWith(BEGIN_SYNC)).toBe(true);
    expect(writes[0].endsWith(END_SYNC)).toBe(true);
    expect(writes[0]).toContain("CHANGED");
    expect(writes[0]).toContain("ALSO");
  });

  it("emits nothing at all when a frame is unchanged, markers included", () => {
    const { writes, stream } = recorder();
    const renderer = new StdoutRenderer(stream, { clear_screen: false, synchronized_output: true });
    renderer.render(textOnlyFrame("row0\nrow1"));
    writes.length = 0;
    renderer.render(textOnlyFrame("row0\nrow1"));
    // An empty synchronized update is still terminal traffic; a no-op must be
    // a true no-op, or an idle TUI would stream markers forever.
    expect(writes).toHaveLength(0);
  });

  it("omits the markers entirely when not enabled", () => {
    const { writes, stream } = recorder();
    const renderer = new StdoutRenderer(stream, { clear_screen: false });
    renderer.render(textOnlyFrame("row0\nrow1"));
    renderer.render(textOnlyFrame("row0\nCHANGED"));
    const all = writes.join("");
    expect(all).not.toContain(BEGIN_SYNC);
    expect(all).not.toContain(END_SYNC);
    expect(all).toContain("CHANGED");
  });
});

describe("row diffing does not measure escape bytes as columns", () => {
  it("repaints a colored row without padding it by its SGR byte length", () => {
    const { writes, stream } = recorder();
    const renderer = new StdoutRenderer(stream, { clear_screen: false });
    const colored = `${CSI}38;2;110;220;140mshort${CSI}0m`;
    renderer.render(textOnlyFrame("short\nx"));
    writes.length = 0;
    renderer.render(textOnlyFrame(`${colored}\nx`));
    const written = writes.join("");
    expect(written).toContain(colored);
    // The old implementation right-padded every row to the longest RAW string
    // length, so a row carrying ~20 bytes of SGR was padded by ~20 spaces it
    // did not need. The erase-line sequence already clears the row's tail, so a
    // correct repaint carries no padding run at all.
    expect(written).not.toMatch(/ {5,}/u);
  });

  it("full-repaints (not a selective per-row erase) when the row count changes -- a real terminal never shrinks its row count except by resizing", () => {
    // `renderScene`/`renderCockpitScene` always emit exactly `terminal.rows`
    // lines -- a real SceneFrame's row count changes only when the terminal
    // itself resizes, never from content alone. A row-count change between
    // frames is therefore a resize signal: the physical terminal may have
    // already reflowed or cleared its buffer out-of-band, so `StdoutRenderer`
    // must not trust its own diff cache (which only knows what *it* last
    // wrote) to selectively erase stale rows -- it forces a full repaint
    // instead (see stdout-renderer-resize-repaint.test.ts for the defect this
    // closes).
    const { writes, stream } = recorder();
    const renderer = new StdoutRenderer(stream, { clear_screen: false });
    renderer.render(textOnlyFrame("a\nb\nc"));
    writes.length = 0;
    renderer.render(textOnlyFrame("a"));
    const written = writes.join("");
    expect(written).not.toContain(`${CSI}2;1H`);
    expect(written).not.toContain(ERASE_LINE);
    expect(written).toContain("a");
  });
});
