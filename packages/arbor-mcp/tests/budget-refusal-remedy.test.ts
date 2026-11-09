import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import type { CapabilitySupport, NativeModelPort, NativeTokenEstimateAuthority } from "@arbor/harness";
import { main, resolvePersistenceDir } from "../src/cli.js";
import { NativeAgentExecutor } from "../src/native-agent-executor.js";
import { NativeCampaignBudgetAuthority } from "../src/native-campaign-budget.js";
import { ArborRuntime } from "../src/runtime.js";

/**
 * A budget refusal carries the canonical v2 typed remedy from the refusing
 * site (the native executor's campaign reservation) through the node outcome
 * and its persistence to the operator surface that reads it (`arbor report`).
 * The operator is the correcting actor: no retry by the specialist can raise
 * a configured ceiling.
 */

const capabilities: readonly CapabilitySupport[] = ["streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting"].map((capability) => ({
  capability, grade: "native",
  evidence: { implementation_id: "budget-refusal-remedy", observed_at: "2026-10-06T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

const estimator: NativeTokenEstimateAuthority = {
  estimate(request) {
    const input = Buffer.byteLength(request.prompt, "utf8");
    return { kind: "estimated", input_tokens: input, output_tokens: 5, cache_read_tokens: input, cache_write_tokens: input, authority: "fixture-upper-bound" };
  },
};

const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

describe("budget refusal remedy", () => {
  it("projects a campaign-budget refusal to the operator, through the node outcome, persistence, and the arbor report CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-budget-remedy-"));
    try {
      let modelCalls = 0;
      const model: NativeModelPort = { async run() { modelCalls += 1; return { text: [], tool_calls: [], final_message: "should not run" }; } };
      const executor = new NativeAgentExecutor({
        workspace_root: "/workspace", capabilities, model_for_role: () => model,
        campaign_budget: { authority: new NativeCampaignBudgetAuthority(join(root, "budget")), config: { max_tokens: 1, provenance: { tag: "generated", generator: "fixture", input_hash: "fixture" } }, max_input_tokens: 100, max_output_tokens: 5, token_estimator: estimator },
      });

      const result = await executor.specialize({ campaign_id: "budget-camp", node_id: "n", action: {}, prompt: "do work", worktree_path: "", specialist_agent: "seed" });

      expect(modelCalls).toBe(0);
      expect(result.error).toMatchObject({
        kind: "internal_error", recoverable: false,
        remedy: { schema_version: 2, kind: "gate.refusal", state: "refused", gate: "budget", code: "campaign_budget", correcting_actor: "operator", corrective_action: "raise_budget", remediation: expect.stringContaining("max_campaign_tokens") },
      });

      // Record the executor's real NodeError the way the campaign loop does,
      // reload it from disk, and read it back through the operator CLI.
      const persistence_dir = resolvePersistenceDir(root);
      const runtime = new ArborRuntime({ persistence_dir });
      runtime.manager.startCampaign("budget-camp", "plan.md", rootAction);
      const [childId] = runtime.manager.branch("budget-camp", "root", [{ ...rootAction, description: "child", delegate_to: "seed" }]);
      if (!childId) throw new Error("child setup failed");
      runtime.manager.recordResult("budget-camp", childId, {
        specialist_output: result.output, specialist_agent: "seed", provenance: { tag: "claimed", claimant: "seed" },
        critic_agent: "lenticel", critic_approved: false, critic_rationale: "budget refused the session",
        score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0, total_visits: 1 },
        node_error: result.error!,
      });
      await runtime.close();

      const ttyOut = new PassThrough() as PassThrough & { isTTY?: boolean };
      ttyOut.isTTY = true;
      let human = "";
      ttyOut.on("data", (chunk: Buffer) => { human += chunk.toString(); });
      await main(["report", "--campaign", "budget-camp"], { cwd: root, persistence_dir: undefined, stdin: new PassThrough(), stdout: ttyOut, stderr: new PassThrough(), runtime_factory: undefined });
      expect(human).toContain(`Node ${childId} budget refused: correcting actor operator; corrective action raise_budget.`);

      const jsonOut = new PassThrough();
      let json = "";
      jsonOut.on("data", (chunk: Buffer) => { json += chunk.toString(); });
      await main(["report", "--campaign", "budget-camp", "--json"], { cwd: root, persistence_dir: undefined, stdin: new PassThrough(), stdout: jsonOut, stderr: new PassThrough(), runtime_factory: undefined });
      const nodes = (JSON.parse(json) as { value: { campaign: { nodes: Array<{ id: string; outcome?: { error?: { remedy?: unknown } } }> } } }).value.campaign.nodes;
      expect(nodes.find((node) => node.id === childId)?.outcome?.error?.remedy).toMatchObject({ gate: "budget", correcting_actor: "operator", corrective_action: "raise_budget" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
