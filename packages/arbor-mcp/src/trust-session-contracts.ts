import type { RuntimeError } from "@arbor/core";
import type { RemoteSessionRegistration, RemoteSessionStatus, RemoteThreadAudience } from "./remote-session.js";

/**
 * Bounded host-local control-plane contracts for `RemoteSessionAuthority`.
 * They do not represent a network protocol or make a remote transport
 * available. Enrolment has no ambient scope: every permitted direct edge (or
 * the explicit approval authority) is supplied by the operator.
 */
export interface TrustSessionCommandEnvelope {
  schema_version: 1;
  metadata: { operation_id: string; idempotency_key: string; actor_id: string; correlation_id: string; requested_at: string };
  command:
    | { kind: "trust.session.enroll"; registration: RemoteSessionRegistration }
    | { kind: "trust.session.rotate"; session_id: string; key_id: string; public_key_pem: string; certificate_id: string }
    | { kind: "trust.session.revoke"; session_id: string };
}

export interface TrustSessionQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query:
    | { kind: "trust.session.list"; limit?: number }
    | { kind: "trust.session.status"; session_id: string };
}

export type TrustSessionAcknowledgement =
  | { accepted: true; operation_id: string }
  | { accepted: false; operation_id: string; error: RuntimeError };

export type TrustSessionListProjection = { sessions: readonly RemoteSessionStatus[]; total: number };

export function isTrustSessionCommandEnvelope(value: unknown): value is TrustSessionCommandEnvelope {
  if (!object(value) || !object(value.metadata) || !object(value.command)) return false;
  return value.command.kind === "trust.session.enroll" || value.command.kind === "trust.session.rotate" || value.command.kind === "trust.session.revoke";
}

export function isTrustSessionQueryEnvelope(value: unknown): value is TrustSessionQueryEnvelope {
  return object(value) && object(value.query) && (value.query.kind === "trust.session.list" || value.query.kind === "trust.session.status");
}

export function validateTrustSessionCommand(value: TrustSessionCommandEnvelope): string[] {
  const failures = metadataFailures(value);
  const command = value.command;
  switch (command.kind) {
    case "trust.session.enroll":
      validateRegistration(command.registration, failures);
      break;
    case "trust.session.rotate":
      if (!identifier(command.session_id) || !identifier(command.key_id) || !boundedText(command.public_key_pem, 16_384) || !identifier(command.certificate_id)) {
        failures.push("trust.session.rotate requires bounded session_id, key_id, public_key_pem and certificate_id");
      }
      break;
    case "trust.session.revoke":
      if (!identifier(command.session_id)) failures.push("trust.session.revoke requires a bounded session_id");
      break;
  }
  return failures;
}

export function validateTrustSessionQuery(value: TrustSessionQueryEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  if (!identifier(value.query_id)) failures.push("query_id must be non-empty and at most 256 bytes");
  if (value.query.kind === "trust.session.list") {
    if (value.query.limit !== undefined && (!Number.isSafeInteger(value.query.limit) || value.query.limit < 1 || value.query.limit > 100)) failures.push("query.limit must be an integer from 1 through 100");
  } else if (!identifier(value.query.session_id)) failures.push("trust.session.status requires a bounded session_id");
  return failures;
}

function validateRegistration(registration: RemoteSessionRegistration, failures: string[]): void {
  if (!object(registration)) { failures.push("trust.session.enroll requires a registration"); return; }
  if (!identifier(registration.session_id) || !identifier(registration.actor_id) || !identifier(registration.key_id)
    || !boundedText(registration.public_key_pem, 16_384) || !identifier(registration.certificate_id)
    || !boundedText(registration.expires_at, 128) || !Number.isFinite(Date.parse(registration.expires_at))) {
    failures.push("trust.session.enroll registration identity, key, certificate and expiry are required and bounded");
  }
  if (!Array.isArray(registration.thread_audiences) || registration.thread_audiences.length > 64) {
    failures.push("trust.session.enroll thread_audiences must contain at most 64 direct edges");
  } else {
    const edges = new Set<string>();
    for (const audience of registration.thread_audiences) {
      if (!validAudience(audience)) {
        failures.push("trust.session.enroll has an invalid direct parent-child edge");
        continue;
      }
      const edge = `${audience.campaign_id}\u0000${audience.parent_node_id}\u0000${audience.child_node_id}\u0000${audience.author_node_id}`;
      if (edges.has(edge)) failures.push("trust.session.enroll must not repeat a direct edge");
      edges.add(edge);
    }
    if (registration.thread_audiences.length === 0 && registration.approval_authority !== true) {
      failures.push("trust.session.enroll requires at least one direct edge or explicit approval authority");
    }
  }
  if (registration.approval_authority !== undefined && typeof registration.approval_authority !== "boolean") failures.push("trust.session.enroll approval_authority must be a boolean when supplied");
}

function metadataFailures(value: TrustSessionCommandEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  const metadata = value.metadata;
  if (!identifier(metadata.operation_id) || !identifier(metadata.idempotency_key) || !identifier(metadata.actor_id)
    || !identifier(metadata.correlation_id) || !boundedText(metadata.requested_at, 128) || !Number.isFinite(Date.parse(metadata.requested_at))) {
    failures.push("metadata identity and requested_at fields are required and bounded");
  }
  return failures;
}

function validAudience(value: RemoteThreadAudience): boolean {
  return object(value) && identifier(value.campaign_id) && identifier(value.parent_node_id) && identifier(value.child_node_id)
    && identifier(value.author_node_id) && value.parent_node_id !== value.child_node_id
    && (value.author_node_id === value.parent_node_id || value.author_node_id === value.child_node_id);
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object"; }
function boundedText(value: unknown, maximum: number): value is string { return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maximum; }
function identifier(value: unknown): value is string { return boundedText(value, 256); }
