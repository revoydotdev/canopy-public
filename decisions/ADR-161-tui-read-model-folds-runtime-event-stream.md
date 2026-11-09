# ADR-161: The TUI read model folds the canonical runtime event stream

**Status:** Accepted
**Date:** 2026-09-18
**Authoring Revision:** 58c52c3baf005330eec4f0453b39c7bd47bf4062
**Content ID:** sha256:beff266f802a9b394cf85114b93d420f6ff1f6fc1e42f8c21595fec18e0008a7

## Context

The operator's TUI-overhaul brief (milestone M1, `docs/tui-overhaul/tasks.md`) requires versioned event envelopes, snapshot-plus-delta subscription, duplicate handling, gap detection, stale-version rejection and deterministic replay behind the TUI. The M0 audit (`docs/tui-overhaul/architecture.md`) found that the substrate already exists: `RuntimeEventStream` (`packages/arbor-core/src/event-stream.ts`) assigns `{stream_id, sequence}` cursors server-side, rejects duplicate ids, serves `resume(cursor)` as snapshot, events or resync, and closes a bounded subscriber on backpressure instead of dropping events. The TUI did not use that substrate for state. `runTuiUnsafe` subscribed only to detect campaign halts, then re-queried the whole product surface. The same loop read `envelope.sequence`, which does not exist (the sequence lives at `envelope.cursor.sequence`), so every canonical-event render-latency key silently fell back to `Date.now()`.

Every surface the overhaul adds (the right-zone gate/approval state, the Inspect tab, live UCT state) needs a bounded, incrementally maintained projection whose staleness is explicit. Polling the full surface cannot say whether it is stale, and it cannot tell duplicated, reordered or missing events apart.

## Decision

1. **A read-side event seam on the TUI port.** `RuntimeEventSource` (`packages/arbor-tui/src/runtime-port.ts`) is an optional `events` member of `RuntimePort`. It has two methods:
   - `subscribe()` returns a bounded `RuntimeEventSubscription`;
   - `resume(cursor)` goes through the catalog's own `event.resume` query, so the resume path stays under the `event.read` capability check.

   The seam reuses `@arbor/core`'s cursor, envelope and subscription types rather than mirroring them. `RuntimePortAdapter` (`packages/arbor-mcp/src/tui-adapter.ts`) implements it over `RuntimeCatalogRouter.eventStream`, a read-only passthrough getter.
2. **A pure, versioned projection.** `packages/arbor-tui/src/read-model.ts` (`TUI_READ_MODEL_VERSION = 1`) folds envelopes into bounded maps of supervisor tasks, operation outcomes, latest gate results and tree-node states. It uses `emptyReadModel`, `applySnapshot` and `applyEnvelopes`. Watermark rules:
   - a foreign `stream_id` is rejected;
   - `sequence ≤ watermark` is a counted duplicate;
   - `sequence > watermark + 1` or a `stream.truncated` event sets `resync_required`, and no later envelope is applied until a snapshot re-seeds the model;
   - a task's terminal state for a given `retry_attempt` is never overwritten by a non-terminal event;
   - a lower attempt never overwrites a higher one.
3. **Composition-root wiring.** `runTuiUnsafe` feeds the existing subscription's polls through `applyEnvelopes`. On `resync_required` it re-seeds through `events.resume`. The whole-surface refresh stays in place and is still what gets rendered until the M2 surfaces consume the projection. The `envelope.cursor.sequence` bug is fixed.
4. **Import discipline is asserted, not assumed.** `wiring-audit.test.ts` statically fails if any `packages/arbor-tui/src` module imports `@arbor/mcp` or `child_process`, or calls an `fs` write API.

## Consequences

- TUI surfaces can render incremental state with an explicit watermark and an explicit "resync required" condition, instead of implying freshness.
- Replay is deterministic: identical envelope sequences produce deep-equal models, and every permutation or duplication either reproduces the in-order result or is flagged `resync_required`.
- Harder / residual:
  - `subscribe()` is not capability-checked. It is a raw in-process handle on the stream, the same access the composition root already had before this decision, and the same precedent `devtools.stream` documents. Only `resume()` is gated. A future out-of-process TUI must gate `subscribe()` too.
  - Terminal-state protection survives map eviction through per-id terminal tombstones, bounded at `max_terminal_tombstones` (65,536). Past that bound, protection for the oldest evicted terminal tasks rests on the canonical stream's own ordering.
  - Gap, truncation and foreign-stream outcomes are reported to the TUI diagnostics ring (source `read-model`), not only acted on.
  - `applySnapshot` does not yet decode a runtime snapshot into the projection maps; no producer emits one in that shape. A resync therefore restarts the projection empty at the snapshot cursor. Surfaces must show that as "resynced", never as "nothing is running".
- Unchanged: the command path (`RuntimePort.command` → `RuntimeCatalogRouter.dispatchCommand` → `enforceAction`), `RuntimeEventStream` itself, and ADR-011's model/update/effect split.

## Alternatives / Roads not taken

- **A new TUI-owned event bus or durable event store.** Rejected. `RuntimeEventStream` already provides server-assigned ordering, duplicate rejection and resync. A second bus would be a competing source of truth and would need its own ordering guarantees.
- **Keep whole-surface polling and diff the results.** Rejected. Polling cannot separate a missing event from an unchanged state, cannot expose a watermark, and scales with surface size rather than with change rate.
- **Route `subscribe()` through a new catalog query kind.** Deferred rather than rejected. A polling handle is not a request/response query, so gating it needs a subscription-capability concept the catalog lacks. The in-process composition root already held the raw stream, so this decision does not widen access.

## Obligations

### O1 — The read model never silently diverges from the canonical stream

Duplicates are ignored, gaps, truncation and foreign streams are refused with an explicit outcome, and terminal attempts are never resurrected. The roundtrip test drives replay determinism and random permutations or duplications of a fixed log through `applyEnvelopes`.

<!-- proof: symbol=applyEnvelopes file=packages/arbor-tui/src/read-model.ts roundtrip=packages/arbor-tui/tests/read-model.test.ts -->

### O2 — The TUI's event seam is bounded and cannot cancel runtime work

`RuntimePortAdapter.events` is driven by a real `RuntimeEventStream` in its roundtrip test. Publishing continues after a subscriber closes. A full subscriber closes with reason `backpressure` instead of dropping events. A TUI command lacking capability is denied by the real router.

<!-- proof: symbol=RuntimePortAdapter file=packages/arbor-mcp/src/tui-adapter.ts roundtrip=packages/arbor-mcp/tests/tui-adapter.test.ts -->

### O3 — The TUI package has no privileged side channel

No `packages/arbor-tui/src` module imports `@arbor/mcp` or `child_process`, or writes files. State reaches the TUI only through `RuntimePort` and its `RuntimeEventSource` seam. The roundtrip test asserts this statically over the package source.

<!-- proof: symbol=RuntimeEventSource file=packages/arbor-tui/src/runtime-port.ts roundtrip=packages/arbor-tui/tests/wiring-audit.test.ts -->
