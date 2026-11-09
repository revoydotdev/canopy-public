import { createHash } from "node:crypto";
import { NATIVE_TOOL_RISK_MANIFEST } from "@arbor/core";
import type { NativeModelAdapterToolDefinition, NativeToolExecutionEvidence, NativeToolPort, NativeToolRequest, NativeToolResponse } from "@arbor/harness";
import type { NativePeerChannelService, NativePeerRelationshipGrant } from "./native-peer-channel.js";

export const NATIVE_PEER_TOOL_RISKS = NATIVE_TOOL_RISK_MANIFEST.peer;
type NativePeerToolName = keyof typeof NATIVE_PEER_TOOL_RISKS;

export interface NativePeerToolScope {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly session_id: string;
  readonly capability_tier: "specialist" | "critic" | "auditor" | "orchestrator";
}

type AdvertisedPeerPort = NativeToolPort & { readonly model_definition: NativeModelAdapterToolDefinition };

export function createNativePeerToolPorts(options: { readonly service: NativePeerChannelService; readonly scope: NativePeerToolScope; readonly now?: () => Date; readonly provision_from_parent?: boolean }): readonly AdvertisedPeerPort[] {
  if (options.provision_from_parent === true) options.service.provisionFromParentAuthority(options.scope.campaign_id, options.scope.node_id);
  const grants = options.service.list(options.scope.campaign_id).filter((grant) => grant.left_node_id === options.scope.node_id || grant.right_node_id === options.scope.node_id);
  if (grants.length === 0) return Object.freeze([]);
  const now = options.now ?? (() => new Date());
  const common = (tool: NativePeerToolName, description: string, parameters: Record<string, unknown>, effect: "read_only" | "external", execute: (request: NativeToolRequest, input: Record<string, unknown>) => NativeToolResponse | Promise<NativeToolResponse>): AdvertisedPeerPort => Object.freeze({
    tool,
    model_definition: Object.freeze({ name: tool, description, parameters: Object.freeze(parameters), risk: NATIVE_PEER_TOOL_RISKS[tool] }),
    recovery_protection: (request: NativeToolRequest) => Object.freeze({ effect_kind: effect, repeatable: effect === "read_only", idempotency_key_hash: effect === "read_only" ? null : `sha256:${createHash("sha256").update(request.call_id).digest("hex")}`, acknowledged_by: null }),
    preflight: (request: NativeToolRequest) => plain(request.input) ? Object.freeze({ allowed: true as const }) : Object.freeze({ allowed: false as const, code: "peer_invalid_input", reason: "peer tool input must be an object", evidence: evidence("refused", "peer_invalid_input", "none") }),
    execute: async (request: NativeToolRequest) => {
      if (request.session_id !== options.scope.session_id || !plain(request.input)) return response("peer_scope_denied", "session is outside the trusted peer scope", "refused", "none");
      try { return await execute(request, request.input); } catch (error) { return response("peer_tool_failed", error instanceof Error ? error.message : "peer tool failed", "failed", "unknown"); }
    },
  });
  const history = common("peer.history", "Read the durable causal history for one explicitly granted sibling channel.", objectSchema(["grant_id"], { grant_id: { type: "string", enum: grants.map((grant) => grant.grant_id) } }), "read_only", (_request, input) => {
    const grant = scopedGrant(grants, input.grant_id, options.scope.node_id);
    const value = options.service.history({ kind: "peer.history", grant_id: grant.grant_id, limit: 100 }, { kind: "peer", actor_id: options.scope.session_id, campaign_id: options.scope.campaign_id, node_id: options.scope.node_id, capability_tier: options.scope.capability_tier });
    return value === null ? response("peer_scope_denied", "grant is not readable", "refused", "none") : response("ok", JSON.stringify(value), "succeeded", "observed");
  });
  const ports: AdvertisedPeerPort[] = [history];
  if (grants.some((grant) => grant.capabilities.includes("query"))) ports.push(common("peer.query", "Ask one explicitly granted sibling a bounded durable question.", messageSchema(grants.filter((grant) => grant.capabilities.includes("query")), options.scope.node_id, false), "external", (request, input) => {
    const grant = scopedGrant(grants, input.grant_id, options.scope.node_id, "query"); const peer = peerFor(grant, options.scope.node_id, input.peer_node_id); const content = text(input.content, "content"); const expected = text(input.expected_version, "expected_version");
    const result = options.service.query({ kind: "peer.query", grant_id: grant.grant_id, query_id: request.call_id, from_node_id: options.scope.node_id, to_node_id: peer, expected_version: expected, content }, request.call_id, now().toISOString(), { kind: "peer", actor_id: options.scope.session_id, campaign_id: options.scope.campaign_id, node_id: options.scope.node_id, capability_tier: options.scope.capability_tier });
    return result.accepted ? response("ok", JSON.stringify(result), "succeeded", "applied") : response(result.code, result.reason, "refused", "none");
  }));
  if (grants.some((grant) => grant.capabilities.includes("reply"))) ports.push(common("peer.reply", "Reply to a durable sibling query under the existing relationship grant.", messageSchema(grants.filter((grant) => grant.capabilities.includes("reply")), options.scope.node_id, true), "external", (request, input) => {
    const grant = scopedGrant(grants, input.grant_id, options.scope.node_id, "reply"); const peer = peerFor(grant, options.scope.node_id, input.peer_node_id); const content = text(input.content, "content"); const expected = text(input.expected_version, "expected_version"); const query = text(input.query_message_id, "query_message_id");
    if (typeof input.agrees !== "boolean") throw new Error("agrees must be boolean");
    const result = options.service.reply({ kind: "peer.reply", grant_id: grant.grant_id, query_message_id: query, from_node_id: options.scope.node_id, to_node_id: peer, expected_version: expected, content, agrees: input.agrees }, request.call_id, now().toISOString(), { kind: "peer", actor_id: options.scope.session_id, campaign_id: options.scope.campaign_id, node_id: options.scope.node_id, capability_tier: options.scope.capability_tier });
    return result.accepted ? response("ok", JSON.stringify(result), "succeeded", "applied") : response(result.code, result.reason, "refused", "none");
  }));
  return Object.freeze(ports);
}

function scopedGrant(grants: readonly NativePeerRelationshipGrant[], id: unknown, node: string, capability?: "query" | "reply"): NativePeerRelationshipGrant { const grant = grants.find((item) => item.grant_id === id); if (!grant || grant.left_node_id !== node && grant.right_node_id !== node || capability && !grant.capabilities.includes(capability)) throw new Error("grant is outside the trusted peer scope"); return grant; }
function peerFor(grant: NativePeerRelationshipGrant, node: string, requested: unknown): string { const peer = grant.left_node_id === node ? grant.right_node_id : grant.left_node_id; if (requested !== peer) throw new Error("peer endpoint is outside the relationship grant"); return peer; }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, field: string): string { if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`); return value; }
function evidence(outcome: NativeToolExecutionEvidence["outcome"], code: string, effect: NativeToolExecutionEvidence["effect"]): NativeToolExecutionEvidence { return Object.freeze({ outcome, stage: "execution", code, effect, action_scope: Object.freeze({ status: "not_required" }) }); }
function response(code: string, output: string, outcome: NativeToolExecutionEvidence["outcome"], effect: NativeToolExecutionEvidence["effect"]): NativeToolResponse { return Object.freeze({ result_summary: code === "ok" ? "peer operation completed" : output, model_output: output, evidence: evidence(outcome, code, effect) }); }
function objectSchema(required: readonly string[], properties: Record<string, unknown>): Record<string, unknown> { return { type: "object", additionalProperties: false, required, properties }; }
function messageSchema(grants: readonly NativePeerRelationshipGrant[], node: string, reply: boolean): Record<string, unknown> { const properties: Record<string, unknown> = { grant_id: { type: "string", enum: grants.map((grant) => grant.grant_id) }, peer_node_id: { type: "string", enum: grants.map((grant) => grant.left_node_id === node ? grant.right_node_id : grant.left_node_id) }, expected_version: { type: "string" }, content: { type: "string", maxLength: Math.max(...grants.map((grant) => grant.max_disclosure_bytes)) } }; if (reply) { properties.query_message_id = { type: "string" }; properties.agrees = { type: "boolean" }; } return objectSchema(reply ? ["grant_id", "peer_node_id", "expected_version", "content", "query_message_id", "agrees"] : ["grant_id", "peer_node_id", "expected_version", "content"], properties); }
