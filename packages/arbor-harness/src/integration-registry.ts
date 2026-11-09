import {
  ConnectorRegistry,
  type ConnectorDescriptor,
  type ConnectorInspection,
  type ConnectorSelection,
} from "./connector-registry.js";
import type { CapabilityRequirement } from "./capabilities.js";

/** A capability-admitted connector paired with its host-owned implementation. */
export type HarnessIntegrationSelection<T> =
  | { readonly kind: "selected"; readonly connector: ConnectorInspection; readonly integration: T }
  | Exclude<ConnectorSelection, { readonly kind: "selected" }>;

/**
 * Revoy-owned binding layer for external harness integrations.
 *
 * ConnectorRegistry deliberately stores declarations only. This companion
 * registry binds each declaration to an opaque host implementation without
 * teaching @arbor/harness about a campaign loop, provider SDK, or upstream
 * package. Selection is still capability-first and fail-closed; an adapter
 * cannot become executable without the matching admitted descriptor.
 */
export class HarnessIntegrationRegistry<T> {
  readonly connectors: ConnectorRegistry;
  private readonly implementations = new Map<string, T>();

  constructor(connectors = new ConnectorRegistry()) {
    this.connectors = connectors;
  }

  register(descriptor: ConnectorDescriptor, implementation: T): ConnectorInspection {
    const admitted = this.connectors.register(descriptor);
    this.implementations.set(admitted.connector_id, implementation);
    return admitted;
  }

  inspect(connectorId: string): { readonly connector: ConnectorInspection; readonly integration: T } | null {
    const connector = this.connectors.inspect(connectorId);
    const integration = this.implementations.get(connectorId);
    return connector === null || integration === undefined ? null : { connector, integration };
  }

  select(requirements: readonly CapabilityRequirement[]): HarnessIntegrationSelection<T> {
    const selected = this.connectors.select(requirements);
    if (selected.kind !== "selected") return selected;
    const integration = this.implementations.get(selected.connector.connector_id);
    if (integration === undefined) {
      return { kind: "unavailable", reason: "requirements_unsatisfied", candidates: [] };
    }
    return { kind: "selected", connector: selected.connector, integration };
  }
}
