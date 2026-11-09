import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const implementation: Action = { description: "implement interaction", estimated_gain: 2, estimated_cost: 1, category: "implementation", delegate_to: "seed" };
const verification: Action = { description: "verify interaction", estimated_gain: 1, estimated_cost: 1, category: "verification", delegate_to: "seed", depends_on: ["implement interaction"] };

describe("campaign acceptance mapping admission", () => {
  it("materializes explicit criteria on durable actions and preserves them across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-acceptance-map-"));
    try {
      const first = new CampaignManager({ persistence_dir: dir });
      const admitted = first.admitCampaignPlan({
        id: "acceptance-map", plan_path: "plan.json", root_action: root, actions: [implementation, verification],
        acceptance_checks: ["keyboard path works", "visual state is observable"],
        acceptance_mapping: [
          { criterion: "keyboard path works", action_descriptions: ["implement interaction", "verify interaction"] },
          { criterion: "visual state is observable", action_descriptions: ["verify interaction"] },
        ],
      });
      expect(admitted).toMatchObject({ ok: true });
      if (!admitted.ok) throw new Error(`acceptance-map admission failed: ${admitted.gate.detail}`);
      const childId = admitted.child_ids[0];
      if (childId === undefined) throw new Error("acceptance-map admission created no executable child");
      expect(first.getNodeInfo("acceptance-map", childId)?.action.acceptance_checks).toEqual(["keyboard path works"]);

      const restarted = new CampaignManager({ persistence_dir: dir });
      expect(restarted.getNodeInfo("acceptance-map", childId)?.action.acceptance_checks).toEqual(["keyboard path works"]);
      // The dependency remains deferred until its prerequisite is actually
      // verified; its criteria are stored in the same campaign snapshot.
      const durable = JSON.parse(readFileSync(join(dir, "tree", "acceptance-map.json"), "utf8")) as { deferred_actions: Array<{ action: Action }> };
      expect(durable.deferred_actions[0]?.action.acceptance_checks).toEqual(["keyboard path works", "visual state is observable"]);

      expect(restarted.expandNode("acceptance-map", childId, {
        worktree_isolated: true, starting_commit_correct: true, lease_acquired: true,
      }).ok).toBe(true);
      restarted.recordResult("acceptance-map", childId, {
        specialist_output: "implemented", specialist_agent: "seed",
        provenance: { tag: "verified", cmd: "bounded-check", exit: 0, stdout_hash: `sha256:${"a".repeat(64)}` },
        critic_agent: "lenticel", critic_approved: true, critic_rationale: "independent review approved",
        score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 1, total_visits: 1 },
      });
      const activated = JSON.parse(readFileSync(join(dir, "tree", "acceptance-map.json"), "utf8")) as { nodes: Array<{ action: Action }> };
      expect(activated.nodes.find((node) => node.action.description === "verify interaction")?.action.acceptance_checks).toEqual(["keyboard path works", "visual state is observable"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails closed before tree creation when stated criteria have no explicit map", () => {
    const manager = new CampaignManager();
    expect(() => manager.admitCampaignPlan({
      id: "unmapped", plan_path: "plan.json", root_action: root, actions: [implementation], acceptance_checks: ["must work"],
    })).toThrow(/explicit acceptance_mapping/);
    expect(manager.getCampaignSnapshot("unmapped")).toBeNull();
  });

  it("rejects oversized direct mappings and quarantines oversized persisted action criteria", () => {
    const manager = new CampaignManager();
    const oversized = "x".repeat(4_097);
    expect(() => manager.admitCampaignPlan({
      id: "oversized", plan_path: "plan.json", root_action: root, actions: [implementation], acceptance_checks: [oversized],
      acceptance_mapping: [{ criterion: oversized, action_descriptions: ["implement interaction"] }],
    })).toThrow(/4096/);
    expect(manager.getCampaignSnapshot("oversized")).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), "arbor-acceptance-persist-"));
    try {
      new CampaignManager({ persistence_dir: dir }).startCampaign("persisted-overflow", "plan.json", root);
      const path = join(dir, "tree", "persisted-overflow.json");
      const snapshot = JSON.parse(readFileSync(path, "utf8")) as { nodes: Array<{ action: { acceptance_checks?: string[] } }> };
      snapshot.nodes[0]!.action.acceptance_checks = Array.from({ length: 33 }, (_, index) => `check-${index}`);
      writeFileSync(path, JSON.stringify(snapshot));
      const restarted = new CampaignManager({ persistence_dir: dir });
      expect(restarted.getCampaignSnapshot("persisted-overflow")).toBeNull();
      expect(restarted.getPersistenceDiagnostics()).toContainEqual(expect.objectContaining({ code: "invalid_shape" }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
