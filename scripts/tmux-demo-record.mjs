#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { assertSecretFree, publicationSecretPatternCodes } from "./lib/sizzle-redaction.mjs";
import { sha256Bytes, writeManifestAndChecksums } from "./lib/sizzle-manifest.mjs";

const WIDTH = 1920;
const HEIGHT = 1080;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const ANSI = /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\)|[\[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", timeout: options.timeout ?? 120_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allow_failure !== true) throw new Error(`${command} exited ${result.status}: ${(result.stderr || result.stdout).slice(-3000)}`);
  return result;
}

function toolExists(command, versionArgs) {
  const result = spawnSync(command, versionArgs, { encoding: "utf8", timeout: 10_000 });
  return !result.error && result.status === 0;
}

function ensureRoot(path) {
  const requested = resolve(path);
  if (requested !== "/mnt/sda2" && !requested.startsWith(`/mnt/sda2${sep}`)) throw new Error("tmux publication output must remain under /mnt/sda2");
  mkdirSync(requested, { recursive: true });
  const actual = realpathSync(requested);
  if (actual !== "/mnt/sda2" && !actual.startsWith(`/mnt/sda2${sep}`)) throw new Error("tmux publication output resolves outside /mnt/sda2");
  return actual;
}

function cleanPane(text, replacements) {
  let value = text.replace(ANSI, "").replaceAll("\r", "");
  for (const [from, to] of replacements) value = value.replaceAll(from, to);
  return value.split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n").replace(/\n+$/g, "");
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function lineColor(line, secondary) {
  if (/verified|claimed|approved|complete|loop\.node_(verified|claimed)|campaign\.changed/i.test(line)) return "#77d7b5";
  if (/failed|rejected|denied|error/i.test(line)) return "#ff8877";
  if (/critic|review/i.test(line)) return "#e8bc72";
  if (/specialist|dispatch|selected/i.test(line)) return "#82c7df";
  return secondary ? "#819a95" : "#c7d8d2";
}

function paneText(lines, x, y, width, secondary = false) {
  const maxChars = Math.max(20, Math.floor(width / 9.2));
  return lines.slice(0, 43).map((line, index) => {
    const cells = [...line];
    const visible = cells.length > maxChars ? `${cells.slice(0, maxChars - 1).join("")}…` : line;
    return `<text x="${x}" y="${y + index * 19}" fill="${lineColor(visible, secondary)}" class="terminal">${xml(visible || " ")}</text>`;
  }).join("");
}

export function renderTmuxFrame(frame, options = {}) {
  const left = frame.left.split("\n");
  const right = frame.right.split("\n");
  const progress = Math.min(1, Math.max(0, frame.at_ms / Math.max(1, options.duration_ms ?? frame.at_ms)));
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><defs><radialGradient id="wash"><stop offset="0" stop-color="#173a35" stop-opacity=".34"/><stop offset="1" stop-color="#020504" stop-opacity="0"/></radialGradient><filter id="glow"><feGaussianBlur stdDeviation="12"/></filter><clipPath id="left-panel-clip"><rect x="84" y="173" width="1216" height="781"/></clipPath><clipPath id="right-panel-clip"><rect x="1364" y="173" width="472" height="781"/></clipPath><style>.brand{font-family:Georgia,serif;font-size:22px;letter-spacing:7px}.meta{font-family:'JetBrains Mono','IBM Plex Mono',monospace;font-size:13px;letter-spacing:2px}.terminal{font-family:'JetBrains Mono','IBM Plex Mono',monospace;font-size:14px;white-space:pre}</style></defs><rect width="1920" height="1080" fill="#030605"/><ellipse cx="920" cy="450" rx="920" ry="520" fill="url(#wash)"/><text x="72" y="62" fill="#e6f2ed" class="brand">REVOY2</text><text x="72" y="88" fill="#718982" class="meta">LIVE GOVERNED OPERATOR COCKPIT / REAL TMUX SESSION</text><text x="1848" y="62" text-anchor="end" fill="#718982" class="meta">${xml(options.run_id ?? "capture")}</text><rect x="62" y="124" width="1260" height="852" rx="15" fill="#07100e" stroke="#294b43"/><rect x="1342" y="124" width="516" height="852" rx="15" fill="#060c0b" stroke="#273a36"/><text x="84" y="158" fill="#77d7b5" class="meta">TUI / CAMPAIGN CONTROL</text><text x="1364" y="158" fill="#e8bc72" class="meta">DURABLE DEVTOOLS STREAM</text><g clip-path="url(#left-panel-clip)">${paneText(left, 84, 192, 1216)}</g><g clip-path="url(#right-panel-clip)">${paneText(right, 1364, 192, 472, true)}</g><rect x="62" y="1014" width="1796" height="2" fill="#12231f"/><rect x="62" y="1014" width="${(1796 * progress).toFixed(1)}" height="2" fill="#77d7b5"/><text x="62" y="1048" fill="#718982" class="meta">TEXT-FRAME CAPTURE · SECRET-SCANNED · NO DESKTOP PIXELS · ${(frame.at_ms / 1000).toFixed(1)}s</text></svg>`;
}

function inspectVideo(path, codec) {
  const result = run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height,pix_fmt,r_frame_rate", "-of", "json", path]);
  const parsed = JSON.parse(result.stdout);
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  if (!video || video.codec_name !== codec || video.width !== WIDTH || video.height !== HEIGHT || Number(parsed.format?.duration) <= 0) throw new Error(`${basename(path)} failed media verification`);
  return parsed;
}

/**
 * The loop events a publishable capture must prove really happened, keyed by
 * the check name evaluateEvidence reports. The readiness gate waits for them
 * (via Object.values below) and the evidence summary re-checks them against
 * the whole log, so both read this one map -- never a second copy of the list.
 *
 * Each value is the set of event kinds that satisfies that requirement, not
 * always a single kind. packages/arbor-opencode/src/loop.ts (~line 2601)
 * emits exactly ONE of `loop.node_claimed` / `loop.node_verified` per node --
 * an if/else, never both -- choosing `verified` (the STRONGER outcome) once a
 * verification command is configured, `claimed` otherwise. A check that
 * required `claimed` specifically therefore failed the instant verification
 * worked: the harness performing BETTER made the proof MORE certain to fail
 * closed, confirmed empirically from two real runs (an unverified take showed
 * loop.node_claimed with zero node_verified; a verified take showed the exact
 * reverse). Either terminal-success kind satisfies the requirement here; a
 * failed or pruned node emits neither and the requirement still fails.
 */
export const REQUIRED_LOOP_EVENTS = Object.freeze({
  specialist_dispatch_observed: Object.freeze(["loop.specialist_dispatched"]),
  critic_dispatch_observed: Object.freeze(["loop.critic_dispatched"]),
  successful_node_observed: Object.freeze(["loop.node_claimed", "loop.node_verified"]),
});

/**
 * Evidence needs only the SHAPE of the frame set (count, distinct pane
 * states), never the pane text itself -- so the capture loop tracks these
 * as it goes (frame counters and sha256 sets, both O(distinct-states) not
 * O(frame-text)) instead of handing this function the accumulated frames.
 *
 * Never throws: this is also called mid-capture (checkLiveness, the failure
 * diagnostic) where "which checks are still pending" is exactly the
 * information needed, not an exception. summarizeEvidence below is the
 * fail-closed wrapper for the end-of-capture gate.
 */
export function evaluateEvidence(logPath, frameStats) {
  const records = existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((record) => record !== null)
    : [];
  const counts = {};
  let lastEventAtMs = null;
  for (const record of records) {
    counts[record.event_kind] = (counts[record.event_kind] ?? 0) + 1;
    const at = Date.parse(record.ts ?? "");
    if (Number.isFinite(at) && (lastEventAtMs === null || at > lastEventAtMs)) lastEventAtMs = at;
  }
  const checks = {
    tmux_session_captured: frameStats.frame_count > 1,
    live_pane_changed: frameStats.distinct_left_frames >= 2,
    devtools_stream_observed: records.length > 0,
  };
  for (const [name, kinds] of Object.entries(REQUIRED_LOOP_EVENTS)) checks[name] = kinds.some((kind) => (counts[kind] ?? 0) > 0);
  return {
    checks,
    record_count: records.length,
    event_kind_counts: counts,
    last_event_at: lastEventAtMs === null ? null : new Date(lastEventAtMs).toISOString(),
    distinct_left_frames: frameStats.distinct_left_frames,
    distinct_right_frames: frameStats.distinct_right_frames,
  };
}

function summarizeEvidence(logPath, frameStats) {
  const evidence = evaluateEvidence(logPath, frameStats);
  const failed = Object.entries(evidence.checks).filter(([, ok]) => !ok).map(([id]) => id);
  if (failed.length) throw new Error(`tmux empirical proof incomplete: ${failed.join(", ")}`);
  return { schema_version: 1, ...evidence };
}

/**
 * Assemble the tmux-capture.json body from already-serialized frame lines
 * read back off disk, in order -- never from an in-memory frame array. Each
 * line is the exact JSON this recorder wrote for that frame during capture,
 * so this is a textual splice, not a parse/re-stringify round trip.
 */
export function buildCaptureText(header, frameLines) {
  const headerJson = JSON.stringify(header, null, 2);
  const withoutClosingBrace = headerJson.replace(/\s*\}\s*$/, "");
  return `${withoutClosingBrace},\n  "frames": [\n${frameLines.map((line) => `    ${line}`).join(",\n")}\n  ]\n}\n`;
}

/** Read the frame records this capture wrote to disk, in capture order. */
export function readFrameLines(framesJsonlPath) {
  if (!existsSync(framesJsonlPath)) return [];
  return readFileSync(framesJsonlPath, "utf8").split("\n").filter(Boolean);
}

/**
 * Decide whether a pre-existing capture directory may be reused.
 *
 * A published exemplar is immutable: refuse to overwrite one. But a FAILED take
 * leaves a directory holding only the `.incomplete` marker and a failure.txt,
 * and that carcass blocked every retry of the same run id with a bare
 * `EEXIST: mkdir` -- an unactionable error for the one operation the operator is
 * certain to attempt next after a failed take. The marker this recorder writes
 * on entry and removes on success already answers "is this a real exemplar?",
 * so consult it: reclaim an incomplete take, never a complete one.
 */
/**
 * Release the selfhost worktree left behind by an abandoned take.
 *
 * The recorder pins the selfhost run id to its own run id so the evidence path
 * is derivable, and demo-window.sh passes --keep-worktree so the log survives
 * the run. Together those mean a retry of the same run id is GUARANTEED to hit
 * selfhost's identity-conflict refusal -- correct behaviour on selfhost's part,
 * but it made the second take of any run id impossible.
 *
 * The identity has TWO halves and selfhost refuses on either: the worktree
 * directory and the `arbor/selfhost/<run-id>` branch. Removing only the
 * directory moved the refusal from one half to the other rather than clearing
 * it, so both are released -- and the branch is checked for existence in its
 * own right, since a worktree removal that already succeeded leaves the branch
 * behind on its own.
 *
 * Only an abandoned take can own this identity: it is derived from this run id,
 * and reclaimOutputDirectory has already refused the call outright if a
 * COMPLETE capture exists for it. The id is charset-restricted at both ends, so
 * the path cannot escape .worktrees/.
 */
export function releaseAbandonedSelfhostWorktree(repoRoot, worktree, branch) {
  const branchExists = run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot, allow_failure: true }).status === 0;
  if (!existsSync(worktree) && !branchExists) return "absent";
  process.stderr.write(`[record] releasing the abandoned selfhost worktree at ${worktree}\n`);
  run("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot, allow_failure: true });
  run("git", ["worktree", "prune"], { cwd: repoRoot, allow_failure: true });
  run("git", ["branch", "-D", branch], { cwd: repoRoot, allow_failure: true });
  if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
  // Verify rather than assume. A previous take's campaign can still be tearing
  // down and recreate the path a moment after it is cleared, and the failure
  // that follows arrives from selfhost as an identity conflict that reads like
  // a stale worktree rather than the race it actually is.
  if (existsSync(worktree)) {
    throw new Error(`${worktree} reappeared after being released -- a previous campaign is probably still shutting down. Wait for it to exit, or pick a new --run-id.`);
  }
  return "released";
}

/**
 * True once the campaign has emitted the required loop.* events BELONGING TO
 * THIS CAPTURE (any loop.* event when no kinds are named).
 *
 * loop.* is runCampaign's own log hook, so it marks real work rather than the
 * setup that precedes it. The timestamp floor matters as much as the kind: an
 * earlier take's log at the same path would otherwise satisfy the gate with
 * events that had already happened, and the capture would open on a campaign
 * that was never running.
 *
 * WHY THE GATE WAITS FOR THE WHOLE SET. A specialist turn takes minutes; the
 * publication ceiling is 120 seconds and is not negotiable. A window opened at
 * campaign start therefore ends long before a critic is ever dispatched, and
 * films setup. Waiting until the run has demonstrably dispatched a specialist,
 * dispatched a critic and claimed a node, and only then filming, points the
 * capture at the cockpit while real governed work continues.
 *
 * This does not weaken the empirical proof by one inch. The same three events
 * are still required, they must still be real, and the timestamp floor still
 * ties them to this capture's own campaign. It changes only WHEN the camera
 * opens, not what has to be true for the recording to be publishable.
 */
export function hasFreshDispatch(logPath, startedAtMs, requiredKinds = null) {
  // Each requirement is EITHER a single event kind OR a list of alternative
  // kinds where any one satisfies it -- the latter for a step whose outcome
  // loop.ts reports as one of several mutually exclusive events (see
  // REQUIRED_LOOP_EVENTS above for why `node_claimed`/`node_verified` must be
  // treated as alternatives, not a single hardcoded kind).
  const outstanding = (requiredKinds ?? []).map((entry) => new Set(Array.isArray(entry) ? entry : [entry]));
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.includes('"loop.')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (typeof record.event_kind !== "string" || !record.event_kind.startsWith("loop.")) continue;
    const at = Date.parse(record.ts ?? "");
    if (!Number.isFinite(at) || at < startedAtMs) continue;
    if (outstanding.length === 0) return true;
    for (let index = outstanding.length - 1; index >= 0; index -= 1) {
      if (outstanding[index].has(record.event_kind)) outstanding.splice(index, 1);
    }
    if (outstanding.length === 0) return true;
  }
  // Reaching end-of-file without an early return means either there were no
  // requirements and no qualifying loop.* line was ever seen, or there were
  // requirements and at least one is still outstanding -- false either way.
  return false;
}

/**
 * Copy raw campaign evidence to a restrictive operator-local directory,
 * outside the publication output. A source is eligible for cleanup only after
 * its copy and permission hardening both succeed. Failed copies are reported
 * by stable labels and the original source is retained by recordTmuxDemo.
 */
export function preserveFailureEvidence(privateDirectory, publicationOutput, persistenceRoots, framesJsonlPath, copyTree = cpSync) {
  const parts = [];
  const paths = [];
  const failedSources = [];
  const preservedSourceRoots = [];
  let framesPreserved = false;
  mkdirSync(dirname(privateDirectory), { recursive: true, mode: 0o700 });
  const actualPrivateParent = realpathSync(dirname(privateDirectory));
  const actualPublicationOutput = realpathSync(publicationOutput);
  const privateCandidate = join(actualPrivateParent, basename(privateDirectory));
  try {
    if (lstatSync(privateCandidate).isSymbolicLink()) throw new Error("private failure evidence run directory must not be a symbolic link");
    throw new Error("private failure evidence run directory already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (pathIsWithin(actualPublicationOutput, privateCandidate)) throw new Error("private failure evidence resolves inside publication output");
  chmodSync(actualPrivateParent, 0o700);
  mkdirSync(privateCandidate, { mode: 0o700 });
  const createdStat = lstatSync(privateCandidate);
  if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) throw new Error("private failure evidence run directory must be a real directory");
  const actualPrivateDirectory = realpathSync(privateCandidate);
  if (pathIsWithin(actualPublicationOutput, actualPrivateDirectory)) throw new Error("private failure evidence resolves inside publication output");
  chmodSync(actualPrivateDirectory, 0o700);
  const roots = [...new Set(persistenceRoots.filter(Boolean))].filter(existsSync);
  const failedSourceLabels = [];
  for (const [index, persistence] of roots.entries()) {
    const name = index === 0 ? "campaign-ledger" : `campaign-ledger-${index + 1}`;
    const destination = join(actualPrivateDirectory, name);
    try {
      copyTree(persistence, destination, { recursive: true });
      securePrivateTree(destination);
      parts.push(`campaign ledger preserved as ${name}`);
      paths.push(name);
      preservedSourceRoots.push(persistence);
    } catch {
      try { if (existsSync(destination)) securePrivateTree(destination); } catch {}
      parts.push(`campaign ledger copy failed for ${name}; original source retained`);
      failedSources.push(persistence);
      failedSourceLabels.push(name);
    }
  }
  if (existsSync(framesJsonlPath)) {
    const destination = join(actualPrivateDirectory, "frames.jsonl");
    try {
      copyTree(framesJsonlPath, destination);
      securePrivateTree(destination);
      parts.push("captured frame records preserved as frames.jsonl");
      paths.push("frames.jsonl");
      framesPreserved = true;
    } catch {
      try { if (existsSync(destination)) securePrivateTree(destination); } catch {}
      parts.push("captured frame copy failed; original frame records retained");
    }
  }
  return Object.freeze({
    complete: failedSources.length === 0 && (!existsSync(framesJsonlPath) || framesPreserved),
    summary: parts.length ? parts.join("; ") : "no campaign persistence or frame records existed to preserve",
    paths: Object.freeze(paths),
    failed_sources: Object.freeze(failedSources),
    failed_source_labels: Object.freeze(failedSourceLabels),
    preserved_source_roots: Object.freeze(preservedSourceRoots),
    frames_preserved: framesPreserved,
    frame_source_retained: existsSync(framesJsonlPath) && !framesPreserved,
    frame_source_path: existsSync(framesJsonlPath) && !framesPreserved ? framesJsonlPath : null,
  });
}

function securePrivateTree(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("private evidence copy contains a symbolic link");
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) securePrivateTree(join(path, name));
    return;
  }
  if (!stat.isFile()) throw new Error("private evidence copy contains a non-regular file");
  chmodSync(path, 0o600);
}

function pathIsWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function privateEvidenceDirectory(options, publicationOutput, runId) {
  const privateRoot = resolve(options.private_evidence_root ?? join(homedir(), ".local", "state", "revoy2", "capture-failures"));
  const directory = join(privateRoot, runId);
  if (pathIsWithin(publicationOutput, directory)) throw new Error("private failure evidence must be outside publication output");
  return directory;
}

function ensurePrivateScratchRoot(privateEvidence, publicationOutput) {
  const directory = dirname(privateEvidence);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  const directoryParent = realpathSync(dirname(directory));
  const scratchCandidate = join(directoryParent, basename(directory));
  try {
    if (lstatSync(scratchCandidate).isSymbolicLink()) throw new Error("private scratch root must not be a symbolic link");
  } catch (error) {
    if (error?.code === "ENOENT") mkdirSync(scratchCandidate, { mode: 0o700 });
    else throw error;
  }
  const scratchStat = lstatSync(scratchCandidate);
  if (scratchStat.isSymbolicLink() || !scratchStat.isDirectory()) throw new Error("private scratch root must be a real directory");
  const actualDirectory = realpathSync(scratchCandidate);
  const actualPublicationOutput = realpathSync(publicationOutput);
  if (pathIsWithin(actualPublicationOutput, actualDirectory)) throw new Error("private capture scratch resolves inside publication output");
  chmodSync(actualDirectory, 0o700);
  return actualDirectory;
}

const FAILURE_PHASES = new Set([
  "setup", "campaign_startup", "campaign_readiness", "campaign_monitoring",
  "frame_capture", "proof_validation", "media_encoding", "media_verification", "artifact_sealing",
]);

/**
 * Classify only evidence visible at the capture boundary. Raw command output
 * is deliberately excluded from the structured diagnostic; it can contain
 * credentials and remains in the private preserved source logs for review.
 */
export function classifyCaptureFailure({ phase, console_text = "", stderr_text = "" } = {}) {
  const safePhase = FAILURE_PHASES.has(phase) ? phase : "setup";
  const observed = [
    ...(console_text ? [{ source: "campaign_console_log", text: console_text }] : []),
    ...(stderr_text ? [{ source: "campaign_stderr_log", text: stderr_text }] : []),
  ];
  const providerPattern = /\b(?:rate.?limit|quota exceeded|authentication failed|invalid[_ ]api[_ ]key|provider (?:request )?(?:failed|error|unavailable|timed out)|upstream (?:provider )?(?:error|timeout)|HTTP (?:401|402|408|429|5\d\d)|status(?: code)?[=: ]+(?:401|402|408|429|5\d\d)|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b/i;
  const providerSources = observed.filter(({ text }) => providerPattern.test(text)).map(({ source }) => source);
  if (providerSources.length > 0) {
    return Object.freeze({ failure_class: "provider", failure_code: "provider_request_failed", phase: safePhase, classification_method: "bounded_log_pattern", classification_confidence: "inferred", classification_sources: Object.freeze(providerSources) });
  }
  const repositoryPattern = /\b(?:verification (?:command|stage).{0,40}(?:failed|exit|nonzero)|test suite failed|build failed|(?:bun|cargo|go test|pytest|vitest|jest|tsc).{0,80}(?:failed|error|exit code [1-9])|git (?:apply|checkout|merge).{0,40}failed)\b/i;
  const repositorySources = observed.filter(({ text }) => repositoryPattern.test(text)).map(({ source }) => source);
  if (repositorySources.length > 0) {
    return Object.freeze({ failure_class: "repository", failure_code: "repository_verification_failed", phase: safePhase, classification_method: "bounded_log_pattern", classification_confidence: "inferred", classification_sources: Object.freeze(repositorySources) });
  }
  if (safePhase.startsWith("campaign_")) {
    return Object.freeze({ failure_class: "harness", failure_code: "campaign_execution_failed", phase: safePhase, classification_method: "campaign_phase_fallback", classification_confidence: "inferred", classification_sources: Object.freeze(["capture_phase"]) });
  }
  return Object.freeze({
    failure_class: "capture",
    failure_code: `${safePhase}_failed`,
    phase: safePhase,
    classification_method: "capture_phase_fallback",
    classification_confidence: "inferred",
    classification_sources: Object.freeze(["capture_phase"]),
  });
}

function safeErrorSummary(error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    assertSecretFree(message, "capture failure summary", { reject_control_characters: true });
    return message;
  } catch {
    return "failure details withheld by secret scan";
  }
}

/** Writes the same failure artifacts used by recordTmuxDemo's catch path. */
export function writeCaptureFailureArtifacts(options) {
  const {
    output, preservation, error, phase, private_location_hint = "operator-local private evidence directory",
    console_text = "", stderr_text = "", evidence = null, frame_stats,
    head_start = null, head_end = null, head_drifted = false,
    worktree_footprint = "unavailable", final_pane_available = false,
  } = options;
  const classification = classifyCaptureFailure({ phase, console_text, stderr_text });
  const diagnostic = {
    schema_version: 1,
    publication_status: "failed_closed",
    ...classification,
    error_name: error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name) ? error.name : "Error",
    private_evidence: {
      status: preservation.complete ? "preserved" : "original_sources_retained",
      location_hint: private_location_hint,
      paths: preservation.paths,
    retained_source_count: preservation.failed_sources.length,
    retained_sources: preservation.failed_source_labels,
    retained_frame_records: preservation.frame_source_retained === true,
    retained_source_locations: [
      ...preservation.failed_sources.map((path, index) => ({ label: preservation.failed_source_labels[index], path })),
      ...(preservation.frame_source_retained ? [{ label: "frames", path: preservation.frame_source_path }] : []),
    ],
      publication_output_exclusion: "raw logs, ledgers, and captured frames are never written under publication output; private copies are excluded from sealed manifests",
    },
    evidence: {
      campaign_ledger_readable: evidence !== null,
      frames_captured: frame_stats.frame_count,
      final_pane_available: final_pane_available,
      repository_head_drifted: head_drifted,
    },
    omitted_private_fields: ["raw_error_message", "provider_response_body", "credentials", "raw_campaign_logs"],
  };
  const diagnosticText = `${JSON.stringify(diagnostic, null, 2)}\n`;
  assertSecretFree(diagnosticText, "capture failure diagnostic", { reject_control_characters: true });
  writeFileSync(join(output, "failure-diagnostic.json"), diagnosticText, "utf8");

  const lines = [
    `capture failed closed (${classification.failure_class}/${classification.failure_code}): ${safeErrorSummary(error)}`,
    "",
    evidence
      ? [
          "proof-set checks at time of failure:",
          ...Object.entries(evidence.checks).map(([id, ok]) => `  ${ok ? "OK  " : "FAIL"} ${id}`),
          `event_kind_counts: ${JSON.stringify(evidence.event_kind_counts)}`,
          `last ledger event: ${evidence.last_event_at ?? "none observed"}`,
        ].join("\n")
      : "no devtools ledger was ever readable for this take -- the campaign likely never started.",
    "",
    `frames captured before failure: ${frame_stats.frame_count} (distinct left panes: ${frame_stats.distinct_left_frames}, distinct right panes: ${frame_stats.distinct_right_frames})`,
    "",
    `repository HEAD at capture start: ${head_start ?? "unknown"}`,
    `repository HEAD at failure:       ${head_end ?? "unknown"}`,
    head_drifted
      ? "HEAD MOVED DURING THIS CAPTURE -- any campaign worktree created before the move may now be built on an orphaned commit; siblings created before/after may be built on DIFFERENT base commits."
      : "HEAD did not move during this capture (or could not be checked).",
    "",
    `worktree footprint at failure time: ${worktree_footprint}`,
    "",
    `private evidence location: ${private_location_hint}`,
    `preserved evidence: ${preservation.summary}`,
    ...(preservation.failed_sources ?? []).map((path, index) => `retained ${preservation.failed_source_labels[index] ?? "source"}: ${path}`),
    ...(preservation.frame_source_retained ? [`retained frames: ${preservation.frame_source_path}`] : []),
    final_pane_available ? `final pane snapshot: ${join(output, "final-pane-snapshot.txt")}` : "final pane snapshot: unavailable (session already gone or secret-scan withheld it)",
  ];
  const failureText = `${lines.join("\n")}\n`;
  try {
    assertSecretFree(failureText, "capture failure text", { reject_control_characters: true });
    writeFileSync(join(output, "failure.txt"), failureText, "utf8");
  } catch {
    writeFileSync(join(output, "failure.txt"), `capture failed closed (${classification.failure_class}/${classification.failure_code}); details withheld by secret scan\n`, "utf8");
  }
  return Object.freeze({ diagnostic, preserved: preservation.summary });
}

/**
 * Cheap (no git-diff, no file walk beyond `du`) summary of what a live
 * campaign's worktrees hold, for the failure diagnostic. A specialist can
 * write tens of thousands of insertions to a throwaway worktree (a full
 * .visual-intelligence regeneration observed at 83k insertions / 67k
 * deletions in one node's worktree); reporting size and HEAD per worktree
 * here is what let a real incident be diagnosed from devtools.log and the
 * console logs alone, rather than from worktree mtimes and `git reflog`.
 */
function summarizeWorktreeFootprint(repoRoot) {
  const worktreesDir = join(repoRoot, ".worktrees");
  if (!existsSync(worktreesDir)) return "no .worktrees directory present";
  let entries;
  try { entries = readdirSync(worktreesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return "worktrees directory unreadable"; }
  if (entries.length === 0) return "no worktree directories present";
  return entries.map((entry) => {
    const path = join(worktreesDir, entry.name);
    const du = run("du", ["-sk", path], { allow_failure: true });
    const kb = du.status === 0 ? Number(du.stdout.split("\t")[0]) : NaN;
    const head = run("git", ["-C", path, "rev-parse", "HEAD"], { allow_failure: true });
    const headLabel = head.status === 0 ? head.stdout.trim().slice(0, 12) : "unknown";
    return `${entry.name} @ ${headLabel}${Number.isFinite(kb) ? ` (~${Math.round(kb / 1024)}MB)` : ""}`;
  }).join("; ");
}

/** Best-effort `git rev-parse HEAD`; null (never throws) if it cannot be read. */
function currentHead(repoRoot) {
  const result = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot, allow_failure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function reclaimOutputDirectory(output) {
  if (!existsSync(output)) return "created";
  if (!existsSync(join(output, ".incomplete"))) {
    throw new Error(`${output} holds a COMPLETE capture. Published exemplars are immutable -- pick a new --run-id rather than overwriting one.`);
  }
  process.stderr.write(`[record] reclaiming the incomplete capture at ${output}\n`);
  rmSync(output, { recursive: true, force: true });
  return "reclaimed";
}

export async function recordTmuxDemo(options = {}, dependencies = {}) {
  const runCommand = dependencies.run ?? run;
  const hasTool = dependencies.tool_exists ?? toolExists;
  const prepareOutputRoot = dependencies.ensure_root ?? ensureRoot;
  const copyPrivateTree = dependencies.copy_private_tree ?? cpSync;
  const runId = options.run_id ?? `cockpit-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (!RUN_ID.test(runId)) throw new Error("run_id must be a publication-safe identifier");
  const durationSeconds = Number(options.duration_seconds ?? 16);
  const captureFps = Number(options.capture_fps ?? 4);
  // Duration and frame rate used to carry a policy ceiling (<=3600s, a fixed
  // frame budget) that had nothing to do with what the machine can actually
  // sustain. A long-running agent is not a failure mode and reel storage is
  // cheap, so there is no longer an upper bound on duration or frame count.
  // What the machine genuinely cannot sustain is holding every captured
  // frame's full pane text in memory for the run's whole lifetime -- so each
  // frame is written to disk as it is captured (see the capture loop below)
  // and nothing here accumulates with duration. The lower bounds stay: a
  // capture too short or too slow to show motion is not evidence of anything.
  if (!(durationSeconds >= 6) || !(captureFps >= 1 && captureFps <= 12)) throw new Error("duration must be at least 6s and capture_fps 1-12");
  if (!hasTool("tmux", ["-V"]) || !hasTool("ffmpeg", ["-version"]) || !hasTool("ffprobe", ["-version"])) throw new Error("tmux, ffmpeg and ffprobe are required");
  const repoRoot = realpathSync(resolve(options.repo_root ?? new URL("..", import.meta.url).pathname));
  const root = prepareOutputRoot(options.output_root ?? "/mnt/sda2/revoy2/exemplars/operator-cockpit");
  const output = join(root, runId);
  const privateEvidence = privateEvidenceDirectory(options, output, runId);
  const privateScratchRoot = ensurePrivateScratchRoot(privateEvidence, root);
  reclaimOutputDirectory(output);
  mkdirSync(output, { recursive: false });
  writeFileSync(join(output, ".incomplete"), "capture incomplete\n", { flag: "wx" });
  const scratch = mkdtempSync(join(privateScratchRoot, `.capture-tmp-${runId}-`));
  chmodSync(scratch, 0o700);
  const persistenceArgument = join(".arbor", "publication-captures", runId);
  const persistence = join(repoRoot, persistenceArgument);
  mkdirSync(join(repoRoot, ".arbor", "publication-captures"), { recursive: true });
  const framesDir = join(scratch, "frames");
  mkdirSync(framesDir);
  // Frames are streamed to disk as they are captured, one JSON line each,
  // instead of accumulating in memory: a multi-hour capture at a few fps can
  // be tens of thousands of frames of full pane text, and holding all of it
  // for the run's whole lifetime is exactly the crash a removed frame budget
  // would otherwise trade the policy limit for. Only small, bounded
  // per-frame state (a running count and two sha256 sets) is kept in memory
  // across the loop; the SVG for each frame is rendered and written to disk
  // immediately, and the frame text itself is read back from framesJsonlPath
  // -- in order, once, at the very end -- only for the one stage that
  // genuinely needs the whole set (assembling tmux-capture.json).
  const framesJsonlPath = join(scratch, "frames.jsonl");
  const session = `revoy2-${runId}`.slice(0, 80);
  const replacements = [[repoRoot, "<revoy2>"], [persistence, "<evidence>"], [scratch, "<capture>"]];
  const selfhostRunId = `cap-${runId}`.replace(/[^A-Za-z0-9_-]/g, "-");
  const selfhostWorktree = join(repoRoot, ".worktrees", `selfhost-${selfhostRunId}`);
  const selfhostPersistence = options.selfhost === true ? join(selfhostWorktree, ".arbor") : null;
  const consoleLogPath = join(persistence, options.selfhost === true ? "selfhost-console.log" : "real-console.log");
  const stderrLogPath = join(persistence, options.selfhost === true ? "selfhost-stderr.log" : "real-stderr.log");
  let frameCount = 0;
  const distinctLeftShas = new Set();
  const distinctRightShas = new Set();
  // Hoisted so the catch block -- which runs in a different lexical scope
  // than the try body's `const`s -- can still read them for diagnostics.
  let logPath = null;
  let startHead = null;
  let headDriftedTo = null;
  let failurePhase = "setup";
  let failedCapture = false;
  let failurePreservation = null;
  let privateEvidencePathSafe = true;
  try {
    // Recorded before the campaign can touch anything. A real incident: the
    // operator amended the HEAD commit a live campaign's worktree was built
    // from ~3.5 minutes into a capture, orphaning it, and a second node
    // later started from a DIFFERENT commit than its sibling -- and nothing
    // watched for it. checkLiveness() below compares against this.
    startHead = currentHead(repoRoot);
    runCommand("tmux", ["new-session", "-d", "-s", session]);
    // --selfhost drives a REAL campaign against this repository with real model
    // calls. Without it demo-window.sh runs the seeded player-piano replay,
    // which never emits loop.specialist_dispatched / loop.critic_dispatched /
    // loop.node_claimed / loop.node_verified -- the exact events
    // summarizeEvidence() below requires (see REQUIRED_LOOP_EVENTS). The recorder therefore demanded proof of real dispatch while
    // launching the one mode that cannot produce it, and failed closed every
    // time. Seeded replay stays the default so an offline capture still works;
    // a publication capture passes --selfhost and gets a real campaign.
    const windowArgs = ["--session", session, "--persistence-dir", persistenceArgument, "--no-observer"];
    // selfhost.ts deliberately roots its runtime inside the throwaway worktree
    // it creates, NEVER at --persistence-dir -- that isolation is the whole
    // point of self-hosting. So in selfhost mode the devtools log this capture
    // must read lives at .worktrees/selfhost-<run-id>/.arbor/..., and the id is
    // otherwise generated inside demo-window.sh and unguessable from here.
    // Pin it so the evidence path is derivable. selfhost.ts charset-validates
    // the id, so strip anything outside its allowed set.
    if (options.real === true) windowArgs.push("--real");
    if (options.selfhost === true) {
      windowArgs.push("--selfhost", "--selfhost-run-id", selfhostRunId);
      if (options.selfhost_task) windowArgs.push("--selfhost-task", String(options.selfhost_task));
      if (options.selfhost_max_iterations) windowArgs.push("--selfhost-max-iterations", String(options.selfhost_max_iterations));
      if (options.selfhost_max_seconds) windowArgs.push("--selfhost-max-seconds", String(options.selfhost_max_seconds));
    }
    // Applies to BOTH real-campaign paths, not just selfhost: `arbor run`
    // (--real) is the entry point a publication capture actually films, and
    // scoping these to the selfhost branch would have left the filmed run
    // verifying nothing while appearing configured.
    // Without at least one stage every success ceilings at `claimed` --
    // nothing machine-checked the work -- so `loop.node_verified` stays zero,
    // exactly as both prior 60-minute reels recorded.
    for (const cmd of options.verification_cmds ?? []) {
      windowArgs.push("--verification-cmd", String(cmd));
    }
    if (options.selfhost === true) releaseAbandonedSelfhostWorktree(repoRoot, selfhostWorktree, `arbor/selfhost/${selfhostRunId}`);
    // demo-window.sh writes the campaign's own stdout/stderr to a DIFFERENT
    // filename per mode -- selfhost-console.log for --selfhost, but
    // real-console.log (plus a separate real-stderr.log) for plain --real.
    // This was hardcoded to the selfhost name regardless of mode, so a
    // plain `--real` capture (the mode the actual failed hour-long take
    // used) could never match a refusal or a no-dispatch summary here: the
    // file it read never existed, and the readiness gate had no way to learn
    // the campaign had already failed rather than merely being slow.
    // Both campaign modes write stderr separately with an explicit exit line;
    // the filename differs, just like their console logs.
    const captureStartedAt = Date.now();
    failurePhase = "campaign_startup";
    runCommand(join(repoRoot, "scripts", "demo-window.sh"), windowArgs, { cwd: repoRoot, timeout: 600_000 });
    failurePhase = "campaign_readiness";
    logPath = options.selfhost === true
      ? join(selfhostWorktree, ".arbor", "devtools", "devtools.log")
      : join(persistence, "devtools", "devtools.log");
    const provesDispatch = options.selfhost === true || options.real === true;
    const filmsWholeArc = durationSeconds >= 600;
    // How long the campaign's own devtools ledger may go without a NEW event
    // before this is treated as a stall rather than normal quiet work. A
    // single specialist/critic turn is capped at 900s and legitimately emits
    // nothing for its whole duration, so any threshold at or near 900s would
    // abort healthy runs; the real incident this fixes went SILENT for 56
    // minutes (3360s), so a much smaller margin above the per-turn ceiling
    // already catches it early. 1500s (25min) gives ~1.67x headroom over one
    // turn while still surfacing a wedged campaign in well under an hour
    // instead of at the very end of one.
    const stallTimeoutMs = Number(options.stall_timeout_seconds ?? 1_500) * 1_000;
    const monitorIntervalMs = 15_000;
    let lastMonitorAt = 0;
    let lastLogMtimeMs = 0;
    let lastLogActivityAt = Date.now();
    // Runs at most once per monitorIntervalMs regardless of call frequency,
    // so it is cheap to call from both the readiness wait (sleeps 200ms-2s)
    // and the frame-capture loop (up to 12fps). Three checks, all against
    // conditions that were previously only discoverable at the very end (or,
    // for HEAD drift, not discoverable at all):
    //   1. repository HEAD moved out from under the running campaign
    //   2. the campaign's ledger has gone silent past stallTimeoutMs
    //   3. progress against the required proof set, reported as it happens
    // Throws (1) and (2); (3) only writes to stderr.
    function checkLiveness(label) {
      if (!provesDispatch) return;
      failurePhase = label === "readiness wait" ? "campaign_monitoring" : "frame_capture";
      if (Date.now() - lastMonitorAt < monitorIntervalMs) return;
      lastMonitorAt = Date.now();
      const head = currentHead(repoRoot);
      if (startHead !== null && head !== null && head !== startHead) {
        headDriftedTo = head;
        throw new Error(`repository HEAD moved during capture (${label}): ${startHead} -> ${head}. A live campaign's worktrees may now be built on drifted or orphaned commits, and this recording is no longer publishable evidence of a stable repository state. Aborting rather than filming past it.`);
      }
      if (existsSync(logPath)) {
        const mtimeMs = statSync(logPath).mtimeMs;
        if (mtimeMs > lastLogMtimeMs) { lastLogMtimeMs = mtimeMs; lastLogActivityAt = Date.now(); }
      }
      const silentMs = Date.now() - lastLogActivityAt;
      if (silentMs > stallTimeoutMs) {
        throw new Error(`campaign ledger stalled (${label}): no new devtools event in ${Math.round(silentMs / 1000)}s (threshold ${Math.round(stallTimeoutMs / 1000)}s; last activity ${new Date(lastLogActivityAt).toISOString()}). Aborting rather than filming a wedged campaign for the rest of the take.`);
      }
      const progress = evaluateEvidence(logPath, { frame_count: frameCount, distinct_left_frames: distinctLeftShas.size, distinct_right_frames: distinctRightShas.size });
      const pending = Object.entries(progress.checks).filter(([, ok]) => !ok).map(([id]) => id);
      process.stderr.write(`[record] ${label}: ${pending.length ? `pending proof -- ${pending.join(", ")}` : "all required proof checks satisfied"} (events=${progress.record_count}, last_event=${progress.last_event_at ?? "none"})\n`);
    }
    // A selfhost run spends its first minutes provisioning dependencies inside
    // the throwaway worktree it creates. That work writes campaign.changed and
    // gate.recorded events, so the old "pane looks alive AND the log is
    // non-empty" gate was satisfied long before any model call -- and a 120s
    // capture (the hard publication ceiling) filmed the install rather than
    // the campaign, then failed the empirical-proof check for the dispatch
    // events that had not happened yet. In selfhost mode, wait for the first
    // loop.* event, which is runCampaign's own log hook and therefore the
    // moment real work starts.
    // How long to wait for the campaign to reach the events a publishable
    // capture must prove. Measured, not guessed: an unbudgeted real run took
    // ~2min to dispatch a specialist, ~15min to dispatch a critic and ~20min
    // to claim a node. A 15-minute budget therefore expired mid-run and the
    // capture filmed anyway, failing the proof for events that were minutes
    // away. This raises only how long the camera is willing to WAIT; the 120s
    // publication ceiling and the required event set are untouched.
    const readyDeadline = Date.now() + (options.selfhost === true || options.real === true
      ? Number(options.ready_timeout_seconds ?? 2_700) * 1_000
      : 20_000);
    let ready = false;
    while (Date.now() < readyDeadline) {
      checkLiveness("readiness wait");
      const probe = runCommand("tmux", ["capture-pane", "-p", "-e", "-t", `${session}:demo.0`], { allow_failure: true });
      // A campaign that refuses to start -- an identity conflict, a forbidden
      // branch, a missing credential -- prints its reason and returns to a
      // prompt. Without this the readiness gate sat out its entire 15 minute
      // budget waiting for dispatch events from a process that had already
      // exited, and reported a timeout instead of the refusal that caused it.
      // The campaign runs detached now, with the cockpit in the left pane, so
      // its refusals and its final summary land in the console log rather than
      // in any pane. Read them there.
      const console_ = existsSync(consoleLogPath) ? readFileSync(consoleLogPath, "utf8") : "";
      const stderr_ = stderrLogPath && existsSync(stderrLogPath) ? readFileSync(stderrLogPath, "utf8") : "";
      const refusal = /^\s*(selfhost|arbor)\s+(CONFLICT|REFUSED|ERROR)[:\s].*/im.exec(`${console_}\n${stderr_}`);
      if (refusal) throw new Error(`the campaign refused to start: ${refusal[0].trim()}`);
      // Plain --real has no selfhost-style "halted: <reason>" summary, but
      // the runner always logs its own exit line to real-stderr.log. If the
      // campaign process has already exited and we have not yet broken out
      // of this loop (the dispatching condition below has not been met),
      // waiting out the rest of the readiness budget waits on a process that
      // no longer exists -- exactly the failure mode the selfhost summary
      // check above exists to avoid.
      const exitedEarly = stderr_ ? /\[runner\] campaign exited rc=(\d+)/.exec(stderr_) : null;
      if (exitedEarly) throw new Error(`the campaign process already exited (rc=${exitedEarly[1]}) before producing the events this capture needs. stderr tail:\n${stderr_.split("\n").filter(Boolean).slice(-20).join("\n")}`);
      // A campaign can also START and then finish without ever dispatching --
      // its one node failing a gate, or halting on no_nodes. The pane prints a
      // summary and returns to a prompt, and the gate would otherwise wait out
      // its whole budget for dispatch events from a process that had already
      // exited. Surface the campaign's own summary, which names the reason.
      const finished = /^\s*selfhost\s+RAN\s+campaign[\s\S]*?halted:\s*\S+.*$/im.exec(console_);
      if (finished) {
        const summary = finished[0].split("\n").map((l) => l.trim()).filter(Boolean).join(" | ");
        throw new Error(`the campaign finished without dispatching: ${summary}`);
      }
      const logReady = runCommand("test", ["-s", logPath], { allow_failure: true }).status === 0;
      // A capture long enough to contain the arc should FILM the arc, not wait
      // for it and then film the aftermath. Waiting for the whole required set
      // before rolling was a workaround for a window too short to hold it; at
      // full length that is exactly backwards, and it is what produced a reel
      // whose event pane never moved. So: a long capture rolls as soon as the
      // campaign is genuinely working, a short one still waits for the set.
      const awaited = filmsWholeArc ? null : Object.values(REQUIRED_LOOP_EVENTS);
      const dispatching = !provesDispatch || (logReady && hasFreshDispatch(logPath, captureStartedAt, awaited));
      if (/REVOY|CAMPAIGN|COCKPIT/i.test(probe.stdout) && logReady && dispatching) { ready = true; break; }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, options.selfhost === true || options.real === true ? 2_000 : 200));
    }
    if (!ready) {
      // Previously this fell through to filming silently: a campaign that
      // never became filmable was discovered only later, via
      // summarizeEvidence's own failure, after paying for the whole
      // readiness budget AND a full take on top of it. Fail here instead,
      // with the same diagnostics (console tail via the catch block below).
      const awaitedLabel = !provesDispatch
        ? "the cockpit pane never came up"
        : filmsWholeArc
          ? "never emitted even one loop.* event"
          : `never satisfied ${Object.values(REQUIRED_LOOP_EVENTS).flat().join(", ")}`;
      throw new Error(`campaign did not reach filmable readiness within ${Math.round((readyDeadline - captureStartedAt) / 1000)}s -- ${awaitedLabel}`);
    }
    failurePhase = "frame_capture";
    const started = Date.now();
    const plannedFrameCount = Math.ceil(durationSeconds * captureFps);
    for (let index = 0; index < plannedFrameCount; index += 1) {
      checkLiveness("filming");
      const target = started + Math.round(index * 1000 / captureFps);
      if (Date.now() < target) await new Promise((resolveSleep) => setTimeout(resolveSleep, target - Date.now()));
      const left = cleanPane(runCommand("tmux", ["capture-pane", "-p", "-e", "-S", "-44", "-t", `${session}:demo.0`]).stdout, replacements);
      const right = cleanPane(runCommand("tmux", ["capture-pane", "-p", "-e", "-S", "-44", "-t", `${session}:demo.1`]).stdout, replacements);
      assertSecretFree(`${left}\n${right}`, `tmux frame ${index}`);
      const leftSha = sha256Bytes(Buffer.from(left));
      const rightSha = sha256Bytes(Buffer.from(right));
      const record = { sequence: index + 1, at_ms: Math.round(index * 1000 / captureFps), left, right, left_sha256: leftSha, right_sha256: rightSha };
      // Persist this frame to disk immediately -- it is never added to an
      // in-memory array. `left`/`right` (the only large fields) go out of
      // scope at the end of this iteration.
      appendFileSync(framesJsonlPath, `${JSON.stringify(record)}\n`);
      writeFileSync(join(framesDir, `frame-${String(index).padStart(6, "0")}.svg`), renderTmuxFrame(record, { run_id: runId, duration_ms: durationSeconds * 1000 }), "utf8");
      frameCount += 1;
      distinctLeftShas.add(leftSha);
      distinctRightShas.add(rightSha);
    }
    failurePhase = "proof_validation";
    const baseEvidence = summarizeEvidence(logPath, { frame_count: frameCount, distinct_left_frames: distinctLeftShas.size, distinct_right_frames: distinctRightShas.size });
    const endHead = currentHead(repoRoot);
    // Recorded even on a clean pass: the absence of drift is itself part of
    // what makes this recording publishable evidence of a stable repository
    // state, not only a diagnostic for when drift happens.
    const evidence = { ...baseEvidence, git_head_at_start: startHead, git_head_at_end: endHead, head_drift_detected: startHead !== null && endHead !== null && startHead !== endHead };
    const capturePath = join(output, "tmux-capture.json");
    const evidencePath = join(output, "evidence.json");
    const privacyPath = join(output, "privacy-report.json");
    // The only stage that needs the whole frame set is this JSON body, and it
    // reads the frames back from disk, in order, rather than from an
    // in-memory array that was never populated.
    const captureText = buildCaptureText({ schema_version: 1, run_id: runId, terminal: { multiplexer: "tmux", panes: 2, capture_fps: captureFps, duration_seconds: durationSeconds } }, readFrameLines(framesJsonlPath));
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    const privacy = { schema_version: 1, policy: "publication-safe text frames; abort on secret pattern", secret_pattern_codes: publicationSecretPatternCodes, findings: 0, arbitrary_desktop_pixels_captured: false, environment_captured: false, provider_content_captured: false, path_scrubbing: ["repository root", "capture scratch root"] };
    const privacyText = `${JSON.stringify(privacy, null, 2)}\n`;
    for (const [path, text] of [[capturePath, captureText], [evidencePath, evidenceText], [privacyPath, privacyText]]) { assertSecretFree(text, basename(path)); writeFileSync(path, text, { flag: "wx" }); }
    const mp4 = join(output, "revoy2-operator-cockpit.mp4");
    const webm = join(output, "revoy2-operator-cockpit.webm");
    // Removing the capture ceiling without removing this one just moves the
    // limit: encoding tens of thousands of rasterized SVG frames takes longer
    // than the capture did. Scale the encode budget to the capture, with the
    // old 30-minute value as the floor for short reels.
    const encodeTimeoutMs = Math.max(30 * 60 * 1000, durationSeconds * 4 * 1000);
    failurePhase = "media_encoding";
    const ffmpegMp4 = runCommand("ffmpeg", ["-hide_banner", "-y", "-framerate", String(captureFps), "-i", join(framesDir, "frame-%06d.svg"), "-vf", "fps=30,format=yuv420p", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", "-map_metadata", "-1", mp4], { timeout: encodeTimeoutMs });
    const ffmpegWebm = runCommand("ffmpeg", ["-hide_banner", "-y", "-framerate", String(captureFps), "-i", join(framesDir, "frame-%06d.svg"), "-vf", "fps=30,format=yuv420p", "-an", "-c:v", "libvpx-vp9", "-crf", "29", "-b:v", "0", "-row-mt", "1", "-cpu-used", "2", "-map_metadata", "-1", webm], { timeout: encodeTimeoutMs });
    assertSecretFree(`${ffmpegMp4.stdout}${ffmpegMp4.stderr}${ffmpegWebm.stdout}${ffmpegWebm.stderr}`, "tmux encoder diagnostics");
    failurePhase = "media_verification";
    const media = { mp4: inspectVideo(mp4, "h264"), webm: inspectVideo(webm, "vp9") };
    const manifest = { schema_version: 1, product: "revoy2", artifact_kind: "live_tmux_operator_cockpit", run_id: runId, generated_at: new Date().toISOString(), source: { frame_count: frameCount, capture_sha256: sha256Bytes(Buffer.from(captureText)), evidence_sha256: sha256Bytes(Buffer.from(evidenceText)) }, empirical_checks: evidence.checks, media };
    failurePhase = "artifact_sealing";
    const sealed = writeManifestAndChecksums(output, manifest, [capturePath, evidencePath, privacyPath, mp4, webm]);
    rmSync(join(output, ".incomplete"));
    return { run_directory: output, mp4, webm, manifest: sealed.manifest_path, checksums: sealed.checksums_path, evidence: evidencePath };
  } catch (error) {
    failedCapture = true;
    // Capture the pane BEFORE the session is killed in `finally` -- the live
    // pane can hold the only surviving trace of what a run was doing at the
    // moment it failed (a prompt after a refusal, a mid-render frame), and
    // it is gone forever once the session is torn down.
    const finalPane = runCommand("tmux", ["capture-pane", "-p", "-e", "-S", "-200", "-t", `${session}:demo.0`], { allow_failure: true });
    if (finalPane.status === 0) {
      try {
        const text = cleanPane(finalPane.stdout, replacements);
        assertSecretFree(text, "final pane snapshot");
        writeFileSync(join(output, "final-pane-snapshot.txt"), `${text}\n`, "utf8");
      } catch (scanError) {
        writeFileSync(join(output, "final-pane-snapshot.txt"), `withheld: ${scanError instanceof Error ? scanError.message : String(scanError)}\n`, "utf8");
      }
    }
    const frameStats = { frame_count: frameCount, distinct_left_frames: distinctLeftShas.size, distinct_right_frames: distinctRightShas.size };
    // logPath may be null if the failure happened before it was computed
    // (e.g. tool checks, session setup) -- evaluateEvidence tolerates that.
    const evidence = logPath ? evaluateEvidence(logPath, frameStats) : null;
    const endHead = currentHead(repoRoot);
    const readTail = (path) => {
      if (!path || !existsSync(path)) return "";
      try { return readFileSync(path, "utf8").slice(-64_000); } catch { return ""; }
    };
    const consoleText = readTail(consoleLogPath);
    const stderrText = readTail(stderrLogPath);
    // This replaces "capture failed closed; inspect the invoking terminal" --
    // the invoking terminal held exactly the proof-incomplete summary line
    // and nothing else, which is what made a real hour-long failure
    // undiagnosable. Every field below is something the operator previously
    // had to reconstruct from worktree mtimes and `git reflog`, or could not
    // recover at all once this dir's `finally` deleted it.
    const sourceRoots = [persistence, selfhostPersistence];
    try {
      failurePreservation = preserveFailureEvidence(privateEvidence, output, sourceRoots, framesJsonlPath, copyPrivateTree);
    } catch {
      privateEvidencePathSafe = false;
      failurePreservation = Object.freeze({
        complete: false,
        summary: "private evidence destination unavailable; original source roots retained",
        paths: Object.freeze([]),
        failed_sources: Object.freeze(sourceRoots.filter((path) => path && existsSync(path))),
        failed_source_labels: Object.freeze(sourceRoots.filter((path) => path && existsSync(path)).map((_, index) => index === 0 ? "campaign-ledger" : `campaign-ledger-${index + 1}`)),
        preserved_source_roots: Object.freeze([]),
        frames_preserved: false,
        frame_source_retained: existsSync(framesJsonlPath),
        frame_source_path: existsSync(framesJsonlPath) ? framesJsonlPath : null,
      });
    }
    writeCaptureFailureArtifacts({
      output,
      preservation: failurePreservation,
      private_location_hint: privateEvidencePathSafe
        ? privateEvidence
        : "private evidence path rejected; inspect the listed retained source locations",
      error,
      phase: failurePhase,
      console_text: consoleText,
      stderr_text: stderrText,
      evidence,
      frame_stats: frameStats,
      head_start: startHead,
      head_end: endHead,
      head_drifted: headDriftedTo !== null || (startHead !== null && endHead !== null && startHead !== endHead),
      worktree_footprint: summarizeWorktreeFootprint(repoRoot),
      final_pane_available: existsSync(join(output, "final-pane-snapshot.txt")),
    });
    throw error;
  } finally {
    runCommand("tmux", ["kill-session", "-t", session], { allow_failure: true });
    const persistenceIsPreserved = failurePreservation?.preserved_source_roots.includes(persistence) === true;
    const framesArePreserved = !existsSync(framesJsonlPath) || failurePreservation?.frames_preserved === true;
    if (!failedCapture || persistenceIsPreserved) rmSync(persistence, { recursive: true, force: true });
    if (!failedCapture || framesArePreserved) rmSync(scratch, { recursive: true, force: true });
  }
}

export function parseArgs(argv) {
  const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
  // Repeatable, unlike `value`: each occurrence is one ordered verification
  // stage, so the staged arm is reachable from a capture rather than only
  // from a hand-run selfhost.
  const values = (name) => argv.reduce((all, arg, index) => (arg === name && argv[index + 1] !== undefined ? [...all, argv[index + 1]] : all), []);
  return {
    run_id: value("--run-id"), output_root: value("--output-root"),
    // recordTmuxDemo already honours options.repo_root; parseArgs never read
    // the flag, so `--repo-root` was accepted and silently discarded and every
    // capture ran against this checkout regardless.
    repo_root: value("--repo-root"),
    private_evidence_root: value("--private-evidence-root"),
    duration_seconds: Number(value("--duration", "16")), capture_fps: Number(value("--fps", "4")),
    selfhost: argv.includes("--selfhost"),
    real: argv.includes("--real"),
    ready_timeout_seconds: value("--ready-timeout"),
    stall_timeout_seconds: value("--stall-timeout"),
    selfhost_task: value("--selfhost-task"),
    selfhost_max_iterations: value("--selfhost-max-iterations"),
    selfhost_max_seconds: value("--selfhost-max-seconds"),
    verification_cmds: values("--verification-cmd"),
  };
}

export function formatCaptureCliFailure(error) {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name) ? error.name : "Error";
  return `capture recorder failed (${name}); inspect failure.txt and failure-diagnostic.json when the output directory was created\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) recordTmuxDemo(parseArgs(process.argv.slice(2))).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(formatCaptureCliFailure(error)); process.exitCode = 1; });
