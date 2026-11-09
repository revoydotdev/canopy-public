// Fixture stub: the durable store the lifecycle reads. The status set is closed,
// and a window retired for want of an actor lands in a TERMINAL status the set
// knows — an unrecognised status makes the pre-commit scan incomplete, and an
// incomplete scan refuses every commit.
export const SESSION_STATUSES = ["open", "closing", "closed", "abandoned"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export interface SessionRecord { readonly session_id: string; readonly status: SessionStatus }
