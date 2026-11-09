import type { Provenance } from "@arbor/core";
import { DEFAULT_REPOSITORY_RETRIEVAL_STRATEGY, RepositoryGraphIndex, type RepositoryGraphResult, type RepositoryRetrievalSignals, type RepositoryRetrievalStrategy } from "@arbor/mcp";
import { evaluateEconomizationGuard, type EconomizationGuardPolicy, type EconomizationGuardResult } from "./trajectory-metrics.js";

export interface RepositoryRetrievalTask {
  readonly task_id: string;
  readonly prompt: string;
  /** Every group requires at least one acceptable path in the projection. */
  readonly required_path_groups: readonly (readonly string[])[];
  readonly signals?: RepositoryRetrievalSignals;
}

export interface RepositoryRetrievalCohort {
  readonly cohort_id: string;
  readonly scope: "calibration" | "held_out";
  readonly provenance: Provenance;
  readonly tasks: readonly RepositoryRetrievalTask[];
}

export interface RepositoryRetrievalTaskResult {
  readonly task_id: string;
  readonly required_paths_found: number;
  readonly required_path_groups: number;
  readonly correct: boolean;
  readonly candidate_nodes: number;
  readonly baseline_tokens: number;
  readonly candidate_tokens: number;
  readonly candidate_paths: readonly string[];
}

export interface RepositoryRetrievalEvaluation {
  readonly schema: "arbor.repository-retrieval-eval/v1";
  readonly cohort_id: string;
  readonly scope: "calibration" | "held_out";
  readonly index_digest: string;
  readonly files_indexed: number;
  readonly task_results: readonly RepositoryRetrievalTaskResult[];
  readonly exact_task_recall: number;
  readonly mean_projection_reduction: number;
  readonly guard: EconomizationGuardResult;
  readonly strategy: RepositoryRetrievalStrategy;
}

export interface RepositoryRetrievalAblation {
  readonly schema: "arbor.repository-retrieval-ablation/v1";
  readonly arms: readonly { readonly arm: string; readonly evaluation: RepositoryRetrievalEvaluation }[];
}

/**
 * Compare the bounded task-conditioned graph seed with the complete metadata
 * graph under one injected tokenizer. Labels are path groups, not source
 * content, and calibration provenance can never promote the candidate.
 */
export function evaluateRepositoryRetrieval(input: {
  readonly root: string;
  readonly cohort: RepositoryRetrievalCohort;
  readonly count_tokens: (text: string) => number;
  readonly guard_policy: EconomizationGuardPolicy;
  readonly index?: RepositoryGraphIndex;
  readonly strategy?: Partial<RepositoryRetrievalStrategy>;
  readonly candidate_config_id?: string;
}): RepositoryRetrievalEvaluation {
  validateCohort(input.cohort);
  const index = input.index ?? new RepositoryGraphIndex();
  const baseline = index.snapshot(input.root);
  if (baseline.truncated) throw new Error("repository retrieval evaluation requires a complete graph snapshot");
  const knownPaths = new Set(baseline.nodes.map((node) => node.path));
  const missingLabels = input.cohort.tasks.flatMap((task) => task.required_path_groups.flat()).filter((path) => !knownPaths.has(path));
  if (missingLabels.length > 0) throw new Error(`repository retrieval cohort labels unknown paths: ${[...new Set(missingLabels)].sort().join(", ")}`);
  const baselineTokens = measuredTokens(input.count_tokens, project(baseline));
  const taskResults = input.cohort.tasks.map((task): RepositoryRetrievalTaskResult => {
    const candidate = index.queryTask(input.root, task.prompt, { signals: task.signals, strategy: input.strategy }); const paths = new Set(candidate.nodes.map((node) => node.path));
    const groupsFound = task.required_path_groups.filter((group) => group.some((path) => paths.has(path))).length;
    return Object.freeze({
      task_id: task.task_id, required_paths_found: groupsFound, required_path_groups: task.required_path_groups.length,
      correct: groupsFound === task.required_path_groups.length, candidate_nodes: candidate.nodes.length,
      baseline_tokens: baselineTokens, candidate_tokens: measuredTokens(input.count_tokens, project(candidate)),
      candidate_paths: Object.freeze(candidate.nodes.map((node) => node.path)),
    });
  });
  const cohortEvidence = { cohort_id: input.cohort.cohort_id, scope: input.cohort.scope, provenance: input.cohort.provenance } as const;
  const baselineOutcomes = taskResults.map((result) => ({ task_id: result.task_id, succeeded: true, correct: true, grounded: true, accepted: true }));
  const candidateOutcomes = taskResults.map((result) => ({ task_id: result.task_id, succeeded: result.correct, correct: result.correct, grounded: result.correct, accepted: true }));
  const baselineTotal = taskResults.reduce((total, result) => total + result.baseline_tokens, 0);
  const candidateTotal = taskResults.reduce((total, result) => total + result.candidate_tokens, 0);
  const guard = evaluateEconomizationGuard(
    { config_id: "repository_graph/full_metadata", effective_tokens: baselineTotal, outcomes: baselineOutcomes, cohort: cohortEvidence },
    { config_id: input.candidate_config_id ?? "repository_graph/task_conditioned_v2", effective_tokens: candidateTotal, outcomes: candidateOutcomes, cohort: cohortEvidence },
    input.guard_policy,
  );
  return Object.freeze({
    schema: "arbor.repository-retrieval-eval/v1", cohort_id: input.cohort.cohort_id, scope: input.cohort.scope,
    index_digest: baseline.index_digest, files_indexed: baseline.files_indexed, task_results: Object.freeze(taskResults),
    exact_task_recall: ratio(taskResults.filter((result) => result.correct).length, taskResults.length),
    mean_projection_reduction: baselineTotal === 0 ? 0 : rounded((baselineTotal - candidateTotal) / baselineTotal), guard,
    strategy: Object.freeze({ ...DEFAULT_REPOSITORY_RETRIEVAL_STRATEGY, ...input.strategy }),
  });
}

/** Ordered cumulative ablation: every arm adds exactly one retrieval signal. */
export function evaluateRepositoryRetrievalAblation(input: Omit<Parameters<typeof evaluateRepositoryRetrieval>[0], "strategy" | "candidate_config_id">): RepositoryRetrievalAblation {
  const definitions = [
    ["lexical", { changed_paths: false, verified_memory: false, structural_centrality: false }],
    ["lexical+delta", { changed_paths: true, verified_memory: false, structural_centrality: false }],
    ["lexical+delta+verified_memory", { changed_paths: true, verified_memory: true, structural_centrality: false }],
    ["lexical+delta+verified_memory+structure", { changed_paths: true, verified_memory: true, structural_centrality: true }],
  ] as const satisfies readonly (readonly [string, RepositoryRetrievalStrategy])[];
  return Object.freeze({
    schema: "arbor.repository-retrieval-ablation/v1",
    arms: Object.freeze(definitions.map(([arm, strategy]) => Object.freeze({
      arm,
      evaluation: evaluateRepositoryRetrieval({ ...input, strategy, candidate_config_id: `repository_graph/${arm}` }),
    }))),
  });
}

function project(graph: RepositoryGraphResult): string {
  return JSON.stringify({ nodes: graph.nodes.map((node) => ({ path: node.path, symbols: node.symbols })), edges: graph.edges });
}
function measuredTokens(counter: (text: string) => number, text: string): number {
  const tokens = counter(text); if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("repository retrieval token counter must return a non-negative safe integer"); return tokens;
}
function validateCohort(cohort: RepositoryRetrievalCohort): void {
  if (cohort.cohort_id.trim().length === 0 || cohort.tasks.length === 0) throw new Error("repository retrieval cohort must have an id and tasks");
  const ids = new Set<string>();
  for (const task of cohort.tasks) {
    if (task.task_id.trim().length === 0 || ids.has(task.task_id) || task.prompt.trim().length === 0 || task.required_path_groups.length === 0
      || task.required_path_groups.some((group) => group.length === 0 || group.some((path) => path.trim().length === 0))) throw new Error("invalid repository retrieval task");
    ids.add(task.task_id);
  }
}
function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 0 : rounded(numerator / denominator); }
function rounded(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
