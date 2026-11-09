#!/usr/bin/env bun
/**
 * TUI pilot: drive `arbor tui` in a real pty, observe it through a VT
 * emulator, and leave a receipt that records what the app DID, not what was
 * asked of it.
 *
 * Replaces the tmux-based `record-console-reel.mjs` for pilot evidence. The
 * EC log (artifacts/tui-pilot/2026-09-02-exemplar-checks.md) attributes
 * roughly nine remediation ticks to that instrument: keys tmux consumed,
 * modifiers it could not send, a renderer assumed rather than read, and
 * single-run conclusions about an intermittent defect. Each of those has a
 * counterpart here: exact key bytes (lib/keys.mjs), the emulator's own grid
 * (lib/screen.mjs), an observed-renderer field derived from the byte stream,
 * and `--runs N` with a refusal to state a rate below sixteen samples.
 *
 * Usage:
 *   bun scripts/tui-pilot/pilot.mjs --scenario <id|file> [--seed <preset>|--project <dir>]
 *     [--geometry <WxH>|random] [--renderer opentui|stdout] [--resume|--no-resume]
 *     [--runs N] [--out <dir>] [--interval-ms 250] [--budget-s 600] [--no-png]
 *     [--env K=V]... [--tui-arg <arg>]... [--kitty]
 *
 * Output per run: frames/fNNNN.{txt,json,svg,png}, stream.cast (asciicast v2
 * with input, reply, resize and marker events), seed.json, receipt.json.
 * Across runs: summary.json.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PtySession } from "./lib/pty-session.mjs";
import { encodeKey, describeBytes } from "./lib/keys.mjs";
import { writeSnapshotFiles } from "./lib/screen.mjs";
import { applySeed, SEED_PRESETS } from "./seeds/index.mjs";
import { assertSecretFree } from "../lib/sizzle-redaction.mjs";

// A single deadline the whole run must respect (A09): a per-step timeout or
// hold that would otherwise run past --budget-s is clamped to what remains,
// so the budget bounds the run instead of merely gating between steps.
export function clampToDeadline(requestedMs, elapsedMs, budgetMs) {
  return Math.max(0, Math.min(requestedMs, budgetMs - elapsedMs));
}

// A07/A09: the step loop can break early (budget exhausted, session exited)
// leaving declared steps unrun. Count that explicitly instead of letting the
// receipt go quiet about it.
export function computeStepAccounting({ declaredSteps, executedSteps, breakReason }) {
  const skipped = declaredSteps - executedSteps;
  return { declared_steps: declaredSteps, executed_steps: executedSteps, skipped_steps: skipped, break_reason: skipped > 0 ? breakReason : null };
}

// An unexecuted step is a failure unless the scenario itself declares that an
// early process exit is an expected terminal outcome (e.g. a deliberately
// broken config that is meant to crash) — that declaration lives on the
// scenario file (`early_exit_expected`), never inferred by the runner.
// Budget exhaustion is never exempt: it is a pilot-infrastructure failure to
// under-budget a scenario, not a property of the scenario under test.
export function isIncompleteScenarioFailure({ skippedSteps, breakReason, earlyExitExpected }) {
  if (skippedSteps === 0) return false;
  if (breakReason === "session-exited" && earlyExitExpected === true) return false;
  return true;
}

// A09: a wait_for step may declare `fail_on` — a pattern that must never be an
// acceptable arrival (e.g. the crash screen). The wait watches for either
// pattern so a crash ends the wait at once instead of running out the clock;
// a fail_on hit then counts as an unmatched wait, which the summary already
// turns into a nonzero exit. fail_on wins when both are on screen. A
// scenario that expects a crash declares it as a wait_for, not as fail_on.
export function buildWaitPattern(waitFor, failOn) {
  return failOn === undefined ? waitFor : `(?:${waitFor})|(?:${failOn})`;
}
export function classifyWaitResult(result, failOn) {
  if (failOn !== undefined && result.snapshot && new RegExp(failOn, "iu").test(result.snapshot.text)) return { matched: false, reason: "fail_on" };
  return { matched: result.matched, reason: result.reason ?? null };
}

// A10: scan every publishable stream — a name -> text map, so a new export
// (the receipt, the seed record, ...) joins the gate by being added to the
// map rather than by a bespoke argument — before anything is exported. A
// scan that throws is a failure, not a note; the caller must not export a
// stream that failed its own scan, nor any sibling stream from the same run.
export function scanPublishableStreams(streams) {
  const failures = [];
  for (const [name, text] of Object.entries(streams)) {
    try { assertSecretFree(text, name); } catch (error) { failures.push({ stream: name, error: error.message }); }
  }
  return { ok: failures.length === 0, error: failures.length === 0 ? null : failures.map((f) => f.error).join("; "), failures };
}

// A10: on a scan failure, no publishable artifact may carry the run's actual
// content — not the typed input in steps[].actions[].type, not the
// event_log note detail, not the seed. What survives is exactly what the
// scanner itself is safe to disclose (finding codes/line/column, never
// matched text — see sizzle-redaction.mjs) plus the step accounting, which
// is scenario-shaped bookkeeping, never run content.
export function buildFailureReceipt({ base, secretScan, withheld }) {
  return {
    kind: base.kind,
    status: "secret_scan_failed",
    recorded_at: base.recorded_at,
    repo_revision: base.repo_revision,
    repo_branch: base.repo_branch,
    repo_dirty_paths: base.repo_dirty_paths,
    bun_version: base.bun_version,
    scenario: base.scenario,
    geometry: base.geometry,
    renderer: base.renderer,
    interval_ms: base.interval_ms,
    exit_code: base.exit_code,
    duration_ms: base.duration_ms,
    frame_count: 0,
    tick_count: 0,
    frames: [],
    ticks: [],
    steps: [],
    step_accounting: base.step_accounting,
    secret_scan: secretScan,
    withheld,
  };
}

// A10, the export gate itself: scan every publishable stream for this run —
// frame text, the asciicast, the seed record, and the receipt that would
// otherwise be exported — as one set, and only then decide what actually
// reaches disk. On success, stream.cast and seed.json (if any) are written
// and the receipt gets a passing secret_scan. On failure, the frames already
// captured this run are deleted, stream.cast and seed.json are never
// written, and a scrubbed failure receipt (buildFailureReceipt) is written
// in place of the real one — so a run directory never ends up holding a
// secret the scanner already found. `runDir`/`framesDir` are the only
// filesystem inputs; everything scanned is passed in as text.
export function exportRunArtifacts({ runDir, framesDir, frameText, cast, seedText, receiptCore }) {
  const streams = { frames: frameText, "stream.cast": cast, "receipt.json": JSON.stringify(receiptCore) };
  if (seedText !== null) streams["seed.json"] = seedText;
  const secretScan = scanPublishableStreams(streams);

  let receipt;
  if (secretScan.ok) {
    writeFileSync(join(runDir, "stream.cast"), cast, "utf8");
    if (seedText !== null) writeFileSync(join(runDir, "seed.json"), seedText, "utf8");
    receipt = { ...receiptCore, secret_scan: secretScan };
  } else {
    rmSync(framesDir, { recursive: true, force: true });
    receipt = buildFailureReceipt({ base: receiptCore, secretScan, withheld: ["frames", "stream.cast", "seed.json", "steps[].actions", "event_log"] });
  }
  writeFileSync(join(runDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const LAUNCHER = join(REPO, "packages/arbor-mcp/bin/arbor-mcp.mjs");

// A receipt is evidence that gets committed and shared; a provider key passed
// through `--env` must reach the process and never the receipt.
export function redactEnv(env) {
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [name, /(KEY|TOKEN|SECRET|PASSWORD)/iu.test(name) ? "<redacted>" : value]));
}

// Declared draw pool for `--geometry random`; recorded in the receipt.
export const GEOMETRY_POOL = Object.freeze(["60x20", "80x24", "100x30", "120x40", "132x50", "140x44", "150x46", "200x60", "240x70"]);
const MIN_RUNS_FOR_RATE = 16;

function fail(message) { console.error(`tui-pilot: ${message}`); process.exit(2); }

export function parseArgs(argv) {
  const opts = { runs: 1, renderer: "opentui", seed: "greenfield", project: null, geometry: "140x44", resume: null, out: null,
    intervalMs: 250, budgetS: 600, png: true, env: {}, tuiArgs: [], kitty: false, scenario: null, keepProject: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    if (a === "--scenario") opts.scenario = next();
    else if (a === "--seed") opts.seed = next();
    else if (a === "--project") opts.project = resolve(next());
    else if (a === "--geometry") opts.geometry = next();
    else if (a === "--renderer") opts.renderer = next();
    else if (a === "--resume") opts.resume = true;
    else if (a === "--no-resume") opts.resume = false;
    else if (a === "--runs") opts.runs = Number(next());
    else if (a === "--out") opts.out = resolve(next());
    else if (a === "--interval-ms") opts.intervalMs = Number(next());
    else if (a === "--budget-s") opts.budgetS = Number(next());
    else if (a === "--no-png") opts.png = false;
    else if (a === "--kitty") opts.kitty = true;
    else if (a === "--env") { const [k, ...v] = next().split("="); opts.env[k] = v.join("="); }
    else if (a === "--tui-arg") opts.tuiArgs.push(next());
    else if (a === "--help" || a === "-h") { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]); process.exit(0); }
    else fail(`unknown argument ${a}`);
  }
  if (!opts.scenario) fail("--scenario is required");
  if (opts.renderer !== "opentui" && opts.renderer !== "stdout") fail("--renderer must be opentui or stdout");
  if (!Number.isInteger(opts.runs) || opts.runs < 1) fail("--runs must be a positive integer");
  if (!opts.project && !SEED_PRESETS[opts.seed]) fail(`unknown seed "${opts.seed}" (have: ${Object.keys(SEED_PRESETS).join(", ")})`);
  // Seeded durable state is only foregrounded on --resume (tui.ts fresh-launch filter).
  if (opts.resume === null) opts.resume = opts.project !== null || opts.seed !== "greenfield";
  return opts;
}

// A scenario may declare `early_exit_expected: true` when the app exiting
// mid-run IS the contract under test (e.g. a deliberately broken config that
// is meant to crash, see degraded-badconfig.json) — see
// isIncompleteScenarioFailure. Everything else defaults to false: a
// scenario that runs to a real terminal UI state has no license to leave
// steps unrun.
function loadScenario(ref) {
  const path = existsSync(ref) ? resolve(ref) : join(HERE, "scenarios", `${ref}.json`);
  if (!existsSync(path)) fail(`scenario not found: ${ref} (looked at ${path})`);
  const scenario = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(scenario.steps)) fail(`scenario ${path} has no steps[]`);
  return { ...scenario, id: scenario.id ?? basename(path, ".json"), path };
}

function drawGeometry(spec, rng = Math.random) {
  const pick = spec === "random" ? GEOMETRY_POOL[Math.floor(rng() * GEOMETRY_POOL.length)] : spec;
  const m = /^(\d+)x(\d+)$/u.exec(pick);
  if (!m) fail(`geometry must be <cols>x<rows> or random, got ${spec}`);
  return { cols: Number(m[1]), rows: Number(m[2]), drawn: spec === "random" };
}

const git = (args) => (spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout ?? "").trim();

async function runOnce({ opts, scenario, runIndex, runDir }) {
  mkdirSync(runDir, { recursive: true });
  const framesDir = join(runDir, "frames");
  mkdirSync(framesDir, { recursive: true });
  const geometry = drawGeometry(opts.geometry);

  // Project state: a fresh seeded directory per run, or the caller's own.
  let projectDir = opts.project;
  let seed = null;
  if (projectDir === null) {
    projectDir = join(runDir, "project");
    rmSync(projectDir, { recursive: true, force: true });
    seed = (await applySeed(opts.seed, projectDir)).toJSON();
    // seed.json is a publishable stream like the cast and the receipt (A10):
    // its write is deferred to the end-of-run scan gate below, not done here.
  }

  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...opts.env };
  delete env.ARBOR_TUI_RENDERER; // the receipt must reflect --renderer, not an inherited override
  delete env.NO_COLOR;
  const cmd = ["bun", LAUNCHER, "tui", "--renderer", opts.renderer, "--notification-mechanism", "off", ...(opts.resume ? ["--resume"] : []), ...opts.tuiArgs];

  const session = new PtySession({ cmd, cwd: projectDir, env, cols: geometry.cols, rows: geometry.rows }).start();
  const startedAt = Date.now();
  const log = [];
  const note = (kind, detail = "") => { const entry = { elapsed_ms: session.elapsedMs, kind, detail }; log.push(entry); console.log(`[pilot r${runIndex}] ${String(entry.elapsed_ms).padStart(6)}ms ${kind}${detail ? `: ${detail}` : ""}`); };

  // Frames are deduplicated at capture: a tick whose screen equals the
  // previous frame records only its sha, so `frames/` holds moments and the
  // tick log still supports per-tick rate arithmetic (EC-044).
  const frames = []; const ticks = [];
  let lastSha = null; let currentStep = null;
  const onTick = (snap) => {
    ticks.push({ elapsed_ms: session.elapsedMs, sha256: snap.sha256, step: currentStep });
    if (snap.sha256 === lastSha) return;
    lastSha = snap.sha256;
    const index = frames.length;
    const base = join(framesDir, `f${String(index).padStart(4, "0")}`);
    const caption = `f${String(index).padStart(4, "0")}  ${geometry.cols}x${geometry.rows}  ${opts.renderer}  +${(session.elapsedMs / 1000).toFixed(1)}s  ${currentStep ?? "startup"}`;
    const written = writeSnapshotFiles(snap, base, { png: opts.png, caption });
    frames.push({ index, file: `frames/${basename(base)}`, elapsed_ms: session.elapsedMs, sha256: snap.sha256, step: currentStep, cursor: snap.cursor, png: written.png });
  };

  note("launch", `${geometry.cols}x${geometry.rows} renderer=${opts.renderer} resume=${opts.resume} seed=${seed?.preset ?? "(project)"} cwd=${projectDir}`);
  const budgetMs = opts.budgetS * 1000;
  const steps = [];
  let breakReason = null;
  for (const [i, step] of scenario.steps.entries()) {
    if (session.elapsedMs > budgetMs) { note("budget-exhausted"); breakReason = "budget-exhausted"; break; }
    if (session.exited) { note("session-exited", `code ${session.exitCode}`); breakReason = "session-exited"; break; }
    currentStep = step.label ?? `step ${i}`;
    session.mark(`step ${i}: ${currentStep}`);
    const record = { index: i, label: currentStep, frame_start: frames.length, tick_start: ticks.length, actions: [] };
    if (step.wait_for !== undefined) {
      const requestedMs = (step.timeout_s ?? 60) * 1000;
      const timeoutMs = clampToDeadline(requestedMs, session.elapsedMs, budgetMs);
      if (timeoutMs < requestedMs) note("budget-clamped", `${currentStep} wait_for ${requestedMs}ms -> ${timeoutMs}ms remaining`);
      const raw = await session.waitFor(buildWaitPattern(step.wait_for, step.fail_on), { timeoutMs, intervalMs: opts.intervalMs, onTick });
      const result = classifyWaitResult(raw, step.fail_on);
      record.actions.push({ wait_for: step.wait_for, ...(step.fail_on === undefined ? {} : { fail_on: step.fail_on }), matched: result.matched, reason: result.reason });
      note(result.matched ? "matched" : "timeout", `${currentStep}${result.matched ? "" : result.reason === "fail_on" ? ` — fail_on /${step.fail_on}/ hit` : ` — never matched /${step.wait_for}/`}`);
    }
    if (step.resize !== undefined) {
      session.resize(step.resize.cols, step.resize.rows); geometry.cols = step.resize.cols; geometry.rows = step.resize.rows;
      record.actions.push({ resize: step.resize }); note("resize", `${step.resize.cols}x${step.resize.rows}`);
    }
    if (step.type !== undefined) { session.write(step.type); record.actions.push({ type: step.type }); note("type", JSON.stringify(step.type.slice(0, 48))); }
    for (const key of step.key === undefined ? [] : [step.key]) {
      const encoded = encodeKey(key, { kitty: step.kitty ?? opts.kitty });
      session.write(encoded.bytes);
      record.actions.push({ key, bytes: describeBytes(encoded.bytes), encoding: encoded.encoding, lossy: encoded.lossy });
      note("key", `${key} -> ${describeBytes(encoded.bytes)}${encoded.lossy ? " (LOSSY: modifier not expressible)" : ""}`);
    }
    for (const key of step.keys ?? []) {
      const encoded = encodeKey(key, { kitty: step.kitty ?? opts.kitty });
      session.write(encoded.bytes);
      record.actions.push({ key, bytes: describeBytes(encoded.bytes), encoding: encoded.encoding, lossy: encoded.lossy });
      note("key", `${key} -> ${describeBytes(encoded.bytes)}`);
      if (step.key_gap_ms) await Bun.sleep(step.key_gap_ms);
    }
    if (step.raw !== undefined) {
      // Exact bytes, e.g. a terminal's XTVERSION reply replayed byte by byte (EC-044).
      const bytes = JSON.parse(`"${step.raw}"`);
      if (step.raw_byte_gap_ms) { for (const ch of bytes) { session.write(ch); await Bun.sleep(step.raw_byte_gap_ms); } }
      else session.write(bytes);
      record.actions.push({ raw: describeBytes(bytes), byte_gap_ms: step.raw_byte_gap_ms ?? 0 }); note("raw", describeBytes(bytes));
    }
    if (step.hold_s) {
      const requestedMs = step.hold_s * 1000;
      const holdMs = clampToDeadline(requestedMs, session.elapsedMs, budgetMs);
      if (holdMs < requestedMs) note("budget-clamped", `${currentStep} hold_s ${requestedMs}ms -> ${holdMs}ms remaining`);
      await session.hold(holdMs, { intervalMs: opts.intervalMs, onTick });
      record.actions.push({ hold_s: step.hold_s, held_ms: holdMs });
    }
    record.frame_end = frames.length; record.tick_end = ticks.length;
    steps.push(record);
  }
  const stepAccounting = computeStepAccounting({ declaredSteps: scenario.steps.length, executedSteps: steps.length, breakReason });
  const earlyExitExpected = scenario.early_exit_expected === true;
  const incompleteIsFailure = isIncompleteScenarioFailure({ skippedSteps: stepAccounting.skipped_steps, breakReason, earlyExitExpected });
  if (stepAccounting.skipped_steps > 0) note("scenario-incomplete", `${stepAccounting.executed_steps}/${stepAccounting.declared_steps} steps ran (${breakReason})${incompleteIsFailure ? "" : " — declared early_exit_expected, not a failure"}`);
  currentStep = "final";
  onTick(await session.snapshot());
  note("captured", `${frames.length} frames over ${ticks.length} ticks`);

  const exitCode = await session.close();
  currentStep = "after-exit";
  onTick(await session.snapshot()); // what the terminal shows once the app has left the alternate screen
  note("exited", `code ${exitCode}`);

  // Pilot output is review evidence that may be shared. Every publishable
  // stream for this run — frame text, the asciicast byte stream, the seed
  // record, and the receipt itself (verbatim typed input lives in
  // steps[].actions[].type and in the "type" event_log note) — is scanned as
  // one set BEFORE any of it is written (A10). A scan failure withholds the
  // whole run: the frame files already on disk are removed, stream.cast and
  // seed.json are never written, and receipt.json carries only what the
  // scanner itself is safe to disclose (finding codes/line/column) plus step
  // accounting — never the run's actual content.
  const cast = session.asciicast();
  const frameText = frames.map((f) => readFileSync(join(runDir, `${f.file}.txt`), "utf8")).join("\n");
  const seedText = seed === null ? null : `${JSON.stringify(seed, null, 2)}\n`;

  const receiptCore = {
    kind: "revoy2.tui_pilot",
    recorded_at: new Date(startedAt).toISOString(),
    repo_revision: git(["rev-parse", "HEAD"]),
    repo_branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    repo_dirty_paths: git(["status", "--porcelain"]).split("\n").filter(Boolean).length,
    bun_version: process.versions.bun,
    scenario: { id: scenario.id, path: scenario.path, title: scenario.title ?? null, covers: scenario.covers ?? [] },
    seed: seed === null ? { preset: null, project: projectDir } : { preset: seed.preset, steps: seed.steps },
    geometry: { cols: geometry.cols, rows: geometry.rows, requested: opts.geometry, drawn_from_pool: geometry.drawn ? GEOMETRY_POOL : null },
    renderer: { requested: opts.renderer, observed: session.observedRenderer(), queries_observed: session.observedQueries() },
    launch: { cmd, cwd: projectDir, resume: opts.resume, env_overrides: redactEnv({ TERM: env.TERM, COLORTERM: env.COLORTERM, ...opts.env }), kitty_encoding: opts.kitty },
    interval_ms: opts.intervalMs,
    exit_code: exitCode,
    duration_ms: session.elapsedMs,
    raw_output_bytes: session.rawByteCount(),
    frame_count: frames.length,
    tick_count: ticks.length,
    frames, ticks, steps,
    step_accounting: { ...stepAccounting, early_exit_expected: earlyExitExpected, incomplete_is_failure: incompleteIsFailure },
    event_log: log,
  };
  const receipt = exportRunArtifacts({ runDir, framesDir, frameText, cast, seedText, receiptCore });
  if (!receipt.secret_scan.ok) note("secret-scan-failed", receipt.secret_scan.error);
  console.log(`[pilot r${runIndex}] wrote ${join(runDir, "receipt.json")}`);
  return receipt;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const scenario = loadScenario(opts.scenario);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  const out = opts.out ?? join("/mnt/sda2/revoy2/pilot", `${stamp}-${scenario.id}-${opts.project ? "project" : opts.seed}`);
  mkdirSync(out, { recursive: true });
  const receipts = [];
  for (let r = 1; r <= opts.runs; r++) {
    receipts.push(await runOnce({ opts, scenario, runIndex: r, runDir: join(out, `run-${String(r).padStart(2, "0")}`) }));
  }
  const summary = {
    kind: "revoy2.tui_pilot_summary",
    scenario: scenario.id, seed: opts.project ? null : opts.seed, renderer: opts.renderer, runs: receipts.length,
    min_runs_for_rate_claim: MIN_RUNS_FOR_RATE,
    rate_claims_permitted: receipts.length >= MIN_RUNS_FOR_RATE,
    per_run: receipts.map((r, i) => ({ run: i + 1, geometry: `${r.geometry.cols}x${r.geometry.rows}`, renderer_observed: r.renderer.observed, exit_code: r.exit_code, frames: r.frame_count, ticks: r.tick_count, timeouts: r.steps.flatMap((s) => s.actions).filter((a) => a.matched === false).length, secret_scan_failed: !r.secret_scan.ok, incomplete_scenario_failure: r.step_accounting.incomplete_is_failure })),
    renderer_mismatches: receipts.filter((r) => r.renderer.observed !== r.renderer.requested).length,
  };
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`[pilot] ${receipts.length} run(s) -> ${out}`);
  if (summary.renderer_mismatches > 0) console.log(`[pilot] WARNING: ${summary.renderer_mismatches} run(s) did not exhibit the requested renderer's byte fingerprint`);
  if (!summary.rate_claims_permitted) console.log(`[pilot] n=${receipts.length} < ${MIN_RUNS_FOR_RATE}: no rate claim may be made from this batch`);
  return out;
}

if (import.meta.main) {
  const out = await main();
  const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
  if (summary.renderer_mismatches > 0 || summary.per_run.some((run) => run.exit_code !== 0 || run.timeouts > 0 || run.secret_scan_failed || run.incomplete_scenario_failure)) process.exitCode = 1;
}
