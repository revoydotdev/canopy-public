import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessHarness, nativeBudgetScreen } from "@arbor/tui";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";

function harness(runtime: ArborRuntime): HeadlessHarness {
  return new HeadlessHarness({
    client: { connect: () => {}, disconnect: () => {}, requestSnapshot: () => {}, close: () => {}, interruptCampaign: () => {} },
    terminal: { restore: () => {} }, clock: { now: () => 1 },
    telemetrySource: { fetch: async () => ({ campaign_id: "campaign", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) },
    runtime: new RuntimePortAdapter(new RuntimeCatalogRouter(runtime)) as never,
  });
}

describe("Native Budget TUI screen", () => {
  it("renders the canonical durable allocation snapshot and its unconfigured state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-budget-tui-"));
    try {
      const runtime = new ArborRuntime({ persistence_dir: directory });
      const ui = harness(runtime);
      await ui.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "native-budget" }, at: 1 });
      await ui.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "none", request: { kind: "native.budget.get", query_id: "none", params: { campaign_id: "campaign" } } }, at: 2 });
      expect(nativeBudgetScreen.project(ui.model.screens.get("native-budget"), { width: 100, height: 20 }).caption).toContain("not configured");

      runtime.nativeCampaignBudget.initialize("campaign", { max_tokens: 100, provenance: { tag: "claimed", claimant: "budget-policy" } });
      await ui.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "configured", request: { kind: "native.budget.get", query_id: "configured", params: { campaign_id: "campaign" } } }, at: 3 });
      expect(nativeBudgetScreen.project(ui.model.screens.get("native-budget"), { width: 100, height: 20 })).toMatchObject({
        caption: expect.stringContaining("durable revision 0"),
        rows: expect.arrayContaining([{ field: "Tokens remaining", value: "100" }, { field: "Cost remaining", value: expect.stringContaining("unpriced") }]),
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
