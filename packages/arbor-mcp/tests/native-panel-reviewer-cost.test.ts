import { describe, expect, it } from "vitest";
import { createNativePanelReviewer } from "../src/cli.js";

describe("createNativePanelReviewer cost carriage", () => {
  it("forwards the native critic's configured cost observation to the panel vote", async () => {
    const usage_cost = { provider: "other" as const, model_family: "other" as const, cost: { kind: "priced" as const, minor_units: 9, currency: "USD", minor_unit_exponent: 6, price_source_id: "fixture:v1" } };
    const native = {
      review: async () => ({
        approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true,
        token_usage: { input_tokens: 3, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" as const },
        usage_cost,
      }),
    };
    const reviewer = createNativePanelReviewer(native as never, "camp");
    const vote = await reviewer("lenticel", { description: "d", action_category: "c", high_stakes: false } as never);
    expect(vote.usage_cost).toEqual(usage_cost);
  });

  it("leaves usage_cost absent when the critic reported none", async () => {
    const native = { review: async () => ({ approved: true, rationale: "ok", token_usage: { kind: "unavailable", reason: "x" } }) };
    const vote = await createNativePanelReviewer(native as never, "camp")("lenticel", { description: "d", action_category: "c", high_stakes: false } as never);
    expect(vote.usage_cost).toBeUndefined();
  });

  it("forwards the native critic's model identity so the panel path records it (TEL-1)", async () => {
    const native = { review: async () => ({ approved: true, rationale: "ok", model_identity: "provider/model-x", token_usage: { kind: "unavailable", reason: "x" } }) };
    const vote = await createNativePanelReviewer(native as never, "camp")("lenticel", { description: "d", action_category: "c", high_stakes: false } as never);
    expect(vote.model_identity).toBe("provider/model-x");
  });

  it("leaves model_identity absent when the critic reported none", async () => {
    const native = { review: async () => ({ approved: true, rationale: "ok", token_usage: { kind: "unavailable", reason: "x" } }) };
    const vote = await createNativePanelReviewer(native as never, "camp")("lenticel", { description: "d", action_category: "c", high_stakes: false } as never);
    expect("model_identity" in vote).toBe(false);
  });
});
