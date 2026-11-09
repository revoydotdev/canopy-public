import type { RecoverableNodeView } from "./manager.js";
import { createHash } from "node:crypto";

/** Bounded, campaign-scoped read side for the recovery commands. */
export interface RecoveryPendingQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "recovery.pending"; campaign_id: string; limit?: number };
}

export interface RecoveryPendingProjection {
  schema_version: 1;
  campaign_id: string;
  /** Campaign revision observed for every row in this projection. */
  source_version: string;
  /** SHA-256 binding of the campaign revision and bounded row set. */
  fingerprint: string;
  nodes: readonly RecoverableNodeView[];
}

export function recoveryPendingFingerprint(campaignId: string, sourceVersion: string, nodes: readonly RecoverableNodeView[]): string {
  // JSON array order is the manager's deterministic tree order. Rebuild each
  // row to keep unrelated object properties out of the projection identity.
  return createHash("sha256").update(JSON.stringify({
    campaign_id: campaignId,
    source_version: sourceVersion,
    nodes: nodes.map(({ campaign_id, node_id, state, prior_operation_id, expected_version }) => ({ campaign_id, node_id, state, prior_operation_id, expected_version })),
  })).digest("hex");
}

export function isRecoveryPendingQueryEnvelope(value: unknown): value is RecoveryPendingQueryEnvelope {
  return record(value) && record(value.query) && value.query.kind === "recovery.pending";
}

export function validateRecoveryPendingQuery(value: RecoveryPendingQueryEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  if (!text(value.query_id)) failures.push("query_id must be non-empty");
  if (!text(value.query.campaign_id)) failures.push("query.campaign_id must be non-empty");
  if (value.query.limit !== undefined && (!Number.isSafeInteger(value.query.limit) || value.query.limit < 1 || value.query.limit > 1_000)) failures.push("query.limit must be an integer from 1 through 1000");
  return failures;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object"; }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
