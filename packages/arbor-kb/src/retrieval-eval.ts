// arbor-kb — Retrieval-quality ablation harness (ADR-112 Decision 3)
//
// This repository already has a working ablation harness for
// retrieval-quality claims: `evaluateRepositoryRetrieval` /
// `evaluateRepositoryRetrievalAblation` in
// packages/arbor-eval/src/repository-retrieval-eval.ts, which runs named
// arms over a calibration/held_out cohort split and reports recall and
// token-reduction under a guard. `arbor-kb` cannot import that module
// (arbor-eval depends on arbor-kb's package graph in the opposite
// direction, and this package ships zero cross-package dependencies), so
// this module reuses the *pattern* — cohort scoping, named arms, recall,
// token reduction — self-contained, exactly as ADR-112's Decision 3
// requires: "measure before and after, do not assert."
//
// Two arms are evaluated against the same cohort:
//   - "exact-tag": today's KnowledgeBase.query behavior, unranked and
//     uncapped — the literal pre-ADR-112 baseline named in Context.
//   - "lexical-topk": ADR-112's ranked, bounded retrieval via `inject`'s
//     new top_k stage — lexical (character-trigram) ranking, not semantic;
//     see ADR-138.
//
// This is real, ongoing evidence, not a one-time report: the cohort must
// be revisited as the KB's entry population and query patterns change,
// the same discipline `repository-retrieval-eval.ts` already commits to.
import type { CapabilityContext, Provenance } from "@arbor/core";
import type { KnowledgeBase } from "./kb.js";
import { selectTopK, type EmbeddingPort } from "./retrieval.js";

export interface KnowledgeBaseRetrievalTask {
  readonly task_id: string;
  readonly query_prompt: string;
  readonly campaign_id: string;
  readonly cap: CapabilityContext;
  readonly category?: string;
  /** Entry ids the arm must surface for this task to count as correct. */
  readonly required_entry_ids: readonly string[];
}

export interface KnowledgeBaseRetrievalCohort {
  readonly cohort_id: string;
  readonly scope: "calibration" | "held_out";
  readonly provenance: Provenance;
  readonly tasks: readonly KnowledgeBaseRetrievalTask[];
}

export interface KnowledgeBaseRetrievalTaskResult {
  readonly task_id: string;
  readonly required_found: number;
  readonly required_total: number;
  readonly correct: boolean;
  readonly baseline_tokens: number;
  readonly candidate_tokens: number;
}

export interface KnowledgeBaseRetrievalEvaluation {
  readonly schema: "arbor.kb-retrieval-eval/v1";
  readonly cohort_id: string;
  readonly scope: "calibration" | "held_out";
  readonly arm: "exact-tag" | "lexical-topk";
  readonly top_k: number;
  readonly task_results: readonly KnowledgeBaseRetrievalTaskResult[];
  readonly exact_task_recall: number;
  readonly mean_token_reduction: number;
}

export interface KnowledgeBaseRetrievalAblation {
  readonly schema: "arbor.kb-retrieval-ablation/v1";
  readonly cohort_id: string;
  readonly scope: "calibration" | "held_out";
  readonly arms: readonly { readonly arm: string; readonly evaluation: KnowledgeBaseRetrievalEvaluation }[];
}

/**
 * Evaluate one retrieval arm against a cohort. `kb` is queried through its
 * public surface (`query`) — the same envelope-wrapped, capability-gated
 * path `inject` uses — never through internal state, so this measures the
 * actual retrieval behavior a specialist or critic would see.
 */
export function evaluateKnowledgeBaseRetrieval(input: {
  readonly kb: KnowledgeBase;
  readonly cohort: KnowledgeBaseRetrievalCohort;
  readonly arm: "exact-tag" | "lexical-topk";
  readonly top_k: number;
  readonly embedder: EmbeddingPort | null;
  readonly count_tokens: (text: string) => number;
}): KnowledgeBaseRetrievalEvaluation {
  validateCohort(input.cohort);

  const task_results = input.cohort.tasks.map((task): KnowledgeBaseRetrievalTaskResult => {
    const preFiltered = input.kb
      .query(task.campaign_id, null, task.cap)
      .filter((e) => e.value !== null)
      .map((e) => e.value!);

    const baselineTokens = input.count_tokens(preFiltered.map((e) => e.value).join("\n"));

    const candidateEntries =
      input.arm === "exact-tag"
        ? preFiltered // today's behavior: unranked, uncapped
        : selectTopK(preFiltered, task.query_prompt, { top_k: input.top_k, embedder: input.embedder }).entries;

    const candidateIds = new Set(candidateEntries.map((e) => e.id));
    const requiredFound = task.required_entry_ids.filter((id) => candidateIds.has(id)).length;
    const candidateTokens = input.count_tokens(candidateEntries.map((e) => e.value).join("\n"));

    return Object.freeze({
      task_id: task.task_id,
      required_found: requiredFound,
      required_total: task.required_entry_ids.length,
      correct: requiredFound === task.required_entry_ids.length,
      baseline_tokens: baselineTokens,
      candidate_tokens: candidateTokens,
    });
  });

  const reductions = task_results.map((r) =>
    r.baseline_tokens === 0 ? 0 : (r.baseline_tokens - r.candidate_tokens) / r.baseline_tokens,
  );

  return Object.freeze({
    schema: "arbor.kb-retrieval-eval/v1",
    cohort_id: input.cohort.cohort_id,
    scope: input.cohort.scope,
    arm: input.arm,
    top_k: input.top_k,
    task_results: Object.freeze(task_results),
    exact_task_recall: ratio(task_results.filter((r) => r.correct).length, task_results.length),
    mean_token_reduction: reductions.length === 0 ? 0 : rounded(reductions.reduce((a, b) => a + b, 0) / reductions.length),
  });
}

/** Runs both named arms ("exact-tag", "lexical-topk") over the same cohort. */
export function evaluateKnowledgeBaseRetrievalAblation(input: {
  readonly kb: KnowledgeBase;
  readonly cohort: KnowledgeBaseRetrievalCohort;
  readonly top_k: number;
  readonly embedder: EmbeddingPort | null;
  readonly count_tokens: (text: string) => number;
}): KnowledgeBaseRetrievalAblation {
  const arms = (["exact-tag", "lexical-topk"] as const).map((arm) => ({
    arm,
    evaluation: evaluateKnowledgeBaseRetrieval({ ...input, arm }),
  }));
  return Object.freeze({
    schema: "arbor.kb-retrieval-ablation/v1",
    cohort_id: input.cohort.cohort_id,
    scope: input.cohort.scope,
    arms: Object.freeze(arms),
  });
}

function validateCohort(cohort: KnowledgeBaseRetrievalCohort): void {
  if (cohort.cohort_id.trim().length === 0 || cohort.tasks.length === 0) {
    throw new Error("knowledge base retrieval cohort must have an id and tasks");
  }
  const ids = new Set<string>();
  for (const task of cohort.tasks) {
    if (task.task_id.trim().length === 0 || ids.has(task.task_id) || task.query_prompt.trim().length === 0) {
      throw new Error("invalid knowledge base retrieval task");
    }
    ids.add(task.task_id);
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : rounded(numerator / denominator);
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
