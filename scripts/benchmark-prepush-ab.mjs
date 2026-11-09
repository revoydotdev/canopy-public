#!/usr/bin/env bun
/**
 * Same-revision, cold-snapshot A/B benchmark for the pre-push critical path.
 *
 * Arms:
 * - legacy_serial: the direct serial pre-control-plane hook body from
 *   c973d83931816aeb69acb0f8f125c89f8875c1cb, executed against today's
 *   candidate tree.
 * - profile_current: today's immutable declarative pre-push profile.
 *
 * This is a measurement tool, not a gate. Each trial makes and removes its own
 * detached worktree and runs a frozen install. The output is intentionally
 * required, atomically written, and refuses to overwrite an existing receipt.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus, freemem, hostname, loadavg, platform, release, totalmem } from "node:os";
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const LEGACY_GATES_BEFORE_DOCS = Object.freeze([
  ["gate:adr-registry"],
  ["gate:decision-queue"],
  ["gate:eval-regression"],
  ["gate:reachability"],
  ["gate:anti-stub:blocking"],
  ["gate:completion-depth"],
]);
const LEGACY_GATES_AFTER_DOCS = Object.freeze([
  ["gate:lockfile"],
  ["gate:typecheck-tests"],
  ["gate:vi-freshness"],
  ["gate:vi-reproducible"],
  ["gate:store-freshness"],
]);
// eb1238a17 introduced the control-plane delegating hook. Its parent is the
// last direct serial hook, retained here as an immutable comparison source.
const LEGACY_HOOK_COMMIT = "c973d83931816aeb69acb0f8f125c89f8875c1cb";
const LEGACY_HOOK_SHA256 = "38441c72cabd4a94e6223dde37cbc3704b8f43acad3ad2dee570d27daad7e805";
const LEGACY_ROSTER_SOURCE = `scripts/hooks/pre-push@${LEGACY_HOOK_COMMIT}`;
// 8019d moved the candidate build into enforcement's immutable battery and
// removed the redundant outer build from the production hook.
const CURRENT_HOOK_BUILD_TRANSITION = "8019d9801b21c920b0c632a8af602348eeafe096";
// ADR-147 made worktree hygiene read-only in 4d386fec. Rebind the source
// identity so the current arm measures that accepted production hook while
// retaining the original 8019d build-placement transition in the receipt.
const CURRENT_HOOK_SHA256 = "330033c9e58bb2123a6e21944999f04957b915b51464d1bdf1844d557347a1f8";
const ARMS = Object.freeze(["legacy_serial", "profile_current"]);

function fail(message) { throw new Error(`prepush A/B benchmark: ${message}`); }
function elapsed(started) { return Date.now() - started; }
function commandText(commandName, args, cwd, timeout = 1_800_000) {
  const started = Date.now();
  const result = spawnSync(commandName, args, { cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  return Object.freeze({
    ok: result.error === undefined && result.status === 0,
    exit_code: result.status ?? null,
    duration_ms: elapsed(started),
    output_tail: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-4_000),
    error: result.error?.message ?? null,
    stdout: result.stdout ?? "",
  });
}
function command(commandName, args, cwd, timeout = 1_800_000) {
  const result = commandText(commandName, args, cwd, timeout);
  const { stdout: _stdout, ...summary } = result;
  return Object.freeze(summary);
}
function git(repo, args) {
  const result = command("git", ["-C", repo, ...args], repo, 120_000);
  if (!result.ok) fail(`git ${args.join(" ")} failed: ${result.output_tail}`);
  return result.output_tail.trim();
}
function input(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? null);
}
function positiveInteger(value, flag) {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) fail(`${flag} must be a positive integer`);
  return Number(value);
}
function machine() {
  return Object.freeze({ hostname: hostname(), platform: platform(), release: release(), bun: Bun.version, cpus: cpus().length, loadavg: loadavg(), total_memory_bytes: totalmem(), free_memory_bytes: freemem() });
}
function parseProfileReceipt(output) {
  try { return JSON.parse(output); }
  catch { return null; }
}
function createTrialSnapshot(repo, candidate, label) {
  const root = mkdtempSync(join(tmpdir(), `revoy2-prepush-ab-${label}-`));
  const candidateRoot = join(root, "candidate");
  const created = command("git", ["-C", repo, "worktree", "add", "--detach", candidateRoot, candidate], repo, 120_000);
  if (!created.ok) { rmSync(root, { recursive: true, force: true }); fail(`could not create ${label} snapshot: ${created.output_tail}`); }
  return Object.freeze({ root, candidateRoot, cleanup: () => {
    command("git", ["-C", repo, "worktree", "remove", "--force", candidateRoot], repo, 120_000);
    rmSync(root, { recursive: true, force: true });
  } });
}
function frozenInstall(cwd) { return command("bun", ["install", "--frozen-lockfile"], cwd, 600_000); }
function runAdvisoryHygiene(cwd) {
  // Both hooks execute this before their blocking path. It belongs in wall time
  // but must not change either arm's pass/fail outcome.
  return command("bun", ["run", "gate:worktree-hygiene"], cwd);
}
function verifyLegacyHookSource(repo) {
  const result = commandText("git", ["-C", repo, "show", `${LEGACY_HOOK_COMMIT}:scripts/hooks/pre-push`], repo, 120_000);
  if (!result.ok) fail(`cannot read ${LEGACY_ROSTER_SOURCE}: ${result.output_tail}`);
  const hook = result.stdout;
  const digest = createHash("sha256").update(hook).digest("hex");
  if (digest !== LEGACY_HOOK_SHA256) fail(`historical hook SHA-256 differs from ${LEGACY_HOOK_SHA256}: ${digest}`);
  const orderedTokens = [
    "bun run gate:worktree-hygiene || true",
    "bun run build",
    ...LEGACY_GATES_BEFORE_DOCS.map(([gate]) => `bun run ${gate}`),
    "bun scripts/docs-truth.mjs --json > \"$DOCS_TRUTH_JSON\"",
    ...LEGACY_GATES_AFTER_DOCS.map(([gate]) => `bun run ${gate}`),
    "bun run gate:claim-ledger -- --docs-truth-json \"$DOCS_TRUTH_JSON\"",
  ];
  let cursor = -1;
  for (const token of orderedTokens) {
    cursor = hook.indexOf(token, cursor + 1);
    if (cursor === -1) fail(`historical hook lacks expected ordered command: ${token}`);
  }
  return Object.freeze({ source: LEGACY_ROSTER_SOURCE, sha256: digest, ordered_roster_verified: true });
}
function verifyCurrentHookSource(repo, candidate) {
  const source = `scripts/hooks/pre-push@${candidate}`;
  const result = commandText("git", ["-C", repo, "show", `${candidate}:scripts/hooks/pre-push`], repo, 120_000);
  if (!result.ok) fail(`cannot read ${source}: ${result.output_tail}`);
  const hook = result.stdout;
  const digest = createHash("sha256").update(hook).digest("hex");
  if (digest !== CURRENT_HOOK_SHA256) fail(`current hook SHA-256 differs from ${CURRENT_HOOK_SHA256}: ${digest}`);
  const orderedTokens = [
    "bun install --frozen-lockfile",
    "bun run gate:worktree-hygiene || true",
    "bun run enforcement:prepush -- --candidate \"$candidate_sha\"",
  ];
  let cursor = -1;
  for (const token of orderedTokens) {
    cursor = hook.indexOf(token, cursor + 1);
    if (cursor === -1) fail(`current hook lacks expected ordered command: ${token}`);
  }
  if (/^bun run build\s*$/m.test(hook)) fail("current hook unexpectedly restored an outer build; update the A/B model");
  return Object.freeze({ source, sha256: digest, ordered_roster_verified: true, outer_build: "absent; moved into immutable battery by 8019d980" });
}
function runLegacy(cwd) {
  const build = command("bun", ["run", "build"], cwd);
  if (!build.ok) return Object.freeze({ ok: false, build_ms: build.duration_ms, gates_ms: 0, phases: [{ id: "build", ...build }] });
  const phases = [];
  const gatesStarted = Date.now();
  for (const [gate] of LEGACY_GATES_BEFORE_DOCS) {
    const result = command("bun", ["run", gate], cwd);
    phases.push({ id: gate, ...result });
    if (!result.ok) return Object.freeze({ ok: false, build_ms: build.duration_ms, gates_ms: elapsed(gatesStarted), phases });
  }
  const docsRaw = commandText("bun", ["scripts/docs-truth.mjs", "--json"], cwd);
  const { stdout: docsText, ...docs } = docsRaw;
  phases.push({ id: "gate:docs-truth", ...docs });
  if (!docs.ok) return Object.freeze({ ok: false, build_ms: build.duration_ms, gates_ms: elapsed(gatesStarted), phases });
  const docsPath = join(cwd, ".arbor", "benchmark-docs-truth.json");
  try { writeFileSync(docsPath, docsText, "utf8"); }
  catch (error) { return Object.freeze({ ok: false, build_ms: build.duration_ms, gates_ms: elapsed(gatesStarted), phases: [...phases, { id: "docs-truth-receipt", ok: false, error: String(error) }] }); }
  for (const [gate] of LEGACY_GATES_AFTER_DOCS) {
    const result = command("bun", ["run", gate], cwd);
    phases.push({ id: gate, ...result });
    if (!result.ok) return Object.freeze({ ok: false, build_ms: build.duration_ms, gates_ms: elapsed(gatesStarted), phases });
  }
  const claims = command("bun", ["run", "gate:claim-ledger", "--", "--docs-truth-json", docsPath], cwd);
  phases.push({ id: "gate:claim-ledger", ...claims });
  return Object.freeze({ ok: claims.ok, build_ms: build.duration_ms, gates_ms: elapsed(gatesStarted), phases });
}
function runCurrent(cwd, candidate) {
  const raw = commandText("bun", ["run", "enforcement:prepush", "--", "--candidate", candidate], cwd);
  const { stdout, ...result } = raw;
  const receipt = parseProfileReceipt(stdout);
  const timings = receipt?.timing_ms;
  return Object.freeze({
    ok: result.ok && receipt?.ok === true,
    profile_ms: result.duration_ms,
    build_ms: typeof timings?.candidate_build === "number" ? timings.candidate_build : null,
    inner_build_ms: typeof timings?.candidate_build === "number" ? timings.candidate_build : null,
    gates_ms: typeof timings?.gates === "number" ? timings.gates : null,
    inner_snapshot_ms: typeof timings?.snapshot === "number" ? timings.snapshot : null,
    inner_install_ms: typeof timings?.dependency_install === "number" ? timings.dependency_install : null,
    status: receipt?.status ?? null,
    output_tail: result.output_tail,
  });
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}
function summarize(trials) {
  return Object.freeze(Object.fromEntries(ARMS.map((arm) => {
    const values = trials.filter((trial) => trial.arm === arm && trial.ok);
    const numeric = (field) => values.map((trial) => trial[field]).filter((value) => typeof value === "number");
    return [arm, {
      successful_runs: values.length,
      median_end_to_end_ms: median(numeric("end_to_end_ms")),
      median_outer_snapshot_ms: median(numeric("outer_snapshot_ms")),
      median_outer_install_ms: median(numeric("outer_install_ms")),
      median_advisory_hygiene_ms: median(numeric("advisory_hygiene_ms")),
      median_inner_snapshot_ms: median(numeric("inner_snapshot_ms")),
      median_inner_install_ms: median(numeric("inner_install_ms")),
      median_outer_build_ms: median(numeric("outer_build_ms")),
      median_inner_build_ms: median(numeric("inner_build_ms")),
      median_build_ms: median(numeric("build_ms")),
      median_gate_ms: median(numeric("gates_ms")),
      median_cleanup_ms: median(numeric("cleanup_ms")),
      median_critical_path_ms: median(numeric("critical_path_ms")),
    }];
  })));
}

const repo = resolve(input("--repo", process.cwd()));
const candidate = input("--candidate", "HEAD");
const output = input("--output");
const runs = positiveInteger(input("--runs", "3"), "--runs");
if (output === null) fail("--output <path> is required");
const outputPath = resolve(output);
if (existsSync(outputPath)) fail(`refusing to overwrite existing receipt ${outputPath}`);
if (runs !== 3) fail("this acceptance benchmark requires exactly --runs 3");
const candidateOid = git(repo, ["rev-parse", "--verify", `${candidate}^{commit}`]);
const toolRevision = git(repo, ["rev-parse", "HEAD"]);
const legacyHook = verifyLegacyHookSource(repo);
const currentHook = verifyCurrentHookSource(repo, candidateOid);

// AB / BA / AB prevents one arm from always receiving the coldest or busiest
// system. Trials remain sequential: concurrent builds/gates would measure
// self-contention, not the operator's pre-push path.
const schedule = ["legacy_serial", "profile_current", "profile_current", "legacy_serial", "legacy_serial", "profile_current"];
const receipt = { schema_version: 1, benchmark: "prepush_same_revision_ab", measured_at: new Date().toISOString(), tool_revision: toolRevision, candidate_oid: candidateOid, legacy_hook: legacyHook, current_hook: currentHook, methodology: { runs_per_arm: 3, schedule, outer_snapshot: "fresh detached worktree + frozen install per trial", advisory_preflight: "gate:worktree-hygiene is timed but non-blocking, matching both hook versions", current_arm: "production hook mirror: outer setup + hygiene, then enforcement:prepush (no outer build)", current_hook_build_transition: { commit: CURRENT_HOOK_BUILD_TRANSITION, effect: "candidate build is inside the inner immutable battery; the outer production hook has no redundant build" }, legacy_arm: "historical direct serial 13-gate hook body", caveat: "wall-clock measurements; no CPU pinning, cache flush, or background-load control" }, machine_at_start: machine(), trials: [] };

for (const [index, arm] of schedule.entries()) {
  const trialStarted = Date.now();
  const trial = { ordinal: index + 1, arm, candidate_oid: candidateOid, machine_at_start: machine() };
  const snapshotStarted = Date.now();
  const snapshot = createTrialSnapshot(repo, candidateOid, `${index + 1}-${arm}`);
  trial.outer_snapshot_ms = elapsed(snapshotStarted);
  try {
    const install = frozenInstall(snapshot.candidateRoot);
    trial.outer_install_ms = install.duration_ms;
    if (!install.ok) {
      Object.assign(trial, { ok: false, status: "outer_install_failed", output_tail: install.output_tail });
    } else {
      const hygiene = runAdvisoryHygiene(snapshot.candidateRoot);
      trial.advisory_hygiene_ms = hygiene.duration_ms;
      trial.advisory_hygiene_ok = hygiene.ok;
      if (arm === "legacy_serial") {
        const measured = runLegacy(snapshot.candidateRoot);
        Object.assign(trial, measured, { inner_snapshot_ms: 0, inner_install_ms: 0, outer_build_ms: measured.build_ms, inner_build_ms: 0, critical_path_ms: hygiene.duration_ms + measured.build_ms + measured.gates_ms, status: measured.ok ? "passed" : "failed" });
      } else {
        const measured = runCurrent(snapshot.candidateRoot, candidateOid);
        Object.assign(trial, measured, { outer_build_ms: 0, critical_path_ms: hygiene.duration_ms + measured.profile_ms, status: measured.ok ? "passed" : "failed" });
      }
    }
  } finally {
    const cleanupStarted = Date.now();
    snapshot.cleanup();
    trial.cleanup_ms = elapsed(cleanupStarted);
    trial.end_to_end_ms = elapsed(trialStarted);
    trial.machine_at_end = machine();
    receipt.trials.push(trial);
  }
}
receipt.machine_at_end = machine();
receipt.summary = summarize(receipt.trials);
receipt.ok = receipt.trials.length === 6 && receipt.trials.every((trial) => trial.ok === true)
  && ARMS.every((arm) => receipt.trials.filter((trial) => trial.arm === arm && trial.ok).length === 3);

mkdirSync(dirname(outputPath), { recursive: true });
const tempOutput = `${outputPath}.tmp-${process.pid}`;
writeFileSync(tempOutput, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
renameSync(tempOutput, outputPath);
process.stdout.write(`${JSON.stringify({ ok: receipt.ok, output: outputPath, candidate_oid: candidateOid, summary: receipt.summary }, null, 2)}\n`);
process.exitCode = receipt.ok ? 0 : 1;
