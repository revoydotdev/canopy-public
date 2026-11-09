#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadFlightEvents, renderFlightFrames } from "./flight-control-replay.mjs";
import { assertSecretFree, publicationSecretPatternCodes, readSecretFreeTextFile } from "./lib/sizzle-redaction.mjs";
import { sha256Bytes, writeManifestAndChecksums } from "./lib/sizzle-manifest.mjs";

const DEFAULT_ROOT = "/mnt/sda2/revoy2/sizzle";
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tool(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: options.timeout ?? 20 * 60 * 1000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${(result.stderr || result.stdout).slice(-3000)}`);
  assertSecretFree(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, `${command} diagnostic output`);
  return Object.freeze({ stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
}

function commandExists(command) {
  const result = spawnSync(command, ["-version"], { encoding: "utf8", timeout: 10_000 });
  return !result.error && result.status === 0;
}

function ensureOutputRoot(outputRoot, requireSda2) {
  const root = resolve(outputRoot);
  if (requireSda2 && root !== "/mnt/sda2" && !root.startsWith(`/mnt/sda2${sep}`)) throw new Error("publication output must remain under /mnt/sda2");
  mkdirSync(root, { recursive: true });
  const actual = realpathSync(root);
  if (requireSda2 && actual !== "/mnt/sda2" && !actual.startsWith(`/mnt/sda2${sep}`)) throw new Error("publication output resolves outside /mnt/sda2");
  return actual;
}

function inspectVideo(path, expectedCodec) {
  const probe = tool("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=index,codec_name,codec_type,width,height,pix_fmt,r_frame_rate", "-of", "json", path]);
  const parsed = JSON.parse(probe.stdout);
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const duration = Number(parsed.format?.duration);
  if (!video || video.codec_name !== expectedCodec || video.width !== 1920 || video.height !== 1080 || !Number.isFinite(duration) || duration <= 0) throw new Error(`${basename(path)} failed media verification`);
  return Object.freeze(parsed);
}

function optionalSource(path, label) {
  if (!path) return null;
  return readSecretFreeTextFile(path, { label, max_bytes: 32 * 1024 * 1024 });
}

export function resolvePublicationSourceRevision(repositoryRoot = REPOSITORY_ROOT) {
  const revision = tool("git", ["-C", repositoryRoot, "rev-parse", "HEAD"]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("publication source revision is not an exact Git object id");
  const dirty = tool("git", ["-C", repositoryRoot, "status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  if (dirty.length > 0) throw new Error("publication source tree has tracked changes; commit them before sealing current-revision media");
  return revision;
}

export function recordSizzle(options) {
  if (!options?.events_path) throw new Error("events_path is required");
  const loaded = loadFlightEvents(options.events_path);
  const runId = options.run_id ?? loaded.events[0].run_id;
  if (!RUN_ID.test(runId) || runId !== loaded.events[0].run_id) throw new Error("run_id must be a safe identifier matching the ledger");
  const title = options.title ?? "CONCURRENT GOVERNED AGENTS";
  assertSecretFree(`${runId}\n${title}`, "publication identity", { reject_control_characters: true });
  const cast = optionalSource(options.cast_path, "terminal cast");
  const timing = optionalSource(options.timing_path, "terminal timing");
  if (!commandExists("ffmpeg") || !commandExists("ffprobe")) throw new Error("ffmpeg and ffprobe are required");
  const sourceRevision = resolvePublicationSourceRevision();

  const root = ensureOutputRoot(options.output_root ?? DEFAULT_ROOT, options.require_sda2 !== false);
  const runDirectory = join(root, runId);
  mkdirSync(runDirectory, { recursive: false });
  const incomplete = join(runDirectory, ".incomplete");
  writeFileSync(incomplete, "publication incomplete\n", { encoding: "utf8", flag: "wx" });
  const temporary = mkdtempSync(join(tmpdir(), "revoy2-sizzle-"));
  const assets = [];
  try {
    const framesDirectory = join(temporary, "frames");
    const plan = renderFlightFrames(loaded.events, framesDirectory, { title, seconds_per_event: options.seconds_per_event });
    const sourceDirectory = join(runDirectory, "source");
    const logDirectory = join(runDirectory, "logs");
    mkdirSync(sourceDirectory);
    mkdirSync(logDirectory);
    const eventsCopy = join(sourceDirectory, "flight-events.jsonl");
    writeFileSync(eventsCopy, loaded.source_text, { encoding: "utf8", flag: "wx" });
    assets.push(eventsCopy);
    if (cast) { const path = join(sourceDirectory, "terminal.typescript"); writeFileSync(path, cast.text, { encoding: "utf8", flag: "wx" }); assets.push(path); }
    if (timing) { const path = join(sourceDirectory, "terminal.timing"); writeFileSync(path, timing.text, { encoding: "utf8", flag: "wx" }); assets.push(path); }
    const publicPlan = { width: plan.width, height: plan.height, frames: plan.frames, seconds_per_event: plan.seconds_per_event, run_id: plan.run_id, ledger_tip: plan.ledger_tip };
    const publicPlanPath = join(sourceDirectory, "render-plan.json");
    writeFileSync(publicPlanPath, `${JSON.stringify(publicPlan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    assets.push(publicPlanPath);

    const master = join(runDirectory, "revoy2-flight-control-master.mkv");
    const mp4 = join(runDirectory, "revoy2-flight-control.mp4");
    const webm = join(runDirectory, "revoy2-flight-control.webm");
    const logs = [];
    logs.push(["master", tool("ffmpeg", ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", plan.concat_path, "-vf", "fps=30,format=yuv444p", "-an", "-c:v", "ffv1", "-level", "3", "-g", "1", master])]);
    logs.push(["mp4", tool("ffmpeg", ["-hide_banner", "-y", "-i", master, "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-map_metadata", "-1", mp4])]);
    logs.push(["webm", tool("ffmpeg", ["-hide_banner", "-y", "-i", master, "-an", "-c:v", "libvpx-vp9", "-crf", "28", "-b:v", "0", "-row-mt", "1", "-cpu-used", "2", "-pix_fmt", "yuv420p", "-map_metadata", "-1", webm], { timeout: 40 * 60 * 1000 })]);
    assets.push(master, mp4, webm);
    for (const [name, log] of logs) {
      const path = join(logDirectory, `ffmpeg-${name}.log`);
      const text = `${log.stdout}${log.stderr}`;
      assertSecretFree(text, `${name} encoder log`);
      writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
      assets.push(path);
    }

    const probes = Object.freeze({ master: inspectVideo(master, "ffv1"), mp4: inspectVideo(mp4, "h264"), webm: inspectVideo(webm, "vp9") });
    const privacy = Object.freeze({
      schema_version: 1,
      policy: "secret-free-by-construction; publication aborts rather than redacts matched material",
      scanned_inputs: Object.freeze(["flight-events.jsonl", ...(cast ? ["terminal.typescript"] : []), ...(timing ? ["terminal.timing"] : []), "generated SVG frames", "encoder diagnostics"]),
      secret_pattern_codes: publicationSecretPatternCodes,
      findings: 0,
      environment_captured: false,
      stdin_captured: false,
      provider_content_captured: false,
      binary_visual_review: "rendered exclusively from validated allowlisted event fields",
    });
    const privacyPath = join(runDirectory, "privacy-report.json");
    const privacyText = `${JSON.stringify(privacy, null, 2)}\n`;
    assertSecretFree(privacyText, "privacy report");
    writeFileSync(privacyPath, privacyText, { encoding: "utf8", flag: "wx" });
    assets.push(privacyPath);
    const claims = Object.fromEntries(loaded.events.map((event) => [event.event_id, { sequence: event.sequence, stage: event.stage, kind: event.kind, hash: event.hash }]));
    const manifest = Object.freeze({ schema_version: 1, product: "revoy2", artifact_kind: "flight_control_sizzle_reel", run_id: runId, title, generated_at: new Date().toISOString(), source_revision: sourceRevision, source_tree_clean: true, source: { event_count: loaded.events.length, ledger_tip: loaded.events.at(-1).hash, source_sha256: sha256Bytes(Buffer.from(loaded.source_text)) }, media: probes, claims });
    const completed = writeManifestAndChecksums(runDirectory, manifest, assets);
    rmSync(incomplete, { force: true });
    return Object.freeze({ run_directory: runDirectory, mp4, webm, master, manifest: completed.manifest_path, checksums: completed.checksums_path });
  } catch (error) {
    writeFileSync(join(runDirectory, "failure.txt"), "publication failed; inspect the invoking terminal for the fail-closed diagnostic\n", { encoding: "utf8", flag: "w" });
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function args(argv) {
  const value = (name, fallback = null) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
  const eventsPath = value("--events");
  if (!eventsPath) throw new Error("usage: bun scripts/sizzle-record.mjs --events <flight-events.jsonl> [--run-id <id>] [--title <text>] [--output-root </mnt/sda2/...>] [--cast <typescript>] [--timing <timing>] [--seconds-per-event 1.45]");
  return { events_path: eventsPath, run_id: value("--run-id"), title: value("--title", "CONCURRENT GOVERNED AGENTS"), output_root: value("--output-root", DEFAULT_ROOT), cast_path: value("--cast"), timing_path: value("--timing"), seconds_per_event: Number(value("--seconds-per-event", "1.45")) };
}

async function main() { process.stdout.write(`${JSON.stringify(recordSizzle(args(process.argv.slice(2))), null, 2)}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
