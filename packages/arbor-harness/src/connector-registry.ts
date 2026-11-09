import {
  type CapabilityClock,
  type CapabilityNegotiation,
  type CapabilityRequirement,
  type CapabilitySupport,
  isHarnessCapability,
  isSupportGrade,
  negotiateCapabilities,
  systemCapabilityClock,
} from "./capabilities.js";

export const CONNECTOR_HEALTH = ["healthy", "degraded", "unavailable"] as const;
export type ConnectorHealth = typeof CONNECTOR_HEALTH[number];

/** A connector's revoy-owned inward declaration, deliberately not an upstream schema. */
export interface ConnectorDescriptor {
  readonly connector_id: string;
  readonly implementation_version: string;
  readonly supported_upstream_range: string;
  readonly health: ConnectorHealth;
  readonly capabilities: readonly CapabilitySupport[];
  readonly diagnostic?: string;
}

export interface ConnectorInspection extends ConnectorDescriptor {
  readonly capabilities: readonly CapabilitySupport[];
}

export interface ConnectorCandidate {
  readonly connector: ConnectorInspection;
  readonly negotiation: CapabilityNegotiation;
}

/** Explicit selection failure preserves each isolated connector's result. */
export type ConnectorSelection =
  | { readonly kind: "selected"; readonly connector: ConnectorInspection; readonly negotiation: CapabilityNegotiation }
  | { readonly kind: "unavailable"; readonly reason: "no_registered_connector" | "no_healthy_connector" | "requirements_unsatisfied"; readonly candidates: readonly ConnectorCandidate[] };

export class ConnectorRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorRegistryError";
  }
}

function copySupport(support: CapabilitySupport): CapabilitySupport {
  return { capability: support.capability, grade: support.grade, evidence: { ...support.evidence } };
}

function copyDescriptor(descriptor: ConnectorDescriptor): ConnectorInspection {
  return {
    connector_id: descriptor.connector_id,
    implementation_version: descriptor.implementation_version,
    supported_upstream_range: descriptor.supported_upstream_range,
    health: descriptor.health,
    capabilities: descriptor.capabilities.map(copySupport),
    ...(descriptor.diagnostic === undefined ? {} : { diagnostic: descriptor.diagnostic }),
  };
}

function validateDescriptor(descriptor: ConnectorDescriptor): void {
  if (!descriptor.connector_id.trim()) throw new ConnectorRegistryError("connector_id must be non-empty");
  if (!descriptor.implementation_version.trim()) throw new ConnectorRegistryError("implementation_version must be non-empty");
  if (!descriptor.supported_upstream_range.trim()) throw new ConnectorRegistryError("supported_upstream_range must be non-empty");
  if (!(CONNECTOR_HEALTH as readonly string[]).includes(descriptor.health)) {
    throw new ConnectorRegistryError(`invalid connector health: ${String(descriptor.health)}`);
  }
  const seen = new Set<string>();
  for (const capability of descriptor.capabilities) {
    if (!isHarnessCapability(capability.capability)) throw new ConnectorRegistryError(`connector ${descriptor.connector_id} declares an unknown harness capability`);
    if (!isSupportGrade(capability.grade)) throw new ConnectorRegistryError(`connector ${descriptor.connector_id} declares an unknown support grade`);
    if (seen.has(capability.capability)) throw new ConnectorRegistryError(`connector ${descriptor.connector_id} declares ${capability.capability} more than once`);
    seen.add(capability.capability);
    if (!capability.evidence.implementation_id.trim() || !capability.evidence.detail.trim() || Number.isNaN(Date.parse(capability.evidence.observed_at))) {
      throw new ConnectorRegistryError(`connector ${descriptor.connector_id} has invalid evidence for ${capability.capability}`);
    }
  }
}

/**
 * In-memory catalog of independently healthy connectors.  A connector record
 * is copied at both ingress and egress, so one adapter cannot mutate another
 * adapter's advertised capability table through a shared object reference.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, ConnectorInspection>();

  constructor(private readonly clock: CapabilityClock = systemCapabilityClock) {}

  register(descriptor: ConnectorDescriptor): ConnectorInspection {
    validateDescriptor(descriptor);
    if (this.connectors.has(descriptor.connector_id)) {
      throw new ConnectorRegistryError(`connector already registered: ${descriptor.connector_id}`);
    }
    const stored = copyDescriptor(descriptor);
    this.connectors.set(stored.connector_id, stored);
    return copyDescriptor(stored);
  }

  inspect(connectorId: string): ConnectorInspection | null {
    const connector = this.connectors.get(connectorId);
    return connector ? copyDescriptor(connector) : null;
  }

  list(): readonly ConnectorInspection[] {
    return [...this.connectors.values()]
      .map(copyDescriptor)
      .sort((left, right) => left.connector_id.localeCompare(right.connector_id));
  }

  setHealth(connectorId: string, health: ConnectorHealth, diagnostic?: string): ConnectorInspection {
    if (!(CONNECTOR_HEALTH as readonly string[]).includes(health)) throw new ConnectorRegistryError(`invalid connector health: ${String(health)}`);
    const prior = this.connectors.get(connectorId);
    if (!prior) throw new ConnectorRegistryError(`connector not registered: ${connectorId}`);
    const next: ConnectorInspection = { ...prior, health, ...(diagnostic === undefined ? {} : { diagnostic }) };
    this.connectors.set(connectorId, next);
    return copyDescriptor(next);
  }

  /**
   * Only healthy connectors are dispatch candidates.  A degraded connector is
   * still inspectable (and therefore diagnosable) but cannot silently receive
   * new work while its drift is unresolved.
   */
  select(requirements: readonly CapabilityRequirement[]): ConnectorSelection {
    const connectors = this.list();
    if (connectors.length === 0) return { kind: "unavailable", reason: "no_registered_connector", candidates: [] };
    const healthy = connectors.filter((connector) => connector.health === "healthy");
    if (healthy.length === 0) return {
      kind: "unavailable",
      reason: "no_healthy_connector",
      candidates: connectors.map((connector) => ({ connector, negotiation: negotiateCapabilities(requirements, connector.capabilities, this.clock) })),
    };
    const candidates = healthy.map((connector) => ({ connector, negotiation: negotiateCapabilities(requirements, connector.capabilities, this.clock) }));
    const selected = candidates
      .filter((candidate): candidate is ConnectorCandidate & { negotiation: Extract<CapabilityNegotiation, { admitted: true }> } => candidate.negotiation.admitted)
      .sort((left, right) => fidelityScore(right.negotiation) - fidelityScore(left.negotiation)
        || left.connector.connector_id.localeCompare(right.connector.connector_id))[0];
    return selected
      ? { kind: "selected", connector: selected.connector, negotiation: selected.negotiation }
      : { kind: "unavailable", reason: "requirements_unsatisfied", candidates };
  }
}

const GRADE_SCORE = { observed: 1, governed: 2, native: 3, unsupported: 0 } as const;

function fidelityScore(negotiation: Extract<CapabilityNegotiation, { admitted: true }>): number {
  return negotiation.negotiated.reduce((total, entry) => total + GRADE_SCORE[entry.support.grade], 0);
}
