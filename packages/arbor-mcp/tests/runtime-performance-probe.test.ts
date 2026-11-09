import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import type { RuntimeEventEnvelope } from "@arbor/core";
import { emptyReadModel } from "@arbor/tui";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimePerformanceProbe } from "../src/runtime-performance-probe.js";
import { applyMeasuredEnvelopes } from "../src/tui.js";

const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

describe("RuntimePerformanceProbe", () => {
  it("measures the canonical TUI event fold without changing its result", () => {
    const durations: number[] = [];
    const event: RuntimeEventEnvelope = {
      schema_version: 1,
      id: "truncated-1",
      occurred_at: "2026-09-23T00:00:00.000Z",
      correlation_id: "fold-test",
      redacted: false,
      cursor: { stream_id: "fold-stream", sequence: 1 },
      event: { kind: "stream.truncated", stream_id: "fold-stream", cursor: { stream_id: "fold-stream", sequence: 0 }, dropped_records: 1 },
    };
    const result = applyMeasuredEnvelopes(emptyReadModel("fold-stream"), [event], (duration) => durations.push(duration));
    expect(result.outcome).toMatchObject({ applied: 1, truncated: true, resync_required: true });
    expect(durations).toHaveLength(1);
    expect(Number.isFinite(durations[0])).toBe(true);
    expect(durations[0]).toBeGreaterThanOrEqual(0);
  });

  it("keeps bounded quantile summaries and observes opt-in runtime boundaries", () => {
    const probe = new RuntimePerformanceProbe();
    for (const duration_ms of [0.5, 1, 3, 40, 600, 6_000]) probe.observe({ operation: "campaign_status_projection", duration_ms });
    expect(probe.snapshot()).toEqual([{
      operation: "campaign_status_projection", count: 6, total_ms: 6_644.5, max_ms: 6_000,
      p50_upper_bound_ms: 5, p95_upper_bound_ms: null,
    }]);

    const dir = mkdtempSync(join(tmpdir(), "arbor-runtime-performance-"));
    try {
      const runtimeProbe = new RuntimePerformanceProbe();
      const runtime = new ArborRuntime({ persistence_dir: dir, performance_probe: runtimeProbe });
      runtime.manager.startCampaign("perf-probe", "plan.md", rootAction);
      runtime.getCampaignRunStatus();
      runtime.checkpointSupervisor();
      const operations = new Set(runtime.getPerformanceSnapshot()?.map((row) => row.operation));
      expect(operations).toEqual(new Set([
        "runtime_startup", "runtime_event_publish", "campaign_status_projection", "supervisor_persistence",
      ]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
