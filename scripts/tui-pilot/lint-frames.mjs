#!/usr/bin/env bun
/**
 * Frame lint: the defect classes the EC log found by eye, as detectors.
 *
 * Every detector here corresponds to a class of defect that was found by
 * reading a screenshot (artifacts/tui-pilot/2026-09-02-exemplar-checks.md).
 * Running them before the eye means the eye never has to find the same class
 * twice, and can spend itself on hierarchy, density and wording — the things
 * a regex cannot judge. A finding is a LEAD, not a verdict: the reviewer
 * confirms on the frame.
 *
 * Usage:
 *   bun scripts/tui-pilot/lint-frames.mjs <run-dir|frames-dir> [--json] [--fail-on det,det]
 *
 * Writes <run-dir>/findings.jsonl and prints a per-detector summary.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ESC = "\u001b";
const BORDER = new Set(["│", "┃", "║", "┆", "┊", "╎"]); // ▏ is the composer cursor, not a border
const GLYPHS_OK_ALONE = new Set(["·", "▸", "▾", "◌", "◒", "◉", "○", "●", "❯", "✓", "✗", "◎", "▣", "▏", "↳", "└", "┌", "┐", "┘", "─", "╌", "│", "…", "‥", "—", "–", "»", "›", "▪", "■", "□", "⋯"]);

/** @typedef {{ detector: string, severity: "error" | "warning" | "info", frame: string, row: number, col: number | null, excerpt: string, step: string | null, ec: string }} Finding */

export const DETECTORS = Object.freeze({
  control_leak: { severity: "error", ec: "EC-010/044/048", why: "terminal control bytes or a capability reply rendered as text" },
  sgr_literal: { severity: "error", ec: "EC-049", why: "SGR parameters rendered as text (an escape lost its ESC)" },
  unmarked_truncation: { severity: "warning", ec: "EC-011/023/036/037/050", why: "content runs flush into a border or the edge with no ellipsis" },
  identifier_heading: { severity: "warning", ec: "EC-035", why: "a machine identifier shown where a title belongs" },
  impossible_range: { severity: "error", ec: "EC-043", why: "a paging range that cannot describe a real window" },
  bare_question_mark: { severity: "warning", ec: "EC-016", why: "an absence disclosed as ? — redacted and unknown share a glyph" },
  bare_empty_state: { severity: "info", ec: "EC-012", why: "an empty state naming no subject or cause" },
  stderr_smear: { severity: "error", ec: "EC-038", why: "a diagnostic written to the terminal while the screen was owned" },
  wrapped_row: { severity: "warning", ec: "EC-040", why: "a row ran past the terminal width and wrapped" },
  no_frame_change: { severity: "info", ec: "EC-024/026", why: "an input step produced no new frame (silent no-op, or nothing to change)" },
  residue: { severity: "warning", ec: "EC-019/030", why: "an isolated glyph survived at the same cell across a screen change" },
  dead_space: { severity: "info", ec: "EC-001", why: "the pane interior is mostly blank" },
  unprompted_screen_change: { severity: "error", ec: "EC-056", why: "the screen caption changed during a step that sent no input (a terminal reply decoded as keystrokes, or a spontaneous navigation)" },
});

const IDENTIFIER = /^[a-z]+(?:\.[a-z_]+)+$/u;
const EMPTY_STATE = /^\(?no [a-z][a-z ]{1,40}\)?$/iu;

function stripBorders(line) { return line.replace(/^[│┃║ ]+|[│┃║ ]+$/gu, ""); }

/** Split a padded row into segments between vertical border cells, with their start columns. */
function segments(padded) {
  const out = [];
  let start = 0;
  for (let i = 0; i <= padded.length; i++) {
    const ch = padded[i];
    if (i === padded.length || BORDER.has(ch)) {
      if (i > start) out.push({ start, end: i, text: padded.slice(start, i), borderAfter: i < padded.length });
      start = i + 1;
    }
  }
  return out;
}

/**
 * @param {{ name: string, lines: string[], cols: number, rows: number, step?: string|null }} frame
 * @param {{ prev?: { lines: string[] } | null, stepChanged?: boolean }} context
 * @returns {Finding[]}
 */
export function lintFrame(frame, { prev = null } = {}) {
  const findings = [];
  const add = (detector, row, col, excerpt) => findings.push({ detector, severity: DETECTORS[detector].severity, ec: DETECTORS[detector].ec, frame: frame.name, row, col, excerpt: excerpt.slice(0, 120), step: frame.step ?? null });
  const padded = frame.lines.map((l) => l.padEnd(frame.cols));
  const crashScreen = frame.lines.some((l) => /revoy2 crashed/u.test(l));
  const diagnosticScreen = frame.lines.some((l) => /^[│ ]*Diagnostics\b/u.test(l));

  frame.lines.forEach((line, row) => {
    if (line.includes(ESC) || /\[\?\d+[hl]|\bP>\||tmux \d\.\d|USERINPUT|\u009b/u.test(line)) add("control_leak", row, null, line);
    if (/\[\d+(?:;\d+)*m/u.test(line) && !crashScreen) add("sgr_literal", row, line.search(/\[\d+(?:;\d+)*m/u), line);
    if (/\[tui\]/u.test(line) && !crashScreen && !diagnosticScreen) add("stderr_smear", row, line.indexOf("[tui]"), line);
    for (const m of line.matchAll(/(\d+)-(\d+) of (\d+)/gu)) {
      const [first, last, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if ((total > 0 && first === 0) || first > last || last > total) add("impossible_range", row, m.index, m[0]);
    }
    if (/(?:^|\s)\?\s*→|→\s*\?(?:\s|$)/u.test(line)) add("bare_question_mark", row, line.indexOf("?"), line);
    const inner = stripBorders(line).trim();
    if (IDENTIFIER.test(inner) && row < 4) add("identifier_heading", row, null, inner);
    if (EMPTY_STATE.test(inner)) {
      const next = stripBorders(frame.lines[row + 1] ?? "").trim();
      if (next === "" || /^[─╌┌└]/u.test(next)) add("bare_empty_state", row, null, inner);
    }
    // Flush truncation: a word character directly against a border or the
    // terminal edge, with the segment otherwise having room to mark a cut.
    for (const seg of segments(padded[row])) {
      const text = seg.text;
      const lastNonSpace = text.replace(/\s+$/u, "");
      if (lastNonSpace.length !== text.length) continue; // has trailing room: not flush
      if (!/[A-Za-z0-9]$/u.test(text)) continue;
      if (!seg.borderAfter && seg.end < frame.cols) continue; // ends before the edge without a border: fine
      if (text.trim().length < 12) continue; // short cells (numbers, ids by design) are noise
      if (text.includes("…")) continue; // the row was laid out with a marked cut already; a flush tail after it is the layout filling its width
      // The pane header's STATUS block is right-aligned by design and ends
      // with the tree ratio, its final fact; flush against the border is its
      // layout, not a cut (sweep 2, every geometry, populated seed).
      if (/tree \d+:\d+$/u.test(text.trim())) continue;
      // A flush row whose next row continues the same segment is a WRAP at a
      // word boundary, not a cut (the crash message and the fact strip wrap).
      const nextSeg = segments(padded[row + 1] ?? "").find((n) => n.start === seg.start);
      if (nextSeg && nextSeg.text.trim() !== "" && !/^[┌└─╌]/u.test(nextSeg.text.trim())) continue;
      add("unmarked_truncation", row, seg.end - 1, text.slice(-40));
    }
    // A wrapped row: this row is flush to the edge and the next begins at col 0 with a word char.
    if (padded[row].length >= frame.cols && /[A-Za-z0-9]$/u.test(padded[row]) && /^[A-Za-z0-9]/u.test(frame.lines[row + 1] ?? "")) add("wrapped_row", row, frame.cols - 1, line.slice(-40));
  });

  // Residue across a screen change: an isolated glyph at the same cell in
  // both frames, where the surrounding row content differs.
  // Row 0 is the constant pane title; row 1 carries the screen caption, so it is the screen-change signal.
  if (prev && (prev.lines[1] ?? "") !== (frame.lines[1] ?? "")) {
    const prevPadded = prev.lines.map((l) => l.padEnd(frame.cols));
    for (let row = 1; row < frame.rows - 2; row++) {
      const cur = padded[row], before = prevPadded[row] ?? "";
      if (cur === before) continue;
      if (cur.includes("❯")) continue; // composer text legitimately persists across screens
      if (/^[│ ]*›?\s*\[(?:command|screen|workflow|theme)\]/u.test(cur)) continue; // a palette row's one-letter key column
      for (let col = 1; col < frame.cols - 1; col++) {
        const ch = cur[col];
        if (!ch || ch === " " || BORDER.has(ch) || GLYPHS_OK_ALONE.has(ch)) continue;
        if (/^[aAI0-9\[\](){}<>|\-—–:;,.]$/u.test(ch)) continue; // one-letter words, counts and list punctuation are not residue
        if (cur[col - 1] !== " " || cur[col + 1] !== " ") continue;
        if (before[col] !== ch) continue;
        add("residue", row, col, `${ch} at ${row}:${col} survived from the previous screen`);
      }
    }
  }

  // Dead space: interior rows that are entirely blank, as a fraction of the interior.
  const interior = padded.slice(1, -2).map((l) => stripBorders(l).trim());
  if (interior.length >= 10) {
    const blank = interior.filter((l) => l === "").length;
    const ratio = blank / interior.length;
    if (ratio > 0.75) add("dead_space", 1, null, `${Math.round(ratio * 100)}% of ${interior.length} interior rows are blank`);
  }
  return findings;
}

/** Lint every frame of a pilot run (or a bare frames directory). */
export function lintRun(dir) {
  const runDir = resolve(dir);
  const framesDir = existsSync(join(runDir, "frames")) ? join(runDir, "frames") : runDir;
  const receipt = existsSync(join(runDir, "receipt.json")) ? JSON.parse(readFileSync(join(runDir, "receipt.json"), "utf8")) : null;
  const stepByFrame = new Map((receipt?.frames ?? []).map((f) => [basename(f.file), f.step]));
  const files = readdirSync(framesDir).filter((f) => f.endsWith(".txt")).sort();
  const findings = [];
  let prev = null;
  for (const file of files) {
    const name = file.replace(/\.txt$/u, "");
    const lines = readFileSync(join(framesDir, file), "utf8").replace(/\n$/u, "").split("\n");
    const meta = existsSync(join(framesDir, `${name}.json`)) ? JSON.parse(readFileSync(join(framesDir, `${name}.json`), "utf8")) : { cols: Math.max(...lines.map((l) => l.length)), rows: lines.length };
    const frame = { name, lines, cols: meta.cols, rows: meta.rows, step: stepByFrame.get(name) ?? null };
    findings.push(...lintFrame(frame, { prev }));
    prev = frame;
  }
  // Unprompted navigation: the caption row changed inside a step that sent
  // nothing (a wait_for or a bare hold). The 240x70 operator-forms run
  // walked Compaction -> Surveillance -> Diff Review on its own: the bytes of
  // a cursor-position reply `ESC[70;240R` decoded as `[`, `;`, `R` (EC-056).
  const frameLines = new Map();
  for (const file of files) frameLines.set(file.replace(/\.txt$/u, ""), readFileSync(join(framesDir, file), "utf8").split("\n"));
  const frameName = (i) => `f${String(i).padStart(4, "0")}`;
  const inputStep = (step) => step.actions.some((a) => a.key !== undefined || a.type !== undefined || a.keys !== undefined || a.raw !== undefined || a.resize !== undefined);
  const steps = receipt?.steps ?? [];
  for (const [i, step] of steps.entries()) {
    if (inputStep(step)) continue;
    // A wait right after an input is that input's consequence (Enter, then "planning acknowledged").
    if (i > 0 && inputStep(steps[i - 1])) continue;
    for (let i = Math.max(1, step.frame_start); i < step.frame_end; i++) {
      const prevRow = stripBorders(frameLines.get(frameName(i - 1))?.[1] ?? "").trim(), row = stripBorders(frameLines.get(frameName(i))?.[1] ?? "").trim();
      // Startup settling — blank, STARTING, or the Console's pending caption hydrating into a variant — is not navigation.
      // Planning → main Console is lifecycle progression on the same screen, not navigation.
      if (prevRow === "" || /Initializing native runtime|revoy2 {1,2}\/ {1,2}STARTING|revoy2 console — |Planning your request|Stopping your request/u.test(prevRow) || row === "") continue;
      // A screen's identity is its caption's first segment; the rest is live state
      // (STATUS · Delegating -> Needs attention on the same Console is not navigation).
      const identity = (caption) => caption.split(" · ")[0].replace(/\s*\(.*$/u, "").trim();
      if (identity(prevRow) !== identity(row)) findings.push({ detector: "unprompted_screen_change", severity: "error", ec: DETECTORS.unprompted_screen_change.ec, frame: frameName(i), row: 1, col: null, excerpt: `${prevRow.trim().slice(0, 40)} -> ${row.trim().slice(0, 40)} during "${step.label}" with no input`, step: step.label });
    }
  }
  // Silent no-op: an input step that produced no new frame.
  for (const step of receipt?.steps ?? []) {
    const acted = step.actions.some((a) => a.key !== undefined || a.type !== undefined || a.keys !== undefined || a.raw !== undefined);
    if (acted && step.frame_end === step.frame_start) findings.push({ detector: "no_frame_change", severity: "info", ec: DETECTORS.no_frame_change.ec, frame: `f${String(Math.max(0, step.frame_start - 1)).padStart(4, "0")}`, row: 0, col: null, excerpt: `step ${step.index} "${step.label}" produced no new frame`, step: step.label });
  }
  const summary = {};
  for (const f of findings) summary[f.detector] = (summary[f.detector] ?? 0) + 1;
  if (existsSync(runDir) && framesDir !== runDir) writeFileSync(join(runDir, "findings.jsonl"), findings.map((f) => JSON.stringify(f)).join("\n") + (findings.length ? "\n" : ""), "utf8");
  return { findings, summary, frames: files.length };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) { console.error("usage: lint-frames.mjs <run-dir|frames-dir> [--json] [--fail-on det,det]"); process.exit(2); }
  const failOn = new Set((args[args.indexOf("--fail-on") + 1] ?? "").split(",").filter(Boolean));
  const result = lintRun(dir);
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[lint] ${result.frames} frames, ${result.findings.length} findings`);
    for (const [det, n] of Object.entries(result.summary).sort()) console.log(`  ${det.padEnd(22)} ${String(n).padStart(4)}  ${DETECTORS[det].severity.padEnd(7)} ${DETECTORS[det].ec}`);
    for (const f of result.findings.filter((f) => f.severity !== "info").slice(0, 40)) console.log(`  ${f.frame} r${f.row}${f.col === null ? "" : `c${f.col}`} ${f.detector}: ${f.excerpt}`);
  }
  if ([...failOn].some((d) => result.summary[d])) process.exit(1);
}
