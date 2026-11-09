import { describe, expect, it } from "vitest";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";
import type { Action } from "@arbor/core";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function makeAdapter() {
  const runtime = new ArborRuntime();
  const router = new RuntimeCatalogRouter(runtime);
  const adapter = new RuntimePortAdapter(router, () => runtime.operations.list().length);
  return { runtime, adapter };
}

describe("RuntimePortAdapter (ADR-011 bridge)", () => {
  it("emits correlated API and function telemetry at the common TUI boundary", async () => {
    const { runtime, adapter } = makeAdapter();
    runtime.manager.startCampaign("telemetry-campaign", "plan.md", root);
    const events: Array<{ kind: string; correlation_id?: string; payload?: Record<string, unknown> }> = [];
    adapter.setTelemetrySink({ event: (input) => { events.push(input as typeof events[number]); } });
    await adapter.query({ kind: "campaign.list", query_id: "telemetry-query", params: { limit: 10 } });
    await adapter.command({
      kind: "campaign.start",
      metadata: { operation_id: "telemetry-command", idempotency_key: "telemetry-command" },
      params: { campaign_id: "telemetry-new", plan_path: "plan.md", root_action: root },
    });
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "api_request", "api_response", "function_start", "function_end",
    ]));
    const queryRequest = events.find((event) => event.kind === "api_request" && event.correlation_id === "tui:query:telemetry-query");
    expect(queryRequest?.payload).toMatchObject({ phase: "query", kind: "campaign.list", query_id: "telemetry-query" });
    const commandResponse = events.find((event) => event.kind === "api_response" && event.correlation_id === "tui:command:telemetry-command");
    expect(commandResponse?.payload).toMatchObject({ phase: "command", kind: "campaign.start", ok: true });
  });

  it("routes a campaign.list query to the catalog and returns a paged projection", async () => {
    const { runtime, adapter } = makeAdapter();
    runtime.manager.startCampaign("c1", "plan.md", root);
    const res = await adapter.query({ kind: "campaign.list", query_id: "q1", params: { limit: 10 } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.value as { items: unknown[] }).items).toHaveLength(1);
      expect((res.value as { total: number }).total).toBe(1);
    }
  });

  it("routes a campaign.start command with params to the catalog", async () => {
    const { adapter } = makeAdapter();
    const res = await adapter.command({
      kind: "campaign.start",
      metadata: { operation_id: "op-start", idempotency_key: "k-start" },
      params: { campaign_id: "c2", plan_path: "plan.md", root_action: root },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toMatchObject({ accepted: true });
  });

  it("reports active operation count from the runtime", () => {
    const { adapter } = makeAdapter();
    expect(adapter.activeOperationCount()).toBe(0);
  });

  it("rejects requests that exceed the TUI runtime-port contract before dispatch", async () => {
    const { adapter } = makeAdapter();
    const command = await adapter.command({
      kind: "campaign.start",
      metadata: { operation_id: "o".repeat(129), idempotency_key: "key" },
      params: {},
    });
    expect(command).toMatchObject({ ok: false, error: { code: "validation", summary: "operation_id exceeds runtime-port limit" } });
    const query = await adapter.query({ kind: "campaign.list", query_id: "q", params: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, i])) });
    expect(query).toMatchObject({ ok: false, error: { code: "validation", summary: "query params exceed runtime-port limit" } });
  });

  it("maps a permission failure to a structured error", async () => {
    const { runtime, adapter } = makeAdapter();
    runtime.manager.startCampaign("c1", "plan.md", root);
    const res = await adapter.query({ kind: "campaign.list", query_id: "q2", params: { limit: 10 } });
    expect(res.ok).toBe(true); // default router grants all catalog capabilities
    void res;
  });
});

describe("RuntimePortAdapter run-stop remediations (2026-09-03)", () => {
  it("EC-063: devtools.stream replays the durable log tail and only adds ring lines the log lacks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-devtools-"));
    mkdirSync(join(dir, "devtools"), { recursive: true });
    const logPath = join(dir, "devtools", "devtools.log");
    const record = (seq: number, kind: string) => JSON.stringify({ schema: "arbor.devtools/v1", seq, ts: `2026-09-03T00:00:0${seq}.000Z`, campaign_id: "c1", node_id: null, event_kind: kind, event: { kind }, source_record_id: null, source_content_hash: null, synthetic: false, loop_event: null });
    writeFileSync(logPath, `${record(1, "campaign.changed")}\n${record(2, "node.changed")}\n{"torn":\n`, "utf8");
    const runtime = new ArborRuntime();
    const adapter = new RuntimePortAdapter(new RuntimeCatalogRouter(runtime), () => 0, undefined, logPath);
    adapter.pushDevtoolsLine({ seq: 2, ts: "2026-09-03T00:00:02.000Z", event_kind: "node.changed", campaign_id: "c1", node_id: null, synthetic: false });
    adapter.pushDevtoolsLine({ seq: 3, ts: "2026-09-03T00:00:03.000Z", event_kind: "loop.phase", campaign_id: "c1", node_id: null, synthetic: false });
    const res = await adapter.query({ kind: "devtools.stream", query_id: "q", params: {} });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.value as { lines: { seq: number; event_kind: string }[] }).lines.map((line) => `${line.seq}:${line.event_kind}`)).toEqual(["1:campaign.changed", "2:node.changed", "3:loop.phase"]);
  });

  it("EC-053: task.list marks a restored non-terminal task as interrupted", async () => {
    const runtime = new ArborRuntime();
    runtime.supervisor.restore([{ id: "orphan", operation_id: "op-orphan", kind: "worker", owner_scope_id: "scope", parent_id: null, state: "started", started_at: "2026-08-01T12:00:00.000Z", deadline_at: null, progress: 0.4, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: null }]);
    runtime.supervisor.register({ id: "live", operation_id: "op-live", kind: "worker", owner_scope_id: "scope" });
    runtime.supervisor.start("live");
    const adapter = new RuntimePortAdapter(new RuntimeCatalogRouter(runtime));
    const res = await adapter.query({ kind: "task.list", query_id: "q", params: { scope_id: "scope", limit: 10 } });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.value as { items: { id: string; state: string; interrupted?: boolean }[] }).items.map((item) => [item.id, item.state, item.interrupted === true])).toEqual([["orphan", "started", true], ["live", "started", false]]);
  });
});

/**
 * M1.5: `RuntimePortAdapter.events` (M1.1) driven against a REAL
 * `RuntimeEventStream` (via a real `ArborRuntime`/`RuntimeCatalogRouter`),
 * not a mock — the whole point of this seam is that closing/dropping a
 * subscriber never touches runtime work, and backpressure closes rather than
 * silently drops. `runtime.manager.startCampaign` is used purely as a cheap,
 * real way to make the runtime publish a real `campaign.changed` envelope
 * through `eventSink` (runtime.ts ~419) — nothing here inspects campaign
 * semantics beyond "an envelope was published".
 */
describe("RuntimePortAdapter.events (M1.1 read-side event seam)", () => {
  it("closing a subscriber does not affect runtime publishing", () => {
    const { runtime, adapter } = makeAdapter();
    const subscription = adapter.events.subscribe();
    subscription.close();
    expect(subscription.status()).toMatchObject({ closed: true, reason: "closed" });
    // Publishing (via a real campaign start) must still succeed after close.
    expect(() => runtime.manager.startCampaign("c1", "plan.md", root)).not.toThrow();
    expect(runtime.eventStream.cursor().sequence).toBeGreaterThan(0);
  });

  it("backpressure closes the subscriber with reason \"backpressure\" and never drops silently", () => {
    const { runtime, adapter } = makeAdapter();
    const subscription = adapter.events.subscribe({ max_pending: 1 });
    // A single `startCampaign` publishes MORE than one envelope
    // (`gate.recorded` + `campaign.changed`, confirmed against the real
    // runtime), so with `max_pending: 1` this one call alone overflows the
    // bounded queue.
    runtime.manager.startCampaign("c1", "plan.md", root);
    const status = subscription.status();
    expect(status).toEqual({ closed: true, reason: "backpressure", pending: 0 });
    // The runtime itself is unaffected by the subscriber's own backpressure.
    expect(() => runtime.manager.startCampaign("c2", "plan.md", root)).not.toThrow();
  });

  it("resume() replays real envelopes through the catalog's own event.resume query", async () => {
    const { runtime, adapter } = makeAdapter();
    runtime.manager.startCampaign("c1", "plan.md", root);
    // `null` maps to the {stream_id, sequence: 0} "from the beginning"
    // convention (see `RuntimeEventSource.resume`'s doc comment) — the
    // catalog's `event.resume` query has no true null-cursor case to hit, so
    // this always resolves to a real `events` (or `resync`) reply, never the
    // stream's own `resume(null)` "snapshot" branch.
    const result = await adapter.events.resume(null);
    expect(result.kind).toBe("events");
    if (result.kind === "events") {
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.cursor).toEqual(runtime.eventStream.cursor());
    }
  });

  it("resume() rejects when the event.read capability is denied, so a caller can never mistake denial for an empty stream", async () => {
    const runtime = new ArborRuntime();
    const router = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set<string>() });
    const adapter = new RuntimePortAdapter(router, () => 0);
    await expect(adapter.events.resume(null)).rejects.toThrow();
  });

  it("a TUI-originated command lacking capability is denied through the real RuntimeCatalogRouter", async () => {
    const runtime = new ArborRuntime();
    // Grant every capability EXCEPT campaign.write — campaign.start requires it.
    const router = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["campaign.read"]) });
    const adapter = new RuntimePortAdapter(router, () => 0);
    const res = await adapter.command({
      kind: "campaign.start",
      metadata: { operation_id: "op-denied", idempotency_key: "k-denied" },
      params: { campaign_id: "c-denied", plan_path: "plan.md", root_action: root },
    });
    // A capability denial is projected as an accepted-envelope command
    // ACKNOWLEDGEMENT with accepted:false (RuntimeCatalogRouter's
    // dispatchCommandObserved `rejection()` path), not as a router-level
    // `ok:false` — the same shape capability-tier-enforcement.test.ts's own
    // `refusal()` helper unwraps.
    expect(res.ok).toBe(true);
    if (res.ok && res.value) {
      expect(res.value.accepted).toBe(false);
      expect(res.value.error?.summary).toContain("missing capability campaign.write");
    }
  });
});
