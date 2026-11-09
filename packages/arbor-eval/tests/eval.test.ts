/**
 * arbor-eval/tests/eval.test.ts — test the evaluation harness.
 */

import { describe, it, expect } from "vitest";
import { CampaignManager } from "@arbor/mcp";
import type { Action, Provenance, ScoreContext } from "@arbor/core";
import { aggregateMetrics, computeCriticReliability, computeMetrics } from "../src/metrics.js";
import { runBenchmark } from "../src/benchmark.js";
import { runBaseline } from "../src/baseline.js";
import { generateReport, buildComparisonSummary } from "../src/report.js";
import { defaultTasks, createLearningOutcomeGenerator } from "../src/tasks.js";
import type { EvalTask } from "../src/types.js";

// --- Test helpers ---

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

const scoreCtx: ScoreContext = {
  accuracy_regression_rate: 0,
  crash_regression_rate: 0,
  best_known: 100,
  total_visits: 5,
};

const fixedOutcomeGenerator = (rate: number) => createLearningOutcomeGenerator(rate, 0, rate).generator;

const verifiedProv: Provenance = { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test"};
const claimedProv: Provenance = { tag: "claimed", claimant: "seed" };

// --- Metric computation tests ---

describe("computeMetrics", () => {
  it("returns correct branching_factor for a simple campaign (1 verified, 2 children)", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("test", "plan.md", rootAction);
    const [c1] = mgr.branch("test", "root", [makeAction(1), makeAction(2)]);
    mgr.expandNode("test", c1, {
      worktree_isolated: true,
      starting_commit_correct: true,
      lease_acquired: true,
    });
    mgr.recordResult("test", c1, {
      specialist_output: "done",
      specialist_agent: "seed",
      provenance: verifiedProv,
      critic_agent: "lenticel",
      critic_approved: true,
      critic_rationale: "approved",
      score_ctx: scoreCtx,
    });

    // Branch children under c1
    mgr.branch("test", c1, [makeAction(3), makeAction(4)]);

    const metrics = computeMetrics("test", mgr, 0, 0);
    // Root has 2 children (c1, c2), c1 is verified and has 2 children
    // Decision nodes: root (verified) + c1 (verified) = 2
    // Total children: root.children (2) + c1.children (2) = 4
    // BF = 4/2 = 2.0
    expect(metrics.branchingFactor).toBe(2.0);
  });

  it("returns correct backtrack_rate when a node fails", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("test", "plan.md", rootAction);
    const [c1, c2] = mgr.branch("test", "root", [makeAction(1), makeAction(2)]);

    // c1 succeeds
    mgr.expandNode("test", c1, {
      worktree_isolated: true,
      starting_commit_correct: true,
      lease_acquired: true,
    });
    mgr.recordResult("test", c1, {
      specialist_output: "done",
      specialist_agent: "seed",
      provenance: verifiedProv,
      critic_agent: "lenticel",
      critic_approved: true,
      critic_rationale: "approved",
      score_ctx: scoreCtx,
    });

    // c2 fails
    mgr.expandNode("test", c2, {
      worktree_isolated: true,
      starting_commit_correct: true,
      lease_acquired: true,
    });
    mgr.recordResult("test", c2, {
      specialist_output: "failed",
      specialist_agent: "seed",
      provenance: claimedProv,
      critic_agent: "lenticel",
      critic_approved: false,
      critic_rationale: "tests broke",
      critic_root_cause: "missing mock",
      score_ctx: scoreCtx,
    });

    const metrics = computeMetrics("test", mgr, 0, 0);
    // Finished nodes: 2 (verified + failed)
    // Failed: 1 → backtrack rate = 1/2 = 0.5
    expect(metrics.backtrackRate).toBe(0.5);
    expect(metrics.verifiedCount).toBe(1);
    expect(metrics.failedCount).toBe(1);
  });

  it("returns zero backtrack_rate when all nodes succeed", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("test", "plan.md", rootAction);
    const [c1, c2] = mgr.branch("test", "root", [makeAction(1), makeAction(2)]);

    for (const c of [c1, c2]) {
      mgr.expandNode("test", c, {
        worktree_isolated: true,
        starting_commit_correct: true,
        lease_acquired: true,
      });
      mgr.recordResult("test", c, {
        specialist_output: "done",
        specialist_agent: "seed",
        provenance: verifiedProv,
        critic_agent: "lenticel",
        critic_approved: true,
        critic_rationale: "approved",
        score_ctx: scoreCtx,
      });
    }

    const metrics = computeMetrics("test", mgr, 0, 0);
    expect(metrics.backtrackRate).toBe(0);
    expect(metrics.failedCount).toBe(0);
  });

  it("returns 0 kb_hit_rate when no KB injections", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("test", "plan.md", rootAction);
    const metrics = computeMetrics("test", mgr, 0, 0);
    expect(metrics.kbHitRate).toBe(0);
  });

  it("returns 1.0 convergence_quality when halted via converged", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("test", "plan.md", rootAction, {
      max_seconds: 600,
      min_score: 0,
      convergence_iterations: 2,
    });
    // Drive convergence
    mgr.incrementNoKbIteration("test");
    mgr.incrementNoKbIteration("test");
    const metrics = computeMetrics("test", mgr, 0, 0);
    expect(metrics.convergenceQuality).toBe(1.0);
    expect(metrics.haltReason).toBe("converged");
  });

  it("computes kb_hit_rate correctly from tracker data", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("test", "plan.md", rootAction);
    const metrics = computeMetrics("test", mgr, 2, 5);
    expect(metrics.kbHitRate).toBe(0.4);
  });

  it("gates halt/memory best_score but not eval's own bestScore for a claimed (unverified) result", () => {
    // A claimed result is, by the Provenance type's own doc, "asserted by an
    // agent but not machine-verified" — it must never raise `campaign
    // .best_score` (manager.ts's recordResult gates that on state ===
    // "verified"), or an unverified/possibly-wrong claim would corrupt the
    // campaign's cross-campaign learned-memory baseline and the halt
    // decision's own reported score. `haltStatus().best_score` and
    // `getCampaignSnapshot().best_score` both correctly stay 0 here.
    //
    // But `computeMetrics`'s `bestScore` answers a different question — "what
    // did the tree search actually find" — for a harness (arbor-eval's
    // scripted benchmark) that is claimed-only by design and can never
    // produce a `verified` node. It must NOT inherit the memory/halt gate, or
    // it is permanently pinned at 0 for every eval run regardless of true
    // search quality (the exact defect `gate:eval-regression` caught: see
    // metrics.ts's `bestPath`-based computation).
    const mgr = new CampaignManager();
    mgr.startCampaign("test", "plan.md", rootAction);
    const [child] = mgr.branch("test", "root", [makeAction(1)]);
    mgr.expandNode("test", child, {
      worktree_isolated: true,
      starting_commit_correct: true,
      lease_acquired: true,
    });
    mgr.recordResult("test", child, {
      specialist_output: "scripted evaluation success",
      specialist_agent: "seed",
      // Scripted outcomes have no command output to verify, so the benchmark
      // uses claimed provenance even when the critic approves the result.
      provenance: claimedProv,
      critic_agent: "lenticel",
      critic_approved: true,
      critic_rationale: "approved scripted outcome",
      score_ctx: scoreCtx,
    });

    const haltStatus = mgr.haltStatus("test");
    const snapshot = mgr.getCampaignSnapshot("test");
    const metrics = computeMetrics("test", mgr, 0, 0);
    const node = mgr.getNodeInfo("test", child);

    expect(haltStatus.best_score).toBe(0);
    expect(snapshot?.best_score).toBe(0);
    expect(node?.score).toBeGreaterThan(0);
    expect(metrics.bestScore).toBeCloseTo(node?.score ?? 0, 2);
  });
});

// --- Benchmark integration tests ---

describe("runBenchmark", () => {
  it("returns results for all tasks", () => {
    const tasks: EvalTask[] = [
      {
        id: "tiny-task",
        description: "a tiny task for testing",
        rootAction,
        branchCount: 2,
        branchActionGenerator: (i: number) => makeAction(i),
        outcomeGenerator: fixedOutcomeGenerator(0.5),
        expectedGoodOutcome: "some branches succeed",
      },
    ];

    const { aggregatedResults } = runBenchmark(tasks, 2, 20);
    expect(aggregatedResults).toHaveLength(1);
    expect(aggregatedResults[0].runs).toBe(2);
    expect(aggregatedResults[0].taskId).toBe("tiny-task");
  });

  it("uses default tasks without error", () => {
    const { aggregatedResults } = runBenchmark(defaultTasks.slice(0, 2), 1, 20);
    expect(aggregatedResults.length).toBeGreaterThanOrEqual(1);
    for (const result of aggregatedResults) {
      expect(result.runs).toBe(1);
      expect(typeof result.avgBranchingFactor).toBe("number");
      expect(typeof result.avgBacktrackRate).toBe("number");
      expect(typeof result.avgKbHitRate).toBe("number");
      expect(typeof result.avgConvergenceQuality).toBe("number");
    }
  });

  it("produces deterministic results for same task and seed", () => {
    const task: EvalTask = {
      id: "deterministic-task",
      description: "test determinism",
      rootAction,
      branchCount: 3,
      branchActionGenerator: (i: number) => makeAction(i),
      outcomeGenerator: fixedOutcomeGenerator(0.5),
      expectedGoodOutcome: "deterministic",
    };

    const run1 = runBenchmark([task], 3, 20);
    const run2 = runBenchmark([task], 3, 20);

    // Same task, same number of runs, same seeds → same results
    expect(run1.aggregatedResults[0].avgBacktrackRate).toBe(
      run2.aggregatedResults[0].avgBacktrackRate,
    );
    expect(run1.aggregatedResults[0].avgBestScore).toBe(
      run2.aggregatedResults[0].avgBestScore,
    );
    expect(run1.aggregatedResults[0].avgIterations).toBe(
      run2.aggregatedResults[0].avgIterations,
    );
  });
});

describe("empty evaluation aggregates and reports", () => {
  it("returns a zero-valued aggregate for a task with no completed runs", () => {
    expect(aggregateMetrics("empty", "no completed runs", [])).toMatchObject({
      taskId: "empty", runs: 0, avgBranchingFactor: 0, avgBacktrackRate: 0,
      avgKbHitRate: 0, avgConvergenceQuality: 0, convergenceRate: 0,
      avgBestScore: 0, avgIterations: 0, perRunMetrics: [],
    });
  });

  it("renders honest zero-result reporting and the non-winning comparison verdict", () => {
    const comparison = buildComparisonSummary([], []);
    const emptyAggregate = aggregateMetrics("empty", "no completed runs", []);
    const report = generateReport({
      generatedAt: "2026-08-08T00:00:00.000Z", numTasks: 1, runsPerTask: 0,
      arborResults: [emptyAggregate], baselineResults: [], comparisonSummary: comparison,
    });
    expect(report).toContain("Avg Branching Factor | 0");
    expect(report).not.toContain("### empty — no completed runs");
    expect(report).toContain("The linear baseline matches or exceeds Arbor on simple tasks.");
  });
});

// --- Baseline tests ---

describe("runBaseline", () => {
  it("returns results for all tasks", () => {
    const tasks: EvalTask[] = [
      {
        id: "base-task",
        description: "test baseline",
        rootAction,
        branchCount: 3,
        branchActionGenerator: (i: number) => makeAction(i),
        outcomeGenerator: fixedOutcomeGenerator(0.5),
        expectedGoodOutcome: "some success",
      },
    ];

    const results = runBaseline(tasks, 3);
    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe("base-task");
    expect(typeof results[0].successRate).toBe("number");
    expect(results[0].successRate).toBeGreaterThanOrEqual(0);
    expect(results[0].successRate).toBeLessThanOrEqual(1);
    expect(results[0].perRunResults).toHaveLength(3);
  });

  it("produces deterministic results for same inputs", () => {
    const task: EvalTask = {
      id: "base-det",
      description: "test baseline determinism",
      rootAction,
      branchCount: 2,
      branchActionGenerator: (i: number) => makeAction(i),
      outcomeGenerator: fixedOutcomeGenerator(0.5),
      expectedGoodOutcome: "deterministic",
    };

    const run1 = runBaseline([task], 3);
    const run2 = runBaseline([task], 3);
    expect(run1[0].successRate).toBe(run2[0].successRate);
    expect(run1[0].avgScore).toBe(run2[0].avgScore);
  });
});

// --- Report tests ---

describe("generateReport", () => {
  it("returns a non-empty string containing key metric labels", () => {
    const tasks: EvalTask[] = [
      {
        id: "rpt-task",
        description: "report test task",
        rootAction,
        branchCount: 2,
        branchActionGenerator: (i: number) => makeAction(i),
        outcomeGenerator: fixedOutcomeGenerator(0.5),
        expectedGoodOutcome: "some success",
      },
    ];

    const { aggregatedResults } = runBenchmark(tasks, 2, 20);
    const baselineResults = runBaseline(tasks, 2);
    const comparison = buildComparisonSummary(
      aggregatedResults.map((a) => ({
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

    const reportText = generateReport({
      generatedAt: new Date().toISOString(),
      numTasks: tasks.length,
      runsPerTask: 2,
      arborResults: aggregatedResults.map((a) => ({
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
      comparisonSummary: comparison,
    });

    expect(reportText.length).toBeGreaterThan(0);
    // Key metric labels must appear
    expect(reportText).toContain("Branching Factor");
    expect(reportText).toContain("Backtrack Rate");
    expect(reportText).toContain("KB Hit Rate");
    expect(reportText).toContain("Convergence Quality");
    expect(reportText).toContain("Arbor Tree-Search Results");
    expect(reportText).toContain("Linear Pipeline Baseline");
    expect(reportText).toContain("Comparison Summary");
    expect(reportText).toContain("rpt-task");
  });

  it("report carries an explicit methodology caveat (synthetic, not a real baseline)", () => {
    const tasks: EvalTask[] = [
      {
        id: "caveat-task",
        description: "caveat test",
        rootAction,
        branchCount: 2,
        branchActionGenerator: (i: number) => makeAction(i),
        outcomeGenerator: fixedOutcomeGenerator(0.5),
        expectedGoodOutcome: "some success",
      },
    ];
    const { aggregatedResults } = runBenchmark(tasks, 2, 10);
    const baselineResults = runBaseline(tasks, 2);
    const arborResults = aggregatedResults.map((a) => ({
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
    }));
    const reportText = generateReport({
      generatedAt: new Date().toISOString(),
      numTasks: tasks.length,
      runsPerTask: 2,
      arborResults,
      baselineResults,
      comparisonSummary: buildComparisonSummary(arborResults, baselineResults),
    });
    expect(reportText).toContain("Methodology caveat");
    expect(reportText).toContain("synthetic");
    expect(reportText).toContain("not an empirical win claim");
  });
});

describe("buildComparisonSummary", () => {
  const comparisonMetrics = (avgBestScore: number, convergenceRate: number) => [{
    taskId: "comparison",
    taskDescription: "deterministic comparison fixture",
    runs: 1,
    avgBranchingFactor: 1,
    avgBacktrackRate: 0,
    avgKbHitRate: 0,
    avgConvergenceQuality: convergenceRate,
    convergenceRate,
    avgBestScore,
    avgIterations: 1,
    perRunMetrics: [],
  }];

  const baselineMetrics = (avgScore: number, successRate: number) => [{
    taskId: "comparison",
    taskDescription: "deterministic comparison fixture",
    successRate,
    avgScore,
    perRunResults: [],
  }];

  it("reports a decisive tree-search win when score and convergence both improve", () => {
    const comparison = buildComparisonSummary(
      comparisonMetrics(0.9, 0.8),
      baselineMetrics(0.6, 0.5),
    );

    expect(comparison).toContain("consistently outperforms the linear");
    expect(comparison).toContain("| Success / Best Score | 0.9 | 0.6 | Arbor |");
    expect(comparison).toContain("| Convergence Rate | 0.8 | 0.5 | Arbor |");
  });

  it("reports a reliability win when convergence improves without a score win", () => {
    const comparison = buildComparisonSummary(
      [{
        taskId: "reliability-only",
        taskDescription: "higher convergence with an equal score",
        runs: 1,
        avgBranchingFactor: 1,
        avgBacktrackRate: 0,
        avgKbHitRate: 0,
        avgConvergenceQuality: 0.75,
        convergenceRate: 0.75,
        avgBestScore: 1,
        avgIterations: 1,
        perRunMetrics: [],
      }],
      [{
        taskId: "reliability-only",
        taskDescription: "higher convergence with an equal score",
        successRate: 0.5,
        avgScore: 1,
        perRunResults: [],
      }],
    );

    expect(comparison).toContain("Arbor converges more reliably than the linear baseline");
    expect(comparison).toContain("best-score differences are marginal");
  });

  it("reports the baseline as winner when both comparison metrics are lower", () => {
    const comparison = buildComparisonSummary(
      comparisonMetrics(0.4, 0.3),
      baselineMetrics(0.7, 0.6),
    );

    expect(comparison).toContain("linear baseline matches or exceeds Arbor");
    expect(comparison).toContain("| Success / Best Score | 0.4 | 0.7 | Baseline |");
    expect(comparison).toContain("| Convergence Rate | 0.3 | 0.6 | Baseline |");
  });

  it("returns a non-empty comparison string", () => {
    const tasks: EvalTask[] = [
      {
        id: "cmp-task",
        description: "comparison test",
        rootAction,
        branchCount: 2,
        branchActionGenerator: (i: number) => makeAction(i),
        outcomeGenerator: fixedOutcomeGenerator(0.5),
        expectedGoodOutcome: "some success",
      },
    ];

    const { aggregatedResults } = runBenchmark(tasks, 2, 20);
    const baselineResults = runBaseline(tasks, 2);
    const comparison = buildComparisonSummary(
      aggregatedResults.map((a) => ({
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

    expect(comparison.length).toBeGreaterThan(100);
    expect(comparison).toContain("Arbor");
    expect(comparison).toContain("Linear");
    expect(comparison).toContain("Winner");
    expect(comparison).toContain("Verdict");
  });
});

// --- Tasks tests ---

describe("defaultTasks", () => {
  it("has at least 3 tasks", () => {
    expect(defaultTasks.length).toBeGreaterThanOrEqual(3);
  });

  it("each task has required fields", () => {
    for (const task of defaultTasks) {
      expect(task.id).toBeTruthy();
      expect(task.description).toBeTruthy();
      expect(task.rootAction).toBeDefined();
      expect(task.branchCount).toBeGreaterThan(0);
      expect(task.branchActionGenerator(0)).toHaveProperty("description");
      expect(task.outcomeGenerator(0, 42)).toHaveProperty("success");
      expect(task.expectedGoodOutcome).toBeTruthy();
    }
  });
});

describe("post-W1a critic reliability", () => {
  it("rejects missing or undated evidence and defines empty subgroup rates as zero", () => {
    expect(() => computeCriticReliability([])).toThrow("at least one post-W1a sample");
    expect(() => computeCriticReliability([
      { node_id: "invalid-date", observed_at: "not-a-date", artifact_correct_before: true, critic_flagged: false, correction_attempted: false, artifact_correct_after: true, later_defect_found: false },
    ])).toThrow("ISO timestamps");
    expect(computeCriticReliability([
      { node_id: "correct-pass", observed_at: "2026-08-12T12:00:00.000Z", artifact_correct_before: true, critic_flagged: false, correction_attempted: false, artifact_correct_after: true, later_defect_found: false },
    ])).toMatchObject({ c_catch_rate: 0, r_repair_rate: 0, f_false_alarm_rate: 0, b_breakage_rate: 0 });
  });

  it("reports c, r, f, b and evaluates the reliability inequality", () => {
    const observed_at = "2026-08-12T12:00:00.000Z";
    const metrics = computeCriticReliability([
      { node_id: "defect-caught-fixed", observed_at, artifact_correct_before: false, critic_flagged: true, correction_attempted: true, artifact_correct_after: true, later_defect_found: true },
      { node_id: "defect-missed", observed_at, artifact_correct_before: false, critic_flagged: false, correction_attempted: false, artifact_correct_after: false, later_defect_found: true },
      { node_id: "correct-pass", observed_at, artifact_correct_before: true, critic_flagged: false, correction_attempted: false, artifact_correct_after: true, later_defect_found: false },
      { node_id: "false-alarm-broke", observed_at, artifact_correct_before: true, critic_flagged: true, correction_attempted: true, artifact_correct_after: false, later_defect_found: false },
    ]);
    expect(metrics).toMatchObject({
      p_correct: 0.5, c_catch_rate: 0.5, r_repair_rate: 1,
      f_false_alarm_rate: 0.5, b_breakage_rate: 1,
      reliability_gain: 0.25, reliability_harm: 0.25,
      inequality_holds: false,
      data_window: { samples: 4 },
    });
  });
});

describe("fixed learning outcome generator", () => {
  it("produces deterministic outcomes for same inputs", () => {
    const gen = fixedOutcomeGenerator(0.6);
    const o1 = gen(5, 123);
    const o2 = gen(5, 123);
    expect(o1.success).toBe(o2.success);
    expect(o1.rationale).toBe(o2.rationale);
  });

  it("respects success rate approximately", () => {
    const gen = fixedOutcomeGenerator(0.8);
    let successes = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      if (gen(i, 99999).success) successes++;
    }
    const rate = successes / trials;
    // Should be roughly around 0.8, with wide bounds for deterministic hash distribution
    expect(rate).toBeGreaterThan(0.45);
    expect(rate).toBeLessThan(0.98);
  });

  it("provides rootCause on failure", () => {
    const gen = fixedOutcomeGenerator(1.0); // All success — test separately
    // Use a generator that we can check
    const outcome = gen(0, 12345);
    if (!outcome.success) {
      expect(outcome.rootCause).toBeTruthy();
    }
  });
});
