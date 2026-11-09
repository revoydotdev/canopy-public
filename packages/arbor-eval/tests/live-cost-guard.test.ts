import { describe, expect, it } from "vitest";
import { assertWithinCostCeiling, estimateLiveRunCostUsd, LiveCostCeilingExceededError } from "../src/live-cost-guard.js";

describe("estimateLiveRunCostUsd", () => {
  it("computes a conservative estimate as arms * tasks * runs * calls * per-call price", () => {
    const usd = estimateLiveRunCostUsd({
      arms: 2, tasks: 5, runs_per_arm_per_task: 3, max_calls_per_run: 3,
      estimated_prompt_tokens_per_call: 1000, max_output_tokens_per_call: 500,
      price_per_input_token_usd: 0.000001, price_per_output_token_usd: 0.000002,
    });
    const totalCalls = 2 * 5 * 3 * 3;
    const perCall = 1000 * 0.000001 + 500 * 0.000002;
    expect(usd).toBeCloseTo(totalCalls * perCall, 6);
  });
});

describe("assertWithinCostCeiling — ADR-095 Decision 3: enforced BEFORE dispatch", () => {
  it("does not throw when the estimate is within the ceiling", () => {
    expect(() => assertWithinCostCeiling(1.0, 5.0)).not.toThrow();
  });

  it("throws LiveCostCeilingExceededError, never clamping the run, when the estimate exceeds the ceiling", () => {
    expect(() => assertWithinCostCeiling(10.0, 5.0)).toThrow(LiveCostCeilingExceededError);
  });

  it("refuses a non-positive ceiling as a configuration error", () => {
    expect(() => assertWithinCostCeiling(0.1, 0)).toThrow();
    expect(() => assertWithinCostCeiling(0.1, -1)).toThrow();
  });
});
