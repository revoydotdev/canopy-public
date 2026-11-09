import type { CompactionLifecycleRecord } from "@arbor/audit";
import type { OperationMetadata } from "@arbor/core";

export type CompactionCommand = {
  kind: "compaction.record";
  campaign_id: string;
  node_id: string;
  lifecycle: import("@arbor/audit").CompactionLifecycle;
};

export type CompactionQuery = {
  kind: "compaction.list" | "compaction.guard";
  campaign_id: string;
  node_id?: string;
  limit?: number;
  as_of?: string;
};

export interface CompactionCommandEnvelope {
  schema_version: 1;
  metadata: OperationMetadata;
  command: CompactionCommand;
}

export interface CompactionQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: CompactionQuery;
}

export interface CompactionListProjection {
  campaign_id: string;
  node_id?: string;
  as_of?: string;
  records: CompactionLifecycleRecord[];
}

export interface CompactionGuardProjection {
  campaign_id: string;
  node_id: string;
  active: boolean;
  since: string | null;
}

export function isCompactionCommandEnvelope(input: unknown): input is CompactionCommandEnvelope {
  if (!record(input) || input.schema_version !== 1 || !record(input.metadata) || !record(input.command)) return false;
  return input.command.kind === "compaction.record";
}

export function isCompactionQueryEnvelope(input: unknown): input is CompactionQueryEnvelope {
  if (!record(input) || input.schema_version !== 1 || typeof input.query_id !== "string" || !record(input.query)) return false;
  return input.query.kind === "compaction.list" || input.query.kind === "compaction.guard";
}

export function validateCompactionCommand(envelope: CompactionCommandEnvelope): string[] {
  const failures: string[] = [];
  if (!text(envelope.metadata.operation_id) || !text(envelope.metadata.idempotency_key)
    || !text(envelope.metadata.correlation_id) || !text(envelope.metadata.actor_id)) failures.push("metadata identity fields are required");
  if (!text(envelope.command.campaign_id) || !text(envelope.command.node_id) || !record(envelope.command.lifecycle)) failures.push("campaign, node, and lifecycle are required");
  return failures;
}

export function validateCompactionQuery(envelope: CompactionQueryEnvelope): string[] {
  const query = envelope.query;
  const failures: string[] = [];
  if (!text(query.campaign_id)) failures.push("campaign_id is required");
  if (query.node_id !== undefined && !text(query.node_id)) failures.push("node_id must be non-empty when present");
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) failures.push("limit must be a positive integer when present");
  if (query.as_of !== undefined && Number.isNaN(Date.parse(query.as_of))) failures.push("as_of must be ISO-parseable when present");
  return failures;
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}