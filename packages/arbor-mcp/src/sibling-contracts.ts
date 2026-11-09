/**
 * Runtime catalog contract for `sibling.status` (Phase 4D.5 — G-29).
 *
 * `CampaignManager.getSiblingStatus` is a real, pure reconciliation over the
 * `NodeCommunication` ledger (delegate/report/retract linkage — never an
 * in-memory count); this file is the missing envelope contract that lets the
 * catalog router actually reach it. No `@arbor/audit` type appears in the
 * envelope itself, but it is kept alongside `bus-contracts.ts`/
 * `a2a-runtime-contracts.ts` in `@arbor/mcp` rather than in
 * `@arbor/core` for the same reason: it is part of the same
 * ledger-communication family and belongs with its siblings' contracts, not
 * split into core's closed lifecycle unions.
 */

export interface SiblingStatusQuery {
  kind: "sibling.status";
  campaign_id: string;
  node_id: string;
}

export interface SiblingStatusQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: SiblingStatusQuery;
}

export interface SiblingStatusProjection {
  campaign_id: string;
  node_id: string;
  active: readonly string[];
  depth: number;
  within_bounds: boolean;
}

export function isSiblingStatusQueryEnvelope(input: unknown): input is SiblingStatusQueryEnvelope {
  return record(input) && input.schema_version === 1 && typeof input.query_id === "string"
    && record(input.query) && input.query.kind === "sibling.status";
}

export function validateSiblingStatusQuery(envelope: SiblingStatusQueryEnvelope): string[] {
  const failures: string[] = [];
  if (!text(envelope.query_id)) failures.push("query_id must be non-empty");
  if (!text(envelope.query.campaign_id) || !text(envelope.query.node_id)) failures.push("campaign_id and node_id are required");
  return failures;
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
