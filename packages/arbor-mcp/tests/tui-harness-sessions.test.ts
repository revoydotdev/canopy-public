import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionInspection } from "@arbor/harness";
import { HeadlessHarness } from "@arbor/tui";
import { harnessSessionsScreen } from "@arbor/tui";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";

function harness(runtime: ArborRuntime): HeadlessHarness {
  const adapter = new RuntimePortAdapter(new RuntimeCatalogRouter(runtime));
  return new HeadlessHarness({
    client: { connect: () => {}, disconnect: () => {}, requestSnapshot: () => {}, close: () => {}, interruptCampaign: () => {} },
    terminal: { restore: () => {} },
    clock: { now: () => 1 },
    telemetrySource: { fetch: async () => ({ campaign_id: "c", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) },
    runtime: adapter as never,
  });
}

describe("Harness Sessions TUI controls", () => {
  it("uses the canonical adapter for list, inspect, bounded operator text, and session-scoped interrupt", async () => {
    const runtime = new ArborRuntime();
    const controller = new AbortController();
    const inspection: SessionInspection = {
      session_id: "hs-live", state: "running", latest_sequence: 2, terminal: null, ephemeral: true,
      policy: { filesystem: "read_only", approvals: "never", tool_allow: [], tool_deny: [], workspace_roots: ["/workspace"], max_wall_clock_ms: 10_000, max_events: 16, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false },
      capabilities: [], lineage: { kind: "new" },
    };
    const events: readonly SessionEvent[] = [
      { protocol_version: "1", session_id: "hs-live", sequence: 1, occurred_at: "2026-08-09T00:00:00.000Z", kind: "lifecycle", payload: { state: "started", lineage: { kind: "new" }, ephemeral: true, model_identity: { provider_id: "fixture", model_id: "native-model", configured_revision: "fp-configured", revision: "fp-observed" } } },
      { protocol_version: "1", session_id: "hs-live", sequence: 2, occurred_at: "2026-08-09T00:00:01.000Z", kind: "model_text", payload: { text: "operator-visible model output", phase: "final" } },
    ];
    runtime.nativeSessionRegistry.register({ session_id: "hs-live", campaign_id: "c", node_id: "n", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "documentation-writer", controller, inspect: () => inspection, events: () => events });
    const ui = harness(runtime);

    await ui.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "harness-sessions" }, at: 1 });
    await ui.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "sessions", request: { kind: "harness.session.list", query_id: "sessions", params: { limit: 20 } } }, at: 2 });
    expect(ui.model.screens.get("harness-sessions")).toMatchObject({ sessions: [{ session_id: "hs-live", profile_id: "documentation-writer", connector_id: "revoy-native", execution_kind: "direct_native" }] });
    expect(harnessSessionsScreen.project(ui.model.screens.get("harness-sessions"), { width: 100, height: 20 })).toMatchObject({
      rows: [expect.objectContaining({ execution: "direct_native", profile: "documentation-writer", recovery: "—", model: "fixture/native-model", revision: "observed fp-observed" })],
      row_ids: [expect.objectContaining({ context: { interruptible: "yes" } })],
    });
    expect(ui.model.selection.get("harness-sessions")?.id).toBe("hs-live");

    await ui.dispatch({ type: "ui_intent", intent: { type: "view_selected_row_detail" }, at: 3 });
    expect(ui.model.screens.get("harness-sessions")).toMatchObject({ session_id: "hs-live", state: "running" });
    expect(harnessSessionsScreen.project(ui.model.screens.get("harness-sessions"), { width: 100, height: 20 }).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "Execution", value: "direct_native" }),
      expect.objectContaining({ field: "Recovery", value: "not required" }),
      expect.objectContaining({ field: "Tool audit records", value: "0" }),
      expect.objectContaining({ field: "Provider/model", value: "fixture/native-model" }),
      expect.objectContaining({ field: "Model revision", value: "observed fp-observed" }),
    ]));
    await ui.dispatch({ type: "ui_intent", intent: { type: "view_selected_harness_session_events" }, at: 4 });
    const eventScreen = ui.model.screens.get("harness-sessions") as { session_id: string; events: readonly unknown[] };
    expect(eventScreen.session_id).toBe("hs-live");
    expect(eventScreen.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "model_text", payload: { text: "operator-visible model output", phase: "final" } })]));

    await ui.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "sessions-again", request: { kind: "harness.session.list", query_id: "sessions-again", params: { limit: 20 } } }, at: 41 });
    await ui.dispatch({ type: "ui_intent", intent: { type: "attach_selected_harness_session" }, at: 42 });
    expect(ui.model.screens.get("harness-sessions")).toMatchObject({ live: true, pending_steering: 0, next_after_sequence: 2 });
    const attachedProjection = harnessSessionsScreen.project(ui.model.screens.get("harness-sessions"), { width: 100, height: 20 });
    expect(attachedProjection.columns).toEqual([]);
    expect(attachedProjection.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ kind: "final_answer", summary: "operator-visible model output", source: "canonical_session", source_id: "hs-live", truth: "canonical" }) }),
    ]));
    await ui.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "harness.session.steer" }, at: 43 });
    await ui.dispatch({ type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at: 44 });
    await ui.dispatch({ type: "ui_intent", intent: { type: "operator_form_input", value: "Please summarize the current blocker." }, at: 45 });
    await ui.dispatch({ type: "ui_intent", intent: { type: "submit_operator_form" }, at: 46 });
    expect(runtime.nativeSessionRegistry.inspect("hs-live")?.pending_steering).toBe(1);

    await ui.dispatch({ type: "ui_intent", intent: { type: "cancel_selected_row" }, at: 5 });
    expect(ui.model.repeatConfirmation).toMatchObject({ action_key: "harness.session.interrupt:hs-live", fired: false });
    await ui.dispatch({ type: "ui_intent", intent: { type: "cancel_selected_row" }, at: 6 });
    expect(controller.signal.aborted).toBe(true);
  });

  it("does not arm an interrupt for a terminal session selected from its durable row identity", async () => {
    const ui = harness(new ArborRuntime());
    await ui.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "harness-sessions" }, at: 1 });
    await ui.dispatch({ type: "ui_intent", intent: { type: "select_row_identity", screen: "harness-sessions", selection: { id: "hs-terminal", context: { interruptible: "no" } } }, at: 2 });
    await ui.dispatch({ type: "ui_intent", intent: { type: "cancel_selected_row" }, at: 3 });
    expect(ui.model.overlay).toBeNull();
    expect(ui.model.notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", message: expect.stringContaining("terminal; inspect its durable evidence") }),
    ]));
    await ui.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "harness.session.steer" }, at: 4 });
    expect(ui.model.overlay).toBeNull();
  });
});
