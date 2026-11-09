/**
 * Pure unified-patch diff model + renderers for the Diff Review screen
 * (T2.3a / FP-20 / RV-TUI-10). Leaf module: depends only on widgets.ts and
 * player-piano.ts's theme-derived ANSI palette — never @arbor/mcp (ADR-011).
 *
 * `fromReviewLines` adapts the already-parsed `files`/`unified` arrays the
 * `result.review.workspace` query actually puts on the wire today (flat
 * `ReviewDiffLine` records with `kind: context|addition|deletion|header|
 * binary`) into the model the screen renders. The TUI deliberately does not
 * reparse raw patch text: the result-review service owns that wire grammar and
 * supplies its typed projection.
 *
 * A rename/binary/mode-only entry carries no line-level hunks; both
 * renderers degrade to a typed one-line `note`, never a crash.
 */
import { ANSI, clipAnsi } from "./player-piano.js";
import { highlightSyntax, syntaxLanguageForPath } from "./syntax.js";
import { clipDisplay, displayWidth } from "./widgets.js";

export type DiffLineKind = "context" | "addition" | "deletion" | "header" | "binary";

export interface DiffLine {
  readonly old_line: number | null;
  readonly new_line: number | null;
  readonly kind: DiffLineKind;
  readonly text: string;
}

export interface DiffHunk {
  readonly header: string;
  readonly old_start: number;
  readonly new_start: number;
  readonly lines: readonly DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "binary" | "mode-only";

export interface DiffFile {
  readonly path: string;
  readonly old_path: string | null;
  readonly status: DiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
  /** Typed one-line note for an entry with no line-level hunks (binary/pure-rename/mode-only). Null when the file has real hunks. */
  readonly note: string | null;
}

export interface ParsedDiff {
  readonly files: readonly DiffFile[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface MutableFile {
  path: string;
  old_path: string | null;
  status: DiffFileStatus;
  binary: boolean;
  mode_only: boolean;
  hunks: DiffHunk[];
}

function noteFor(file: MutableFile): string | null {
  if (file.hunks.length > 0) return null;
  if (file.binary) return "Binary file changed — no line-level diff.";
  if (file.status === "renamed") return file.old_path ? `Renamed from ${file.old_path} — no content change.` : "Renamed — no content change.";
  if (file.mode_only) return "File mode changed — no content diff.";
  return "No content diff.";
}

function finalizeFile(file: MutableFile, additions: number, deletions: number): DiffFile {
  return {
    path: file.path,
    old_path: file.old_path,
    status: file.binary ? "binary" : file.status,
    additions,
    deletions,
    hunks: file.hunks,
    note: noteFor(file),
  };
}

// ── adapter from the result.review.workspace wire shape ─────────────────────

export interface ReviewFileLike {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
}
export interface ReviewDiffLineLike {
  readonly file_path: string | null;
  readonly old_line: number | null;
  readonly new_line: number | null;
  readonly kind: string;
  readonly text: string;
}

const isDiffLineKind = (value: string): value is DiffLineKind => value === "context" || value === "addition" || value === "deletion" || value === "header" || value === "binary";
const isDiffFileStatus = (value: string): value is Exclude<DiffFileStatus, "mode-only"> => value === "added" || value === "modified" || value === "deleted" || value === "renamed" || value === "binary";

/** Build the pure diff model from the already-tokenized `files`/`unified` arrays `result.review.workspace` puts on the wire — no text reparsing. */
export function fromReviewLines(files: readonly ReviewFileLike[], lines: readonly ReviewDiffLineLike[]): ParsedDiff {
  const singleFileFallback = files.length === 1 ? files[0]!.path : null;
  return {
    files: files.map((file): DiffFile => {
      const owned = lines.filter((line) => line.file_path === file.path || (line.file_path === null && singleFileFallback === file.path));
      const hunks: DiffHunk[] = [];
      let current: { header: string; old_start: number; new_start: number; lines: DiffLine[] } | null = null;
      for (const line of owned) {
        const kind = isDiffLineKind(line.kind) ? line.kind : "context";
        if (kind === "header") {
          // The wire's "header" kind also carries file-level preamble
          // (`diff --git ...`, `index ...`, `--- a/...`, `+++ b/...`) that
          // result-review-workspace.ts's own parser tags "header" too —
          // only a real `@@ -a,b +c,d @@` line starts a new hunk; the rest
          // is preamble already reflected in `file.status`/`file.path` and
          // carries no line-level content of its own.
          const parsed = HUNK_HEADER.exec(line.text);
          if (!parsed) continue;
          if (current) hunks.push(current);
          current = { header: line.text, old_start: Number(parsed[1]), new_start: Number(parsed[2]), lines: [] };
          continue;
        }
        if (kind === "binary") continue; // carried on file.status instead of a line
        if (current === null) continue; // content with no preceding hunk header — never guess a hunk boundary
        current.lines.push({ old_line: line.old_line, new_line: line.new_line, kind, text: line.text });
      }
      if (current) hunks.push(current);
      const status = isDiffFileStatus(file.status) ? file.status : "modified";
      const built: MutableFile = { path: file.path, old_path: null, status, binary: status === "binary", mode_only: false, hunks };
      return finalizeFile(built, file.additions, file.deletions);
    }),
  };
}

// ── rendering ────────────────────────────────────────────────────────────────

export interface DiffRenderOptions {
  readonly width: number;
  readonly height: number;
  readonly mode: "unified" | "split";
  readonly scroll_offset?: number;
  /** Index into `file.hunks` to visually mark as the operator's current hunk. Null/absent = no hunk highlighted. */
  readonly current_hunk?: number | null;
  readonly color?: boolean;
}

function hunkHeaderLine(hunk: DiffHunk, isCurrent: boolean, width: number, color: boolean): string {
  const marker = isCurrent ? "▶ " : "  ";
  const text = `${marker}${hunk.header}`;
  if (!color) return clipDisplay(text, width);
  const style = isCurrent ? `${ANSI.bold}${ANSI.magenta}` : ANSI.cyan;
  return clipAnsi(`${style}${text}${ANSI.reset}`, width);
}

function gutter(oldLine: number | null, newLine: number | null): string {
  const old = oldLine === null ? "" : String(oldLine);
  const fresh = newLine === null ? "" : String(newLine);
  return `${old.padStart(5)} ${fresh.padStart(5)}`;
}

function unifiedLineMarker(kind: DiffLineKind): string {
  if (kind === "addition") return "+";
  if (kind === "deletion") return "-";
  return " ";
}

function renderUnifiedLine(line: DiffLine, width: number, color: boolean, path: string): string {
  const marker = unifiedLineMarker(line.kind);
  const prefix = `${gutter(line.old_line, line.new_line)} ${marker} `;
  const textWidth = Math.max(0, width - displayWidth(prefix));
  // Added/deleted rows reserve their full-line color for the status signal;
  // unchanged context receives lexical coloring so syntax remains legible
  // without obscuring whether the row changed.
  const source = color && line.kind === "context"
    ? clipAnsi(highlightSyntax(line.text, syntaxLanguageForPath(path)), textWidth)
    : clipDisplay(line.text, textWidth);
  const body = `${prefix}${source}`;
  if (!color) return body;
  if (line.kind === "addition") return clipAnsi(`${ANSI.green}${body}${ANSI.reset}`, width);
  if (line.kind === "deletion") return clipAnsi(`${ANSI.red}${body}${ANSI.reset}`, width);
  return body;
}

function paginate(lines: readonly string[], height: number, offset: number): readonly string[] {
  const bounded = Math.min(Math.max(0, offset), lines.length);
  return lines.slice(bounded, bounded + Math.max(0, height));
}

function renderUnified(file: DiffFile, options: DiffRenderOptions): readonly string[] {
  const color = options.color ?? false;
  const lines: string[] = [];
  file.hunks.forEach((hunk, index) => {
    lines.push(hunkHeaderLine(hunk, index === options.current_hunk, options.width, color));
    for (const line of hunk.lines) lines.push(renderUnifiedLine(line, options.width, color, file.path));
  });
  return paginate(lines, options.height, options.scroll_offset ?? 0);
}

/** Clip a display string to `width` columns, honestly marking truncation with a single "…" cell rather than silently dropping content. */
function clipWithMarker(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return clipDisplay(text, width).padEnd(width, " ");
  return `${clipDisplay(text, Math.max(0, width - 1))}…`;
}

interface SplitRow {
  readonly old_line: number | null;
  readonly old_text: string;
  readonly new_line: number | null;
  readonly new_text: string;
  readonly kind: "context" | "changed" | "deletion" | "addition";
}

/** Pair a hunk's context/addition/deletion lines into old|new columns, matching each deletion run to the addition run that follows it (the same pairing a two-column diff view always uses). */
function pairHunkLines(hunk: DiffHunk): readonly SplitRow[] {
  const rows: SplitRow[] = [];
  const pendingDeletions: DiffLine[] = [];
  const flush = (): void => { for (const deletion of pendingDeletions) rows.push({ old_line: deletion.old_line, old_text: deletion.text, new_line: null, new_text: "", kind: "deletion" }); pendingDeletions.length = 0; };
  for (const line of hunk.lines) {
    if (line.kind === "deletion") { pendingDeletions.push(line); continue; }
    if (line.kind === "addition") {
      const paired = pendingDeletions.shift();
      rows.push(paired
        ? { old_line: paired.old_line, old_text: paired.text, new_line: line.new_line, new_text: line.text, kind: "changed" }
        : { old_line: null, old_text: "", new_line: line.new_line, new_text: line.text, kind: "addition" });
      continue;
    }
    flush();
    rows.push({ old_line: line.old_line, old_text: line.text, new_line: line.new_line, new_text: line.text, kind: "context" });
  }
  flush();
  return rows;
}

function renderSplitRow(row: SplitRow, half: number, color: boolean, path: string): string {
  const oldGutter = (row.old_line === null ? "" : String(row.old_line)).padStart(5);
  const newGutter = (row.new_line === null ? "" : String(row.new_line)).padStart(5);
  const bodyWidth = Math.max(0, half - 6);
  const language = syntaxLanguageForPath(path);
  const oldBody = color && row.kind === "context" ? clipAnsi(highlightSyntax(row.old_text, language), bodyWidth) : clipWithMarker(row.old_text, bodyWidth);
  const newBody = color && row.kind === "context" ? clipAnsi(highlightSyntax(row.new_text, language), bodyWidth) : clipWithMarker(row.new_text, bodyWidth);
  const oldRaw = `${oldGutter} ${oldBody}`;
  const newRaw = `${newGutter} ${newBody}`;
  const oldSide = `${oldRaw}${" ".repeat(Math.max(0, half - displayWidth(oldRaw)))}`;
  const newSide = `${newRaw}${" ".repeat(Math.max(0, half - displayWidth(newRaw)))}`;
  if (!color) return `${oldSide} │ ${newSide}`;
  const oldStyled = row.kind === "deletion" || row.kind === "changed" ? `${ANSI.red}${oldSide}${ANSI.reset}` : oldSide;
  const newStyled = row.kind === "addition" || row.kind === "changed" ? `${ANSI.green}${newSide}${ANSI.reset}` : newSide;
  return `${oldStyled} │ ${newStyled}`;
}

function renderSplit(file: DiffFile, options: DiffRenderOptions): readonly string[] {
  const color = options.color ?? false;
  const half = Math.max(1, Math.floor((options.width - 3) / 2));
  const lines: string[] = [];
  file.hunks.forEach((hunk, index) => {
    lines.push(hunkHeaderLine(hunk, index === options.current_hunk, options.width, color));
    for (const row of pairHunkLines(hunk)) lines.push(clipAnsi(renderSplitRow(row, half, color, file.path), options.width));
  });
  return paginate(lines, options.height, options.scroll_offset ?? 0);
}

/** Render one file's diff — unified gutter view or width-aware side-by-side. Degrades to the file's typed one-line `note` when it has no line-level hunks (binary/pure-rename/mode-only), never crashing. */
export function renderDiffFile(file: DiffFile, options: DiffRenderOptions): readonly string[] {
  if (file.hunks.length === 0) return [clipDisplay(file.note ?? "No content diff.", options.width)];
  return options.mode === "split" ? renderSplit(file, options) : renderUnified(file, options);
}
