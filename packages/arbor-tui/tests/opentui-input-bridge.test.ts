/// <reference types="bun-types" />
// bun:test only (ADR-036/ADR-037) — @opentui/core's native render library
// does not bind under Node, and fails identically inside vitest even when
// vitest itself is launched via `bun x` (Node workers).
// Run with: bun test packages/arbor-tui/tests/opentui-input-bridge.test.ts
//
// OT-2 capability proof: OpenTuiRenderer.onNativeInput bridges OpenTUI's own
// KeyHandler/paste pipeline into the exact same DecodedTerminalInput shape
// input-terminal.ts#decodeTerminalInput produces for the raw stdin path —
// driven here by @opentui/core/testing's REAL createMockKeys (real key
// events through the real native KeyHandler, not a mock standing in for
// either side of the bridge).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMockKeys, createTestRenderer, type TestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { PassThrough } from "node:stream";
import { parseKeypress } from "@opentui/core";
import { decodeOpenTuiKeyEvent, OpenTuiRenderer } from "../src/opentui-renderer.js";
import { SplitReplyHold, TerminalReplyFilter } from "../src/input-terminal.js";
import type { DecodedTerminalInput } from "../src/input-terminal.js";

let setup: TestRendererSetup;
let renderer: TestRenderer;

test("Tab preserves reverse and session modifiers across the native bridge", () => {
  const base = { name: "tab", raw: "\t", sequence: "\t", ctrl: false, meta: false, shift: false };
  expect(decodeOpenTuiKeyEvent(base).text).toBe("\t");
  expect(decodeOpenTuiKeyEvent({ ...base, shift: true }).keys).toEqual([{ key: "tab", modifiers: ["shift"] }]);
  expect(decodeOpenTuiKeyEvent({ ...base, ctrl: true }).keys).toEqual([{ key: "tab", modifiers: ["ctrl"] }]);
});

beforeEach(async () => {
  setup = await createTestRenderer({ width: 80, height: 24 });
  renderer = setup.renderer;
});

afterEach(() => {
  renderer.destroy();
});

describe("OpenTuiRenderer.onNativeInput (OT-2 — single keyboard pipeline, no raw stdin second listener)", () => {
  test("preserves Ctrl+P on a printable native event so the command palette chord remains reachable", () => {
    const decoded = decodeOpenTuiKeyEvent({ name: "p", raw: "p", sequence: "p", ctrl: true, meta: false, shift: false });
    expect(decoded.text).toBe("");
    expect(decoded.keys).toEqual([{ key: "p", modifiers: ["ctrl"] }]);
  });

  // Defect (tui-overhaul m2 reel): Shift+F10 (default-catalog.ts's
  // CONTEXT_MENU_ACTION_ID binding) did nothing under a real OpenTUI
  // capture. `useKittyKeyboard` reports function keys as CSI-u sequences
  // whose `raw`/`sequence` bytes are NOT the legacy `\x1b[21;2~` form
  // `decodeTerminalInput`'s table expects, so falling through to that
  // decoder (the old behavior for any name longer than one character) left
  // Shift+F10 undecoded into any key at all, even though `name`/`shift` were
  // always populated correctly (verified against @opentui/core's own kitty
  // key map, chunk-node-aj3n20gq.js's `kittyKeyMap[57373] === "f10"`).
  test("decodes a native Shift+F10 event straight from name+shift, not the legacy raw/sequence bytes", () => {
    const decoded = decodeOpenTuiKeyEvent({ name: "f10", raw: "", sequence: "", ctrl: false, meta: false, shift: true });
    expect(decoded.text).toBe("");
    expect(decoded.keys).toEqual([{ key: "f10", modifiers: ["shift"] }]);
  });

  test("decodes an unmodified native F6 event the same way", () => {
    const decoded = decodeOpenTuiKeyEvent({ name: "f6", raw: "", sequence: "", ctrl: false, meta: false, shift: false });
    expect(decoded.text).toBe("");
    expect(decoded.keys).toEqual([{ key: "f6" }]);
  });

  test("normalizes native Shift+/ to the documented ? Help binding", () => {
    const decoded = decodeOpenTuiKeyEvent({ name: "/", raw: "/", sequence: "/", ctrl: false, meta: false, shift: true });
    expect(decoded.text).toBe("");
    expect(decoded.keys).toEqual([{ key: "?", modifiers: ["shift"] }]);
  });

  test("returns null before enter() has run (no injected renderer yet to expose)", () => {
    const adapter = new OpenTuiRenderer({});
    expect(adapter.keyInput()).toBeNull();
    expect(adapter.onNativeInput(() => {}, () => {})).toBeNull();
  });

  test("a real keypress through OpenTUI's own KeyHandler decodes to the same shape decodeTerminalInput produces for a printable key", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();
    const decoded: DecodedTerminalInput[] = [];
    const unsubscribe = adapter.onNativeInput((d) => decoded.push(d), () => {});
    expect(unsubscribe).not.toBeNull();

    const keys = createMockKeys(renderer);
    keys.pressKey("a");
    await setup.renderOnce();

    expect(decoded.length).toBeGreaterThan(0);
    const text = decoded.map((d) => d.text).join("");
    expect(text).toContain("a");
  });

  test("a real Home-key press through KeyHandler is recognized as a navigation key, not shredded into raw text", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();
    const decoded: DecodedTerminalInput[] = [];
    const unsubscribe = adapter.onNativeInput((d) => decoded.push(d), () => {});
    expect(unsubscribe).not.toBeNull();

    const keys = createMockKeys(renderer);
    keys.pressKey("HOME");
    await setup.renderOnce();

    const allKeys = decoded.flatMap((d) => d.keys);
    expect(allKeys.some((k) => k.key === "home")).toBe(true);
  });

  test("a real Escape press is delivered as cancel text even when the native event has no legacy raw bytes", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();
    const decoded: DecodedTerminalInput[] = [];
    adapter.onNativeInput((d) => decoded.push(d), () => {});

    // Kitty's extended keyboard protocol delivers Escape as CSI-u semantic
    // input rather than a legacy one-byte raw sequence.
    createMockKeys(renderer, { kittyKeyboard: true }).pressEscape();
    await setup.renderOnce();

    expect(decoded.map((d) => d.text).join("")).toContain("\u001b");
  });

  test("a lone legacy Escape is delivered immediately and its later semantic flush is deduplicated", async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const adapter = new OpenTuiRenderer({ renderer, stdin });
    await adapter.enter();
    const decoded: DecodedTerminalInput[] = [];
    adapter.onNativeInput((d) => decoded.push(d), () => {});

    stdin.emit("data", Buffer.from("\u001b"));
    await Promise.resolve();
    expect(decoded.map((d) => d.text).join("")).toBe("\u001b");

    createMockKeys(renderer).pressEscape();
    await setup.renderOnce();
    expect(decoded.map((d) => d.text).join("")).toBe("\u001b");
  });

  test("a real bracketed paste is delivered whole to onPaste, distinct from the per-keystroke onDecoded path", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();
    const decoded: DecodedTerminalInput[] = [];
    const pasted: string[] = [];
    const unsubscribe = adapter.onNativeInput((d) => decoded.push(d), (text) => pasted.push(text));
    expect(unsubscribe).not.toBeNull();

    const keys = createMockKeys(renderer);
    await keys.pasteBracketedText("first line\nsecond line\nthird line");
    await setup.renderOnce();

    expect(pasted).toEqual(["first line\nsecond line\nthird line"]);
    // The paste must not ALSO have been decoded through the per-keystroke
    // path as ordinary text (that would be the OT-1 truncation risk this
    // bridge exists to avoid: newlines mid-paste read as Enter/submit).
    const decodedTextDuringPaste = decoded.map((d) => d.text).join("");
    expect(decodedTextDuringPaste).not.toContain("first line");
  });

  test("unsubscribe stops further delivery to either callback", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();
    const decoded: DecodedTerminalInput[] = [];
    const unsubscribe = adapter.onNativeInput((d) => decoded.push(d), () => {});
    expect(unsubscribe).not.toBeNull();
    unsubscribe!();

    const keys = createMockKeys(renderer);
    keys.pressKey("z");
    await setup.renderOnce();

    expect(decoded).toEqual([]);
  });

  test("keyInput() exposes the same live KeyHandler after enter()", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();
    expect(adapter.keyInput()).not.toBeNull();
  });
});

describe("terminal capability replies are not typed into the composer (EC-010/EC-017)", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);

  /**
   * Drives the REAL @opentui/core parser, one byte per key event, exactly as
   * the renderer receives a terminal's answer -- then through the same filter
   * and decoder the live bridge uses. Nothing here stands in for either side.
   */
  const drive = (bytes: string, filter = new TerminalReplyFilter()) => {
    const text: string[] = [];
    const keys: string[] = [];
    for (const ch of bytes) {
      const event = parseKeypress(Buffer.from(ch, "utf8")) as Parameters<typeof decodeOpenTuiKeyEvent>[0];
      if (filter.consume(event.raw || event.sequence || "")) continue;
      const decoded = decodeOpenTuiKeyEvent(event);
      if (decoded.text !== "") text.push(decoded.text);
      for (const key of decoded.keys) keys.push(key.key);
    }
    return { text: text.join(""), keys };
  };

  test("tmux's XTVERSION DCS reply contributes no typed text", () => {
    // Before the filter this inserted `P>|tmux 3.7` into an operator's
    // composer: parseKeypress reports each payload byte as a printable key.
    const { text, keys } = drive(`${ESC}P>|tmux 3.7${ESC}\\`);
    expect(text).toBe(ESC);
    expect(keys).toEqual([]);
  });

  test("a BEL-terminated OSC colour reply contributes no typed text", () => {
    const { text, keys } = drive(`${ESC}]11;rgb:1e1e/1e1e/2e2e${BEL}`);
    expect(text).toBe(ESC);
    expect(keys).toEqual([]);
  });

  test("a reply arriving mid-session is filtered too (no first-frame gate can bound this)", () => {
    const filter = new TerminalReplyFilter();
    expect(drive("hi", filter).text).toBe("hi");
    expect(drive(`${ESC}P>|tmux 3.7${ESC}\\`, filter).text).toBe(ESC);
    expect(drive("ok", filter).text).toBe("ok");
  });

  test("ordinary typing still reaches the composer", () => {
    expect(drive("refactor app.py").text).toBe("refactor app.py");
  });

  /**
   * The same reply, but SPLIT the way tmux delivered it (EC-044/EC-048): the
   * ESC in one burst, the payload later, one byte per event. `replyFilter`
   * cannot see this shape; the hold must.
   */
  const driveSplit = async (bytes: string, gapMs: number, quietMs = 30) => {
    const filter = new TerminalReplyFilter();
    const text: string[] = [];
    const deliver = (event: ReturnType<typeof parseKeypress>) => {
      const decoded = decodeOpenTuiKeyEvent(event as Parameters<typeof decodeOpenTuiKeyEvent>[0]);
      if (decoded.text === ESC && decoded.keys.length === 0) hold.noteLoneEscape();
      if (decoded.text !== "") text.push(decoded.text);
    };
    const hold = new SplitReplyHold<ReturnType<typeof parseKeypress>>({
      textOf: (event) => (event as { raw?: string; sequence?: string }).raw || (event as { sequence?: string }).sequence || "",
      release: (events) => { for (const event of events) deliver(event); },
      quietMs,
    });
    const feed = (ch: string) => {
      const event = parseKeypress(Buffer.from(ch, "utf8"));
      if (filter.consume((event as { raw?: string }).raw || (event as { sequence?: string }).sequence || "")) return;
      if (hold.offer(event)) return;
      deliver(event);
    };
    feed(bytes[0]!);
    await new Promise((resolve) => setTimeout(resolve, gapMs));
    for (const ch of bytes.slice(1)) feed(ch);
    await new Promise((resolve) => setTimeout(resolve, quietMs * 3));
    return text.join("");
  };

  test("tmux's XTVERSION reply split after its ESC contributes no typed text (EC-048)", async () => {
    expect(await driveSplit(`${ESC}P>|tmux 3.7${ESC}\\`, 60)).toBe(ESC);
  });

  test("Escape then ] after a gap is released as input, so the Siblings chord survives", async () => {
    expect(await driveSplit(`${ESC}]`, 60)).toBe(`${ESC}]`);
  });

  test("a cursor-position report split after its ESC contributes no keys (EC-056)", async () => {
    expect(await driveSplit(`${ESC}[40;120R`, 60)).toBe(ESC);
  });

  test("Escape then [ (Compaction) is released as input once its final byte proves it is a chord", async () => {
    expect(await driveSplit(`${ESC}[`, 60)).toBe(`${ESC}[`);
  });

  test("Escape followed LATER by a string introducer does not swallow typing", async () => {
    const filter = new TerminalReplyFilter();
    expect(drive(ESC, filter).text).toBe(ESC);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // "P" is an introducer byte, but this is a person typing after Escape.
    const { text, keys } = drive("Post", filter);
    expect(keys).toEqual(["p"]);
    expect(text).toBe("ost");
  });
});
