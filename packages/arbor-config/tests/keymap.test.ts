import { describe, expect, it } from "vitest";
import {
  parseKeymap,
  formatBinding,
  KEYMAP_SPEC_PREFIX,
  KEYMAP_MAX_EVENTS_PER_BINDING,
  KEYMAP_MAX_BINDINGS,
} from "../src/keymap.js";

describe("parseKeymap", () => {
  it("parses simple single-key and chord bindings", () => {
    const res = parseKeymap(`${KEYMAP_SPEC_PREFIX}\nctrl-a = "focus palette"\nctrl-x ctrl-s = "save"`);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bindings).toHaveLength(2);
      expect(res.bindings[0].keys[0]).toEqual({ mods: ["ctrl"], key: "a" });
      expect(res.bindings[0].description).toBe("focus palette");
      // two-stroke chord
      expect(res.bindings[1].keys).toHaveLength(2);
      expect(formatBinding(res.bindings[1])).toBe("ctrl+x ctrl+s");
    }
  });

  it("expands an alternative-binding list into separate bindings", () => {
    const res = parseKeymap(`${KEYMAP_SPEC_PREFIX}\n[alt-p, alt-shift-p] = "toggle preview"`);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bindings).toHaveLength(2);
  });

  it("normalizes duplicate modifiers and lowercases keys", () => {
    const res = parseKeymap(`${KEYMAP_SPEC_PREFIX}\nctrl-shift-ctrl-A = "norm"`);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bindings[0].keys[0].mods).toEqual(["ctrl", "shift"]);
      expect(res.bindings[0].keys[0].key).toBe("a");
    }
  });

  it("rejects malformed bindings with diagnostics (early rejection)", () => {
    const res = parseKeymap(`${KEYMAP_SPEC_PREFIX}\nctrl- = "missing key"\ncapslock-a = "bad modifier"`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics.length).toBeGreaterThan(0);
  });

  it("rejects a binding with more than max events", () => {
    const tooMany = Array.from({ length: KEYMAP_MAX_EVENTS_PER_BINDING + 1 }, (_, i) => `ctrl-${String.fromCharCode(97 + i)}`).join(" ");
    const res = parseKeymap(`${KEYMAP_SPEC_PREFIX}\n${tooMany} = "too many"`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics.some((d) => d.includes("exceeds"))).toBe(true);
  });

  it("rejects exceeding the max binding count", () => {
    const lines = Array.from({ length: KEYMAP_MAX_BINDINGS + 1 }, (_, i) => `ctrl-${i} = "b${i}"`).join("\n");
    const res = parseKeymap(`${KEYMAP_SPEC_PREFIX}\n${lines}`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics.some((d) => d.includes("exceeds"))).toBe(true);
  });

  it("skips comments and blank lines; requires =, description", () => {
    const res = parseKeymap(`${KEYMAP_SPEC_PREFIX}\n# a comment\n\nctrl-a = "ok"\nbroken line`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics.some((d) => d.includes("no '='"))).toBe(true);
  });
});
