/** Display ordering only: session-local sequence numbers are not global clocks. */
export function consoleCampaignSessionIds(sessionsValue: unknown, campaignId: string | null): readonly string[] {
  const shape = typeof sessionsValue === "object" && sessionsValue !== null ? sessionsValue as Record<string, unknown> : {};
  const sessions = Array.isArray(shape.sessions) ? shape.sessions : Array.isArray(shape.items) ? shape.items : [];
  return sessions.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const session = candidate as Record<string, unknown>;
    if (typeof session.session_id !== "string" || typeof session.campaign_id !== "string"
      || (campaignId !== null && session.campaign_id !== campaignId)) return [];
    const parsed = typeof session.latest_event_at === "string" ? Date.parse(session.latest_event_at) : NaN;
    return [{ id: session.session_id, live: session.terminal == null, at: Number.isFinite(parsed) ? parsed : null }];
  }).sort((left, right) => Number(right.live) - Number(left.live)
    || (left.at === null ? (right.at === null ? 0 : 1) : right.at === null ? -1 : right.at - left.at)
    // Stable identity tie-break, not a claim of chronological ordering.
    || right.id.localeCompare(left.id)).map((session) => session.id);
}
