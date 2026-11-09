import { describe, expect, it } from "vitest";
import { deriveStatusBarZones, initialModel, nativeBudgetScreen, nativeBudgetWarning, type ScreenId } from "../src/index.js";

const budget = (consumed: number, reserved = 0) => ({ availability: "configured", campaign_id: "c", revision: 1, configured: { max_tokens: 100 }, consumed_tokens: consumed, reserved_tokens: reserved, remaining_tokens: 100 - consumed - reserved, consumed_cost: { kind: "unpriced", reason: "n/a" }, reserved_cost: { kind: "unpriced", reason: "n/a" }, remaining_cost: { kind: "unpriced", reason: "n/a" }, reservations: [] });

describe("thresholded native budget surfacing", () => {
  it("is silent below the warning threshold", () => {
    expect(nativeBudgetWarning(budget(50))).toBeNull();
    expect(nativeBudgetScreen.project(budget(50), { width: 120, height: 20 }).rows.some((row) => row.field === "Budget warning")).toBe(false);
  });
  it("reports headroom and remedy at warning/error thresholds with reserve below hard limit", () => {
    expect(nativeBudgetWarning(budget(60))).toMatchObject({ severity: "warning", remaining_percent: 33, effective_ceiling_tokens: 90, remediation_reserve_tokens: 10, message: expect.stringContaining("compact or start a fresh context window") });
    expect(nativeBudgetWarning(budget(80))).toMatchObject({ severity: "error", remaining_percent: 11 });
  });
  it("puts only an active warning in the status bar", () => {
    const quiet = { ...initialModel(), screens: new Map<ScreenId, unknown>([["native-budget", budget(50)]]) };
    expect(deriveStatusBarZones(quiet, 0).budget).toBe("—");
    const warning = { ...quiet, screens: new Map<ScreenId, unknown>([["native-budget", budget(60)]]) };
    expect(deriveStatusBarZones(warning, 0).budget).toContain("33% remaining");
  });
});
