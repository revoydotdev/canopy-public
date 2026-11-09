import type { ApprovalMemoryScope, ApprovalRecord, ApprovalStatus } from "./approval-service.js";
import type { RuntimeError } from "@arbor/core";

export type ApprovalCommandKind = "approval.request" | "approval.approve" | "approval.reject" | "approval.expire";

export type ApprovalDecisionKind = "approval.approve" | "approval.reject";

export interface ApprovalRequestEnvelope {
  schema_version: 1;
  metadata: { operation_id: string; idempotency_key: string; actor_id: string; correlation_id: string; requested_at: string };
  command:
    | { kind: "approval.request"; request_id: string; idempotency_key: string; action: string; subject: string; resource_id: string; proposer: string; rationale?: string; expires_at: string }
    | { kind: "approval.approve"; request_id: string; actor: string; at?: string; memory_scope?: ApprovalMemoryScope }
    | { kind: "approval.reject"; request_id: string; actor: string; at?: string }
    | { kind: "approval.expire"; request_id: string };
}

export interface ApprovalListQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "approval.list"; status?: ApprovalStatus; limit?: number };
}

export type ApprovalRequestAcknowledgement =
  | { accepted: true; operation_id: string; record?: ApprovalRecord }
  | { accepted: false; operation_id: string; error: RuntimeError };

export type ApprovalListProjection = { records: readonly ApprovalRecord[] };

export function isApprovalRequestEnvelope(value: unknown): value is ApprovalRequestEnvelope {
  if (!object(value) || !object(value.metadata) || !object(value.command)) return false;
  const kind = value.command.kind;
  return kind === "approval.request" || kind === "approval.approve" || kind === "approval.reject" || kind === "approval.expire";
}

export function isApprovalListQueryEnvelope(value: unknown): value is ApprovalListQueryEnvelope {
  return object(value) && object(value.query) && value.query.kind === "approval.list";
}

export function validateApprovalRequest(value: ApprovalRequestEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  const m = value.metadata;
  if (!text(m.operation_id) || !text(m.idempotency_key) || !text(m.actor_id) || !text(m.correlation_id) || !text(m.requested_at)) failures.push("metadata identity fields are required");
  switch (value.command.kind) {
    case "approval.request": {
      const c = value.command;
      if (!text(c.request_id) || !text(c.idempotency_key) || !text(c.action) || !text(c.subject) || !text(c.resource_id) || !text(c.proposer)) failures.push("approval.request requires request_id, idempotency_key, action, subject, resource_id, proposer");
      if (!text(c.expires_at)) failures.push("approval.request requires expires_at");
      break;
    }
    case "approval.approve":
    case "approval.reject":
      if (!text(value.command.request_id) || !text(value.command.actor)) failures.push(`approval.${value.command.kind} requires request_id and actor`);
      if (value.command.kind === "approval.approve" && value.command.memory_scope !== undefined && !["once", "session", "persistent"].includes(value.command.memory_scope)) failures.push("approval.approve memory_scope must be once|session|persistent");
      break;
    case "approval.expire":
      if (!text(value.command.request_id)) failures.push("approval.expire requires request_id");
      break;
  }
  return failures;
}

export function validateApprovalListQuery(value: ApprovalListQueryEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  if (!text(value.query_id)) failures.push("query_id must be non-empty");
  if (value.query.limit !== undefined && (!Number.isSafeInteger(value.query.limit) || value.query.limit < 1 || value.query.limit > 1_000)) failures.push("query.limit must be an integer from 1 through 1000");
  if (value.query.status !== undefined && !["pending", "approved", "rejected", "expired"].includes(value.query.status)) failures.push("query.status must be pending|approved|rejected|expired");
  return failures;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
