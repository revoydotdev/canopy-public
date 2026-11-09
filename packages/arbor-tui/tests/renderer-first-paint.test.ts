import { describe, expect, it } from "vitest";
import { StdoutRenderer } from "../src/renderer.js";
import { textOnlyFrame } from "./support/render-harness.js";

describe("full-height stdout first paint", () => {
  it("does not scroll the frame before applying row-addressed diffs", () => {
    const writes: string[] = [];
    const renderer = new StdoutRenderer({ write: (value) => { writes.push(value); } });
    try {
      // Same terminal width (a stable, explicit `columns`) across both
      // frames — this exercises content diffing, not a resize.
      renderer.render(textOnlyFrame("border\nbody\nstatus", 6));
      const firstPaint = writes.at(-1)!;
      expect(firstPaint.split("\n")).toHaveLength(3);
      expect(firstPaint.endsWith("\n")).toBe(false);
      writes.length = 0;
      renderer.render(textOnlyFrame("border\nchanged\nstatus", 6));
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("\u001b[2;1Hchanged");
      expect(writes[0]).not.toContain("\n");
    } finally { renderer.restore(); }
  });

  it("retains the newline for non-full-screen output", () => {
    const writes: string[] = [];
    const renderer = new StdoutRenderer({ write: (value) => { writes.push(value); } }, { clear_screen: false });
    try {
      renderer.render(textOnlyFrame("line"));
      expect(writes.at(-1)?.endsWith("\n")).toBe(true);
    } finally { renderer.restore(); }
  });
});
