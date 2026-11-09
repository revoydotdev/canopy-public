import { describe, expect, it } from "vitest";
import { CampaignManager } from "@arbor/mcp";
import type { Action, Provenance, ScoreContext } from "@arbor/core";
import { prepareOutput, suppressRoutineSuccess, type OutputEvidenceCapturePort } from "@arbor/campaign-support";
import { DEFAULT_LOOP_CONFIG, runCampaign, type CampaignLoopConfig, type LoopExecutor } from "../src/loop.js";

const tiny = { max_bytes: 180, max_lines: 5, max_tokens_estimate: 45 };
const verified: Provenance = { tag: "verified", cmd: "vitest", exit: 0, stdout_hash: "sha256:test"};

describe("agent output boundary", () => {
  it("captures adversarial no-newline output before propagating a bounded summary", async () => {
    const calls: string[] = [];
    const capture: OutputEvidenceCapturePort = { async capture(input) { calls.push(input.content); return { evidence_pointer: "audit://c/n/specialist" }; } };
    const raw = "SECRET-MIDDLE-".repeat(20_000);
    const prepared = await prepareOutput({ campaign_id: "c", node_id: "n", kind: "specialist", content: raw, provenance: verified, capture, budget: tiny });

    expect(calls).toEqual([raw]);
    expect(prepared.abbreviated).toBe(true);
    expect(Buffer.byteLength(prepared.summary)).toBeLessThan(500);
    expect(prepared.summary).toContain("audit://c/n/specialist");
    expect(prepared.summary).toContain("provenance=verified");
    expect(prepared.capture?.provenance).toEqual(verified);
    expect(prepared.capture?.content_bytes).toBe(Buffer.byteLength(raw));
  });

  it("fails closed when durable capture rejects", async () => {
    const capture: OutputEvidenceCapturePort = { async capture() { throw new Error("disk unavailable"); } };
    await expect(prepareOutput({ campaign_id: "c", node_id: "n", kind: "tool", content: "x".repeat(10_000), provenance: { tag: "claimed", claimant: "seed" }, capture, budget: tiny }))
      .rejects.toThrow("disk unavailable");
  });

  it("suppresses only short routine successes", async () => {
    const output = await prepareOutput({ campaign_id: "c", node_id: "n", kind: "specialist", content: "tests pass", provenance: verified, budget: tiny });
    expect(suppressRoutineSuccess(output, true)).toContain("routine success suppressed");
    expect(suppressRoutineSuccess(output, false)).toBe("tests pass");
  });
});

describe("campaign output propagation", () => {
  it("never sends oversized raw output to critic, branch planner, or tree record", async () => {
    const raw = `head\n${"private-detail\n".repeat(2_000)}tail`;
    const captured: Array<{ content: string; provenance: Provenance }> = [];
    let criticOutput = "";
    let criticPrompt = "";
    let branchOutput = "";
    const capture: OutputEvidenceCapturePort = {
      async capture(input) { captured.push({ content: input.content, provenance: input.provenance }); return { evidence_pointer: `audit://${input.kind}` }; },
    };
    const executor: LoopExecutor = {
      async specialize() { return { output: raw, provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "test fixture" } }; },
      async review(input) { criticOutput = input.specialist_output; criticPrompt = input.prompt; return { approved: true, rationale: "looks sound", token_usage: { kind: "unavailable", reason: "test fixture" } }; },
    };
    const manager = new CampaignManager();
    const action: Action = { description: "work", category: "testing", estimated_gain: 1, estimated_cost: 1, delegate_to: "seed" };
    manager.startCampaign("c", "plan", action);
    const [childId] = manager.branch("c", "root", [action]);
    const score: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 1, total_visits: 1 };
    const config: CampaignLoopConfig = {
      ...DEFAULT_LOOP_CONFIG,
      max_iterations: 1,
      use_worktrees: false,
      specialist_cap: { tier: "specialist" },
      critic_cap: { tier: "critic" },
      score_ctx: () => score,
      branch_actions(input) { branchOutput = input.output; return null; },
      output_evidence: capture,
      output_budget: tiny,
    };
    await runCampaign({ manager, campaign_id: "c", executor, config });

    expect(captured[0]).toEqual({ content: raw, provenance: { tag: "claimed", claimant: "seed" } });
    expect(criticOutput).not.toContain("private-detail\nprivate-detail\nprivate-detail");
    expect(criticPrompt).not.toContain("private-detail\nprivate-detail\nprivate-detail");
    expect(branchOutput).toBe(criticOutput);
    expect(manager.getNodeInfo("c", childId!)?.specialist_output).toBe(criticOutput);
    expect(criticOutput).toContain("audit://specialist");
  });

  it("keeps bounded critic rationale and root cause semantically distinct", async () => {
    const manager = new CampaignManager();
    const action: Action = { description: "work", category: "testing", estimated_gain: 1, estimated_cost: 1, delegate_to: "seed" };
    manager.startCampaign("distinct", "plan", action);
    manager.branch("distinct", "root", [action]);
    let recordedRationale: string | undefined;
    let recordedRootCause: string | undefined;
    const recordResult = manager.recordResult.bind(manager);
    manager.recordResult = ((campaignId, nodeId, result) => {
      recordedRationale = result.critic_rationale;
      recordedRootCause = result.critic_root_cause;
      return recordResult(campaignId, nodeId, result);
    }) as typeof manager.recordResult;
    const captures: string[] = [];
    const config: CampaignLoopConfig = {
      ...DEFAULT_LOOP_CONFIG,
      max_iterations: 1,
      use_worktrees: false,
      specialist_cap: { tier: "specialist" },
      critic_cap: { tier: "critic" },
      score_ctx: () => ({ accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 1, total_visits: 1 }),
      branch_actions: () => null,
      output_budget: tiny,
      output_evidence: { async capture(input) { captures.push(input.content); return { evidence_pointer: "audit://critic" }; } },
    };
    const executor: LoopExecutor = {
      async specialize() { return { output: "implementation", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "test fixture" } }; },
      async review() { return { approved: false, rationale: `RATIONALE ${"context ".repeat(200)}`, root_cause: `ROOT_CAUSE ${"cause ".repeat(200)}`, token_usage: { kind: "unavailable", reason: "test fixture" } }; },
    };
    await runCampaign({ manager, campaign_id: "distinct", executor, config });
    expect(captures).toHaveLength(1);
    expect(captures[0]).toContain("RATIONALE");
    expect(captures[0]).toContain("ROOT_CAUSE");
    expect(recordedRationale).toContain("RATIONALE");
    expect(recordedRootCause).toContain("ROOT_CAUSE");
    expect(recordedRootCause).not.toContain("RATIONALE");
  });
});
