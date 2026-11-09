/**
 * Runtime catalog dispatch contract for `a2a.send` / `a2a.receive`
 * (Phase 4D.6 — G-29).
 *
 * `a2a-contracts.ts` (wire types + validators) and `a2a-bridge.ts`
 * (inbound/outbound conversion to/from `NodeCommunication`) already exist
 * and are unit-tested, but nothing wired them to the runtime catalog router.
 * This file is that missing envelope contract: `a2a.send` records an
 * outbound `NodeCommunication` and projects it to the A2A wire format for
 * delivery; `a2a.receive` converts an inbound A2A message to a
 * `NodeCommunication` and durably records it. Both need `@arbor/audit`'s
 * `NodeCommunication` type, which `@arbor/core` must not import — so, like
 * every other non-lifecycle catalog kind, the envelope lives here in
 * `@arbor/mcp`, not in core's closed command/query unions.
 */
import type { NodeCommunication } from "@arbor/audit";
import type { CommandAcknowledgement, OperationMetadata } from "@arbor/core";
import { isA2AMessage, validateA2AMessage, type A2AMessage } from "./a2a-contracts.js";

export type A2ASendCommand = {
  kind: "a2a.send";
  campaign_id: string;
  node_id: string;
  communication: NodeCommunication;
};

export type A2AReceiveCommand = {
  kind: "a2a.receive";
  campaign_id: string;
  node_id: string;
  message: A2AMessage;
  /**
   * The inbound message in A2A v1.0.0's real wire format, when the peer speaks
   * the protocol rather than revoy2's internal DTO. Optional and additive:
   * `message` remains required so every existing caller and assertion is
   * unchanged, and when `wire` is present it is authoritative for message
   * CONTENT only — never for task state, which stays derived from
   * ledger-witnessed records.
   */
  wire?: import("./a2a-wire.js").WireMessage;
};

export interface A2ASendCommandEnvelope {
  schema_version: 1;
  metadata: OperationMetadata;
  command: A2ASendCommand;
}

export interface A2AReceiveCommandEnvelope {
  schema_version: 1;
  metadata: OperationMetadata;
  command: A2AReceiveCommand;
}

export type A2ASendAcknowledgement = Extract<CommandAcknowledgement, { accepted: true }> & {
  message: A2AMessage;
  /**
   * The same message rendered in A2A v1.0.0's actual wire format, so a
   * transport can emit it without a second translation step. Optional so every
   * pre-existing assertion over `message` keeps passing unmodified.
   */
  wire?: import("./a2a-wire.js").WireMessage;
  /** The ledger-derived task, in v1.0.0 shape, when one was derived. */
  wire_task?: import("./a2a-wire.js").WireTask;
};

export function isA2ASendCommandEnvelope(input: unknown): input is A2ASendCommandEnvelope {
  if (!record(input) || input.schema_version !== 1 || !record(input.metadata) || !record(input.command)) return false;
  return input.command.kind === "a2a.send";
}

export function isA2AReceiveCommandEnvelope(input: unknown): input is A2AReceiveCommandEnvelope {
  if (!record(input) || input.schema_version !== 1 || !record(input.metadata) || !record(input.command)) return false;
  return input.command.kind === "a2a.receive";
}

export function validateA2ASendCommand(envelope: A2ASendCommandEnvelope): string[] {
  const failures: string[] = [];
  if (!text(envelope.metadata.operation_id) || !text(envelope.metadata.idempotency_key)
    || !text(envelope.metadata.correlation_id) || !text(envelope.metadata.actor_id)) failures.push("metadata identity fields are required");
  if (!text(envelope.command.campaign_id) || !text(envelope.command.node_id) || !record(envelope.command.communication)) {
    failures.push("campaign, node, and communication are required");
  }
  return failures;
}

export function validateA2AReceiveCommand(envelope: A2AReceiveCommandEnvelope): string[] {
  const failures: string[] = [];
  if (!text(envelope.metadata.operation_id) || !text(envelope.metadata.idempotency_key)
    || !text(envelope.metadata.correlation_id) || !text(envelope.metadata.actor_id)) failures.push("metadata identity fields are required");
  if (!text(envelope.command.campaign_id) || !text(envelope.command.node_id)) failures.push("campaign_id and node_id are required");
  if (!isA2AMessage(envelope.command.message)) failures.push("a well-formed A2A message is required");
  else failures.push(...validateA2AMessage(envelope.command.message));
  return failures;
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
