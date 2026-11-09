/**
 * Narrow A2A v1 direct-thread interoperability profile.
 *
 * This is an in-process adapter over `RemoteRuntimeIngress`, not an HTTP,
 * JSON-RPC, SSE, or public A2A endpoint. A host must supply the existing
 * authenticated ingress explicitly; when it does not, every operation returns
 * a typed unavailable result rather than pretending an Agent Card is
 * discoverable or a message is deliverable.
 */
import type { NodeCommunication } from "@arbor/audit";
import type { NodeCard } from "@arbor/core";
import { messageFromWire, type WireAgentCard, type WireMessage } from "./a2a-wire.js";
import { publishNodeCardAsA2A, type A2ABridgeConfig } from "./a2a-bridge.js";
import { RemoteRuntimeIngress } from "./remote-ingress.js";
import type { RemoteSessionProof } from "./remote-session.js";

export const A2A_DIRECT_THREAD_PROFILE_ID = "arbor.dev/a2a/direct-thread/v1";
export const A2A_DIRECT_THREAD_A2A_VERSION = "1.0.0";

export interface A2ADirectThreadTask {
  readonly task_id: string;
  readonly campaign_id: string;
  readonly parent_node_id: string;
  readonly child_node_id: string;
}

export interface A2ADirectThreadProfileCard {
  readonly profile_id: typeof A2A_DIRECT_THREAD_PROFILE_ID;
  readonly a2a_version: typeof A2A_DIRECT_THREAD_A2A_VERSION;
  /** This profile can only be handed to an already-configured host adapter. */
  readonly transport: "host_composed_no_listener";
  readonly authentication: {
    readonly scheme: "arbor.remote-session.ed25519";
    readonly per_operation_proof: true;
    readonly direct_edge_authorization: true;
  };
  /** The A2A card projection; its HMAC signature is card integrity, not request authentication. */
  readonly card: WireAgentCard;
}

export interface A2ADirectThreadSendInput {
  readonly profile_id: typeof A2A_DIRECT_THREAD_PROFILE_ID;
  readonly a2a_version: typeof A2A_DIRECT_THREAD_A2A_VERSION;
  readonly task: A2ADirectThreadTask;
  /** Authenticated remote principal; distinct from the tree-node endpoint. */
  readonly actor_id: string;
  readonly wire: WireMessage;
  readonly from_node_id: string;
  readonly expected_thread_version: string;
  readonly message_kind: NodeCommunication["kind"];
  readonly intent?: NodeCommunication["intent"];
  readonly ack_required?: boolean;
}

export interface A2ADirectThreadAckInput {
  readonly profile_id: typeof A2A_DIRECT_THREAD_PROFILE_ID;
  readonly a2a_version: typeof A2A_DIRECT_THREAD_A2A_VERSION;
  readonly task: A2ADirectThreadTask;
  /** Authenticated remote principal; distinct from the tree-node endpoint. */
  readonly actor_id: string;
  readonly from_node_id: string;
  readonly expected_thread_version: string;
  readonly message_id: string;
}

type PreparedEnvelope = {
  readonly envelope: { schema_version: 1; metadata: Record<string, string>; command: Record<string, unknown> };
  readonly signing: { kind: string; metadata: Record<string, unknown>; params: Record<string, unknown> };
};

export type A2ADirectThreadProfileResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: "unavailable" | "validation" | "scope_isolation" | "dispatch_refused"; readonly detail: string; readonly result?: unknown };

/**
 * Host-composed A2A profile surface. The remote ingress remains the sole
 * authority for proof integrity, replay, key lifecycle, and exact direct-edge
 * authorization; this adapter only translates a strict interoperable subset.
 */
export class A2ADirectThreadProfileAdapter {
  constructor(private readonly ingress: RemoteRuntimeIngress | null) {}

  agentCard(nodeCard: NodeCard, config: A2ABridgeConfig): A2ADirectThreadProfileResult<A2ADirectThreadProfileCard> {
    if (this.ingress === null) return unavailable();
    return {
      ok: true,
      value: {
        profile_id: A2A_DIRECT_THREAD_PROFILE_ID,
        a2a_version: A2A_DIRECT_THREAD_A2A_VERSION,
        transport: "host_composed_no_listener",
        authentication: { scheme: "arbor.remote-session.ed25519", per_operation_proof: true, direct_edge_authorization: true },
        card: publishNodeCardAsA2A(nodeCard, config).wire,
      },
    };
  }

  prepareSend(input: A2ADirectThreadSendInput): A2ADirectThreadProfileResult<PreparedEnvelope> {
    const normalized = normalizeSend(input);
    if (!normalized.ok) return normalized;
    return { ok: true, value: preparedSend(normalized.value) };
  }

  async deliverSend(input: A2ADirectThreadSendInput, proof: RemoteSessionProof): Promise<A2ADirectThreadProfileResult<unknown>> {
    if (this.ingress === null) return unavailable();
    const prepared = this.prepareSend(input);
    if (!prepared.ok) return prepared;
    const result = await this.ingress.dispatch({ ...prepared.value.envelope, metadata: { ...prepared.value.envelope.metadata, remote_session_proof: proof } });
    return result.ok ? { ok: true, value: result.value } : { ok: false, code: "dispatch_refused", detail: result.error.summary, result };
  }

  prepareAck(input: A2ADirectThreadAckInput): A2ADirectThreadProfileResult<PreparedEnvelope> {
    const failure = validateTaskAndEndpoint(input.profile_id, input.a2a_version, input.task, input.actor_id, input.from_node_id, input.expected_thread_version);
    if (failure !== null) return failure;
    if (!text(input.message_id)) return validation("message_id must be non-empty");
    const metadata = metadataFor(`ack:${input.task.task_id}:${input.message_id}`, input.actor_id);
    const command = {
      kind: "bus.thread.ack",
      campaign_id: input.task.campaign_id,
      parent_node_id: input.task.parent_node_id,
      child_node_id: input.task.child_node_id,
      from_node_id: input.from_node_id,
      expected_thread_version: input.expected_thread_version,
      message_id: input.message_id,
      provenance: { tag: "claimed", claimant: input.from_node_id },
      capability_tier: "specialist",
    };
    return { ok: true, value: prepared(metadata, command) };
  }

  async deliverAck(input: A2ADirectThreadAckInput, proof: RemoteSessionProof): Promise<A2ADirectThreadProfileResult<unknown>> {
    if (this.ingress === null) return unavailable();
    const preparedAck = this.prepareAck(input);
    if (!preparedAck.ok) return preparedAck;
    const result = await this.ingress.dispatch({ ...preparedAck.value.envelope, metadata: { ...preparedAck.value.envelope.metadata, remote_session_proof: proof } });
    return result.ok ? { ok: true, value: result.value } : { ok: false, code: "dispatch_refused", detail: result.error.summary, result };
  }
}

export function createA2ADirectThreadProfileAdapter(ingress?: RemoteRuntimeIngress): A2ADirectThreadProfileAdapter {
  return new A2ADirectThreadProfileAdapter(ingress ?? null);
}

type NormalizedSend = {
  readonly task: A2ADirectThreadTask;
  readonly actor_id: string;
  readonly from_node_id: string;
  readonly expected_thread_version: string;
  readonly message_kind: NodeCommunication["kind"];
  readonly intent?: NodeCommunication["intent"];
  readonly ack_required?: boolean;
  readonly message_id: string;
  readonly content: string;
  readonly evidence_refs: readonly string[];
};

function normalizeSend(input: A2ADirectThreadSendInput): A2ADirectThreadProfileResult<NormalizedSend> {
  const taskFailure = validateTaskAndEndpoint(input.profile_id, input.a2a_version, input.task, input.actor_id, input.from_node_id, input.expected_thread_version);
  if (taskFailure !== null) return taskFailure;
  if (input.wire.role !== "ROLE_AGENT") return validation("wire.role must be ROLE_AGENT for this agent-to-agent profile");
  if (!text(input.wire.messageId) || input.wire.taskId !== input.task.task_id) return validation("wire.messageId must be non-empty and wire.taskId must equal task.task_id");
  if (input.wire.contextId !== undefined && input.wire.contextId !== input.task.task_id) return validation("wire.contextId must equal task.task_id when supplied");
  if (!Array.isArray(input.wire.parts) || input.wire.parts.length < 1 || input.wire.parts.length > 32) return validation("wire.parts must contain from 1 through 32 supported parts");
  const other = input.from_node_id === input.task.parent_node_id ? input.task.child_node_id : input.task.parent_node_id;
  const meta = input.wire.metadata ?? {};
  if (meta["arbor.dev/author-node-ref"] !== undefined && meta["arbor.dev/author-node-ref"] !== input.from_node_id) return scope("wire author declaration does not match direct-thread author");
  const declaredRecipients = meta["arbor.dev/recipient-node-refs"];
  if (declaredRecipients !== undefined && (!Array.isArray(declaredRecipients) || declaredRecipients.length !== 1 || declaredRecipients[0] !== other)) return scope("wire recipient declaration must name only the opposite direct-thread endpoint");
  const converted = messageFromWire(input.wire, { author_node_ref: input.from_node_id, as_of: "1970-01-01T00:00:00.000Z" });
  const textParts = converted.parts.filter((part) => part.kind === "text").map((part) => part.text ?? "");
  const evidenceRefs = converted.parts.filter((part) => part.kind === "evidence_ref").map((part) => part.evidence_ref ?? "");
  if (textParts.length !== 1 || !text(textParts[0]) || Buffer.byteLength(textParts[0]!, "utf8") > 4096) return validation("wire must contain exactly one non-empty text part of at most 4096 bytes");
  if (evidenceRefs.some((ref) => !text(ref)) || evidenceRefs.length > 32) return validation("wire evidence references must be non-empty and bounded");
  return { ok: true, value: { task: input.task, actor_id: input.actor_id, from_node_id: input.from_node_id, expected_thread_version: input.expected_thread_version, message_kind: input.message_kind, ...(input.intent === undefined ? {} : { intent: input.intent }), ...(input.ack_required === undefined ? {} : { ack_required: input.ack_required }), message_id: input.wire.messageId, content: textParts[0]!, evidence_refs: evidenceRefs } };
}

function preparedSend(input: NormalizedSend): PreparedEnvelope {
  const metadata = metadataFor(`message:${input.task.task_id}:${input.message_id}`, input.actor_id);
  const command = {
    kind: "bus.thread.send",
    campaign_id: input.task.campaign_id,
    parent_node_id: input.task.parent_node_id,
    child_node_id: input.task.child_node_id,
    from_node_id: input.from_node_id,
    expected_thread_version: input.expected_thread_version,
    message_kind: input.message_kind,
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    content: input.content,
    ...(input.evidence_refs.length === 0 ? {} : { evidence_refs: input.evidence_refs }),
    ...(input.ack_required === undefined ? {} : { ack_required: input.ack_required }),
    provenance: { tag: "claimed", claimant: input.from_node_id },
    capability_tier: "specialist",
  };
  return prepared(metadata, command);
}

function prepared(metadata: Record<string, string>, command: Record<string, unknown>): PreparedEnvelope {
  const { kind, ...params } = command;
  return { envelope: { schema_version: 1, metadata, command }, signing: { kind: kind as string, metadata, params } };
}

function metadataFor(identity: string, actor_id: string): Record<string, string> {
  const stem = `a2a-direct:${identity}`;
  return { operation_id: stem, idempotency_key: stem, correlation_id: stem, actor_id, requested_at: "2026-08-08T00:00:00.000Z" };
}

function validateTaskAndEndpoint(profile: string, version: string, task: A2ADirectThreadTask, actor: string, from: string, expectedVersion: string): A2ADirectThreadProfileResult<never> | null {
  if (profile !== A2A_DIRECT_THREAD_PROFILE_ID) return validation(`profile_id must be ${A2A_DIRECT_THREAD_PROFILE_ID}`);
  if (version !== A2A_DIRECT_THREAD_A2A_VERSION) return validation(`a2a_version must be ${A2A_DIRECT_THREAD_A2A_VERSION}`);
  if (!text(task.task_id) || !text(task.campaign_id) || !text(task.parent_node_id) || !text(task.child_node_id) || task.parent_node_id === task.child_node_id) return validation("task must contain bounded campaign and distinct parent/child identities");
  if (!text(actor)) return validation("actor_id must be non-empty");
  if (!text(from) || (from !== task.parent_node_id && from !== task.child_node_id)) return scope("from_node_id must be one endpoint of the direct thread");
  if (!text(expectedVersion)) return validation("expected_thread_version must be non-empty");
  return null;
}

function unavailable(): A2ADirectThreadProfileResult<never> { return { ok: false, code: "unavailable", detail: "A2A direct-thread profile adapter is not configured; no public transport is available" }; }
function validation(detail: string): A2ADirectThreadProfileResult<never> { return { ok: false, code: "validation", detail }; }
function scope(detail: string): A2ADirectThreadProfileResult<never> { return { ok: false, code: "scope_isolation", detail }; }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 4096; }
