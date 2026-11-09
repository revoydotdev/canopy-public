/** Keep native pre-campaign work observable without polling terminal-only views. */
export function shouldRefreshConsoleSession(input: {
  readonly screen: string;
  readonly campaign_id: string | null;
  readonly live_session_count: number;
  readonly console_data: unknown;
}): boolean {
  if (input.screen !== "console") return false;
  if (input.campaign_id !== null || input.live_session_count > 0) return true;
  if (typeof input.console_data !== "object" || input.console_data === null) return false;
  const drafts = (input.console_data as { drafts?: unknown }).drafts;
  if (typeof drafts !== "object" || drafts === null) return false;
  const items = (drafts as { items?: unknown }).items;
  return Array.isArray(items) && items.some((draft: unknown) =>
    typeof draft === "object" && draft !== null
    && (draft as { status?: unknown }).status === "planning");
}
