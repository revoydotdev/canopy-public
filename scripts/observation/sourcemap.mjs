/**
 * scripts/observation/sourcemap.mjs — minimal Source Map v3 reader for
 * ADR-042's observation pipeline (scripts/vi-observe.mjs).
 *
 * Hand-rolled, ~zero dependencies (Commandment: no new runtime deps). Decodes
 * only what vi-observe.mjs needs: the base64-VLQ `mappings` field, enough to
 * answer "generated (line, column) in this dist/*.js file -> which original
 * packages/*\/src/*.ts (line, column)".
 *
 * OFFSET UNIT — VERIFIED EMPIRICALLY, NOT ASSUMED. V8 coverage's
 * `ranges[].startOffset`/`endOffset` are character offsets into the
 * COMPILED FILE'S TEXT. The candidate ambiguity is UTF-16 code units vs.
 * UTF-8 bytes, and they diverge the instant a multibyte character appears
 * before the offset in question.
 *
 * Verified 2026-08-11 with a throwaway fixture (a comment and a string
 * literal containing multibyte characters — "日本語テスト", accented
 * Latin — placed before an exported function, compiled with this
 * repository's own `typescript` package, executed under
 * `NODE_V8_COVERAGE`): the real V8-reported `startOffset` for the exported
 * function, walked as a **UTF-16 code-unit index into the `fs.readFileSync`
 * result** (i.e. plain JS string indexing — `str[i]`, `str.length` — which
 * is inherently UTF-16 in every JS engine), landed exactly on
 * `"function coveredFn(x"` — correct. The same offset walked as a UTF-8
 * **byte** index (via `Buffer.from(str, "utf8")`) landed mid-string, one
 * line early — wrong. See `scripts/tests/vi-observe.test.mjs` for the
 * committed regression test that re-verifies this every run.
 *
 * CONSEQUENCE: this module does no byte-counting at all. `fs.readFileSync`
 * with the `"utf8"` encoding already decodes into a JS string, and plain
 * string iteration over that string already walks UTF-16 code units — so
 * `offsetToLineColumn` below is deliberately the simplest possible
 * implementation, not an oversight.
 */

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = new Map([...BASE64_CHARS].map((c, i) => [c, i]));

/** Decode one VLQ-base64 segment string into an array of signed integers. */
function decodeVlqSegment(segment) {
  const values = [];
  let shift = 0;
  let value = 0;
  for (const char of segment) {
    const digit = BASE64_LOOKUP.get(char);
    if (digit === undefined) throw new Error(`sourcemap: invalid base64 VLQ character '${char}'`);
    const continuation = digit & 0b100000;
    let chunk = digit & 0b011111;
    value += chunk << shift;
    if (continuation) {
      shift += 5;
      continue;
    }
    const negative = value & 1;
    value >>= 1;
    values.push(negative ? -value : value);
    value = 0;
    shift = 0;
  }
  return values;
}

/**
 * Parse a Source Map v3 `mappings` string into per-generated-line arrays of
 * `{ genColumn, sourceIndex, origLine, origColumn }`, sorted by genColumn.
 * Fields are cumulative across the whole map per the spec (source index and
 * original line/column reset only implicitly via the running deltas); the
 * name index (5th VLQ field) is decoded to stay spec-correct but discarded —
 * vi-observe.mjs never needs identifier names, only positions.
 */
export function parseMappings(mappingsString) {
  const lines = [];
  let genColumn = 0;
  let sourceIndex = 0;
  let origLine = 0;
  let origColumn = 0;

  for (const lineStr of mappingsString.split(";")) {
    genColumn = 0;
    const segments = [];
    if (lineStr.length > 0) {
      for (const seg of lineStr.split(",")) {
        if (seg.length === 0) continue;
        const decoded = decodeVlqSegment(seg);
        genColumn += decoded[0];
        if (decoded.length >= 4) {
          sourceIndex += decoded[1];
          origLine += decoded[2];
          origColumn += decoded[3];
          segments.push({ genColumn, sourceIndex, origLine, origColumn });
        }
        // A 1-field segment (generated-column only, no source mapping) is
        // legal per spec and carries no original position — skip storing it,
        // it cannot resolve to a symbol either way.
      }
    }
    segments.sort((a, b) => a.genColumn - b.genColumn);
    lines.push(segments);
  }
  return lines;
}

/** Load and parse a `.js.map` file (Source Map v3) into a queryable form. */
export function loadSourceMap(mapJson) {
  const map = typeof mapJson === "string" ? JSON.parse(mapJson) : mapJson;
  if (map.version !== 3) throw new Error(`sourcemap: unsupported version ${map.version}`);
  const sources = (map.sources ?? []).map((s) => (map.sourceRoot ? `${map.sourceRoot.replace(/\/$/, "")}/${s}` : s));
  return { sources, lines: parseMappings(map.mappings ?? "") };
}

/**
 * Resolve a 0-based (generatedLine, generatedColumn) through a parsed map to
 * `{ source, line, column }` (source = the resolved sources[] path, line and
 * column both 0-based, matching the original file's own coordinates), or
 * `null` if this generated line has no mapping at or before that column.
 *
 * "At or before" (not exact match) is standard sourcemap consumer behavior:
 * a coverage offset lands inside a mapped RANGE, not necessarily exactly on
 * a mapping boundary, so the last segment with genColumn <= target is the
 * segment that covers it.
 */
export function resolvePosition(parsedMap, generatedLine, generatedColumn) {
  const segments = parsedMap.lines[generatedLine];
  if (!segments || segments.length === 0) return null;
  let best = null;
  for (const seg of segments) {
    if (seg.genColumn <= generatedColumn) best = seg;
    else break;
  }
  if (!best) return null;
  const source = parsedMap.sources[best.sourceIndex];
  if (source === undefined) return null;
  return { source, line: best.origLine, column: best.origColumn };
}

/**
 * Convert a 0-based UTF-16 code-unit character OFFSET into the generated
 * file's text into a 0-based (line, column) pair. See the module header for
 * why offsets are walked as UTF-16 code units (verified empirically, not
 * assumed) and why this is a plain string scan.
 */
export function offsetToLineColumn(text, offset) {
  let line = 0;
  let column = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") { line++; column = 0; } else { column++; }
  }
  return { line, column };
}
