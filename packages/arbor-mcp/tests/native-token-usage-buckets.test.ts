import { describe, expect, it } from "vitest";
import { tokenUsage } from "../src/native-agent-executor.js";
import type { NativeUsageAndCost } from "@arbor/harness";

/**
 * The native specialist's token record must be reconstructible.
 *
 * `TokenUsage.input_tokens` is documented as fresh input "excluding the two
 * cache buckets", and the cache buckets as "disjoint prompt-input buckets", so
 * `input + cached + cache_write` is the provider's prompt total. The executor
 * read `input_tokens` from the `usage` event -- which is ALREADY net of cache,
 * because `parseUsage` computes `prompt_tokens - cacheRead - cacheWrite` -- and
 * hardcoded both cache buckets to 0. Every cached prompt token therefore
 * disappeared: measured on sonnet with a 25-tool catalogue, 22 fresh input
 * reported across 6 turns against roughly 6,900 actual prompt tokens per turn.
 */
const measured = (input: number, output: number, cacheRead: number, cacheWrite: number): NativeUsageAndCost => ({
  tokens: { kind: "measured", input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite },
  cost: { kind: "unpriced", reason: "no attributable price schedule" },
});

const usageEvent = (input_tokens: number | null, output_tokens: number | null) => ({
  kind: "usage",
  session_id: "s",
  sequence: 1,
  occurred_at: "2026-09-27T00:00:00.000Z",
  payload: { input_tokens, output_tokens },
}) as never;

describe("tokenUsage", () => {
  it("reports all four buckets from the session's measured usage", () => {
    const result = tokenUsage([usageEvent(3, 6)], measured(3, 6, 6181, 751));
    expect(result).toEqual({
      input_tokens: 3,
      output_tokens: 6,
      cached_input_tokens: 6181,
      cache_write_input_tokens: 751,
      counter_source: "provider_counter",
    });
  });

  it("keeps the prompt total reconstructible from the record", () => {
    const result = tokenUsage([], measured(22, 19142, 6181, 751)) as { input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number };
    // The provider saw 22 fresh + 6181 cached-read + 751 cache-write.
    expect(result.input_tokens + result.cached_input_tokens + result.cache_write_input_tokens).toBe(6954);
    // The defect: cache buckets were zeroed, so this collapsed to 22.
    expect(result.cached_input_tokens).not.toBe(0);
    expect(result.cache_write_input_tokens).not.toBe(0);
  });

  it("does not prefer a net-of-cache event over the measured session total", () => {
    // The event alone carries 3 fresh input and no cache buckets at all. The
    // measured total is the only source that can satisfy TokenUsage's contract.
    const result = tokenUsage([usageEvent(3, 6)], measured(3, 6, 6181, 751));
    expect(result).not.toMatchObject({ cached_input_tokens: 0, cache_write_input_tokens: 0 });
  });

  it("reports unavailable rather than fabricating zero cache buckets", () => {
    const result = tokenUsage([usageEvent(3, 6)], null);
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(result).not.toMatchObject({ cached_input_tokens: 0 });
  });

  it("reports unavailable when the provider reported nothing at all", () => {
    expect(tokenUsage([], null)).toMatchObject({ kind: "unavailable" });
  });

  it("preserves the provider's own unavailability reason", () => {
    const event = { kind: "usage", session_id: "s", sequence: 1, occurred_at: "2026-09-27T00:00:00.000Z", payload: { input_tokens: null, output_tokens: null, unavailable_reason: "provider omitted usage" } } as never;
    expect(tokenUsage([event], null)).toMatchObject({ kind: "unavailable", reason: "provider omitted usage" });
  });
});
