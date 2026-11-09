import { describe, expect, it } from "vitest";

import { ARBOR_CATEGORIES, resolveCategoryModel, resolveCategoryModelWithFallback } from "../src/agent-taxonomy.js";

describe("category model availability fallback", () => {
  it("uses a configured model when the live catalog contains it", () => {
    const result = resolveCategoryModelWithFallback(
      "seed-quick",
      { "seed-quick": "openrouter/qwen" },
      new Set(["openrouter/qwen", "anthropic/claude-sonnet-4"]),
    );
    expect(result).toEqual({ model: "openrouter/qwen", source: "configured" });
  });

  it("falls back to the category default and records the requested model", () => {
    const defaultModel = ARBOR_CATEGORIES["seed-quick"].model_hint!.model;
    const result = resolveCategoryModelWithFallback(
      "seed-quick",
      { "seed-quick": "provider/retired-model" },
      new Set([defaultModel]),
    );
    expect(result).toEqual({ model: defaultModel, source: "default", requested_model: "provider/retired-model" });
  });

  it("fails deterministically when both requested and category models are unavailable", () => {
    expect(() => resolveCategoryModelWithFallback("seed-quick", { "seed-quick": "provider/missing" }, new Set()))
      .toThrow("category model unavailable: seed-quick requested provider/missing; no configured fallback is available");
  });

  it("keeps the legacy resolver unchanged without a runtime catalog", () => {
    expect(resolveCategoryModel("seed-quick", { "seed-quick": "provider/model" }))
      .toEqual({ model: "provider/model" });
  });
});
