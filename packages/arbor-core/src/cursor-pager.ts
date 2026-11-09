/**
 * Deterministic cursor pagination over an ordered result set (Phase 4D /
 * release-readiness "cursor pagination not wired" gap).
 *
 * revoy2's queries return ordered projections (a list of campaigns, a tree's
 * node array, a supervisor's task list). A `RuntimeCursor` encodes an offset
 * via its `sequence`, and this helper returns the bounded slice *strictly
 * after* that offset plus an opaque next-cursor. Pure and dependency-free; no
 * authority or mutable state lives here (Commandment III) — the caller supplies
 * the current ordered array and we page over it deterministically.
 */
import type { RuntimeCursor } from "./runtime-contracts.js";

export interface CursorPage<T> {
  items: T[];
  /** Opaque cursor for the next page; null when this page is the last. */
  next_cursor: RuntimeCursor | null;
  /** Total items in the underlying result set (before this page's slice). */
  total: number;
}

export interface CursorPageInput {
  /** The stream_id that identifies this result-set lineage. */
  stream_id: string;
  /** 0-based offset to start from (>= 0); the cursor's sequence is the offset. */
  offset: number;
  /** Strictly positive page size. */
  limit: number;
  /** The full ordered result set to page over. */
  items: readonly unknown[];
}

/**
 * Page `items` starting at `offset`, capped at `limit`, returning a next-cursor
 * whose sequence is the next offset (or null when `offset + limit >= items.length`).
 */
export function cursorPage<T>(input: CursorPageInput): CursorPage<T> {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw new Error("cursor offset must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new Error("cursor limit must be a positive safe integer");
  }
  const start = Math.min(input.offset, input.items.length);
  const end = Math.min(input.offset + input.limit, input.items.length);
  const items = input.items.slice(start, end) as T[];
  const nextOffset = end;
  const hasMore = nextOffset < input.items.length;
  const next_cursor: RuntimeCursor | null = hasMore
    ? { stream_id: input.stream_id, sequence: nextOffset }
    : null;
  return { items, next_cursor, total: input.items.length };
}

/** Parse a cursor's sequence as an offset, failing loudly on a mismatched stream. */
export function cursorOffset(cursor: RuntimeCursor | undefined, stream_id: string): number {
  if (cursor === undefined) return 0;
  if (cursor.stream_id !== stream_id) {
    throw new Error(`cursor stream ${cursor.stream_id} does not match ${stream_id}`);
  }
  return cursor.sequence;
}
