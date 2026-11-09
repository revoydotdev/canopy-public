import { describe, expect, it } from "vitest";
import { backspace, cursorLineInfo, deleteForward, fromText, insertText, moveCursor } from "../src/text-buffer.js";

describe("text-buffer (T2.3b)", () => {
  it("fromText places the cursor at the end", () => {
    expect(fromText("ab")).toEqual({ text: "ab", cursor: 2 });
  });

  it("insertText inserts at the cursor, not the end", () => {
    // type "ab", move left, type "X" -> "aXb"
    let state = insertText(fromText(""), "ab");
    state = moveCursor(state, "left");
    state = insertText(state, "X");
    expect(state).toEqual({ text: "aXb", cursor: 2 });
  });

  it("insertText is a no-op for empty input", () => {
    const state = fromText("ab");
    expect(insertText(state, "")).toBe(state);
  });

  it("backspace deletes before the cursor and is a no-op at offset 0", () => {
    const mid = moveCursor(fromText("abc"), "left");
    expect(backspace(mid)).toEqual({ text: "ac", cursor: 1 });
    const atStart = { text: "abc", cursor: 0 };
    expect(backspace(atStart)).toEqual(atStart);
  });

  it("deleteForward deletes at the cursor and is a no-op at end of text", () => {
    const start = { text: "abc", cursor: 0 };
    expect(deleteForward(start)).toEqual({ text: "bc", cursor: 0 });
    const end = fromText("abc");
    expect(deleteForward(end)).toEqual(end);
  });

  describe("cursor movement", () => {
    it("left/right clamp at the buffer edges", () => {
      const start = { text: "abc", cursor: 0 };
      expect(moveCursor(start, "left")).toEqual(start);
      const end = fromText("abc");
      expect(moveCursor(end, "right")).toEqual(end);
      expect(moveCursor({ text: "abc", cursor: 1 }, "right")).toEqual({ text: "abc", cursor: 2 });
    });

    it("home/end move to the start/end of the current line, not the whole buffer", () => {
      const text = "one\ntwo\nthree";
      const midSecondLine = { text, cursor: text.indexOf("wo") };
      expect(moveCursor(midSecondLine, "home")).toEqual({ text, cursor: 4 });
      expect(moveCursor(midSecondLine, "end")).toEqual({ text, cursor: 7 });
    });

    it("up/down move to the same column in the adjacent line, clamped to that line's length", () => {
      const text = "abcdef\nxy\n123456";
      // cursor at column 5 on line 0 ("abcdef")
      const onFirstLine = { text, cursor: 5 };
      const down = moveCursor(onFirstLine, "down");
      // line 1 ("xy") is only 2 chars -> clamps to its end (offset 7+2=9)
      expect(down).toEqual({ text, cursor: 9 });
      // Column is not "sticky" across a clamp: coming back up lands at the
      // column the clamped position actually held (2), not the original (5).
      const backUp = moveCursor(down, "up");
      expect(backUp).toEqual({ text, cursor: 2 });
    });

    it("up at the first line clamps to offset 0; down at the last line clamps to the end", () => {
      const text = "only";
      expect(moveCursor({ text, cursor: 2 }, "up")).toEqual({ text, cursor: 0 });
      expect(moveCursor({ text, cursor: 2 }, "down")).toEqual({ text, cursor: 4 });
    });

    it("word_left/word_right skip whitespace then a word", () => {
      const text = "foo bar  baz";
      const atEnd = fromText(text);
      const afterBar = moveCursor(atEnd, "word_left");
      expect(afterBar).toEqual({ text, cursor: 9 }); // start of "baz"
      const afterFoo = moveCursor(afterBar, "word_left");
      expect(afterFoo).toEqual({ text, cursor: 4 }); // start of "bar"
      const start = { text, cursor: 0 };
      const toBar = moveCursor(start, "word_right");
      expect(toBar).toEqual({ text, cursor: 3 }); // end of "foo"
    });
  });

  describe("cursorLineInfo", () => {
    it("reports line/column/lineCount for a single-line buffer", () => {
      expect(cursorLineInfo({ text: "hello", cursor: 3 })).toEqual({ line: 0, column: 3, lineCount: 1 });
    });

    it("reports line/column/lineCount across embedded newlines", () => {
      const text = "one\ntwo\nthree";
      expect(cursorLineInfo({ text, cursor: text.indexOf("wo") })).toEqual({ line: 1, column: 1, lineCount: 3 });
      expect(cursorLineInfo({ text, cursor: text.length })).toEqual({ line: 2, column: 5, lineCount: 3 });
    });
  });
});
