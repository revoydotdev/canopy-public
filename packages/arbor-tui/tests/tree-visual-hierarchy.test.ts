import { describe, expect, it } from "vitest";
import { treeScreen } from "../src/screens/tree.js";
import { stripAnsi } from "../src/player-piano.js";

describe("Tree visual hierarchy", () => {
  it("uses a concise summary and navigation hints beside a docked rail", () => {
    const projection = treeScreen.project({ campaign_id: "long-campaign-identity", nodes: [
      { id: "a", state: "claimed", action_description: "Plan" },
      { id: "b", state: "verified", action_description: "Result" },
    ] }, { width: 126, height: 30 });
    const lines = treeScreen.render({ projection, width: 126, height: 30 });
    expect(lines[0]).toBe("SEARCH · 1/2 verified · 0 expanding · 1 claimed");
    expect(lines[1]).toContain("up/down select");
    expect(lines[1]).toContain("Ctrl+P commands");
    expect(lines[2]).toContain("Plan");
    const active = treeScreen.project({ nodes: [{ id: "plan", state: "claimed" }, { id: "worker", state: "expanding" }] }, { width: 126, height: 30 });
    const activeHeader = treeScreen.render({ projection: active, width: 126, height: 30 })[0];
    expect(activeHeader).toContain("1 expanding");
    expect(activeHeader).toContain("1 claimed");
    expect(activeHeader).not.toContain("2 expanding");
  });
  it("prioritizes populated evidence while retaining absent field labels and values", () => {
    const projection = treeScreen.project({ nodes: [{
      id: "a", state: "claimed", action_description: "Inspect the selected task",
      provenance: { tag: "claimed", claimant: "planner" },
    }] }, { width: 120, height: 30 });
    const lines = treeScreen.render({ projection, width: 120, height: 30, selected_id: "a" });
    const text = lines.join("\n");
    expect(text.indexOf("Provenance: claimed by planner")).toBeLessThan(text.indexOf("Not recorded / not applicable"));
    expect(text).toContain("Gates: (none)");
    expect(text).toContain("Critic verdict: (not recorded)");
    expect(lines.length).toBeLessThan(19);
  });
  it("adds state color and selection weight without changing row text", () => {
    const projection = treeScreen.project({ nodes: [
      { id: "a", state: "claimed", action_description: "Unverified plan" },
      { id: "b", state: "verified", action_description: "Verified result" },
    ] }, { width: 90, height: 30 });
    const plain = treeScreen.render({ projection, width: 90, height: 30, selected_id: "a" });
    const color = treeScreen.render({ projection, width: 90, height: 30, selected_id: "a", color: true });
    expect(color.map((line) => stripAnsi(line).trimEnd())).toEqual(plain.map((line) => line.trimEnd()));
    expect(color[2]).toContain("\u001b[1m");
    expect(color[2]).not.toBe(color[3]);
    expect(plain.join("\n")).not.toContain("\u001b");
  });

  it("marks truncation even when only the final field overflows", () => {
    const projection = treeScreen.project({ nodes: [{ id: "a", state: "claimed" }] }, { width: 80, height: 20 });
    const row = projection.rows[0]!;
    const altered = { ...projection, rows: [{ ...row, _inspector: {
      ...(row._inspector as Record<string, unknown>), kb_entries_extracted: "long evidence ".repeat(100),
    } }] };
    const lines = treeScreen.render({ projection: altered, width: 80, height: 20, selected_id: "a" });
    expect(lines.at(-1)).toContain("more node-detail content");
  });
});
