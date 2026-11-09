import type { ApprovalRequestEnvelope } from "./approval-contracts.js";
import { createHash } from "node:crypto";
import type { ParentChildThreadAckEnvelope, ParentChildThreadSendEnvelope } from "./parent-child-thread-contracts.js";
import type { AuthenticatedApprovalIdentity, RuntimeCatalogRouter, RuntimeRouterResult } from "./runtime-catalog.js";
import { RemoteSessionAuthority, type RemoteSessionProof, type RemoteThreadAudience } from "./remote-session.js";
import {
  remoteTransportSigningEnvelope,
  canonicalizeRemoteTransportSigningEnvelope,
  validateRemoteTransportEnvelope,
  type RemoteTransportEnvelope,
  type RemoteTransportErrorCode,
} from "./remote-transport-contracts.js";

type RemoteThreadEnvelope = ParentChildThreadSendEnvelope | ParentChildThreadAckEnvelope;
type RemoteApprovalEnvelope = ApprovalRequestEnvelope;

/**
 * Narrow, opt-in ingress for authenticated remote direct-thread and approval
 * commands. It intentionally is neither an HTTP server nor an A2A/SSE adapter:
 * a host transport must call this boundary after it has received bytes.
 */
export class RemoteRuntimeIngress {
  constructor(private readonly router: RuntimeCatalogRouter, private readonly authority: RemoteSessionAuthority) {}

  async dispatch(input: unknown): Promise<RuntimeRouterResult<unknown>> {
    if (!record(input) || !record(input.metadata) || !record(input.command)) return failure("remote command envelope is required");
    const command = input.command;
    if (command.kind === "bus.thread.send" || command.kind === "bus.thread.ack") return this.dispatchThread(input as unknown as RemoteThreadEnvelope);
    if (command.kind === "approval.request" || command.kind === "approval.approve" || command.kind === "approval.reject") return this.dispatchApproval(input as unknown as RemoteApprovalEnvelope);
    return failure("remote ingress only supports direct-thread send/ack and approval request/decision commands");
  }

  /**
   * ADR-041 ingress for an explicitly composed local host. This consumes the
   * nonce before router dispatch and therefore before catalog idempotency.
   * It does not bind a network port or authenticate a channel by itself.
   */
  async dispatchTransport(input: unknown, onAuthenticated?: () => void): Promise<RemoteTransportIngressResult> {
    const failures = validateRemoteTransportEnvelope(input);
    if (failures.length > 0) return { ok: false, code: "malformed_envelope", summary: failures.join("; ") };
    const envelope = input as RemoteTransportEnvelope;
    const legacy = {
      schema_version: 1 as const,
      metadata: envelope.metadata,
      command: { kind: envelope.command.kind, ...envelope.command.params },
    };
    const signing = remoteTransportSigningEnvelope(envelope);
    const proofDigest = `sha256:${createHash("sha256").update(canonicalizeRemoteTransportSigningEnvelope(signing)).digest("hex")}` as const;
    if (envelope.command.kind === "bus.thread.send" || envelope.command.kind === "bus.thread.ack") {
      const audience = threadAudience(legacy.command);
      if (audience === null) return { ok: false, code: "malformed_envelope", summary: "remote direct-thread audience is malformed" };
      const verified = this.authority.verifyTransportThread(envelope.proof, { signing_envelope: signing, audience });
      if (!verified.ok) return transportFailure(verified.error);
      onAuthenticated?.();
      return { ok: true, value: await this.dispatchVerifiedThread(legacy as RemoteThreadEnvelope, verified, proofDigest) };
    }
    const verified = this.authority.verifyTransportApproval(envelope.proof, { signing_envelope: signing });
    if (!verified.ok) return transportFailure(verified.error);
    onAuthenticated?.();
    return { ok: true, value: await this.dispatchVerifiedApproval(legacy as RemoteApprovalEnvelope, verified, proofDigest) };
  }

  private async dispatchThread(envelope: RemoteThreadEnvelope): Promise<RuntimeRouterResult<unknown>> {
    const metadata = envelope.metadata as unknown as Record<string, unknown>;
    const command = envelope.command as unknown as Record<string, unknown>;
    const proof = metadata.remote_session_proof;
    const { remote_session_proof: _proof, ...signedMetadata } = metadata;
    const { kind, ...params } = command;
    const audience = threadAudience(command);
    if (audience === null) return failure("remote direct-thread audience is malformed");
    const verified = this.authority.verifyThread(proof, { kind: kind as "bus.thread.send" | "bus.thread.ack", metadata: signedMetadata, params, audience });
    if (!verified.ok) return failure(verified.error);
    return this.dispatchVerifiedThread(envelope, verified);
  }

  private async dispatchVerifiedThread(envelope: RemoteThreadEnvelope, verified: Extract<ReturnType<RemoteSessionAuthority["verifyThread"]>, { ok: true }>, proofDigest?: `sha256:${string}`): Promise<RuntimeRouterResult<unknown>> {
    const metadata = envelope.metadata as unknown as Record<string, unknown>;
    const { remote_session_proof: _proof, ...signedMetadata } = metadata;
    if (signedMetadata.actor_id !== verified.actor_id) return failure("remote command actor does not match authenticated session");
    const normalized = {
      ...envelope,
      metadata: {
        ...envelope.metadata,
        remote_session: { session_id: verified.session_id, key_id: verified.key_id, certificate_id: verified.certificate_id, nonce: verified.nonce, issued_at: verified.issued_at, integrity: "ed25519" as const, ...(proofDigest === undefined ? {} : { proof_digest: proofDigest }) },
      },
    };
    return this.router.dispatchCommand(normalized);
  }

  private async dispatchApproval(envelope: RemoteApprovalEnvelope): Promise<RuntimeRouterResult<unknown>> {
    const metadata = envelope.metadata as unknown as Record<string, unknown>;
    const command = envelope.command as unknown as Record<string, unknown>;
    const proof = metadata.remote_session_proof;
    const { remote_session_proof: _proof, ...signedMetadata } = metadata;
    const { kind, ...params } = command;
    const verified = this.authority.verifyApproval(proof, { kind: kind as "approval.request" | "approval.approve" | "approval.reject", metadata: signedMetadata, params });
    if (!verified.ok) return failure(verified.error);
    return this.dispatchVerifiedApproval(envelope, verified);
  }

  private async dispatchVerifiedApproval(envelope: RemoteApprovalEnvelope, verified: Extract<ReturnType<RemoteSessionAuthority["verifyApproval"]>, { ok: true }>, proofDigest?: `sha256:${string}`): Promise<RuntimeRouterResult<unknown>> {
    const metadata = envelope.metadata as unknown as Record<string, unknown>;
    const command = envelope.command as unknown as Record<string, unknown>;
    const { remote_session_proof: _proof, ...signedMetadata } = metadata;
    const kind = command.kind;
    if (signedMetadata.actor_id !== verified.actor_id) return failure("remote command actor does not match authenticated session");
    if (kind === "approval.request" && command.proposer !== verified.actor_id) return failure("remote approval proposer must equal authenticated session actor");
    if ((kind === "approval.approve" || kind === "approval.reject") && command.actor !== verified.actor_id) return failure("remote approval decider must equal authenticated session actor");
    const normalized = {
      ...envelope,
      metadata: {
        ...envelope.metadata,
        remote_session: { session_id: verified.session_id, key_id: verified.key_id, certificate_id: verified.certificate_id, nonce: verified.nonce, issued_at: verified.issued_at, integrity: "ed25519" as const, ...(proofDigest === undefined ? {} : { proof_digest: proofDigest }) },
      },
    };
    const identity: AuthenticatedApprovalIdentity = { actor_id: verified.actor_id, source: "remote_session" };
    return this.router.dispatchAuthenticatedApproval(normalized, identity);
  }
}

export type RemoteTransportIngressResult =
  | { readonly ok: true; readonly value: RuntimeRouterResult<unknown> }
  | { readonly ok: false; readonly code: RemoteTransportErrorCode; readonly summary: string };

function threadAudience(command: Record<string, unknown>): RemoteThreadAudience | null {
  const { campaign_id, parent_node_id, child_node_id, from_node_id } = command;
  if (![campaign_id, parent_node_id, child_node_id, from_node_id].every(text)) return null;
  return { campaign_id: campaign_id as string, parent_node_id: parent_node_id as string, child_node_id: child_node_id as string, author_node_id: from_node_id as string };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function failure(summary: string): RuntimeRouterResult<never> { return { ok: false, capability: null, error: { code: "permission", severity: "warning", recoverable: false, source: "remote-ingress", summary } }; }

function transportFailure(summary: string): Extract<RemoteTransportIngressResult, { ok: false }> {
  if (summary.includes("nonce was already consumed")) return { ok: false, code: "replay_detected", summary };
  if (summary.includes("replay store capacity")) return { ok: false, code: "replay_store_exhausted", summary };
  if (summary.includes("authorized")) return { ok: false, code: "authorization_denied", summary };
  return { ok: false, code: "authentication_failed", summary };
}

/** Attaches the mandatory proof without making it part of any core contract. */
export type RemoteIngressEnvelope<T> = T & { metadata: T extends { metadata: infer M } ? M & { remote_session_proof: RemoteSessionProof } : never };
