import { describe, expect, it } from "vitest";
import { decodeTerminalInput, TerminalInputDecoder, navigationKeyFromChar } from "../src/input-terminal.js";
import { buildDefaultCatalog, TREE_SELECT_NEXT_ACTION_ID, TREE_SELECT_PREV_ACTION_ID, RETRY_ROW_ACTION_ID } from "../src/default-catalog.js";
import { InputRouter } from "../src/input-catalog.js";

const ESC = "\u001b";

// Audit 2026-08-23 WA-24/WA-25: arrow keys reached the router as ESC + "[" +
// letter (the "[" being the Compaction hotkey) and Shift+letter was
// indistinguishable from the lowercase letter.
describe("keyboard navigation decoding (WA-24, WA-25)", () => {
  it("decodes CSI and SS3 cursor keys as up/down/left/right, never as loose text", () => {
    for (const [rest, key] of [["[A", "up"], ["[B", "down"], ["[C", "right"], ["[D", "left"], ["OA", "up"], ["OB", "down"]] as const) {
      const decoded = decodeTerminalInput(ESC + rest);
      expect(decoded.keys).toEqual([{ key }]);
      expect(decoded.text).toBe("");
    }
  });

  it("decodes a cursor sequence split across stdin chunks", () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.decode(ESC).keys).toEqual([]);
    expect(decoder.decode("[B").keys).toEqual([{ key: "down" }]);
  });

  it("drops terminal capability responses instead of routing their payload as keys", () => {
    const decoded = decodeTerminalInput(`${ESC}[?1;2c${ESC}[1;1R${ESC}[4;140;44t`);
    expect(decoded.keys).toEqual([]);
    expect(decoded.text).toBe("");
  });

  it("holds a split terminal response until its final byte", () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.decode(`${ESC}[1;1`).text).toBe("");
    expect(decoder.decode("R")).toEqual({ keys: [], mouse: [], text: "", pastes: [] });
  });

  it("quarantines private-mode CSI and OSC terminal control traffic", () => {
    const decoded = decodeTerminalInput(`${ESC}[?25l${ESC}]0;revoy2${ESC}\\${ESC}[?25h`);
    expect(decoded.keys).toEqual([]);
    expect(decoded.text).toBe("");
  });

  it("quarantines DCS/APC string controls that terminate with ST", () => {
    const decoded = decodeTerminalInput(`${ESC}P1+r native-cli.test${ESC}\\${ESC}_apc payload${ESC}\\`);
    expect(decoded.keys).toEqual([]);
    expect(decoded.text).toBe("");
  });

  it("an arrow key never resolves to the Compaction screen; down/up select rows", () => {
    const router = new InputRouter(buildDefaultCatalog(), () => 1000);
    expect(router.handle({ key: "down" }, ["global"])).toEqual({ kind: "action", action_id: TREE_SELECT_NEXT_ACTION_ID });
    expect(router.handle({ key: "up" }, ["global"])).toEqual({ kind: "action", action_id: TREE_SELECT_PREV_ACTION_ID });
    expect(router.handle({ key: "left" }, ["global"])).toEqual({ kind: "ignored" });
    expect(router.handle({ key: "right" }, ["global"])).toEqual({ kind: "ignored" });
  });

  it("an uppercase printable becomes shift+letter so shift+r opens Diff Review instead of arming a row retry", () => {
    expect(navigationKeyFromChar("R")).toEqual({ key: "r", modifiers: ["shift"] });
    expect(navigationKeyFromChar("r")).toEqual({ key: "r" });
    expect(navigationKeyFromChar(";")).toEqual({ key: ";" });
    const router = new InputRouter(buildDefaultCatalog(), () => 1000);
    expect(router.handle(navigationKeyFromChar("R"), ["global"])).toEqual({ kind: "action", action_id: "focus:result-review" });
    expect(router.handle(navigationKeyFromChar("r"), ["global"])).toEqual({ kind: "action", action_id: RETRY_ROW_ACTION_ID });
  });
});
