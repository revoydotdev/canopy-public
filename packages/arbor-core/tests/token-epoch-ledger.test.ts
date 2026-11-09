import { describe, expect, it } from "vitest";
import {
  claimBudgetWarning,
  createExpansionTokenEpoch,
  recordTokenUsage,
  resolveTokenBudget,
  type ExpansionTokenEpoch,
  type ProviderTokenCapability,
} from "../src/token-economy.js";

/**
 * Todo 7 evidence: per-attempt token-epoch ledger records with one-shot
 * warning claims. Proves the epoch record carries every persisted field,
 * survives a persist/recover round-trip byte-identical, bumps revision on
 * each change, delivers warnings exactly once, and rejects in-place
 * mutation (frozen, replace-don't-mutate).
 */

const CAPABILITY_200K: ProviderTokenCapability = {
  provider_id: "openrouter",
  model_id: "openrouter/anthropic/claude-opus-4-6",
  context_capacity: 200_000,
  max_output_tokens: 32_000,
  source: "snapshot",
};

function epoch(capability: ProviderTokenCapability = CAPABILITY_200K): ExpansionTokenEpoch {
  return createExpansionTokenEpoch({
    epoch_id: "expansion:campaign:node:attempt-1",
    capability,
    reserved_output_tokens: 4_000,
    requested_output_tokens: 32_000,
    prefill: { tokens: 1_500, source: "provider_counter", counter_id: "tok-v1" },
  });
}

describe("token epoch ledger records", () => {
  it("persists every ledger field an attempt must record", () => {
    const created = epoch();
    expect(created).toMatchObject({
      epoch_id: "expansion:campaign:node:attempt-1",
      provider_id: "openrouter",
      model_id: "openrouter/anthropic/claude-opus-4-6",
      capability_source: "snapshot",
      context_capacity: 200_000,
      reserved_output_tokens: 32_000,
      eligible_input_tokens: 168_000,
      applied_output_tokens: 32_000,
      output_limit_source: "requested",
      warning_delivered: false,
      revision: 0,
    });
    expect(created.prefill).toEqual({ tokens: 1_500, source: "provider_counter", counter_id: "tok-v1" });
    expect(created.usage).toMatchObject({ input_tokens: 1_500, output_tokens: 0, counter_source: "provider_counter" });
  });

  it("recovers byte-identical through a persist/recover round-trip", () => {
    const warned = claimBudgetWarning(epoch());
    const recovered: ExpansionTokenEpoch = JSON.parse(JSON.stringify(warned)) as ExpansionTokenEpoch;
    expect(recovered).toEqual(warned);
    // A recovered epoch keeps enforcing one-shot and revision discipline.
    expect(claimBudgetWarning(recovered)).toEqual(recovered);
    expect(recovered.revision).toBe(1);
  });

  it("computes eligible input on a 200k-context fixture without guessing", () => {
    const budget = resolveTokenBudget(CAPABILITY_200K, 4_000, 32_000);
    // The 32k request itself consumes output headroom: reserved is
    // max(configured 4k, applied 32k), never the configured value alone.
    expect(budget).toEqual({
      eligible_input_tokens: 168_000,
      reserved_output_tokens: 32_000,
      applied_output_tokens: 32_000,
      output_limit_source: "requested",
      capability_source: "snapshot",
    });
  });

  it("bumps revision on usage records and returns the same epoch when unchanged", () => {
    const created = epoch();
    const usage = {
      input_tokens: 1_500,
      output_tokens: 210,
      cached_input_tokens: 900,
      cache_write_input_tokens: 100,
      counter_source: "provider_counter" as const,
    };
    const recorded = recordTokenUsage(created, usage);
    expect(recorded.revision).toBe(1);
    expect(recorded.usage).toEqual(usage);
    expect(created.usage.output_tokens).toBe(0);
    expect(recordTokenUsage(recorded, usage)).toBe(recorded);
  });

  it("delivers the budget warning exactly once across repeated claims", () => {
    const created = epoch();
    const warned = claimBudgetWarning(created);
    expect(warned.warning_delivered).toBe(true);
    expect(warned.revision).toBe(1);
    expect(claimBudgetWarning(warned)).toBe(warned);
    // Double-delivery after a simulated restart (fresh object, same payload).
    const afterRestart = JSON.parse(JSON.stringify(warned)) as ExpansionTokenEpoch;
    expect(claimBudgetWarning(afterRestart).revision).toBe(1);
  });

  it("rejects in-place mutation: epochs are frozen, change means a new epoch", () => {
    const created = epoch();
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.prefill)).toBe(true);
    expect(Object.isFrozen(created.usage)).toBe(true);
    expect(() => {
      (created as { warning_delivered: boolean }).warning_delivered = true;
    }).toThrow(TypeError);
    expect(created.warning_delivered).toBe(false);
  });
});
