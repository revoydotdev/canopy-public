import { describe, expect, it } from "vitest";
import { buildDefaultCatalog } from "../src/default-catalog.js";
import { InputRouter, catalogConflicts } from "../src/input-catalog.js";
import { nativeBudgetScreen } from "../src/screens/native-budget.js";

describe("native budget discovery", () => {
  it("uses Alt+B without advertising the Console sidebar shortcut", () => {
    const catalog = buildDefaultCatalog();
    expect(catalogConflicts(catalog)).toEqual([]);
    const action = catalog.actions.find((entry) => entry.id === "focus:native-budget")!;
    expect(action.bindings.flatMap((binding) => binding.keys)).toEqual(["alt+b"]);
    expect(new InputRouter(catalog, () => 0).handle({ key: "b", modifiers: ["alt"] }, ["global"]))
      .toEqual({ kind: "action", action_id: "focus:native-budget" });
  });

  it.each([null, { availability: "unconfigured", campaign_id: "campaign" }])("offers a next step without inventing allocation for %j", (value) => {
    const context = { width: 80, height: 24 };
    const projection = nativeBudgetScreen.project(value, context);
    const lines = nativeBudgetScreen.render({ projection, ...context });
    expect(lines.join("\n")).toContain("NEXT STEPS");
    expect(lines.join("\n")).toContain("not evidence of unlimited capacity");
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
  });

  it("does not mislabel an unknown response as no selected campaign", () => {
    const projection = nativeBudgetScreen.project({ invalid: true }, { width: 80, height: 24 });
    expect(projection.caption).toContain("not recognized");
  });
});
