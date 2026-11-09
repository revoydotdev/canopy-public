import type { NodeCommunication, NodeCommunicationRecord } from "@arbor/audit";
import type { OperationMetadata } from "@arbor/core";

export type CommunicationCommand = {
  kind: "communication.record";
  campaign_id: string;
  node_id: string;
  communication: NodeCommunication;
};

export type CommunicationQuery = {
  kind: "communication.selection" | "communication.history";
  campaign_id: string;
  node_id: string;
  limit: number;
  as_of?: string;
};

export interface CommunicationCommandEnvelope {
  schema_version: 1;
  metadata: OperationMetadata;
  command: CommunicationCommand;
}

export interface CommunicationQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: CommunicationQuery;
}

export interface CommunicationProjection {
  campaign_id: string;
  node_id: string;
  as_of: string;
  /**
   * The capability tier this projection was BUILT for. ADR-005 places gating
   * at the envelope-construction layer, so a consumer renders what it was
   * given rather than re-deriving access; carrying the tier lets a view state
   * what it is showing without guessing a default. Absent it, the
   * Communications screen fell back to "no tier" and redacted every message.
   */
  consumer_tier: NodeCommunication["capability_tier"];
  communications: NodeCommunicationRecord[];
}

export function isCommunicationCommandEnvelope(input: unknown): input is CommunicationCommandEnvelope {
  if (!record(input) || input.schema_version !== 1 || !record(input.metadata) || !record(input.command)) return false;
  return input.command.kind === "communication.record";
}

export function isCommunicationQueryEnvelope(input: unknown): input is CommunicationQueryEnvelope {
  if (!record(input) || input.schema_version !== 1 || typeof input.query_id !== "string" || !record(input.query)) return false;
  return input.query.kind === "communication.selection" || input.query.kind === "communication.history";
}

export function validateCommunicationCommand(envelope: CommunicationCommandEnvelope): string[] {
  const failures: string[] = [];
  if (!text(envelope.metadata.operation_id) || !text(envelope.metadata.idempotency_key)
    || !text(envelope.metadata.correlation_id) || !text(envelope.metadata.actor_id)) failures.push("metadata identity fields are required");
  if (!text(envelope.command.campaign_id) || !text(envelope.command.node_id) || !record(envelope.command.communication)) failures.push("campaign, node, and communication are required");
  return failures;
}

export function validateCommunicationQuery(envelope: CommunicationQueryEnvelope): string[] {
  const query = envelope.query;
  const failures: string[] = [];
  if (!text(query.campaign_id) || !text(query.node_id)) failures.push("campaign_id and node_id are required");
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) failures.push("limit must be an integer from 1 through 100");
  if (query.as_of !== undefined && Number.isNaN(Date.parse(query.as_of))) failures.push("as_of checkpoint must be ISO-parseable");
  return failures;
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
