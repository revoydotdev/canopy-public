/**
 * ADR-094 Decision §1's catalog freshness registry: "Freshness budgets are
 * registered by projection class at the runtime catalog, not scattered
 * through renderers."  One static table, one resolver.  A projection id not
 * present here is a configuration error, not a silently-invented budget —
 * `resolveProjectionFreshnessPolicy` throws rather than defaulting.
 *
 * The projection classes enumerated match Decision §5.6's representative
 * list ("campaign-run, evidence, finalization, approvals, interviews,
 * recovery, governance, and diagnostics projections").  Only `campaign.run.
 * status` has a real producer wired to it this tranche
 * (`packages/arbor-mcp/src/campaign-run-status-projection.ts`, landed under
 * ADR-093); the remaining classes are registered with policy now so a
 * producer can adopt the envelope later without a second freshness
 * decision, per Decision §5's "so a new screen/query cannot bypass the
 * envelope or omit a freshness classification."
 *
 * `projectCampaignRunStatusLifecycle` below is this catalog's first real
 * consumer: it wraps ADR-093's `CampaignRunStatusProjection` in the
 * envelope without touching or reshaping it, proving the additive fit the
 * ADR-093 author left room for. Wiring it into `ArborRuntime`/the CLI/TUI/
 * web adapters is out of this file's ownership this tranche (see the
 * ADR-094 implementation report) — the same boundary ADR-093's own gate
 * documented for its consumers.
 */
import type { CampaignRunStatusProjection } from "./campaign-run-status-projection.js";
import type { GateRefusalProjection } from "./gate-refusal-projection.js";
import {
  markProjectionUnavailable,
  resolveProjectionSuccess,
  type ProjectionClock,
  type ProjectionFreshnessPolicy,
  type ProjectionLifecycle,
  type ProjectionResyncState,
  type ProjectionTransportState,
} from "./projection-lifecycle.js";

/** Decision §5.6's representative projection classes. Extend only alongside a real producer + catalog entry, never speculatively. */
export type ProjectionClass =
  | "campaign.run.status"
  | "gate.refusal"
  | "evidence.transaction"
  | "finalization.progress"
  | "approvals.queue"
  | "interviews.queue"
  | "recovery.diagnostics"
  | "governance.snapshot"
  | "diagnostics.liveness";

/**
 * `fresh_for_ms: 0` on `approvals.queue` selects Decision §1's "immediate
 * expiry for authority-sensitive state" — an approval decision must never
 * be rendered as fresh without a request in the same observation. All other
 * classes use a bounded, non-zero budget; `max_poll_age_ms` always equals
 * `fresh_for_ms` here because no producer in this tranche polls on a longer
 * cycle than its own freshness budget (Decision §2's "declared maximum age
 * must satisfy the same projection freshness budget").
 */
export const PROJECTION_FRESHNESS_CATALOG: Readonly<Record<ProjectionClass, ProjectionFreshnessPolicy>> = Object.freeze({
  "campaign.run.status": Object.freeze({ projection_class: "campaign.run.status", fresh_for_ms: 5_000, max_poll_age_ms: 5_000 }),
  // Gate refusal/remediation is authority-sensitive. A caller must refresh
  // before treating it as current, so it follows the same immediate-expiry
  // rule as approvals rather than letting a stale denial block an action.
  "gate.refusal": Object.freeze({ projection_class: "gate.refusal", fresh_for_ms: 0, max_poll_age_ms: 0 }),
  "evidence.transaction": Object.freeze({ projection_class: "evidence.transaction", fresh_for_ms: 5_000, max_poll_age_ms: 5_000 }),
  "finalization.progress": Object.freeze({ projection_class: "finalization.progress", fresh_for_ms: 3_000, max_poll_age_ms: 3_000 }),
  "approvals.queue": Object.freeze({ projection_class: "approvals.queue", fresh_for_ms: 0, max_poll_age_ms: 0 }),
  "interviews.queue": Object.freeze({ projection_class: "interviews.queue", fresh_for_ms: 10_000, max_poll_age_ms: 10_000 }),
  "recovery.diagnostics": Object.freeze({ projection_class: "recovery.diagnostics", fresh_for_ms: 10_000, max_poll_age_ms: 10_000 }),
  "governance.snapshot": Object.freeze({ projection_class: "governance.snapshot", fresh_for_ms: 15_000, max_poll_age_ms: 15_000 }),
  "diagnostics.liveness": Object.freeze({ projection_class: "diagnostics.liveness", fresh_for_ms: 15_000, max_poll_age_ms: 15_000 }),
});

export function isRegisteredProjectionClass(value: string): value is ProjectionClass {
  return Object.prototype.hasOwnProperty.call(PROJECTION_FRESHNESS_CATALOG, value);
}

/** Throws rather than defaulting — Decision §1 forbids a renderer from inventing a budget for an unregistered projection. */
export function resolveProjectionFreshnessPolicy(projectionClass: string): ProjectionFreshnessPolicy {
  if (!isRegisteredProjectionClass(projectionClass)) {
    throw new Error(`no registered ADR-094 freshness policy for projection class ${JSON.stringify(projectionClass)}; register one in PROJECTION_FRESHNESS_CATALOG before a producer may use it`);
  }
  return PROJECTION_FRESHNESS_CATALOG[projectionClass];
}

export interface CampaignRunStatusLifecycleParams {
  readonly status: CampaignRunStatusProjection;
  readonly clock: ProjectionClock;
  readonly transport: ProjectionTransportState;
  readonly resync?: ProjectionResyncState;
}

export interface GateRefusalLifecycleParams {
  /** A present value means the gate source was read successfully. `null` is
   * a ready, empty result: no refusal is currently recorded. */
  readonly source:
    | { readonly kind: "available"; readonly value: GateRefusalProjection | null }
    | { readonly kind: "unavailable"; readonly code: string; readonly diagnostic_ref: string | null };
  readonly clock: ProjectionClock;
  readonly transport: ProjectionTransportState;
  readonly resync?: ProjectionResyncState;
}

/**
 * The shared gate-refusal projection lifecycle used by CLI/TUI/web adapters.
 * Source absence is represented by `unavailable`; it is never converted into
 * an empty refusal or a synthetic failure. A successful read with no refusal
 * remains `ready` with a null domain value.
 */
export function projectGateRefusalLifecycle(
  prior: ProjectionLifecycle<GateRefusalProjection | null>,
  params: GateRefusalLifecycleParams,
): ProjectionLifecycle<GateRefusalProjection | null> {
  const next = params.source.kind === "unavailable"
    ? markProjectionUnavailable(prior, {
      code: params.source.code,
      diagnostic_ref: params.source.diagnostic_ref,
      clock: params.clock,
      transport: params.transport,
    })
    : resolveProjectionSuccess(prior, {
      value: params.source.value,
      clock: params.clock,
      policy: resolveProjectionFreshnessPolicy("gate.refusal"),
      transport: params.transport,
    });
  return params.resync === "required" ? Object.freeze({ ...next, resync: "required" as const }) : next;
}

/**
 * Wraps ADR-093's `projectCampaignRunStatus` output in the envelope. Takes
 * the already-computed `CampaignRunStatusProjection` rather than the
 * supervisor/campaign/attempt authorities themselves — this module never
 * re-derives domain state, only observes it (Decision, opening paragraph).
 */
export function projectCampaignRunStatusLifecycle(
  prior: ProjectionLifecycle<CampaignRunStatusProjection>,
  params: CampaignRunStatusLifecycleParams,
): ProjectionLifecycle<CampaignRunStatusProjection> {
  const next = resolveProjectionSuccess(prior, {
    value: params.status,
    clock: params.clock,
    policy: resolveProjectionFreshnessPolicy("campaign.run.status"),
    transport: params.transport,
  });
  return params.resync === "required" ? Object.freeze({ ...next, resync: "required" as const }) : next;
}
