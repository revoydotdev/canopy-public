/**
 * ADR-094: `ProjectionLifecycle<T>` — the one versioned envelope every
 * operator-facing runtime projection MUST be carried in (Decision, opening
 * paragraph).  This module owns ONLY observation, transport, freshness, and
 * resynchronization facts.  It never owns, infers, or reshapes the domain
 * payload `T` — that stays owned by its canonical producer (e.g.
 * `projectCampaignRunStatus` in `campaign-run-status-projection.ts`,
 * `projectCostHud` in `cost/hud-projection.ts`). See
 * `projection-lifecycle-catalog.ts` for the per-projection-class freshness
 * registry (Decision §1's "registered ... at the runtime catalog, not
 * scattered through renderers") and for the first real consumer wrapping
 * ADR-093's `CampaignRunStatusProjection`.
 *
 * Every transition below is a pure reducer over an explicit `ProjectionClock`
 * (Decision §1/§3 forbid inferring freshness from redraw activity or wall
 * time read directly off the host) so TUI and web can share one reducer
 * (Decision §2) and so tests can drive every closed-lifecycle state and every
 * clock anomaly deterministically with a fake clock instead of real sleeps.
 */

/** Decision §1's closed lifecycle. No other value may ever appear here. */
export type ProjectionLifecycleState = "loading" | "ready" | "stale" | "unavailable" | "failed";

/** Decision §2: the query/event channel only — never worker/reporter liveness. */
export type ProjectionTransportState = "connected" | "disconnected" | "unknown";

/** Decision §2: whether a bounded snapshot refresh is owed before an event-backed value may be trusted again. */
export type ProjectionResyncState = "required" | "not_required";

/** Decision §1: a typed, redacted failure/clock reason. Never a raw stack trace, provider payload, or free-form message. */
export interface ProjectionFailure {
  readonly code: string;
  readonly occurred_at: string;
  /** Opaque/redacted reference; never raw model/tool text, credentials, or paths. */
  readonly diagnostic_ref: string | null;
}

/** Decision §1's envelope shape (the ADR's own JSON example), generic over the domain payload `T`. */
export interface ProjectionLifecycle<T> {
  readonly schema_version: 1;
  readonly projection_id: string;
  readonly lifecycle: ProjectionLifecycleState;
  readonly requested_at: string | null;
  readonly received_at: string | null;
  readonly source_cursor: string | null;
  readonly source_version: string | null;
  readonly fresh_for_ms: number | null;
  readonly expires_at: string | null;
  readonly transport: ProjectionTransportState;
  readonly resync: ProjectionResyncState;
  /** Owned entirely by the domain producer. Null only when no usable value exists (`unavailable`/`failed`, or never-fetched `loading`). */
  readonly value: T | null;
  readonly last_failure: ProjectionFailure | null;
}

/** Explicit time source. TUI and web inject their own; tests inject a fake one instead of sleeping (see the karpathy/ADR-078 rule against sleeping at a condition). */
export interface ProjectionClock {
  readonly now: () => string;
}

/** Decision §1: freshness budgets are registered by projection class at the catalog, never invented by a renderer. `fresh_for_ms: 0` selects immediate expiry for authority-sensitive state. */
export interface ProjectionFreshnessPolicy {
  readonly projection_class: string;
  readonly fresh_for_ms: number;
  /** Decision §2: a polling transport's declared maximum age must satisfy this same budget. */
  readonly max_poll_age_ms: number;
}

function isoNow(clock: ProjectionClock): string {
  const value = clock.now();
  if (Number.isNaN(Date.parse(value))) throw new Error(`ProjectionClock.now() must return a parseable ISO-8601 timestamp, got ${JSON.stringify(value)}`);
  return value;
}

/** The never-fetched state: `loading`, no request ever issued, no value. Decision §5.1's "never-fetched" fixture case. */
export function initialProjectionLifecycle<T>(projectionId: string): ProjectionLifecycle<T> {
  return Object.freeze({
    schema_version: 1,
    projection_id: projectionId,
    lifecycle: "loading",
    requested_at: null,
    received_at: null,
    source_cursor: null,
    source_version: null,
    fresh_for_ms: null,
    expires_at: null,
    transport: "unknown",
    resync: "not_required",
    value: null,
    last_failure: null,
  });
}

/** Decision §1: a request is in flight. Retains any prior value/cursor/version so a mid-flight redraw never drops a previously ready payload (Decision §1's "says whether a prior value is retained"). */
export function beginProjectionRequest<T>(prior: ProjectionLifecycle<T>, clock: ProjectionClock, transport: ProjectionTransportState): ProjectionLifecycle<T> {
  return Object.freeze({
    ...prior,
    lifecycle: "loading" as const,
    requested_at: isoNow(clock),
    transport,
  });
}

export interface ResolveProjectionSuccessParams<T> {
  readonly value: T;
  readonly clock: ProjectionClock;
  readonly policy: ProjectionFreshnessPolicy;
  readonly transport: ProjectionTransportState;
  readonly source_cursor?: string | null;
  readonly source_version?: string | null;
}

/** Decision §1: a successful value within its declared budget. An empty domain result is still `ready` here — emptiness is a fact about `T`, never inferred by this envelope. */
export function resolveProjectionSuccess<T>(prior: ProjectionLifecycle<T>, params: ResolveProjectionSuccessParams<T>): ProjectionLifecycle<T> {
  const receivedAt = isoNow(params.clock);
  const expiresAt = new Date(new Date(receivedAt).getTime() + params.policy.fresh_for_ms).toISOString();
  return Object.freeze({
    schema_version: 1,
    projection_id: prior.projection_id,
    lifecycle: "ready" as const,
    requested_at: prior.requested_at,
    received_at: receivedAt,
    source_cursor: params.source_cursor === undefined ? prior.source_cursor : params.source_cursor,
    source_version: params.source_version === undefined ? prior.source_version : params.source_version,
    fresh_for_ms: params.policy.fresh_for_ms,
    expires_at: expiresAt,
    transport: params.transport,
    resync: "not_required" as const,
    value: params.value,
    last_failure: null,
  });
}

export interface ResolveProjectionFailureParams {
  readonly code: string;
  readonly diagnostic_ref: string | null;
  readonly clock: ProjectionClock;
  readonly transport: ProjectionTransportState;
}

/**
 * Decision §1's "a failure after success preserves the bounded old value only
 * as `stale`" rule. If `prior` carries a usable value, the result is `stale`
 * with that value retained; otherwise it is `failed` with no value. Either
 * way `last_failure` is set and the value is never re-presented as `ready`.
 */
export function resolveProjectionFailure<T>(prior: ProjectionLifecycle<T>, params: ResolveProjectionFailureParams): ProjectionLifecycle<T> {
  const failure: ProjectionFailure = Object.freeze({ code: params.code, occurred_at: isoNow(params.clock), diagnostic_ref: params.diagnostic_ref });
  // `prior` may be `loading` here (a request just began via beginProjectionRequest, which retains any
  // earlier value) as well as `ready`/`stale` — value presence, not the lifecycle label, is what makes it usable.
  const hasUsableValue = prior.value !== null;
  return Object.freeze({
    ...prior,
    lifecycle: (hasUsableValue ? "stale" : "failed") as ProjectionLifecycleState,
    transport: params.transport,
    last_failure: failure,
    value: hasUsableValue ? prior.value : null,
  });
}

export interface MarkProjectionUnavailableParams {
  readonly code: string;
  readonly diagnostic_ref: string | null;
  readonly clock: ProjectionClock;
  readonly transport: ProjectionTransportState;
}

/** Decision §1: the source or capability is not available at all (distinct from a failed request against an available source). Always clears any retained value — Decision §1 does not extend stale-retention to capability absence. */
export function markProjectionUnavailable<T>(prior: ProjectionLifecycle<T>, params: MarkProjectionUnavailableParams): ProjectionLifecycle<T> {
  return Object.freeze({
    ...prior,
    lifecycle: "unavailable" as const,
    transport: params.transport,
    last_failure: Object.freeze({ code: params.code, occurred_at: isoNow(params.clock), diagnostic_ref: params.diagnostic_ref }),
    value: null,
    resync: "not_required" as const,
  });
}

const CLOCK_ANOMALY_CODE = "clock_anomaly";

/**
 * Decision §1's age check, applied on read (never on a background timer —
 * callers invoke this at render/observation time). Three outcomes:
 *   - not yet expired and clock is sane        -> unchanged
 *   - expired (`now >= expires_at`)             -> `stale`, value retained
 *   - `now` precedes `received_at`               -> `stale` with a typed
 *     `clock_anomaly` failure, never negative age and never a renewed budget
 * Only applies to `ready`; `loading`/`stale`/`unavailable`/`failed` pass through unchanged (staleness cannot un-fail a `failed` envelope; it stays `failed` until a real request resolves it).
 */
export function checkProjectionFreshness<T>(current: ProjectionLifecycle<T>, clock: ProjectionClock): ProjectionLifecycle<T> {
  if (current.lifecycle !== "ready" || current.received_at === null || current.expires_at === null) return current;
  const now = isoNow(clock);
  const nowMs = Date.parse(now);
  const receivedMs = Date.parse(current.received_at);
  if (nowMs < receivedMs) {
    return Object.freeze({
      ...current,
      lifecycle: "stale" as const,
      last_failure: Object.freeze({ code: CLOCK_ANOMALY_CODE, occurred_at: now, diagnostic_ref: null }),
    });
  }
  const expiresMs = Date.parse(current.expires_at);
  if (nowMs >= expiresMs) return Object.freeze({ ...current, lifecycle: "stale" as const });
  return current;
}

// Decision §2's transport reducers (`markProjectionResyncRequired`,
// `resolveProjectionResync`), Decision §3's status-chrome classifier
// (`classifyProjectionStatusPriority`) and Decision §4's read-only refresh
// action (`refreshProjection`) were removed 2026-10-01. ADR-094 O2 owned the
// subscribing TUI/web read path that would have consumed them, ADR-107 — the
// lane O2 named as that consumer's owner — is Accepted, and nothing outside
// this module, its index re-export and its unit test ever referenced them.
// They were surplus API awaiting a consumer that has now demonstrably not
// arrived, so they are deleted rather than re-exempted. See the 2026-10-01
// interview record in decisions/interviews.jsonl.
