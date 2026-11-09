import { describe, expect, it } from "vitest";
import { evaluatePairedEconomy, generatePairedEconomyReport, type PairedEconomyAttempt } from "../src/paired-economy-eval.js";

const provenance = { tag: "verified" as const, cmd: "fixture", exit: 0, stdout_hash: "sha256:fixture" };
const policy = { minimum_matched_tasks: 100, minimum_effective_token_reduction: 0.2, minimum_candidate_priced_coverage: 0.95, max_r4r_regression: 0.05, max_false_acceptance_increase: 0.05 };
function attempt(task_id: string, arm: "baseline" | "candidate", overrides: Partial<PairedEconomyAttempt> = {}): PairedEconomyAttempt {
  return {
    task_id, arm, scope: "held_out",
    tokens: arm === "baseline"
      ? { input_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 10 }
      : { input_tokens: 40, cache_read_tokens: 20, cache_write_tokens: 0, output_tokens: 10 },
    verified: true, right_for_right_reasons: true, false_acceptance: false,
    succeeded: true, correct: true, grounded: true, accepted: true,
    price: { kind: "priced", currency: task_id === "t2" ? "EUR" : "USD", minor_unit_exponent: 2, minor_units: arm === "baseline" ? 5 : 3, price_source_id: `fixture-${task_id}` },
    ...overrides,
  };
}

describe("paired economy evaluation", () => {
  it("pairs held-out tasks, separates cache buckets and currency, and never promotes fixture assertions", () => {
    const report = evaluatePairedEconomy({
      cohort_id: "held-out-cache", mechanism: "cache", provenance,
      attempts: Array.from({ length: 100 }, (_, index) => {
        const taskId = `t${index}`;
        return [attempt(taskId, "baseline"), attempt(taskId, "candidate")];
      }).flat(),
      policy,
    });
    expect(report).toMatchObject({
      matched_tasks: 100,
      effective_token_reduction: 0.414286,
      candidate: { tokens: { input_tokens: 4000, cache_read_tokens: 2000 }, priced_coverage: 1 },
      evidence_authority: "fixture_asserted",
      promotion: { status: "fixture_only", reasons: ["fixture observations and caller-supplied provenance cannot authorize policy promotion"] },
    });
    expect(report.candidate.priced_totals).toHaveLength(2);
    expect(generatePairedEconomyReport(report)).toContain("Quality guard: eligible");
    expect(report.promotion.status).not.toBe("eligible");
  });

  it("keeps unpriced candidate calls unavailable and blocks promotion below priced coverage", () => {
    const attempts = [
      attempt("t1", "baseline"), attempt("t1", "candidate", { price: { kind: "unpriced", reason: "provider schedule unavailable" } }),
      attempt("t2", "baseline"), attempt("t2", "candidate", { price: { kind: "unpriced", reason: "provider schedule unavailable" } }),
    ];
    const report = evaluatePairedEconomy({ cohort_id: "held-out-unpriced", mechanism: "combined", provenance, attempts, policy });
    expect(report.candidate).toMatchObject({ priced_coverage: 0, unpriced_calls: 2, priced_totals: [], unpriced_reasons: ["provider schedule unavailable"] });
    expect(report.promotion.status).toBe("insufficient_evidence");
    expect(report.promotion.reasons).toContain("candidate priced-cost coverage is below policy or unavailable");
  });

  it("blocks promotion when the candidate regresses on verified and truthfulness outcomes", () => {
    const attempts = Array.from({ length: 100 }, (_, index) => {
      const taskId = `t${index}`;
      const candidate = index === 99
        ? attempt(taskId, "candidate", { verified: false, right_for_right_reasons: false, false_acceptance: true, succeeded: false, correct: false, grounded: false })
        : attempt(taskId, "candidate");
      return [attempt(taskId, "baseline"), candidate];
    }).flat();
    const report = evaluatePairedEconomy({ cohort_id: "held-out-regression", mechanism: "retrieval", provenance, attempts, policy });
    expect(report.quality_regressions).toEqual({ verified: 1, right_for_right_reasons: 1, false_acceptance: 1 });
    expect(report.promotion.status).not.toBe("eligible");
  });

  it("refuses unmatched and duplicate task results", () => {
    expect(() => evaluatePairedEconomy({ cohort_id: "bad", mechanism: "retrieval", provenance, attempts: [attempt("t1", "baseline")] })).toThrow(/missing one arm/);
    expect(() => evaluatePairedEconomy({ cohort_id: "bad", mechanism: "retrieval", provenance, attempts: [attempt("t1", "baseline"), attempt("t1", "baseline")] })).toThrow(/duplicate baseline/);
    expect(() => evaluatePairedEconomy({ cohort_id: "bad", mechanism: "retrieval", provenance, attempts: [attempt("t1", "baseline", { false_acceptance: true })] })).toThrow(/inconsistent quality labels/);
  });
});
