import { describe, expect, it } from "vitest";
import {
  ANSI,
  buildAnsiPalette,
  deriveTheme,
  deriveTransitions,
  DEFAULT_DARK_PALETTE,
  DEFAULT_LIGHT_PALETTE,
  eventClassColor,
  eventKindClass,
  isDevToolsStreamShape,
  nodeStateColor,
  spinnerGlyph,
  toForegroundSgr,
  TUI_THEME_NAMES,
  THEME_CATALOG,
  type DevToolsStreamLine,
} from "../src/index.js";

function line(overrides: Partial<DevToolsStreamLine> = {}): DevToolsStreamLine {
  return {
    seq: 1,
    ts: "2026-08-03T13:37:42.000Z",
    event_kind: "tree.node_changed",
    campaign_id: "demo-1",
    node_id: "n1",
    synthetic: false,
    ...overrides,
  };
}

describe("spinnerGlyph", () => {
  it("yields different glyphs for different frame counts", () => {
    const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const glyphs = frames.map((frame) => spinnerGlyph(frame));
    // At least two distinct glyphs across the cycle.
    expect(new Set(glyphs).size).toBeGreaterThan(1);
    // Deterministic: same frame → same glyph.
    expect(spinnerGlyph(3)).toBe(spinnerGlyph(3));
  });

  it("starts at the static expanding icon and wraps around", () => {
    expect(spinnerGlyph(0)).toBe("◌");
    // The cycle length is 5; frame 5 wraps back to the first glyph.
    expect(spinnerGlyph(5)).toBe(spinnerGlyph(0));
  });

  it("treats negative / non-integer frame counts as frame 0", () => {
    expect(spinnerGlyph(-1)).toBe("◌");
    expect(spinnerGlyph(Number.NaN)).toBe("◌");
  });
});

describe("deriveTransitions", () => {
  it("a node flipping verified raises a flash that decays over frames", () => {
    const stream = [line({ seq: 1, event_kind: "loop.node_verified", node_id: "n1", node_state: "verified" })];
    // Frame 1: the flip raises a full-strength flash.
    let transitions = deriveTransitions(new Map(), [], stream);
    expect(transitions.get("n1")).toEqual({ state: "verified", frames_remaining: 8 });
    // Frames 2..8: the same stream decays the flash one frame per update.
    for (let frame = 2; frame <= 8; frame += 1) {
      transitions = deriveTransitions(transitions, stream, stream);
      expect(transitions.get("n1")?.frames_remaining).toBe(9 - frame);
    }
    // Frame 9: the flash has expired and is dropped.
    transitions = deriveTransitions(transitions, stream, stream);
    expect(transitions.get("n1")).toBeUndefined();
  });

  it("a state change refreshes the flash to full strength", () => {
    const verified = [line({ seq: 1, event_kind: "loop.node_verified", node_id: "n1", node_state: "verified" })];
    let transitions = deriveTransitions(new Map(), [], verified);
    transitions = deriveTransitions(transitions, verified, verified); // decay to 7
    expect(transitions.get("n1")?.frames_remaining).toBe(7);
    // n1 flips to failed → flash refreshes with the new state.
    const failed = [line({ seq: 2, event_kind: "loop.node_failed", node_id: "n1", node_state: "failed" })];
    transitions = deriveTransitions(transitions, verified, failed);
    expect(transitions.get("n1")).toEqual({ state: "failed", frames_remaining: 8 });
  });

  it("does not raise flashes for non-flashable states", () => {
    const pending = [line({ seq: 1, event_kind: "tree.node_changed", node_id: "n1", node_state: "pending" })];
    const expanding = [line({ seq: 1, event_kind: "tree.node_changed", node_id: "n1", node_state: "expanding" })];
    expect(deriveTransitions(new Map(), [], pending).size).toBe(0);
    expect(deriveTransitions(new Map(), [], expanding).size).toBe(0);
  });

  it("is deterministic for identical inputs", () => {
    const stream = [line({ seq: 1, event_kind: "loop.node_claimed", node_id: "n1", node_state: "claimed" })];
    const first = deriveTransitions(new Map(), [], stream);
    const second = deriveTransitions(new Map(), [], stream);
    expect(first).toEqual(second);
  });
});

describe("event classification", () => {
  it("classifies loop.* and stream.* event kinds", () => {
    expect(eventKindClass("loop.specialist_dispatched")).toBe("dispatch");
    expect(eventKindClass("loop.critic_dispatched")).toBe("dispatch");
    expect(eventKindClass("loop.node_verified")).toBe("verified");
    expect(eventKindClass("loop.node_failed")).toBe("failed");
    expect(eventKindClass("loop.node_claimed")).toBe("claimed");
    expect(eventKindClass("loop.halt")).toBe("halt");
    expect(eventKindClass("stream.truncated")).toBe("truncated");
    expect(eventKindClass("tree.node_changed")).toBe("node_changed");
    expect(eventKindClass("campaign.changed")).toBe("other");
  });

  it("colors verified/failed/claimed distinctly", () => {
    expect(eventClassColor("verified")).toBe(ANSI.green);
    expect(eventClassColor("failed")).toBe(ANSI.red);
    expect(eventClassColor("claimed")).toBe(ANSI.yellow);
    expect(eventClassColor("dispatch")).toBe(ANSI.cyan);
    expect(eventClassColor("halt")).toBe(ANSI.magenta);
    expect(eventClassColor("truncated")).toBe(ANSI.dim);
  });

  it("colors tree.node_changed by node state", () => {
    expect(eventClassColor("node_changed", "verified")).toBe(ANSI.green);
    expect(eventClassColor("node_changed", "failed")).toBe(ANSI.red);
    expect(eventClassColor("node_changed", "expanding")).toBe(ANSI.cyan);
    expect(eventClassColor("node_changed", "pending")).toBe(ANSI.dim);
  });
});

describe("nodeStateColor", () => {
  it("maps verified/failed/claimed to distinct ANSI colors", () => {
    expect(nodeStateColor("verified")).toBe(ANSI.green);
    expect(nodeStateColor("failed")).toBe(ANSI.red);
    expect(nodeStateColor("claimed")).toBe(ANSI.yellow);
    expect(nodeStateColor("expanding")).toBe(ANSI.cyan);
    expect(nodeStateColor("unknown")).toBe("");
  });
});

// 4F polish-pass closure: the ANSI color table used to be 16-color codes
// with zero relationship to theme.ts's light/dark RunTheme — centralized,
// but not theme-derived, so it could never respond to theme. These assert
// the values are now a real PROJECTION of theme.ts (not a cosmetic no-op):
// they equal toForegroundSgr of the theme's own semantic roles, and a
// light-mode palette actually yields different escapes than the dark
// default — while remaining a pure, deterministic function of its `theme`
// argument (no Date.now()/Math.random() anywhere in the derivation).
describe("ANSI is theme-derived (routes through theme.ts)", () => {
  it("the default ANSI palette equals toForegroundSgr of the dark theme's semantic roles", () => {
    expect(ANSI.red).toBe(toForegroundSgr(DEFAULT_DARK_PALETTE.danger));
    expect(ANSI.green).toBe(toForegroundSgr(DEFAULT_DARK_PALETTE.success));
    expect(ANSI.yellow).toBe(toForegroundSgr(DEFAULT_DARK_PALETTE.warning));
    expect(ANSI.magenta).toBe(toForegroundSgr(DEFAULT_DARK_PALETTE.special));
    expect(ANSI.cyan).toBe(toForegroundSgr(DEFAULT_DARK_PALETTE.info));
  });

  it("attributes (bold/dim/inverse/reset) are unchanged raw SGR — not colors, nothing to theme", () => {
    const ESC = String.fromCharCode(27);
    expect(ANSI.reset).toBe(`${ESC}[0m`);
    expect(ANSI.bold).toBe(`${ESC}[1m`);
    expect(ANSI.dim).toBe(`${ESC}[2m`);
    expect(ANSI.inverse).toBe(`${ESC}[7m`);
  });

  it("a light-mode theme yields genuinely different color escapes than the dark default", () => {
    const light = buildAnsiPalette(deriveTheme("light"));
    expect(light.red).toBe(toForegroundSgr(DEFAULT_LIGHT_PALETTE.danger));
    expect(light.red).not.toBe(ANSI.red);
    expect(light.green).not.toBe(ANSI.green);
  });

  it("buildAnsiPalette is pure and deterministic: identical theme in, identical palette out", () => {
    const a = buildAnsiPalette(deriveTheme("dark"));
    const b = buildAnsiPalette(deriveTheme("dark"));
    expect(a).toEqual(b);
  });
});

describe("named theme switch repaint (buildAnsiPalette across the seven live theme palettes)", () => {
  it("derives catalog-correct ANSI escapes for every named theme, not stale defaults", () => {
    for (const name of TUI_THEME_NAMES) {
      const theme = THEME_CATALOG[name];
      const palette = buildAnsiPalette(theme);
      expect(palette.red).toBe(toForegroundSgr(theme.colors.danger));
      expect(palette.green).toBe(toForegroundSgr(theme.colors.success));
      expect(palette.yellow).toBe(toForegroundSgr(theme.colors.warning));
      expect(palette.magenta).toBe(toForegroundSgr(theme.colors.special));
      expect(palette.cyan).toBe(toForegroundSgr(theme.colors.info));
    }
  });

  it("switching between two named themes yields genuinely different escapes for every semantic role (a real repaint, not stale colors)", () => {
    const before = buildAnsiPalette(THEME_CATALOG["moss-agate"]);
    const after = buildAnsiPalette(THEME_CATALOG["copper-canopy"]);
    expect(before).not.toEqual(after);
    for (const key of ["red", "green", "yellow", "magenta", "cyan"] as const) {
      expect(before[key]).not.toBe(after[key]);
    }
  });

  it("every named theme yields a distinct palette (no two catalog entries silently collide)", () => {
    const serialized = TUI_THEME_NAMES.map((name) => JSON.stringify(buildAnsiPalette(THEME_CATALOG[name])));
    expect(new Set(serialized).size).toBe(TUI_THEME_NAMES.length);
  });
});

describe("isDevToolsStreamShape", () => {
  it("accepts the integration contract and rejects non-stream shapes", () => {
    expect(isDevToolsStreamShape({ campaign_id: "c", lines: [] })).toBe(true);
    expect(isDevToolsStreamShape({ lines: [line()] })).toBe(true);
    expect(isDevToolsStreamShape(null)).toBe(false);
    expect(isDevToolsStreamShape(undefined)).toBe(false);
    expect(isDevToolsStreamShape({ campaign_id: "c" })).toBe(false);
    expect(isDevToolsStreamShape([line()])).toBe(false);
    expect(isDevToolsStreamShape("stream")).toBe(false);
  });
});
