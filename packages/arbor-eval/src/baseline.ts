/**
 * arbor-eval/baseline — linear pipeline baseline (no branching/backtracking).
 *
 * Processes tasks as a single-path sequential pipeline: each action is tried
 * one at a time. Success → continue to next step. Failure → the task fails.
 * No tree search, no backtracking, no KB injection.
 */

import type { EvalTask, BaselineResult } from "./types.js";

/**
 * Run a single task through a linear pipeline for one trial.
 * Tries each branch action in sequence. First success → task succeeds.
 * All fail → task fails.
 */
function runLinearPipeline(task: EvalTask, seed: number): BaselineResult {
  let bestScore = 0;

  for (let i = 0; i < task.branchCount; i++) {
    const outcome = task.outcomeGenerator(i, seed);

    if (outcome.success) {
      // In a linear pipeline, the first success is the result.
      // Score simulates the gain of the action that succeeded.
      const action = task.branchActionGenerator(i);
      bestScore = action.estimated_gain;
      return {
        taskId: task.id,
        taskDescription: task.description,
        success: true,
        score: bestScore,
      };
    }
  }

  return {
    taskId: task.id,
    taskDescription: task.description,
    success: false,
    score: 0,
  };
}

/**
 * Run all tasks through the linear baseline N times each.
 */
export function runBaseline(
  tasks: EvalTask[],
  runsPerTask: number,
): {
  taskId: string;
  taskDescription: string;
  successRate: number;
  avgScore: number;
  perRunResults: BaselineResult[];
}[] {
  const results: {
    taskId: string;
    taskDescription: string;
    successRate: number;
    avgScore: number;
    perRunResults: BaselineResult[];
  }[] = [];

  for (const task of tasks) {
    const perRunResults: BaselineResult[] = [];
    for (let run = 0; run < runsPerTask; run++) {
      const seed = computeBaselineSeed(task.id, run);
      perRunResults.push(runLinearPipeline(task, seed));
    }

    const successCount = perRunResults.filter((r) => r.success).length;
    const totalScore = perRunResults.reduce((s, r) => s + r.score, 0);

    results.push({
      taskId: task.id,
      taskDescription: task.description,
      successRate: Math.round((successCount / runsPerTask) * 100) / 100,
      avgScore: Math.round((totalScore / runsPerTask) * 100) / 100,
      perRunResults,
    });
  }

  return results;
}

/** Keep baseline randomness independent from tree-search benchmark randomness. */
function computeBaselineSeed(taskId: string, run: number): number {
  let hash = 2166136261;
  const input = `${taskId}:baseline:${run}`;
  for (let index = 0; index < input.length; index++) {
    hash = (hash ^ input.charCodeAt(index)) * 16777619;
    hash >>>= 0;
  }
  return hash;
}
