#!/usr/bin/env bun
/**
 * Contact sheets: one image per six moments, so an eye-review reads six
 * screens per image instead of one, and each tile carries the step that
 * produced it and any lint finding on it.
 *
 * Frames are already deduplicated to moments at capture (pilot.mjs). This
 * tiles their PNGs with ImageMagick `montage`, burns a label under each tile
 * (frame id, step label, lint summary), and writes `sheets/sheet-NN.png` plus
 * `sheets/index.json` into the run directory.
 *
 * The review checklist (six regions, in order) is written into the index so
 * the assessment template can cite it: pane header, main column, inspector
 * rail, notification band, status bar, composer. EC-026 was missed by reading
 * rows 2–6 only.
 *
 * Usage:
 *   bun scripts/tui-pilot/contact-sheet.mjs <run-dir> [--per-sheet 6] [--tile-width 960]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const REVIEW_REGIONS = Object.freeze(["pane header", "main column", "inspector rail", "notification band", "status bar", "composer"]);

export function buildContactSheets(runDir, { perSheet = 6, tileWidth = 960 } = {}) {
  const dir = resolve(runDir);
  const receipt = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
  const findings = existsSync(join(dir, "findings.jsonl"))
    ? readFileSync(join(dir, "findings.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const byFrame = new Map();
  for (const f of findings) { if (!byFrame.has(f.frame)) byFrame.set(f.frame, []); byFrame.get(f.frame).push(f); }
  const sheetsDir = join(dir, "sheets");
  mkdirSync(sheetsDir, { recursive: true });
  const frames = receipt.frames.filter((f) => f.png);
  const sheets = [];
  for (let i = 0; i < frames.length; i += perSheet) {
    const group = frames.slice(i, i + perSheet);
    const index = sheets.length;
    const out = join(sheetsDir, `sheet-${String(index).padStart(2, "0")}.png`);
    const args = ["montage"];
    for (const f of group) {
      const id = f.file.split("/").pop();
      const lint = (byFrame.get(id) ?? []).filter((x) => x.severity !== "info");
      const lintLabel = lint.length === 0 ? "lint: clean" : `lint: ${[...new Set(lint.map((x) => x.detector))].join(", ")}`;
      const label = `${id}  +${(f.elapsed_ms / 1000).toFixed(1)}s  ${f.step ?? "startup"}\n${lintLabel}`;
      args.push("-label", label, join(dir, `${f.file}.png`));
    }
    args.push("-tile", "2x3", "-geometry", `${tileWidth}x+8+8`, "-background", "#101418", "-fill", "#d9e3e8", "-font", "DejaVu-Sans-Mono", "-pointsize", "14", out);
    const result = spawnSync("magick", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`montage failed for ${out}: ${result.stderr}`);
    sheets.push({ sheet: `sheets/sheet-${String(index).padStart(2, "0")}.png`, frames: group.map((f) => f.file.split("/").pop()), findings: group.map((f) => (byFrame.get(f.file.split("/").pop()) ?? []).length) });
  }
  const index = { kind: "revoy2.tui_pilot_contact_sheets", scenario: receipt.scenario.id, geometry: receipt.geometry, renderer: receipt.renderer, sheets, review_regions: REVIEW_REGIONS, moments: frames.length };
  writeFileSync(join(sheetsDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) { console.error("usage: contact-sheet.mjs <run-dir> [--per-sheet 6] [--tile-width 960]"); process.exit(2); }
  const num = (flag, d) => { const i = args.indexOf(flag); return i < 0 ? d : Number(args[i + 1]); };
  const index = buildContactSheets(dir, { perSheet: num("--per-sheet", 6), tileWidth: num("--tile-width", 960) });
  console.log(`[sheets] ${index.moments} moments -> ${index.sheets.length} sheet(s) in ${resolve(dir, "sheets")}`);
}
