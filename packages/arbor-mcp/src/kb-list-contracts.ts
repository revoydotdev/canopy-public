import type { Envelope } from "@arbor/core";
import type { KBEntry } from "@arbor/kb";

/**
 * `kb.list` — the enumeration query the KB entries `manager.ts`'s
 * `kb.entry_added` event already names by id had no way to be read back with
 * (finding 8, TUI-vs-backend observability gap audit). An operator only ever
 * saw an opaque `entry_id` flash through the diagnostics event log; the real
 * `failure_mode`/`root_cause`/`fix_template`/`parameter`/`validated_value`
 * content behind it was unreachable — no `RuntimeQueryKind` existed to fetch
 * it.
 *
 * Backed by `CampaignManager.kbQuery` (already real, already used by
 * `devtools.ts`/`resources.ts`/`webui.ts`), which returns full
 * capability-gated `Envelope<KBEntry>` records — the same envelope a
 * single-entry `KnowledgeBase.read` would return, so a list closes the gap
 * completely: every row already carries the entry's real content, not a
 * pointer to a second round trip.
 *
 * Follows the same minimal per-kind contracts shape as `config-contracts.ts`/
 * `agent-contracts.ts`/`operation-list-contracts.ts` (query-only, no command
 * side).
 */
export interface KbListQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "kb.list"; campaign_id: string; type?: KBEntry["type"]; limit?: number };
}

/**
 * Envelopes, not bare entries: a `capability_required` absence (a
 * `critic_only` entry read at a tier that cannot see it) is a real, honest
 * fact the projection must be able to state, never silently dropped or
 * fabricated into a visible row.
 */
export type KbListProjection = readonly Envelope<KBEntry>[];

export function isKbListQueryEnvelope(value: unknown): value is KbListQueryEnvelope {
  return object(value) && object(value.query) && value.query.kind === "kb.list";
}

const KB_ENTRY_TYPES = ["failure_mode", "success_pattern", "parameter_finding"] as const;

export function validateKbListQuery(value: KbListQueryEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  if (!text(value.query_id)) failures.push("query_id must be non-empty");
  if (!text(value.query.campaign_id)) failures.push("query.campaign_id must be non-empty");
  if (value.query.type !== undefined && !KB_ENTRY_TYPES.includes(value.query.type)) failures.push("query.type is invalid");
  if (value.query.limit !== undefined && (!Number.isSafeInteger(value.query.limit) || value.query.limit <= 0)) {
    failures.push("query.limit must be a positive safe integer");
  }
  return failures;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
