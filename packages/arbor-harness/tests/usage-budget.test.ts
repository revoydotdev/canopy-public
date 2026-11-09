import { describe, expect, it } from "vitest";

import { NativeUsageBudgetController, NativeUtf8UpperBoundTokenEstimator, StaticNativeModelPricingAuthority } from "../src/usage-budget.js";
import type { NativeModelRequest } from "../src/native-worker.js";

const request = (prompt = "task"): NativeModelRequest => ({
  session_id: "s", turn: 1, prompt, history: [], profile: null,
  governed_context: { instructions: [], artifacts: [] }, context: null, structured_output: null,
});

const pricing = new StaticNativeModelPricingAuthority({
  price_source_id: "operator-schedule-2026-08", observed_at: "2026-08-09T00:00:00.000Z",
  provider_id: "fixture", model_id: "exact-model", currency: "USD", minor_unit_exponent: 6,
  input_minor_units_per_million_tokens: 1_000_000, output_minor_units_per_million_tokens: 2_000_000,
  cache_read_minor_units_per_million_tokens: 250_000, cache_write_minor_units_per_million_tokens: 1_250_000,
});

describe("native usage budget", () => {
  it("refuses a prospective cost ceiling without an exact configured schedule", () => {
    const controller = new NativeUsageBudgetController({
      provider_id: "fixture", model_id: "different-model", limits: { max_cost: { currency: "USD", minor_units: 100, minor_unit_exponent: 6 } },
      token_estimator: { estimate: () => ({ kind: "estimated", input_tokens: 2, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, authority: "test-bound" }) }, pricing,
    });
    expect(controller.admit(request())).toEqual({ allowed: false, reason: "prospective cost budget unavailable: no exact configured price observation matches this provider/model" });
  });

  it("refuses a prospective price whose currency does not match the configured ceiling", () => {
    const controller = new NativeUsageBudgetController({
      provider_id: "fixture", model_id: "exact-model", limits: { max_cost: { currency: "EUR", minor_units: 100, minor_unit_exponent: 6 } },
      token_estimator: { estimate: () => ({ kind: "estimated", input_tokens: 2, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, authority: "test-bound" }) }, pricing,
    });
    expect(controller.admit(request())).toEqual({ allowed: false, reason: "prospective cost budget unavailable: configured price denomination differs from the budget" });
  });

  it("rejects provider cost observations in a different denomination from the ceiling", () => {
    const controller = new NativeUsageBudgetController({
      provider_id: "fixture", model_id: "exact-model", limits: { max_cost: { currency: "USD", minor_units: 100, minor_unit_exponent: 2 } },
    });
    expect(controller.observe({
      tokens: { kind: "measured", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 },
      cost: { kind: "priced", minor_units: 1, currency: "EUR", minor_unit_exponent: 2, price_source_id: "provider-observation" },
    })).toMatchObject({ allowed: false, reason: "runtime cost budget cannot be enforced because measured cost denomination differs from the budget" });
  });

  it("fails closed before dispatch when an explicit estimate authority is absent", () => {
    const controller = new NativeUsageBudgetController({ provider_id: "fixture", model_id: "exact-model", limits: { max_total_tokens: 10 } });
    expect(controller.admit(request())).toEqual({ allowed: false, reason: "prospective budget unavailable: no explicit token estimate authority was composed" });
  });

  it("derives priced cost from measured tokens but never from unavailable usage", () => {
    const controller = new NativeUsageBudgetController({
      provider_id: "fixture", model_id: "exact-model", limits: { max_cost: { currency: "USD", minor_units: 12, minor_unit_exponent: 6 } },
      token_estimator: { estimate: () => ({ kind: "estimated", input_tokens: 2, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, authority: "test-bound" }) }, pricing,
    });
    expect(controller.observe({ tokens: { kind: "measured", input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, cache_write_tokens: 1 }, cost: { kind: "unpriced", reason: "provider has no schedule" } })).toMatchObject({
      allowed: true, observation: { cost: { kind: "priced", minor_units: 11, price_source_id: "operator-schedule-2026-08" } },
    });
    const unknown = new NativeUsageBudgetController({
      provider_id: "fixture", model_id: "exact-model", limits: { max_total_tokens: 10 },
      token_estimator: { estimate: () => ({ kind: "estimated", input_tokens: 2, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, authority: "test-bound" }) },
    });
    expect(unknown.observe({ tokens: { kind: "unavailable", reason: "provider omitted usage" }, cost: { kind: "unpriced", reason: "no price" } })).toMatchObject({ allowed: false, reason: "runtime token budget cannot be enforced because the provider did not report measured usage" });
  });

  it("retains cache-only measured usage in the budget total", () => {
    const controller = new NativeUsageBudgetController({ provider_id: "fixture", model_id: "exact-model", limits: {} });
    controller.observe({ tokens: { kind: "measured", input_tokens: 0, output_tokens: 0, cache_read_tokens: 7, cache_write_tokens: 3 }, cost: { kind: "unpriced", reason: "test" } });
    expect(controller.total()).toMatchObject({ tokens: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 7, cache_write_tokens: 3 } });
  });

  it("includes observed cache traffic when admitting the next prospective input", () => {
    const controller = new NativeUsageBudgetController({
      provider_id: "fixture", model_id: "exact-model", limits: { max_total_tokens: 10 },
      token_estimator: { estimate: () => ({ kind: "estimated", input_tokens: 3, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, authority: "test-bound" }) },
    });
    controller.observe({ tokens: { kind: "measured", input_tokens: 0, output_tokens: 0, cache_read_tokens: 6, cache_write_tokens: 2 }, cost: { kind: "unpriced", reason: "test" } });

    expect(controller.admit(request())).toEqual({ allowed: false, reason: "native total-token budget would be exceeded" });
  });

  it("uses only conservative UTF-8 bounds and rejects an oversize request", () => {
    const smallRequestBytes = Buffer.byteLength(JSON.stringify(request("x")), "utf8");
    const estimator = new NativeUtf8UpperBoundTokenEstimator({ authority: "utf8-byte-upper-bound-v1", max_input_tokens: smallRequestBytes, max_output_tokens: 4 });
    expect(estimator.estimate(request("x".repeat(100)))).toMatchObject({ kind: "unavailable", reason: "request exceeds the configured maximum input-token estimate" });
    const estimate = estimator.estimate(request("x"));
    expect(estimate).toMatchObject({ kind: "estimated", input_tokens: expect.any(Number), authority: "utf8-byte-upper-bound-v1" });
    if (estimate.kind === "estimated") expect(estimate.cache_read_tokens).toBe(estimate.cache_write_tokens);
  });

  it("enforces independent prospective fresh, output, cache-read, and cache-write ceilings", () => {
    const estimate = { estimate: () => ({ kind: "estimated" as const, input_tokens: 3, output_tokens: 2, cache_read_tokens: 4, cache_write_tokens: 1, authority: "dimension-bound" }) };
    const allowed = new NativeUsageBudgetController({ provider_id: "fixture", model_id: "exact-model", limits: { max_fresh_input_tokens: 3, max_output_tokens: 2, max_cache_read_tokens: 4, max_cache_write_tokens: 1, max_total_tokens: 10 }, token_estimator: estimate });
    expect(allowed.admit(request())).toMatchObject({ allowed: true });
    const denied = new NativeUsageBudgetController({ provider_id: "fixture", model_id: "exact-model", limits: { max_cache_read_tokens: 3 }, token_estimator: estimate });
    expect(denied.admit(request())).toMatchObject({ allowed: false, reason: "native cache-read-token budget would be exceeded" });
  });

  it("uses the conservative UTF-8 ceiling for each prospective cache dimension", () => {
    const smallRequestBytes = Buffer.byteLength(JSON.stringify(request()), "utf8");
    const controller = new NativeUsageBudgetController({
      provider_id: "fixture", model_id: "exact-model", limits: { max_cost: { currency: "USD", minor_units: 100_000, minor_unit_exponent: 6 } },
      token_estimator: new NativeUtf8UpperBoundTokenEstimator({ authority: "utf8-byte-upper-bound-v1", max_input_tokens: smallRequestBytes, max_output_tokens: 20 }), pricing,
    });
    const admitted = controller.admit(request());
    expect(admitted).toMatchObject({ allowed: true, estimate: { kind: "estimated", authority: "utf8-byte-upper-bound-v1" } });
    if (admitted.allowed && admitted.estimate?.kind === "estimated") {
      expect(admitted.estimate.cache_read_tokens).toBe(admitted.estimate.input_tokens);
      expect(admitted.estimate.cache_write_tokens).toBe(admitted.estimate.input_tokens);
    }
  });

  it("keeps cache estimates unavailable when an estimator cannot provide safe bounds", () => {
    const controller = new NativeUsageBudgetController({
      provider_id: "fixture", model_id: "exact-model", limits: { max_cache_read_tokens: 10 },
      token_estimator: { estimate: () => ({ kind: "estimated", input_tokens: 2, output_tokens: 2, cache_read_tokens: null, cache_write_tokens: null, authority: "input-only" }) },
    });
    expect(controller.admit(request())).toMatchObject({ allowed: false, reason: "prospective budget unavailable: estimator cannot bound cache-read and cache-write tokens" });
  });

  it("allows a zero ceiling as a real bound and blocks any positive prospective usage", () => {
    const controller = new NativeUsageBudgetController({
      provider_id: "fixture", model_id: "exact-model", limits: { max_output_tokens: 0 },
      token_estimator: { estimate: () => ({ kind: "estimated", input_tokens: 1, output_tokens: 1, cache_read_tokens: null, cache_write_tokens: null, authority: "input-output-bound" }) },
    });
    expect(controller.admit(request())).toMatchObject({ allowed: false, reason: "native output-token budget would be exceeded" });
  });
});
