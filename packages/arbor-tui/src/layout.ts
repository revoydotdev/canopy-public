/**
 * `computeShellLayout` — the pure geometry authority for the M2 shell
 * (docs/tui-overhaul/ui-spec.md §2). Replaces the ad-hoc inline geometry
 * `renderCockpitScene` used to compute (status row + 4-row hero,
 * `renderer.ts`, pre-M2): a single pure function of `{columns, rows, rail,
 * header, composer_lines}` that the flat painter, the OpenTUI painter, and
 * hit-testing can all consume so they can never disagree about where a pane
 * actually sits.
 *
 * Every returned rect is integer and lies inside `[0,cols) x [0,rows)`
 * (§2.5 invariant 1). This module owns no rendering, no theme, and no
 * screen-specific content — only the rectangles.
 */

import type { FocusZone } from "./types.js";

export interface ShellLayoutRect {
  readonly x: number;
  readonly y: number;
  readonly columns: number;
  readonly rows: number;
}

export type ShellLayoutClass = "docked" | "drawer" | "compressed" | "minimal";
export type ShellRailRequest = "auto" | "open" | "closed";
export type ShellHeaderRequest = "auto" | "collapsed" | "expanded";

export interface ShellLayoutInput {
  readonly columns: number;
  readonly rows: number;
  readonly rail?: ShellRailRequest;
  readonly header?: ShellHeaderRequest;
  /** Logical lines currently in the composer buffer; drives its anchored height. */
  readonly composer_lines?: number;
}

export interface ShellLayout {
  readonly layout_class: ShellLayoutClass;
  /** Full top band (borders included), or `null` in `minimal`. */
  readonly header: ShellLayoutRect | null;
  readonly header_left: ShellLayoutRect | null;
  readonly header_graph: ShellLayoutRect | null;
  readonly header_right: ShellLayoutRect | null;
  readonly transcript: ShellLayoutRect;
  readonly composer: ShellLayoutRect;
  /** Docked rail (spans header-bottom to the last row). `null` when not docked. */
  readonly rail: ShellLayoutRect | null;
  /** Drawer/compressed overlay rail, opened explicitly. Overlays the transcript only. */
  readonly rail_overlay: ShellLayoutRect | null;
  /** `minimal` size-warning row. `null` otherwise. */
  readonly warning: ShellLayoutRect | null;
}

/** Focus targets that have a painted target at the current shell geometry. */
export function focusZonesForShellLayout(layout: ShellLayout): readonly FocusZone[] {
  const available = new Set<FocusZone>();
  if (layout.composer.rows > 0 && layout.composer.columns > 0) available.add("composer");
  if (layout.transcript.rows > 0 && layout.transcript.columns > 0) available.add("transcript");
  if ((layout.rail !== null || layout.rail_overlay !== null) && layout.layout_class !== "minimal") available.add("rail");
  if (layout.header_graph !== null && layout.header_graph.rows > 0 && layout.header_graph.columns > 0) available.add("graph");
  return (["composer", "transcript", "rail", "graph"] as const).filter((zone) => available.has(zone));
}

function clampInt(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

function classify(columns: number, rows: number): ShellLayoutClass {
  if (columns < 60 || rows < 16) return "minimal";
  if (columns >= 120 && rows >= 24) return "docked";
  if (columns >= 80 && rows >= 24) return "drawer";
  return "compressed";
}

/** clamp(floor(rows/3), 8, 12), adjusted by an explicit collapse/expand request within the same invariants. */
function fullHeaderHeight(rows: number, request: ShellHeaderRequest): number {
  const base = clampInt(Math.floor(rows / 3), 8, 12);
  if (request === "collapsed") return rows >= 18 ? 4 : Math.min(base, Math.max(1, rows));
  if (request === "expanded") return Math.min(clampInt(base + 4, 8, 12 + 4), Math.max(8, rows - 4));
  return base;
}

interface HeaderZones {
  readonly left: number;
  readonly right: number;
  readonly graph: number;
  readonly folded: boolean;
}

/**
 * Zone widths are a pure function of `columns` alone (ui-spec §2.2: never of
 * the status text). The header frame reserves one column on each outer edge
 * for its own left/right border (drawn by `renderer.ts`), so the interior
 * available to zones + separators is `columns - 2`, not `columns`.
 */
function headerZones(columns: number): HeaderZones {
  const side = clampInt(Math.floor(columns * 0.2), 18, 30);
  const interior = Math.max(0, columns - 2);
  const graph = interior - side * 2 - 2;
  if (graph < 24) return { left: 0, right: 0, graph: interior, folded: true };
  return { left: side, right: side, graph, folded: false };
}

function composerHeightFor(bodyRows: number, composerLines: number): number {
  return clampInt(composerLines + 2, 3, Math.max(3, Math.floor(bodyRows / 3)));
}

/** Builds the header rect plus its three interior zones for a full (docked/drawer) header. */
function buildFullHeader(columns: number, headerHeight: number): Pick<ShellLayout, "header" | "header_left" | "header_graph" | "header_right"> {
  const header: ShellLayoutRect = { x: 0, y: 0, columns, rows: headerHeight };
  const interiorRows = Math.max(0, headerHeight - 2);
  if (interiorRows <= 0) {
    return { header, header_left: null, header_graph: header, header_right: null };
  }
  const zones = headerZones(columns);
  // The outer left/right border columns (x=0 and x=columns-1) belong to the
  // frame, not to any zone — every zone rect is inset by one column on each
  // side so its text can never overwrite the side borders `renderer.ts` draws.
  const innerLeft = columns > 0 ? 1 : 0;
  const innerWidth = Math.max(0, columns - 2);
  if (zones.folded) {
    // Left/right identity moves into the header's first interior row; the
    // graph claims every remaining interior row at full width (ui-spec §2.2).
    const zoneRow: ShellLayoutRect = { x: innerLeft, y: 1, columns: innerWidth, rows: 1 };
    const graphRows = Math.max(0, interiorRows - 1);
    const graph: ShellLayoutRect = { x: innerLeft, y: 1 + Math.min(1, interiorRows), columns: innerWidth, rows: graphRows };
    return {
      header,
      header_left: interiorRows >= 1 ? { ...zoneRow, columns: Math.floor(innerWidth / 2) } : null,
      header_right: interiorRows >= 1 ? { ...zoneRow, x: columns - 1 - Math.ceil(innerWidth / 2), columns: Math.ceil(innerWidth / 2) } : null,
      header_graph: graphRows > 0 ? graph : (interiorRows >= 1 ? null : header),
    };
  }
  return {
    header,
    header_left: { x: innerLeft, y: 1, columns: zones.left, rows: interiorRows },
    header_graph: { x: innerLeft + zones.left + 1, y: 1, columns: zones.graph, rows: interiorRows },
    header_right: { x: columns - 1 - zones.right, y: 1, columns: zones.right, rows: interiorRows },
  };
}

/**
 * Pure geometry for the M2 shell (ui-spec §2). Same input always produces
 * the same rects (§2.5 invariant 3); every rect fits `[0,cols)x[0,rows)`
 * (invariant 1); the composer is always >=1 row/column whenever `rows>=3`
 * (invariant 2).
 */
export function computeShellLayout(input: ShellLayoutInput): ShellLayout {
  const columns = Math.max(0, Math.trunc(input.columns));
  const rows = Math.max(0, Math.trunc(input.rows));
  const railRequest = input.rail ?? "auto";
  const headerRequest = input.header ?? "auto";
  const composerLines = Math.max(0, Math.trunc(input.composer_lines ?? 1));
  const layoutClass = classify(columns, rows);

  if (layoutClass === "minimal") {
    const warningRows = rows >= 1 ? 1 : 0;
    const available = Math.max(0, rows - warningRows);
    const composerRows = available <= 0 ? 0 : Math.min(available, Math.max(1, composerLines + 1));
    const transcriptRows = Math.max(0, available - composerRows);
    return {
      layout_class: layoutClass,
      header: null,
      header_left: null,
      header_graph: null,
      header_right: null,
      warning: warningRows > 0 ? { x: 0, y: 0, columns, rows: warningRows } : null,
      transcript: { x: 0, y: warningRows, columns, rows: transcriptRows },
      composer: { x: 0, y: warningRows + transcriptRows, columns, rows: composerRows },
      rail: null,
      rail_overlay: null,
    };
  }

  const headerHeight = layoutClass === "compressed"
    ? (rows >= 18 ? 4 : 1)
    : fullHeaderHeight(rows, headerRequest);
  const clampedHeaderHeight = Math.min(headerHeight, Math.max(0, rows));
  const headerParts = clampedHeaderHeight <= 0
    ? { header: null, header_left: null, header_graph: null, header_right: null }
    : clampedHeaderHeight === 1
      ? { header: { x: 0, y: 0, columns, rows: 1 }, header_left: null, header_graph: { x: 0, y: 0, columns, rows: 1 }, header_right: null }
      : buildFullHeader(columns, clampedHeaderHeight);

  const bodyTop = clampedHeaderHeight;
  const bodyRows = Math.max(0, rows - bodyTop);

  const wantsDockedRail = layoutClass === "docked" && railRequest !== "closed";
  const railWidth = wantsDockedRail ? Math.max(0, Math.min(clampInt(Math.floor(columns * 0.28), 32, 44), columns - 72)) : 0;
  const rail: ShellLayoutRect | null = wantsDockedRail && railWidth > 0
    ? { x: columns - railWidth, y: bodyTop, columns: railWidth, rows: bodyRows }
    : null;
  const mainWidth = rail !== null ? columns - rail.columns : columns;

  const composerRows = bodyRows <= 0 ? 0 : Math.min(bodyRows, composerHeightFor(bodyRows, composerLines));
  const transcriptRows = Math.max(0, bodyRows - composerRows);
  const composer: ShellLayoutRect = { x: 0, y: rows - composerRows, columns: mainWidth, rows: composerRows };
  const transcript: ShellLayoutRect = { x: 0, y: bodyTop, columns: mainWidth, rows: transcriptRows };

  // Drawer/compressed rail is an explicit-open overlay over the transcript
  // only, never the composer (ui-spec §2.3).
  const wantsOverlayRail = (layoutClass === "drawer" || layoutClass === "compressed") && railRequest === "open";
  const overlayWidth = wantsOverlayRail ? Math.max(0, Math.min(44, columns - 4)) : 0;
  const railOverlay: ShellLayoutRect | null = wantsOverlayRail && overlayWidth > 0 && transcriptRows > 0
    ? { x: columns - overlayWidth, y: bodyTop, columns: overlayWidth, rows: transcriptRows }
    : null;

  return {
    layout_class: layoutClass,
    ...headerParts,
    warning: null,
    transcript,
    composer,
    rail,
    rail_overlay: railOverlay,
  };
}
