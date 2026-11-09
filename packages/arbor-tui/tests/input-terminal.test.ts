import { describe, expect, it } from "vitest";
import { classifyHeldBurst, decodeTerminalInput, mouseEventToIntent, parseMouseEvent, SplitReplyHold } from "../src/input-terminal.js";

const ESC = String.fromCharCode(27);

describe("parseMouseEvent (SGR mouse protocol)", () => {
  it("parses a wheel-up report", () => {
    expect(parseMouseEvent(`${ESC}[<64;10;5M`)).toEqual({ x: 10, y: 5, action: { kind: "wheel", direction: -1 } });
  });

  it("parses a wheel-down report", () => {
    expect(parseMouseEvent(`${ESC}[<65;10;5M`)).toEqual({ x: 10, y: 5, action: { kind: "wheel", direction: 1 } });
  });

  it("parses a left-button press and release", () => {
    expect(parseMouseEvent(`${ESC}[<0;3;4M`)).toEqual({ x: 3, y: 4, action: { kind: "press", button: "left" } });
    expect(parseMouseEvent(`${ESC}[<0;3;4m`)).toEqual({ x: 3, y: 4, action: { kind: "release", button: "left" } });
  });

  it("parses right and middle buttons", () => {
    expect(parseMouseEvent(`${ESC}[<1;1;1M`)).toEqual({ x: 1, y: 1, action: { kind: "press", button: "middle" } });
    expect(parseMouseEvent(`${ESC}[<2;1;1M`)).toEqual({ x: 1, y: 1, action: { kind: "press", button: "right" } });
  });

  it("returns null for malformed or non-mouse input", () => {
    expect(parseMouseEvent("not a mouse report")).toBeNull();
    expect(parseMouseEvent(`${ESC}[<0;0;0M`)).toBeNull(); // coordinates are 1-based; 0 is invalid
    expect(parseMouseEvent(`${ESC}[5~`)).toBeNull(); // a navigation key sequence, not a mouse report
  });
});

describe("decodeTerminalInput", () => {
  it("normalizes terminal Ctrl bytes into reachable catalog events", () => {
    const decoded = decodeTerminalInput(`x\u000ey\u0001z`);
    expect(decoded.keys).toEqual([
      { key: "n", modifiers: ["ctrl"] },
      { key: "a", modifiers: ["ctrl"] },
    ]);
    expect(decoded.text).toBe("xyz");
  });

  it("does not fabricate a Shift modifier for a Ctrl byte", () => {
    expect(decodeTerminalInput("\u0007").keys).toEqual([{ key: "g", modifiers: ["ctrl"] }]);
  });

  it("leaves form-owned Tab, Enter, and carriage return in the text stream", () => {
    const decoded = decodeTerminalInput("\t\n\r");
    expect(decoded.keys).toEqual([]);
    expect(decoded.text).toBe("\t\n\r");
  });

  it("recognizes PageUp/PageDown/Home/End and leaves other bytes as text", () => {
    const decoded = decodeTerminalInput(`ab${ESC}[5~cd${ESC}[6~${ESC}[H${ESC}[F`);
    expect(decoded.keys).toEqual([
      { key: "pageup" },
      { key: "pagedown" },
      { key: "home" },
      { key: "end" },
    ]);
    expect(decoded.text).toBe("abcd");
    expect(decoded.mouse).toEqual([]);
  });

  it("recognizes an SGR mouse wheel report interleaved with plain text", () => {
    const decoded = decodeTerminalInput(`x${ESC}[<65;5;5My`);
    expect(decoded.mouse).toEqual([{ x: 5, y: 5, action: { kind: "wheel", direction: 1 } }]);
    expect(decoded.text).toBe("xy");
    expect(decoded.keys).toEqual([]);
  });

  it("passes an unrecognized escape sequence through as plain text, preserving the bare-Escape convention", () => {
    // A lone Escape keypress (no following CSI bytes) must still surface as
    // the raw ESC character in `text`, since the existing raw stdin loop
    // (packages/arbor-mcp/src/tui.ts) checks `ch === ESC` to mean "cancel".
    const decoded = decodeTerminalInput(`${ESC}`);
    expect(decoded.text).toBe(ESC);
    expect(decoded.keys).toEqual([]);
    expect(decoded.mouse).toEqual([]);
  });

  it("handles multiple Home encodings (VT220 and SS3 forms) identically", () => {
    expect(decodeTerminalInput(`${ESC}[1~`).keys).toEqual([{ key: "home" }]);
    expect(decodeTerminalInput(`${ESC}[7~`).keys).toEqual([{ key: "home" }]);
    expect(decodeTerminalInput(`${ESC}OH`).keys).toEqual([{ key: "home" }]);
  });

  it("recognizes multiple sequences in one chunk in order", () => {
    const decoded = decodeTerminalInput(`${ESC}[5~${ESC}[<65;1;1M${ESC}[6~`);
    expect(decoded.keys).toEqual([{ key: "pageup" }, { key: "pagedown" }]);
    expect(decoded.mouse).toEqual([{ x: 1, y: 1, action: { kind: "wheel", direction: 1 } }]);
  });

  // T2.3b: multiline compose editing needs Delete and word-wise Ctrl+arrow
  // movement recognized as real keys, and a way to distinguish "insert a
  // newline" from "submit" over raw stdin.
  it("recognizes VT220 Delete", () => {
    expect(decodeTerminalInput(`${ESC}[3~`).keys).toEqual([{ key: "delete" }]);
  });

  it("recognizes canopy-debug screenshot and recording function keys", () => {
    expect(decodeTerminalInput(`${ESC}[19~${ESC}[20~`).keys).toEqual([{ key: "f8" }, { key: "f9" }]);
  });

  it("recognizes xterm's Ctrl+Left/Ctrl+Right modified-cursor-key encoding", () => {
    expect(decodeTerminalInput(`${ESC}[1;5D`).keys).toEqual([{ key: "left", modifiers: ["ctrl"] }]);
    expect(decodeTerminalInput(`${ESC}[1;5C`).keys).toEqual([{ key: "right", modifiers: ["ctrl"] }]);
  });

  it("does not let a Ctrl+Left/Right report shadow the plain arrow-key encoding", () => {
    expect(decodeTerminalInput(`${ESC}[D`).keys).toEqual([{ key: "left" }]);
    expect(decodeTerminalInput(`${ESC}[C`).keys).toEqual([{ key: "right" }]);
  });

  it("recognizes the kitty keyboard protocol's Shift+Enter and Alt+Enter (CSI-u) as a normalized newline key", () => {
    expect(decodeTerminalInput(`${ESC}[13;2u`).keys).toEqual([{ key: "newline" }]);
    expect(decodeTerminalInput(`${ESC}[13;3u`).keys).toEqual([{ key: "newline" }]);
  });

  it("recognizes the legacy Alt+Enter encoding (bare ESC immediately followed by CR or LF)", () => {
    expect(decodeTerminalInput(`${ESC}\r`).keys).toEqual([{ key: "newline" }]);
    expect(decodeTerminalInput(`${ESC}\n`).keys).toEqual([{ key: "newline" }]);
    expect(decodeTerminalInput(`${ESC}\r`).text).toBe("");
  });

  it("still passes a genuinely bare Escape through as text, unaffected by the Alt+Enter check", () => {
    const decoded = decodeTerminalInput(`${ESC}x`);
    expect(decoded.keys).toEqual([]);
    expect(decoded.text).toBe(`${ESC}x`);
  });
});

describe("mouseEventToIntent", () => {
  it("routes wheel-up to a negative scroll_by intent", () => {
    expect(mouseEventToIntent({ x: 1, y: 1, action: { kind: "wheel", direction: -1 } })).toEqual({ type: "scroll_by", lines: -3 });
  });

  it("routes wheel-down to a positive scroll_by intent", () => {
    expect(mouseEventToIntent({ x: 1, y: 1, action: { kind: "wheel", direction: 1 } })).toEqual({ type: "scroll_by", lines: 3 });
  });

  it("declines to resolve click/press/release events — hit-testing needs frame geometry this layer does not have", () => {
    expect(mouseEventToIntent({ x: 1, y: 1, action: { kind: "press", button: "left" } })).toBeNull();
    expect(mouseEventToIntent({ x: 1, y: 1, action: { kind: "release", button: "left" } })).toBeNull();
  });
});

describe("SplitReplyHold (EC-048 — a reply whose introducer arrives after its ESC)", () => {
  const BEL = String.fromCharCode(7);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const make = (released: string[][]) => new SplitReplyHold<string>({ textOf: (s) => s, release: (items) => released.push([...items]), quietMs: 40, escapeWindowMs: 250 });

  it("drops a split DCS reply once its ST terminator arrives, and releases nothing", async () => {
    const released: string[][] = [];
    const hold = make(released);
    hold.noteLoneEscape();
    const absorbed = [..."P>|tmux 3.7", ESC, "\\"].map((ch) => hold.offer(ch));
    expect(absorbed.every(Boolean)).toBe(true);
    expect(hold.holding).toBe(false);
    await sleep(80);
    expect(released).toEqual([]);
  });

  it("drops a split BEL-terminated OSC reply", () => {
    const released: string[][] = [];
    const hold = make(released);
    hold.noteLoneEscape();
    for (const ch of `]11;rgb:1e1e/1e1e/2e2e${BEL}`) expect(hold.offer(ch)).toBe(true);
    expect(hold.holding).toBe(false);
  });

  it("releases Escape-then-] (Siblings) as ordinary input after the quiet period instead of eating it", async () => {
    const released: string[][] = [];
    const hold = make(released);
    hold.noteLoneEscape();
    expect(hold.offer("]")).toBe(true);
    expect(hold.holding).toBe(true);
    await sleep(80);
    expect(released).toEqual([["]"]]);
    expect(hold.holding).toBe(false);
  });

  it("does not hold an introducer that arrives outside the escape window, nor a non-introducer", () => {
    let clock = 1_000;
    const released: string[][] = [];
    const hold = new SplitReplyHold<string>({ textOf: (s) => s, release: (items) => released.push([...items]), quietMs: 40, escapeWindowMs: 250, now: () => clock });
    hold.noteLoneEscape();
    clock += 300;
    expect(hold.offer("P")).toBe(false);
    hold.noteLoneEscape();
    expect(hold.offer("x")).toBe(false);
    expect(hold.holding).toBe(false);
  });

  it("reset() discards a pending hold without releasing it", async () => {
    const released: string[][] = [];
    const hold = make(released);
    hold.noteLoneEscape();
    hold.offer("P");
    hold.reset();
    await sleep(80);
    expect(released).toEqual([]);
  });
});

describe("classifyHeldBurst / SplitReplyHold with CSI reports (EC-056)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  it("recognises a cursor-position report, DA1, DA2, DECRPM and kitty flags as replies", () => {
    for (const reply of ["[40;120R", "[?1;2c", "[>1;10;0c", "[?2026;2$y", "[?1u", "[8;40;120t"]) expect(classifyHeldBurst(reply), reply).toBe("reply");
  });
  it("calls a CSI that is not a report keystrokes at its final byte, and an unfinished one incomplete", () => {
    expect(classifyHeldBurst("[")).toBe("incomplete");
    expect(classifyHeldBurst("[40;12")).toBe("incomplete");
    expect(classifyHeldBurst("[A")).toBe("keystrokes");
    expect(classifyHeldBurst("[x")).toBe("keystrokes");
  });
  it("string controls stay incomplete until ST or BEL", () => {
    expect(classifyHeldBurst("P>|tmux 3.7")).toBe("incomplete");
    expect(classifyHeldBurst(`P>|tmux 3.7${ESC}\\`)).toBe("reply");
  });
  it("SplitReplyHold drops a split cursor-position report and releases Escape-then-[ (Compaction) at once", async () => {
    const released: string[][] = [];
    const hold = new SplitReplyHold<string>({ textOf: (s) => s, release: (items) => released.push([...items]), quietMs: 40 });
    hold.noteLoneEscape();
    for (const ch of "[40;120R") expect(hold.offer(ch)).toBe(true);
    expect(hold.holding).toBe(false);
    await sleep(60);
    expect(released).toEqual([]);
    hold.noteLoneEscape();
    expect(hold.offer("[")).toBe(true);
    expect(hold.offer("x")).toBe(true); // final byte proves a chord: released immediately
    expect(released).toEqual([["[", "x"]]);
    expect(hold.holding).toBe(false);
  });
});
