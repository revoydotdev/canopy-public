/**
 * Strict SGR (`ESC [ ... m`) → `@opentui/core` `StyledText` conversion.
 *
 * `renderer.ts`/`theme.ts`/`status-bar.ts`/`player-piano.ts` are the only
 * emitters of embedded ANSI in this package's frame text, and they only ever
 * emit a fixed, known vocabulary: reset (`0`), the bare attribute codes
 * `1`/`2`/`3`/`4`/`9` (bold/dim/italic/underline/strikethrough), and 24-bit
 * truecolor `38;2;r;g;b` / `48;2;r;g;b`. This parser recognizes exactly that
 * vocabulary and safely drops everything else (unknown SGR codes, malformed
 * parameter lists, and any non-SGR escape sequence) rather than leaking raw
 * escape bytes into rendered text — `@opentui/core` ships no ANSI parser of
 * its own, and `TextRenderable.content` shows a plain string byte-for-byte,
 * SGR bytes included, if handed one directly.
 */
import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core";

const ESC = "";

interface AnsiStyleState {
  fg: RGBA | undefined;
  bg: RGBA | undefined;
  attributes: number;
}

function freshState(): AnsiStyleState {
  return { fg: undefined, bg: undefined, attributes: 0 };
}

/** Applies one already-tokenized SGR parameter list (`38;2;r;g;b` etc.) to `state` in place. Unknown/malformed codes are ignored, never thrown. */
function applySgrParams(params: readonly string[], state: AnsiStyleState): void {
  if (params.length === 0 || (params.length === 1 && params[0] === "")) {
    // `ESC[m` with no params is defined as `ESC[0m` (full reset).
    state.fg = undefined;
    state.bg = undefined;
    state.attributes = 0;
    return;
  }
  let i = 0;
  while (i < params.length) {
    const code = params[i];
    if (code === "0" || code === "") {
      state.fg = undefined;
      state.bg = undefined;
      state.attributes = 0;
      i += 1;
      continue;
    }
    if (code === "1") { state.attributes |= TextAttributes.BOLD; i += 1; continue; }
    if (code === "2") { state.attributes |= TextAttributes.DIM; i += 1; continue; }
    if (code === "3") { state.attributes |= TextAttributes.ITALIC; i += 1; continue; }
    if (code === "4") { state.attributes |= TextAttributes.UNDERLINE; i += 1; continue; }
    if (code === "9") { state.attributes |= TextAttributes.STRIKETHROUGH; i += 1; continue; }
    if (code === "38" || code === "48") {
      const mode = params[i + 1];
      if (mode === "2") {
        const r = Number(params[i + 2]);
        const g = Number(params[i + 3]);
        const b = Number(params[i + 4]);
        const valid =
          params.length >= i + 5 &&
          [r, g, b].every((component) => Number.isInteger(component) && component >= 0 && component <= 255);
        if (valid) {
          const color = RGBA.fromInts(r, g, b);
          if (code === "38") state.fg = color; else state.bg = color;
          i += 5;
          continue;
        }
      }
      // Unsupported color mode (e.g. 256-indexed `38;5;n`) or a truncated
      // truecolor sequence — the r/g/b components can't be told apart from
      // unrelated trailing codes, so the rest of this SGR escape is dropped
      // wholesale rather than guessing where a "next" code would begin.
      i = params.length;
      continue;
    }
    // Any other SGR code (italic-off, blink, reverse, 16/256-color aliases,
    // …) is out of scope for this codebase's real emitters — safely ignored.
    i += 1;
  }
}

/** One parsed, fixed-attribute run plus the plain text it covers. */
interface AnsiRun {
  readonly text: string;
  readonly fg: RGBA | undefined;
  readonly bg: RGBA | undefined;
  readonly attributes: number;
}

/**
 * Scans `input` for SGR escape sequences, applying each to a running style
 * state and splitting the plain text between them into style-tagged runs. A
 * malformed or unrecognized escape sequence (not a well-formed CSI, or a CSI
 * whose final byte is not `m`) is consumed and dropped without emitting any
 * of its bytes as text — this is what keeps a broken/incomplete sequence
 * from ever showing up as literal characters.
 */
function tokenize(input: string): AnsiRun[] {
  const runs: AnsiRun[] = [];
  const state = freshState();
  let buffer = "";
  let i = 0;
  const n = input.length;

  const flush = (): void => {
    if (buffer.length === 0) return;
    runs.push({ text: buffer, fg: state.fg, bg: state.bg, attributes: state.attributes });
    buffer = "";
  };

  while (i < n) {
    const ch = input[i];
    if (ch !== ESC) {
      buffer += ch;
      i += 1;
      continue;
    }
    if (input[i + 1] !== "[") {
      // A lone/unknown escape byte — drop just the ESC, never render it.
      i += 1;
      continue;
    }
    // CSI: ESC [ params(0x30-0x3F) intermediates(0x20-0x2F) final(0x40-0x7E)
    let j = i + 2;
    while (j < n && input.charCodeAt(j) >= 0x30 && input.charCodeAt(j) <= 0x3f) j += 1;
    const paramsEnd = j;
    while (j < n && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j += 1;
    if (j >= n || input.charCodeAt(j) < 0x40 || input.charCodeAt(j) > 0x7e) {
      // No valid final byte before the string ends — truncated/malformed
      // escape sequence. Drop the entire remainder; none of it is real text.
      i = n;
      continue;
    }
    const finalByte = input[j];
    const paramText = input.slice(i + 2, paramsEnd);
    if (finalByte === "m") {
      flush();
      const params = paramText.split(";");
      applySgrParams(params, state);
    }
    // Any other CSI final byte (cursor movement, erase, etc.) is not part of
    // this codebase's emitted vocabulary — consumed and dropped, same as an
    // unsupported SGR code, so its bytes never leak into rendered text.
    i = j + 1;
  }
  flush();
  return runs;
}

/**
 * Converts a string that may contain embedded SGR escapes into a real
 * `StyledText`, so `TextRenderable.content` paints actual native fg/bg/
 * attribute cells instead of showing literal escape bytes. Plain text with
 * no escapes round-trips to a single unstyled chunk.
 */
export function ansiToStyledText(input: string): StyledText {
  const runs = tokenize(input);
  const chunks: TextChunk[] = runs.map((run) => {
    const chunk: TextChunk = { __isChunk: true, text: run.text };
    if (run.fg !== undefined) chunk.fg = run.fg;
    if (run.bg !== undefined) chunk.bg = run.bg;
    if (run.attributes !== 0) chunk.attributes = run.attributes;
    return chunk;
  });
  return new StyledText(chunks);
}
