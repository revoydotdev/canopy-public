export type DistributedControlQueryKind = "control.status" | "control.discover" | "control.inbox";
export interface DistributedControlQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: DistributedControlQueryKind; limit?: number };
}
export type DistributedControlDisabledProjection = {
  availability: "disabled";
  kind: DistributedControlQueryKind;
  reason: "distributed control is not configured";
  remediation: "Set ARBOR_DISTRIBUTED_CONTROL_CONFIG to a closed v1 authority or join config, then restart this runtime.";
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function isDistributedControlQueryEnvelope(value: unknown): value is DistributedControlQueryEnvelope {
  return record(value) && value.schema_version === 1 && typeof value.query_id === "string" && value.query_id.length > 0 && value.query_id.length <= 256 && record(value.query) && ["control.status", "control.discover", "control.inbox"].includes(String(value.query.kind));
}
export function validateDistributedControlQuery(value: DistributedControlQueryEnvelope): string[] {
  const failures: string[] = [];
  if (!isDistributedControlQueryEnvelope(value)) failures.push("distributed control query envelope is malformed");
  if (value.query.limit !== undefined && (!Number.isSafeInteger(value.query.limit) || value.query.limit < 1 || value.query.limit > 100)) failures.push("control projection limit must be 1 through 100");
  const allowed = value.query.kind === "control.status" ? ["kind"] : ["kind", "limit"];
  if (Object.keys(value.query).some((key) => !allowed.includes(key))) failures.push("distributed control query contains unknown fields");
  return failures;
}
