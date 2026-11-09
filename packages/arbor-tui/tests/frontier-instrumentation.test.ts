import { describe, expect, it } from "vitest";
import { FrontierInstrumentation, type InstrumentationClock, type OperatorMetricReceipt } from "../src/frontier-instrumentation.js";

class ManualClock implements InstrumentationClock {
  value = 0;
  now(): number { return this.value; }
  advance(milliseconds: number): void { this.value += milliseconds; }
}

describe("frontier instrumentation", () => {
  it("records injected-clock input/event projection latency and a renderer invocation without using a commit as a proxy", () => {
    const clock = new ManualClock();
    const observed: OperatorMetricReceipt[] = [];
    const metrics = new FrontierInstrumentation({ clock, observer: { observe: (receipt) => observed.push(receipt) } });

    const input = metrics.beginLatency("input", "intent-1");
    clock.advance(12);
    expect(metrics.observeProjection(input)).toMatchObject({ metric: "input_to_projection_ms", state: "observed", duration_ms: 12 });

    const event = metrics.beginLatency("canonical_event", "event-1");
    clock.advance(7);
    expect(metrics.observeProjection(event)).toMatchObject({ metric: "canonical_event_to_projection_ms", state: "observed", duration_ms: 7 });

    const render = metrics.beginRendererInvocation();
    clock.advance(4);
    expect(metrics.observeRendererInvocation(render)).toMatchObject({ metric: "renderer_invocation_ms", state: "observed", duration_ms: 4 });
    expect(observed).toHaveLength(3);
  });

  it("makes absent renderer-commit observation inconclusive rather than fabricating visible latency", () => {
    const clock = new ManualClock();
    const metrics = new FrontierInstrumentation({ clock });
    const event = metrics.beginLatency("canonical_event", "event-7");
    clock.advance(30);

    expect(metrics.rendererCommitInconclusive(event)).toMatchObject({
      metric: "canonical_event_to_renderer_commit_ms",
      state: "inconclusive",
      correlation_id: "event-7",
      reason: "no renderer commit observer is installed",
    });
    expect(metrics.receipts()[0]?.duration_ms).toBeUndefined();
  });

  it("accepts renderer commit latency only through the explicit observer boundary", () => {
    const clock = new ManualClock();
    const metrics = new FrontierInstrumentation({ clock });
    const input = metrics.beginLatency("input", "intent-2");
    clock.advance(19);

    expect(metrics.observeRendererCommit(input)).toMatchObject({
      metric: "input_to_renderer_commit_ms",
      state: "observed",
      duration_ms: 19,
    });
  });

  it("retains bounded receipts while tracking queue and retention high-water marks", () => {
    const clock = new ManualClock();
    const metrics = new FrontierInstrumentation({ clock, receipt_limit: 2 });
    metrics.observeQueueRetention({ pending: 2, retained_rows: 8, retained_bytes: 100 });
    metrics.observeQueueRetention({ pending: 1, retained_rows: 12, retained_bytes: 80 });
    const receipt = metrics.observeQueueRetention({ pending: 5 });

    expect(receipt).toMatchObject({
      metric: "queue_retention_high_water",
      state: "observed",
      queue_high_water: { pending: 5, retained_rows: 12, retained_bytes: 100 },
    });
    expect(metrics.receipts()).toHaveLength(2);
    expect(metrics.evictedReceipts()).toBe(1);
  });

  it("reports unknown counters and cleanup scope as inconclusive", () => {
    const metrics = new FrontierInstrumentation({ clock: new ManualClock() });
    expect(metrics.observeQueueRetention({})).toMatchObject({ state: "inconclusive", reason: "queue and retention counters were not supplied" });
    expect(metrics.observeResourceSettlement()).toMatchObject({ state: "inconclusive", reason: "expected resource scope was not supplied" });
  });

  it("records scoped resource settlement without claiming process-wide cleanup", () => {
    const metrics = new FrontierInstrumentation({ clock: new ManualClock() });
    metrics.observeResourceAcquired("subscription-1", "subscription");
    expect(metrics.observeResourceSettlement(["subscription-1"])).toMatchObject({
      state: "observed",
      resources: { settlement: "pending", active_resource_ids: ["subscription-1"] },
    });
    metrics.observeResourceReleased("subscription-1");
    expect(metrics.observeResourceSettlement(["subscription-1"])).toMatchObject({
      state: "observed",
      resources: { settlement: "settled", active_resource_ids: [] },
    });
    expect(metrics.observeResourceSettlement(["never-observed"])).toMatchObject({ state: "inconclusive", resources: { settlement: "unknown" } });
  });

  it("keeps reduced-capability facts factual and marks an empty report inconclusive", () => {
    const metrics = new FrontierInstrumentation({ clock: new ManualClock() });
    expect(metrics.observeAccessibilityCapabilities({ color_mode: "none", unicode: false, reduced_motion: true, tty: false })).toMatchObject({
      state: "observed",
      accessibility: { color_mode: "none", unicode: false, reduced_motion: true, tty: false },
    });
    expect(metrics.observeAccessibilityCapabilities({})).toMatchObject({ state: "inconclusive" });
  });
});
