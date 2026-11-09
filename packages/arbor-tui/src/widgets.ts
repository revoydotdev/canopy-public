import { DEFAULT_OUTPUT_POLICY, abbreviateOutput, type OutputBudget } from "@arbor/core";
/**
 * `truncate` picks WHERE a too-long cell loses characters. "end" (the default)
 * keeps the head, which is right for prose. "middle" keeps both ends, which is
 * the only correct choice for an identifier or path whose distinguishing
 * characters are at the TAIL: the Audit screen rendered two different records
 * as `communicatio` and `communicatio`, indistinguishable, because
 * `communication_3` and `communication_4` differ only in their last character
 * (EC-023). OpenCode keeps the same distinction -- `truncate` / `truncateLeft`
 * / `truncateMiddle` in `packages/tui/src/util/locale.ts`.
 */
export interface TableColumn { readonly key: string; readonly title: string; readonly width: number; readonly truncate?: "end" | "middle"; }
export interface TreeRow { readonly id: string; readonly label: string; readonly depth: number; readonly expanded?: boolean; readonly has_children?: boolean; readonly active?: boolean; }
/** A selection never relies on color: every selectable row receives this marker. */
export const SELECTED_ROW_MARKER = "›";
export const UNSELECTED_ROW_MARKER = " ";
export function selectedRowMarker(selected: boolean): string { return selected ? SELECTED_ROW_MARKER : UNSELECTED_ROW_MARKER; }
/** Removes C0/C1 terminal controls from untrusted data while preserving line boundaries. */
export function sanitizeUntrustedTerminalText(value: string): string {
  return value.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu, "");
}
/**
 * Segments a string into extended grapheme clusters (UAX #29) so a ZWJ
 * sequence (`👩‍💻`) or a flag's regional-indicator pair (`🇺🇸`) is measured as
 * the ONE terminal cell-group a real terminal paints it as, not as its
 * separate constituent code points. `displayWidth`/`displayCells` used to
 * iterate `[...value]` (one step per code point): each half of `👩‍💻` is
 * independently in the emoji wide range, so the old per-code-point loop
 * counted it as two double-width glyphs (width 4) with the ZWJ merely
 * skipped, instead of the one double-width glyph (width 2) every terminal
 * actually draws it as -- the composer then disagreed with the terminal's own
 * cursor math and left stray border glyphs/blank cells next to the emoji.
 */
// One shared segmenter: `Intl.Segmenter` construction is comparatively
// expensive, and `displayWidth`/`displayCells` sit on hot per-row render
// paths (FOI's own interaction-benchmark budgets a 1000-line disclosure at
// 50ms) — building a fresh instance on every call regressed that budget.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function graphemeClusters(value: string): string[] {
  return [...graphemeSegmenter.segment(value.normalize("NFC"))].map((entry) => entry.segment);
}
/**
 * Width/cell count for one extended grapheme cluster. A cluster carrying a
 * ZWJ or an explicit emoji-presentation selector (VS16), or a regional-
 * indicator flag pair, is one wide glyph regardless of how many code points
 * it bundles. Otherwise the cluster's width follows its widest non-combining
 * code point (a base letter plus combining accents stays the base's width).
 * A cluster made ONLY of combining marks (no base -- the degenerate leading-
 * mark case) has display width 0 but still occupies one padding cell.
 */
function clusterMetrics(cluster: string): { width: number; cells: number } {
  const points = [...cluster].map((character) => character.codePointAt(0)!);
  const isJoinedOrPresented = points.some((point) => point === 0x200d || point === 0xfe0f);
  const isFlagPair = points.length === 2 && points.every((point) => point >= 0x1f1e6 && point <= 0x1f1ff);
  if (isJoinedOrPresented || isFlagPair) return { width: 2, cells: 2 };
  const base = points.filter((point) => !isCombining(point));
  if (base.length === 0) return { width: 0, cells: 1 };
  const width = base.some((point) => isWide(point)) ? 2 : 1;
  return { width, cells: width };
}
// Plain ASCII (the overwhelming majority of rendered text -- diff bodies,
// command titles, prose) never combines, joins, or widens: `value.length`
// already IS its display width there. Skip `normalize`/`Intl.Segmenter`
// entirely for that case; both sit on hot per-row render paths (FOI's own
// interaction-benchmark budgets a 1000-line disclosure at 50ms) and a
// segmenter pass over every row regressed that budget even with a shared
// segmenter instance.
const isPlainAscii = (value: string): boolean => /^[\x20-\x7e]*$/.test(value);
export function displayWidth(value: string): number {
  if (isPlainAscii(value)) return value.length;
  return graphemeClusters(value).reduce((sum, cluster) => sum + clusterMetrics(cluster).width, 0);
}
/**
 * Split a string into terminal grid cells: a wide glyph (including a whole
 * ZWJ/flag cluster) yields its head cell followed by an empty continuation
 * cell. Cell count equals displayWidth except for the degenerate leading-
 * combining-mark case, which is rendered on a space cell.
 */
export function displayCells(value: string): string[] {
  if (isPlainAscii(value)) return [...value];
  const cells: string[] = [];
  for (const cluster of graphemeClusters(value)) {
    const metrics = clusterMetrics(cluster);
    cells.push(metrics.width === 0 ? ` ${cluster}` : cluster);
    if (metrics.cells === 2) cells.push("");
  }
  return cells;
}
export function clipDisplay(value: string, columns: number): string { if (!Number.isSafeInteger(columns) || columns < 0) throw new Error("columns must be a non-negative safe integer"); let result = ""; let used = 0; for (const character of [...value.normalize("NFC")]) { const width = displayWidth(character); if (used + width > columns) break; result += character; used += width; } return result; }
function clipMiddleWithEllipsis(value: string, columns: number): string {
  if (displayWidth(value) <= columns) return value;
  if (columns <= 1) return clipWithEllipsis(value, columns);
  // Keep both ends so values sharing a long prefix stay distinguishable.
  const keep = columns - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const tailText = tail <= 0 ? "" : Array.from(value).slice(-tail).join("");
  return `${clipDisplay(value, head)}…${tailText}`;
}
function clipWithEllipsis(value: string, columns: number): string {
  if (displayWidth(value) <= columns) return value;
  if (columns <= 0) return "";
  return `${clipDisplay(value, columns - 1)}…`;
}
/**
 * The `[first-last/total]` range suffix is this table's ONLY statement that
 * rows are hidden. It was being computed and then clipped straight back off:
 * the padded header already consumes exactly `totalWidth`, so appending the
 * suffix and clipping to `totalWidth` discarded it every time. Capabilities
 * showed 39 of 188 action classes with nothing on screen saying so, across all
 * 14 screens that route through `renderStatusDocument`. Budget the suffix into
 * the clip width; the pane's own content clip still bounds the line if the
 * terminal is genuinely too narrow. Same convention as the rail's
 * `+N more · Ctrl+B` (EC-004 #10, exemplar-confirmed: Claude Code marks
 * truncation with a count and pairs it with an expand affordance; OpenCode
 * returns an explicit `overflow` flag). Worded rather than bracketed, matching
 * the exemplar's plain-language form and this file's `·` separator idiom; the
 * bracketed variant was never visible on screen, so no convention was broken.
 */
export function renderTable(rows: readonly Readonly<Record<string, unknown>>[], columns: readonly TableColumn[], options: { height: number; offset?: number; selected_id?: string; row_ids?: readonly ({ readonly id: string } | null)[]; line_width?: number }): string[] { if (!columns.length || columns.some((column) => !column.key.trim() || !column.title.trim() || !Number.isSafeInteger(column.width) || column.width < 1)) throw new Error("table columns require key, title, and positive width"); const height = positive(options.height, "height"); const offset = boundedOffset(options.offset, rows.length); const line = (row: Readonly<Record<string, unknown>>, marker = "") => columns.map((column, index) => { const value = `${index === 0 ? marker : ""}${sanitizeUntrustedTerminalText(String(row[column.key] ?? ""))}`; const clipped = column.truncate === "middle" ? clipMiddleWithEllipsis(value, column.width) : clipWithEllipsis(value, column.width); return pad(clipped, column.width); }).join(" "); const visible = rows.slice(offset, offset + Math.max(0, height - 1)); const ids = options.row_ids ?? []; const first = visible.length === 0 ? 0 : offset + 1; const last = offset + visible.length; const header = line(Object.fromEntries(columns.map((column) => [column.key, column.title]))); const totalWidth = columns.reduce((sum, column) => column.width + sum, 0) + Math.max(0, columns.length - 1); const rangeSuffix = ` · ${first}-${last} of ${rows.length}`; const headerTrimmed = header.replace(/\s+$/u, ""); const headerWidth = Math.max(totalWidth, Number.isSafeInteger(options.line_width) ? options.line_width! : 0); const headerLine = displayWidth(headerTrimmed) + displayWidth(rangeSuffix) <= headerWidth ? `${headerTrimmed}${rangeSuffix}` : header; return [pad(clipDisplay(headerLine, headerWidth), totalWidth === headerWidth ? totalWidth : Math.min(headerWidth, displayWidth(headerLine))), ...visible.map((row, index) => line(row, options.selected_id === undefined ? "" : selectedRowMarker(ids[offset + index]?.id === options.selected_id)))]; }
export function renderTree(rows: readonly TreeRow[], options: { width: number; height: number; offset?: number; unicode?: boolean }): string[] {
  const { width, height } = dimensions(options); const offset = boundedOffset(options.offset, rows.length);
  const hasLaterSibling = (index: number, depth: number): boolean => { for (let next = index + 1; next < rows.length; next += 1) { if (rows[next]!.depth < depth) return false; if (rows[next]!.depth === depth) return true; } return false; };
  return rows.slice(offset, offset + height).map((row, visibleIndex) => {
    if (!Number.isSafeInteger(row.depth) || row.depth < 0) throw new Error("tree depth must be a non-negative safe integer");
    const index = offset + visibleIndex; const ascii = options.unicode === false;
    let stem = "";
    for (let depth = 1; depth < row.depth; depth += 1) stem += hasLaterSibling(index, depth) ? (ascii ? "| " : "│ ") : "  ";
    if (row.depth > 0) stem += hasLaterSibling(index, row.depth) ? (ascii ? "+-" : "├─") : (ascii ? "`-" : "└─");
    const branch = row.has_children ? (row.expanded ? (ascii ? "v" : "▼") : (ascii ? ">" : "▶")) : (row.active ? (ascii ? ">" : "◆") : " ");
    return clipWithEllipsis(`${stem}${branch} ${sanitizeUntrustedTerminalText(row.label)}`, width);
  });
}
/**
 * Word-wrap to `width` display columns. A single token wider than the line
 * (a path, a hash, a URL) is BROKEN across lines rather than clipped: the
 * crash screen at 60 columns lost the tail of the very path it was reporting
 * with no marker (EC-055e). Nothing a wrapper is asked to show is safe to
 * drop silently.
 */
export function wrapDisplay(value: string, width: number): string[] {
  const limit = positive(width, "width");
  const words = sanitizeUntrustedTerminalText(value).trim().split(/\s+/u).filter(Boolean).flatMap((word) => breakToken(word, limit));
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line || displayWidth(`${line} ${word}`) <= limit) line = line ? `${line} ${word}` : word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}
function breakToken(word: string, limit: number): string[] {
  if (displayWidth(word) <= limit) return [word];
  const pieces: string[] = [];
  let rest = word;
  while (displayWidth(rest) > limit) { const head = clipDisplay(rest, limit); pieces.push(head); rest = rest.slice(head.length); }
  if (rest) pieces.push(rest);
  return pieces;
}
export function renderStreamViewport(content: string, options: { width: number; height: number; scroll_from_end?: number; budget?: OutputBudget; evidence_pointer?: string }): string[] { const { width, height } = dimensions(options); const excerpt = abbreviateOutput(sanitizeUntrustedTerminalText(content), options.budget ?? DEFAULT_OUTPUT_POLICY.render); const evidence = options.evidence_pointer?.trim(); const lines = [...excerpt.text.split("\n"), ...(evidence ? [`[evidence: ${sanitizeUntrustedTerminalText(evidence)}]`] : [])]; const fromEnd = Math.max(0, options.scroll_from_end ?? 0); const end = Math.max(0, lines.length - fromEnd); return lines.slice(Math.max(0, end - height), end).map((line) => clipDisplay(line, width)); }
function dimensions(value: { width: number; height: number }): { width: number; height: number } { return { width: positive(value.width, "width"), height: positive(value.height, "height") }; }
function positive(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`); return value; }
/**
 * Clamp a scroll offset so it always lands on a REAL row.
 *
 * Clamping to `length` let the offset equal the row count, so `slice(offset)`
 * returned nothing: paging past the end of the 188-row Capabilities screen
 * showed a blank table captioned "0-188 of 188" — no rows, an impossible
 * range, and no way to tell the list had simply been scrolled off (EC-043).
 * Clamped to the last ROW, not the last full page: a status document may
 * deliberately scroll a short list that already fits (its "respects record
 * offsets" contract), so requiring a full page would silently disable that.
 * This is OpenCode's own idiom — `Math.max(0, Math.min(rows.length - 1, ...))`
 * — and the `Math.max(0, Math.min(` clamp Claude Code uses in 57 places.
 */
function boundedOffset(value: number | undefined, length: number): number { const offset = value ?? 0; if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer"); return Math.min(offset, Math.max(0, length - 1)); }
function pad(value: string, width: number): string { return value + " ".repeat(Math.max(0, width - displayWidth(value))); }
function isCombining(point: number): boolean { return (point >= 0x300 && point <= 0x36f) || (point >= 0x1ab0 && point <= 0x1aff) || (point >= 0x1dc0 && point <= 0x1dff); }
function isWide(point: number): boolean { return point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a || (point >= 0x2e80 && point <= 0xa4cf) || (point >= 0xac00 && point <= 0xd7a3) || (point >= 0xf900 && point <= 0xfaff) || (point >= 0xfe10 && point <= 0xfe6f) || (point >= 0xff00 && point <= 0xff60) || (point >= 0x1f300 && point <= 0x1faff) || (point >= 0x20000 && point <= 0x3fffd)); }
