#!/usr/bin/env bun
/**
 * Capture two real tmux TUI frames at the narrow acceptance geometries.
 *
 * This is deliberately an explicit operator acceptance command, not a test:
 * native tests prove renderer invariants, while these receipts prove the
 * launchable CLI owns a real pseudo-terminal at the exact recorded size.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { assertSecretFree } from "./lib/sizzle-redaction.mjs";

const SIZES = Object.freeze([{ columns: 80, rows: 24 }, { columns: 120, rows: 40 }]);
const OUTPUT_ROOT = "/mnt/sda2/revoy2/exemplars";
const ANSI = /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\\\)|[\[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;

function fail(message) { throw new Error(`narrow TUI acceptance: ${message}`); }
function input(flag, fallback = null) { const index = process.argv.indexOf(flag); return index < 0 ? fallback : (process.argv[index + 1] ?? null); }
function contains(parent, child) { const value = relative(parent, child); return value === "" || (!value.startsWith("..") && !value.includes(`..${sep}`)); }
function command(name, args, cwd, timeout = 120_000) {
  const result = spawnSync(name, args, { cwd, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${name} ${args.join(" ")} failed: ${(result.stderr || result.stdout || result.error?.message || "unknown error").slice(-2_000)}`);
  return result.stdout;
}
function shellQuote(value) { return `'${value.replaceAll("'", `'\\''`)}'`; }
function clean(text) { return text.replace(ANSI, "").replaceAll("\r", "").split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n").replace(/\n+$/g, ""); }
function sha256(text) { return createHash("sha256").update(text).digest("hex"); }
function writeJson(path, value) { const temp = `${path}.tmp-${process.pid}`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); renameSync(temp, path); }
function renderPng(textPath, imagePath, size) {
  // ImageMagick lays out the captured cell text for human review. It is a
  // view of the real tmux capture, not a recreated/synthetic product screen.
  command("convert", ["-background", "#101418", "-fill", "#d9e3e8", "-font", "DejaVu-Sans-Mono", "-pointsize", "13", "-gravity", "northwest", "-size", `${size.columns * 9}x${size.rows * 19}`, `label:@${textPath}`, imagePath], process.cwd());
}
async function waitForFrame(session, expected) {
  const deadline = Date.now() + 12_000;
  let latest = "";
  while (Date.now() < deadline) {
    latest = command("tmux", ["capture-pane", "-p", "-e", "-t", `${session}:0.0`, "-S", "-"], process.cwd());
    if (expected.test(clean(latest))) return latest;
    await Bun.sleep(250);
  }
  fail(`timed out waiting for ${expected} in tmux session ${session}; last frame: ${clean(latest).slice(-500)}`);
}
async function openPaletteAndCapture(session) {
  const deadline = Date.now() + 12_000;
  let latest = "";
  // The boot skeleton intentionally paints before the runtime has finished
  // composing the interactive input path. Retry the real Ctrl+P gesture until
  // the palette is observable rather than treating a key sent during boot as
  // evidence that the terminal cannot route it.
  while (Date.now() < deadline) {
    command("tmux", ["send-keys", "-t", `${session}:0.0`, "C-p"], process.cwd());
    await Bun.sleep(750);
    latest = command("tmux", ["capture-pane", "-p", "-e", "-t", `${session}:0.0`, "-S", "-"], process.cwd());
    if (/command palette|help.*(palette|filter)|show the key-binding/i.test(clean(latest))) return latest;
  }
  fail(`timed out opening Ctrl+P palette in tmux session ${session}; last frame: ${clean(latest).slice(-500)}`);
}

const output = input("--out-dir");
if (output === null) fail("usage: acceptance:tui:narrow -- --out-dir /mnt/sda2/revoy2/exemplars/<run-id>");
const outputDir = resolve(output);
const allowedRoot = resolve(OUTPUT_ROOT);
if (!contains(allowedRoot, outputDir) || outputDir === allowedRoot) fail(`--out-dir must be a new child of ${OUTPUT_ROOT}`);
if (existsSync(outputDir)) fail(`refusing to overwrite existing acceptance directory ${outputDir}`);
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const cwd = process.cwd();
const runId = `narrow-${Date.now()}-${randomUUID().slice(0, 8)}`;
const receipt = { schema_version: 1, kind: "revoy2.narrow_tui_tmux_acceptance", run_id: runId, source_revision: command("git", ["rev-parse", "HEAD"], cwd).trim(), cwd, recorded_at: new Date().toISOString(), frames: [] };

try {
  for (const size of SIZES) {
    const label = `${size.columns}x${size.rows}`;
    const session = `revoy2-${runId}-${size.columns}`;
    const persistence = join(cwd, ".arbor", `narrow-acceptance-${runId}-${label}`);
    const launch = `cd ${shellQuote(cwd)} && exec bun packages/arbor-mcp/bin/arbor-mcp.mjs tui --renderer opentui --notification-mechanism off --persistence-dir ${shellQuote(persistence)}`;
    command("tmux", ["new-session", "-d", "-x", String(size.columns), "-y", String(size.rows), "-s", session, "bash", "-c", launch], cwd);
    try {
      const geometry = command("tmux", ["display-message", "-p", "-t", `${session}:0.0`, "#{pane_width}x#{pane_height}"], cwd).trim();
      if (geometry !== label) fail(`${session} reported ${geometry}, expected ${label}`);
      const bootAnsi = await waitForFrame(session, /revoy2|native cockpit|starting/i);
      const bootText = clean(bootAnsi);
      assertSecretFree(bootText, `${label} boot frame`);
      const bootBase = join(outputDir, `${label}-boot`);
      writeFileSync(`${bootBase}.ansi`, bootAnsi, "utf8");
      writeFileSync(`${bootBase}.txt`, `${bootText}\n`, "utf8");
      renderPng(`${bootBase}.txt`, `${bootBase}.png`, size);

      const paletteAnsi = await openPaletteAndCapture(session);
      const paletteText = clean(paletteAnsi);
      assertSecretFree(paletteText, `${label} palette frame`);
      const paletteBase = join(outputDir, `${label}-palette`);
      writeFileSync(`${paletteBase}.ansi`, paletteAnsi, "utf8");
      writeFileSync(`${paletteBase}.txt`, `${paletteText}\n`, "utf8");
      renderPng(`${paletteBase}.txt`, `${paletteBase}.png`, size);
      receipt.frames.push({ geometry, boot: { text: basename(`${bootBase}.txt`), ansi: basename(`${bootBase}.ansi`), png: basename(`${bootBase}.png`), sha256: sha256(bootText), secret_scan: "passed" }, palette: { text: basename(`${paletteBase}.txt`), ansi: basename(`${paletteBase}.ansi`), png: basename(`${paletteBase}.png`), sha256: sha256(paletteText), secret_scan: "passed" }, checks: { geometry_exact: true, launch_frame_observed: true, ctrl_p_palette_observed: true } });
    } finally {
      try { command("tmux", ["send-keys", "-t", `${session}:0.0`, "C-c"], cwd); } catch { /* process may already have exited */ }
      await Bun.sleep(250);
      spawnSync("tmux", ["kill-session", "-t", session], { cwd, encoding: "utf8" });
      rmSync(persistence, { recursive: true, force: true });
    }
  }
  receipt.ok = receipt.frames.length === SIZES.length && receipt.frames.every((frame) => frame.checks.geometry_exact && frame.checks.launch_frame_observed && frame.checks.ctrl_p_palette_observed);
  writeJson(join(outputDir, "receipt.json"), receipt);
  process.stdout.write(`${JSON.stringify({ ok: receipt.ok, output: outputDir, source_revision: receipt.source_revision, frames: receipt.frames.map((frame) => frame.geometry) }, null, 2)}\n`);
  process.exitCode = receipt.ok ? 0 : 1;
} catch (error) {
  writeJson(join(outputDir, "failure.json"), { ...receipt, ok: false, error: error instanceof Error ? error.message : String(error) });
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
