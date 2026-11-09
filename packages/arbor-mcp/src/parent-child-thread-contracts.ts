import type { NodeCommunication } from "@arbor/audit";
import type { OperationMetadata, Provenance } from "@arbor/core";
import type { ParentChildThreadProjection } from "./conversation-bus.js";

/**
 * Canonical parent↔child conversation controls. They are deliberately a
 * narrow facade over the existing append-only NodeCommunication ledger, not a
 * second mailbox: durable delivery is the ledger append; acknowledgement is a
 * later ledger message naming the delivered record.
 */
export type ParentChildThreadSendCommand = {
  kind: "bus.thread.send";
  campaign_id: string;
  parent_node_id: string;
  child_node_id: string;
  from_node_id: string;
  /** Compare-and-swap cursor from the previous `bus.thread.history` result. */
  expected_thread_version: string;
  message_kind: NodeCommunication["kind"];
  /** Durable transport purpose; defaults to notify for legacy-compatible sends. */
  intent?: NodeCommunication["intent"];
  content: string;
  /** References only; bytes stay in the evidence store. */
  evidence_refs?: readonly string[];
  provenance: Provenance;
  capability_tier: NodeCommunication["capability_tier"];
  trigger_turn?: boolean;
  parent_communication_id?: string | null;
  acknowledges_communication_id?: string | null;
  retracts_communication_id?: string | null;
  /** Reply target in this exact direct thread; correlation must match its record. */
  reply_to_communication_id?: string | null;
  /** Require a durable acknowledgement from the recipient. */
  ack_required?: boolean;
  /** ISO deadline persisted in the ledger; history derives timeout from it. */
  deadline_at?: string | null;
};

/** Appends a durable acknowledgement; it never mutates an earlier ledger record. */
export type ParentChildThreadAckCommand = {
  kind: "bus.thread.ack";
  campaign_id: string;
  parent_node_id: string;
  child_node_id: string;
  from_node_id: string;
  expected_thread_version: string;
  message_id: string;
  provenance: Provenance;
  capability_tier: NodeCommunication["capability_tier"];
};

export type ParentChildThreadHistoryQuery = {
  kind: "bus.thread.history";
  campaign_id: string;
  parent_node_id: string;
  child_node_id: string;
  as_of?: string;
  limit?: number;
  tier?: NodeCommunication["capability_tier"];
};

export interface ParentChildThreadSendEnvelope {
  schema_version: 1;
  metadata: OperationMetadata;
  command: ParentChildThreadSendCommand;
}

export interface ParentChildThreadHistoryEnvelope {
  schema_version: 1;
  query_id: string;
  query: ParentChildThreadHistoryQuery;
}

export interface ParentChildThreadAckEnvelope {
  schema_version: 1;
  metadata: OperationMetadata;
  command: ParentChildThreadAckCommand;
}

export interface ParentChildThreadSendAcknowledgement {
  accepted: true;
  operation_id: string;
  message_id: string;
  thread_id: string;
  delivery: "durable";
}

export function isParentChildThreadSendEnvelope(input: unknown): input is ParentChildThreadSendEnvelope {
  return record(input) && input.schema_version === 1 && record(input.metadata) && record(input.command) && input.command.kind === "bus.thread.send";
}

export function isParentChildThreadHistoryEnvelope(input: unknown): input is ParentChildThreadHistoryEnvelope {
  return record(input) && input.schema_version === 1 && typeof input.query_id === "string" && record(input.query) && input.query.kind === "bus.thread.history";
}
export function isParentChildThreadAckEnvelope(input: unknown): input is ParentChildThreadAckEnvelope {
  return record(input) && input.schema_version === 1 && record(input.metadata) && record(input.command) && input.command.kind === "bus.thread.ack";
}

export function validateParentChildThreadSend(envelope: ParentChildThreadSendEnvelope): string[] {
  const { metadata, command } = envelope;
  const failures = identity(metadata as unknown as Record<string, unknown>, "metadata");
  for (const [name, value] of Object.entries({ campaign_id: command.campaign_id, parent_node_id: command.parent_node_id, child_node_id: command.child_node_id, from_node_id: command.from_node_id, expected_thread_version: command.expected_thread_version, content: command.content })) {
    if (!text(value)) failures.push(`${name} must be non-empty`);
  }
  // A node cannot be its own parent AND child. `bus.thread.history` rejects
  // that pair outright ("endpoints must be a direct parent and child in this
  // campaign"), but `send` accepted it and returned ok -- the write path
  // acknowledged a relationship the read path declares impossible, so the
  // record was logged to `operations/registry.json` and could never be
  // returned by the only query that would surface it (EC-014b; same asymmetry
  // as EC-013b -- outer shape validated, meaning not).
  if (text(command.parent_node_id) && command.parent_node_id === command.child_node_id) {
    failures.push("parent_node_id and child_node_id must be different nodes");
  }
  if (!record(command.provenance)) failures.push("provenance is required");
  if (command.evidence_refs !== undefined && (!Array.isArray(command.evidence_refs) || command.evidence_refs.length > 32 || command.evidence_refs.some((ref) => !text(ref)))) failures.push("evidence_refs must contain at most 32 non-empty references");
  if (!VALID_KINDS.has(command.message_kind)) failures.push("message_kind is invalid");
  if (command.intent !== undefined && !VALID_INTENTS.has(command.intent)) failures.push("intent is invalid");
  if (!VALID_TIERS.has(command.capability_tier)) failures.push("capability_tier is invalid");
  for (const [name, value] of Object.entries({ parent_communication_id: command.parent_communication_id, acknowledges_communication_id: command.acknowledges_communication_id, retracts_communication_id: command.retracts_communication_id, reply_to_communication_id: command.reply_to_communication_id })) {
    if (value !== undefined && value !== null && !text(value)) failures.push(`${name} must be non-empty when supplied`);
  }
  if (command.ack_required !== undefined && typeof command.ack_required !== "boolean") failures.push("ack_required must be boolean when supplied");
  if (command.deadline_at !== undefined && command.deadline_at !== null && (!text(command.deadline_at) || Number.isNaN(Date.parse(command.deadline_at)))) failures.push("deadline_at must be ISO-parseable when supplied");
  return failures;
}

export function validateParentChildThreadAck(envelope: ParentChildThreadAckEnvelope): string[] {
  const { metadata, command } = envelope;
  const failures = identity(metadata as unknown as Record<string, unknown>, "metadata");
  for (const [name, value] of Object.entries({ campaign_id: command.campaign_id, parent_node_id: command.parent_node_id, child_node_id: command.child_node_id, from_node_id: command.from_node_id, expected_thread_version: command.expected_thread_version, message_id: command.message_id })) {
    if (!text(value)) failures.push(`${name} must be non-empty`);
  }
  if (!record(command.provenance)) failures.push("provenance is required");
  if (!VALID_TIERS.has(command.capability_tier)) failures.push("capability_tier is invalid");
  return failures;
}

export function validateParentChildThreadHistory(envelope: ParentChildThreadHistoryEnvelope): string[] {
  const query = envelope.query;
  const failures = !text(envelope.query_id) ? ["query_id must be non-empty"] : [];
  for (const [name, value] of Object.entries({ campaign_id: query.campaign_id, parent_node_id: query.parent_node_id, child_node_id: query.child_node_id })) {
    if (!text(value)) failures.push(`${name} must be non-empty`);
  }
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000)) failures.push("limit must be an integer from 1 through 1000");
  if (query.as_of !== undefined && Number.isNaN(Date.parse(query.as_of))) failures.push("as_of must be ISO-parseable");
  return failures;
}

export type ParentChildThreadHistoryProjection = ParentChildThreadProjection;

const VALID_KINDS = new Set<NodeCommunication["kind"]>(["delegate", "report", "retract", "steer", "reply", "clarify", "promote"]);
const VALID_INTENTS = new Set<NonNullable<NodeCommunication["intent"]>>(["request", "response", "notify", "needs_attention"]);
const VALID_TIERS = new Set<NodeCommunication["capability_tier"]>(["specialist", "critic", "auditor", "orchestrator"]);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function identity(value: Record<string, unknown>, label: string): string[] {
  return ["operation_id", "idempotency_key", "correlation_id", "actor_id"].flatMap((key) => text(value[key]) ? [] : [`${label}.${key} must be non-empty`]);
}
