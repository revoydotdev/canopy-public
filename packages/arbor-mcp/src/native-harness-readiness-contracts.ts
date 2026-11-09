/** Read-only canonical envelope for the native setup/readiness doctor. */
export interface NativeHarnessReadinessQueryEnvelope {
  readonly schema_version: 1;
  readonly query_id: string;
  readonly query: { readonly kind: "harness.native.readiness" };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNativeHarnessReadinessQueryEnvelope(value: unknown): value is NativeHarnessReadinessQueryEnvelope {
  return record(value) && value.schema_version === 1 && typeof value.query_id === "string"
    && record(value.query) && value.query.kind === "harness.native.readiness";
}

export function validateNativeHarnessReadinessQuery(value: NativeHarnessReadinessQueryEnvelope): readonly string[] {
  return value.query_id.trim().length > 0 ? [] : ["query_id is required"];
}
