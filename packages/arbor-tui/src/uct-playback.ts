import { BACKTRACK_DISPLAY_MS, recentUctBacktracks, type UctBacktrack } from "./uct-header.js";

export interface UctPlayback {
  readonly campaign_id: string | null;
  readonly attached_at_ms: number;
  readonly observed_at_ms: number;
  readonly seen: readonly string[];
  readonly pending: readonly UctBacktrack[];
  readonly dropped: number;
}

export function initialUctPlayback(): UctPlayback {
  return { campaign_id: null, attached_at_ms: 0, observed_at_ms: 0, seen: [], pending: [], dropped: 0 };
}

/** Receipt-clock playback; source timestamps remain evidence, not animation clocks. */
export function observeUctPlayback(previous: UctPlayback, stream: unknown, campaignId: string | null, nowMs: number): UctPlayback {
  if (!Number.isFinite(nowMs) || typeof stream !== "object" || stream === null) return previous;
  const lines = (stream as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return previous;
  const candidates = lines.flatMap((line) => {
    const ts = typeof line === "object" && line !== null ? (line as { ts?: unknown }).ts : null;
    const occurred = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
    return occurred <= nowMs ? recentUctBacktracks({ lines: [line] }, occurred, campaignId) : [];
  }).sort((a, b) => a.occurred_at_ms - b.occurred_at_ms);
  const key = (event: UctBacktrack): string => JSON.stringify([event.from, event.to, event.occurred_at_ms]);
  if (campaignId !== previous.campaign_id || previous.campaign_id === null) {
    return { campaign_id: campaignId, attached_at_ms: nowMs, observed_at_ms: nowMs,
      seen: candidates.map(key).slice(-512), pending: [], dropped: 0 };
  }
  if (nowMs < previous.observed_at_ms) return previous;
  const seen = new Set(previous.seen);
  const pending = previous.pending.filter((event) => nowMs < (event.playback_at_ms ?? event.occurred_at_ms) + BACKTRACK_DISPLAY_MS);
  let dropped = previous.dropped;
  for (const event of candidates) {
    const id = key(event);
    if (seen.has(id)) continue;
    seen.add(id);
    if (event.occurred_at_ms <= previous.attached_at_ms) continue;
    if (pending.length >= 16) { dropped++; continue; }
    const last = pending.at(-1);
    const start = Math.max(nowMs, last === undefined ? nowMs : (last.playback_at_ms ?? last.occurred_at_ms) + BACKTRACK_DISPLAY_MS);
    pending.push({ ...event, playback_at_ms: start });
  }
  return { ...previous, observed_at_ms: nowMs, seen: [...seen].slice(-512), pending, dropped };
}
