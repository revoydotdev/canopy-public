import type { RevisionEvaluation } from "@arbor/core";

/** Structural, hermetic evaluator port. It never exposes scenarios or a live transport to the catalog. */
export interface HarnessEvaluationPort {
  readonly evaluator_id: string;
  /** `run_id` is an authority binding that must appear in every evidence artifact. */
  evaluate(input: { revision_id: string; run_id: string; signal?: AbortSignal }): Promise<
    | { kind: "measured"; evaluation: RevisionEvaluation; evidence_ids: readonly string[]; detail: readonly Record<string, unknown>[] }
    | { kind: "unmeasured"; reason: string }
  >;
}
