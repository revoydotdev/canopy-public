import { describe, expect, it } from "vitest";
import {
  deriveTheme,
  detectTerminalMode,
  checkLegibility,
  contrastRatio,
  toForegroundSgr,
  toBackgroundSgr,
  rgbToAnsi256,
  DEFAULT_DARK_PALETTE,
  DEFAULT_LIGHT_PALETTE,
  TUI_THEME_NAMES,
  THEME_CATALOG,
  THEME_TITLES,
  isTuiThemeName,
  getNamedTheme,
  resolveStartupTheme,
  type PaletteRole,
} from "../src/theme.js";

const ESC = String.fromCharCode(27);

describe("palette-as-projection (ADR-020)", () => {
  it("derives the dark palette by default", () => {
    const theme = deriveTheme(undefined);
    expect(theme.mode).toBe("dark");
    expect(theme.colors.background).toEqual(DEFAULT_DARK_PALETTE.background);
  });

  it("derives the light palette when the terminal is light", () => {
    const theme = deriveTheme("light");
    expect(theme.mode).toBe("light");
    expect(theme.colors.background).toEqual(DEFAULT_LIGHT_PALETTE.background);
  });

  it("detects truecolor terminals as dark and honors an explicit light hint", () => {
    expect(detectTerminalMode({ colorterm: "truecolor" })).toBe("dark");
    expect(detectTerminalMode({ colorterm: "24bit" })).toBe("dark");
    expect(detectTerminalMode({ tui_light: true })).toBe("light");
    expect(detectTerminalMode({ colorterm: "" })).toBeUndefined();
  });

  it("holds the legibility contract at the same zero-low-contrast bar the named themes meet — every role, not just text", () => {
    // The out-of-box default palette used to be the only surface held to a
    // weaker bar than the named themes (`tui.ts` printed a contrast warning
    // for muted/border and rendered anyway). `muted`/`border` are no longer
    // exempt: this asserts the full `lowContrast` list is empty, the same
    // contract `checkLegibility(theme, 4.5)` already enforces on every named
    // theme below.
    const dark = deriveTheme("dark");
    const darkCheck = checkLegibility(dark, 4.5);
    expect(darkCheck.lowContrast, `dark failed roles: ${darkCheck.lowContrast.join(", ")}`).toEqual([]);
    const light = deriveTheme("light");
    const lightCheck = checkLegibility(light, 4.5);
    expect(lightCheck.lowContrast, `light failed roles: ${lightCheck.lowContrast.join(", ")}`).toEqual([]);
  });

  it("contrastRatio is symmetric and max-contrast white-on-black", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeGreaterThan(10);
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(contrastRatio([0, 0, 0], [255, 255, 255]), 6);
  });

  it("flags low-contrast roles under a strict ratio", () => {
    // muted on background is the least-contrast role; a strict bound should flag at least one role
    const dark = deriveTheme("dark");
    const strict = checkLegibility(dark, 8);
    expect(strict.lowContrast.length).toBeGreaterThan(0);
  });

  // Semantic state roles (player-piano.ts's verified/failed/claimed/dispatch/
  // halt coloring) are folded into the SAME palette/legibility contract as
  // the structural roles — never a separate, unchecked color source.
  describe("semantic state roles (success/danger/warning/info/special)", () => {
    it("are present in both palettes and pass the legibility contract at 4.5", () => {
      // Scoped to the five semantic roles only, independent of whatever the
      // structural roles (including muted/border, now also held to zero
      // low-contrast by the suite above) happen to do — this test is about
      // the semantic roles specifically, not a weaker bar for the others.
      const semanticRoles = ["success", "danger", "warning", "info", "special"] as const;
      for (const mode of ["dark", "light"] as const) {
        const theme = deriveTheme(mode);
        for (const role of semanticRoles) {
          expect(theme.colors[role]).toBeDefined();
        }
        const check = checkLegibility(theme, 4.5);
        const failingSemanticRoles = check.lowContrast.filter((role) => (semanticRoles as readonly string[]).includes(role));
        expect(failingSemanticRoles, `${mode} semantic roles failing 4.5 contrast: ${failingSemanticRoles.join(", ")}`).toEqual([]);
      }
    });

    it("differ between dark and light palettes — a real per-mode projection, not one constant reused", () => {
      for (const role of ["success", "danger", "warning", "info", "special"] as const) {
        expect(DEFAULT_DARK_PALETTE[role]).not.toEqual(DEFAULT_LIGHT_PALETTE[role]);
      }
    });
  });
});

describe("toForegroundSgr / toBackgroundSgr (truecolor SGR projection)", () => {
  it("encodes a theme RGB triple as a real 24-bit SGR escape", () => {
    expect(toForegroundSgr(DEFAULT_DARK_PALETTE.success)).toBe(`${ESC}[38;2;120;230;170m`);
    expect(toBackgroundSgr(DEFAULT_DARK_PALETTE.background)).toBe(`${ESC}[48;2;0;0;0m`);
  });

  it("is a pure function of its input — same triple, same escape, every call", () => {
    expect(toForegroundSgr(DEFAULT_LIGHT_PALETTE.danger)).toBe(toForegroundSgr(DEFAULT_LIGHT_PALETTE.danger));
  });

  it("defaults to truecolor mode when no mode is given (pre-OT-6 behavior preserved)", () => {
    expect(toForegroundSgr(DEFAULT_DARK_PALETTE.accent)).toBe(toForegroundSgr(DEFAULT_DARK_PALETTE.accent, "truecolor"));
  });
});

// OT-6 (P0): color-emission tier degrade. NO_COLOR/mono is handled entirely
// by the `color: boolean` gate upstream of these emitters (never called at
// all) — this describe block covers the middle tier: a terminal with
// `.ansi256` but not `.rgb` capability.
describe("ColorMode degrade (OT-6 — truecolor -> ansi256)", () => {
  it("rgbToAnsi256 maps pure grayscale to the 24-step grayscale ramp", () => {
    expect(rgbToAnsi256([0, 0, 0])).toBe(16);
    expect(rgbToAnsi256([255, 255, 255])).toBe(231);
    expect(rgbToAnsi256([128, 128, 128])).toBeGreaterThanOrEqual(232);
    expect(rgbToAnsi256([128, 128, 128])).toBeLessThanOrEqual(255);
  });

  it("rgbToAnsi256 maps a saturated color into the 6x6x6 color cube (16..231)", () => {
    const index = rgbToAnsi256(DEFAULT_DARK_PALETTE.danger);
    expect(index).toBeGreaterThanOrEqual(16);
    expect(index).toBeLessThanOrEqual(231);
  });

  it("toForegroundSgr/toBackgroundSgr emit a 256-color SGR sequence in ansi256 mode, distinct from truecolor", () => {
    const color = DEFAULT_DARK_PALETTE.success;
    const truecolor = toForegroundSgr(color, "truecolor");
    const ansi256 = toForegroundSgr(color, "ansi256");
    expect(ansi256).toBe(`${ESC}[38;5;${rgbToAnsi256(color)}m`);
    expect(ansi256).not.toBe(truecolor);
    const bgAnsi256 = toBackgroundSgr(color, "ansi256");
    expect(bgAnsi256).toBe(`${ESC}[48;5;${rgbToAnsi256(color)}m`);
  });

  it("every role in every named theme produces a valid ansi256 index (0..255)", () => {
    for (const name of TUI_THEME_NAMES) {
      const theme = THEME_CATALOG[name];
      for (const role of Object.keys(theme.colors) as PaletteRole[]) {
        const index = rgbToAnsi256(theme.colors[role]);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThanOrEqual(255);
      }
    }
  });
});

// Seven original botanical/material named palettes (command-palette theme
// switching). Each must independently clear checkLegibility(theme, 4.5) with
// ZERO low-contrast roles — not merely the five semantic state roles the
// default two-mode palette is held to.
describe("named theme catalog (TUI_THEME_NAMES / THEME_CATALOG)", () => {
  it("declares exactly seven distinct, original theme names", () => {
    expect(TUI_THEME_NAMES.length).toBe(8);
    expect(new Set(TUI_THEME_NAMES).size).toBe(8);
  });

  it("every catalog entry is registered under its own name and has a display title", () => {
    for (const name of TUI_THEME_NAMES) {
      expect(THEME_CATALOG[name]).toBeDefined();
      expect(typeof THEME_TITLES[name]).toBe("string");
      expect(THEME_TITLES[name].length).toBeGreaterThan(0);
    }
  });

  it("every named theme passes checkLegibility(theme, 4.5) with zero low-contrast roles", () => {
    for (const name of TUI_THEME_NAMES) {
      const theme = THEME_CATALOG[name];
      const check = checkLegibility(theme, 4.5);
      expect(check.lowContrast, `${name} failed roles: ${check.lowContrast.join(", ")}`).toEqual([]);
    }
  });

  it("every named theme carries a full role set with valid 0..255 RGB triples", () => {
    const roles: PaletteRole[] = ["background", "text", "accent", "muted", "border", "success", "danger", "warning", "info", "special"];
    for (const name of TUI_THEME_NAMES) {
      const theme = THEME_CATALOG[name];
      for (const role of roles) {
        const [r, g, b] = theme.colors[role];
        for (const channel of [r, g, b]) {
          expect(Number.isInteger(channel)).toBe(true);
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it("isTuiThemeName/getNamedTheme recognize every catalog name and reject unknown strings", () => {
    for (const name of TUI_THEME_NAMES) {
      expect(isTuiThemeName(name)).toBe(true);
      expect(getNamedTheme(name)).toBe(THEME_CATALOG[name]);
    }
    expect(isTuiThemeName("not-a-real-theme")).toBe(false);
    expect(getNamedTheme("not-a-real-theme")).toBeNull();
  });
});

describe("resolveStartupTheme (config override, then terminal fallback)", () => {
  it("uses the configured named theme when present", () => {
    const theme = resolveStartupTheme("moss-agate", { colorterm: "truecolor" });
    expect(theme).toBe(THEME_CATALOG["moss-agate"]);
  });

  it("falls back to the terminal-derived palette when no theme is configured", () => {
    expect(resolveStartupTheme(undefined, { colorterm: "truecolor" })).toEqual(deriveTheme("dark"));
    expect(resolveStartupTheme(undefined, { tui_light: true })).toEqual(deriveTheme("light"));
  });

  it("falls back to the terminal-derived palette when the configured name is unknown (never throws)", () => {
    expect(resolveStartupTheme("not-a-real-theme", { tui_light: true })).toEqual(deriveTheme("light"));
  });
});
