#!/usr/bin/env node
/**
 * arbor-eval CLI — run the evaluation benchmark and print a report.
 *
 * Usage:
 *   bun packages/arbor-eval/src/cli.ts [--tasks <n>] [--runs <n>] [--max-iterations <n>] [--output <dir>]
 *     [--scenario-fixture <path>] [--analytics-fixture <path>]
 *     [--reuse-ledger-dir <dir> --reuse-ledger-id <id>]
 *   bun packages/arbor-eval/src/cli.ts governance-friction <fixture.json> <report.json>
 *     Writes the typed JSON report and a denominator-explicit sibling Markdown report.
 *
 * An analytics fixture may contain `reuse_ledger_observations`. Those
 * provenance-carrying evaluation inputs are replayed only when both ledger
 * flags explicitly select an eval artifact store; they never alter campaign
 * state or Crown scoring.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runBenchmark } from "./benchmark.js";
import { runBaseline } from "./baseline.js";
import { generateReport, buildComparisonSummary } from "./report.js";
import { defaultTasks } from "./tasks.js";
import { evaluateGovernedScenarios } from "./governed-scenarios.js";
import { evaluateAnalytics, parseEvalAnalyticsFixture } from "./analytics.js";
import type { EvalReport, GovernedEvalScenario } from "./types.js";
import { runLiveCli } from "./live-cli.js";
import { runFrontierInterfaceCli, runFrontierInterfaceNativeCli } from "./frontier-interface-cli.js";
import { createFrontierFlashCatalogAttestation } from "./frontier-flash-profile.js";
import { evaluateGovernanceFriction, generateGovernanceFrictionReport } from "./governance-friction.js";
import { evaluatePairedEconomy, generatePairedEconomyReport } from "./paired-economy-eval.js";

const FRONTIER_FLASH_CATALOG_URL = "https://openrouter.ai/api/v1/model/deepseek/deepseek-v4-flash-0731";

export function parseArgs(argv: string[]): {
  taskCount: number;
  runsPerTask: number;
  maxIterations: number;
  outputDir: string;
  scenarioFixture: string | null;
  analyticsFixture: string | null;
  reuseLedgerDir: string | null;
  reuseLedgerId: string | null;
} {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i];
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
      args.set(key, val);
      if (val !== "true") i++;
    }
  }

  return {
    taskCount: parseInt(args.get("--tasks") ?? "5", 10),
    runsPerTask: parseInt(args.get("--runs") ?? "3", 10),
    maxIterations: parseInt(args.get("--max-iterations") ?? "50", 10),
    outputDir: args.get("--output") ?? ".arbor/eval",
    scenarioFixture: args.get("--scenario-fixture") ?? null,
    analyticsFixture: args.get("--analytics-fixture") ?? null,
    reuseLedgerDir: args.get("--reuse-ledger-dir") ?? null,
    reuseLedgerId: args.get("--reuse-ledger-id") ?? null,
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  if (argv[0] === "economy-paired") {
    const fixturePath = argv[1];
    const reportPath = argv[2];
    if (fixturePath === undefined || reportPath === undefined) throw new Error("usage: arbor-eval economy-paired <fixture.json> <report.json>");
    const report = evaluatePairedEconomy(JSON.parse(readFileSync(fixturePath, "utf-8")) as Parameters<typeof evaluatePairedEconomy>[0]);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    const markdownPath = reportPath.replace(/\.json$/i, "") + ".md";
    writeFileSync(markdownPath, `${generatePairedEconomyReport(report)}\n`, "utf-8");
    console.log(`Paired economy report: ${reportPath}`);
    console.log(`Markdown summary: ${markdownPath}`);
    return;
  }
  if (argv[0] === "governance-friction") {
    const fixturePath = argv[1];
    const reportPath = argv[2];
    if (fixturePath === undefined || reportPath === undefined) throw new Error("usage: arbor-eval governance-friction <fixture.json> <report.json>");
    const report = evaluateGovernanceFriction(JSON.parse(readFileSync(fixturePath, "utf-8")) as unknown);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    const markdownPath = reportPath.replace(/\.json$/i, "") + ".md";
    writeFileSync(markdownPath, generateGovernanceFrictionReport(report), "utf-8");
    console.log(`Governance friction report: ${reportPath}`);
    console.log(`Markdown summary: ${markdownPath}`);
    return;
  }
  if (argv[0] === "frontier-flash-attestation") {
    const sourcePath = argv[1];
    const destinationPath = argv[2];
    if (sourcePath === undefined || destinationPath === undefined) {
      throw new Error("usage: arbor-eval frontier-flash-attestation <catalog-document.json> <attestation.json> [checked-at]");
    }
    const checkedAt = argv[3] ?? new Date().toISOString();
    const outcome = createFrontierFlashCatalogAttestation({
      catalog_model: JSON.parse(readFileSync(sourcePath, "utf-8")) as unknown,
      checked_at: checkedAt,
      source_url: FRONTIER_FLASH_CATALOG_URL,
    });
    if (outcome.status !== "ready") {
      throw new Error(`frontier Flash catalog document rejected: ${outcome.reason}`);
    }
    mkdirSync(dirname(destinationPath), { recursive: true });
    writeFileSync(destinationPath, `${JSON.stringify(outcome.attestation, null, 2)}\n`, "utf-8");
    console.error(`Frontier Flash catalog attestation written to: ${destinationPath}`);
    return;
  }
  if (argv[0] === "frontier-interface") {
    if (
      argv[1] === "record-native"
      || argv[1] === "record-native-corpus"
      || argv[1] === "record-runtime-roundtrip"
      || argv[1] === "record-original-interface-baseline"
      || argv[1] === "record-current-legacy-native-candidate"
      || argv[1] === "benchmark-native"
    ) {
      void runFrontierInterfaceNativeCli(argv.slice(1)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      });
      return;
    }
    process.exitCode = runFrontierInterfaceCli(argv.slice(1));
    return;
  }
  // ADR-095: the live-model lane is an explicit, separate subcommand — never
  // the default path. `eval:report`/`gate:eval-regression` invoke this CLI
  // with no leading positional argument and must keep running the free,
  // deterministic scripted benchmark exactly as before; only an operator
  // typing `arbor-eval live ...` (or CI's slower, paid, non-every-push job)
  // reaches the live lane. See live-cli.ts for its own credential handling.
  if (argv[0] === "live") {
    runLiveCli(argv.slice(1)).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
    return;
  }
  const opts = parseArgs(argv);
  if ((opts.reuseLedgerDir === null) !== (opts.reuseLedgerId === null)) {
    throw new Error("--reuse-ledger-dir and --reuse-ledger-id must be supplied together");
  }

  // Signal handling — graceful shutdown on SIGINT/SIGTERM
  let shuttingDown = false;
  const onSignal = (signal: string) => {
    if (shuttingDown) {
      console.error(`\nForce exiting on second ${signal}.`);
      process.exit(1);
    }
    shuttingDown = true;
    console.error(`\n${signal} received, shutting down gracefully...`);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  // Select tasks
  const tasks = defaultTasks.slice(0, Math.min(opts.taskCount, defaultTasks.length));
  if (tasks.length === 0) {
    console.error("No tasks selected.");
    process.exit(1);
  }

  console.error(`Running benchmark: ${tasks.length} tasks × ${opts.runsPerTask} runs each...`);

  // Run Arbor benchmark
  const arborStart = Date.now();
  const arborResult = runBenchmark(tasks, opts.runsPerTask, opts.maxIterations);
  const arborElapsed = Date.now() - arborStart;

  if (shuttingDown) {
    console.error("Shutdown before baseline completed — partial results available.");
    process.exit(arborResult.aggregatedResults.length > 0 ? 0 : 1);
  }

  // Run baseline
  const baselineStart = Date.now();
  const baselineResults = runBaseline(tasks, opts.runsPerTask);
  const baselineElapsed = Date.now() - baselineStart;

  if (shuttingDown) {
    console.error("Shutdown before report generated — partial results available.");
    process.exit(0);
  }

  // Build comparison
  const comparisonSummary = buildComparisonSummary(
    arborResult.aggregatedResults.map((a) => ({
      taskId: a.taskId,
      taskDescription: a.taskDescription,
      runs: a.runs,
      avgBranchingFactor: a.avgBranchingFactor,
      avgBacktrackRate: a.avgBacktrackRate,
      avgKbHitRate: a.avgKbHitRate,
      avgConvergenceQuality: a.avgConvergenceQuality,
      convergenceRate: a.convergenceRate,
      avgBestScore: a.avgBestScore,
      avgIterations: a.avgIterations,
      perRunMetrics: a.perRunMetrics,
    })),
    baselineResults,
  );

  // Build report
  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    numTasks: tasks.length,
    runsPerTask: opts.runsPerTask,
    arborResults: arborResult.aggregatedResults.map((a) => ({
      taskId: a.taskId,
      taskDescription: a.taskDescription,
      runs: a.runs,
      avgBranchingFactor: a.avgBranchingFactor,
      avgBacktrackRate: a.avgBacktrackRate,
      avgKbHitRate: a.avgKbHitRate,
      avgConvergenceQuality: a.avgConvergenceQuality,
      convergenceRate: a.convergenceRate,
      avgBestScore: a.avgBestScore,
      avgIterations: a.avgIterations,
      perRunMetrics: a.perRunMetrics,
    })),
    baselineResults,
    comparisonSummary,
  };

  const analytics = opts.analyticsFixture === null ? null : evaluateAnalytics(
    parseEvalAnalyticsFixture(JSON.parse(readFileSync(opts.analyticsFixture, "utf-8")) as unknown),
    opts.reuseLedgerDir === null ? undefined : { dir: opts.reuseLedgerDir, id: opts.reuseLedgerId! },
  );
  const reportText = generateReport(report, analytics ?? undefined);

  // Add timing info
  const timingLines = [
    "",
    "## Timing",
    "",
    `Arbor benchmark: ${arborElapsed}ms`,
    `Linear baseline: ${baselineElapsed}ms`,
    "",
  ];

  const fullReport = reportText + timingLines.join("\n");

  // Write to output file
  const outputPath = join(opts.outputDir, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  mkdirSync(opts.outputDir, { recursive: true });
  writeFileSync(outputPath, fullReport, "utf-8");

  // An explicit fixture opt-in keeps deterministic scenario accounting
  // separate from measured provider cost: it never creates a model client.
  if (opts.scenarioFixture !== null) {
    const scenarios = JSON.parse(readFileSync(opts.scenarioFixture, "utf-8")) as GovernedEvalScenario[];
    const scenarioPath = join(opts.outputDir, "governed-scenarios.json");
    writeFileSync(scenarioPath, `${JSON.stringify(evaluateGovernedScenarios(scenarios), null, 2)}\n`, "utf-8");
    console.error(`Governed scenario comparison written to: ${scenarioPath}`);
  }
  if (analytics !== null) {
    const analyticsPath = join(opts.outputDir, "advanced-analytics.json");
    writeFileSync(analyticsPath, `${JSON.stringify(analytics, null, 2)}\n`, "utf-8");
    console.error(`Advanced analytics written to: ${analyticsPath}`);
  }

  // Print to stdout
  console.log(fullReport);
  console.error(`\nReport written to: ${outputPath}`);
}

// Auto-run on every real invocation (`node cli.js`, `vite-node cli.ts`), but
// not when imported inside the vitest suite — vitest sets `process.env.VITEST`
// in its worker processes, and that's the one case this module gets `import`ed
// rather than executed. (An `import.meta.url`-vs-`process.argv[1]` entrypoint
// check was tried first and rejected: under `vite-node`, `process.argv[1]` is
// vite-node's own script path, not this file's, so that check silently never
// fired and the CLI stopped running at all under `npm run eval:report` /
// `gate:eval-regression` — confirmed by direct invocation before landing this.)
if (process.env.VITEST !== "true") {
  main();
}
