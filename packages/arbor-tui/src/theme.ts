/**
 * Terminal-derived palette as a projection with a legibility contract (ADR-020,
 * frontier Appendix B / opencode).
 *
 * The palette is a deterministic function of the terminal's light/dark mode —
 * never borrowed from a host editor theme and never a hardcoded RGB primary.
 * A neutrality/luminance check asserts a surface stays legible (a small
 * luminance spread against its background) on saturated or warm terminal
 * themes, so meaning is never carried by color or symbol alone.
 *
 * Pure, dependency-free; the renderer consumes the fully-derived RunTheme.
 */

export type TerminalMode = "dark" | "light";
/**
 * `success`/`danger`/`warning`/`info`/`special` are the semantic STATE roles
 * (player-piano.ts's event/node-state coloring — verified/failed/claimed/
 * dispatch/halt) folded into the same palette as the structural
 * background/text/accent/muted/border roles, so every ANSI color in the TUI
 * — structural chrome or state semantics — derives from one theme and is
 * covered by the same legibility contract (`checkLegibility` iterates every
 * non-background role).
 */
export type PaletteRole = "background" | "text" | "accent" | "muted" | "border" | "success" | "danger" | "warning" | "info" | "special";

export interface RunTheme {
  mode: TerminalMode;
  /** Per-role RGB color in 0..255. */
  colors: Record<PaletteRole, readonly [number, number, number]>;
}

// `muted`/`border` were the only two roles below the named themes' 4.5
// contrast bar (checkLegibility) — 4.44/1.79 in dark, 4.74/1.74 in light.
// Both are raised here just far enough to clear 4.5 with a small rounding
// margin, same hue direction as before (lightened toward the dark
// background's opposite pole, darkened toward the light background's), not
// redesigned. `light.muted` was already compliant (4.74) and is unchanged.
export const DEFAULT_DARK_PALETTE: Record<PaletteRole, readonly [number, number, number]> = Object.freeze({
  // Night Bloom is the product default: near-white reading text over a
  // blue-black surface, with the pink/purple warmth of Sweet and the calm
  // violet/cyan separation of Dracula. Saturated roles are reserved for
  // state and action; prose should continue to use `text`.
  background: [0, 0, 0],
  text: [246, 244, 250],
  accent: [255, 105, 180],
  muted: [170, 160, 185],
  border: [142, 132, 158],
  success: [120, 230, 170],
  danger: [255, 120, 145],
  warning: [245, 195, 100],
  info: [105, 215, 240],
  special: [205, 140, 255],
});

export const DEFAULT_LIGHT_PALETTE: Record<PaletteRole, readonly [number, number, number]> = Object.freeze({
  background: [250, 250, 252],
  text: [28, 28, 32],
  accent: [0, 96, 210],
  muted: [110, 112, 120],
  border: [112, 114, 119],
  success: [20, 120, 60],
  danger: [180, 30, 30],
  warning: [120, 90, 0],
  info: [10, 100, 140],
  special: [110, 40, 140],
});

/** ANSI Control Sequence Introducer, built at runtime (never a bare literal escape byte in source). */
const CSI = String.fromCharCode(27) + "[";

/**
 * Color-emission tier for the live render path (OT-6). `NO_COLOR`/non-TTY
 * output never reaches these emitters at all (the caller gates on a plain
 * `color: boolean` first, matching `doctor.ts`'s `NO_COLOR`/TTY contract) —
 * `ColorMode` only decides HOW an already-color-eligible frame encodes each
 * RGB triple, degrading to the terminal's captured `TerminalCapabilities`
 * (`.rgb`/`.ansi256`) instead of always assuming 24-bit truecolor support.
 */
export type ColorMode = "truecolor" | "ansi256";

/**
 * Nearest xterm 256-color palette index for an RGB triple (the standard
 * 6x6x6 color cube + 24-step grayscale ramp xterm/most terminals implement).
 */
export function rgbToAnsi256(color: readonly [number, number, number]): number {
  const [r, g, b] = color;
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const toIndex = (c: number): number => Math.round((c / 255) * 5);
  return 16 + 36 * toIndex(r) + 6 * toIndex(g) + toIndex(b);
}

/** SGR foreground escape for a theme RGB triple, degraded per `mode` (default truecolor, the pre-OT-6 behavior). */
export function toForegroundSgr(color: readonly [number, number, number], mode: ColorMode = "truecolor"): string {
  if (mode === "ansi256") return CSI + "38;5;" + rgbToAnsi256(color) + "m";
  return CSI + "38;2;" + color[0] + ";" + color[1] + ";" + color[2] + "m";
}

/** SGR background escape for a theme RGB triple, degraded per `mode` (default truecolor, the pre-OT-6 behavior). */
export function toBackgroundSgr(color: readonly [number, number, number], mode: ColorMode = "truecolor"): string {
  if (mode === "ansi256") return CSI + "48;5;" + rgbToAnsi256(color) + "m";
  return CSI + "48;2;" + color[0] + ";" + color[1] + ";" + color[2] + "m";
}

/**
 * Derive the palette from a detected terminal mode. `COLORTERM=truecolor` (or a
 * dark-mode hint) → dark; a light hint → light; fallback to a neutral default
 * when detection fails (never a hardcoded RGB primary as the primary path).
 */
export function deriveTheme(mode: TerminalMode | undefined): RunTheme {
  return {
    mode: mode === "light" ? "light" : "dark",
    colors: mode === "light" ? { ...DEFAULT_LIGHT_PALETTE } : { ...DEFAULT_DARK_PALETTE },
  };
}

export function detectTerminalMode(hint?: { colorterm?: string; tui_light?: boolean }): TerminalMode | undefined {
  if (hint?.tui_light === true) return "light";
  const ct = hint?.colorterm ?? "";
  if (ct.toLowerCase().includes("truecolor") || ct.toLowerCase().includes("24bit")) return "dark";
  if (ct !== "" && !ct.toLowerCase().includes("truecolor")) return "dark"; // unknown → dark default
  return undefined;
}

/** Relative luminance (sRGB coefficients) for a 0..255 RGB triple. */
export function luminance(color: readonly [number, number, number]): number {
  const [r, g, b] = color.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as unknown as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Absolute luminance contrast between two RGB triples (WCAG-style ratio). */
export function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export interface LeftRightsSpacingCheck {
  /** Roles whose luminance spread against the background exceeds the bound. */
  lowContrast: PaletteRole[];
  min_ratio: number;
}

/**
 * The neutrality/legibility contract: every foreground role must hold at least
 * `minRatio` contrast against the theme background. This is what makes the
 * palette legible on any user theme and prevents meaning-by-color-only.
 */
export function checkLegibility(theme: RunTheme, minRatio = 4.5): LeftRightsSpacingCheck {
  const bg = theme.colors.background;
  const lowContrast: PaletteRole[] = (Object.keys(theme.colors) as PaletteRole[])
    .filter((role) => role !== "background" && contrastRatio(theme.colors[role], bg) < minRatio);
  return { lowContrast, min_ratio: minRatio };
}

/**
 * Seven original, named botanical/material palettes (operator command-palette
 * theme switching). Each is a single fixed `RunTheme` — never re-derived from
 * terminal light/dark detection — and each independently clears
 * `checkLegibility(theme, 4.5)` with ZERO low-contrast roles (not just the
 * five semantic roles the default two-mode palette is held to): every
 * foreground role (text/accent/muted/border/success/danger/warning/info/
 * special) holds real contrast against its own background.
 */
export const TUI_THEME_NAMES = [
  "night-bloom",
  "moss-agate",
  "verdigris-forge",
  "sandstone-thicket",
  "birchwood-frost",
  "obsidian-fern",
  "copper-canopy",
  "slate-orchard",
] as const;
export type TuiThemeName = typeof TUI_THEME_NAMES[number];

const THEME_CATALOG_DATA = {
  "night-bloom": {
    mode: "dark",
    colors: { ...DEFAULT_DARK_PALETTE },
  },
  "moss-agate": {
    mode: "dark",
    colors: {
      background: [17, 21, 18],
      text: [223, 232, 220],
      accent: [138, 214, 150],
      muted: [163, 176, 160],
      border: [140, 156, 138],
      success: [140, 224, 150],
      danger: [255, 140, 132],
      warning: [235, 196, 96],
      info: [140, 210, 224],
      special: [206, 160, 232],
    },
  },
  "verdigris-forge": {
    mode: "dark",
    colors: {
      background: [14, 22, 22],
      text: [220, 235, 233],
      accent: [120, 210, 196],
      muted: [158, 178, 175],
      border: [132, 158, 154],
      success: [140, 224, 176],
      danger: [255, 142, 138],
      warning: [232, 194, 100],
      info: [140, 206, 226],
      special: [206, 164, 226],
    },
  },
  "sandstone-thicket": {
    mode: "light",
    colors: {
      background: [248, 242, 230],
      text: [46, 38, 26],
      accent: [140, 82, 20],
      muted: [96, 86, 70],
      border: [120, 106, 84],
      success: [30, 110, 46],
      danger: [170, 32, 30],
      warning: [130, 84, 0],
      info: [10, 96, 128],
      special: [110, 42, 132],
    },
  },
  "birchwood-frost": {
    mode: "light",
    colors: {
      background: [246, 247, 242],
      text: [34, 40, 32],
      accent: [24, 96, 78],
      muted: [90, 96, 86],
      border: [110, 114, 100],
      success: [22, 108, 52],
      danger: [166, 28, 34],
      warning: [124, 86, 0],
      info: [8, 92, 132],
      special: [104, 38, 128],
    },
  },
  "obsidian-fern": {
    mode: "dark",
    colors: {
      background: [12, 16, 14],
      text: [225, 232, 222],
      accent: [126, 206, 140],
      muted: [160, 172, 156],
      border: [134, 150, 132],
      success: [132, 220, 146],
      danger: [252, 138, 130],
      warning: [230, 192, 92],
      info: [134, 204, 222],
      special: [200, 156, 228],
    },
  },
  "copper-canopy": {
    mode: "dark",
    colors: {
      background: [20, 15, 12],
      text: [236, 224, 214],
      accent: [232, 150, 96],
      muted: [180, 164, 150],
      border: [156, 140, 126],
      success: [148, 216, 140],
      danger: [255, 140, 128],
      warning: [236, 190, 90],
      info: [140, 206, 226],
      special: [216, 164, 224],
    },
  },
  "slate-orchard": {
    mode: "light",
    colors: {
      background: [240, 240, 244],
      text: [30, 32, 40],
      accent: [72, 62, 140],
      muted: [88, 90, 100],
      border: [104, 106, 116],
      success: [24, 108, 62],
      danger: [172, 30, 60],
      warning: [122, 84, 0],
      info: [10, 92, 140],
      special: [116, 40, 140],
    },
  },
} as const;

export const THEME_CATALOG: Record<TuiThemeName, RunTheme> = Object.freeze(THEME_CATALOG_DATA);

/** Human-facing display title for a named theme (command palette / help overlay). */
export const THEME_TITLES: Record<TuiThemeName, string> = Object.freeze({
  "night-bloom": "Night Bloom",
  "moss-agate": "Moss Agate",
  "verdigris-forge": "Verdigris Forge",
  "sandstone-thicket": "Sandstone Thicket",
  "birchwood-frost": "Birchwood Frost",
  "obsidian-fern": "Obsidian Fern",
  "copper-canopy": "Copper Canopy",
  "slate-orchard": "Slate Orchard",
});

export function isTuiThemeName(value: string): value is TuiThemeName {
  return (TUI_THEME_NAMES as readonly string[]).includes(value);
}

/** Look up a named palette by its canonical id, or `null` for an unknown name. */
export function getNamedTheme(name: string): RunTheme | null {
  return isTuiThemeName(name) ? THEME_CATALOG[name] : null;
}

/**
 * Startup theme resolution (config override, then terminal light/dark/
 * color-capability fallback): an explicit `tui.theme` config value wins when
 * it names a real catalog entry; otherwise the terminal-derived two-mode
 * palette applies. Terminal color CAPABILITY (truecolor vs 256-color vs
 * mono) is a separate, orthogonal concern from which palette is chosen: it
 * degrades at the display layer via `ColorMode` (`toForegroundSgr`/
 * `toBackgroundSgr`'s second argument), not by picking a different palette —
 * see `packages/arbor-mcp/src/tui.ts`'s `resolveColorPolicy`, which reads
 * `NO_COLOR` and the renderer's captured `TerminalCapabilities` to decide the
 * live frame's `color`/`color_mode`.
 */
export function resolveStartupTheme(
  configuredTheme: string | undefined,
  terminalHint?: { colorterm?: string; tui_light?: boolean },
): RunTheme {
  if (configuredTheme !== undefined) {
    const named = getNamedTheme(configuredTheme);
    if (named !== null) return named;
  }
  return deriveTheme(detectTerminalMode(terminalHint));
}

export interface RunFooterTheme {
  background: readonly [number, number, number];
  text: readonly [number, number, number];
  accent: readonly [number, number, number];
}

/**
 * Semantic state roles (ui-spec §6): `active`/`governance`/`success`/
 * `waiting`/`failure`/`muted`/`selection`/`focus`. State is always carried by
 * glyph + label, never by colour alone, so every one of these maps onto a
 * `PaletteRole` for colour AND a fixed glyph pair — Unicode by default, a
 * plain-ASCII fallback selected the same way `drawPane`'s box-drawing
 * characters already are (`FrameOptions.unicode === false`).
 */
export type SemanticRole = "active" | "governance" | "success" | "waiting" | "failure" | "muted" | "selection" | "focus";

export interface SemanticGlyph {
  /** The `PaletteRole` this state's colour derives from. `null` for roles that carry no colour of their own (selection/focus are chrome, not palette roles). */
  readonly paletteRole: PaletteRole | null;
  readonly unicode: string;
  readonly ascii: string;
}

/**
 * One table, keyed by the semantic role, each carrying both glyph variants —
 * so a caller never independently decides "what does failure look like in
 * ASCII", which would let the two tables drift apart.
 */
export const SEMANTIC_GLYPHS: Record<SemanticRole, SemanticGlyph> = Object.freeze({
  active: { paletteRole: "info", unicode: "▶", ascii: ">" },
  governance: { paletteRole: "special", unicode: "§", ascii: "$" },
  success: { paletteRole: "success", unicode: "✓", ascii: "+" },
  waiting: { paletteRole: "warning", unicode: "…", ascii: "~" },
  failure: { paletteRole: "danger", unicode: "!", ascii: "!" },
  muted: { paletteRole: "muted", unicode: "·", ascii: "." },
  // Chrome roles: selection is a row marker and focus is a pane-title marker;
  // both are drawn structurally rather than tinted from a state palette entry.
  selection: { paletteRole: null, unicode: "›", ascii: ">" },
  focus: { paletteRole: null, unicode: "▸", ascii: ">" },
});

/** The glyph for `role`, Unicode unless `unicode === false` (matches `FrameOptions.unicode`'s existing box-drawing convention). */
export function semanticGlyph(role: SemanticRole, unicode: boolean): string {
  const entry = SEMANTIC_GLYPHS[role];
  return unicode ? entry.unicode : entry.ascii;
}

/** Focus border characters: heavy (double-line) vs light, selected the same way as any other unicode/ASCII pair. */
export function focusBorderGlyphs(unicode: boolean, focused: boolean): { readonly horizontal: string; readonly vertical: string } {
  if (unicode) return focused ? { horizontal: "═", vertical: "║" } : { horizontal: "─", vertical: "│" };
  return focused ? { horizontal: "=", vertical: "#" } : { horizontal: "-", vertical: "|" };
}

/** Derive the footer theme (the primary operator affordance) from the RunTheme. */
export function footerTheme(theme: RunTheme): RunFooterTheme {
  return {
    background: theme.colors.background,
    text: theme.colors.text,
    accent: theme.colors.accent,
  };
}
