import type { AuditRecord } from "@arbor/audit";

/**
 * `audit.list` — the enumeration query the evidence ledger had no query
 * surface at all for (finding 9, TUI-vs-backend observability gap audit).
 * `manager.ts` emits `{kind:"audit.evidence_recorded", campaign_id,
 * evidence_id}` at 8+ call sites, but an operator only ever saw the opaque
 * `evidence_id` flash through the diagnostics event log — the real
 * `TracePacket`/`GateCheckpointRecord`/`RecoveryDecisionRecord`/etc. content
 * behind it was unreachable by construction.
 *
 * Backed by `CampaignManager.getAuditRecords` — already real, already the
 * "immutable, complete audit projection for read-only runtime observers" its
 * own doc comment names, just never wired to a `RuntimeQueryKind`. Returns
 * every persisted record for a campaign (trace packets, gate checkpoints,
 * recovery decisions, interruptions, ...), never a synthesized shape.
 *
 * Follows the same minimal per-kind contracts shape as `config-contracts.ts`/
 * `agent-contracts.ts`/`operation-list-contracts.ts` (query-only, no command
 * side).
 */
export interface AuditListQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "audit.list"; campaign_id: string; limit?: number };
}

export type AuditListProjection = readonly AuditRecord[];

export function isAuditListQueryEnvelope(value: unknown): value is AuditListQueryEnvelope {
  return object(value) && object(value.query) && value.query.kind === "audit.list";
}

export function validateAuditListQuery(value: AuditListQueryEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  if (!text(value.query_id)) failures.push("query_id must be non-empty");
  if (!text(value.query.campaign_id)) failures.push("query.campaign_id must be non-empty");
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
