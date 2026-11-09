#!/usr/bin/env -S node
/**
 * scripts/eval-regression-gate.ts — G-12 CI wiring for arbor-eval.
 *
 * Before this script existed, `packages/arbor-eval` was a real harness
 * (compares tree-search against a linear baseline across four metrics, via
 * `packages/arbor-eval/src/cli.ts`) that nothing in CI ever ran. The unit
 * tests exercise `runBenchmark`/`runBaseline` against 1-2 tasks with a
 * handful of runs to prove the code paths work; none of them run the full
 * `defaultTasks` set the way a human invoking the CLI would, and none of
 * them fail the build if the tree-search algorithm's behavior silently
 * drifts.
 *
 * WHAT THIS GATES ON — read before trusting a green run here:
 * `defaultTasks`' outcomes come from `createOutcomeGenerator`/
 * `createLearningOutcomeGenerator` — deterministic seeded hash functions,
 * not live LLM calls (see `packages/arbor-eval/src/tasks.ts` and the
 * "Methodology caveat" `generateReport` prints on every report). That makes
 * this a REGRESSION DETECTOR for the tree-search loop's decision behavior
 * against a fixed synthetic scenario set — it proves branching, backtracking,
 * KB-injection convergence, and scoring still produce the same numbers they
 * did when this gate's expected values were pinned. It is NOT a quality
 * measure of real campaigns and must never be reported as one; a failure
 * here means "the algorithm's behavior on scripted tasks changed," not "the
 * product got worse."
 *
 * A failing run means one of two things: an intentional change to
 * scoring/branching/KB-injection/convergence logic — update EXPECTED below
 * with the new pinned values and note why in the commit — or a genuine
 * regression. Never widen TOLERANCE to make a red run green without reading
 * why the numbers moved.
 *
 * Run directly: `bun run gate:eval-regression`. Bun executes the workspace
 * TypeScript sources directly, so this gate does not need Vitest's vite-node
 * loader.
 *
 * Conservative bias (stated explicitly; D4b, §24.2 P8) — FAIL-CLOSED by
 * construction: every metric is checked against its pinned EXPECTED_* value
 * with a fixed, symmetric TOLERANCE (0.01), and any `delta > TOLERANCE` in
 * either direction is a REGRESSION. There is no ambiguity branch — the
 * comparison is deterministic (seeded hash generators, not live model
 * calls), so a "could not tell" case does not arise the way it does for an
 * AST-heuristic gate. Same direction as lockfile-check.mjs and
 * typecheck-tests.mjs: report every detected delta, never widen tolerance
 * silently to make a red run green (see the note above this file already
 * carries: "Never widen TOLERANCE... without reading why the numbers
 * moved").
 */
import { runBenchmark, runBaseline, defaultTasks, createPrefixReuseLedger, evaluateAnalytics, parseEvalAnalyticsFixture, recordPrefixReuseObservation, savePrefixReuseLedger } from "@arbor/eval";
import type { AggregatedMetrics, AggregatedBaseline } from "@arbor/eval";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNS_PER_TASK = 3;
const MAX_ITERATIONS = 50;
const TOLERANCE = 0.01;

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/** Redirects the advanced-analytics leg at a caller-supplied fixture; inert when absent. */
const ADVANCED_FIXTURE_PATH =
  argValue(process.argv, "--fixture") ??
  fileURLToPath(new URL("../packages/arbor-eval/fixtures/advanced-analytics.json", import.meta.url));

/** Pinned baseline — re-captured 2026-08-19 from a clean run of
 * `defaultTasks` at RUNS_PER_TASK=3, MAX_ITERATIONS=50 (the CLI's own
 * defaults). Verified byte-identical across two independent process
 * invocations before pinning (the harness's determinism claim, checked, not
 * assumed). Supersedes the 2026-08-04 pin (`avgBranchingFactor: 1.93,
 * avgBacktrackRate: 0.33, avgKbHitRate: 0.45, avgConvergenceQuality: 0.73,
 * convergenceRate: 0.73, avgBestScore: 3.33`) for two independent reasons:
 *
 * 1. `avgBestScore` was a metrics-plumbing defect, not real drift: since
 *    2026-08-07 (`21bc5cd`/`cde6500`), `haltStatus().best_score` only
 *    reports `campaign.best_score` when some node reached the (never-used-
 *    by-this-harness) `verified` state, and since 2026-08-14 (`3220c8ed`)
 *    `campaign.best_score` itself only rises on a `verified` result too —
 *    this scripted harness is claimed-only by design (`benchmark.ts`'s G-25
 *    comment: it has no real command to hash), so both fields were
 *    structurally pinned at 0 for every run regardless of true search
 *    quality. Fixed at the source (`packages/arbor-eval/src/metrics.ts`,
 *    `computeMetrics`): `bestScore` now reads the best-scoring
 *    verified-or-claimed node's own `score` off `manager.getBestPath()`,
 *    which is never gated by either fix's verified-only memory/halt
 *    concerns. `4.52` is that metric's first real (non-zero-by-construction)
 *    measurement since 2026-08-07.
 * 2. The other five metrics drifted independently, for an unrelated reason:
 *    roughly fifty commits touched `arbor-core/src/{scoring,tree}.ts` or
 *    `arbor-mcp/src/manager.ts` between the 2026-08-04 pin and this
 *    re-pinning (`git log --oneline 400611b..HEAD -- packages/arbor-core/src/
 *    scoring.ts packages/arbor-core/src/tree.ts packages/arbor-mcp/src/
 *    manager.ts`), including deliberate, individually-tested tree-search
 *    correctness fixes (e.g. `b59f7c5d`: scoring-sign correction, dead-node
 *    UCB exclusion, backtrack ancestor-walk fix, root-is-claimed-not-
 *    verified; `3220c8ed`: DAG-admission for `depends_on` actions). This
 *    gate is tiered `full` (`scripts/gate-all.mjs`) and was not run once in
 *    that entire window, so none of that drift was caught incrementally.
 *    `packages/arbor-core`'s own unit suite passes clean (285/285) against
 *    the current code, corroborating that the new numbers reflect intended,
 *    tested algorithm behavior rather than a live bug. No individual commit
 *    in that range was re-audited against this gate's five node/halt-derived
 *    metrics specifically — if any of them individually deserves scrutiny,
 *    that is a separate question from the `avgBestScore` defect this
 *    revision was scoped to fix. */
/*
 * RESOLVED 2026-08-19. The five metrics held earlier today are settled, and
 * four of them needed no pin at all.
 *
 * The hold was right. Re-pinning had been proposed for all five as "measured
 * drift"; investigation found a genuine PRODUCTION regression instead, in
 * manager.ts's convergence counter (commit 3220c8ed gated the success_pattern
 * KB write on isAcceptedForMemory but left the convergence reset keyed on
 * `learned`, which asks whether that write happened -- so `learned` was
 * permanently true and the counter reset every iteration). Traced: 12 of 15
 * campaigns never converged, 8 burned all 50 iterations.
 *
 * With that fixed, FOUR metrics returned to their exact 2026-08-04 values:
 * avgConvergenceQuality 0.73, convergenceRate 0.73, avgBacktrackRate 0.33,
 * avgKbHitRate 0.45. They were never drift -- all four were downstream of the
 * same bug. Absorbing them into a new pin would have encoded a live defect as
 * normal across four fields at once, which is exactly what
 * audit/eval-regression-disposition.md warned against.
 *
 * TWO residuals are genuine and are pinned here, both stable across repeated
 * runs:
 *   avgBranchingFactor 1.93 -> 1.88   (delta 0.05)
 *   avgBestScore       3.33 -> 3.20   (delta 0.13)
 * Small, same direction, and consistent with b59f7c5d's deliberate,
 * individually-tested scoring-sign/UCB/backtrack-walk corrections. Note
 * avgBestScore is NOT the 4.52 measured earlier today: that number was taken
 * while the convergence bug was still live, so campaigns ran their full
 * 50-iteration budget and found higher scores. 3.20 is the value with the loop
 * halting correctly, and it sits beside the original 3.33 rather than far from
 * it -- which is itself corroboration.
 *
 * What is NOT claimed: that each of the ~50 commits since the last pin was
 * individually audited. The claim is narrower and checkable -- the large
 * movements had one identified cause which is now fixed, and what remains is
 * small, stable, and directionally consistent with known scoring work.
 */
const EXPECTED_ARBOR = {
  avgBranchingFactor: 1.88,
  avgBacktrackRate: 0.33,
  avgKbHitRate: 0.45,
  avgConvergenceQuality: 0.73,
  convergenceRate: 0.73,
  avgBestScore: 3.2,
};
const EXPECTED_BASELINE = {
  successRate: 0.47,
  avgScore: 20.93,
};
/** Pinned from the bounded advanced fixture: lexical tie-breaking preserves alpha,
 * while the trace still exercises two materializations and two prefix reuses. */
const EXPECTED_ADVANCED_ANALYTICS = { best_configuration: "alpha", reuse_count: 2, reliability_gain: 0.5, reliability_harm: 0 };

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function overallArbor(results: AggregatedMetrics[]): typeof EXPECTED_ARBOR {
  return {
    avgBranchingFactor: round2(mean(results.map((r) => r.avgBranchingFactor))),
    avgBacktrackRate: round2(mean(results.map((r) => r.avgBacktrackRate))),
    avgKbHitRate: round2(mean(results.map((r) => r.avgKbHitRate))),
    avgConvergenceQuality: round2(mean(results.map((r) => r.avgConvergenceQuality))),
    convergenceRate: round2(mean(results.map((r) => r.convergenceRate))),
    avgBestScore: round2(mean(results.map((r) => r.avgBestScore))),
  };
}

function overallBaseline(results: AggregatedBaseline[]): typeof EXPECTED_BASELINE {
  return {
    successRate: round2(mean(results.map((r) => r.successRate))),
    avgScore: round2(mean(results.map((r) => r.avgScore))),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function main(): void {
  console.error(
    `Running eval regression gate: ${defaultTasks.length} scripted tasks × ${RUNS_PER_TASK} runs ` +
      `(max ${MAX_ITERATIONS} iterations) — deterministic, no live model calls.`,
  );

  const { aggregatedResults } = runBenchmark(defaultTasks, RUNS_PER_TASK, MAX_ITERATIONS);
  const baselineResults = runBaseline(defaultTasks, RUNS_PER_TASK);

  const actualArbor = overallArbor(aggregatedResults);
  const actualBaseline = overallBaseline(baselineResults);
  const advancedFixture = parseEvalAnalyticsFixture(JSON.parse(readFileSync(ADVANCED_FIXTURE_PATH, "utf8")) as unknown);
  const advancedLedgerDir = mkdtempSync(join(tmpdir(), "arbor-eval-regression-"));
  let advanced;
  let missingLedger;
  let corruptLedger;
  try {
    const ledger = recordPrefixReuseObservation(createPrefixReuseLedger("advanced-gate", { now: "2026-08-10T00:00:00.000Z" }), {
      operation_id: "advanced-gate-observation", observed_at: "2026-08-10T00:00:00.000Z", observation_kind: "materialized",
      prefix: { prefix_text: "fixture prefix", prompt_template_id: "advanced-fixture", token_units: 3, byte_length: 14 },
      target: { cluster_id: "core", item_id: "q1", config_id: "alpha" }, marginal_cost_token_units: 3,
      marginal_cost: { kind: "unpriced", reason: "deterministic fixture" }, provenance: { tag: "generated", generator: "arbor-eval/regression-gate", input_hash: "sha256:advanced-fixture" },
    });
    savePrefixReuseLedger(ledger, advancedLedgerDir);
    advanced = evaluateAnalytics(advancedFixture, { dir: advancedLedgerDir, id: "advanced-gate" });
    missingLedger = evaluateAnalytics(advancedFixture, { dir: advancedLedgerDir, id: "missing-gate" });
    mkdirSync(join(advancedLedgerDir, "eval-reuse-ledger"), { recursive: true });
    writeFileSync(join(advancedLedgerDir, "eval-reuse-ledger", "corrupt-gate.json"), "not json");
    corruptLedger = evaluateAnalytics(advancedFixture, { dir: advancedLedgerDir, id: "corrupt-gate" });
  } finally { rmSync(advancedLedgerDir, { recursive: true, force: true }); }

  let failed = false;
  const checks: Array<[string, number, number]> = [
    ...Object.entries(actualArbor).map(([k, v]) => [k, v, EXPECTED_ARBOR[k as keyof typeof EXPECTED_ARBOR]] as [string, number, number]),
    ...Object.entries(actualBaseline).map(([k, v]) => [`baseline.${k}`, v, EXPECTED_BASELINE[k as keyof typeof EXPECTED_BASELINE]] as [string, number, number]),
  ];

  for (const [key, actual, expected] of checks) {
    const delta = Math.abs(actual - expected);
    if (delta > TOLERANCE) {
      console.error(`REGRESSION  ${key}: actual=${actual} expected=${expected} (delta=${delta.toFixed(4)} > tolerance=${TOLERANCE})`);
      failed = true;
    } else {
      console.error(`ok          ${key}: ${actual}`);
    }
  }
  const advancedChecks: Array<[string, unknown, unknown]> = [
    ["advanced.best_configuration", advanced.agent_uct.best_configuration.join("/"), EXPECTED_ADVANCED_ANALYTICS.best_configuration],
    ["advanced.reuse_count", advanced.agent_uct.reuse_summary.totals.reuse_count, EXPECTED_ADVANCED_ANALYTICS.reuse_count],
    ["advanced.reliability_gain", advanced.critic_reliability.reliability_gain, EXPECTED_ADVANCED_ANALYTICS.reliability_gain],
    ["advanced.reliability_harm", advanced.critic_reliability.reliability_harm, EXPECTED_ADVANCED_ANALYTICS.reliability_harm],
    ["advanced.persisted_ledger", advanced.reuse_ledger?.totals.observation_count, 1],
    ["advanced.trajectory_manifest", advanced.run_manifest?.schema, "arbor.eval-run-manifest/v3"],
    ["advanced.trajectory_manifest_effective_tokens", advanced.run_manifest?.efficiency.effective_tokens, 0],
    ["advanced.provenance", advanced.provenance.tag, "generated"],
    ["advanced.missing_persisted_ledger_diagnostic", missingLedger.reuse_ledger === null && missingLedger.diagnostics.some((diagnostic) => diagnostic.code === "missing_reuse_ledger"), true],
    ["advanced.corrupt_persisted_ledger_diagnostic", corruptLedger.reuse_ledger === null && corruptLedger.diagnostics.some((diagnostic) => diagnostic.code === "invalid_json"), true],
  ];
  for (const [key, actual, expected] of advancedChecks) {
    if (actual !== expected) { console.error(`REGRESSION  ${key}: actual=${String(actual)} expected=${String(expected)}`); failed = true; }
    else console.error(`ok          ${key}: ${String(actual)}`);
  }

  if (failed) {
    console.error(
      "\nEval regression gate FAILED — the tree-search harness's behavior on the " +
        "fixed scripted task set changed. If this is an intentional consequence of " +
        "a scoring/branching/KB-injection/convergence change, update EXPECTED_* in " +
        "scripts/eval-regression-gate.ts and explain why in the commit. This does " +
        "NOT mean real campaign quality changed — see the header comment.",
    );
    process.exit(1);
  }

  console.error(
    "\nEval regression gate passed — tree-search decision behavior on scripted " +
      "tasks matches the pinned baseline. This is a scripted-determinism check, " +
      "not a live-model quality measurement.",
  );
}

main();
