import type { PhaseMessageKind, PhaseMessageRecord } from "@arbor/audit";

/**
 * ADR-016 read surface: phase messages are execution evidence the loop
 * journals from the real specialist-completion path
 * (`arbor-opencode`'s `runCampaign`, `emitPhaseMessage`). There is
 * deliberately no `phase_message.record`-style command here — a write
 * surface would let a caller fabricate the record this ledger exists to
 * prove; only the loop itself, via `EvidenceLedger.recordPhaseMessage`,
 * produces one.
 */
export type PhaseMessageQuery = {
  kind: "phase_message.list";
  campaign_id: string;
  node_id?: string;
  phase?: PhaseMessageKind;
  limit?: number;
};

export interface PhaseMessageQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: PhaseMessageQuery;
}

export interface PhaseMessageListProjection {
  campaign_id: string;
  node_id?: string;
  phase?: PhaseMessageKind;
  records: PhaseMessageRecord[];
}

export function isPhaseMessageQueryEnvelope(input: unknown): input is PhaseMessageQueryEnvelope {
  if (!record(input) || input.schema_version !== 1 || typeof input.query_id !== "string" || !record(input.query)) return false;
  return input.query.kind === "phase_message.list";
}

export function validatePhaseMessageQuery(envelope: PhaseMessageQueryEnvelope): string[] {
  const query = envelope.query;
  const failures: string[] = [];
  if (!text(query.campaign_id)) failures.push("campaign_id is required");
  if (query.node_id !== undefined && !text(query.node_id)) failures.push("node_id must be non-empty when present");
  if (query.phase !== undefined && query.phase !== "commentary" && query.phase !== "final") failures.push("phase must be commentary or final when present");
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) failures.push("limit must be a positive integer when present");
  return failures;
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
