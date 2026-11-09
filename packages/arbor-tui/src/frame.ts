/**
 * frame.ts (ADR-037) — the structured scene `RendererPort` now carries.
 *
 * Wave 1's port (`renderer.ts`'s `RendererPort.render(frame: string)`)
 * received one already-flattened blob: `renderScene` computed real pane
 * rectangles via `layoutWorkspace` (`navigation.ts`), then `drawPane`/`put`
 * baked them into a shared `string[][]` canvas and threw the rectangles away
 * before a renderer ever saw them (`renderer.ts`'s old `renderScene`, before
 * this record). Mouse hit-testing, a native scroll region, and retained-tree
 * diffing all need to know which pane a cell belongs to; none of that
 * survives a join("\n"). This module is the seam that keeps it.
 *
 * `SceneFrame` is additive, not replacing: it still carries the exact `rows`
 * the flattened `Frame` (`painter.ts`) always did — `TerminalPainter`,
 * `SsePainter`, and every existing consumer of that shape keep working
 * unchanged (a `SceneFrame` satisfies `Frame` structurally) — plus the pane
 * rectangles and per-pane content a structure-aware renderer needs.
 */
import type { PaneRect } from "./navigation.js";
import type { ShellLayoutClass } from "./layout.js";

/** Explicit layout semantics for a retained renderer; never reconstructed from text rows. */
export interface FramePaneChronology {
  readonly placement: "top" | "bottom";
  readonly sticky_bottom: boolean;
}

/** Canonical Console buffer metadata. The reducer owns this buffer, not a native textarea. */
export interface FramePaneComposer {
  readonly kind: "console";
  readonly focused: boolean;
  readonly cursor: number;
  readonly text: string;
  readonly action: "send" | "queue" | "answer";
  readonly interrupt_available: boolean;
  readonly max_visible_rows: number;
  /**
   * The composer's anchored rect per `computeShellLayout` (layout.ts,
   * ui-spec §2.3), when the cockpit shell computed one. Console still draws
   * its composer box inline as part of the pane's own content (ui-spec §7),
   * so this is metadata only — never a second paintable pane. A structure-
   * aware renderer must not create a sibling box/pane at this rect: doing so
   * would double-paint over the real composer text already drawn as part of
   * this pane's content (this is exactly the bug a real OpenTUI capture
   * caught: a same-rect sibling pane's own opaque background hid the "❯"
   * prompt the console screen had already drawn).
   */
  readonly anchor?: { readonly x: number; readonly y: number; readonly columns: number; readonly rows: number };
}

/**
 * One pane's rectangle (`navigation.ts`'s `PaneRect`, unchanged) plus its
 * already-composed interior content rows: the same lines `drawPane` writes
 * into the flat canvas, border-stripped and clipped to the pane's interior
 * (`rows - 2` lines when the pane is large enough to carry a border, `[]`
 * when it is too small to have an interior at all — mirroring `drawPane`'s
 * own `pane.columns < 2 || pane.rows < 2` early return). Only the primary
 * pane (`renderScene`'s `layout.panes[0]`) carries real content today; a
 * secondary pane's `content` is `[]`, matching what `drawPane` has always
 * painted into its interior (nothing) — this module reports that honestly
 * rather than inventing content that was never rendered.
 */
export interface FramePane extends PaneRect {
  readonly title: string;
  readonly content: readonly string[];
  /**
   * The rectangle actually painted before an ambient status/notification
   * overlay reserves hit-test space. Native renderers use this to retain
   * stdout parity while `rows` remains the interactive geometry.
   */
  readonly paint_rows?: number;
  /** Content's spatial contract for native/retained renderers. */
  readonly content_alignment?: "top" | "bottom";
  /** A compact chronology can stay pinned independently of rendered strings. */
  readonly chronology?: FramePaneChronology;
  /** Present only for the Console primary pane. */
  readonly composer?: FramePaneComposer;
  /**
   * Whether a structure-aware renderer should draw a border/chrome box
   * around this pane. Absent (or `true`) preserves the pane-by-default
   * behavior every workspace pane has always had (`opentui-renderer.ts`
   * derives borderedness from size alone when this is unset). `false` marks
   * an ambient strip that is real geometry — hit-testable via
   * `hitTestFrame` exactly like any other pane — but never a bordered box
   * (the notification band, `renderer.ts`'s `renderScene`, is the first
   * producer of `false`: it is painted the same unbordered way the status
   * row already is, and a border would misrepresent it as a fourth
   * workspace pane rather than the ambient feedback strip it is).
   */
  readonly bordered?: boolean;
  /** Absolute input-only regions, tested before the containing painted pane. */
  readonly interaction_regions?: readonly PaneRect[];
  /** Document identities on the actually rendered rail, including scroll offset. */
  readonly inspector_document_rows?: readonly { readonly row: number; readonly path: string }[];
  /** ADR record identities on the actually rendered rail, including scroll offset. */
  readonly inspector_adr_rows?: readonly { readonly row: number; readonly id: string }[];
}

/**
 * Canonical structured scene one `renderScene` call produces. `columns`/
 * `rows` are byte-identical to what the pre-widening `Frame` (`painter.ts`)
 * carried — every existing painter/consumer of that shape keeps working
 * against a `SceneFrame` with no changes on their side. `panes` is the
 * addition: the pane rectangles and content `renderScene` used to discard.
 */
export interface SceneFrame {
  readonly columns: number;
  readonly rows: readonly string[];
  readonly panes: readonly FramePane[];
  /**
   * Absolute row index of the status bar this frame reserved (always the
   * last row, `renderScene`'s own convention), or `null` when the frame has
   * zero rows and therefore reserved nothing.
   */
  readonly status_row: number | null;
  /** Status may share its row with a full-height inspector to its right. */
  readonly status_columns?: number;
  /**
   * The `computeShellLayout` (layout.ts, ui-spec §2.1) class this frame was
   * painted under, when the cockpit shell produced it. `undefined` for the
   * legacy multi-pane workspace path (`renderScene`'s non-cockpit branch),
   * which does not consume `computeShellLayout` at all.
   */
  readonly layout_class?: ShellLayoutClass;
}

/** One point-to-pane hit-test result: which pane a click landed in, and its
 * position translated into that pane's own local coordinate space. */
export interface PaneHit {
  readonly pane_id: string;
  readonly row_in_pane: number;
  readonly column_in_pane: number;
}

/**
 * Hit-tests one absolute terminal cell (e.g. a mouse click's `(column,row)`)
 * against a `SceneFrame`'s pane rectangles. Returns `null` for a point that
 * falls outside every pane (the status bar row, an inter-pane gutter, or a
 * click beyond the frame entirely) rather than guessing the nearest pane —
 * "no pane was hit" is a real, distinct outcome from "pane X was hit at row
 * 0", and collapsing them would make a renderer report a false positive.
 *
 * Pure and renderer-agnostic: this is the same translation a structure-aware
 * renderer (`opentui-renderer.ts`) performs using `@opentui/core`'s own
 * native hit-grid, expressed here as a plain function so it is independently
 * testable (`tests/frame.test.ts`) without spinning up a real renderer.
 */
export function hitTestFrame(scene: SceneFrame, point: { readonly column: number; readonly row: number }): PaneHit | null {
  // Iterates from the LAST pane to the first: `syncPanes` (opentui-renderer.ts)
  // assigns z-index by array position (`paneIndex * 2`), so a later pane
  // paints on top of an earlier one at the same coordinates (e.g. a header
  // zone pane painted over its own decorative full-header backdrop pane, or
  // a drawer/compressed rail overlay painted over the transcript beneath
  // it). A point over two overlapping panes must resolve to whichever one is
  // actually visible there — the topmost, last-painted one — never the
  // pane a click appears to land on but cannot actually see.
  for (let index = scene.panes.length - 1; index >= 0; index -= 1) {
    const pane = scene.panes[index]!;
    if (point.column < pane.x || point.column >= pane.x + pane.columns) continue;
    if (point.row < pane.y || point.row >= pane.y + pane.rows) continue;
    for (const region of pane.interaction_regions ?? []) {
      if (point.column < region.x || point.column >= region.x + region.columns) continue;
      if (point.row < region.y || point.row >= region.y + region.rows) continue;
      return { pane_id: region.id, row_in_pane: point.row - region.y, column_in_pane: point.column - region.x };
    }
    return { pane_id: pane.id, row_in_pane: point.row - pane.y, column_in_pane: point.column - pane.x };
  }
  return null;
}
