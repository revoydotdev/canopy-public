import { describe, expect, it } from "vitest";
import { aggregatePanelUsageCost, buildNodeCostAttribution, detectRedundantToolCalls } from "@arbor/campaign-support";

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  input_tokens: input, output_tokens: output, cached_input_tokens: cacheRead,
  cache_write_input_tokens: cacheWrite, counter_source: "provider_counter" as const,
});
const cost = (minor_units: number) => ({ kind: "priced" as const, minor_units, currency: "USD", minor_unit_exponent: 6, price_source_id: "fixture:v1" });

describe("node cost attribution", () => {
  it("ranks spans by attributable cost and emits an advisory unproductive signal", () => {
    const record = buildNodeCostAttribution({
      identity: { operation_id: "op", epoch: 1, phase: "backprop", outcome: "failure", source_evidence_id: "evidence",
        idempotency_key: "node-cost:1", provenance: { tag: "generated", generator: "test", input_hash: "input" } },
      calls: [
        { span_id: "specialist", kind: "specialist", usage: usage(10, 2, 80, 4), cost: cost(30) },
        { span_id: "critic", kind: "critic", usage: usage(5, 5, 0, 0), cost: cost(70) },
      ], tool_call_signatures: ["file.read: README.md", " FILE.READ:  README.md "],
      produced_verified_progress: false, expensive_threshold_minor_units: 100,
    });
    expect(record.total_tokens).toEqual({ input: 15, output: 7, cache_read: 80, cache_write: 4 });
    expect(record.total_cost).toMatchObject({ kind: "priced", minor_units: 100 });
    expect(record.top_cost_spans.map((span) => span.span_id)).toEqual(["critic", "specialist"]);
    expect(record.redundant_tool_calls).toEqual([{ normalized_signature: "file.read: readme.md", count: 2 }]);
    expect(record.pruning_signal).toBe("expensive_unproductive");
  });

  it("uses fuzzy matching only as a surfaced heuristic", () => {
    expect(detectRedundantToolCalls(["shell:bun run test", "shell:bun run tests", "file:README"])).toEqual([
      { normalized_signature: "shell:bun run test", count: 2 },
    ]);
  });

  describe("aggregatePanelUsageCost", () => {
    const vote = (minor: number | null, source = "fixture:v1") => ({
      approved: true, rationale: "ok", token_usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" as const },
      ...(minor === null ? {} : { usage_cost: { provider: "other" as const, model_family: "other" as const, cost: { ...cost(minor), price_source_id: source } } }),
    });
    it("sums priced reviewers under one schedule", () => {
      expect(aggregatePanelUsageCost({ lenticel: vote(3), burl: vote(4) })?.cost).toMatchObject({ kind: "priced", minor_units: 7 });
    });
    it("is unpriced, with a reason, when a reviewer with usage has no cost or schedules differ", () => {
      expect(aggregatePanelUsageCost({ lenticel: vote(3), burl: vote(null) })?.cost.kind).toBe("unpriced");
      expect(aggregatePanelUsageCost({ lenticel: vote(3), burl: vote(4, "other:v2") })?.cost.kind).toBe("unpriced");
    });
    it("gives a review with no reported usage no cost", () => {
      expect(aggregatePanelUsageCost({ lenticel: { approved: true, rationale: "ok" } })).toBeUndefined();
    });
  });
});
