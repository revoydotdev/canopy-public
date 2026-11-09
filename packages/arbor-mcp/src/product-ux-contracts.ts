import type { Provenance } from "@arbor/core";

export type ProductUxQuery =
  | { readonly kind: "session.identity.get"; readonly session_id: string }
  | { readonly kind: "session.identity.search"; readonly query?: string; readonly limit: number; readonly cursor?: string }
  | { readonly kind: "result.verification.get"; readonly campaign_id: string; readonly node_id: string }
  | { readonly kind: "result.verification.list"; readonly campaign_id: string; readonly limit?: number }
  | { readonly kind: "notification.list"; readonly project_id?: string; readonly unread_only?: boolean; readonly limit?: number }
  | { readonly kind: "followup.list"; readonly parent_campaign_id: string; readonly limit?: number };

export interface ProductUxQueryEnvelope {
  readonly schema_version: 1;
  readonly query_id: string;
  readonly query: ProductUxQuery;
}

export type ProductUxCommand =
  | { readonly kind: "session.identity.mutate"; readonly session_id: string; readonly display_name?: string | null; readonly tags?: readonly string[]; readonly provenance: Provenance }
  | { readonly kind: "notification.read"; readonly notification_id: string }
  | { readonly kind: "followup.create"; readonly id?: string; readonly parent_campaign_id: string; readonly source_result: { readonly campaign_id: string; readonly node_id: string } | null; readonly source_node: { readonly campaign_id: string; readonly node_id: string } | null; readonly provenance: Provenance };

export interface ProductUxCommandEnvelope {
  readonly schema_version: 1;
  readonly metadata: { readonly operation_id: string; readonly idempotency_key: string; readonly correlation_id: string; readonly actor_id: string; readonly requested_at: string };
  readonly command: ProductUxCommand;
}

export function isProductUxQueryEnvelope(value: unknown): value is ProductUxQueryEnvelope {
  return isRecord(value) && isRecord(value.query) && typeof value.query.kind === "string" && ["session.identity.get", "session.identity.search", "result.verification.get", "result.verification.list", "notification.list", "followup.list"].includes(value.query.kind);
}

export function isProductUxCommandEnvelope(value: unknown): value is ProductUxCommandEnvelope {
  return isRecord(value) && isRecord(value.command) && typeof value.command.kind === "string" && ["session.identity.mutate", "notification.read", "followup.create"].includes(value.command.kind);
}

export function validateProductUxQuery(envelope: ProductUxQueryEnvelope): readonly string[] {
  const query = envelope.query;
  if (!safeId(envelope.query_id)) return ["query_id must be a safe identifier"];
  if (query.kind === "session.identity.get") return safeId(query.session_id) ? [] : ["session_id must be a safe identifier"];
  if (query.kind === "session.identity.search") return bounded(query.limit, 1, 100) && (query.query === undefined || text(query.query, 128)) && (query.cursor === undefined || safeId(query.cursor)) ? [] : ["identity search fields are invalid"];
  if (query.kind === "result.verification.get") return safeId(query.campaign_id) && safeId(query.node_id) ? [] : ["campaign_id and node_id must be safe identifiers"];
  if (query.kind === "result.verification.list") return safeId(query.campaign_id) && (query.limit === undefined || bounded(query.limit, 1, 200)) ? [] : ["verification list fields are invalid"];
  if (query.kind === "notification.list") return (query.project_id === undefined || safeId(query.project_id)) && (query.unread_only === undefined || typeof query.unread_only === "boolean") && (query.limit === undefined || bounded(query.limit, 1, 200)) ? [] : ["notification list fields are invalid"];
  return safeId(query.parent_campaign_id) && (query.limit === undefined || bounded(query.limit, 1, 200)) ? [] : ["follow-up list fields are invalid"];
}

export function validateProductUxCommand(envelope: ProductUxCommandEnvelope): readonly string[] {
  const command = envelope.command;
  if (command.kind === "session.identity.mutate") return safeId(command.session_id) && (command.display_name === undefined || command.display_name === null || text(command.display_name, 96)) && (command.tags === undefined || (command.tags.length <= 12 && command.tags.every((tag) => text(tag, 32)))) && provenance(command.provenance) ? [] : ["session identity mutation fields are invalid"];
  if (command.kind === "notification.read") return safeId(command.notification_id) ? [] : ["notification_id must be a safe identifier"];
  return safeId(command.parent_campaign_id) && (command.id === undefined || safeId(command.id)) && source(command.source_result) && source(command.source_node) && (command.source_result !== null || command.source_node !== null) && provenance(command.provenance) ? [] : ["follow-up lineage fields are invalid"];
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function safeId(value: unknown): value is string { return text(value, 256) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value); }
function bounded(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
function provenance(value: unknown): value is Provenance { return isRecord(value) && typeof value.tag === "string"; }
function source(value: unknown): value is { readonly campaign_id: string; readonly node_id: string } | null { return value === null || (isRecord(value) && safeId(value.campaign_id) && safeId(value.node_id)); }
