/** A matching final tree needs no periodic execution refresh. */
export function shouldRefreshFocusedTree(campaignId: string | null, currentTree: unknown): boolean {
  if (campaignId === null) return false;
  if (typeof currentTree !== "object" || currentTree === null) return true;
  const tree = currentTree as { readonly campaign_id?: unknown; readonly halted?: unknown };
  return tree.campaign_id !== campaignId || tree.halted !== true;
}

/** Review focus is not the manager's execution pointer: terminal work stays visible. */
export function newestVisibleCampaignId(
  campaigns: readonly { readonly id: string; readonly started_at: string }[],
  hidden: ReadonlySet<string>,
): string | null {
  let newest: { readonly id: string; readonly started_at: string } | null = null;
  for (const campaign of campaigns) {
    if (hidden.has(campaign.id)) continue;
    if (newest === null || campaign.started_at > newest.started_at
      || (campaign.started_at === newest.started_at && campaign.id > newest.id)) newest = campaign;
  }
  return newest?.id ?? null;
}
