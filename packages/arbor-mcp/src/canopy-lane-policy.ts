/**
 * Canopy is the only campaign harness before 1.0.0 (operator directive
 * 2026-10-07; amends ADR-061).
 *
 * WHY THIS EXISTS. A campaign's model turns could be routed to a non-Canopy
 * harness from half a dozen places — `ARBOR_HARNESS_INTEGRATION` defaulted to
 * `opencode`, `arbor run` fell back to the opencode connector whenever the
 * native lane was unavailable, `arbor selfhost` fell back to a direct opencode
 * executor and decomposer, and `native.mode: "fallback"` forced a connector.
 * Each was a reasonable local default; together they meant "which harness ran
 * this campaign?" had no single answer, and the deprecated lanes kept running
 * by default while the native lane was the declared direction.
 *
 * This module is the one decision every composition root asks. The native
 * lane (`revoy-native`) is always admitted. Every other lane is refused at
 * composition time with a typed ADR-179 remedy, unless the operator has set
 * the single post-1.0 opt-in, `connectors.allow_deprecated: true` with a
 * `connectors.reason`, in `arbor.jsonc`. An admitted deprecated lane carries
 * that reason forward so the run that uses it can record it as evidence.
 *
 * The remedy maps onto ADR-179's existing `capability` authority (operator →
 * `grant_capability`): re-enabling a deprecated lane is a grant only the
 * operator can make, and the table needs no new pair for it.
 */
import type { ArborConfig } from "@arbor/config";
import { projectGateRefusal, type GateRefusalProjection } from "./gate-refusal-projection.js";
import { NATIVE_HARNESS_CONNECTOR_ID } from "./harness-control-plane.js";

/** The Canopy lane's connector id — the native harness descriptor's id, not a second literal. */
export const CANOPY_CONNECTOR_ID = NATIVE_HARNESS_CONNECTOR_ID;

/** The integration id `ARBOR_HARNESS_INTEGRATION` resolves to when unset. */
export const DEFAULT_HARNESS_INTEGRATION_ID = "native";

/** The stable refusal code every deprecated-lane refusal carries. */
export const DEPRECATED_HARNESS_REFUSAL_CODE = "deprecated_harness_lane";

/**
 * The selectable lanes that are not Canopy. `native_mode_fallback` is
 * `native.mode: "fallback"`, which exists only to force a connector.
 */
export type DeprecatedHarnessLane = "opencode" | "claude-code" | "codex" | "native_mode_fallback";

/** A deprecated lane the operator explicitly opted into, with the reason the run records. */
export interface DeprecatedHarnessAdmission {
  readonly lane: DeprecatedHarnessLane;
  /** Where the lane was selected (env var, flag, config key), for the evidence line. */
  readonly site: string;
  readonly reason: string;
}

/** A composition-time refusal of a deprecated lane. `refusal` is the typed ADR-179 remedy. */
export class DeprecatedHarnessRefusal extends Error {
  readonly refusal: GateRefusalProjection;
  readonly lane: DeprecatedHarnessLane;
  readonly site: string;

  constructor(lane: DeprecatedHarnessLane, site: string) {
    const refusal = projectDeprecatedHarnessRefusal(lane, site);
    super(`${refusal.summary} ${refusal.remediation}`);
    this.name = "DeprecatedHarnessRefusal";
    this.refusal = refusal;
    this.lane = lane;
    this.site = site;
  }
}

/** The ADR-179 projection for a refused deprecated lane: capability authority, operator, grant_capability. */
export function projectDeprecatedHarnessRefusal(lane: DeprecatedHarnessLane, site: string): GateRefusalProjection {
  const name = lane === "native_mode_fallback" ? "native.mode \"fallback\" (a connector fallback)" : `the "${lane}" connector`;
  return projectGateRefusal({
    gate: "capability",
    code: DEPRECATED_HARNESS_REFUSAL_CODE,
    summary: `${name} was selected by ${site}, but all work runs through the Canopy harness (revoy-native); non-Canopy harnesses are deprecated until after 1.0.0.`,
    remediation: lane === "native_mode_fallback"
      ? "Set native.mode to \"native\" or \"auto\" with a complete native selection (run `arbor doctor`), or, to use a deprecated connector anyway, set connectors.allow_deprecated: true and connectors.reason: \"<why>\" in arbor.jsonc."
      : `Unset ${site} (Canopy is the default), or, to use this deprecated connector anyway, set connectors.allow_deprecated: true and connectors.reason: "<why>" in arbor.jsonc; the reason is recorded in the run's evidence.`,
    correcting_actor: "operator",
    corrective_action: "grant_capability",
  });
}

/** The operator's opt-in, or null when none is configured. A malformed opt-in was already refused by the config validator. */
export function resolveDeprecatedHarnessOptIn(config: Pick<ArborConfig, "connectors">): { readonly reason: string } | null {
  const policy = config.connectors;
  if (policy?.allow_deprecated !== true || typeof policy.reason !== "string" || policy.reason.trim() === "") return null;
  return Object.freeze({ reason: policy.reason.trim() });
}

/**
 * Admit a deprecated lane or throw the typed refusal. There is no "warn and
 * continue" result: a lane that runs without the opt-in is the exact silent
 * default this module exists to end.
 */
export function admitDeprecatedHarnessLane(lane: DeprecatedHarnessLane, site: string, config: Pick<ArborConfig, "connectors">): DeprecatedHarnessAdmission {
  const optIn = resolveDeprecatedHarnessOptIn(config);
  if (optIn === null) throw new DeprecatedHarnessRefusal(lane, site);
  return Object.freeze({ lane, site, reason: optIn.reason });
}

/** `ARBOR_HARNESS_INTEGRATION`, defaulting to the Canopy lane rather than to a connector. */
export function resolveConfiguredHarnessIntegrationId(env: Readonly<Record<string, string | undefined>>): string {
  return env.ARBOR_HARNESS_INTEGRATION?.trim() || DEFAULT_HARNESS_INTEGRATION_ID;
}

/** Map a connector integration id onto its deprecated lane; null for the Canopy lane or an unknown id. */
export function deprecatedLaneForIntegration(integrationId: string): DeprecatedHarnessLane | null {
  return integrationId === "opencode" || integrationId === "claude-code" || integrationId === "codex" ? integrationId : null;
}

/** The one-line, operator-facing statement of an admitted deprecated lane. */
export function describeDeprecatedHarnessAdmission(admission: DeprecatedHarnessAdmission): string {
  return `deprecated harness lane "${admission.lane}" (selected by ${admission.site}) admitted by connectors.allow_deprecated: ${admission.reason}`;
}

/** The minimal manager surface needed to journal an admission into a campaign's ledger. */
export interface DeprecatedHarnessEvidenceSink {
  recordPhaseMessage(input: {
    campaign_id: string; node_id: string; operation_id: string; phase: "commentary";
    content: string; content_length_bytes: number;
    provenance: { tag: "generated"; generator: string; input_hash: string };
    idempotency_key: string;
  }): string;
}

/**
 * Record an admitted deprecated lane in the campaign's own hash-chained
 * ledger, on its root node, before any turn runs on it. `generated`
 * provenance: this is a composition fact, not a verified outcome. The
 * idempotency key is per campaign and lane, so a resumed run does not
 * duplicate it.
 */
export function recordDeprecatedHarnessAdmission(sink: DeprecatedHarnessEvidenceSink, campaignId: string, admission: DeprecatedHarnessAdmission, rootId = "root"): string {
  const content = describeDeprecatedHarnessAdmission(admission);
  return sink.recordPhaseMessage({
    campaign_id: campaignId,
    node_id: rootId,
    operation_id: `${campaignId}:${rootId}:harness-lane`,
    phase: "commentary",
    content,
    content_length_bytes: Buffer.byteLength(content, "utf8"),
    provenance: { tag: "generated", generator: "arbor-mcp/canopy-lane-policy@1", input_hash: `${admission.lane}:${admission.site}` },
    idempotency_key: `deprecated-harness-lane:${campaignId}:${admission.lane}`,
  });
}
