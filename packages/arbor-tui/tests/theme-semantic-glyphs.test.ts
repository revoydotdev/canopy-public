import { describe, expect, it } from "vitest";
import { SEMANTIC_GLYPHS, semanticGlyph, focusBorderGlyphs, type SemanticRole } from "../src/theme.js";

const ASCII_ONLY = /^[\x00-\x7F]+$/;
const ROLES: readonly SemanticRole[] = ["active", "governance", "success", "waiting", "failure", "muted", "selection", "focus"];

describe("semantic glyph table (ui-spec §6)", () => {
  it("provides a distinct unicode glyph for every semantic role", () => {
    for (const role of ROLES) expect(SEMANTIC_GLYPHS[role].unicode.length).toBeGreaterThan(0);
  });

  it("provides a plain-ASCII fallback for every semantic role", () => {
    for (const role of ROLES) {
      expect(SEMANTIC_GLYPHS[role].ascii).toMatch(ASCII_ONLY);
    }
  });

  it("selects the fallback exactly when unicode is false", () => {
    for (const role of ROLES) {
      expect(semanticGlyph(role, true)).toBe(SEMANTIC_GLYPHS[role].unicode);
      expect(semanticGlyph(role, false)).toBe(SEMANTIC_GLYPHS[role].ascii);
    }
  });

  it("distinguishes focused from unfocused border weight in both glyph sets", () => {
    const unicodeFocused = focusBorderGlyphs(true, true);
    const unicodeUnfocused = focusBorderGlyphs(true, false);
    expect(unicodeFocused).not.toEqual(unicodeUnfocused);
    const asciiFocused = focusBorderGlyphs(false, true);
    const asciiUnfocused = focusBorderGlyphs(false, false);
    expect(asciiFocused).not.toEqual(asciiUnfocused);
    expect(asciiFocused.horizontal).toMatch(ASCII_ONLY);
    expect(asciiFocused.vertical).toMatch(ASCII_ONLY);
  });
});
