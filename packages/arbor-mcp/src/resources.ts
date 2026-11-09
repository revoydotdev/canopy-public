import type { CampaignManager } from "./manager.js";

export interface ResourceDefinition {
  uri_template: string;
  description: string;
  handler: (campaignId: string) => unknown;
}

export function defineResources(manager: CampaignManager): ResourceDefinition[] {
  return [
    {
      uri_template: "arbor://campaigns/{id}/state",
      description: "Campaign state: halt status, audit stats, iteration count",
      handler: (campaignId: string) => {
        const status = manager.haltStatus(campaignId);
        const halt = manager.recordedHalt(campaignId);
        const stats = manager.auditCampaign(campaignId);
        return { status, halt, stats };
      },
    },
    {
      uri_template: "arbor://campaigns/{id}/kb",
      description: "KB entries for this campaign (all types, critic tier)",
      handler: (campaignId: string) => {
        return manager.kbQuery(campaignId, null, { tier: "critic" });
      },
    },
    {
      uri_template: "arbor://campaigns/{id}/audit",
      description: "Audit trail: trace packets for this campaign",
      handler: (campaignId: string) => {
        const stats = manager.auditCampaign(campaignId);
        const bypasses = manager.auditBypasses(campaignId);
        return { stats, bypasses };
      },
    },
  ];
}
