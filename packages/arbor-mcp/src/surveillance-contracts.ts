import type { OperationMetadata, SurveillanceFinding } from "@arbor/core";

export interface SurveillanceScanCommandEnvelope {
  schema_version: 1;
  metadata: OperationMetadata;
  command: { kind: "surveillance.scan"; campaign_id: string; as_of?: string };
}

export interface SurveillanceFindingsQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "surveillance.findings"; campaign_id: string; limit: number };
}

export interface SurveillanceScanAcknowledgement {
  accepted: true;
  operation_id: string;
  scanned_at: string;
  finding_count: number;
  newly_recorded_count: number;
}

export interface SurveillanceFindingsProjection {
  campaign_id: string;
  findings: readonly SurveillanceFinding[];
}

export function isSurveillanceScanEnvelope(value: unknown): value is SurveillanceScanCommandEnvelope {
  return object(value) && object(value.command) && value.command.kind === "surveillance.scan";
}

export function isSurveillanceQueryEnvelope(value: unknown): value is SurveillanceFindingsQueryEnvelope {
  return object(value) && object(value.query) && value.query.kind === "surveillance.findings";
}

export function validateSurveillanceScan(value: SurveillanceScanCommandEnvelope): string[] {
  const failures = validateBase(value, true);
  if (!text(value.command.campaign_id)) failures.push("command.campaign_id must be non-empty");
  if (value.command.as_of !== undefined && !validTime(value.command.as_of)) failures.push("command.as_of must be a valid timestamp");
  return failures;
}

export function validateSurveillanceQuery(value: SurveillanceFindingsQueryEnvelope): string[] {
  const failures = validateBase(value, false);
  if (!text(value.query.campaign_id)) failures.push("query.campaign_id must be non-empty");
  if (!Number.isSafeInteger(value.query.limit) || value.query.limit < 1 || value.query.limit > 1_024) failures.push("query.limit must be an integer from 1 through 1024");
  return failures;
}

function validateBase(value: SurveillanceScanCommandEnvelope | SurveillanceFindingsQueryEnvelope, command: boolean): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  if (command) {
    const commandValue = value as SurveillanceScanCommandEnvelope;
    if (!object(commandValue.metadata)) failures.push("metadata is required");
    else {
      if (!text(commandValue.metadata.correlation_id)) failures.push("metadata.correlation_id must be non-empty");
      if (!text(commandValue.metadata.actor_id)) failures.push("metadata.actor_id must be non-empty");
      if (!validTime(commandValue.metadata.requested_at)) failures.push("metadata.requested_at must be a valid timestamp");
      if (!text(commandValue.metadata.operation_id)) failures.push("metadata.operation_id must be non-empty");
      if (!text(commandValue.metadata.idempotency_key)) failures.push("metadata.idempotency_key must be non-empty");
    }
  } else if (!text((value as SurveillanceFindingsQueryEnvelope).query_id)) failures.push("query_id must be non-empty");
  return failures;
}

function object(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validTime(value: string): boolean { return Number.isFinite(Date.parse(value)); }
