/**
 * arbor-eval/tasks — predefined benchmark tasks with scripted, deterministic outcomes.
 *
 * Each task uses a seeded hash to produce reproducible pass/fail patterns.
 * The same (taskId, branchIndex, seed) triple always yields the same outcome.
 */

import type { Action } from "@arbor/core";
import type { EvalTask, OutcomeGenerator, ScriptedOutcome } from "./types.js";

/**
 * Deterministic pseudo-random hash: (taskId, branchIndex, seed) → number in [0, 1).
 * Uses a simple FNV-1a-like hash for reproducibility across platforms.
 */
function deterministicHash(taskId: string, branchIndex: number, seed: number): number {
  let h = 2166136261 ^ seed;
  const str = `${taskId}:${branchIndex}`;
  for (let i = 0; i < str.length; i++) {
    h = (h ^ str.charCodeAt(i)) * 16777619;
    h >>>= 0;
  }
  return (h & 0x7fffffff) / 0x7fffffff;
}

const reasonsSuccess = [
  "implementation completed, all tests pass",
  "refactor succeeded, coverage improved to 94%",
  "module extracted cleanly, backward compatible",
  "optimization yielded 35% latency reduction",
  "integration tests green, edge cases covered",
];

const reasonsFail = [
  "broke existing API contract, 12 tests regressed",
  "introduced race condition in async pipeline",
  "missed edge case: null input causes crash",
  "performance regression: p99 latency doubled",
  "incompatible with existing dependency version",
];

const rootCauses = [
  "insufficient test coverage before change",
  "missing mock in test harness",
  "unexpected interaction with concurrent writes",
  "schema migration not backward-compatible",
  "incorrect assumption about input validation",
];

/**
 * Creates a learning-aware outcome generator.
 *
 * The success probability increases after failures are recorded, simulating
 * how KB injection helps subsequent branches avoid repeating known mistakes.
 *
 * Base rate applies when no prior failures exist. After failures are known,
 * the effective rate increases by `learningBonus` (up to `maxRate`).
 */
export function createLearningOutcomeGenerator(
  baseRate: number = 0.4,
  learningBonus: number = 0.35,
  maxRate: number = 0.9,
): { generator: OutcomeGenerator; getKbHitRate: (dispatchRecords: Array<{ hadPriorFailures: boolean; succeeded: boolean }>) => number } {
  const generator: OutcomeGenerator = (branchIndex: number, seed: number, hadPriorFailures?: boolean): ScriptedOutcome => {
    const effectiveRate = hadPriorFailures
      ? Math.min(baseRate + learningBonus, maxRate)
      : baseRate;
    const hash = deterministicHash("learning", branchIndex, seed);
    const success = hash < effectiveRate;
    const reasonIdx = branchIndex % (success ? reasonsSuccess.length : reasonsFail.length);
    const rootIdx = branchIndex % rootCauses.length;

    if (success) {
      return {
        success: true,
        rationale: reasonsSuccess[reasonIdx],
      };
    }
    return {
      success: false,
      rationale: reasonsFail[reasonIdx],
      rootCause: rootCauses[rootIdx],
    };
  };

  return {
    generator,
    getKbHitRate: (dispatchRecords) => {
      const withPrior = dispatchRecords.filter((r) => r.hadPriorFailures);
      if (withPrior.length === 0) return 0;
      const hits = withPrior.filter((r) => r.succeeded).length;
      return Math.round((hits / withPrior.length) * 100) / 100;
    },
  };
}

// --- Built-in task definitions ---

/** A root action for all tasks. */
function rootAction(desc: string): Action {
  return {
    description: desc,
    estimated_gain: 100,
    estimated_cost: 1,
    category: "root",
    delegate_to: "crown",
  };
}

function makeBranchAction(i: number, category: string): Action {
  const descriptions = [
    "refactor auth module to use dependency injection",
    "extract shared validation logic to utility package",
    "add circuit breaker to database connection pool",
    "migrate error handling to typed error union",
    "optimize API response serialization",
    "introduce request batching for bulk operations",
    "replace synchronous file I/O with streaming",
    "add retry policy with exponential backoff",
    "implement request-scoped caching layer",
    "convert callbacks to async/await throughout",
    "introduce feature flag system for rollout",
    "add structured logging with correlation IDs",
  ];
  return {
    description: descriptions[i % descriptions.length],
    estimated_gain: 40 + (i % 20),
    estimated_cost: 5 + (i % 15),
    category,
    delegate_to: "seed",
  };
}

/**
 * Default eval tasks.
 */
export const defaultTasks: EvalTask[] = [
  {
    id: "refactor-auth",
    description: "Refactor authentication module to use dependency injection for testability",
    rootAction: rootAction("refactor auth module with DI"),
    branchCount: 4,
    branchActionGenerator: (i: number) => makeBranchAction(i, "refactor"),
    outcomeGenerator: createLearningOutcomeGenerator(0.4, 0.35, 0.9).generator,
    expectedGoodOutcome: "At least one branch succeeds via verified provenance; campaign converges or meets score threshold",
  },
  {
    id: "optimize-serialization",
    description: "Optimize API response serialization to reduce latency",
    rootAction: rootAction("optimize serialization pipeline"),
    branchCount: 5,
    branchActionGenerator: (i: number) => makeBranchAction(i + 4, "optimization"),
    outcomeGenerator: createLearningOutcomeGenerator(0.35, 0.4, 0.9).generator,
    expectedGoodOutcome: "Tree search explores multiple strategies; best-scoring approach is verified",
  },
  {
    id: "error-handling",
    description: "Migrate error handling from ad-hoc to typed error union across the codebase",
    rootAction: rootAction("migrate error handling to typed errors"),
    branchCount: 3,
    branchActionGenerator: (i: number) => makeBranchAction(i + 8, "migration"),
    outcomeGenerator: createLearningOutcomeGenerator(0.5, 0.3, 0.85).generator,
    expectedGoodOutcome: "High success rate; campaign converges quickly with few failures",
  },
  {
    id: "performance-regression",
    description: "Identify and fix a latent performance regression in data pipeline",
    rootAction: rootAction("fix performance regression in data pipeline"),
    branchCount: 6,
    branchActionGenerator: (i: number) => makeBranchAction(i + 2, "bugfix"),
    outcomeGenerator: createLearningOutcomeGenerator(0.3, 0.4, 0.85).generator,
    expectedGoodOutcome: "Tree search explores many alternatives; KB entries from failures inform subsequent attempts",
  },
  {
    id: "circuit-breaker",
    description: "Add circuit breaker pattern to all database connections",
    rootAction: rootAction("add circuit breakers to DB pool"),
    branchCount: 4,
    branchActionGenerator: (i: number) => makeBranchAction(i + 6, "feature"),
    outcomeGenerator: createLearningOutcomeGenerator(0.45, 0.3, 0.85).generator,
    expectedGoodOutcome: "Branching explores different circuit breaker strategies; converges on best implementation",
  },
];
