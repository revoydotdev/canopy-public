import { describe, expect, it } from "vitest";

import { classifyNativeInferenceFailure, isNativeUsageAndCost } from "../src/inference.js";

describe("native inference contract", () => {
  it("keeps unmeasured tokens and unpriced cost explicit", () => {
    expect(isNativeUsageAndCost({ tokens: { kind: "unavailable", reason: "adapter does not report usage" }, cost: { kind: "unpriced", reason: "no schedule evidence" } })).toBe(true);
    expect(isNativeUsageAndCost({ tokens: { kind: "measured", input_tokens: -1, output_tokens: 2 }, cost: { kind: "unpriced", reason: "unknown" } })).toBe(false);
  });

  it("defaults unknown failures to a terminal classification", () => {
    expect(classifyNativeInferenceFailure(new Error("provider text is intentionally ignored"))).toEqual({ kind: "terminal", reason: "adapter did not classify the inference failure" });
  });
});
