/**
 * Responsive, source-neutral status document for bounded domain projections.
 *
 * Producers and screen modules retain authority over values, identity, actions,
 * and ordering. This module only gives their existing labelled columns a
 * readable narrow form instead of squeezing a wide table until labels vanish.
 */
import { clipDisplay, renderTable, wrapDisplay } from "../widgets.js";
import { clipLabelWithEllipsis } from "./region.js";
import type { TableColumn } from "../widgets.js";
import type { ScreenProjection } from "./screen.js";

export interface StatusDocumentOptions {
  readonly wide_min_columns?: number;
  readonly empty_caption?: string;
  /** Operator orientation for empty states; never inserts selectable records. */
  readonly empty_title?: string;
  readonly empty_hint?: string;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ") || "—";
  return String(value).trim() || "—";
}

function marker(row: Readonly<Record<string, unknown>>): string {
  const state = [row.severity, row.state, row.status, row.health, row.availability]
    .map(text).join(" ").toLowerCase();
  if (/error|fail|blocked|unavailable|unhealthy|denied/u.test(state)) return "!";
  if (/warn|degrad|pending|action required|unconfigured/u.test(state)) return "?";
  if (/active|ready|healthy|supported|configured|pass|complete/u.test(state)) return "✓";
  return "•";
}

function narrowRows(
  projection: ScreenProjection,
  width: number,
  height: number,
  offset: number,
): readonly string[] {
  const lines: string[] = [clipLabelWithEllipsis(projection.caption ?? projection.screen, width)];
  const rows = projection.rows.slice(Math.min(offset, projection.rows.length));
  for (const row of rows) {
    if (lines.length >= height) break;
    const first = projection.columns[0];
    if (first === undefined) break;
    for (const line of wrapDisplay(`${marker(row)} ${first.title}: ${text(row[first.key])}`, width)) {
      if (lines.length >= height) break;
      lines.push(clipDisplay(line, width));
    }
    for (const column of projection.columns.slice(1)) {
      if (lines.length >= height) break;
      for (const line of wrapDisplay(`  ${column.title}: ${text(row[column.key])}`, width)) {
        if (lines.length >= height) break;
        lines.push(clipDisplay(line, width));
      }
    }
  }
  return lines;
}

/** Wide tables and narrow labelled records are two layouts of the same rows. */
export function renderStatusDocument(
  projection: ScreenProjection,
  width: number,
  height: number,
  offset = 0,
  options: StatusDocumentOptions = {},
): readonly string[] {
  const caption = projection.caption ?? options.empty_caption ?? projection.screen;
  // Some callers deliberately pass a corrupt projection to prove the shared
  // renderer fails closed. Guard before both narrow and wide paths; the wide
  // path's try/catch cannot protect the narrow path from a missing schema.
  if (!Array.isArray((projection as { readonly columns?: unknown }).columns)) {
    return [clipDisplay("(render error)", width)];
  }
  if (projection.rows.length === 0) {
    const lines: string[] = [];
    if (options.empty_title) lines.push(clipLabelWithEllipsis(options.empty_title, width), "");
    lines.push(...wrapDisplay(caption, width));
    if (options.empty_hint) lines.push("", ...wrapDisplay(options.empty_hint, width));
    return lines.slice(0, Math.max(1, height));
  }
  if (width < (options.wide_min_columns ?? 96)) return narrowRows(projection, width, height, offset);
  const available = Math.max(1, width - Math.max(0, projection.columns.length - 1));
  const equalShare = Math.max(4, Math.floor(available / Math.max(1, projection.columns.length)));
  const columns: TableColumn[] = projection.columns.map((column) => ({ ...column, width: Math.min(column.width, equalShare) }));
  try {
    // Hand the table the PANE's width, not just its own column sum: a narrow
    // table inside a wide pane has ample room for the `· first-last of total`
    // range suffix even when its own columns leave no trailing slack, and
    // without it the suffix is dropped and rows vanish silently (EC-011).
    return [clipLabelWithEllipsis(caption, width), ...renderTable(projection.rows, columns, { height: Math.max(1, height - 1), offset, line_width: width })];
  } catch {
    return [clipDisplay("(render error)", width)];
  }
}
