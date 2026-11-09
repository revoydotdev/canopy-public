/** Deterministic, fixture-backed baseline vs governed-loop evaluation. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateGovernedScenarios } from "../src/governed-scenarios.js";
import type { GovernedEvalScenario } from "../src/types.js";

const fixturePath = fileURLToPath(new URL("../fixtures/governed-loop-scenarios.json", import.meta.url));
const scenarios = JSON.parse(readFileSync(fixturePath, "utf8")) as GovernedEvalScenario[];

describe("governed deterministic evaluation scenarios", () => {
  it("compares completion, regression, recovery, evidence, and honest cost availability", () => {
    const results = evaluateGovernedScenarios(scenarios);
    expect(results.map((result) => result.scenario_id)).toEqual(scenarios.map((scenario) => scenario.id));

    const recovery = results[0];
    expect(recovery.baseline.completed).toBe(false);
    expect(recovery.governed.completed).toBe(true);
    expect(recovery.governed.recoveries_required).toBe(1);
    expect(recovery.governed.recoveries_completed).toBe(1);
    expect(recovery.governed.evidence.completeness).toBe(1);
    expect(recovery.baseline.evidence.completeness).toBe(0);

    const regression = results[1];
    expect(regression.baseline.regressions_accepted).toBe(1);
    expect(regression.governed.regressions_detected).toBe(1);
    expect(regression.governed.regressions_accepted).toBe(0);
    expect(regression.governed.completed).toBe(true);

    for (const result of results) {
      expect(result.governed.cost.provider_cost_usd).toBeNull();
      expect(result.governed.cost.provider_cost_status).toBe("not_measured");
      expect(result.governed.cost.scripted_token_units).toBeGreaterThan(0);
    }
  });

  it("is repeatable with no provider or clock input", () => {
    expect(evaluateGovernedScenarios(scenarios)).toEqual(evaluateGovernedScenarios(scenarios));
  });
});
