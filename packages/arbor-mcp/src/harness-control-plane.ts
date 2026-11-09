/**
 * Composition-root services for the revoy-owned reference harness.
 *
 * This module deliberately owns no connector process and no credentials.  It
 * exposes injected, typed services to the runtime so campaign dispatch can
 * negotiate a connector before it enters the already-supervised campaign.run
 * path.  In particular, it is not an alternate campaign driver.
 */
import {
  ConnectorRegistry,
  InMemoryCredentialLeaseBroker,
  type CapabilityRequirement,
  type CapabilitySupport,
  type ConnectorDescriptor,
  type ConnectorInspection,
  type ConnectorSelection,
} from "@arbor/harness";

export const NATIVE_HARNESS_CONNECTOR_ID = "revoy-native";

/**
 * Minimum behavior the production campaign runner requires before it may
 * select a direct native executor.  This lives beside the descriptor rather
 * than in a CLI composition root so read-only inventory can report the exact
 * same admission standard without importing a runner or creating a cycle.
 */
export const DEFAULT_DIRECT_NATIVE_CAMPAIGN_REQUIREMENTS: readonly CapabilityRequirement[] = Object.freeze([
  { capability: "interruption", minimum_grade: "governed" },
  { capability: "tool_policy", minimum_grade: "governed" },
]);

/**
 * The direct-native campaign composition's truthful present-tense declaration.
 *
 * This is deliberately narrower than every operation the in-process reference
 * engine can model. The production campaign surface starts fresh, ephemeral
 * sessions and admits governed crash continuation as another fresh session;
 * it does not expose general fork or a caller-owned structured-output schema.
 * It does compose one fixed, validated schema for
 * critic verdicts. Advertising broader protocol-only shapes here would let
 * connector negotiation approve an operation the selected campaign executor
 * cannot actually perform.
 *
 * Items that the composed worker merely records or exposes as evidence remain
 * `observed`; callers requiring direct enforcement receive a typed rejection.
 */
export function createNativeHarnessConnectorDescriptor(observedAt = new Date().toISOString(), artifactCapture = false): ConnectorDescriptor {
  const support = (
    capability: CapabilitySupport["capability"],
    grade: CapabilitySupport["grade"],
    detail: string,
  ): CapabilitySupport => ({
    capability,
    grade,
    evidence: {
      implementation_id: "revoy2-native-session-engine",
      observed_at: observedAt,
      detail,
    },
  });
  return {
    connector_id: NATIVE_HARNESS_CONNECTOR_ID,
    implementation_version: "1",
    supported_upstream_range: "not_applicable",
    health: "healthy",
    capabilities: [
      support("streaming", "native", "ordered canonical model-text events are retained by the native engine"),
      support("interruption", "native", "the native engine records and settles cooperative interruption"),
      support("resumption", "governed", "direct-native continuation starts a fresh session only after durable effect reconciliation and fresh authority"),
      support("forking", "unsupported", "direct-native campaign execution exposes no session fork operation"),
      support("ephemeral_sessions", "native", "the native engine prevents durable recovery of ephemeral sessions"),
      support("structured_output", "native", "the direct-native campaign composition validates one fixed revoy-native critic-verdict schema; it exposes no caller-owned schema selection"),
      support("tool_policy", "native", "the native engine enforces immutable allow and deny policy with deny precedence"),
      support("workspace_isolation", "observed", "the native engine validates canonical roots but does not itself mount an isolation boundary"),
      support("approval_mediation", "governed", "direct-native composition applies a distinct system policy port before high-risk repository tools"),
      support("usage_reporting", "observed", "the native engine retains usage observations without inventing provider totals"),
      support("artifact_capture", artifactCapture ? "native" : "unsupported", artifactCapture
        ? "the composed durable session journal captures a content-addressed, redacted terminal evidence manifest; it cannot resume a model, credential, or tool scope"
        : "the current direct-native composition has no durable artifact journal"),
      support("remote_transport", "unsupported", "the first reference engine is in-process only"),
    ],
  };
}

export type HarnessConnectorSelection = ConnectorSelection
  | { readonly kind: "unavailable"; readonly reason: "not_configured"; readonly candidates: readonly [] };

export interface HarnessControlPlaneOptions {
  /** Optional injected registry; no process-global connector catalog exists. */
  readonly connector_registry?: ConnectorRegistry;
  /** Optional injected opaque lease broker. The control plane never reads a secret. */
  readonly credential_broker?: InMemoryCredentialLeaseBroker;
  /** Register the native descriptor in an injected registry unless it already exists. */
  readonly register_native_connector?: boolean;
  /** Testable observation timestamp for the native descriptor. */
  readonly native_observed_at?: string;
  /** True only when this composition has a durable terminal-session journal. */
  readonly native_artifact_capture?: boolean;
}

/**
 * A narrow adapter around injected harness services.  The null states are
 * deliberate typed absence: constructing an ordinary ArborRuntime neither
 * manufactures credentials nor silently starts a connector.
 */
export class HarnessControlPlane {
  readonly connectorRegistry: ConnectorRegistry | null;
  readonly credentialBroker: InMemoryCredentialLeaseBroker | null;

  constructor(options: HarnessControlPlaneOptions = {}) {
    this.connectorRegistry = options.connector_registry ?? null;
    this.credentialBroker = options.credential_broker ?? null;
    if (this.connectorRegistry && options.register_native_connector !== false
      && this.connectorRegistry.inspect(NATIVE_HARNESS_CONNECTOR_ID) === null) {
      this.connectorRegistry.register(createNativeHarnessConnectorDescriptor(options.native_observed_at, options.native_artifact_capture === true));
    }
  }

  inspect(connectorId: string): ConnectorInspection | null {
    return this.connectorRegistry?.inspect(connectorId) ?? null;
  }

  list(): readonly ConnectorInspection[] {
    return this.connectorRegistry?.list() ?? [];
  }

  select(requirements: readonly CapabilityRequirement[]): HarnessConnectorSelection {
    return this.connectorRegistry?.select(requirements)
      ?? { kind: "unavailable", reason: "not_configured", candidates: [] };
  }
}
