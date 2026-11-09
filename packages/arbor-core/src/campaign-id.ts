/** Campaign IDs become persistence path components, so display-name grammar is unsafe here. */
const CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidCampaignId(value: unknown): value is string {
  return typeof value === "string" && CAMPAIGN_ID.test(value) && value !== "." && value !== "..";
}

export function assertValidCampaignId(value: unknown, label = "campaign_id"): asserts value is string {
  if (!isValidCampaignId(value)) throw new Error(`${label} must be a safe campaign identifier`);
}

/** A path in a capability scope must stay relative on both POSIX and Windows. */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || value.includes("\0")) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.includes(":")) return false;
  return value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..");
}
