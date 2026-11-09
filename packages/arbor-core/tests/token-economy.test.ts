import { describe, expect, it } from "vitest";
import {
  claimBudgetWarning, countWithCharacterFallback, createExpansionTokenEpoch,
  foldStructuralContext, manageContext, recordTokenUsage, resolveTokenBudget, willManageContext,
  type ProviderTokenCapability, type StructuralContextEntry,
} from "../src/token-economy.js";

const capability: ProviderTokenCapability = { provider_id: "p", model_id: "m", context_capacity: 100, max_output_tokens: 20, source: "runtime" };
const verified = { tag: "verified" as const, cmd: "vitest", exit: 0, stdout_hash: "sha256:test"};
function epoch(input = 80) {
  return createExpansionTokenEpoch({ epoch_id: "node:1", capability, reserved_output_tokens: 20, requested_output_tokens: 30, prefill: { tokens: input, source: "provider_counter", counter_id: "tok" } });
}

describe("model-aware token economy", () => {
  it("reserves output headroom and reports provider capability clamps at boundaries", () => {
    expect(resolveTokenBudget(capability, 20, 30)).toEqual({ eligible_input_tokens: 80, reserved_output_tokens: 20, applied_output_tokens: 20, output_limit_source: "provider_capability", capability_source: "runtime" });
    expect(resolveTokenBudget(capability, 200, 5)).toMatchObject({ eligible_input_tokens: 0, reserved_output_tokens: 100, applied_output_tokens: 5, output_limit_source: "requested" });
    expect(resolveTokenBudget(capability, 0, 20)).toMatchObject({ eligible_input_tokens: 80, reserved_output_tokens: 20, applied_output_tokens: 20 });
  });

  it("rejects zero and internally inconsistent provider capacities", () => {
    expect(() => resolveTokenBudget({ ...capability, context_capacity: 0 }, 0, 0)).toThrow("positive");
    expect(() => resolveTokenBudget({ ...capability, max_output_tokens: 0 }, 0, 0)).toThrow("positive");
    expect(() => resolveTokenBudget({ ...capability, max_output_tokens: 101 }, 0, 0)).toThrow("cannot exceed");
  });

  it("keeps the explicit fallback counter distinguishable from provider-reported epochs", () => {
    expect(countWithCharacterFallback("abcde", 4)).toEqual({ tokens: 2, source: "character_fallback", characters_per_token: 4 });
  });

  it("creates immutable epochs and delivers a warning only once", () => {
    const original = epoch(); const warned = claimBudgetWarning(original);
    expect(Object.isFrozen(original)).toBe(true); expect(original.warning_delivered).toBe(false);
    expect(warned).toMatchObject({ warning_delivered: true, revision: 1 });
    expect(claimBudgetWarning(warned)).toBe(warned);
  });

  it("separates prediction from an idempotent management claim across replay", () => {
    const original = epoch(); const prediction = willManageContext(original);
    expect(prediction).toMatchObject({ should_manage: true, reason: "context_exhausted", active_tokens: 80 });
    const claimed = manageContext(original, prediction, "compact:1");
    expect(claimed.status).toBe("claimed");
    if (claimed.status !== "claimed") throw new Error("unreachable");
    expect(manageContext(claimed.epoch, prediction, "compact:1")).toMatchObject({ status: "idempotent" });
    expect(manageContext(claimed.epoch, prediction, "compact:2")).toMatchObject({ status: "claim_conflict" });
  });

  it("replaces observed usage immutably and includes cache accounting in overflow", () => {
    const original = epoch(1);
    const updated = recordTokenUsage(original, { input_tokens: 40, output_tokens: 3, cached_input_tokens: 30, cache_write_input_tokens: 10, counter_source: "provider_counter" });
    expect(original.usage.input_tokens).toBe(1);
    expect(updated.revision).toBe(1);
    expect(willManageContext(updated)).toMatchObject({ active_tokens: 80, should_manage: true });
    expect(recordTokenUsage(updated, updated.usage)).toBe(updated);
  });

  it("rejects stale predictions and does not let a below-threshold count gate work", () => {
    const original = epoch(10); const prediction = willManageContext(original, 70);
    expect(manageContext(original, prediction, "compact:1").status).toBe("not_required");
    expect(manageContext(claimBudgetWarning(original), prediction, "compact:1").status).toBe("stale_prediction");
  });

  it("folds deterministically, preserves bounded recent evidence, and filters critic-only context", () => {
    const entries: StructuralContextEntry[] = [
      { identity: "public", signature: "fn public()", content_hash: "h1", evidence_pointer: "audit:1", provenance: verified, visibility: "specialist", content: "old" },
      { identity: "secret", signature: "fn secret()", content_hash: "h2", evidence_pointer: "audit:2", provenance: verified, visibility: "critic", content: "critic only" },
      { identity: "recent", content_hash: "h3", evidence_pointer: "audit:3", provenance: verified, visibility: "specialist", content: "recent body" },
    ];
    const policy = { max_entries: 3, recent_tail: 1, max_rendered_characters: 900 };
    const first = foldStructuralContext(entries, "specialist", policy);
    expect(first).toEqual(foldStructuralContext(entries, "specialist", policy));
    expect(first.rendered).not.toContain("secret");
    expect(first.recent_tail[0]).toMatchObject({ identity: "recent", evidence_pointer: "audit:3", content: "recent body" });
    expect(foldStructuralContext(entries, "critic", policy).structures).toHaveLength(3);
  });

  it("bounds adversarial no-newline content and marks elision explicitly", () => {
    const entry: StructuralContextEntry = { identity: "huge", content_hash: "hash", evidence_pointer: "audit:huge", provenance: verified, visibility: "specialist", content: "x".repeat(1_000_000) };
    const folded = foldStructuralContext([entry], "specialist", { max_entries: 1, recent_tail: 1, max_rendered_characters: 80 });
    expect(folded.rendered.length).toBeLessThanOrEqual(80);
    expect(folded.elided_count).toBeGreaterThan(0);
    expect(folded.rendered).toContain("structural_fold");
  });
});
