import type { Job, JobQueueView } from "./job-scheduler.js";
import type { RuntimeError } from "@arbor/core";

export type JobCommandKind = "job.submit" | "job.cancel" | "job.retry" | "job.pause" | "job.resume";

export interface JobCommandEnvelope {
  schema_version: 1;
  metadata: { operation_id: string; idempotency_key: string; actor_id: string; correlation_id: string; requested_at: string };
  command:
    | { kind: "job.submit"; id: string; operation_id: string; job_kind: string; owner_scope_id: string; idempotency_key: string }
    | { kind: "job.cancel"; job_id: string }
    | { kind: "job.retry"; job_id: string }
    | { kind: "job.pause" }
    | { kind: "job.resume" };
}

export interface JobListQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "job.list"; include_terminal?: boolean };
}

export type JobListProjection = JobQueueView;
export type JobCommandAcknowledgement =
  | { accepted: true; operation_id: string; job?: Job; dispatched?: boolean }
  | { accepted: false; operation_id: string; error: RuntimeError };

export function isJobCommandEnvelope(value: unknown): value is JobCommandEnvelope {
  if (!object(value) || !object(value.metadata) || !object(value.command)) return false;
  return value.command.kind === "job.submit" || value.command.kind === "job.cancel"
    || value.command.kind === "job.retry" || value.command.kind === "job.pause" || value.command.kind === "job.resume";
}

export function isJobListQueryEnvelope(value: unknown): value is JobListQueryEnvelope {
  return object(value) && object(value.query) && value.query.kind === "job.list";
}

export function validateJobCommand(value: JobCommandEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  const m = value.metadata;
  if (!text(m.operation_id) || !text(m.idempotency_key) || !text(m.actor_id) || !text(m.correlation_id) || !text(m.requested_at)) failures.push("metadata identity fields are required");
  switch (value.command.kind) {
    case "job.submit": {
      const c = value.command;
      if (!text(c.id) || !text(c.operation_id) || !text(c.job_kind) || !text(c.owner_scope_id) || !text(c.idempotency_key)) failures.push("job.submit requires id, operation_id, job_kind, owner_scope_id, idempotency_key");
      break;
    }
    case "job.cancel":
    case "job.retry":
      if (!text(value.command.job_id)) failures.push(`job.${value.command.kind} requires job_id`);
      break;
    case "job.pause":
    case "job.resume":
      break;
  }
  return failures;
}

export function validateJobListQuery(value: JobListQueryEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  if (!text(value.query_id)) failures.push("query_id must be non-empty");
  if (value.query.include_terminal !== undefined && typeof value.query.include_terminal !== "boolean") failures.push("query.include_terminal must be a boolean");
  return failures;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
