/** Frequency decayed by whole/partial days since the last observed use. */
export function frecencyScore(frequency: number, lastUsedAt: string, now: Date | string | number = new Date()): number {
  if (!Number.isFinite(frequency) || frequency < 0) throw new Error("frecency frequency must be a non-negative finite number");
  const last = Date.parse(lastUsedAt);
  const current = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now;
  if (!Number.isFinite(last) || !Number.isFinite(current)) throw new Error("frecency timestamps must be valid");
  const days = Math.max(0, current - last) / 86_400_000;
  return frequency / (1 + days);
}

/** Stable descending frecency order; equal scores retain source ordering. */
export function rankByFrecency<T>(items: readonly T[], facts: (item: T) => { frequency: number; last_used_at: string }, now: Date | string | number = new Date()): T[] {
  return items.map((item, index) => ({ item, index, score: frecencyScore(facts(item).frequency, facts(item).last_used_at, now) }))
    .sort((left, right) => right.score - left.score || left.index - right.index).map(({ item }) => item);
}
