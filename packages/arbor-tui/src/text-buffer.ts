/**
 * Pure cursor/multiline text-buffer model (T2.3b, RV-TUI-14 / FP-19).
 *
 * The compose overlay (`userinput.answer` free-text) and operator-form text
 * fields previously had no cursor at all — typing only ever appended to the
 * end of a string, and backspace only ever chopped the last character. This
 * module is the pure editing core both consumers (`update.ts`'s reducers)
 * drive: cursor-relative insert/delete/movement over a single string that
 * may contain embedded `\n` (compose only — operator-form fields stay
 * single-line by never receiving a `\n` insert). No terminal/rendering
 * concern lives here; `renderer.ts` wraps and paints the result.
 *
 * Cursor is a UTF-16 code-unit offset into `text` (0..text.length),
 * consistent with every other buffer offset already in this codebase
 * (`compose.buffer.slice(0, -1)`, `MAX_ANSWER_BYTES` truncation, etc.) — not
 * grapheme-cluster-aware, matching the existing convention rather than
 * introducing a second one.
 */

export interface TextBufferState {
  readonly text: string;
  readonly cursor: number;
}

export type CursorMovement = "left" | "right" | "up" | "down" | "home" | "end" | "word_left" | "word_right";

function clampOffset(offset: number, text: string): number {
  if (!Number.isFinite(offset)) return text.length;
  return Math.min(Math.max(Math.trunc(offset), 0), text.length);
}

/**
 * Grapheme-cluster boundaries for `text` (UTF-16 code-unit offsets), via the
 * platform's `Intl.Segmenter` (ui-spec §7: combining marks, ZWJ emoji
 * sequences and CJK wide characters move/delete as one unit, not one code
 * unit at a time). Always includes `0` and `text.length`, and is cached per
 * call only — callers that move the cursor repeatedly over the same buffer
 * pay this once per call, matching every other pure function in this module.
 */
function graphemeBoundaries(text: string): readonly number[] {
  if (text.length === 0) return [0];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const boundaries: number[] = [0];
  for (const segment of segmenter.segment(text)) boundaries.push(segment.index + segment.segment.length);
  return boundaries;
}

/** The nearest grapheme boundary at or before `offset`. */
function graphemeBoundaryAtOrBefore(text: string, offset: number): number {
  const boundaries = graphemeBoundaries(text);
  let result = 0;
  for (const boundary of boundaries) { if (boundary <= offset) result = boundary; else break; }
  return result;
}

/** The nearest grapheme boundary at or after `offset`. */
function graphemeBoundaryAtOrAfter(text: string, offset: number): number {
  const boundaries = graphemeBoundaries(text);
  for (const boundary of boundaries) if (boundary >= offset) return boundary;
  return text.length;
}

/** One grapheme cluster's code-unit width, ending at `offset` (offset must be a boundary or later). */
function graphemeWidthBefore(text: string, offset: number): number {
  const start = graphemeBoundaryAtOrBefore(text, Math.max(0, offset - 1));
  return Math.max(1, offset - start);
}

/** One grapheme cluster's code-unit width, starting at `offset`. */
function graphemeWidthAfter(text: string, offset: number): number {
  const end = graphemeBoundaryAtOrAfter(text, offset + 1);
  return Math.max(1, end - offset);
}

/** A buffer holding `text`, cursor placed at its end — the pre-existing "always append" behavior. */
export function fromText(text: string): TextBufferState {
  return { text, cursor: text.length };
}

/** Insert `insert` at the cursor as one edit (typed characters, or a whole paste). Empty insert is a no-op. */
export function insertText(state: TextBufferState, insert: string): TextBufferState {
  if (insert.length === 0) return state;
  const cursor = clampOffset(state.cursor, state.text);
  return { text: state.text.slice(0, cursor) + insert + state.text.slice(cursor), cursor: cursor + insert.length };
}

/**
 * Delete the grapheme cluster before the cursor (Backspace). No-op at offset
 * 0. Grapheme-aware (ui-spec §7): a combining mark, ZWJ emoji sequence, or
 * wide CJK character is deleted as one unit, not one UTF-16 code unit.
 */
export function backspace(state: TextBufferState): TextBufferState {
  const cursor = clampOffset(state.cursor, state.text);
  if (cursor === 0) return { text: state.text, cursor };
  const width = graphemeWidthBefore(state.text, cursor);
  return { text: state.text.slice(0, cursor - width) + state.text.slice(cursor), cursor: cursor - width };
}

/**
 * Delete the grapheme cluster at the cursor (Delete/`[3~`). No-op at end of
 * text. Grapheme-aware, mirroring `backspace` above.
 */
export function deleteForward(state: TextBufferState): TextBufferState {
  const cursor = clampOffset(state.cursor, state.text);
  if (cursor >= state.text.length) return { text: state.text, cursor };
  const width = graphemeWidthAfter(state.text, cursor);
  return { text: state.text.slice(0, cursor) + state.text.slice(cursor + width), cursor };
}

function lineStart(text: string, offset: number): number {
  const idx = text.lastIndexOf("\n", Math.max(0, offset - 1));
  return idx < 0 ? 0 : idx + 1;
}

function lineEnd(text: string, offset: number): number {
  const idx = text.indexOf("\n", offset);
  return idx < 0 ? text.length : idx;
}

const WORD_BOUNDARY = /\s/u;

/** Move the cursor per `movement`. `up`/`down` are only meaningful over embedded `\n`; on single-line text they clamp to start/end. */
export function moveCursor(state: TextBufferState, movement: CursorMovement): TextBufferState {
  const { text } = state;
  const cursor = clampOffset(state.cursor, text);
  switch (movement) {
    case "left":
      // Grapheme-aware (ui-spec §7): steps over one full cluster, never
      // splitting a combining mark, ZWJ emoji sequence, or wide character.
      return { text, cursor: cursor <= 0 ? 0 : graphemeBoundaryAtOrBefore(text, cursor - 1) };
    case "right":
      return { text, cursor: cursor >= text.length ? text.length : graphemeBoundaryAtOrAfter(text, cursor + 1) };
    case "home":
      return { text, cursor: lineStart(text, cursor) };
    case "end":
      return { text, cursor: lineEnd(text, cursor) };
    case "word_left": {
      let i = cursor;
      while (i > 0 && WORD_BOUNDARY.test(text[i - 1] ?? "")) i -= 1;
      while (i > 0 && !WORD_BOUNDARY.test(text[i - 1] ?? "")) i -= 1;
      return { text, cursor: i };
    }
    case "word_right": {
      let i = cursor;
      while (i < text.length && WORD_BOUNDARY.test(text[i] ?? "")) i += 1;
      while (i < text.length && !WORD_BOUNDARY.test(text[i] ?? "")) i += 1;
      return { text, cursor: i };
    }
    case "up": {
      const start = lineStart(text, cursor);
      if (start === 0) return { text, cursor: 0 };
      const column = cursor - start;
      const prevEnd = start - 1;
      const prevStart = lineStart(text, prevEnd);
      return { text, cursor: prevStart + Math.min(column, prevEnd - prevStart) };
    }
    case "down": {
      const end = lineEnd(text, cursor);
      if (end === text.length) return { text, cursor: text.length };
      const column = cursor - lineStart(text, cursor);
      const nextStart = end + 1;
      const nextEnd = lineEnd(text, nextStart);
      return { text, cursor: nextStart + Math.min(column, nextEnd - nextStart) };
    }
  }
}

export interface CursorLineInfo {
  /** 0-based line index the cursor sits on. */
  readonly line: number;
  /** 0-based column (code units since that line's start). */
  readonly column: number;
  /** Total number of `\n`-delimited lines in the buffer (always >= 1). */
  readonly lineCount: number;
}

/** Where the cursor sits in `\n`-delimited line/column terms — drives the renderer's "line n/m" hint and cursor placement. */
export function cursorLineInfo(state: TextBufferState): CursorLineInfo {
  const cursor = clampOffset(state.cursor, state.text);
  const before = state.text.slice(0, cursor);
  const line = (before.match(/\n/gu) ?? []).length;
  const column = cursor - lineStart(state.text, cursor);
  const lineCount = (state.text.match(/\n/gu) ?? []).length + 1;
  return { line, column, lineCount };
}
