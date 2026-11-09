import { describe, expect, it, vi } from "vitest";
import { ArborRuntime } from "../src/runtime.js";
import { ArborMCPServer } from "../src/server.js";
import { defineTools } from "../src/tools.js";
import type { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const root = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const child = { description: "child", estimated_gain: 1, estimated_cost: 1, category: "audit", delegate_to: "seed" };

describe("legacy MCP mutation authority", () => {
  it.each(["arbor_branch", "arbor_prune"])("%s preserves a canonical permission refusal without mutating the tree", async (name) => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("authority", "plan.md", root);
    const error = { code: "permission", summary: "senior capability required" };
    const dispatchCommand = vi.fn(() => ({ ok: true, value: { accepted: false, error }, capability: "tree.write" }));
    // Only the router port used by these handlers is supplied; the real manager
    // proves that a denial never falls through to its mutation methods.
    const router = { dispatchCommand } as unknown as RuntimeCatalogRouter;
    const tools = defineTools(runtime.manager, router);
    const before = runtime.manager.getCampaignSnapshot("authority");
    const result = await tools.find((tool) => tool.name === name)!.handler({
      campaign_id: "authority", parent_id: "root", node_id: "root", actions: [child],
    });
    expect(result).toEqual({ ok: true, value: { accepted: false, error }, capability: "tree.write" });
    expect(dispatchCommand).toHaveBeenCalledWith(expect.objectContaining({
      schema_version: 1,
      command: expect.objectContaining({ kind: name === "arbor_branch" ? "tree.branch" : "tree.prune", campaign_id: "authority", node_id: "root" }),
    }));
    expect(runtime.manager.getCampaignSnapshot("authority")).toEqual(before);
  });

  it("routes legacy campaign creation through the same authority without creating a denied campaign", async () => {
    const runtime = new ArborRuntime();
    const error = { code: "permission", summary: "senior capability required" };
    const denial = { ok: true, value: { accepted: false, error }, capability: "campaign.write" };
    const dispatchCommand = vi.fn(async () => denial);
    const router = { dispatchCommand } as unknown as RuntimeCatalogRouter;
    const tool = defineTools(runtime.manager, router).find((entry) => entry.name === "arbor_start_campaign")!;
    expect(await tool.handler({ id: "denied", plan_path: "plan.md", root_action: root })).toEqual(denial);
    expect(dispatchCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: { kind: "campaign.start", campaign_id: "denied", plan_path: "plan.md", root_action: root },
    }));
    expect(runtime.manager.getCampaignSnapshot("denied")).toBeNull();
  });

  it("advertises deprecation and returns canonical acknowledgements through the real command authority", async () => {
    const server = new ArborMCPServer(new ArborRuntime());
    for (const name of ["arbor_start_campaign", "arbor_branch", "arbor_prune"]) {
      expect(server.listTools().find((tool) => tool.name === name)?.description).toMatch(/^Deprecated: use arbor_command/);
    }
    expect(await server.callTool("arbor_start_campaign", { id: "authority", plan_path: "plan.md", root_action: root }))
      .toMatchObject({ ok: true, value: { accepted: true }, capability: "campaign.write" });
    const branch = await server.callTool("arbor_branch", {
      campaign_id: "authority", parent_id: "root", actions: [child],
    });
    expect(branch).toMatchObject({ ok: true, value: { accepted: true }, capability: "tree.write" });
    const children = server.manager.getCampaignSnapshot("authority")!.nodes.filter((node) => node.parent_id === "root");
    expect(children).toHaveLength(1);
    expect(children[0]!.state).toBe("pending");
    expect(await server.callTool("arbor_prune", { campaign_id: "authority", node_id: children[0]!.id })).toMatchObject({ ok: true, value: { accepted: true }, capability: "tree.write" });
    expect(server.manager.getCampaignSnapshot("authority")!.nodes.find((node) => node.id === children[0]!.id)?.state).toBe("pruned");
  });
});
