import { describe, expect, it } from "vitest";
import { collectLifecycleCampaigns } from "../lifecycle-tree-publication.mjs";

describe("lifecycle tree publication", () => {
  it("discovers and orders a lineage from primary and follow-up turns", () => {
    expect(collectLifecycleCampaigns({
      campaign_id: "campaign-a",
      task_turns: [{ campaign_id: "campaign-a", args: ["task", "initial"] }],
      followup_task_turns: [
        { campaign_id: "campaign-b", args: ["task", "follow-up", "campaign-a", "second"] },
        { campaign_result: { campaign_id: "campaign-c" }, args: ["task", "follow-up", "campaign-b", "third"] },
      ],
    })).toEqual([
      { campaign_id: "campaign-a", parent_campaign_id: null },
      { campaign_id: "campaign-b", parent_campaign_id: "campaign-a" },
      { campaign_id: "campaign-c", parent_campaign_id: "campaign-b" },
    ]);
  });

  it("fails closed on absent identities, unsafe identities, and broken lineage", () => {
    expect(() => collectLifecycleCampaigns({ task_turns: [] })).toThrow(/no campaign identities/);
    expect(() => collectLifecycleCampaigns({ campaign_id: "campaign-a", followups: [{ campaign_id: "campaign-b", parent_campaign_id: "wrong" }] })).toThrow(/not lineage-linked/);
    expect(() => collectLifecycleCampaigns({ campaign_id: "campaign-a", followups: [{ campaign_id: "campaign-b", parent_campaign_id: "../escape" }] })).toThrow(/unsafe parent/);
  });
});
