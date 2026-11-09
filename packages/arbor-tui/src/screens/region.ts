/**
 * region.ts — ADR-122's row/column-budgeting primitive.
 *
 * Extraction, not invention (ADR-125's Rule-of-Three trigger): `console.ts`
 * already contained a working wide-width two-column composition. This file
 * lifts that arithmetic into `stackHorizontal` and moves the shared row
 * helpers (`clipLabelWithEllipsis` and the ANSI-safe `pad`) that `console.ts`
 * had declared locally.
 *
 * The primitive owns column count only. Vertical allocation remains local to
 * the one screen that needs it, matching ADR-125's explicit decision not to
 * generalize a one-screen layout into a public region engine.
 */

import { ANSI, clipAnsi, stripAnsi } from "../player-piano.js";
import { displayWidth } from "../widgets.js";

export interface RegionSpec {
  readonly id: string;
  /** Caller-rendered content, in final display order — the primitive owns
   * row COUNT only, never content. */
  readonly lines: readonly string[];
  readonly weight?: number;
}

// ── ANSI-safe row helpers, moved here from console.ts (no longer screen-local)

/** Display width of `value` with SGR escapes stripped first, so a colored
 * row still measures the same as its uncolored sibling. */
function visibleWidth(value: string): number {
  return displayWidth(stripAnsi(value));
}

/** Right-pads `value` to `width` display columns, measuring past any SGR
 * escapes it may already carry. */
export function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

/**
 * ADR-126 decision 2: a label that fits inside `width` is returned
 * unchanged; one that doesn't is clipped with a trailing ellipsis (itself 1
 * display column) so truncation is visible instead of a silent mid-word
 * cut.
 */
export function clipLabelWithEllipsis(label: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(label) <= width) return label;
  const budget = Math.max(0, width - displayWidth("…"));
  return `${clipAnsi(label, budget)}…${label.includes(String.fromCharCode(27)) ? ANSI.reset : ""}`;
}

/**
 * Splits `total` across `weights` proportionally, flooring every share at
 * 1 and pinning any rounding drift onto the last share — the same
 * arithmetic console.ts's wide layout used for its 0.62/0.38 and 0.6/0.4
 * splits, generalized from two hardcoded ratios to N weights.
 */
function computeShares(total: number, weights: readonly number[]): number[] {
  const count = weights.length;
  if (count === 0) return [];
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || count;
  const shares = weights.map((weight) => Math.max(1, Math.floor((total * weight) / totalWeight)));
  const consumed = shares.slice(0, -1).reduce((sum, value) => sum + value, 0);
  shares[count - 1] = Math.max(1, total - consumed);
  return shares;
}

// ── composition ────────────────────────────────────────────────────────────

/**
 * Places `regions` side by side across `options.total_width` columns, one
 * space between adjacent columns, every column but the last right-padded to
 * its share. Generalizes console.ts's wide two-column composition
 * (transcript | tree+governance).
 *
 * ANSI-safe by construction: `pad` measures past SGR escapes and the final
 * join is clipped with `clipAnsi` (never `clipDisplay`), so content that
 * already carries color survives composition without an escape sequence
 * getting truncated mid-code or counted as display width. `options.color`
 * is accepted for interface symmetry with the rest of this package's
 * render path (color is applied by the caller before content ever reaches
 * this primitive) — composition is ANSI-safe unconditionally, the same way
 * console.ts's original wide layout already called `clipAnsi`
 * unconditionally regardless of whether color was on.
 */
export function stackHorizontal(regions: readonly RegionSpec[], options: { total_width: number; color: boolean }): readonly string[] {
  if (regions.length === 0) return [];
  void options.color;
  const totalWidth = Math.max(0, options.total_width);
  const gap = 1;
  const gapsWidth = gap * (regions.length - 1);
  const usableWidth = Math.max(regions.length, totalWidth - gapsWidth);
  const weights = regions.map((region) => region.weight ?? 1);
  const widths = computeShares(usableWidth, weights);
  const rowCount = regions.reduce((max, region) => Math.max(max, region.lines.length), 0);
  const lines: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const parts = regions.map((region, columnIndex) => {
      const value = region.lines[index] ?? "";
      const isLast = columnIndex === regions.length - 1;
      return isLast ? value : pad(value, widths[columnIndex]!);
    });
    lines.push(clipAnsi(parts.join(" ".repeat(gap)), totalWidth));
  }
  return lines;
}
