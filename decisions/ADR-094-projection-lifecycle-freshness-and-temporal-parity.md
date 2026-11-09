# ADR-094: Projection Lifecycle, Freshness, and Temporal Parity

**Status:** Accepted
**Date:** 2026-08-25
**Authoring Revision:** a1ca6e112a06c059e40d9393e40f100d21f75daf
**Content ID:** sha256:cb5417a0854e557a364af53e164dbcf9dfc2e6a695dd1e73909f54560527e2ca

## Context

The TUI and web surfaces render a large set of canonical runtime queries, but
they do not share a temporal contract for those results.  The terminal TUI is
mostly fetch-on-focus: only the active campaign tree is polled routinely.
Successful payloads are stored without their request time, receipt time,
cursor, expiry, or later query failure.  A transport error can therefore leave
an older successful value on screen while a separate notification reports the
error.  The operator cannot distinguish current empty state, a retained stale
value, a failed refresh, or a disconnected client from the projection itself.

The web surface refreshes more often through runtime events, but it composes
its own client-side refresh behavior.  A spinner, redraw, or local model epoch
is sometimes the only visible motion in the TUI; none proves that a worker,
reporter, or query transport is alive.  This creates a general situational-
awareness vacuum even when each domain source is individually correct.

ADR-091, ADR-092, and ADR-093 define missing domain producer contracts for
finalization progress, evidence transactions, and campaign-run attempts.  They
do not define the lifecycle of an arbitrary client projection.  Adding those
new payloads without a shared lifecycle would reproduce the same ambiguity on
new screens.  The product needs one typed boundary between canonical domain
truth and every operator renderer.

## Decision

Every operator-facing runtime projection MUST be carried in one versioned
`ProjectionLifecycle<T>` envelope.  Domain payloads remain owned by their
canonical producers; this envelope owns only observation, transport, freshness,
and resynchronization facts.  TUI and web may render the envelope differently,
but they may not infer lifecycle state from a payload, a spinner, or redraw
activity.

### 1. Closed lifecycle and retained-value semantics

The envelope has a closed lifecycle of `loading`, `ready`, `stale`,
`unavailable`, or `failed` and contains:

```json
{
  "schema_version": 1,
  "projection_id": "campaign.run.status",
  "lifecycle": "stale",
  "requested_at": "2026-08-25T18:00:00Z",
  "received_at": "2026-08-25T17:59:55Z",
  "source_cursor": "opaque-or-null",
  "source_version": "opaque-or-null",
  "fresh_for_ms": 5000,
  "expires_at": "2026-08-25T18:00:00Z",
  "transport": "connected",
  "resync": "not_required",
  "value": {},
  "last_failure": null
}
```

`loading` means a request is in flight and says whether a prior value is
retained.  `ready` means a successful value within its declared freshness
budget; an empty domain result is still `ready`, never `unavailable`.
`stale` means a previously successful value is retained after its budget or
after a later request failed.  `unavailable` means the source or capability is
not available and no usable value exists.  `failed` means a request failed and
no usable value exists.  A failure after success preserves the bounded old
value only as `stale` and records a typed, redacted `last_failure`; it may not
continue displaying it as ready.

Freshness budgets are registered by projection class at the runtime catalog,
not scattered through renderers.  The envelope exposes the effective budget
and timestamps.  A domain may select immediate expiry for authority-sensitive
state, but no renderer may invent a longer budget.  Wall-clock anomalies yield
`stale` with a typed clock reason rather than negative age or renewed freshness.

### 2. Transport, cursor, and resynchronization are explicit

`transport` is `connected`, `disconnected`, or `unknown`.  It describes the
query/event channel, never worker liveness.  Event-backed projections carry an
opaque source cursor/version when the producer supplies one.  A cursor gap,
overflow, restart, or reconnect sets `resync` to `required` until a bounded
snapshot refresh succeeds; clients must not silently bridge a gap with local
joins.  Polling is permitted where no event source exists, but its declared
maximum age must satisfy the same projection freshness budget.

TUI and web consume the same reducer and envelope semantics.  They may use
different delivery mechanisms only when parity tests prove the same lifecycle,
freshness bound, disconnect wording, resync behavior, and domain payload at
equivalent observation points.  Client-side `Promise.all` composition may not
discard a facet's failure reason or timestamp; each facet retains its own
envelope before any aggregate view is rendered.

### 3. Runtime liveness is distinct from renderer liveness

Status chrome MUST keep separate indicators for projection freshness,
transport state, reporter/worker heartbeat when the domain supplies one, and
local renderer activity.  A spinner or model epoch may indicate only that the
client is drawing or processing input.  It MUST NOT be labelled or positioned
as proof that a campaign, gate, evidence producer, session, or transport is
alive.

Active, attention-bearing projections show the age of their last successful
observation and, when applicable, last progress and last heartbeat separately.
The compact status bar prioritizes: terminal/refusal or action required;
disconnect/resync; overdue/stale; active domain progress; then no active work.
Detailed screens expose the exact timestamps, declared freshness/deadline, and
redacted failure/recovery reference.

### 4. Refresh is an explicit read-only action

Every screen has one standard read-only refresh action.  Refresh may request a
snapshot or resubscribe from a cursor; it may not dispatch work, clear a lease,
acknowledge cancellation, approve/review/adopt a result, or recover a campaign.
Automatic retry uses bounded backoff and remains visibly `loading`, `stale`, or
`failed`; it cannot turn repeated redraws into a success signal.

Domain-specific empty and unavailable captions remain.  The shared lifecycle
badge supplements them and does not erase provenance, review authority, gate
outcomes, or recovery constraints from the domain renderer.

### 5. Delivery and acceptance teeth

Before this record may be accepted, `gate:projection-lifecycle` MUST be
registered in `package.json` and the declarative execution profile and required
by prepush and CI.  Its fake-clock, fake-transport fixtures MUST prove:

1. never-fetched, loading, empty-ready, ready, stale-by-age,
   failed-after-success, unavailable, and failed-without-value states;
2. a retained value is visibly stale after a failed refresh and never silently
   cleared or presented as current;
3. disconnect, dropped cursor, required resync, successful snapshot resync, and
   bounded polling all use the declared catalog freshness policy;
4. status chrome distinguishes local renderer activity from worker/reporter
   heartbeat and transport/freshness state;
5. manual refresh is read-only and cannot invoke a mutation capability; and
6. TUI and web produce semantically equal envelopes for representative
   campaign-run, evidence, finalization, approvals, interviews, recovery,
   governance, and diagnostics projections.

The gate also scans registered operator projections so a new screen/query
cannot bypass the envelope or omit a freshness classification.  Acceptance
remains a separate operator act under ADR-059.

## Consequences

An operator can tell whether a value is current, retained but stale, still
loading, unavailable by capability, or failed, and can see whether an event
stream needs resynchronization.  TUI and web stop conveying different temporal
truth merely because one polls and the other receives events.  New ADR-091,
ADR-092, and ADR-093 projections enter the product through a reusable contract
instead of bespoke status indicators.

The cost is metadata beside every screen payload, a catalog-owned freshness
registry, a common reducer, cursor/resync handling, and broad renderer/parity
tests.  Some presently simple `unknown` screen state becomes explicit typed
state.  Honest stale/disconnected badges may make outages more visible; that is
the intended result, not additional system unreliability.

This record does not define domain progress, infer worker liveness, or grant
mutation authority.  It also does not authorize querying a remote CI provider.
Remote CI identity, credentials, retention, and authority require a separate
operator scope decision; local ADR-091 progress can still use this envelope.

## Alternatives / Roads not taken

1. **Add `last updated` text independently to each screen.** Rejected: it
   leaves failure retention, expiry, disconnect, and resync semantics as
   renderer conventions and guarantees drift.

2. **Clear every old value on a request error.** Rejected: it discards useful
   bounded context and makes a transient transport failure indistinguishable
   from a canonical empty result.  Retain-and-label-stale is more truthful.

3. **Treat the TUI spinner or web SSE connection as liveness.** Rejected: one
   proves only local rendering and the other only transport connectivity;
   neither proves domain work or recent data.

4. **Require every TUI surface to use streaming.** Rejected: bounded polling
   can meet the same temporal contract for low-frequency projections.  The
   contract governs age, loss, and resync rather than prescribing one transport.

5. **Build remote CI status into the generic envelope.** Rejected for now:
   the envelope can carry such a projection later, but it cannot decide provider
   authority, credentials, or retention on the operator's behalf.

## Obligations

### O1 — Every operator projection carries explicit lifecycle and freshness without presenting retained data as current

<!-- proof: symbol=ProjectionLifecycle file=packages/arbor-mcp/src/projection-lifecycle.ts roundtrip=packages/arbor-mcp/tests/projection-lifecycle.test.ts -->

`packages/arbor-mcp/src/projection-lifecycle.ts` implements the closed
`ProjectionLifecycle<T>` envelope and its pure reducers
(`initialProjectionLifecycle`, `beginProjectionRequest`,
`resolveProjectionSuccess`, `resolveProjectionFailure`,
`markProjectionUnavailable`, `checkProjectionFreshness`); freshness budgets
are registered per projection class in
`packages/arbor-mcp/src/projection-lifecycle-catalog.ts`'s
`PROJECTION_FRESHNESS_CATALOG`, resolved via `resolveProjectionFreshnessPolicy`
rather than invented by a renderer. `packages/arbor-mcp/tests/projection-lifecycle.test.ts`
drives every closed-lifecycle fixture named by Decision §5.1 (never-fetched,
loading-with-retained-value, empty-ready, ready, stale-by-age,
failed-after-success -> stale with the old value retained and never
re-presented as current, unavailable, failed-without-value) against an
injected fake `ProjectionClock`, plus the wall-clock-anomaly case (a clock
that appears to move backward yields `stale` with a typed `clock_anomaly`
reason, never negative age or a renewed budget). `gate:projection-lifecycle`
(`scripts/projection-lifecycle-gate.mjs`) runs this suite as its blocking
check. Registering the gate in `package.json`/the execution profile and
wiring the envelope into a live producer (`ArborRuntime`/CLI/TUI/web) beyond
the `projectCampaignRunStatusLifecycle` wrapper in
`projection-lifecycle-catalog.ts` is out of this tranche's file ownership
(`runtime.ts`, `cli.ts`, and `arbor-tui/**` belong to the concurrent ADR-107
lane) — this obligation resolves the envelope and freshness-registry
contract Decision §5 requires exist and be gate-proven, not full runtime
wiring, which remains tracked separately.

### O2 — TUI and web expose equivalent disconnect, cursor-loss, resync, and refresh semantics

<!-- unverifiable: packages/arbor-mcp/src/projection-lifecycle.ts's reducer and packages/arbor-mcp/src/projection-lifecycle-catalog.ts's catalog now exist and are unit-proven, but the cross-surface TUI/web parity fixtures Decision §5.6 requires need packages/arbor-tui/** and the CLI/TUI/web adapters in runtime.ts/cli.ts, all owned by the concurrent ADR-107 lane this tranche, not this one. -->

The required parity tests must drive equivalent snapshots and event gaps
through both clients and compare their semantic envelopes and declared age
bounds.

### O3 — Renderer activity never masquerades as runtime liveness or mutation authority

<!-- unverifiable: the classifier (classifyProjectionStatusPriority, ProjectionStatusFacets) and the read-only refresh (refreshProjection, ProjectionReadCapability) were deleted in 1496dcca on the 2026-10-01 operator decision (5002e009) because no TUI/web read path ever consumed them; O3 is owed again with O2's consumer and must be re-derived there. -->

This obligation was once implemented as a pure classifier and a read-only
refresh capability in `packages/arbor-mcp/src/projection-lifecycle.ts`. Both
were removed on 2026-10-01: nothing outside their own module, its index
re-export and its unit test ever called them, and the operator chose deletion
over renewing their reachability waivers. Decision §3 (separate renderer and
heartbeat indicators) and §4 (refresh with no mutation authority) therefore
have no implementation today. Whoever builds the subscribing TUI/web read path
under O2 owns re-deriving both, with tests against a real screen rather than
against an unconsumed reducer.

### Acceptance note

This record remains Proposed.  Its obligations describe future implementation
and do not claim that any current TUI/web payload is fresh, live, or synchronized.
