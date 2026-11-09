import { describe, expect, it, vi } from "vitest";
import { HeadlessHarness } from "../src/index.js";
import type { RuntimePort } from "../src/runtime-port.js";

const inertRuntime: RuntimePort = {
  command: async () => ({ ok: false, error: { code: "unavailable", summary: "test runtime is inactive" }, capability: null }),
  query: async () => ({ ok: false, error: { code: "unavailable", summary: "test runtime is inactive" }, capability: null }),
  activeOperationCount: () => 0,
};

describe("HeadlessHarness", () => {
  it("interprets effects through injected ports and records them", async () => {
    const client = {
      connect: vi.fn(), disconnect: vi.fn(), requestSnapshot: vi.fn(), close: vi.fn(), interruptCampaign: vi.fn(),
    };
    const terminal = { restore: vi.fn() };
    const harness = new HeadlessHarness({ client, terminal, clock: { now: () => 42 }, telemetrySource: { fetch: async () => ({ campaign_id: "c1", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) }, runtime: inertRuntime });

    expect(harness.now()).toBe(42);
    // No UiIntent constructs the "connect" effect in production (DEF-02) --
    // the boot path seeds `snapshot_received` directly instead of driving
    // connect/transport_connecting/transport_connected -- so this test
    // exercises the reachable half of the port: a raw `transport_connected`
    // AppEvent (still a real reducer branch) through to `request_shutdown`'s
    // teardown chain, not the now-unreachable "connect" intent that used to
    // seed this test.
    await harness.dispatch({ type: "transport_connected" });
    await harness.dispatch({ type: "ui_intent", intent: { type: "request_shutdown" }, at: harness.now() });

    expect(client.connect).not.toHaveBeenCalled();
    expect(client.requestSnapshot).toHaveBeenCalledWith(null);
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.interruptCampaign).toHaveBeenCalledOnce();
    expect(terminal.restore).toHaveBeenCalledOnce();
    expect(harness.effects.map((effect) => effect.type)).toEqual([
      "request_snapshot", "interrupt_campaign", "disconnect", "close_client", "restore_terminal",
    ]);
  });

  it("requires two interrupt presses and does not fire again on a third", async () => {
    const client = {
      connect: vi.fn(), disconnect: vi.fn(), requestSnapshot: vi.fn(), close: vi.fn(), interruptCampaign: vi.fn(),
    };
    const terminal = { restore: vi.fn() };
    const harness = new HeadlessHarness({ client, terminal, clock: { now: () => 1 }, telemetrySource: { fetch: async () => ({ campaign_id: "c1", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) }, runtime: inertRuntime });

    await harness.dispatch({ type: "ui_intent", intent: { type: "interrupt_active_campaign" }, at: 1 });
    expect(client.interruptCampaign).not.toHaveBeenCalled();
    expect(harness.model.repeatConfirmation?.hint).toBe("press again to interrupt");
    await harness.dispatch({ type: "ui_intent", intent: { type: "interrupt_active_campaign" }, at: 2 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "interrupt_active_campaign" }, at: 3 });

    expect(client.interruptCampaign).toHaveBeenCalledOnce();
    expect(harness.effects.map((effect) => effect.type)).toEqual(["schedule_repeat_confirmation_clear", "interrupt_campaign"]);
  });

  it("awaits asynchronous effect completion in order", async () => {
    const order: string[] = [];
    const harness = new HeadlessHarness({
      client: {
        connect: async () => { order.push("connect"); },
        disconnect: async () => { order.push("disconnect"); },
        requestSnapshot: async () => { order.push("snapshot"); },
        close: async () => { order.push("close"); },
        interruptCampaign: async () => { order.push("interrupt"); },
      },
      terminal: { restore: async () => { order.push("restore"); } },
      clock: { now: () => 1 },
      telemetrySource: { fetch: async () => ({ campaign_id: "c1", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) },
      runtime: inertRuntime,
    });
    await harness.dispatch({ type: "ui_intent", intent: { type: "request_shutdown" }, at: 1 });
    expect(order).toEqual(["interrupt", "disconnect", "close", "restore"]);
  });

  it("reduces runtime command/query successes and every surfaced runtime failure", async () => {
    const client = { connect: vi.fn(), disconnect: vi.fn(), requestSnapshot: vi.fn(), close: vi.fn(), interruptCampaign: vi.fn() };
    const terminal = { restore: vi.fn() };
    const telemetrySource = { fetch: vi.fn()
      .mockResolvedValueOnce({ campaign_id: "c1", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] })
      .mockRejectedValueOnce(new Error("telemetry offline")) };
    const runtime = {
      command: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { accepted: true, operation_id: "op-1" }, capability: "job.write" })
        .mockResolvedValueOnce({ ok: false, error: { code: "permission", summary: "job.write denied" }, capability: "job.write" }),
      query: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { jobs: [] }, capability: "job.read" })
        .mockResolvedValueOnce({ ok: false, error: { code: "permission", summary: "denied" }, capability: "job.read" })
        .mockRejectedValueOnce(new Error("query offline")),
      activeOperationCount: () => 0,
    } as unknown as RuntimePort;
    const harness = new HeadlessHarness({ client, terminal, clock: { now: () => 42 }, telemetrySource, runtime });

    // "issue_command" was a generic dispatch_command passthrough nothing in
    // production ever constructed (DEF-02) -- deleted. The real production
    // path to a dispatch_command effect is a screen-scoped intent; the jobs
    // screen's `toggle_job_queue` reads the already-fetched `queue_paused`
    // flag and issues the complementary job.pause/job.resume command, so it
    // exercises the identical runtime.command plumbing this test cares about.
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "jobs" }, at: 0 });
    await harness.dispatch({ type: "query_results", queryId: "jobs-seed-1", screen: "jobs", value: { queue_paused: false } });
    await harness.dispatch({ type: "ui_intent", intent: { type: "toggle_job_queue" }, at: 1 });
    await harness.dispatch({ type: "query_results", queryId: "jobs-seed-2", screen: "jobs", value: { queue_paused: true } });
    await harness.dispatch({ type: "ui_intent", intent: { type: "toggle_job_queue" }, at: 2 });
    // Back to the default screen so the query-result fallback below lands on
    // "tree" exactly as it did before toggle_job_queue needed "jobs"
    // focused to fire at all.
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "tree" }, at: 2 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "jobs-ok", request: { kind: "job.list", query_id: "jobs-ok", params: {} } }, at: 3 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "jobs-denied", request: { kind: "job.list", query_id: "jobs-denied", params: {} } }, at: 4 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "jobs-offline", request: { kind: "job.list", query_id: "jobs-offline", params: {} } }, at: 5 });
    // "view_telemetry" was a duplicate of the real `telemetry_requested`
    // AppEvent (DEF-02) -- deleted in favor of the mechanism tui.ts actually
    // dispatches on active-campaign change.
    await harness.dispatch({ type: "telemetry_requested", campaignId: "c1", at: 6 });
    await harness.dispatch({ type: "telemetry_requested", campaignId: "c1", at: 7 });

    expect(runtime.command).toHaveBeenCalledTimes(2);
    expect(runtime.query).toHaveBeenCalledTimes(3);
    // The headless harness deliberately falls back to the active slot until
    // the screen composition root is installed by its host.
    expect(harness.model.screens.get("tree")).toEqual({ jobs: [] });
    expect(harness.model.telemetrySnapshot?.campaign_id).toBe("c1");
    expect(harness.model.diagnostics.map((item) => item.fingerprint)).toEqual(expect.arrayContaining([
      "command:job.resume:capability-gate:permission", "query:job.list:permission", "query:job.list:transport", "telemetry:fetch-failed",
    ]));
    expect(harness.model.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "capability-gate", message: "Capability denied for job.resume: job.write denied" }),
    ]));
  });

  it("stores a background terminal campaign-tree refresh in the tree slot, not the focused screen", async () => {
    const client = { connect: vi.fn(), disconnect: vi.fn(), requestSnapshot: vi.fn(), close: vi.fn(), interruptCampaign: vi.fn() };
    const runtime = {
      command: vi.fn(),
      query: vi.fn().mockResolvedValue({ ok: true, value: { campaign_id: "campaign-1", halted: true, halt_reason: "no_nodes", nodes: [] }, capability: "campaign.read" }),
      activeOperationCount: () => 0,
    } as unknown as RuntimePort;
    const harness = new HeadlessHarness({ client, terminal: { restore: vi.fn() }, clock: { now: () => 42 }, telemetrySource: { fetch: async () => ({ campaign_id: "campaign-1", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) }, runtime });

    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "console" }, at: 0 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "terminal-tree", request: { kind: "campaign.tree", query_id: "terminal-tree", params: { campaign_id: "campaign-1" } }, screen: "tree" },
      at: 1,
    });

    expect(harness.model.screens.get("tree")).toEqual({ campaign_id: "campaign-1", halted: true, halt_reason: "no_nodes", nodes: [] });
    expect(harness.model.screens.has("console")).toBe(false);
  });

  it("distinguishes rejected operator decisions from harness faults returned by the command port", async () => {
    const client = { connect: vi.fn(), disconnect: vi.fn(), requestSnapshot: vi.fn(), close: vi.fn(), interruptCampaign: vi.fn() };
    const runtime = {
      command: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: { code: "conflict", summary: "stale queue state" }, capability: "job.write" })
        .mockResolvedValueOnce({ ok: false, error: { code: "unavailable", summary: "scheduler offline" }, capability: "job.write" }),
      query: vi.fn(), activeOperationCount: () => 0,
    } as unknown as RuntimePort;
    const harness = new HeadlessHarness({ client, terminal: { restore: vi.fn() }, clock: { now: () => 42 }, telemetrySource: { fetch: async () => ({ campaign_id: "c1", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) }, runtime });
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "jobs" }, at: 0 });
    await harness.dispatch({ type: "query_results", queryId: "jobs-1", screen: "jobs", value: { queue_paused: false } });
    await harness.dispatch({ type: "ui_intent", intent: { type: "toggle_job_queue" }, at: 1 });
    await harness.dispatch({ type: "query_results", queryId: "jobs-2", screen: "jobs", value: { queue_paused: true } });
    await harness.dispatch({ type: "ui_intent", intent: { type: "toggle_job_queue" }, at: 2 });
    expect(harness.model.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "operator-decision", message: "Operator action not applied for job.pause: stale queue state" }),
      expect.objectContaining({ source: "harness-fault", message: "Harness fault while running job.resume: scheduler offline" }),
    ]));
  });
});
