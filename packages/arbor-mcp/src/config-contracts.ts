import type { EffectiveConfigView } from "./config-inspection.js";

export interface ConfigQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "config.get" };
}

export type ConfigInspectionProjection = EffectiveConfigView;

export function isConfigQueryEnvelope(value: unknown): value is ConfigQueryEnvelope {
  return object(value) && object(value.query) && value.query.kind === "config.get";
}

export function validateConfigQuery(value: ConfigQueryEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  if (!text(value.query_id)) failures.push("query_id must be non-empty");
  return failures;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
