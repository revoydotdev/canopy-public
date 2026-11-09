/**
 * arbor-eval/tests/baseline-comparison.test.ts — Phase 5.2 tree-search vs linear baseline.
 *
 * Runs the existing evaluation harness end-to-end and asserts it produces the
 * baseline comparison output:
 *
 *   - runBenchmark produces aggregated tree-search metrics.
 *   - runBaseline produces linear-pipeline baseline results.
 *   - buildComparisonSummary produces an Arbor-vs-Linear comparison.
 *   - generateReport produces a report containing both result sections.
 *
 * This is a benchmark/test that asserts the eval suite runs and produces the
 * baseline comparison output. It is deterministic and bounded (small task set,
 * few runs, few iterations) — no wall-clock sleeps.
 */

import { describe, it, expect } from "vitest";
import type { Action } from "@arbor/core";
import { runBenchmark } from "../src/benchmark.js";
import { runBaseline } from "../src/baseline.js";
import { generateReport, buildComparisonSummary } from "../src/report.js";
import { defaultTasks, createLearningOutcomeGenerator } from "../src/tasks.js";
import type { EvalTask } from "../src/types.js";

const rootAction: Action = {
  description: "test plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

function makeAction(i: number): Action {
  return {
    description: `test action ${i}`,
    estimated_gain: 50,
    estimated_cost: 10,
    category: "refactor",
    delegate_to: "seed",
  };
}

function makeTask(id: string, description: string, branchCount: number): EvalTask {
  return {
    id,
    description,
    rootAction,
    branchCount,
    branchActionGenerator: (i: number) => makeAction(i),
    outcomeGenerator: createLearningOutcomeGenerator(0.6, 0, 0.6).generator,
    expectedGoodOutcome: "some branches succeed",
  };
}

describe("eval harness runs and produces baseline comparison output", () => {
  it("runBenchmark produces aggregated tree-search metrics", () => {
    const tasks = [makeTask("cmp-task", "comparison task", 3)];
    const { aggregatedResults } = runBenchmark(tasks, 2, 20);
    expect(aggregatedResults).toHaveLength(1);
    const result = aggregatedResults[0];
    expect(result.taskId).toBe("cmp-task");
    expect(result.runs).toBe(2);
    expect(typeof result.avgBranchingFactor).toBe("number");
    expect(typeof result.avgBacktrackRate).toBe("number");
    expect(typeof result.avgKbHitRate).toBe("number");
    expect(typeof result.avgConvergenceQuality).toBe("number");
    expect(typeof result.avgBestScore).toBe("number");
  });

  it("runBaseline produces linear-pipeline baseline results", () => {
    const tasks = [makeTask("base-task", "baseline task", 3)];
    const results = runBaseline(tasks, 2);
    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe("base-task");
    expect(results[0].successRate).toBeGreaterThanOrEqual(0);
    expect(results[0].successRate).toBeLessThanOrEqual(1);
    expect(results[0].perRunResults).toHaveLength(2);
  });

  it("buildComparisonSummary produces an Arbor-vs-Linear comparison", () => {
    const tasks = [makeTask("cmp-task", "comparison task", 3)];
    const { aggregatedResults } = runBenchmark(tasks, 2, 20);
    const baselineResults = runBaseline(tasks, 2);
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
    expect(comparison).toContain("Arbor");
    expect(comparison).toContain("Linear");
    expect(comparison).toContain("Winner");
    expect(comparison).toContain("Verdict");
  });

  it("generateReport contains both the tree-search and baseline sections", () => {
    const tasks = [makeTask("rpt-task", "report task", 3)];
    const { aggregatedResults } = runBenchmark(tasks, 2, 20);
    const baselineResults = runBaseline(tasks, 2);
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
    const report = generateReport({
      generatedAt: new Date().toISOString(),
      numTasks: tasks.length,
      runsPerTask: 2,
      arborResults: aggregatedResults.map((a) => ({
        taskId: a.taskId, taskDescription: a.taskDescription, runs: a.runs,
        avgBranchingFactor: a.avgBranchingFactor, avgBacktrackRate: a.avgBacktrackRate,
        avgKbHitRate: a.avgKbHitRate, avgConvergenceQuality: a.avgConvergenceQuality,
        convergenceRate: a.convergenceRate, avgBestScore: a.avgBestScore, avgIterations: a.avgIterations,
        perRunMetrics: a.perRunMetrics,
      })),
      baselineResults,
      comparisonSummary: comparison,
    });
    expect(report).toContain("Arbor Tree-Search Results");
    expect(report).toContain("Linear Pipeline Baseline");
    expect(report).toContain("Comparison Summary");
    expect(report).toContain("rpt-task");
  });

  it("default tasks run through the full harness without error", () => {
    const tasks = defaultTasks.slice(0, 2);
    const { aggregatedResults } = runBenchmark(tasks, 1, 15);
    const baselineResults = runBaseline(tasks, 1);
    expect(aggregatedResults.length).toBeGreaterThanOrEqual(1);
    expect(baselineResults).toHaveLength(tasks.length);
  });
});
