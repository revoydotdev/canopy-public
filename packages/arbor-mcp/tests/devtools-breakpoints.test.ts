import { describe, it, expect } from "vitest";
import { BreakpointRegistry, kindMatches, type DevToolsBreakpointKind } from "../src/devtools-breakpoints.js";
import type { RuntimeEvent } from "@arbor/core";

const failedEvent: RuntimeEvent = { kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", state: "failed" };
const verifiedEvent: RuntimeEvent = { kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", state: "verified" };
const claimedEvent: RuntimeEvent = { kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", state: "claimed" };
const kbEvent: RuntimeEvent = { kind: "kb.entry_added", campaign_id: "c1", entry_id: "kb_1" };
const gateFailEvent: RuntimeEvent = { kind: "gate.recorded", campaign_id: "c1", node_id: "n1", gate: "isolation", result: "fail" };
const gatePassEvent: RuntimeEvent = { kind: "gate.recorded", campaign_id: "c1", node_id: "n1", gate: "isolation", result: "pass" };
const haltEvent: RuntimeEvent = { kind: "campaign.changed", campaign_id: "c1", change: "halted" };
const createdEvent: RuntimeEvent = { kind: "campaign.changed", campaign_id: "c1", change: "created" };
const otherCampaignEvent: RuntimeEvent = { kind: "tree.node_changed", campaign_id: "c2", node_id: "n2", state: "failed" };

describe("kindMatches", () => {
  const cases: Array<[DevToolsBreakpointKind, RuntimeEvent, boolean]> = [
    ["node_failed", failedEvent, true],
    ["node_failed", verifiedEvent, false],
    ["node_verified", verifiedEvent, true],
    ["node_verified", claimedEvent, false],
    ["node_claimed", claimedEvent, true],
    ["kb_entry_added", kbEvent, true],
    ["kb_entry_added", failedEvent, false],
    ["gate_failed", gateFailEvent, true],
    ["gate_failed", gatePassEvent, false],
    ["gate_passed", gatePassEvent, true],
    ["halt", haltEvent, true],
    ["halt", createdEvent, false],
    ["campaign_changed", createdEvent, true],
    ["campaign_changed", haltEvent, true],
    ["any", failedEvent, true],
    ["any", kbEvent, true],
    ["any", gatePassEvent, true],
  ];
  for (const [kind, event, expected] of cases) {
    it(`${kind} matches ${event.kind}/${("state" in event && event.state) || ("change" in event && event.change) || ("result" in event && event.result) || "—"} → ${expected}`, () => {
      expect(kindMatches(kind, event)).toBe(expected);
    });
  }
});

describe("BreakpointRegistry", () => {
  it("resolves when a matching event fires", async () => {
    const registry = new BreakpointRegistry();
    const { match } = registry.park({ kind: "node_failed" });
    const promise = match.then((m) => m.kind);
    registry.onEvent(failedEvent);
    await expect(promise).resolves.toBe("node_failed");
  });

  it("does not resolve on a non-matching event", async () => {
    const registry = new BreakpointRegistry();
    const { match } = registry.park({ kind: "node_failed" });
    let resolved = false;
    const floating = match.then(() => { resolved = true; });
    registry.onEvent(verifiedEvent);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(registry.pending()).toHaveLength(1);
    registry.clear();
    await floating.catch(() => {});
  });

  it("filters by campaign_id when set", async () => {
    const registry = new BreakpointRegistry();
    const { match } = registry.park({ kind: "node_failed", campaign_id: "c1" });
    const promise = match.then((m) => m.event);
    registry.onEvent(otherCampaignEvent);
    await Promise.resolve();
    expect(registry.pending()).toHaveLength(1);
    registry.onEvent(failedEvent);
    const result = await promise;
    expect(result).toBe(failedEvent);
  });

  it("treats null campaign_id as match-any-campaign", async () => {
    const registry = new BreakpointRegistry();
    const { match } = registry.park({ kind: "any" });
    const promise = match.then((m) => m.event);
    registry.onEvent(otherCampaignEvent);
    await expect(promise).resolves.toBe(otherCampaignEvent);
  });

  it("rejects with timeout when timeout_ms elapses without a match", async () => {
    const registry = new BreakpointRegistry();
    const { match } = registry.park({ kind: "node_failed", timeout_ms: 10 });
    await expect(match).rejects.toMatchObject({ kind: "timeout" });
    expect(registry.pending()).toHaveLength(0);
  });

  it("WA-11: defaults to a bounded timeout (never parks forever) when timeout_ms is omitted", () => {
    const registry = new BreakpointRegistry();
    const { registration } = registry.park({ kind: "node_failed" });
    expect(registration.timeout_ms).not.toBeNull();
    expect(registration.timeout_ms as number).toBeGreaterThan(0);
    expect(registration.timeout_ms as number).toBeLessThanOrEqual(30_000);
  });

  it("WA-11: clamps an excessive timeout_ms to the same bound rather than trusting the caller", () => {
    const registry = new BreakpointRegistry();
    const { registration } = registry.park({ kind: "node_failed", timeout_ms: 10_000_000 });
    expect(registration.timeout_ms).toBeLessThanOrEqual(30_000);
  });

  it("rejects with aborted when the abort signal is already aborted", async () => {
    const registry = new BreakpointRegistry();
    const controller = new AbortController();
    controller.abort();
    const { match } = registry.park({ kind: "node_failed", signal: controller.signal });
    await expect(match).rejects.toMatchObject({ kind: "aborted" });
  });

  it("rejects with aborted when the abort signal fires later", async () => {
    const registry = new BreakpointRegistry();
    const controller = new AbortController();
    const { match } = registry.park({ kind: "node_failed", signal: controller.signal });
    // Bun test (1.3.14): calling expect(promise).rejects.toMatchObject(...)
    // and holding the result before triggering a *synchronous* rejection
    // (here, via the abort listener firing inside controller.abort()) hangs
    // indefinitely — reproduced in isolation with a bare Promise + no
    // @arbor code involved. Vitest handles this ordering fine; awaiting the
    // matcher directly (as every other rejects-assertion in this file
    // already does) sidesteps the bug without changing what is asserted.
    controller.abort();
    await expect(match).rejects.toMatchObject({ kind: "aborted" });
  });

  it("clear() rejects all matching breakpoints and returns the count", async () => {
    const registry = new BreakpointRegistry();
    const a = registry.park({ kind: "node_failed", campaign_id: "c1" });
    const b = registry.park({ kind: "kb_entry_added", campaign_id: "c1" });
    const c = registry.park({ kind: "node_verified", campaign_id: "c2" });
    const cleared = registry.clear("c1");
    expect(cleared).toBe(2);
    await expect(a.match).rejects.toMatchObject({ kind: "cleared" });
    await expect(b.match).rejects.toMatchObject({ kind: "cleared" });
    expect(registry.pending()).toEqual([c.registration]);
    registry.clear();
    await expect(c.match).rejects.toMatchObject({ kind: "cleared" });
  });
  it("clear() with no argument clears every parked breakpoint", async () => {
    const registry = new BreakpointRegistry();
    const a = registry.park({ kind: "node_failed" });
    const b = registry.park({ kind: "halt" });
    const c = registry.park({ kind: "any" });
    const cleared = registry.clear();
    expect(cleared).toBe(3);
    expect(registry.pending()).toHaveLength(0);
    await Promise.allSettled([a.match, b.match, c.match]);
  });

  it("multiple breakpoints can resolve on the same matching event", async () => {
    const registry = new BreakpointRegistry();
    const a = registry.park({ kind: "node_failed" });
    const b = registry.park({ kind: "node_failed" });
    registry.onEvent(failedEvent);
    await expect(a.match).resolves.toBeDefined();
    await expect(b.match).resolves.toBeDefined();
  });

  it("any matches every event variant", async () => {
    const registry = new BreakpointRegistry();
    const { match } = registry.park({ kind: "any" });
    const promise = match.then((m) => m.event);
    registry.onEvent(kbEvent);
    await expect(promise).resolves.toBe(kbEvent);
  });

  it("registration record reflects the input", () => {
    const registry = new BreakpointRegistry({ now: () => "2026-01-01T00:00:00.000Z" });
    const { registration, match } = registry.park({ kind: "halt", campaign_id: "c1", timeout_ms: 5000 });
    // Never resolved/observed on purpose (this test only cares about the
    // registration record) — but an abandoned 5s timeout would otherwise
    // reject `match` later with nothing attached to it. Under vitest that
    // went unnoticed; bun:test (1.3.14) surfaces it as a real "unhandled
    // error between tests" against whatever test happens to be running when
    // the timer fires. Clearing the breakpoint and swallowing the resulting
    // rejection makes the cleanup explicit instead of relying on process
    // teardown timing.
    match.catch(() => {});
    registry.clear();
    expect(registration.kind).toBe("halt");
    expect(registration.campaign_id).toBe("c1");
    expect(registration.timeout_ms).toBe(5000);
    expect(registration.registered_at).toBe("2026-01-01T00:00:00.000Z");
    expect(registration.id).toMatch(/^bp_/);
  });

  it("no-op when an event fires and no breakpoints are parked", () => {
    const registry = new BreakpointRegistry();
    expect(() => registry.onEvent(failedEvent)).not.toThrow();
  });

  it("cleans up the timeout handle when a breakpoint resolves on event", async () => {
    const registry = new BreakpointRegistry();
    const { match } = registry.park({ kind: "node_failed", timeout_ms: 5000 });
    registry.onEvent(failedEvent);
    await match;
    await new Promise((r) => setTimeout(r, 10));
    expect(registry.pending()).toHaveLength(0);
  });
});
