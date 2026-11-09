// ADR-112 Decision 3: retrieval quality measured before/after via the
// ablation pattern, reusing the discipline `repository-retrieval-eval.ts`
// already established for code retrieval (cited in Obligation O2) — not
// asserted.
import { describe, it, expect } from "vitest";
import { KnowledgeBase } from "../src/kb.js";
import { evaluateKnowledgeBaseRetrievalAblation, type KnowledgeBaseRetrievalCohort } from "../src/retrieval-eval.js";
import { makeFakeEmbeddingPort } from "./helpers/fake-embedder.js";
import type { CapabilityContext, Provenance } from "@arbor/core";

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" };
const criticCap: CapabilityContext = { tier: "critic" };
const wordCount = (text: string): number => (text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length);

/**
 * A KB where relevant entries share word-level (trigram) overlap with their
 * task's query but are interleaved with a large volume of noise entries
 * under the same tags/campaign — the exact scenario Decision 3 requires
 * measuring before this ships: does lexical-topk actually beat unranked
 * exact-tag on a held-out query set, or is this an unevidenced change?
 */
function seedKb(): KnowledgeBase {
  const kb = new KnowledgeBase(null); // production wiring; embedder passed explicitly per-call in the eval
  kb.write({
    campaign_id: "camp1", type: "failure_mode", value: "connection refused talking to the auth database",
    provenance: verifiedProv, as_of: "iter:1", tier: "critic_only",
    failure_mode: "db connection refused", root_cause: "auth db unreachable", tags: ["auth"],
  });
  kb.write({
    campaign_id: "camp1", type: "failure_mode", value: "timeout waiting for the payment gateway response",
    provenance: verifiedProv, as_of: "iter:2", tier: "critic_only",
    failure_mode: "payment gateway timeout", root_cause: "slow upstream", tags: ["payments"],
  });
  for (let i = 0; i < 30; i++) {
    kb.write({
      campaign_id: "camp1", type: "failure_mode", value: `noise entry ${i} about formatting and lint`,
      provenance: verifiedProv, as_of: `iter:${i + 3}`, tier: "critic_only",
      failure_mode: `lint nit ${i}`, root_cause: "style", tags: ["lint"],
    });
  }
  return kb;
}

describe("KB retrieval ablation (exact-tag vs lexical-topk)", () => {
  it("lexical-topk achieves at least as much recall as exact-tag while using materially fewer tokens on a held-out cohort", () => {
    const kb = seedKb();
    const entries = kb.getEntries();
    const dbEntry = entries.find((e) => e.failure_mode === "db connection refused")!;
    const paymentEntry = entries.find((e) => e.failure_mode === "payment gateway timeout")!;

    const heldOut: KnowledgeBaseRetrievalCohort = {
      cohort_id: "kb-retrieval-held-out-2026-08-26",
      scope: "held_out",
      provenance: { tag: "claimed", claimant: "ADR-112 implementation" },
      tasks: [
        {
          task_id: "db-connection-issue",
          query_prompt: "database connection refused during auth",
          campaign_id: "camp1",
          cap: criticCap,
          required_entry_ids: [dbEntry.id],
        },
        {
          task_id: "payment-timeout-issue",
          query_prompt: "payment gateway timing out",
          campaign_id: "camp1",
          cap: criticCap,
          required_entry_ids: [paymentEntry.id],
        },
      ],
    };

    const ablation = evaluateKnowledgeBaseRetrievalAblation({
      kb,
      cohort: heldOut,
      top_k: 3,
      embedder: makeFakeEmbeddingPort(),
      count_tokens: wordCount,
    });

    const exactTag = ablation.arms.find((a) => a.arm === "exact-tag")!.evaluation;
    const lexicalTopk = ablation.arms.find((a) => a.arm === "lexical-topk")!.evaluation;

    // exact-tag today: unranked, uncapped — recall is trivially perfect
    // (every entry the campaign owns is "found"), which is exactly the
    // unbounded-injection problem ADR-112 Context names.
    expect(exactTag.exact_task_recall).toBe(1);
    expect(exactTag.mean_token_reduction).toBe(0);

    // lexical-topk: bounded to top_k=3 out of 32 entries, still finds the
    // relevant entry for both tasks (real recall, not an unbounded dump),
    // and uses materially fewer tokens doing it.
    expect(lexicalTopk.exact_task_recall).toBe(1);
    expect(lexicalTopk.mean_token_reduction).toBeGreaterThan(0.5);
    for (const result of lexicalTopk.task_results) {
      expect(result.candidate_tokens).toBeLessThanOrEqual(exactTag.task_results.find((r) => r.task_id === result.task_id)!.baseline_tokens);
    }
  });

  it("rejects a cohort with no tasks", () => {
    const kb = seedKb();
    expect(() =>
      evaluateKnowledgeBaseRetrievalAblation({
        kb,
        cohort: { cohort_id: "empty", scope: "calibration", provenance: { tag: "claimed", claimant: "test" }, tasks: [] },
        top_k: 3,
        embedder: makeFakeEmbeddingPort(),
        count_tokens: wordCount,
      }),
    ).toThrow(/must have an id and tasks/);
  });
});
