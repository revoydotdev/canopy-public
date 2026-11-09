import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCampaign, WorktreeManager, type CampaignLoopConfig, type LoopExecutor } from "@arbor/opencode";
import { CampaignManager } from "../src/manager.js";
import { adoptCapturedResult, bestVerifiedResult, captureWorktreeResult } from "../src/result-adoption.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-task-finalization-"));
  temporary.push(root);
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  writeFileSync(join(root, "seed.txt"), "seed\n", "utf8");
  git("add", "-A");
  git("commit", "-qm", "base");
  return root;
}

describe("verified task finalization", () => {
  it("captures the direct task as verified before lease release and makes it adoptable", async () => {
    const root = repository();
    const persistence = mkdtempSync(join(tmpdir(), "arbor-task-result-"));
    temporary.push(persistence);
    const manager = new CampaignManager();
    manager.startCampaign("task", "plan.md", { description: "write one doc", estimated_gain: 1, estimated_cost: 1, category: "documentation", delegate_to: "seed", decomposition_depth: 0 });
    const [nodeId] = manager.branch("task", "root", [{ description: "write one doc", estimated_gain: 1, estimated_cost: 1, category: "documentation", delegate_to: "seed", decomposition_depth: 0 }]);
    const executor: LoopExecutor = {
      async specialize({ worktree_path }) {
        mkdirSync(join(worktree_path, "docs"), { recursive: true });
        writeFileSync(join(worktree_path, "docs", "result.md"), "# verified result\n", "utf8");
        return { output: "verified", provenance: { tag: "verified", cmd: "declared-outputs-check", exit: 0, stdout_hash: "sha256:test" }, token_usage: { kind: "unavailable", reason: "fixture" } };
      },
      async review() {
        return { approved: true, rationale: "independent approval", critic_agent: "lenticel", measurement_validated: true, token_usage: { kind: "unavailable", reason: "fixture" } };
      },
    };
    const config: CampaignLoopConfig = {
      max_iterations: 10,
      specialist_base_prompt: "specialist",
      critic_base_prompt: "critic",
      specialist_cap: { tier: "specialist" },
      critic_cap: { tier: "critic" },
      score_ctx: () => ({ accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 1, total_visits: 1 }),
      use_worktrees: true,
      branch_actions: () => null,
      execution_strategy: { kind: "direct_single_action", node_id: nodeId! },
      result_capture: { capture: (input) => { captureWorktreeResult({ ...input, persistence_dir: persistence, now: () => "2026-08-12T00:00:00.000Z" }); } },
    };

    const report = await runCampaign({ manager, campaign_id: "task", executor, config, worktrees: new WorktreeManager({ repoRoot: root }) });
    expect(report).toMatchObject({ halted: true, halt_reason: "verified_result", verified: 1 });
    expect(bestVerifiedResult(persistence, "task")).toMatchObject({ node_id: nodeId, verified: true });
    expect(existsSync(join(root, "docs", "result.md"))).toBe(false);
    expect(adoptCapturedResult({ campaign_id: "task", node_id: nodeId!, persistence_dir: persistence, target_root: root })).toMatchObject({ ok: true, applied: true });
    expect(readFileSync(join(root, "docs", "result.md"), "utf8")).toBe("# verified result\n");
  });
});
