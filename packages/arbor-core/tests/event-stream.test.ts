import { describe, expect, it } from "vitest";
import { EventStreamError, RuntimeEventStream } from "../src/index.js";
import type { RuntimeEventEnvelope } from "../src/index.js";

function event(id: string): Omit<RuntimeEventEnvelope, "cursor" | "schema_version"> {
  return {
    id,
    occurred_at: "2026-08-01T12:00:00.000Z",
    correlation_id: "correlation",
    redacted: false,
    event: { kind: "campaign.changed", campaign_id: "campaign", change: "created" },
  };
}

describe("RuntimeEventStream", () => {
  it("assigns monotonic cursors and returns detached bounded records", () => {
    const stream = new RuntimeEventStream("runtime", 2);
    const one = stream.publish(event("one"));
    const two = stream.publish(event("two"));
    stream.publish(event("three"));

    expect(one.cursor).toEqual({ stream_id: "runtime", sequence: 1 });
    expect(two.cursor).toEqual({ stream_id: "runtime", sequence: 2 });
    expect(stream.cursor()).toEqual({ stream_id: "runtime", sequence: 3 });
    const resumed = stream.resume({ stream_id: "runtime", sequence: 1 }, { campaigns: 3 });
    expect(resumed).toMatchObject({ kind: "events", events: [{ id: "two" }, { id: "three" }] });
    if (resumed.kind === "events") resumed.events[0].id = "mutated";
    expect(stream.resume({ stream_id: "runtime", sequence: 1 }, {}).kind).toBe("events");
    // Duplicate tracking is bounded with retained history, not an unbounded registry.
    expect(stream.publish(event("one")).cursor.sequence).toBe(4);
  });

  it("rejects invalid and duplicate events without advancing its cursor", () => {
    const stream = new RuntimeEventStream("runtime");
    stream.publish(event("one"));
    expect(() => stream.publish(event("one"))).toThrow(EventStreamError);
    expect(() => stream.publish({ ...event("bad"), occurred_at: "not a timestamp" })).toThrow(EventStreamError);
    expect(stream.cursor().sequence).toBe(1);
  });

  it("makes snapshot, gap, wrong-stream, and future-cursor recovery explicit", () => {
    const stream = new RuntimeEventStream("runtime", 2);
    stream.publish(event("one"));
    stream.publish(event("two"));
    stream.publish(event("three"));

    expect(stream.resume(null, { version: 1 })).toMatchObject({ kind: "snapshot", snapshot: { cursor: { sequence: 3 } } });
    expect(stream.resume({ stream_id: "other", sequence: 3 }, {}).kind).toBe("resync");
    expect(stream.resume({ stream_id: "runtime", sequence: 4 }, {})).toMatchObject({ kind: "resync", reason: "ahead" });
    expect(stream.resume({ stream_id: "runtime", sequence: 0 }, {})).toMatchObject({ kind: "resync", reason: "gap" });
  });

  it("closes slow subscribers on backpressure instead of silently dropping control events", () => {
    const stream = new RuntimeEventStream("runtime");
    const slow = stream.subscribe({ max_pending: 1 });
    const fast = stream.subscribe({ max_pending: 2 });
    stream.publish(event("one"));
    stream.publish(event("two"));

    expect(slow.status()).toEqual({ closed: true, reason: "backpressure", pending: 0 });
    expect(fast.poll()).toHaveLength(2);
    fast.close();
    expect(fast.status()).toEqual({ closed: true, reason: "closed", pending: 0 });
  });
});
