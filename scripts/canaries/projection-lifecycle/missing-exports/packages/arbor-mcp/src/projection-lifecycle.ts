// Canary fixture: the envelope shape `checkEnvelopeDoesNotAbsorbDomainState`
// inspects, faithful to the real interface, so that leg PASSES and the only
// failing leg in this fixture is the public-barrel export check.
export type ProjectionLifecycleState =
  | "never_fetched"
  | "loading"
  | "empty_ready"
  | "ready"
  | "stale_by_age"
  | "failed_after_success"
  | "unavailable"
  | "failed_without_value";

export type ProjectionTransportState = "idle" | "in_flight" | "aborted" | "completed";
export type ProjectionResyncState = "none" | "required" | "in_progress";
export type ProjectionFailure = { readonly code: string; readonly message: string };

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
  readonly value: T | null;
  readonly last_failure: ProjectionFailure | null;
}
