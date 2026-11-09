#!/usr/bin/env node
/**
 * arbor-eval/scripts/run-baseline-comparison.ts — Phase 5.2 benchmark script.
 *
 * Runs the tree-search benchmark and the linear-pipeline baseline over the
 * default task set, then prints the Arbor-vs-Linear comparison summary.
 *
 * Usage:
 *   npx tsx packages/arbor-eval/scripts/run-baseline-comparison.ts [--runs N] [--max-iterations N]
 *
 * Deterministic and bounded: seeds are derived from (taskId, run), so repeated
 * invocations produce identical comparison output.
 */

import { runBenchmark } from "../src/benchmark.js";
import { runBaseline } from "../src/baseline.js";
import { buildComparisonSummary } from "../src/report.js";
import { defaultTasks } from "../src/tasks.js";

function parseArgs(argv: string[]): { runsPerTask: number; maxIterations: number } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
      args.set(argv[i], val);
      if (val !== "true") i++;
    }
  }
  return {
    runsPerTask: parseInt(args.get("--runs") ?? "3", 10),
    maxIterations: parseInt(args.get("--max-iterations") ?? "50", 10),
  };
}

function main(): void {
  const { runsPerTask, maxIterations } = parseArgs(process.argv.slice(2));
  const tasks = defaultTasks;

  console.error(`Running ${tasks.length} tasks × ${runsPerTask} runs (max ${maxIterations} iterations)...`);

  const { aggregatedResults } = runBenchmark(tasks, runsPerTask, maxIterations);
  const baselineResults = runBaseline(tasks, runsPerTask);

  const comparison = buildComparisonSummary(
    aggregatedResults.map((a) => ({
      taskId: a.taskId, taskDescription: a.taskDescription, runs: a.runs,
      avgBranchingFactor: a.avgBranchingFactor, avgBacktrackRate: a.avgBacktrackRate,
      avgKbHitRate: a.avgKbHitRate, avgConvergenceQuality: a.avgConvergenceQuality,
      convergenceRate: a.convergenceRate, avgBestScore: a.avgBestScore, avgIterations: a.avgIterations,
      perRunMetrics: a.perRunMetrics,
    })),
    baselineResults,
  );

  console.log(comparison);
}

main();
