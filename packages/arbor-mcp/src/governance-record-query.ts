import { GovernanceRecordStore } from "@arbor/governance";
import type { GovernanceBrowseResult, GovernanceResult } from "@arbor/governance";

export type GovernanceRecordQuery =
  | { readonly kind: "governance.record.search"; readonly repo_root?: string; readonly query?: string; readonly limit?: number; readonly offset?: number }
  | { readonly kind: "governance.record.read"; readonly repo_root?: string; readonly id: string };

export interface GovernanceRecordQueryEnvelope {
  readonly schema_version: 1;
  readonly query_id: string;
  readonly query: GovernanceRecordQuery;
}

export function isGovernanceRecordQueryEnvelope(value: unknown): value is GovernanceRecordQueryEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const query = (value as { query?: unknown }).query;
  if (typeof query !== "object" || query === null || Array.isArray(query)) return false;
  const kind = (query as { kind?: unknown }).kind;
  return kind === "governance.record.search" || kind === "governance.record.read";
}

export function validateGovernanceRecordQuery(input: unknown): string[] {
  const failures: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return ["query envelope must be an object"];
  const envelope = input as Partial<GovernanceRecordQueryEnvelope> & { query?: unknown };
  if (envelope.schema_version !== 1) failures.push("schema_version must be 1");
  if (typeof envelope.query_id !== "string" || envelope.query_id.trim().length === 0) failures.push("query_id must be non-empty");
  if (typeof envelope.query !== "object" || envelope.query === null || Array.isArray(envelope.query)) return [...failures, "query must be an object"];
  const query = envelope.query as Partial<Record<"kind" | "repo_root" | "id" | "query" | "limit" | "offset", unknown>>;
  if (query.repo_root !== undefined && (typeof query.repo_root !== "string" || query.repo_root.trim().length === 0)) failures.push("query.repo_root must be non-empty when supplied");
  if (query.kind !== "governance.record.read" && query.kind !== "governance.record.search") {
    failures.push("query.kind must be governance.record.search or governance.record.read");
  } else if (query.kind === "governance.record.read") {
    if (typeof query.id !== "string" || query.id.trim().length === 0) failures.push("query.id must be non-empty");
  } else {
    if (query.query !== undefined && typeof query.query !== "string") failures.push("query.query must be a string");
    if (query.limit !== undefined && (typeof query.limit !== "number" || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500)) failures.push("query.limit must be 1..500");
    if (query.offset !== undefined && (typeof query.offset !== "number" || !Number.isSafeInteger(query.offset) || query.offset < 0)) failures.push("query.offset must be non-negative");
  }
  return failures;
}

export type GovernanceRecordQueryProjection = GovernanceBrowseResult | { readonly record: ReturnType<GovernanceRecordStore["read"]> };

export function executeGovernanceRecordQuery(envelope: unknown): GovernanceResult<GovernanceRecordQueryProjection> {
  const failures = validateGovernanceRecordQuery(envelope);
  if (failures.length > 0) return { ok: false, error: { code: "validation", message: failures.join("; ") }, capability: "governance.record.query" };
  const validEnvelope = envelope as GovernanceRecordQueryEnvelope;
  const store = new GovernanceRecordStore({ repo_root: validEnvelope.query.repo_root ?? process.cwd() });
  if (validEnvelope.query.kind === "governance.record.search") return store.browse(validEnvelope.query.query ?? "", validEnvelope.query.limit ?? 100, validEnvelope.query.offset ?? 0);
  return { ok: true, capability: "governance.record.read", value: { record: store.read(validEnvelope.query.id) } };
}
