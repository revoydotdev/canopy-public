import { describe, expect, it } from "vitest";
import {
  beginProjectionRequest,
  checkProjectionFreshness,
  initialProjectionLifecycle,
  markProjectionUnavailable,
  resolveProjectionFailure,
  resolveProjectionSuccess,
  type ProjectionClock,
  type ProjectionFreshnessPolicy,
} from "../src/projection-lifecycle.js";

/** Deterministic fake clock: advances only when told to. Never sleeps — ADR-078's rule against sleeping at a condition applies to fixtures too. */
function fakeClock(startIso: string): ProjectionClock & { advanceMs: (ms: number) => void; set: (iso: string) => void } {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current).toISOString(),
    advanceMs: (ms: number) => { current += ms; },
    set: (iso: string) => { current = Date.parse(iso); },
  };
}

const POLICY: ProjectionFreshnessPolicy = { projection_class: "test.class", fresh_for_ms: 5_000, max_poll_age_ms: 5_000 };
const IMMEDIATE_POLICY: ProjectionFreshnessPolicy = { projection_class: "test.immediate", fresh_for_ms: 0, max_poll_age_ms: 0 };

describe("ProjectionLifecycle closed-state fixtures (ADR-094 Decision §5.1)", () => {
  it("never-fetched: loading, no request issued, no value", () => {
    const initial = initialProjectionLifecycle<{ n: number }>("test.projection");
    expect(initial.lifecycle).toBe("loading");
    expect(initial.requested_at).toBeNull();
    expect(initial.received_at).toBeNull();
    expect(initial.value).toBeNull();
  });

  it("loading: a request is in flight and a prior value is retained", () => {
    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<{ n: number }>("test.projection");
    const ready = resolveProjectionSuccess(initial, { value: { n: 1 }, clock, policy: POLICY, transport: "connected" });
    clock.advanceMs(1_000);
    const loading = beginProjectionRequest(ready, clock, "connected");
    expect(loading.lifecycle).toBe("loading");
    expect(loading.value).toEqual({ n: 1 });
    expect(loading.requested_at).toBe(clock.now());
  });

  it("empty-ready: an empty domain result is still ready, never unavailable", () => {
    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<readonly number[]>("test.projection");
    const ready = resolveProjectionSuccess(initial, { value: [], clock, policy: POLICY, transport: "connected" });
    expect(ready.lifecycle).toBe("ready");
    expect(ready.value).toEqual([]);
  });

  it("ready: a successful value within its declared freshness budget", () => {
    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<{ n: number }>("test.projection");
    const ready = resolveProjectionSuccess(initial, { value: { n: 7 }, clock, policy: POLICY, transport: "connected" });
    expect(ready.lifecycle).toBe("ready");
    expect(ready.fresh_for_ms).toBe(5_000);
    expect(ready.expires_at).toBe(new Date(Date.parse(clock.now()) + 5_000).toISOString());
    expect(ready.last_failure).toBeNull();
  });

  it("stale-by-age: expiry crossed on read transitions ready -> stale without a failed request", () => {
    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<{ n: number }>("test.projection");
    const ready = resolveProjectionSuccess(initial, { value: { n: 7 }, clock, policy: POLICY, transport: "connected" });
    clock.advanceMs(5_001);
    const checked = checkProjectionFreshness(ready, clock);
    expect(checked.lifecycle).toBe("stale");
    expect(checked.value).toEqual({ n: 7 });
    expect(checked.last_failure).toBeNull();

    clock.set("2026-08-25T18:00:04.999Z");
    const stillFresh = checkProjectionFreshness(ready, fakeClock("2026-08-25T18:00:04.999Z"));
    expect(stillFresh.lifecycle).toBe("ready");
  });

  it("failed-after-success: a retained value is visibly stale after a failed refresh, never silently cleared or presented as current", () => {
    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<{ n: number }>("test.projection");
    const ready = resolveProjectionSuccess(initial, { value: { n: 42 }, clock, policy: POLICY, transport: "connected" });
    clock.advanceMs(1_000);
    const afterFailure = resolveProjectionFailure(ready, { code: "transport_error", diagnostic_ref: "ref-1", clock, transport: "connected" });
    expect(afterFailure.lifecycle).toBe("stale");
    expect(afterFailure.value).toEqual({ n: 42 });
    expect(afterFailure.last_failure).toEqual({ code: "transport_error", occurred_at: clock.now(), diagnostic_ref: "ref-1" });
  });

  it("unavailable: the source or capability is not available and no usable value exists", () => {
    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<{ n: number }>("test.projection");
    const unavailable = markProjectionUnavailable(initial, { code: "capability_not_configured", diagnostic_ref: null, clock, transport: "unknown" });
    expect(unavailable.lifecycle).toBe("unavailable");
    expect(unavailable.value).toBeNull();
  });

  it("failed-without-value: a request failed and no usable value exists", () => {
    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<{ n: number }>("test.projection");
    const loading = beginProjectionRequest(initial, clock, "connected");
    const failed = resolveProjectionFailure(loading, { code: "transport_error", diagnostic_ref: null, clock, transport: "connected" });
    expect(failed.lifecycle).toBe("failed");
    expect(failed.value).toBeNull();
    expect(failed.last_failure?.code).toBe("transport_error");
  });

  it("a stale envelope stays stale (never re-ready) purely from the passage of time without a new request", () => {
    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<{ n: number }>("test.projection");
    const ready = resolveProjectionSuccess(initial, { value: { n: 1 }, clock, policy: POLICY, transport: "connected" });
    clock.advanceMs(6_000);
    const stale = checkProjectionFreshness(ready, clock);
    clock.advanceMs(60_000);
    const stillStale = checkProjectionFreshness(stale, clock);
    expect(stillStale.lifecycle).toBe("stale");
  });
});

describe("wall-clock anomalies (Decision §1: typed clock reason, never negative age or renewed freshness)", () => {
  it("a clock that appears to move backward yields stale with a typed clock_anomaly reason", () => {
    const clock = fakeClock("2026-08-25T18:00:10.000Z");
    const initial = initialProjectionLifecycle<{ n: number }>("test.projection");
    const ready = resolveProjectionSuccess(initial, { value: { n: 1 }, clock, policy: POLICY, transport: "connected" });
    const backward = fakeClock("2026-08-25T17:59:00.000Z");
    const checked = checkProjectionFreshness(ready, backward);
    expect(checked.lifecycle).toBe("stale");
    expect(checked.last_failure?.code).toBe("clock_anomaly");
    expect(checked.value).toEqual({ n: 1 });
  });

  it("immediate-expiry (fresh_for_ms: 0) authority-sensitive policy is stale on the very next read", () => {
    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<{ approved: boolean }>("test.approvals");
    const ready = resolveProjectionSuccess(initial, { value: { approved: true }, clock, policy: IMMEDIATE_POLICY, transport: "connected" });
    expect(ready.lifecycle).toBe("ready");
    const checked = checkProjectionFreshness(ready, clock);
    expect(checked.lifecycle).toBe("stale");
  });
});

describe("transport, cursor, and resync (Decision §2)", () => {
  it("disconnect sets transport without inventing a lifecycle change on its own", () => {
    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<{ n: number }>("test.projection");
    const ready = resolveProjectionSuccess(initial, { value: { n: 1 }, clock, policy: POLICY, transport: "connected" });
    const disconnected = resolveProjectionFailure(ready, { code: "transport_disconnected", diagnostic_ref: null, clock, transport: "disconnected" });
    expect(disconnected.transport).toBe("disconnected");
    expect(disconnected.lifecycle).toBe("stale");
  });

  it("bounded polling satisfies the same freshness budget as an event source (same policy object, same expires_at math)", () => {
    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<{ n: number }>("test.projection");
    const polled = resolveProjectionSuccess(initial, { value: { n: 1 }, clock, policy: POLICY, transport: "unknown" });
    expect(polled.fresh_for_ms).toBe(POLICY.max_poll_age_ms);
  });
});
