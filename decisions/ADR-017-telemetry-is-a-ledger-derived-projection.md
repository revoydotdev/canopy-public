# ADR-017: Telemetry Is a Ledger-Derived Projection

**Status:** Accepted
**Date:** 2026-08-01

## Context

revoy2 has audit records, runtime events, SSE, and surveillance, but lacks one
canonical model for timing, token/cache usage, provider cost, counters, and
histograms. Mutable metrics updated beside the ledger could drift after crashes
or duplicate replay, recreating the stale-derived-count failure class.

## Decision

The audit ledger records bounded provenance-typed observations for tree-loop
phase timing and provider/model usage/cost. Every observation identifies its
campaign, node, operation/epoch, phase, unit, and source evidence. Monetary
values use an exact integer minor-unit representation plus currency/price-source
identity, never binary floating-point authority.

Counters, histograms, timings, and cost summaries are deterministic bounded
projections over those records. Projection rows carry the producing ledger
record/hash pointer. Runtime/web/TUI metric events are presentation and can be
discarded/rebuilt; they never authorize a transition or gate the loop.

Metric names and tag keys are a closed revoy2-owned catalog with explicit
cardinality bounds. Arbitrary user/model text is not a tag. Observation time is
supplied by the runtime for deterministic replay.

## Consequences

**Positive:** Observability is auditable, restart-stable, cost-aware, and cannot
silently diverge from campaign evidence.

**Negative:** Fine-grained timing adds ledger volume and requires batching/
retention projections without removing raw evidence.

**Neutral:** External telemetry exporters may consume the projection but are not
authority and may lose data without affecting campaign correctness.

## Test implications

- Rebuilding an empty metric projection yields byte-equivalent aggregates.
- Duplicate/replayed observations do not double-count; conflicts are detected.
- Phase durations, token/cache totals, and exact costs retain evidence pointers.
- Unknown names/tags and cardinality overflow fail validation.
- Exporter failure cannot mutate or halt a campaign.

## Alternatives considered

1. **Increment in-memory counters directly.** Rejected because restart/replay can
   drift.
2. **Use logs as metrics authority.** Rejected because free text is not typed or
   provenance linked.
3. **Let providers define metric names/tags.** Rejected because cardinality and
   compatibility would be uncontrolled.

## Obligations

### O1 — Rebuilding an empty metric projection yields byte-equivalent aggregates

Counters, histograms, and cost summaries are deterministic projections over
the ledger.

<!-- proof: symbol=projectTelemetry file=packages/arbor-mcp/src/metrics-projector.ts roundtrip=packages/arbor-mcp/tests/metrics-projector.test.ts -->

### O2 — Monetary amounts use an exact integer minor-unit representation, never a fabricated zero

An unpriced call carries a typed reason instead of a hardcoded zero amount.

<!-- proof: symbol=Cost file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-mcp/tests/metrics-projector.test.ts -->

### O3 — Duplicate or replayed observations do not double-count

A conflicting observation under the same idempotency key is detected rather
than silently overwritten.

<!-- proof: symbol=TelemetryObservationInput file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/telemetry.test.ts -->

### O4 — Metric phase, provider, model-family, and outcome vocabularies are closed catalogs

They are revoy2-owned, not arbitrary user/model text.

<!-- proof: symbol=TelemetryPhase file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/telemetry.test.ts -->
