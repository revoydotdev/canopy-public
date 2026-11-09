import type { ActionClass, CapabilityTier } from "@arbor/core";

/** Read-only, catalog-derived explanation of the authority boundary (ADR-028). */
export interface CapabilityIntrospectionQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "capability.introspect" };
}

export interface CapabilityActionClassProjection {
  readonly kind: string;
  readonly direction: "command" | "query";
  readonly capability: string;
  readonly supported: boolean;
  readonly unavailable_reason?: string;
  readonly action_class: ActionClass;
  readonly mutating: boolean;
  readonly minimum_tier: CapabilityTier | null;
}

export interface CapabilityTierProjection {
  readonly tier: CapabilityTier;
  readonly entitled_action_classes: readonly ActionClass[];
}

export interface CapabilityIntrospectionProjection {
  readonly action_classes: readonly ActionClass[];
  readonly catalog: readonly CapabilityActionClassProjection[];
  readonly tiers: readonly CapabilityTierProjection[];
}

export function isCapabilityIntrospectionQueryEnvelope(input: unknown): input is CapabilityIntrospectionQueryEnvelope {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    && (input as { schema_version?: unknown }).schema_version === 1
    && typeof (input as { query_id?: unknown }).query_id === "string"
    && typeof (input as { query?: unknown }).query === "object"
    && (input as { query: { kind?: unknown } }).query.kind === "capability.introspect";
}

export function validateCapabilityIntrospectionQuery(envelope: CapabilityIntrospectionQueryEnvelope): string[] {
  return envelope.query_id.trim().length > 0 ? [] : ["query_id must be non-empty"];
}
