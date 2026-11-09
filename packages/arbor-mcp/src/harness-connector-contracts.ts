/**
 * Read-only inventory for the meta-harness connector seam.
 *
 * This is intentionally an inspection surface, not a connector installer,
 * credential manager, or alternate campaign runner.  It makes actual direct
 * dispatch admission visible through the same catalog used by the TUI/Web
 * while preserving typed fallback and unavailable states.
 */
import type { CapabilityRequirement, ConnectorHealth, HarnessCapability, SupportGrade } from "@arbor/harness";

export interface HarnessConnectorInventoryQueryEnvelope {
  readonly schema_version: 1;
  readonly query_id: string;
  readonly query: { readonly kind: "harness.connector.inventory" };
}

export type HarnessConnectorExecutionProjection =
  | {
      readonly kind: "direct_native";
      readonly connector_id: string;
      readonly readiness: "selected";
      readonly reason: null;
    }
  | {
      readonly kind: "connector_fallback";
      readonly connector_id: "opencode";
      /** The fallback is selected by composition, but its upstream process is not probed here. */
      readonly readiness: "fallback_unattested";
      readonly reason: string;
    }
  | {
      /** Explicit native mode was selected but cannot be composed; no fallback will run. */
      readonly kind: "unavailable";
      readonly connector_id: "revoy-native";
      readonly readiness: "blocked";
      readonly reason: string;
    };

/** Deliberately content-free connector metadata safe for all cockpit surfaces. */
export interface HarnessConnectorInventoryItem {
  readonly connector_id: string;
  readonly implementation_version: string;
  readonly supported_upstream_range: string;
  readonly health: ConnectorHealth;
  readonly capabilities: readonly {
    readonly capability: HarnessCapability;
    readonly grade: SupportGrade;
    readonly observed_at: string;
  }[];
}

export type HarnessConnectorSelectionProjection =
  | { readonly kind: "selected"; readonly connector_id: string }
  | {
      readonly kind: "unavailable";
      readonly reason: "not_configured" | "no_registered_connector" | "no_healthy_connector" | "requirements_unsatisfied";
      readonly candidates: readonly {
        readonly connector_id: string;
        readonly health: ConnectorHealth;
        readonly admitted: boolean;
        readonly rejected: readonly {
          readonly capability: HarnessCapability;
          readonly reason: "missing_capability" | "insufficient_grade" | "stale_evidence";
          readonly observed_grade: SupportGrade | null;
        }[];
      }[];
    };

export interface HarnessConnectorInventoryProjection {
  readonly requirements: readonly CapabilityRequirement[];
  readonly connectors: readonly HarnessConnectorInventoryItem[];
  readonly selection: HarnessConnectorSelectionProjection;
  readonly selected_execution: HarnessConnectorExecutionProjection;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isHarnessConnectorInventoryQueryEnvelope(value: unknown): value is HarnessConnectorInventoryQueryEnvelope {
  return record(value) && value.schema_version === 1 && typeof value.query_id === "string"
    && record(value.query) && value.query.kind === "harness.connector.inventory";
}

export function validateHarnessConnectorInventoryQuery(value: HarnessConnectorInventoryQueryEnvelope): readonly string[] {
  return value.query_id.trim() ? [] : ["query_id is required"];
}
