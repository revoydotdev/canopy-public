/**
 * Runtime catalog contract for the operator-facing conversation bus
 * (`bus.record` / `bus.history`, Phase 4D.1/4D.2 — G-29).
 *
 * These are a thin conversation-scoped view over the same
 * `NodeCommunication` ledger that `communication.record`/`communication.*`
 * already project — `recordBusMessage`/`getConversationBus` on
 * `CampaignManager` are the real, previously-untested-only backends this
 * wires up. Mirrors the `communication-contracts.ts` shape deliberately:
 * `@arbor/core`'s closed `ApplicationCommand`/`ApplicationQuery` unions
 * cannot express this payload (it needs `@arbor/audit`'s `NodeCommunication`
 * type, and core must import nothing upward), so — exactly like every other
 * non-lifecycle catalog kind — the envelope contract lives here in
 * `@arbor/mcp`, not in core.
 */
import type { NodeCommunication } from "@arbor/audit";
import type { OperationMetadata } from "@arbor/core";
import type { ConversationBusProjection } from "./conversation-bus.js";

export type BusCommand = {
  kind: "bus.record";
  campaign_id: string;
  node_id: string;
  communication: NodeCommunication & { conversation_id: string };
};

export type BusQuery = {
  kind: "bus.history";
  campaign_id: string;
  as_of?: string;
  limit?: number;
  conversation_id?: string;
  tier?: NodeCommunication["capability_tier"];
};

export interface BusCommandEnvelope {
  schema_version: 1;
  metadata: OperationMetadata;
  command: BusCommand;
}

export interface BusQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: BusQuery;
}

export type BusHistoryProjection = ConversationBusProjection;

export function isBusCommandEnvelope(input: unknown): input is BusCommandEnvelope {
  if (!record(input) || input.schema_version !== 1 || !record(input.metadata) || !record(input.command)) return false;
  return input.command.kind === "bus.record";
}

export function isBusQueryEnvelope(input: unknown): input is BusQueryEnvelope {
  if (!record(input) || input.schema_version !== 1 || typeof input.query_id !== "string" || !record(input.query)) return false;
  return input.query.kind === "bus.history";
}

export function validateBusCommand(envelope: BusCommandEnvelope): string[] {
  const failures: string[] = [];
  if (!text(envelope.metadata.operation_id) || !text(envelope.metadata.idempotency_key)
    || !text(envelope.metadata.correlation_id) || !text(envelope.metadata.actor_id)) failures.push("metadata identity fields are required");
  if (!text(envelope.command.campaign_id) || !text(envelope.command.node_id) || !record(envelope.command.communication)) {
    failures.push("campaign, node, and communication are required");
  } else if (!text(envelope.command.communication.conversation_id)) {
    failures.push("bus messages require a non-empty conversation_id");
  }
  return failures;
}

export function validateBusQuery(envelope: BusQueryEnvelope): string[] {
  const query = envelope.query;
  const failures: string[] = [];
  if (!text(query.campaign_id)) failures.push("campaign_id is required");
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000)) failures.push("limit must be an integer from 1 through 1000");
  if (query.as_of !== undefined && Number.isNaN(Date.parse(query.as_of))) failures.push("as_of checkpoint must be ISO-parseable");
  if (query.conversation_id !== undefined && !text(query.conversation_id)) failures.push("conversation_id must be non-empty when present");
  return failures;
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
