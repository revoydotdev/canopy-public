/**
 * Small dependency-free visual encoders used by canopy-debug.
 *
 * The TUI owns a structured terminal scene rather than a native window, so a
 * screenshot has to be rendered from that scene.  Keeping this encoder local
 * makes screenshots work in headless sessions and in the Bun launcher without
 * requiring ImageMagick, a browser, or a platform-specific screen grabber.
 * The output is a real PNG (RGBA, zlib-compressed scanlines), not a renamed
 * ANSI transcript.  Terminal recording uses the asciicast v2 line format.
 */
import { deflateSync } from "node:zlib";
import { stripAnsi } from "@arbor/tui";

const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
const MAX_COLUMNS = 512;
const MAX_ROWS = 256;

/** A compact 5x7 font for the ASCII characters most common in a TUI. */
const FONT: Record<string, readonly string[]> = {
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  ".": [".....", ".....", ".....", ".....", ".....", "..#..", "..#.."],
  ",": [".....", ".....", ".....", ".....", ".....", "..#..", ".#..."],
  ":": [".....", "..#..", "..#..", ".....", "..#..", "..#..", "....."],
  "-": [".....", ".....", ".....", ".###.", ".....", ".....", "....."],
  "_": [".....", ".....", ".....", ".....", ".....", ".....", ".###."],
  "/": ["....#", "...#.", "...#.", "..#..", ".#...", ".#...", "#...."],
  "\\": ["#....", ".#...", ".#...", "..#..", "...#.", "...#.", "....#"],
  "[": [".##..", ".#...", ".#...", ".#...", ".#...", ".#...", ".##.."],
  "]": ["..##.", "...#.", "...#.", "...#.", "...#.", "...#.", "..##."],
  "(": ["..#..", ".#...", "#....", "#....", "#....", ".#...", "..#.."],
  ")": ["..#..", "...#.", "....#", "....#", "....#", "...#.", "..#.."],
  "<": ["...#.", "..#..", ".#...", "#....", ".#...", "..#..", "...#."],
  ">": [".#...", "..#..", "...#.", "....#", "...#.", "..#..", ".#..."],
  "=": [".....", ".###.", ".....", ".###.", ".....", ".....", "....."],
  "+": [".....", "..#..", "..#..", ".###.", "..#..", "..#..", "....."],
  "*": [".....", "#.#.#", ".###.", "#####", ".###.", "#.#.#", "....."],
  "#": [".#.#.", "#####", ".#.#.", ".#.#.", "#####", ".#.#.", ".#.#."],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "#....", "####.", "....#", "....#", "####."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
};

const LETTERS = [
  ["A", [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"]],
  ["B", ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."]],
  ["C", [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."]],
  ["D", ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."]],
  ["E", ["#####", "#....", "#....", "####.", "#....", "#....", "#####"]],
  ["F", ["#####", "#....", "#....", "####.", "#....", "#....", "#...."]],
  ["G", [".###.", "#...#", "#....", "#..##", "#...#", "#...#", ".####"]],
  ["H", ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"]],
  ["I", [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."]],
  ["J", ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."]],
  ["K", ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"]],
  ["L", ["#....", "#....", "#....", "#....", "#....", "#....", "#####"]],
  ["M", ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"]],
  ["N", ["#...#", "##..#", "##..#", "#.#.#", "#..##", "#..##", "#...#"]],
  ["O", [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."]],
  ["P", ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."]],
  ["Q", [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"]],
  ["R", ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"]],
  ["S", [".####", "#....", "#....", ".###.", "....#", "....#", "####."]],
  ["T", ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."]],
  ["U", ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."]],
  ["V", ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."]],
  ["W", ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"]],
  ["X", ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"]],
  ["Y", ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."]],
  ["Z", ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"]],
] as const;
for (const [letter, pattern] of LETTERS) FONT[letter] = pattern;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.allocUnsafe(12 + typeBytes.length + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  Buffer.from(data).copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.length);
  return result;
}

/** Render the structured terminal scene into a valid RGB-neutral RGBA PNG. */
export function renderTerminalPng(frame: { readonly scene: { readonly columns: number; readonly rows: readonly string[] } }): Uint8Array {
  // Keep capture resilient to a partially populated frame.  Headless tests and
  // shutdown races can hand us a scene without dimensions; derive a bounded
  // width from visible rows instead of allowing NaN into Buffer.alloc().
  const sourceRows = Array.isArray(frame.scene.rows) ? frame.scene.rows : [];
  const inferredColumns = sourceRows.reduce((max, row) => Math.max(max, stripAnsi(String(row)).length), 1);
  const rawColumns = Number(frame.scene.columns);
  const columns = Math.max(1, Math.min(MAX_COLUMNS, Number.isFinite(rawColumns) && rawColumns > 0 ? Math.trunc(rawColumns) : inferredColumns));
  const rows = sourceRows.slice(0, MAX_ROWS).map((row) => [...stripAnsi(String(row))]);
  const heightRows = Math.max(1, rows.length);
  const width = columns * CELL_WIDTH;
  const height = heightRows * CELL_HEIGHT;
  const scanlines = Buffer.alloc((width * 4 + 1) * height, 0);
  const background = [15, 23, 42, 255] as const;
  const foreground = [226, 232, 240, 255] as const;
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / CELL_HEIGHT);
    const localY = y % CELL_HEIGHT;
    const scanOffset = y * (width * 4 + 1);
    scanlines[scanOffset] = 0;
    for (let x = 0; x < width; x++) {
      const cell = Math.floor(x / CELL_WIDTH);
      const localX = x % CELL_WIDTH;
      const glyph = rows[row]?.[cell] ?? " ";
      const pattern = FONT[glyph] ?? FONT[glyph.toUpperCase()] ?? FONT["?"]!;
      const ink = localY >= 4 && localY <= 10 && localX >= 1 && localX <= 5 && pattern[localY - 4]![localX - 1] === "#";
      const color = ink ? foreground : background;
      const pixel = scanOffset + 1 + (x * 4);
      scanlines[pixel] = color[0]; scanlines[pixel + 1] = color[1]; scanlines[pixel + 2] = color[2]; scanlines[pixel + 3] = color[3];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
}

/** Asciinema v2 header for a durable, seekable terminal recording. */
export function terminalRecordingHeader(frame: { readonly scene: { readonly columns: number; readonly rows: readonly string[] } }): string {
  const rows = Array.isArray(frame.scene.rows) ? frame.scene.rows : [];
  const inferredColumns = rows.reduce((max, row) => Math.max(max, stripAnsi(String(row)).length), 1);
  const rawColumns = Number(frame.scene.columns);
  const width = Number.isFinite(rawColumns) && rawColumns > 0 ? Math.trunc(rawColumns) : inferredColumns;
  return `${JSON.stringify({ version: 2, width: Math.max(1, width), height: Math.max(1, rows.length), timestamp: Math.floor(Date.now() / 1000), env: { TERM: "xterm-256color", SHELL: "canopy-debug" } })}\n`;
}
