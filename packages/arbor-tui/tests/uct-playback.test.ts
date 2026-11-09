import { describe, expect, it } from "vitest";
import { initialUctPlayback, observeUctPlayback } from "../src/uct-playback.js";
import { initialModel } from "../src/model.js";
import { update } from "../src/update.js";

const line = (at: number, id = "child", campaign = "c") => ({
  ts: new Date(at).toISOString(), campaign_id: campaign, synthetic: false,
  event_kind: "loop.backtracked", loop_event: { node_id: id, parent_id: "root" },
});

describe("model-owned UCT playback", () => {
  it("baselines history and retains a newly observed event after a slow poll", () => {
    const baseline = observeUctPlayback(initialUctPlayback(), { lines: [line(100)] }, "c", 1_000);
    expect(baseline.pending).toEqual([]);
    const next = observeUctPlayback(baseline, { lines: [line(100), line(1_100)] }, "c", 5_000);
    expect(next.pending).toEqual([{ from: "child", to: "root", occurred_at_ms: 1_100, playback_at_ms: 5_000 }]);
    expect(observeUctPlayback(next, { lines: [line(1_100)] }, "c", 7_000).pending).toEqual([]);
    expect(observeUctPlayback(next, { lines: [line(1_100)] }, "other", 5_500).pending).toEqual([]);
  });
  it("bounds and serializes bursts, disclosing dropped playback exactly once", () => {
    const baseline = observeUctPlayback(initialUctPlayback(), { lines: [] }, "c", 1_000);
    const stream = { lines: Array.from({ length: 20 }, (_, i) => line(1_100 + i, `n${i}`)) };
    const next = observeUctPlayback(baseline, stream, "c", 5_000);
    expect(next.pending).toHaveLength(16);
    expect(next.pending[1]?.playback_at_ms).toBe(6_500);
    expect(next.dropped).toBe(4);
    expect(observeUctPlayback(next, stream, "c", 5_100).dropped).toBe(4);
  });
  it("folds real Console receipts but not UI-only query echoes", () => {
    const base = { ...initialModel(), telemetryCampaignId: "c" };
    const baseline = update(base, { type: "query_results", queryId: "a", screen: "console", value: { devtools: { lines: [] } }, observed_at_ms: 1_000 }).model;
    const value = { devtools: { lines: [line(1_100)] } };
    const echo = update(baseline, { type: "query_results", queryId: "echo", screen: "console", value }).model;
    expect(echo.uctPlayback).toBe(baseline.uctPlayback);
    const next = update(echo, { type: "query_results", queryId: "b", screen: "console", value, observed_at_ms: 5_000 }).model;
    expect(next.uctPlayback.pending).toHaveLength(1);
  });
});
