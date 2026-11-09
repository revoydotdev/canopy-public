import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DifficultyCalibrator } from "../../src/routing/difficulty.js";
import { DifficultyRoutingPolicy } from "../../src/routing/routing-policy.js";
import { ArborRuntime } from "../../src/runtime.js";
import { createProductionCampaignLoopConfig } from "../../src/cli.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const easy = { description: "rename one variable", category: "seed-quick", constraints: [], estimated_gain: 8, estimated_cost: 1 };
const hard = { description: "redesign a complex cross cutting architecture across many subsystems with migrations and compatibility", category: "crown-structural", constraints: ["compatibility", "migration", "security", "performance", "rollback", "audit"], estimated_gain: 4, estimated_cost: 20, decomposition_depth: 2 };

describe("difficulty and capability routing", () => {
  it("routes a hard task deeper and to a stronger model tier than an easy task", () => {
    const policy = new DifficultyRoutingPolicy(new DifficultyCalibrator());
    const low = policy.route(easy); const high = policy.route(hard);
    expect(high.difficulty).toBeGreaterThan(low.difficulty);
    expect(high.expansion_depth).toBeGreaterThan(low.expansion_depth);
    expect(low.model_tier).toBe("economical"); expect(high.model_tier).toBe("capable");
  });

  it("raises and durably reloads difficulty after observed failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-routing-")); dirs.push(dir);
    const calibrator = new DifficultyCalibrator(dir); const before = calibrator.estimate(easy);
    for (let index = 0; index < 12; index += 1) calibrator.record(easy.category, false);
    expect(new DifficultyCalibrator(dir).estimate(easy)).toBeGreaterThan(before);
  });

  it("wires both NodeCard capability selection and difficulty policy in the production config", () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("routing-production", "plan.md", { description: "complex architecture migration", estimated_gain: 5, estimated_cost: 8, category: "architecture", delegate_to: "heartwood" });
    const config = createProductionCampaignLoopConfig(runtime, "routing-production", async () => ({ critic: "lenticel", approved: true, rationale: "ok", root_cause: "none", measurement_validated: true }));
    expect(config.task_skills).toContain("crown-structural");
    expect(config.node_routing?.route(hard)).toMatchObject({ model_tier: "capable" });
  });
});
