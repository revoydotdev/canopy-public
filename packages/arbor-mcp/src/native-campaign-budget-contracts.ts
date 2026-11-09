/** Read-only canonical projection of the durable native campaign allocation. */
import type { NativeCampaignBudgetSnapshot } from "./native-campaign-budget.js";

export interface NativeCampaignBudgetQueryEnvelope {
  readonly schema_version: 1;
  readonly query_id: string;
  readonly query: { readonly kind: "native.budget.get"; readonly campaign_id: string };
}

/**
 * `unconfigured` is a deliberate absence, not an empty zero-budget record.
 * A configured snapshot is read directly from the durable authority; this
 * projection never invents a remaining budget from telemetry or config.
 */
export type NativeCampaignBudgetProjection =
  | { readonly availability: "unconfigured"; readonly campaign_id: string }
  | ({ readonly availability: "configured" } & NativeCampaignBudgetSnapshot);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNativeCampaignBudgetQueryEnvelope(value: unknown): value is NativeCampaignBudgetQueryEnvelope {
  return record(value) && value.schema_version === 1 && typeof value.query_id === "string"
    && record(value.query) && value.query.kind === "native.budget.get";
}

export function validateNativeCampaignBudgetQuery(value: NativeCampaignBudgetQueryEnvelope): readonly string[] {
  const failures: string[] = [];
  if (!value.query_id.trim()) failures.push("query_id is required");
  if (!value.query.campaign_id.trim()) failures.push("campaign_id is required");
  return failures;
}
