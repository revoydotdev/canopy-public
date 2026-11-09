#!/usr/bin/env bun
/** Publish a util-linux `script` raw/timing terminal recording without publishing its raw bytes. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSecretFree, publicationSecretPatternCodes } from "./lib/sizzle-redaction.mjs";
import { sha256Bytes, writeManifestAndChecksums } from "./lib/sizzle-manifest.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION = /^[a-f0-9]{40}$/i;
const SDA2 = "/mnt/sda2";
const WIDTH = 1920, HEIGHT = 1080, DEFAULT_FPS = 1, MIN_DURATION_MS = 120_000, MAX_FRAMES = 10_000;
const SCRIPT_PATH = realpathSync(fileURLToPath(import.meta.url));

function tool(command, args, options = {}) {
  const result = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: options.timeout ?? 60 * 60_000 });
  assertSecretFree(result, `${command} diagnostic output`);
  return result;
}
function sha(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function xml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function safeId(value, label) { if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a publication-safe identifier`); return value; }
export function validateOutputAncestor(path, rootPath = SDA2) {
  const requested = resolve(path), root = resolve(rootPath);
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) throw new Error("terminal recording output must remain under the configured root");
  let ancestor = requested;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("terminal recording output has no existing ancestor");
    ancestor = parent;
  }
  const canonicalRoot = realpathSync(root), canonicalAncestor = realpathSync(ancestor);
  if (canonicalAncestor !== canonicalRoot && !canonicalAncestor.startsWith(`${canonicalRoot}${sep}`)) throw new Error("terminal recording output ancestor resolves outside the configured root");
  return requested;
}
function safeOutput(path) {
  const requested = validateOutputAncestor(path);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const actual = realpathSync(requested), canonicalRoot = realpathSync(SDA2);
  if (actual !== canonicalRoot && !actual.startsWith(`${canonicalRoot}${sep}`)) throw new Error("terminal recording output resolved outside /mnt/sda2");
  return actual;
}

export function parseScriptTiming(text) {
  const rows = String(text).trim().split(/\r?\n/u).filter(Boolean);
  if (!rows.length) throw new Error("terminal timing is empty");
  let durationMs = 0, byteCount = 0;
  const entries = rows.map((line, index) => {
    const match = /^(\d+(?:\.\d+)?)\s+(\d+)$/u.exec(line.trim());
    if (!match) throw new Error(`terminal timing line ${index + 1} must contain delay and byte count`);
    const delayMs = Number(match[1]) * 1000, bytes = Number(match[2]);
    if (!Number.isFinite(delayMs) || delayMs < 0 || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`terminal timing line ${index + 1} is invalid`);
    durationMs += delayMs; byteCount += bytes;
    return Object.freeze({ delay_ms: delayMs, bytes });
  });
  if (!Number.isFinite(durationMs) || !Number.isSafeInteger(byteCount)) throw new Error("terminal timing exceeds publication bounds");
  return Object.freeze({ entries: Object.freeze(entries), duration_ms: durationMs, byte_count: byteCount });
}

function countMarker(bytes, marker) {
  let count = 0, offset = 0;
  while ((offset = bytes.indexOf(marker, offset)) >= 0) { count += 1; offset += marker.length; }
  return count;
}

/**
 * util-linux `script` may wrap the timed stream in an untimed header/footer.
 * The timing file attests only to the interior output bytes. Accept that form
 * only when both wrappers are exact, singular, and consume every remaining
 * byte; otherwise treat a count mismatch as tampering or an unknown format.
 */
export function normalizeScriptRaw(rawBytes, timing) {
  if (timing.byte_count === rawBytes.length) return Object.freeze({ timed_bytes: rawBytes, wrapper: Object.freeze({ kind: "none", start_bytes: 0, footer_bytes: 0, raw_bytes: rawBytes.length, timed_bytes: rawBytes.length }) });
  const startMarker = Buffer.from("Script started on "), footerMarker = Buffer.from("Script done on ");
  if (countMarker(rawBytes, startMarker) !== 1 || countMarker(rawBytes, footerMarker) !== 1) throw new Error("terminal timing/raw mismatch has missing or ambiguous util-linux script wrappers");
  const startEnd = rawBytes.indexOf(0x0a);
  if (startEnd < 0) throw new Error("util-linux script start wrapper is not newline-terminated");
  const startBytes = rawBytes.subarray(0, startEnd + 1), start = startBytes.toString("utf8");
  // util-linux writes COMMAND verbatim and does not escape embedded double
  // quotes (for example the JSON in `--verify-json '["cargo","test"]'`).
  // Anchor from the exact trailing terminal fields instead of pretending the
  // discarded COMMAND value follows an escaped quoted-string grammar.
  const terminalStart = /^Script started on [^\r\n]+ \[COMMAND="[^\r\n]*" TERM="(?:[^"\\\r\n]|\\["\\])*" TTY="(?:[^"\\\r\n]|\\["\\])*" COLUMNS="\d+" LINES="\d+"\]\r?\n$/u;
  const headlessStart = /^Script started on [^\r\n]+ \[COMMAND="[^\r\n]*" <not executed on terminal>\]\r?\n$/u;
  if (!terminalStart.test(start) && !headlessStart.test(start)) throw new Error("util-linux script start wrapper is malformed");
  if (rawBytes.at(-1) !== 0x0a) throw new Error("util-linux script done wrapper is not newline-terminated");
  const footerMarkerStart = rawBytes.indexOf(footerMarker);
  if (footerMarkerStart <= startBytes.length || rawBytes[footerMarkerStart - 1] !== 0x0a) throw new Error("util-linux script done wrapper is not a final line after timed interior");
  const footerStart = rawBytes[footerMarkerStart - 2] === 0x0d ? footerMarkerStart - 2 : footerMarkerStart - 1;
  const footerBytes = rawBytes.subarray(footerStart), footer = footerBytes.toString("utf8");
  if (!/^\r?\nScript done on [^\r\n]+ \[COMMAND_EXIT_CODE="\d+"\]\r?\n$/u.test(footer)) throw new Error("util-linux script done wrapper is malformed");
  const interior = rawBytes.subarray(startBytes.length, footerStart);
  if (timing.byte_count !== interior.length) throw new Error(`terminal timing attests to ${timing.byte_count} bytes but wrapped interior contains ${interior.length}`);
  return Object.freeze({ timed_bytes: interior, wrapper: Object.freeze({ kind: "util_linux_script", start_bytes: startBytes.length, footer_bytes: footerBytes.length, raw_bytes: rawBytes.length, timed_bytes: interior.length }) });
}

class TerminalGrid {
  constructor(columns = 120, rows = 42) { this.columns = columns; this.rows = rows; this.lines = Array.from({ length: rows }, () => Array(columns).fill(" ")); this.row = 0; this.column = 0; this.saved = [0, 0]; this.carry = ""; }
  clear() { this.lines = Array.from({ length: this.rows }, () => Array(this.columns).fill(" ")); this.row = 0; this.column = 0; }
  scroll() { this.lines.shift(); this.lines.push(Array(this.columns).fill(" ")); this.row = this.rows - 1; }
  linefeed() { this.row += 1; if (this.row >= this.rows) this.scroll(); }
  csi(params, final) {
    const numbers = params.replace(/^\?/u, "").split(";").map((part) => Number(part || "0"));
    const count = (index = 0, fallback = 1) => numbers[index] || fallback;
    if (final === "H" || final === "f") { this.row = Math.max(0, Math.min(this.rows - 1, count(0) - 1)); this.column = Math.max(0, Math.min(this.columns - 1, count(1) - 1)); }
    else if (final === "A") this.row = Math.max(0, this.row - count());
    else if (final === "B") this.row = Math.min(this.rows - 1, this.row + count());
    else if (final === "C") this.column = Math.min(this.columns - 1, this.column + count());
    else if (final === "D") this.column = Math.max(0, this.column - count());
    else if (final === "G") this.column = Math.max(0, Math.min(this.columns - 1, count() - 1));
    else if (final === "J" && (numbers[0] === 2 || numbers[0] === 3)) this.clear();
    else if (final === "K") { const start = numbers[0] === 1 ? 0 : this.column, end = numbers[0] === 1 ? this.column : this.columns; for (let column = start; column < end; column += 1) this.lines[this.row][column] = " "; }
    else if (final === "s") this.saved = [this.row, this.column];
    else if (final === "u") [this.row, this.column] = this.saved;
    else if ((final === "h" || final === "l") && params.includes("1049")) this.clear();
  }
  write(text, final = false) {
    const input = this.carry + text;
    this.carry = "";
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (char === "\u001b") {
        if (index + 1 >= input.length) { this.carry = input.slice(index); break; }
        if (input[index + 1] === "[") {
          let end = index + 2;
          while (end < input.length && !/[\x40-\x7e]/u.test(input[end])) end += 1;
          if (end >= input.length) { this.carry = input.slice(index); break; }
          this.csi(input.slice(index + 2, end), input[end]); index = end;
        } else if (input[index + 1] === "]") {
          let end = index + 2;
          while (end < input.length && input[end] !== "\u0007" && !(input[end] === "\u001b" && input[end + 1] === "\\")) end += 1;
          if (end >= input.length) { this.carry = input.slice(index); break; }
          index = end + (input[end] === "\u001b" ? 1 : 0);
        } else index += 1;
        continue;
      }
      if (char === "\r") { this.column = 0; continue; }
      if (char === "\n") { this.linefeed(); continue; }
      if (char === "\b") { this.column = Math.max(0, this.column - 1); continue; }
      if (char === "\t") { this.column = Math.min(this.columns - 1, this.column + (8 - (this.column % 8))); continue; }
      if (char < " " || char === "\u007f") continue;
      this.lines[this.row][this.column] = char;
      this.column += 1;
      if (this.column >= this.columns) { this.column = 0; this.linefeed(); }
    }
    if (this.carry.length > 4096) throw new Error("terminal ANSI sequence exceeds the publication carry bound");
    if (final && this.carry) throw new Error("terminal recording ends with an incomplete ANSI sequence");
  }
  text() { return this.lines.map((line) => line.join("").replace(/\s+$/u, "")).join("\n").replace(/^\n+/u, ""); }
}

export function replayScriptRecording(rawBytes, timing, fps = DEFAULT_FPS) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 8) throw new Error("terminal replay fps must be an integer from 1 through 8");
  const normalized = normalizeScriptRaw(rawBytes, timing);
  if (timing.duration_ms < MIN_DURATION_MS) throw new Error("terminal recording is not minutes long");
  const interval = 1000 / fps, frames = [], terminal = new TerminalGrid(), decoder = new TextDecoder("utf-8");
  let offset = 0, elapsed = 0, next = 0;
  const snapshot = (at) => { const text = terminal.text(); assertSecretFree(text, `terminal frame at ${at}ms`); frames.push(Object.freeze({ at_ms: Math.round(at), text })); };
  for (const entry of timing.entries) {
    const arrival = elapsed + entry.delay_ms;
    while (next < arrival) { snapshot(next); next += interval; if (frames.length > MAX_FRAMES) throw new Error("terminal replay exceeds the publication frame bound"); }
    terminal.write(decoder.decode(normalized.timed_bytes.subarray(offset, offset + entry.bytes), { stream: true }));
    offset += entry.bytes; elapsed = arrival;
    while (next === elapsed) { snapshot(next); next += interval; }
  }
  terminal.write(decoder.decode(), true);
  if (!frames.length) snapshot(0);
  return Object.freeze({ frames: Object.freeze(frames), duration_ms: Math.round(timing.duration_ms), fps, wrapper: normalized.wrapper });
}

export function renderTerminalFrame(frame, { campaign_id, duration_ms }) {
  const lines = frame.text.split("\n").slice(-38);
  const body = lines.map((line, index) => `<text x="92" y="${196 + index * 20}" fill="#d8e8e1" font-family="'JetBrains Mono','IBM Plex Mono',monospace" font-size="14">${xml(line)}</text>`).join("");
  const progress = Math.min(1, frame.at_ms / duration_ms);
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><defs><radialGradient id="wash"><stop offset="0" stop-color="#173a35" stop-opacity=".34"/><stop offset="1" stop-color="#020504" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="#030605"/><ellipse cx="960" cy="430" rx="900" ry="500" fill="url(#wash)"/><text x="72" y="66" fill="#e6f2ed" font-family="Georgia,serif" font-size="24" letter-spacing="7">REVOY2</text><text x="72" y="96" fill="#77d7b5" font-family="monospace" font-size="13" letter-spacing="2">RECORDED TUI REPLAY / REAL TIMING / SECRET-SCANNED TEXT</text><text x="1848" y="66" text-anchor="end" fill="#718982" font-family="monospace" font-size="13">${xml(campaign_id)}</text><rect x="62" y="124" width="1796" height="852" rx="15" fill="#07100e" stroke="#294b43"/><g>${body}</g><rect x="62" y="1014" width="1796" height="2" fill="#12231f"/><rect x="62" y="1014" width="${(1796 * progress).toFixed(1)}" height="2" fill="#77d7b5"/><text x="62" y="1048" fill="#718982" font-family="monospace" font-size="13">CAPTURE CLOCK ${(frame.at_ms / 1000).toFixed(1)}s / ${(duration_ms / 1000).toFixed(1)}s</text></svg>`;
}

function validateGenerator(worktreePath, sourceRevision) {
  if (!REVISION.test(sourceRevision)) throw new Error("source revision must be an exact 40-character Git SHA");
  const worktree = realpathSync(resolve(worktreePath));
  const git = (args) => tool("git", ["-C", worktree, ...args]).trim();
  if (git(["status", "--porcelain"])) throw new Error("terminal publication requires a fully clean generator worktree");
  const generatorRevision = git(["rev-parse", "HEAD"]);
  if (!REVISION.test(generatorRevision)) throw new Error("generator worktree HEAD is not an exact 40-character Git SHA");
  const scriptRelative = relative(worktree, SCRIPT_PATH);
  if (!scriptRelative || scriptRelative === ".." || scriptRelative.startsWith(`..${sep}`)) throw new Error("executing terminal publication script is outside the generator worktree");
  const trackedScript = scriptRelative.split(sep).join("/");
  try { git(["ls-files", "--error-unmatch", "--", trackedScript]); git(["cat-file", "-e", `HEAD:${trackedScript}`]); } catch { throw new Error("executing terminal publication script is not tracked at generator HEAD"); }
  try { git(["cat-file", "-e", `${sourceRevision}^{commit}`]); } catch { throw new Error("source revision does not resolve to a commit in the generator repository"); }
  return Object.freeze({ generator_revision: generatorRevision.toLowerCase() });
}
function inspectVideo(path, codec, durationMs) {
  const probe = JSON.parse(tool("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height,pix_fmt", "-of", "json", path]));
  const video = probe.streams?.find((stream) => stream.codec_type === "video"), duration = Number(probe.format?.duration);
  if (!video || video.codec_name !== codec || video.width !== WIDTH || video.height !== HEIGHT || !(duration > 0) || Math.abs(duration * 1000 - durationMs) > 1_500) throw new Error(`${basename(path)} failed timing or media verification`);
  return probe;
}
function concatPlan(frames, durationMs, directory, campaignId) {
  const framePaths = [];
  for (const [index, frame] of frames.entries()) {
    const path = join(directory, `frame-${String(index).padStart(6, "0")}.svg`);
    writeFileSync(path, renderTerminalFrame(frame, { campaign_id: campaignId, duration_ms: durationMs }), { encoding: "utf8", flag: "wx" });
    framePaths.push(path);
  }
  const durations = frames.map((frame, index) => Math.max(0.001, ((frames[index + 1]?.at_ms ?? durationMs) - frame.at_ms) / 1000));
  const quote = (path) => path.replaceAll("'", "'\\''");
  const plan = frames.map((_, index) => `file '${quote(framePaths[index])}'\nduration ${durations[index].toFixed(6)}`).join("\n") + `\nfile '${quote(framePaths.at(-1))}'\n`;
  const path = join(directory, "frames.ffconcat"); writeFileSync(path, plan, { encoding: "utf8", flag: "wx" });
  return { path, frame_paths: framePaths, durations };
}

export function mp4EncoderArgs(planPath, durationMs, outputPath) {
  return ["-hide_banner", "-loglevel", "error", "-nostats", "-y", "-f", "concat", "-safe", "0", "-i", planPath, "-t", (durationMs / 1000).toFixed(3), "-vf", "fps=30,format=yuv420p", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-movflags", "+faststart", "-map_metadata", "-1", outputPath];
}
export function webmEncoderArgs(mp4Path, outputPath) {
  return ["-hide_banner", "-loglevel", "error", "-nostats", "-y", "-i", mp4Path, "-an", "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-row-mt", "1", "-cpu-used", "5", "-pix_fmt", "yuv420p", "-map_metadata", "-1", outputPath];
}

export function publishTerminalRecording({ raw_path, timing_path, campaign_id, source_revision, generator_worktree, output_directory, fps = DEFAULT_FPS }) {
  safeId(campaign_id, "campaign id");
  if (!raw_path || !timing_path || !generator_worktree || !output_directory) throw new Error("raw recording, timing, generator worktree, and output directory are required");
  const raw = readFileSync(resolve(raw_path)), timingText = readFileSync(resolve(timing_path), "utf8");
  assertSecretFree(raw.toString("utf8"), "terminal raw recording"); assertSecretFree(timingText, "terminal timing");
  const timing = parseScriptTiming(timingText), replay = replayScriptRecording(raw, timing, fps), generator = validateGenerator(generator_worktree, source_revision);
  for (const command of ["ffmpeg", "ffprobe"]) { try { tool(command, ["-version"]); } catch { throw new Error(`${command} is required for terminal publication`); } }
  const temporary = mkdtempSync(join(tmpdir(), "revoy2-terminal-publication-"));
  try {
    const framesDirectory = join(temporary, "frames"); mkdirSync(framesDirectory);
    const plan = concatPlan(replay.frames, replay.duration_ms, framesDirectory, campaign_id);
    const mp4 = join(temporary, "campaign-tui.mp4"), webm = join(temporary, "campaign-tui.webm");
    const mp4Log = tool("ffmpeg", mp4EncoderArgs(plan.path, replay.duration_ms, mp4));
    const webmLog = tool("ffmpeg", webmEncoderArgs(mp4, webm));
    const media = { mp4: inspectVideo(mp4, "h264", replay.duration_ms), webm: inspectVideo(webm, "vp9", replay.duration_ms) };
    const output = safeOutput(output_directory);
    if (existsSync(join(output, "manifest.json")) || existsSync(join(output, "SHA256SUMS")) || existsSync(join(output, ".incomplete"))) throw new Error("terminal publication output already contains a sealed or incomplete run");
    writeFileSync(join(output, ".incomplete"), "terminal recording publication is incomplete\n", { encoding: "utf8", flag: "wx" });
    const assets = [];
    try {
      const source = join(output, "source"), logs = join(output, "logs"); mkdirSync(source); mkdirSync(logs);
      const renderPlan = { schema_version: 1, campaign_id, source_duration_ms: replay.duration_ms, rendered_duration_ms: replay.duration_ms, timing: "real_time", sample_fps: replay.fps, frame_count: replay.frames.length, raw_original_sha256: sha256Bytes(raw), timing_sha256: sha256Bytes(Buffer.from(timingText)), wrapper: replay.wrapper, source_revision: source_revision.toLowerCase(), generator_revision: generator.generator_revision };
      const renderPlanPath = join(source, "render-plan.json"), privacyPath = join(output, "privacy-report.json");
      const privacy = { schema_version: 1, policy: "raw terminal recording is read only in memory; published media is generated from secret-scanned terminal text frames and requires visual review before external release", scanned_inputs: ["raw terminal recording", "timing file", "generated terminal text frames", "encoder diagnostics"], raw_recording_published: false, raw_original_sha256: renderPlan.raw_original_sha256, util_linux_wrapper: replay.wrapper, secret_scan_passed: true, visual_review_required: true, real_time_preserved: true, secret_pattern_codes: publicationSecretPatternCodes, findings: 0 };
      writeFileSync(renderPlanPath, `${JSON.stringify(renderPlan, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); writeFileSync(privacyPath, `${JSON.stringify(privacy, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      const mp4Path = join(output, "campaign-tui.mp4"), webmPath = join(output, "campaign-tui.webm"), mp4LogPath = join(logs, "ffmpeg-mp4.log"), webmLogPath = join(logs, "ffmpeg-webm.log");
      copyFileSync(mp4, mp4Path); copyFileSync(webm, webmPath); writeFileSync(mp4LogPath, mp4Log, { encoding: "utf8", flag: "wx" }); writeFileSync(webmLogPath, webmLog, { encoding: "utf8", flag: "wx" });
      assets.push(renderPlanPath, privacyPath, mp4Path, webmPath, mp4LogPath, webmLogPath);
      for (const asset of assets.filter((path) => !path.endsWith(".mp4") && !path.endsWith(".webm"))) assertSecretFree(readFileSync(asset, "utf8"), `public ${asset}`);
      const sealed = writeManifestAndChecksums(output, { schema_version: 1, product: "revoy2", artifact_kind: "real_time_terminal_campaign_recording", campaign_id, source_revision: source_revision.toLowerCase(), generator_revision: generator.generator_revision, source: { raw_original_sha256: renderPlan.raw_original_sha256, timing_sha256: renderPlan.timing_sha256, wrapper: replay.wrapper, duration_ms: replay.duration_ms, timing: "real_time" }, media, privacy }, assets);
      rmSync(join(output, ".incomplete"));
      return Object.freeze({ output_directory: output, mp4: mp4Path, webm: webmPath, manifest: sealed.manifest_path, checksums: sealed.checksums_path });
    } catch (error) { throw error; }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function option(args, name, fallback = undefined) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
if (import.meta.main) {
  try {
    const args = process.argv.slice(2), result = publishTerminalRecording({ raw_path: option(args, "--raw"), timing_path: option(args, "--timing"), campaign_id: option(args, "--campaign-id"), source_revision: option(args, "--source-revision"), generator_worktree: option(args, "--generator-worktree"), output_directory: option(args, "--out"), fps: Number(option(args, "--fps", String(DEFAULT_FPS))) });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
