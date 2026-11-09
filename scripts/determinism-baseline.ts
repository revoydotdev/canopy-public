#!/usr/bin/env node
/**
 * scripts/determinism-baseline.ts — does the same code give the same answer twice?
 *
 *   bun scripts/determinism-baseline.ts            # gate  (bun run gate:determinism)
 *   captest bun run determinism:measure-missing    # measure only newly cited seams
 *   captest bun run determinism:refresh            # deliberately remeasure every seam
 *   ... --json --repeat <n>
 *
 * THE AXIS. Every other gate here is a single-revision, single-run question:
 * does this symbol exist, is it reachable, does its proof resolve. None of them
 * can see a test that passes nine runs in ten. Today a flaky test and a solid
 * one are indistinguishable to every signal this repository produces — checked
 * on 2026-08-07, `package.json` has no script matching `perf|bench|latency|
 * profile`, and `gate:eval-regression` pins scripted determinism for the eval
 * harness only.
 *
 * That matters most where it is least visible. `gate:docs-truth` and
 * `gate:obligations` both discharge a completeness claim by pointing at a
 * `roundtrip=` test. If that test is flaky, the claim is discharged by
 * something that does not reliably hold — and both gates say so themselves:
 * they measure citation integrity, not correctness.
 *
 * SCOPE, CUT DELIBERATELY AND STATED RATHER THAN DISCOVERED:
 *   - Seams are ONLY the test files already cited by a `roundtrip=` proof. That
 *     is the population whose reliability a completeness claim depends on. The
 *     full suite is out of scope; measuring 189 files to learn about 68 would
 *     cost more and say less.
 *   - Flake rate and wall-clock only. ALLOCATION IS NOT MEASURED: per-file heap
 *     needs `--expose-gc` snapshots or process-level RSS sampling, neither cheap
 *     nor reliable, and a number that is wrong is worse than a number that is
 *     absent.
 *   - TOKEN DRIFT IS NOT MEASURED HERE. `packages/arbor-eval` and
 *     `gate:eval-regression` already own it. A second token counter would be
 *     the "two stores, two truths" failure `extract-exceptions.mjs` warns about.
 *
 * WHY MEASUREMENT NEVER RUNS IN CI OR PRE-PUSH. A flake rate captured on a
 * shared GitHub runner measures runner contention, not this code — the exact
 * noise this skill exists to distinguish from real nondeterminism. And it is
 * genuinely expensive. So `--refresh` is a manual, operator-invoked act; the
 * GATE reads the committed baseline and never runs a test.
 *
 * WORKSTATION CONSTRAINT. Run refresh under `captest` (memory-capped transient
 * scope). This script deliberately does NOT self-invoke `systemd-run`: wrapping
 * itself would be a new failure mode for marginal convenience, and the box
 * already has that convention.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@arbor/governance";
import { computeEvidenceContentHashForStore } from "./lib/store-provenance.mjs";
import { mergeMeasuredBaselines, selectSeamsToMeasure } from "./lib/determinism-refresh-policy.mjs";
import { assertEvidenceProducerAuthority, evidenceTransactionPaths } from "./evidence-transaction.mjs";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

// Bun runtime migration (docs/bun-migration-plan.md): vitest's worker pool
// depends on Node worker_threads semantics (e.g. `node:sqlite`) that Bun's
// shim does not fully provide — confirmed empirically running this gate's
// vitest child process under `bun` produces spurious failures that do not
// occur under Node. This gate itself may run under either `node` or `bun`
// (it is now invoked as `bun scripts/determinism-baseline.ts`), but the
// vitest child process it spawns below must always run under Node.
const VITEST_RUNNER = process.versions.bun ? "node" : process.execPath;
/** Overridable for fixture-based failure tests — see claim-ledger.ts's note. */
const STORE_DIR = process.env.REVOY2_DETERMINISM_DIR
  ? resolve(process.env.REVOY2_DETERMINISM_DIR)
  : join(REPO_ROOT, ".determinism-baseline");
const RUNS = join(STORE_DIR, "runs.jsonl");
const CURRENT = join(STORE_DIR, "current.jsonl");
const MANIFEST = join(STORE_DIR, "manifest.json");

const REFRESH_ALL = process.argv.includes("--refresh");
const REFRESH_MISSING = process.argv.includes("--refresh-missing");
const REFRESH = REFRESH_ALL || REFRESH_MISSING;
const JSON_OUT = process.argv.includes("--json");
const REPEAT = Number.parseInt(
  process.argv[process.argv.indexOf("--repeat") + 1] ?? "3", 10,
) || 3;

/**
 * A seam above this flake rate fails the gate. 20% is deliberately loose for a
 * first ceiling: the point is to catch a seam that is obviously unreliable, not
 * to litigate a single bad run out of twenty. Ratchet DOWN as evidence
 * accumulates; never up.
 */
const MAX_FLAKE_RATE = 0.2;

/**
 * Cited seams tolerated with no baseline at all.
 *
 * MEASURED 0 on 2026-08-07: all 64 cited seams were baselined at 3 runs each
 * under `captest`, and none was nondeterministic. Zero is therefore a real
 * floor, not an aspiration — it says every claim discharged by a `roundtrip=`
 * citation currently rests on a seam that has been observed to behave the same
 * way three times running.
 *
 * It rises only when a NEW `roundtrip=` citation appears without measurement,
 * which is DB-A's whole point. May FALL, must not RISE — the convention
 * POL_04_FLOOR set.
 */
const DETERMINISM_FLOOR = 0;

/** Days after which a baseline is reported stale. Reported, never gated — see the ceiling note. */
const STALE_DAYS = 30;

interface SeamBaseline {
  id: string;
  roundtrip_path: string;
  measured_at: string;
  git_revision: string;
  node_version: string;
  repeat_count: number;
  pass_count: number;
  fail_count: number;
  flake_rate: number;
  wall_clock_ms_median: number;
  wall_clock_ms_spread_pct: number;
  nondeterministic: boolean;
}

const SEAM_KEYS: (keyof SeamBaseline)[] = [
  "id", "roundtrip_path", "measured_at", "git_revision", "node_version",
  "repeat_count", "pass_count", "fail_count", "flake_rate",
  "wall_clock_ms_median", "wall_clock_ms_spread_pct", "nondeterministic",
];

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const e = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${e.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
const seamId = (path: string) => `seam:${sha256Hex(path).slice(0, 16)}`;

function git(args: string[]): string {
  try { return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim(); }
  catch { return ""; }
}

/**
 * The cited-seam set: every `roundtrip=` path in ROADMAP.md or an ADR. This is
 * the join key `docs-truth.mjs` and `obligations-gate.ts` already use, so the
 * three agree on what a seam is without a fourth definition existing anywhere.
 */
function citedSeams(): string[] {
  const sources = [join(REPO_ROOT, "ROADMAP.md")];
  const decisions = join(REPO_ROOT, "decisions");
  if (existsSync(decisions)) {
    for (const f of readdirSync(decisions)) if (f.endsWith(".md")) sources.push(join(decisions, f));
  }
  const seams = new Set<string>();
  for (const file of sources) {
    if (!existsSync(file)) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/roundtrip=([^\s>`)]+)/g)) {
      const p = m[1].trim();
      // Only real, existing test files. A citation that does not resolve is
      // already `gate:obligations`'s M-B finding; re-reporting it here would be
      // a second opinion on a question that gate already settles.
      if (/\.test\.[cm]?[jt]sx?$/.test(p) && existsSync(join(REPO_ROOT, p))) seams.add(p);
    }
  }
  return [...seams].sort();
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Seams that vitest structurally cannot run, and which therefore must not be
 * measured with it.
 *
 * `@opentui/core`'s native render library does not initialize under Node, and
 * vitest executes tests in Node workers even when vitest itself is launched
 * via `bun x` (verified on both runtimes, 2026-08-07). These files are excluded
 * from `vitest.config.ts` for that reason and run under `bun test` instead
 * (`bun run test:opentui`). They are legitimately cited by ADR-036/ADR-037 as
 * `roundtrip=` proofs, so they ARE cited seams — measuring them with the wrong
 * runner would record a 100% flake rate for tests that pass every time on the
 * runner they belong to, which is a false failure, not a measurement.
 */
const BUN_ONLY_SEAM = /(^|\/)opentui-[^/]*\.test\.ts$/;

/**
 * Socket-owning suites whose result is not independent when Vitest schedules
 * them in the same worker batch as every other cited seam.
 *
 * `webui.test.ts` repeatedly appeared as an all-fail 35--51 ms file in the
 * 208-file evidence batch while passing its 44 tests in ~300 ms both alone
 * and in the ordinary full suite. That duration is a collection/setup result,
 * not an execution of the seam. Keep the broad batch parallel, but give this
 * one file its own Vitest process so the baseline measures the seam rather
 * than cross-file socket/process interference.
 */
const ISOLATED_VITEST_SEAMS = new Set([
  "packages/arbor-mcp/tests/webui.test.ts",
]);

function measure(seams: string[]): SeamBaseline[] {
  const perFile = new Map<string, { pass: number; fail: number; durations: number[] }>();
  for (const s of seams) perFile.set(s, { pass: 0, fail: 0, durations: [] });

  const vitestSeams = seams.filter((s) => !BUN_ONLY_SEAM.test(s));
  const bunSeams = seams.filter((s) => BUN_ONLY_SEAM.test(s));
  const isolatedVitestSeams = vitestSeams.filter((s) => ISOLATED_VITEST_SEAMS.has(s));
  const batchedVitestSeams = vitestSeams.filter((s) => !ISOLATED_VITEST_SEAMS.has(s));

  const recordVitestInvocation = (requestedSeams: string[], result: ReturnType<typeof spawnSync>, label: string): void => {
    let report: { testResults?: { name: string; status: string; startTime: number; endTime: number; message?: string }[] };
    try {
      report = JSON.parse(String(result.stdout).slice(String(result.stdout).indexOf("{")));
    } catch {
      process.stderr.write(`[determinism] ${label} produced unparseable reporter output — recorded as a failed run for ${requestedSeams.length} seam(s)\n`);
      for (const seam of requestedSeams) perFile.get(seam)!.fail++;
      return;
    }
    const seen = new Set<string>();
    for (const tr of report.testResults ?? []) {
      const rel = tr.name.replace(`${REPO_ROOT}/`, "");
      const entry = perFile.get(rel);
      if (!entry || !requestedSeams.includes(rel)) continue;
      seen.add(rel);
      if (tr.status === "passed") entry.pass++;
      else {
        entry.fail++;
        const detail = tr.message?.trim().split("\n")[0];
        process.stderr.write(`[determinism] ${label} failed ${rel}${detail ? ` — ${detail}` : ""}\n`);
      }
      entry.durations.push(Math.max(0, Math.round(tr.endTime - tr.startTime)));
    }
    // A requested seam Vitest did not report did not pass. Silence is not a
    // pass — the same rule `vi-validate` applies to an unmakeable comparison.
    for (const rel of requestedSeams) if (!seen.has(rel)) perFile.get(rel)!.fail++;
  };

  for (let run = 1; run <= REPEAT; run++) {
    // Bun-only seams first, so a `bun test` failure is attributed to the seam
    // rather than swallowed by the vitest reporter parse below.
    for (const seam of bunSeams) {
      const started = Date.now();
      const r = spawnSync("bun", ["test", seam], { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
      const entry = perFile.get(seam)!;
      if (r.status === 0) entry.pass++; else entry.fail++;
      entry.durations.push(Math.max(0, Date.now() - started));
    }
    if (vitestSeams.length === 0) continue;
    process.stderr.write(`[determinism] run ${run}/${REPEAT} over ${seams.length} seam(s)...\n`);
    // One vitest invocation per repeat, not one per file: 3 process starts
    // instead of one per file, while socket/process-sensitive seams get a
    // dedicated process rather than forcing all 208 files to run serially.
    // Run isolated seams first. The isolation is specifically from transient
    // resources left behind by the broad batch; a fresh process started after
    // that batch can still collide with a descendant or socket that is in the
    // middle of teardown.
    for (const seam of isolatedVitestSeams) {
      const result = spawnSync(
        VITEST_RUNNER,
        [join(REPO_ROOT, "node_modules/.bin/vitest"), "run", "--reporter=json", seam],
        { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
      );
      recordVitestInvocation([seam], result, `run ${run} isolated`);
    }
    if (batchedVitestSeams.length > 0) {
      const result = spawnSync(
        VITEST_RUNNER,
        [join(REPO_ROOT, "node_modules/.bin/vitest"), "run", "--reporter=json", ...batchedVitestSeams],
        { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
      );
      recordVitestInvocation(batchedVitestSeams, result, `run ${run} batch`);
    }
  }

  const at = new Date().toISOString();
  const rev = git(["rev-parse", "HEAD"]);
  return seams.map((path) => {
    const e = perFile.get(path)!;
    const total = e.pass + e.fail;
    const med = median(e.durations);
    const spread = med > 0 && e.durations.length > 1
      ? Math.round(((Math.max(...e.durations) - Math.min(...e.durations)) / med) * 100)
      : 0;
    return {
      id: seamId(path), roundtrip_path: path, measured_at: at, git_revision: rev,
      node_version: process.version, repeat_count: total,
      pass_count: e.pass, fail_count: e.fail,
      flake_rate: total ? Number((e.fail / total).toFixed(4)) : 1,
      wall_clock_ms_median: med, wall_clock_ms_spread_pct: spread,
      // Mixed pass AND fail across identical runs is the signature. All-fail is
      // a broken test, which the suite already reports; this axis is about
      // instability, and conflating the two would make every red test "flaky".
      nondeterministic: e.pass > 0 && e.fail > 0,
    };
  });
}

function readCurrent(): Map<string, SeamBaseline> {
  const map = new Map<string, SeamBaseline>();
  if (!existsSync(CURRENT)) return map;
  for (const line of readFileSync(CURRENT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line) as SeamBaseline; map.set(r.roundtrip_path, r); } catch { /* skip */ }
  }
  return map;
}

function writeStores(baselines: SeamBaseline[], measured: SeamBaseline[]): void {
  mkdirSync(STORE_DIR, { recursive: true });
  const render = (r: SeamBaseline) => `{${SEAM_KEYS.map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`).join(",")}}`;
  const sorted = [...baselines].sort((a, b) => (a.id < b.id ? -1 : 1));
  writeFileSync(CURRENT, sorted.length ? `${sorted.map(render).join("\n")}\n` : "", "utf8");
  // Append only measurements made by THIS invocation. Retained rows already
  // exist in history; duplicating all of them makes incremental repair look
  // like a remeasurement that never happened.
  const measuredSorted = [...measured].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (measuredSorted.length > 0) {
    writeFileSync(RUNS, (existsSync(RUNS) ? readFileSync(RUNS, "utf8") : "") + `${measuredSorted.map(render).join("\n")}\n`, "utf8");
  }
  // The revision this store describes. Without it nothing can say how far the
  // baseline trails HEAD, and a manual producer with no staleness signal is a
  // store that quietly stops being true — see gate:store-freshness.
  writeFileSync(MANIFEST, `${JSON.stringify({
    schema_version: 1,
    scanned_up_to_revision: git(["rev-parse", "HEAD"]),
    content_hash: computeEvidenceContentHashForStore(REPO_ROOT, "determinism-baseline"),
    measured_at: new Date().toISOString(),
    seam_count: baselines.length,
  }, null, 2)}\n`, "utf8");
}

function main(): number {
  // The evidence lease exists to serialise WRITES to derived governance
  // stores. `measure()` below writes nothing — it spawns test runners and
  // reads their reports — but it is the longest-running step in the whole
  // rebind chain (193 seams x 3 repeats, ~9 minutes of test time per repeat).
  // Holding the repo-wide lease across it blocked every read-side gate in
  // every worktree for that entire window, repeatedly, for no protection at
  // all: three gates failed together on a held lease six times in one session.
  //
  // So acquire late, just before the only write. A DELEGATED producer is the
  // exception: its parent already owns the lease for the whole transaction, so
  // there is nothing to release, and its identity guard (candidate OID and
  // input digest must match the lease) is worth failing on BEFORE spending
  // nine minutes measuring the wrong candidate.
  const delegated = REFRESH && existsSync(evidenceTransactionPaths(REPO_ROOT).lock);
  if (delegated) assertEvidenceProducerAuthority(REPO_ROOT);
  const seams = citedSeams();

  if (REFRESH) {
    const current = readCurrent();
    const selected = selectSeamsToMeasure(seams, current, REFRESH_ALL);
    if (selected.length === 0) {
      console.log("determinism baseline — no unmeasured cited seams; nothing to measure");
      return 0;
    }
    const measured = measure(selected);
    const baselines = mergeMeasuredBaselines(seams, current, measured);
    if (!delegated) assertEvidenceProducerAuthority(REPO_ROOT);
    writeStores(baselines, measured);
    const flaky = measured.filter((b) => b.nondeterministic);
    console.log(`determinism baseline — measured ${measured.length}/${seams.length} cited seam(s), ${REPEAT} run(s) each${REFRESH_ALL ? " (full refresh)" : " (missing only)"}`);
    console.log(`  nondeterministic: ${flaky.length}`);
    for (const f of flaky) console.log(`    ${f.roundtrip_path}  ${f.pass_count} pass / ${f.fail_count} fail`);
    console.log(`  wrote ${CURRENT.replace(`${REPO_ROOT}/`, "")} and appended to ${RUNS.replace(`${REPO_ROOT}/`, "")}`);
    return 0;
  }

  const current = readCurrent();
  const unmeasured = seams.filter((s) => !current.has(s));
  const flaky = [...current.values()].filter((b) => b.flake_rate > MAX_FLAKE_RATE);
  const nondet = [...current.values()].filter((b) => b.nondeterministic);
  const stale = [...current.values()].filter((b) => {
    const age = (Date.now() - Date.parse(b.measured_at)) / 86_400_000;
    return Number.isFinite(age) && age > STALE_DAYS;
  });

  const failures: string[] = [];
  if (flaky.length > 0) {
    failures.push(`DB-B: ${flaky.length} seam(s) above the ${Math.round(MAX_FLAKE_RATE * 100)}% flake ceiling:\n` +
      flaky.map((f) => `         ${f.roundtrip_path}  flake_rate=${f.flake_rate}`).join("\n"));
  }
  if (unmeasured.length > DETERMINISM_FLOOR) {
    failures.push(`DB-R: ${unmeasured.length} cited seam(s) with no baseline, above the floor of ${DETERMINISM_FLOOR} — run \`captest bun run determinism:measure-missing\``);
  }

  const report = {
    ok: failures.length === 0, cited_seams: seams.length, measured: current.size,
    unmeasured: unmeasured.length, nondeterministic: nondet.length,
    above_flake_ceiling: flaky.length, stale: stale.length, floor: DETERMINISM_FLOOR,
  };
  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return report.ok ? 0 : 1; }

  console.log(`determinism baseline gate — ${seams.length} cited seam(s), ${current.size} with a baseline`);
  console.log(`  unmeasured: ${unmeasured.length} (floor ${DETERMINISM_FLOOR})`);
  console.log(`  nondeterministic (mixed pass/fail across identical runs): ${nondet.length}`);
  console.log(`  above the ${Math.round(MAX_FLAKE_RATE * 100)}% flake ceiling: ${flaky.length}`);
  if (stale.length) console.log(`  stale (>${STALE_DAYS}d): ${stale.length} — reported, not gated`);
  console.log("");
  console.log("  Strength: REPORTED, not PREVENTED, and the weakest of this repository's gates by");
  console.log("  design. It reads a committed baseline produced by a separate, deliberately manual");
  console.log("  refresh; a green run means the LAST measurement was within tolerance and says nothing");
  console.log("  about code changed since. Measurement never runs in CI or pre-push on purpose — a");
  console.log("  flake rate captured on a shared runner measures runner contention, not this code.");
  console.log("  Flake rate and wall-clock only: allocation is not measured (unreliable to obtain),");
  console.log("  and token drift belongs to gate:eval-regression, not here.");
  console.log("");
  if (failures.length === 0) { console.log("PASS"); return 0; }
  for (const f of failures) console.log(`FAIL — ${f}`);
  return 1;
}

process.exitCode = main();
