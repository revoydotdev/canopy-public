# ADR-004: Envelope Pattern for KB Reads

**Status:** Accepted
**Date:** 2026-07-31

## Context

When an agent reads from the KB, it needs more than just the data — it needs metadata about freshness, source, and access rights. A raw data read forces the agent to guess whether the data is current, verified, or accessible at its tier.

## Decision

Every KB read returns an **envelope**: `{value, provenance, as_of, id, absence}`.

- `value`: The KB entry data, or null if absent.
- `provenance`: How the entry was established (verified/claimed/critic_approved/generated).
- `as_of`: A cursor (`iter:N` or `sha:XXXXXXX`) indicating freshness.
- `id`: Stable identifier for the entry.
- `absence`: If value is null, a reason (`not_found`, `not_yet_attempted`, `capability_required`, `retracted`).

## Consequences

**Positive:** The scoring function can reason about entry freshness and trust level. The agent can distinguish "no known failure mode" from "the KB was never queried for this." Capability gating is structural — a specialist sees `absence: capability_required` rather than silently missing data.

**Negative:** Slightly more complex read API (envelope vs raw value). Agents must unwrap the envelope.

**Neutral:** The `as_of` cursor format (`iter:N` vs `sha:XXXXXXX`) is flexible enough to support both iteration-based and git-based freshness tracking.

## Alternatives Considered

1. **Raw data reads.** Rejected: loses freshness, provenance, and absence metadata. The scoring function can't trust the data without knowing how it was established.

2. **Metadata as separate query.** Rejected: requires two round-trips per read and risks inconsistency between data and metadata.

## Source

Derived from revoy-spec's REVOY-Q (ADR-004), which defines the envelope as `{value, provenance, as_of, id, absence}`. The concept is independently implemented here.

## Obligations

### O1 — Every KB read returns an envelope (`{value, provenance, as_of, id, absence}`), never raw entry data

<!-- proof: symbol=Envelope file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-kb/tests/kb.test.ts -->

### O2 — Absence is a typed reason, not a bare null, so "never queried" is distinguishable from "queried and not found"

<!-- proof: symbol=AbsenceReason file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-kb/tests/kb.test.ts -->

### O3 — Capability gating happens at envelope construction (the read path), not at storage — a specialist sees `absence: capability_required` rather than the entry silently disappearing

<!-- proof: symbol=KnowledgeBase file=packages/arbor-kb/src/kb.ts roundtrip=packages/arbor-kb/tests/checks-and-balances.test.ts -->
