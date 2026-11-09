// S04 (audit/2026-09-06-remediation/manifest.md) follow-up: the tier gate
// added in tools.ts (see s04-legacy-authority-parity.test.ts) was correct but
// unreachable in production — server.ts:62 called
// `defineTools(this.manager, this.runtimeCatalog)` with only two arguments,
// so every real `ArborMCPServer`, including the untrusted `arbor serve`
// composition (`new ArborMCPServer(runtime, {caller_tier: "junior"})`, the
// exact shape cli.ts uses), silently dropped the caller's tier and gated
// as "senior" regardless. This drives the REAL `ArborMCPServer` surface
// (`server.callTool`, not `defineTools` directly) with an explicit junior
// tier and asserts on the capability-denial REASON, not merely `ok:false` —
// a denial test that only checks `ok:false` also "passes" against an
// ungated handler that fails for an unrelated reason (bad payload, missing
// campaign, ...).
import { describe, expect, it } from "vitest";
import { ArborRuntime } from "../src/runtime.js";
import { ArborMCPServer } from "../src/server.js";

const rootAction = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const childAction = { description: "child", estimated_gain: 1, estimated_cost: 1, category: "audit", delegate_to: "seed" };
const ctx = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0, total_visits: 0 };
const isolationCheck = { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true };

/** The reason string enforceAction/CapabilityError actually produces (capability.ts). */
const DENIAL_REASON = /requires capability senior but caller is junior/;

function campaignWithPendingChild(): { runtime: ArborRuntime; childId: string } {
  const runtime = new ArborRuntime();
  runtime.manager.startCampaign("camp-s04-wiring", "plan.md", rootAction);
  const [childId] = runtime.manager.branch("camp-s04-wiring", "root", [childAction]);
  return { runtime, childId: childId! };
}

describe("S04: the real ArborMCPServer honors a configured junior caller_tier", () => {
  it.each([
    ["arbor_select_node", () => ({ campaign_id: "camp-s04-wiring", ctx })],
    ["arbor_expand_node", (childId: string) => ({ campaign_id: "camp-s04-wiring", node_id: childId, isolation_check: isolationCheck })],
    ["arbor_record_result", (childId: string) => ({
      campaign_id: "camp-s04-wiring", node_id: childId, specialist_output: "output", specialist_agent: "specialist",
      provenance: { tag: "claimed", claimant: "specialist" },
      critic_agent: "critic", critic_approved: true, critic_rationale: "looks good", score_ctx: ctx,
    })],
    ["arbor_interrupt_campaign", (childId: string) => ({ campaign_id: "camp-s04-wiring", node_id: childId, scope: "node" })],
  ] as const)("%s is denied for the capability reason through the real junior-tier server, not merely ok:false", async (name, buildArgs) => {
    const { runtime, childId } = campaignWithPendingChild();
    // Exactly cli.ts's untrusted `arbor serve` composition (WA-10): a
    // transport handed to a party it does not fully control passes
    // caller_tier: "junior" explicitly.
    const server = new ArborMCPServer(runtime, { caller_tier: "junior" });
    const before = runtime.manager.getCampaignSnapshot("camp-s04-wiring");
    const result = (await server.callTool(name, buildArgs(childId) as Record<string, unknown>)) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    // Assert on WHY it was denied, not just that it was denied — a payload
    // or schema failure also produces ok:false and would pass a weaker
    // assertion against a completely ungated handler.
    expect(result.error).toMatch(DENIAL_REASON);
    expect(runtime.manager.getCampaignSnapshot("camp-s04-wiring")).toEqual(before);
  });

  it("the same four tools succeed end-to-end through the real server once it is composed with (default) senior authority", async () => {
    const { runtime, childId } = campaignWithPendingChild();
    const server = new ArborMCPServer(runtime); // no caller_tier supplied -> "senior", matching every trusted in-process composition root
    const selected = await server.callTool("arbor_select_node", { campaign_id: "camp-s04-wiring", ctx });
    expect(selected).toEqual({ node_id: childId });

    const expanded = await server.callTool("arbor_expand_node", { campaign_id: "camp-s04-wiring", node_id: childId, isolation_check: isolationCheck });
    expect(expanded).toEqual({ ok: true });
    expect(runtime.manager.getCampaignSnapshot("camp-s04-wiring")!.nodes.find((node) => node.id === childId)?.state).toBe("expanding");

    const recorded = await server.callTool("arbor_record_result", {
      campaign_id: "camp-s04-wiring", node_id: childId, specialist_output: "output", specialist_agent: "specialist",
      provenance: { tag: "claimed", claimant: "specialist" },
      critic_agent: "critic", critic_approved: true, critic_rationale: "looks good", score_ctx: ctx,
    });
    expect(recorded).toMatchObject({ state: "claimed" });

    // arbor_interrupt_campaign on its own child: interrupting a node retires
    // it, so this runs against a second, still-'expanding' child rather than
    // the one just recorded above.
    const [secondChildId] = runtime.manager.branch("camp-s04-wiring", "root", [childAction]);
    await server.callTool("arbor_expand_node", { campaign_id: "camp-s04-wiring", node_id: secondChildId, isolation_check: isolationCheck });
    const interrupted = (await server.callTool("arbor_interrupt_campaign", { campaign_id: "camp-s04-wiring", node_id: secondChildId, scope: "node", reason: "test" })) as { affected_node_ids: string[] };
    expect(interrupted.affected_node_ids).toContain(secondChildId);
  });

  it("a junior-tier server still permits the four already-canonical-routed legacy aliases only insofar as the router denies them the same way (no regression)", async () => {
    const { runtime } = campaignWithPendingChild();
    const server = new ArborMCPServer(runtime, { caller_tier: "junior" });
    const start = (await server.callTool("arbor_start_campaign", { id: "camp-s04-second", plan_path: "plan.md", root_action: rootAction })) as { ok: boolean; value: { accepted: boolean; error: { summary: string } } };
    expect(start.ok).toBe(true);
    expect(start.value.accepted).toBe(false);
    expect(start.value.error.summary).toMatch(/senior/);
    expect(runtime.manager.getCampaignSnapshot("camp-s04-second")).toBeNull();
  });
});
