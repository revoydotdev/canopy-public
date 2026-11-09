/**
 * Output-fidelity taper meter (§3.3 of the fused-component architecture).
 *
 * Surfaces the context-adaptive throttle (OMO's strongest component) to the
 * operator: as a campaign's `elapsed_seconds → max_seconds`, the preview
 * budget tapers (same 0.25+0.75·remaining scale the canonical output policy
 * applies), so the TUI shows the throttle is engaged. Pure and dependency-free —
 * it mirrors the taper math, not any harness's internals or constants.
 */
import type { AppModel } from "./types.js";

export interface FidelityBudgetInput {
  elapsed_seconds: number;
  max_seconds: number;
}

export interface FidelityMeter {
  /** Fraction of the preview budget remaining (1.0 = full, 0.25 = floor). */
  scale: number;
  /** Remaining time fraction (0..1). */
  remaining: number;
  /** Whether the throttle has tightened below the full budget. */
  tapered: boolean;
  /** Compact bar like `[████░  ]`. */
  bar: string;
}

const FLOOR = 0.25;
const BAR_WIDTH = 8;
const FULL_BLOCK = "\u2588";
const HALF_BLOCK = "\u2592";
const EMPTY_BLOCK = "\u2001";

/** Derive the fidelity taper from a campaign budget. Mirrors the policy scale. */
export function fidelityMeter(input: FidelityBudgetInput): FidelityMeter {
  if (!Number.isFinite(input.elapsed_seconds) || !Number.isFinite(input.max_seconds) || input.max_seconds <= 0) {
    throw new Error("fidelity meter requires finite elapsed and positive max seconds");
  }
  const remaining = Math.max(0, Math.min(1, 1 - input.elapsed_seconds / input.max_seconds));
  const scale = FLOOR + (1 - FLOOR) * remaining;
  const filled = Math.round(scale * BAR_WIDTH);
  const bar = FULL_BLOCK.repeat(filled) +
    (filled < BAR_WIDTH ? HALF_BLOCK : "") +
    EMPTY_BLOCK.repeat(Math.max(0, BAR_WIDTH - filled - (filled < BAR_WIDTH ? 1 : 0)));
  return { scale, remaining, tapered: scale < 1, bar };
}

/**
 * The current campaign's fidelity meter — reads the focused campaign from the
 * AppModel snapshot summary if present, else returns a neutral full-budget
 * meter (boot state, nothing running yet).
 */
export function campaignFidelityMeter(app: AppModel): FidelityMeter {
  const s = app.snapshot?.summary;
  const elapsed = typeof s?.elapsed_seconds === "number" ? s.elapsed_seconds : 0;
  const max = typeof s?.max_seconds === "number" ? s.max_seconds : 0;
  return fidelityMeter({ elapsed_seconds: elapsed, max_seconds: max > 0 ? max : 1 });
}
