import { describe, expect, it, vi } from "vitest";
import { copySelectedTerminalText } from "../src/selection-copy.js";

describe("selected terminal text copy", () => {
  it.each([false, true])("consumes Ctrl+C with shift=%s and copies the exact visible selection", shift => {
    const copyText = vi.fn(() => true);
    const key = { name: "c", ctrl: true, meta: false, shift };
    expect(copySelectedTerminalText(key, { selectedText: () => "line one\nline two", copyText })).toBe(true);
    expect(copyText).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledWith("line one\nline two");
  });
  it("leaves unselected Ctrl+C to the explicit application route", () => {
    const copyText = vi.fn(() => true);
    expect(copySelectedTerminalText({ name: "c", ctrl: true, meta: false }, { selectedText: () => null, copyText })).toBe(false);
    expect(copyText).not.toHaveBeenCalled();
  });
  it("does not hijack ordinary text or alternate-modifier chords", () => {
    const port = { selectedText: () => "selected", copyText: vi.fn(() => true) };
    expect(copySelectedTerminalText({ name: "c", ctrl: false, meta: false }, port)).toBe(false);
    expect(copySelectedTerminalText({ name: "c", ctrl: true, meta: true }, port)).toBe(false);
    expect(port.copyText).not.toHaveBeenCalled();
  });
  it("never falls through to destructive commands when clipboard delivery fails", () => {
    expect(copySelectedTerminalText({ name: "c", ctrl: true, meta: false }, { selectedText: () => "keep this", copyText: () => { throw new Error("clipboard unavailable"); } })).toBe(true);
  });
});
