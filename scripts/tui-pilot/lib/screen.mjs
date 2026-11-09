/**
 * Screen snapshots from an `@xterm/headless` terminal, and their rendering.
 *
 * A snapshot is what an operator's terminal is showing: the emulator's cell
 * grid after every byte the app wrote, including stale cells the app never
 * repainted and any bytes stderr smeared over the alternate screen. That is
 * the property `createTestRenderer` cannot have (it captures the app's own
 * intent buffer, EC-030) and `tmux capture-pane` only approximately has.
 *
 * Colour is kept. The previous pilot PNGs were `magick label:` renders of
 * stripped text, so emphasis, contrast and theme defects were unreviewable.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// xterm.js colour-mode constants (Attributes.CM_* shifted into the fg/bg word).
const CM_P16 = 0x1000000;
const CM_P256 = 0x2000000;
const CM_RGB = 0x3000000;

// A neutral dark scheme for the 16 ANSI slots. The app's own theme drives
// truecolor; these only matter when a cell uses a palette index.
const ANSI16 = [
  "#0e1116", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
  "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff",
];
export const DEFAULT_FG = "#d9e3e8";
export const DEFAULT_BG = "#0e1116";

function paletteColor(index) {
  if (index < 16) return ANSI16[index];
  if (index < 232) {
    const i = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(i / 36)], g = steps[Math.floor(i / 6) % 6], b = steps[i % 6];
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  const v = 8 + (index - 232) * 10;
  return `#${v.toString(16).padStart(2, "0").repeat(3)}`;
}

function cellColor(mode, value) {
  if (mode === CM_RGB) return `#${value.toString(16).padStart(6, "0")}`;
  if (mode === CM_P16 || mode === CM_P256) return paletteColor(value);
  return null;
}

export function sha256(text) { return createHash("sha256").update(text).digest("hex"); }

/**
 * @returns {{ cols, rows, lines: string[], padded: string[], runs: object[][], cursor: {x,y}, sha256: string, text: string }}
 */
export function snapshotScreen(term) {
  const buffer = term.buffer.active;
  const cols = term.cols, rows = term.rows;
  const lines = [], padded = [], runs = [];
  const cell = buffer.getNullCell();
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) { lines.push(""); padded.push(" ".repeat(cols)); runs.push([]); continue; }
    const full = line.translateToString(false);
    padded.push(full.padEnd(cols));
    lines.push(full.replace(/[ \t]+$/u, ""));
    const rowRuns = [];
    let current = null;
    for (let x = 0; x < cols; x++) {
      line.getCell(x, cell);
      const width = cell.getWidth();
      if (width === 0) continue; // continuation of a wide glyph
      const chars = cell.getChars() || " ";
      const inverse = cell.isInverse() !== 0;
      let fg = cellColor(cell.getFgColorMode(), cell.getFgColor());
      let bg = cellColor(cell.getBgColorMode(), cell.getBgColor());
      if (inverse) [fg, bg] = [bg ?? DEFAULT_BG, fg ?? DEFAULT_FG];
      const attrs = { fg, bg, b: cell.isBold() !== 0, d: cell.isDim() !== 0, i: cell.isItalic() !== 0, u: cell.isUnderline() !== 0, s: cell.isStrikethrough() !== 0 };
      const key = JSON.stringify(attrs);
      if (current && current.key === key) { current.t += chars; current.w += width; }
      else { current = { x, t: chars, w: width, key, ...attrs }; rowRuns.push(current); }
    }
    for (const r of rowRuns) delete r.key;
    runs.push(rowRuns);
  }
  const text = lines.join("\n");
  return { cols, rows, lines, padded, runs, cursor: { x: buffer.cursorX, y: buffer.cursorY }, sha256: sha256(text), text };
}

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Render a snapshot to SVG. Cell metrics are fixed so column alignment is exact regardless of glyph widths. */
export function renderSvg(snapshot, { cellWidth = 8, cellHeight = 17, fontSize = 13, font = "DejaVu Sans Mono", caption = null } = {}) {
  const width = snapshot.cols * cellWidth;
  const captionHeight = caption ? cellHeight + 6 : 0;
  const height = snapshot.rows * cellHeight + captionHeight;
  const parts = [`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${DEFAULT_BG}"/>`];
  const rects = [], texts = [];
  snapshot.runs.forEach((row, y) => {
    const top = y * cellHeight;
    for (const run of row) {
      const x = run.x * cellWidth;
      const w = run.w * cellWidth;
      if (run.bg && run.bg !== DEFAULT_BG) rects.push(`<rect x="${x}" y="${top}" width="${w}" height="${cellHeight}" fill="${run.bg}"/>`);
      if (run.t.trim() === "" && !run.u && !run.s) continue;
      const style = [];
      if (run.b) style.push('font-weight="bold"');
      if (run.i) style.push('font-style="italic"');
      if (run.d) style.push('opacity="0.55"');
      const deco = [run.u ? "underline" : "", run.s ? "line-through" : ""].filter(Boolean).join(" ");
      if (deco) style.push(`text-decoration="${deco}"`);
      texts.push(`<text x="${x}" y="${top + cellHeight - 4}" fill="${run.fg ?? DEFAULT_FG}" textLength="${w}" lengthAdjust="spacingAndGlyphs" ${style.join(" ")} xml:space="preserve">${xml(run.t)}</text>`);
    }
  });
  parts.push(...rects, `<g font-family="'${font}', monospace" font-size="${fontSize}">`, ...texts, "</g>");
  if (caption) parts.push(`<rect x="0" y="${snapshot.rows * cellHeight}" width="${width}" height="${captionHeight}" fill="#1b2430"/>`,
    `<text x="6" y="${snapshot.rows * cellHeight + cellHeight - 2}" fill="#9fb3c8" font-family="'${font}', monospace" font-size="${fontSize - 1}" xml:space="preserve">${xml(caption)}</text>`);
  parts.push("</svg>");
  return parts.join("");
}

/** Rasterise an SVG file with ImageMagick's rsvg delegate. Returns true on success. */
export function svgToPng(svgPath, pngPath) {
  const result = spawnSync("magick", ["-density", "96", "-background", DEFAULT_BG, svgPath, pngPath], { encoding: "utf8" });
  return result.status === 0;
}

export function writeSnapshotFiles(snapshot, basePath, { png = true, caption = null } = {}) {
  writeFileSync(`${basePath}.txt`, `${snapshot.text}\n`, "utf8");
  writeFileSync(`${basePath}.json`, JSON.stringify({ cols: snapshot.cols, rows: snapshot.rows, cursor: snapshot.cursor, sha256: snapshot.sha256, runs: snapshot.runs }), "utf8");
  if (png) {
    writeFileSync(`${basePath}.svg`, renderSvg(snapshot, { caption }), "utf8");
    if (!svgToPng(`${basePath}.svg`, `${basePath}.png`)) return { png: false };
  }
  return { png };
}
