// S04 (audit/2026-09-06-remediation/manifest.md): arbor_select_node,
// arbor_expand_node, arbor_record_result and arbor_interrupt_campaign called
// CampaignManager directly with no ADR-028 tier gate at all — a junior
// caller could mutate campaign state (select the next node, mark it
// expanding, retire it verified/claimed, or interrupt it) with no capability
// check whatsoever, unlike arbor_start_campaign/arbor_branch/arbor_prune
// (covered by tools-legacy-authority.test.ts), which already route through
// RuntimeCatalogRouter and its own tier gate.
//
// There is no canonical RuntimeCatalogRouter command kind for selection,
// expansion or result-recording to alias (see tools.ts's `tierDenial` doc
// comment), so this closes the gap at the MCP tool boundary directly with
// the same `enforceAction` primitive the router uses internally.
import { describe, expect, it } from "vitest";
import { ArborRuntime } from "../src/runtime.js";
import { defineTools } from "../src/tools.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const root = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const ctx = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0, total_visits: 0 };
const isolationCheck = { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true };
const scoreCtx = ctx;

const child = { description: "child", estimated_gain: 1, estimated_cost: 1, category: "audit", delegate_to: "seed" };

function campaign(): ArborRuntime {
  const runtime = new ArborRuntime();
  runtime.manager.startCampaign("authority", "plan.md", root);
  return runtime;
}

/**
 * The root node is created 'claimed' by construction (arbor-core's
 * `createCampaign`, the admitted plan itself is never a selectable/
 * expandable node) — `selectNode`/`expandNode`/`recordResult` all act on a
 * 'pending' child, so every senior-success fixture below branches one first.
 */
function campaignWithPendingChild(): { runtime: ArborRuntime; childId: string } {
  const runtime = new ArborRuntime();
  runtime.manager.startCampaign("authority", "plan.md", root);
  const [childId] = runtime.manager.branch("authority", "root", [child]);
  return { runtime, childId: childId! };
}

describe("S04: arbor_select_node/arbor_expand_node/arbor_record_result authority parity", () => {
  it.each([
    ["arbor_select_node", { campaign_id: "authority", ctx }],
    ["arbor_expand_node", { campaign_id: "authority", node_id: "root", isolation_check: isolationCheck }],
    ["arbor_record_result", {
      campaign_id: "authority", node_id: "root", specialist_output: "output", specialist_agent: "specialist",
      provenance: { tag: "claimed", claimant: "specialist" },
      critic_agent: "critic", critic_approved: true, critic_rationale: "looks good", score_ctx: scoreCtx,
    }],
    ["arbor_interrupt_campaign", { campaign_id: "authority", node_id: "root", scope: "node" }],
  ] as const)("%s denies a junior caller and leaves the campaign untouched", async (name, args) => {
    const runtime = campaign();
    const router = new RuntimeCatalogRouter(runtime);
    const tools = defineTools(runtime.manager, router, "junior");
    const before = runtime.manager.getCampaignSnapshot("authority");
    const result = await tools.find((tool) => tool.name === name)!.handler(args as Record<string, unknown>);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/junior/) });
    expect(runtime.manager.getCampaignSnapshot("authority")).toEqual(before);
  });

  it("arbor_select_node authorizes a senior caller and returns the pending child", async () => {
    const { runtime, childId } = campaignWithPendingChild();
    const router = new RuntimeCatalogRouter(runtime);
    const tools = defineTools(runtime.manager, router, "senior");
    const result = await tools.find((tool) => tool.name === "arbor_select_node")!.handler({ campaign_id: "authority", ctx });
    expect(result).toEqual({ node_id: childId });
  });

  it("arbor_expand_node authorizes a senior caller and marks the node expanding", async () => {
    const { runtime, childId } = campaignWithPendingChild();
    const router = new RuntimeCatalogRouter(runtime);
    const tools = defineTools(runtime.manager, router, "senior");
    const result = await tools.find((tool) => tool.name === "arbor_expand_node")!.handler({
      campaign_id: "authority", node_id: childId, isolation_check: isolationCheck,
    });
    expect(result).toEqual({ ok: true });
    expect(runtime.manager.getCampaignSnapshot("authority")!.nodes.find((node) => node.id === childId)?.state).toBe("expanding");
  });

  it("arbor_record_result authorizes a senior caller and records the result", async () => {
    const { runtime, childId } = campaignWithPendingChild();
    const router = new RuntimeCatalogRouter(runtime);
    const tools = defineTools(runtime.manager, router, "senior");
    await tools.find((tool) => tool.name === "arbor_expand_node")!.handler({
      campaign_id: "authority", node_id: childId, isolation_check: isolationCheck,
    });
    const result = await tools.find((tool) => tool.name === "arbor_record_result")!.handler({
      campaign_id: "authority", node_id: childId, specialist_output: "output", specialist_agent: "specialist",
      provenance: { tag: "claimed", claimant: "specialist" },
      critic_agent: "critic", critic_approved: true, critic_rationale: "looks good", score_ctx: scoreCtx,
    });
    expect(result).toMatchObject({ state: "claimed" });
  });

  it("arbor_interrupt_campaign authorizes a senior caller and interrupts the node", async () => {
    const { runtime, childId } = campaignWithPendingChild();
    const router = new RuntimeCatalogRouter(runtime);
    const tools = defineTools(runtime.manager, router, "senior");
    await tools.find((tool) => tool.name === "arbor_expand_node")!.handler({
      campaign_id: "authority", node_id: childId, isolation_check: isolationCheck,
    });
    const result = await tools.find((tool) => tool.name === "arbor_interrupt_campaign")!.handler({
      campaign_id: "authority", node_id: childId, scope: "node", reason: "test",
    });
    expect(result).toMatchObject({ affected_node_ids: [childId] });
  });

  it("defaults to senior (unchanged behavior) when defineTools is called without a callerTier, matching every existing production call site", async () => {
    const { runtime, childId } = campaignWithPendingChild();
    const router = new RuntimeCatalogRouter(runtime);
    const tools = defineTools(runtime.manager, router);
    const result = await tools.find((tool) => tool.name === "arbor_select_node")!.handler({ campaign_id: "authority", ctx });
    expect(result).toEqual({ node_id: childId });
  });
});
