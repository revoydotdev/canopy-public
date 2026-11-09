#!/usr/bin/env bun
/**
 * Record a real Console reel: drive `arbor tui` in a live pseudo-terminal with
 * scripted keystrokes, capture every frame, and assemble a video plus a decile
 * frame set for review.
 *
 * WHAT MAKES THIS A RECORDING AND NOT A MOCK-UP. Every frame is a real
 * `tmux capture-pane` of the real launchable CLI attached to a real pty, driven
 * by real `tmux send-keys`. Nothing here composes a screen, replays a fixture,
 * or edits a captured frame. If the product stalls or errors, the stall or the
 * error is what gets recorded — which is the only way the reel can be evidence
 * rather than an illustration.
 *
 * Each scripted step may declare a `wait_for` precondition that must appear on
 * the real screen before the next keystroke is sent, so the reel never types
 * into a surface that is not ready, and a missed precondition is recorded as an
 * explicit timeout in the receipt rather than silently skipped.
 *
 * Usage:
 *   bun scripts/record-console-reel.mjs --project <dir> --out <dir> --script <file>
 *     [--columns 140] [--rows 44] [--seconds 900] [--interval-ms 1000] [--fps 8]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Built at runtime rather than written as literal escape bytes in source, the
// same convention theme.ts follows.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_8BIT = String.fromCharCode(155);
const ANSI = new RegExp(
  `[${ESC}${CSI_8BIT}](?:\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)|[\\[\\]()#;?]*(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?${BEL}|(?:(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])))`,
  "g",
);

const arg = (flag, fallback = null) => { const i = process.argv.indexOf(flag); return i < 0 ? fallback : (process.argv[i + 1] ?? null); };
const num = (flag, fallback) => { const v = arg(flag); return v === null ? fallback : Number(v); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
const clean = (t) => t.replace(ANSI, "").replaceAll("\r", "").split("\n").map((l) => l.replace(/[ \t]+$/gu, "")).join("\n");
const sha256 = (t) => createHash("sha256").update(t).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(m) { console.error(`record-console-reel: ${m}`); process.exit(1); }

/** Pure argv builders for the two new step kinds — exported so their exact
 * tmux invocations are unit-testable without spawning a real session. */
export function resizeArgs(session, columns, rows) {
  return ["resize-window", "-t", session, "-x", String(columns), "-y", String(rows)];
}

/** `paste-buffer -p` sends the buffer through tmux's bracketed-paste path
 * (real bracketed paste to the attached application), not simulated
 * keystrokes. The buffer is loaded from a real file (`tmpFile`) rather than
 * stdin, so it works identically across tmux versions. */
export function pasteCommandPlan(session, bufferName, tmpFile) {
  return {
    loadArgs: ["load-buffer", "-b", bufferName, tmpFile],
    pasteArgs: ["paste-buffer", "-p", "-d", "-b", bufferName, "-t", session],
  };
}

// Everything below actually spawns tmux/ffmpeg/magick and records a reel; it
// only runs when this file is executed directly (`bun scripts/record-console-reel.mjs`),
// not when imported for its pure helper functions (see scripts/tests/).
if (import.meta.main) {
const PROJECT = resolve(arg("--project") ?? fail("--project is required"));
const OUT = resolve(arg("--out") ?? fail("--out is required"));
const SCRIPT_PATH = resolve(arg("--script") ?? fail("--script is required"));
const COLUMNS = num("--columns", 140);
const ROWS = num("--rows", 44);
const MAX_SECONDS = num("--seconds", 900);
const INTERVAL = num("--interval-ms", 1000);
const FPS = num("--fps", 8);
const SESSION = `reel-${process.pid}`;
const REPO = process.cwd();

const framesDir = join(OUT, "frames-raw");
mkdirSync(framesDir, { recursive: true });

const capture = () => sh("tmux", ["capture-pane", "-p", "-t", SESSION]).stdout ?? "";
const alive = () => sh("tmux", ["has-session", "-t", SESSION]).status === 0;
const sendLiteral = (text) => sh("tmux", ["send-keys", "-t", SESSION, "-l", text]);
// Keep scenario files readable with familiar aliases, but normalize at the
// tmux boundary so an alias such as `BS` cannot become literal user text.
// This is recorder transport normalization, not a second product input path.
const TMUX_KEY_ALIASES = Object.freeze({ ESC: "Escape", ENTER: "Enter", BS: "BSpace", TAB: "Tab", UP: "Up", DOWN: "Down", LEFT: "Left", RIGHT: "Right", HOME: "Home", END: "End" });
const sendKey = (key) => sh("tmux", ["send-keys", "-t", SESSION, TMUX_KEY_ALIASES[key] ?? key]);

const script = JSON.parse(readFileSync(SCRIPT_PATH, "utf8"));
const log = [];
let started = 0;
function note(kind, detail = "") {
  const entry = { at: new Date().toISOString(), elapsed_ms: Date.now() - started, kind, detail };
  log.push(entry);
  console.log(`[reel] ${entry.elapsed_ms}ms ${kind}${detail ? `: ${detail}` : ""}`);
}

sh("tmux", ["kill-session", "-t", SESSION]);
started = Date.now();
// `tui` accepts --resume / --persistence-dir / --renderer / notification flags
// (`tuimain` in packages/arbor-mcp/src/tui.ts). Hardcoding a bare `tui` meant
// every mode except the default was unreachable from a recording, so no reel
// could ever pilot a resumed session -- and a resumed session is the only way
// seeded durable state is visible, because the fresh-launch foreground filter
// hides work that predates the process.
const TUI_ARGS = (arg("--tui-args", "") ?? "").trim();
// `--launch` overrides the default `arbor-mcp.mjs tui` invocation with an
// arbitrary shell command (e.g. a different launchable driven by the same
// recorder plumbing, such as tui-demo-sim.ts). Omitted, behavior is
// unchanged from before this flag existed.
const LAUNCH_OVERRIDE = arg("--launch", null);
const launch = LAUNCH_OVERRIDE ?? `cd ${JSON.stringify(PROJECT)} && exec bun ${JSON.stringify(join(REPO, "packages/arbor-mcp/bin/arbor-mcp.mjs"))} tui${TUI_ARGS ? ` ${TUI_ARGS}` : ""}`;
sh("tmux", ["new-session", "-d", "-s", SESSION, "-x", String(COLUMNS), "-y", String(ROWS), launch]);
note("launch", `${COLUMNS}x${ROWS} in ${PROJECT}${LAUNCH_OVERRIDE ? ` [launch override]` : TUI_ARGS ? ` [tui ${TUI_ARGS}]` : ""}`);

let frameIndex = 0;
const frames = [];
function snap() {
  const text = clean(capture());
  const file = `f${String(frameIndex).padStart(5, "0")}.txt`;
  writeFileSync(join(framesDir, file), `${text}\n`, "utf8");
  frames.push({ index: frameIndex, file, elapsed_ms: Date.now() - started, sha256: sha256(text) });
  frameIndex += 1;
  return text;
}

async function waitFor(pattern, timeoutMs, label) {
  const re = new RegExp(pattern, "iu");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive()) { note("session-ended", label); return false; }
    if (re.test(snap())) { note("matched", `${label}`); return true; }
    await sleep(INTERVAL);
  }
  note("timeout", `${label} — never matched /${pattern}/`);
  return false;
}

for (const step of script.steps) {
  if (Date.now() - started > MAX_SECONDS * 1000) { note("budget-exhausted"); break; }
  if (!alive()) { note("session-gone"); break; }
  if (step.wait_for !== undefined) { await waitFor(step.wait_for, (step.timeout_s ?? 60) * 1000, step.label ?? step.wait_for); }
  if (step.type !== undefined) { note("type", step.label ?? step.type.slice(0, 48)); sendLiteral(step.type); }
  if (step.key !== undefined) { note("key", step.label ?? step.key); sendKey(step.key); }
  if (step.resize !== undefined) {
    const [columns, rows] = step.resize;
    note("resize", step.label ?? `${columns}x${rows}`);
    sh("tmux", resizeArgs(SESSION, columns, rows));
  }
  if (step.paste !== undefined) {
    note("paste", step.label ?? `${step.paste.split("\n").length} line(s)`);
    const bufferName = `reel-paste-${frameIndex}`;
    const tmpFile = join(OUT, `.paste-${frameIndex}.txt`);
    writeFileSync(tmpFile, step.paste, "utf8");
    const plan = pasteCommandPlan(SESSION, bufferName, tmpFile);
    sh("tmux", plan.loadArgs);
    sh("tmux", plan.pasteArgs);
  }
  if (step.hold_s) {
    note("hold", `${step.hold_s}s ${step.label ?? ""}`);
    const until = Date.now() + step.hold_s * 1000;
    while (Date.now() < until && alive()) { snap(); await sleep(INTERVAL); }
  }
}
if (alive()) snap();
note("captured", `${frames.length} frames`);

function renderPng(textPath, pngPath) {
  return sh("magick", [
    "-background", "#0e1116", "-fill", "#d9e3e8", "-font", "DejaVu-Sans-Mono", "-pointsize", "13",
    "-gravity", "northwest", "-size", `${COLUMNS * 8}x${ROWS * 18}`, `label:@${textPath}`, pngPath,
  ]);
}

const pngDir = join(OUT, "frames-png");
mkdirSync(pngDir, { recursive: true });
for (const f of frames) renderPng(join(framesDir, f.file), join(pngDir, f.file.replace(/\.txt$/u, ".png")));

const video = join(OUT, "console-reel.mp4");
const ff = sh("ffmpeg", ["-y", "-framerate", String(FPS), "-pattern_type", "glob",
  "-i", join(pngDir, "*.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
  "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", video]);
if (ff.status !== 0) note("ffmpeg-failed", (ff.stderr ?? "").slice(-600));

// One frame per 10% of the recording, both ends inclusive.
const decileDir = join(OUT, "frames-decile");
mkdirSync(decileDir, { recursive: true });
const deciles = [];
for (let percent = 0; percent <= 100; percent += 10) {
  const idx = frames.length === 0 ? -1 : Math.min(frames.length - 1, Math.round((percent / 100) * (frames.length - 1)));
  const src = frames[idx];
  if (!src) continue;
  const base = `p${String(percent).padStart(3, "0")}`;
  writeFileSync(join(decileDir, `${base}.txt`), readFileSync(join(framesDir, src.file)));
  renderPng(join(decileDir, `${base}.txt`), join(decileDir, `${base}.png`));
  deciles.push({ percent, frame_index: src.index, elapsed_ms: src.elapsed_ms, text: `${base}.txt`, png: `${base}.png`, sha256: src.sha256 });
}

writeFileSync(join(OUT, "receipt.json"), `${JSON.stringify({
  kind: "revoy2.console_reel",
  recorded_at: new Date().toISOString(),
  repo_revision: (sh("git", ["rev-parse", "HEAD"], { cwd: REPO }).stdout ?? "").trim(),
  project: PROJECT,
  geometry: { columns: COLUMNS, rows: ROWS },
  frame_interval_ms: INTERVAL,
  video_fps: FPS,
  frame_count: frames.length,
  duration_ms: frames.at(-1)?.elapsed_ms ?? 0,
  video: existsSync(video) ? "console-reel.mp4" : null,
  deciles,
  event_log: log,
}, null, 2)}\n`, "utf8");

sh("tmux", ["kill-session", "-t", SESSION]);
console.log(`[reel] wrote ${join(OUT, "receipt.json")}`);
}
