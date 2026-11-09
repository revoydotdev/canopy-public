import { describe, expect, it } from "vitest";
import { initialModel } from "../src/model.js";
import { renderStatusBar } from "../src/status-bar.js";
import { stripAnsi } from "../src/player-piano.js";
import { displayWidth } from "../src/widgets.js";

describe("operator status header", () => {
  const model = { ...initialModel(), screen: "tree" as const, telemetryCampaignId: "operator-campaign",
    screens: new Map([["tree" as const, {campaign_id: "operator-campaign", nodes: [{id: "root", state: "claimed"}]}]]) };
  it("prioritizes activity and meaningful context without empty diagnostic zones", () => {
    const row = renderStatusBar(model, {columns: 120, presentation: "operator"});
    expect(row).toContain("Idle");
    expect(row).toContain("operator-campaign");
    expect(row).toContain("0/1 verified");
    expect(row).toContain("Ctrl+P commands");
    expect(row).not.toContain("active —");
    expect(row).not.toContain("phase —");
    expect(row).not.toContain("events —");
  });
  it("keeps colored and plain geometry identical at constrained widths", () => {
    for (const columns of [1, 20, 40, 80, 120]) {
      const plain = renderStatusBar(model, {columns, presentation: "operator"});
      const colored = renderStatusBar(model, {columns, presentation: "operator", color: true});
      expect(displayWidth(plain)).toBe(columns);
      expect(stripAnsi(colored)).toBe(plain);
      expect(plain.trimEnd()).not.toMatch(/\|$/);
    }
  });
});
