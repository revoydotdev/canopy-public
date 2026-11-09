import { describe, expect, it } from "vitest";
import { TextAttributes } from "@opentui/core";
import { ansiToStyledText } from "../src/ansi-styled-text.js";

const ESC = String.fromCharCode(27);
const CSI = ESC + "[";
const RESET = CSI + "0m";

function chunks(input: string) {
  return ansiToStyledText(input).chunks;
}

describe("ansiToStyledText (pure SGR parser)", () => {
  it("returns a single unstyled chunk for plain text with no escapes", () => {
    const result = chunks("plain text");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: "plain text" });
    expect(result[0]?.fg).toBeUndefined();
    expect(result[0]?.bg).toBeUndefined();
    expect(result[0]?.attributes).toBeUndefined();
  });

  it("parses 24-bit truecolor foreground (38;2;r;g;b)", () => {
    const result = chunks(`${CSI}38;2;10;20;30m` + "colored" + RESET);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("colored");
    expect(result[0]?.fg?.toInts()).toEqual([10, 20, 30, 255]);
    expect(result[0]?.bg).toBeUndefined();
  });

  it("parses 24-bit truecolor background (48;2;r;g;b)", () => {
    const result = chunks(`${CSI}48;2;40;50;60m` + "bg" + RESET);
    expect(result).toHaveLength(1);
    expect(result[0]?.bg?.toInts()).toEqual([40, 50, 60, 255]);
    expect(result[0]?.fg).toBeUndefined();
  });

  it("combines fg and bg from separate SGR codes in one escape", () => {
    const result = chunks(`${CSI}38;2;1;2;3;48;2;4;5;6m` + "both" + RESET);
    expect(result).toHaveLength(1);
    expect(result[0]?.fg?.toInts()).toEqual([1, 2, 3, 255]);
    expect(result[0]?.bg?.toInts()).toEqual([4, 5, 6, 255]);
  });

  it.each([
    ["bold", "1", TextAttributes.BOLD],
    ["dim", "2", TextAttributes.DIM],
    ["italic", "3", TextAttributes.ITALIC],
    ["underline", "4", TextAttributes.UNDERLINE],
    ["strikethrough", "9", TextAttributes.STRIKETHROUGH],
  ])("parses the %s attribute code", (_name, code, flag) => {
    const result = chunks(`${CSI}${code}m` + "styled" + RESET);
    expect(result).toHaveLength(1);
    expect(result[0]?.attributes).toBe(flag);
  });

  it("combines multiple attribute codes in one escape", () => {
    const result = chunks(`${CSI}1;4m` + "bold-underline" + RESET);
    expect(result[0]?.attributes).toBe(TextAttributes.BOLD | TextAttributes.UNDERLINE);
  });

  it("resets fg/bg/attributes on code 0", () => {
    const result = chunks(`${CSI}1;38;2;9;9;9m` + "styled" + RESET + "plain");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ text: "styled" });
    expect(result[0]?.fg?.toInts()).toEqual([9, 9, 9, 255]);
    expect(result[0]?.attributes).toBe(TextAttributes.BOLD);
    expect(result[1]).toMatchObject({ text: "plain" });
    expect(result[1]?.fg).toBeUndefined();
    expect(result[1]?.attributes).toBeUndefined();
  });

  it("treats a bare ESC[m (no params) as a full reset", () => {
    const result = chunks(`${CSI}1m` + "bold" + `${CSI}m` + "plain");
    expect(result).toHaveLength(2);
    expect(result[0]?.attributes).toBe(TextAttributes.BOLD);
    expect(result[1]?.attributes).toBeUndefined();
  });

  it("splits text into multiple runs across style changes without duplicating or dropping text", () => {
    const input = `${CSI}38;2;1;1;1m` + "red" + `${CSI}38;2;2;2;2m` + "green" + RESET + "plain";
    const result = chunks(input);
    expect(result.map((chunk) => chunk.text).join("")).toBe("redgreenplain");
    expect(result[0]?.fg?.toInts()).toEqual([1, 1, 1, 255]);
    expect(result[1]?.fg?.toInts()).toEqual([2, 2, 2, 255]);
    expect(result[2]?.fg).toBeUndefined();
  });

  it("ignores unsupported SGR codes (indexed 256-color, blink, reverse) without dropping surrounding text", () => {
    const result = chunks(`${CSI}5m` + "blink-code-ignored" + RESET + `${CSI}38;5;200m` + "indexed-ignored" + RESET);
    expect(result.map((chunk) => chunk.text).join("")).toBe("blink-code-ignoredindexed-ignored");
    for (const chunk of result) {
      expect(chunk.fg).toBeUndefined();
      expect(chunk.bg).toBeUndefined();
      expect(chunk.attributes).toBeUndefined();
    }
  });

  it("keeps attribute codes preceding a truncated truecolor sequence, dropping only the color", () => {
    const result = chunks(`${CSI}1;38;2;9m` + "text" + RESET);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("text");
    expect(result[0]?.attributes).toBe(TextAttributes.BOLD);
    expect(result[0]?.fg).toBeUndefined();
  });

  it("drops the entire rest of an escape once a truncated truecolor sequence is hit, not reinterpreting leftovers as codes", () => {
    // "9" here is `38;2;9`'s stray third param, not the strikethrough code —
    // it must not resurrect as STRIKETHROUGH once the color group fails.
    const result = chunks(`${CSI}38;2;9m` + "text" + RESET);
    expect(result[0]?.fg).toBeUndefined();
    expect(result[0]?.attributes).toBeUndefined();
  });

  it("drops a truncated/malformed escape sequence with no final byte, never leaking the ESC byte", () => {
    const result = chunks("before" + CSI + "38;2;1");
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("before");
    expect(result.map((chunk) => chunk.text).join("")).not.toContain(ESC);
  });

  it("drops a lone/unrecognized ESC byte that is not followed by '['", () => {
    const result = chunks("a" + ESC + "Zb");
    const text = result.map((chunk) => chunk.text).join("");
    expect(text).not.toContain(ESC);
    expect(text).toBe("aZb");
  });

  it("drops non-SGR CSI sequences (e.g. cursor movement) entirely, leaking no bytes", () => {
    const result = chunks("a" + CSI + "2J" + "b");
    const text = result.map((chunk) => chunk.text).join("");
    expect(text).toBe("ab");
    expect(text).not.toContain(ESC);
  });

  it("round-trips an empty string", () => {
    expect(chunks("")).toHaveLength(0);
  });

  it("matches the real reset/bold/dim SGR bytes this package's own player-piano.ts colorize emits (each styled run self-resets)", () => {
    // colorize(text, code) = code + text + ANSI.reset (player-piano.ts):
    // bold-reset then dim-reset -- every run resets before the next starts.
    const result = chunks(`${CSI}1m` + "bold" + RESET + `${CSI}2m` + "dim" + RESET + "plain");
    expect(result[0]).toMatchObject({ text: "bold", attributes: TextAttributes.BOLD });
    expect(result[1]).toMatchObject({ text: "dim", attributes: TextAttributes.DIM });
    expect(result[2]).toMatchObject({ text: "plain" });
    expect(result[2]?.attributes).toBeUndefined();
  });

  it("accumulates attributes across escapes that do not reset in between, exactly like a real terminal", () => {
    const result = chunks(`${CSI}1m` + "bold" + `${CSI}2m` + "bold-and-dim" + RESET);
    expect(result[0]).toMatchObject({ text: "bold", attributes: TextAttributes.BOLD });
    expect(result[1]).toMatchObject({ text: "bold-and-dim", attributes: TextAttributes.BOLD | TextAttributes.DIM });
  });
});
