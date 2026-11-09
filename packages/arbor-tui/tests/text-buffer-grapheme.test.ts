import { describe, expect, it } from "vitest";
import { backspace, deleteForward, fromText, moveCursor } from "../src/text-buffer.js";

describe("text-buffer: grapheme-cluster cursor movement (ui-spec §7)", () => {
  it("moves left/right over a combining-mark cluster as one unit", () => {
    const combining = "é"; // "é" as base + combining acute accent
    const text = `a${combining}b`;
    const state = fromText(text); // cursor at end (4)
    const left1 = moveCursor(state, "left");
    expect(left1.cursor).toBe(3); // steps over "b"
    const left2 = moveCursor(left1, "left");
    expect(left2.cursor).toBe(1); // steps over the whole "é" cluster, not just "́"
    const right = moveCursor(left2, "right");
    expect(right.cursor).toBe(3);
  });

  it("moves left/right over a ZWJ emoji sequence as one unit", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // man-woman-girl family, one grapheme
    const text = `x${family}y`;
    const state = fromText(text);
    const left1 = moveCursor(state, "left");
    expect(left1.cursor).toBe(text.length - 1); // steps over "y"
    const left2 = moveCursor(left1, "left");
    expect(left2.cursor).toBe(1); // steps over the entire family cluster in one hop
    const right = moveCursor(left2, "right");
    expect(right.cursor).toBe(text.length - 1);
  });

  it("moves left/right over wide CJK characters (still one code point per cluster)", () => {
    const text = "你好";
    const state = fromText(text);
    const left1 = moveCursor(state, "left");
    expect(left1.cursor).toBe(1);
    const left2 = moveCursor(left1, "left");
    expect(left2.cursor).toBe(0);
  });

  it("backspace removes a whole combining-mark cluster, not one code unit", () => {
    const combining = "é";
    const state = fromText(`a${combining}`);
    const after = backspace(state);
    expect(after.text).toBe("a");
    expect(after.cursor).toBe(1);
  });

  it("backspace removes a whole ZWJ emoji cluster in one press", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const state = fromText(`x${family}`);
    const after = backspace(state);
    expect(after.text).toBe("x");
  });

  it("delete-forward removes a whole cluster ahead of the cursor", () => {
    const combining = "é";
    const text = `${combining}z`;
    const state = { text, cursor: 0 };
    const after = deleteForward(state);
    expect(after.text).toBe("z");
    expect(after.cursor).toBe(0);
  });
});
