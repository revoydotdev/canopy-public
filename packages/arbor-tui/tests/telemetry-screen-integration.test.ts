import { describe, expect, it } from "vitest";
import { HeadlessHarness } from "../src/headless.js";
import { createNavigation } from "../src/navigation.js";
import { installScreens } from "../src/screens/install.js";
import { clearRegisteredScreens } from "../src/screens/screen.js";
import { renderTerminalFrame } from "./support/render-harness.js";
import type { RuntimePort } from "../src/runtime-port.js";

const inertRuntime: RuntimePort = {
  command: async () => ({ ok: false, error: { code: "unavailable", summary: "test runtime is inactive" }, capability: null }),
  query: async () => ({ ok: false, error: { code: "unavailable", summary: "test runtime is inactive" }, capability: null }),
  activeOperationCount: () => 0,
};

describe("ledger-derived Telemetry screen integration", () => {
  it("carries the injected ledger projection through the headless effect path into the active renderer slot", async () => {
    installScreens();
    try {
      const harness = new HeadlessHarness({
        client: { connect() {}, disconnect() {}, requestSnapshot() {}, close() {}, interruptCampaign() {} },
        terminal: { restore() {} },
        clock: { now: () => 42 },
        telemetrySource: { fetch: async () => ({ campaign_id: "campaign-telemetry", source_record_count: 3, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) },
        runtime: inertRuntime,
      });
      await harness.dispatch({ type: "grants_updated", capabilities: ["telemetry.read"] });
      await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "telemetry" }, at: 1 });
      // "view_telemetry" was a duplicate of the real `telemetry_requested`
      // AppEvent (DEF-02) -- deleted in favor of the mechanism tui.ts
      // actually dispatches on active-campaign change.
      await harness.dispatch({ type: "telemetry_requested", campaignId: "campaign-telemetry", at: 2 });

      expect(harness.model.screens.get("telemetry")).toMatchObject({ campaign_id: "campaign-telemetry", source_record_count: 3 });
      const frame = renderTerminalFrame({
        app: harness.model,
        output: "generic fallback",
        navigation: createNavigation({ id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "screen", title: "Screen" }] }, { columns: 100, rows: 20 }),
      });
      expect(frame).toContain("Telemetry: campaign=campaign-telemetry  records=3");
      expect(frame).not.toContain("generic fallback");
    } finally {
      clearRegisteredScreens();
    }
  });
});
