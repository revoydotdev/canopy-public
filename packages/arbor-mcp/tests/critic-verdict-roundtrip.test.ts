import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, CapabilityContext, CriticVerdict, ScoreContext } from "@arbor/core";
import { treeScreen } from "@arbor/tui";
import { DEFAULT_LOOP_CONFIG, runCampaign, type LoopExecutor } from "@arbor/opencode";
import { CampaignManager } from "../src/manager.js";

const action: Action = { description: "persist full critic evidence", estimated_gain: 1, estimated_cost: 1, category: "testing", delegate_to: "seed" };
const score: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 1, total_visits: 1 };
const specialistCap: CapabilityContext = { tier: "specialist" };
const criticCap: CapabilityContext = { tier: "critic" };

function verdict(approved: boolean): CriticVerdict {
  return {
    approved, critic: "lenticel", rationale: approved ? "all five mandates passed" : "introspection found a contradiction",
    ...(approved ? {} : { root_cause: "specialist rationale conflicts with evidence" }),
    measurement_validated: true, guardrails_enforced: true, introspection_passed: approved, stability_ok: true,
    checks: [
      { name: "root_cause", passed: true, detail: "cause is explicit" },
      { name: "measurement_validation", passed: true, detail: "measurements are isolated" },
      { name: "guardrail_enforcement", passed: true, detail: "scope is respected" },
      { name: "introspection", passed: approved, detail: approved ? "reasoning is consistent" : "claim contradicts output" },
      { name: "stability_monitoring", passed: true, detail: "no oscillation" },
    ],
  };
}

describe("five-mandate critic verdict round trip", () => {
  it("carries a real loop verdict through the tree, durable restart, snapshot, and TUI inspector", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-critic-verdict-"));
    try {
      const manager = new CampaignManager({ persistence_dir: dir });
      expect(manager.startCampaign("critic-roundtrip", "plan.md", action).ok).toBe(true);
      manager.branch("critic-roundtrip", "root", [action]);
      const fullVerdict = verdict(true);
      const executor: LoopExecutor = {
        async specialize() {
          return { output: "implemented and verified", provenance: { tag: "verified", cmd: "bun run test", exit: 0, stdout_hash: "sha256:critic-roundtrip" }, token_usage: { kind: "unavailable", reason: "fixture" } };
        },
        async review() {
          return { approved: true, rationale: fullVerdict.rationale, critic_agent: "lenticel", measurement_validated: true, verdict: fullVerdict, token_usage: { kind: "unavailable", reason: "fixture" } };
        },
      };
      await runCampaign({
        manager,
        campaign_id: "critic-roundtrip",
        executor,
        config: { ...DEFAULT_LOOP_CONFIG, max_iterations: 1, use_worktrees: false, specialist_cap: specialistCap, critic_cap: criticCap, score_ctx: () => score, branch_actions: () => null },
      });

      const first = manager.getCampaignSnapshot("critic-roundtrip")!;
      expect(first.nodes.find((node) => node.parent_id === "root")?.critic_verdict).toEqual(fullVerdict);

      const restored = new CampaignManager({ persistence_dir: dir });
      const snapshot = restored.getCampaignSnapshot("critic-roundtrip")!;
      expect(restored.getPersistenceDiagnostics()).toEqual([]);
      expect(snapshot.nodes.find((node) => node.parent_id === "root")?.critic_verdict).toEqual(fullVerdict);
      const projection = treeScreen.project(snapshot, { width: 240, height: 40 });
      const inspector = projection.rows.find((row) => row.id !== "root")!._inspector as Record<string, string>;
      expect(inspector.critic).toContain("root_cause=true");
      expect(inspector.critic).toContain("introspection=true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a claimed five-mandate verdict from the same agent that did the specialist work", () => {
    const manager = new CampaignManager();
    expect(manager.startCampaign("self-approval", "plan.md", action).ok).toBe(true);
    const [nodeId] = manager.branch("self-approval", "root", [action]);
    expect(manager.expandNode("self-approval", nodeId!, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true }).ok).toBe(true);
    const fullVerdict = { ...verdict(true), critic: "seed" };
    expect(() => manager.recordResult("self-approval", nodeId!, {
      specialist_output: "work", specialist_agent: "seed", provenance: { tag: "claimed", claimant: "seed" },
      critic_agent: "seed", critic_approved: true, critic_rationale: fullVerdict.rationale, critic_verdict: fullVerdict, score_ctx: score,
    })).toThrow(/self-approval|distinct critic/i);
  });

  it("retains a genuine rejected verdict instead of replacing it with failure text", () => {
    const manager = new CampaignManager();
    expect(manager.startCampaign("rejected-verdict", "plan.md", action).ok).toBe(true);
    const [nodeId] = manager.branch("rejected-verdict", "root", [action]);
    expect(manager.expandNode("rejected-verdict", nodeId!, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true }).ok).toBe(true);
    const fullVerdict = verdict(false);
    manager.recordResult("rejected-verdict", nodeId!, {
      specialist_output: "work with a contradiction", specialist_agent: "seed", provenance: { tag: "claimed", claimant: "seed" },
      critic_agent: "lenticel", critic_approved: false, critic_rationale: fullVerdict.rationale,
      critic_root_cause: fullVerdict.root_cause, critic_verdict: fullVerdict, score_ctx: score,
    });
    const node = manager.getCampaignSnapshot("rejected-verdict")!.nodes.find((item) => item.id === nodeId)!;
    expect(node.state).toBe("failed");
    expect(node.critic_verdict).toEqual(fullVerdict);
  });
});
