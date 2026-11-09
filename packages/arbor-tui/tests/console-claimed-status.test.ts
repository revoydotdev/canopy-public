import { describe, expect, it } from "vitest";
import { consoleScreen } from "../src/screens/console.js";
import { initialModel } from "../src/model.js";
import { deriveConsoleActivityNarrative } from "../src/status-bar.js";

describe("Console claim versus worker activity", () => {
  it("does not describe an idle claimed plan as delegation in progress", () => {
    const raw = {
      captured_at: "2026-09-05T12:00:00Z",
      campaigns: {items: [{id: "c", plan_path: "plan.md", active_node_state: "claimed", verified_nodes: 0, total_nodes: 2, halted: false}]},
      tree: {campaign_id: "c", nodes: [{id: "root", state: "claimed"}, {id: "child", parent_id: "root", state: "pruned"}]},
    };
    const projection = consoleScreen.project(raw, {width: 140, height: 30});
    expect(projection.rows.find((row) => row.region === "header")?.status).toBe("Claimed, not verified");
    expect(consoleScreen.render({projection, width: 140, height: 30}).join("\n")).not.toContain("Delegating");
    const narrative = deriveConsoleActivityNarrative({...initialModel(), telemetryCampaignId: "c", screens: new Map([["console", raw]])});
    expect(narrative.active).toBe(false);
    expect(narrative.text).toContain("Idle");
  });
  it("still labels an actual expanding node as working", () => {
    const projection = consoleScreen.project({captured_at: "2026-09-05T12:00:00Z", campaigns: {items: [{id: "c", active_node_state: "expanding", halted: false}]}}, {width: 140, height: 30});
    expect(projection.rows.find((row) => row.region === "header")?.status).toBe("Working");
  });
});
