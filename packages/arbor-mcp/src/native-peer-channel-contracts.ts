import type { Provenance } from "@arbor/core";

export type NativePeerCapabilityTier = "specialist" | "critic" | "auditor" | "orchestrator";
export type NativePeerCapability = "query" | "reply";

/**
 * Identity established by the composing transport, never by a peer request.
 * A parent may create relationships and inspect its children; a peer may only
 * act as itself within one campaign.
 */
export type NativePeerTrustedCaller =
  | Readonly<{ readonly kind: "parent"; readonly actor_id: string; readonly campaign_id: string; readonly node_id: string; readonly capability_tier: "orchestrator" }>
  | Readonly<{ readonly kind: "peer"; readonly actor_id: string; readonly campaign_id: string; readonly node_id: string; readonly capability_tier: NativePeerCapabilityTier }>;

export interface NativePeerGrantCommand {
  readonly kind: "peer.grant";
  readonly grant_id: string;
  readonly campaign_id: string;
  readonly parent_node_id: string;
  readonly left_node_id: string;
  readonly right_node_id: string;
  readonly capabilities: readonly NativePeerCapability[];
  readonly capability_tier: NativePeerCapabilityTier;
  readonly max_disclosure_bytes: number;
  readonly expires_at: string;
  readonly provenance: Provenance;
}
export interface NativePeerQueryCommand {
  readonly kind: "peer.query";
  readonly grant_id: string;
  readonly query_id: string;
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly expected_version: string;
  readonly content: string;
}
export interface NativePeerReplyCommand {
  readonly kind: "peer.reply";
  readonly grant_id: string;
  readonly query_message_id: string;
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly expected_version: string;
  readonly content: string;
  readonly agrees: boolean;
}
export type NativePeerCommand = NativePeerGrantCommand | NativePeerQueryCommand | NativePeerReplyCommand;

export interface NativePeerHistoryQuery {
  readonly kind: "peer.history";
  readonly grant_id: string;
  readonly limit?: number;
}
export interface NativePeerGrantListQuery { readonly kind: "peer.grants"; readonly campaign_id?: string; }
export type NativePeerQuery = NativePeerHistoryQuery | NativePeerGrantListQuery;

export interface NativePeerCommandEnvelope {
  readonly schema_version: 1;
  readonly metadata: { readonly operation_id: string; readonly idempotency_key: string; readonly correlation_id: string; readonly actor_id: string; readonly requested_at: string };
  readonly command: NativePeerCommand;
}
export interface NativePeerQueryEnvelope { readonly schema_version: 1; readonly query_id: string; readonly query: NativePeerQuery; }

const COMMANDS = new Set(["peer.grant", "peer.query", "peer.reply"]);
const QUERIES = new Set(["peer.history", "peer.grants"]);
export function isNativePeerCommandEnvelope(value: unknown): value is NativePeerCommandEnvelope {
  return record(value) && value.schema_version === 1 && record(value.metadata) && record(value.command) && typeof value.command.kind === "string" && COMMANDS.has(value.command.kind);
}
export function isNativePeerQueryEnvelope(value: unknown): value is NativePeerQueryEnvelope {
  return record(value) && value.schema_version === 1 && typeof value.query_id === "string" && record(value.query) && typeof value.query.kind === "string" && QUERIES.has(value.query.kind);
}

export function validateNativePeerCommand(envelope: NativePeerCommandEnvelope): readonly string[] {
  const failures = validateMetadata(envelope.metadata);
  const command = envelope.command;
  if (command.kind === "peer.grant") {
    exact(command, ["kind", "grant_id", "campaign_id", "parent_node_id", "left_node_id", "right_node_id", "capabilities", "capability_tier", "max_disclosure_bytes", "expires_at", "provenance"], failures);
    for (const [field, value] of [["grant_id", command.grant_id], ["campaign_id", command.campaign_id], ["parent_node_id", command.parent_node_id], ["left_node_id", command.left_node_id], ["right_node_id", command.right_node_id]] as const) if (!id(value)) failures.push(`${field} is invalid`);
    if (command.left_node_id === command.right_node_id) failures.push("peer endpoints must be distinct");
    if (!Array.isArray(command.capabilities) || command.capabilities.length === 0 || command.capabilities.length > 2 || new Set(command.capabilities).size !== command.capabilities.length || command.capabilities.some((item) => item !== "query" && item !== "reply")) failures.push("capabilities must be a unique non-empty query/reply subset");
    if (!tier(command.capability_tier)) failures.push("capability_tier is invalid");
    if (!Number.isSafeInteger(command.max_disclosure_bytes) || command.max_disclosure_bytes < 1 || command.max_disclosure_bytes > 16_384) failures.push("max_disclosure_bytes must be from 1 to 16384");
    if (!iso(command.expires_at)) failures.push("expires_at must be ISO-parseable");
    if (!validProvenance(command.provenance)) failures.push("provenance must be a complete supported provenance record");
  } else if (command.kind === "peer.query") {
    exact(command, ["kind", "grant_id", "query_id", "from_node_id", "to_node_id", "expected_version", "content"], failures);
    validateMessage(command, failures); if (!id(command.query_id)) failures.push("query_id is invalid");
  } else {
    exact(command, ["kind", "grant_id", "query_message_id", "from_node_id", "to_node_id", "expected_version", "content", "agrees"], failures);
    validateMessage(command, failures); if (!id(command.query_message_id)) failures.push("query_message_id is invalid"); if (typeof command.agrees !== "boolean") failures.push("agrees must be boolean");
  }
  return failures;
}

export function validateNativePeerQuery(envelope: NativePeerQueryEnvelope): readonly string[] {
  const failures: string[] = [];
  if (!id(envelope.query_id)) failures.push("query_id is invalid");
  if (envelope.query.kind === "peer.history") {
    exact(envelope.query, ["kind", "grant_id", ...(envelope.query.limit === undefined ? [] : ["limit"])], failures);
    if (!id(envelope.query.grant_id)) failures.push("grant_id is required");
    if (envelope.query.limit !== undefined && (!Number.isSafeInteger(envelope.query.limit) || envelope.query.limit < 1 || envelope.query.limit > 500)) failures.push("limit must be from 1 to 500");
  } else {
    exact(envelope.query, ["kind", ...(envelope.query.campaign_id === undefined ? [] : ["campaign_id"])], failures);
    if (envelope.query.campaign_id !== undefined && !id(envelope.query.campaign_id)) failures.push("campaign_id is invalid");
  }
  return failures;
}

function validateMetadata(value: NativePeerCommandEnvelope["metadata"]): string[] {
  const failures: string[] = [];
  exact(value, ["operation_id", "idempotency_key", "correlation_id", "actor_id", "requested_at"], failures);
  for (const [field, item] of Object.entries(value)) if (field !== "requested_at" && !id(String(item))) failures.push(`${field} is invalid`);
  if (!iso(value.requested_at)) failures.push("requested_at must be ISO-parseable");
  return failures;
}
function validateMessage(command: NativePeerQueryCommand | NativePeerReplyCommand, failures: string[]): void {
  if (!id(command.grant_id) || !id(command.from_node_id) || !id(command.to_node_id) || !id(command.expected_version)) failures.push("peer message identity is invalid");
  if (command.from_node_id === command.to_node_id) failures.push("peer message endpoints must be distinct");
  if (typeof command.content !== "string" || command.content.trim().length === 0 || Buffer.byteLength(command.content, "utf8") > 16_384) failures.push("content is empty or oversized");
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function id(value: string): boolean { return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value); }
function iso(value: string): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function tier(value: unknown): value is NativePeerCapabilityTier { return value === "specialist" || value === "critic" || value === "auditor" || value === "orchestrator"; }
function validProvenance(value: unknown): value is Provenance {
  if (!record(value)) return false;
  if (value.tag === "generated") return typeof value.generator === "string" && value.generator.length > 0 && typeof value.input_hash === "string" && value.input_hash.length > 0;
  if (value.tag === "claimed") return typeof value.claimant === "string" && value.claimant.length > 0;
  if (value.tag === "verified") return typeof value.cmd === "string" && value.cmd.length > 0 && Number.isSafeInteger(value.exit) && typeof value.stdout_hash === "string" && value.stdout_hash.length > 0;
  if (value.tag === "critic_approved") return typeof value.critic === "string" && value.critic.length > 0 && typeof value.rationale === "string" && value.rationale.length > 0;
  return false;
}
function exact(value: object, keys: readonly string[], failures: string[]): void { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) failures.push("object contains missing or unsupported fields"); }
