import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignManager } from "../../src/manager.js";
import { ArborRuntime, type CampaignRunner } from "../../src/runtime.js";
import { adoptCapturedResult, captureWorktreeResult } from "../../src/result-adoption.js";

const CONTENT = "edited, verified, and adopted\n";
const proposal = JSON.stringify({
  summary: "write and verify the requested file", assumptions: [], questions: [],
  root_action: { description: "deliver requested edit", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" },
  actions: [{ description: "write delivered.txt and verify it", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }],
  acceptance_checks: ["delivered.txt contains the verified bytes"],
  acceptance_mapping: [{ criterion: "delivered.txt contains the verified bytes", action_descriptions: ["write delivered.txt and verify it"] }],
  risk_notes: [],
});

export interface TaskIntakeFilesystemFixture {
  readonly root: string;
  readonly persistence: string;
  readonly targetFile: string;
  readonly expectedContent: string;
  readonly runtime: ArborRuntime;
}

/**
 * A deterministic production-runtime fixture, not a surface mock. The only
 * substituted capabilities are the model planner and campaign worker. The
 * worker drives the real manager gates, Git diff capture, integrity checks,
 * and adoption boundary used by production.
 */
export function createTaskIntakeFilesystemFixture(): TaskIntakeFilesystemFixture {
  const root = mkdtempSync(join(tmpdir(), "arbor-intake-e2e-"));
  const persistence = join(root, ".arbor");
  mkdirSync(persistence, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@revoy.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Revoy Fixture"], { cwd: root });
  writeFileSync(join(root, "seed.txt"), "seed\n", "utf8");
  execFileSync("git", ["add", "seed.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture base"], { cwd: root });

  const manager = new CampaignManager();
  const runner: CampaignRunner = {
    async run(campaignId, signal) {
      if (signal.aborted) return { halted: false, halt_reason: null, cancelled: true, awaiting_user_input: false };
      const snapshot = manager.getCampaignSnapshot(campaignId);
      if (!snapshot) throw new Error(`missing admitted campaign ${campaignId}`);
      const node = snapshot.nodes.find((candidate) => candidate.parent_id === snapshot.root_id);
      if (!node) throw new Error("admitted campaign has no executable child");
      const worktree = join(root, `.fixture-worktree-${campaignId}`);
      execFileSync("git", ["clone", "-q", root, worktree]);
      writeFileSync(join(worktree, "delivered.txt"), CONTENT, "utf8");
      const expanded = manager.expandNode(campaignId, node.id, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
      if (!expanded.ok) throw new Error("fixture isolation gate failed");
      manager.recordResult(campaignId, node.id, {
        specialist_output: "wrote and machine-verified delivered.txt", specialist_agent: "seed",
        provenance: { tag: "verified", cmd: "test -f delivered.txt", exit: 0, stdout_hash: "sha256:fixture-verified" },
        critic_agent: "lenticel", critic_approved: true, critic_rationale: "independent byte verification passed",
        score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 1, total_visits: 1 },
      });
      manager.completeAutoHalt(campaignId, "no_nodes");
      const capture = captureWorktreeResult({ campaign_id: campaignId, node_id: node.id, worktree_path: worktree, verified: true, score: 1, persistence_dir: persistence });
      if (!capture) throw new Error("verified edit produced no captured patch");
      const adopted = adoptCapturedResult({ campaign_id: campaignId, node_id: node.id, persistence_dir: persistence, target_root: root, expected_patch_sha256: capture.patch_sha256 });
      if (!adopted.ok) throw new Error(`adoption failed: ${adopted.reason}`);
      return { halted: true, halt_reason: "no_nodes", cancelled: false, awaiting_user_input: false };
    },
  };
  const runtime = new ArborRuntime({
    manager, persistence_dir: persistence, campaign_runner: runner,
    task_composer_planner: { plan: async () => ({ raw_proposal: proposal, session_id: "fixture-planner", model_identity: "deterministic-fixture", usage: { kind: "unavailable", reason: "deterministic acceptance fixture" } }) },
  });
  return { root, persistence, targetFile: join(root, "delivered.txt"), expectedContent: CONTENT, runtime };
}
