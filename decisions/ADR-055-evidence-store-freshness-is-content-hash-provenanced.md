# ADR-055: Evidence-store freshness is content-hash-provenanced

**Status:** Accepted
**Date:** 2026-08-12
**Authoring Revision:** d13506cbf931b422aa9b0fef25718e54d0fecd46
**Content ID:** sha256:9bb9eef84f277e3f69439622b4e81bea01b4bea6a2bb0bab88e8e400d43d2385

## Context

The four committed evidence stores recorded the commit that produced them and
the freshness gate required that commit to remain an ancestor of HEAD. Rebasing
an unchanged tree therefore invalidated valid evidence, while an ancestor SHA
could not detect changed input bytes. Parallel branches also collided in store
manifests and measurement snapshots that should have had one integration-time
writer.

The Automerge precedent summarized in
`docs/research/concurrent-integration-frontier-brief.md` §2 separates causal
content identity from mutable repository commit identity. ADR-034 separately
requires determinism measurement to remain off the critical path; centralizing
its refresh at integration preserves that constraint.

## Decision

Evidence-store freshness is keyed by a shared SHA-256 digest of sorted repository
input paths and bytes, excluding the four generated stores themselves. Each
manifest records `content_hash`; `scanned_up_to_revision` remains diagnostic and
never overrides a matching or mismatching content hash. A PID-validated marker
in the git common directory identifies a conductor-owned regeneration already
in flight; stale or malformed markers grant no exemption.

The stores use two distinct integration disciplines:

- `.claim-ledger/claims.jsonl` and
  `.visual-intelligence/observed/*.jsonl` are additive JSONL stores. Their merge
  driver takes set union, canonicalizes and sorts records, deduplicates identical
  records, and refuses a same-ID/different-content semantic conflict.
- `.determinism-baseline/` and `.completion-depth/` are measurement snapshots.
  Feature-branch copies are discarded by the conductor after rebase and before
  verification; only the integration phase may refresh and commit them.

The recorded commit remains useful for explaining when a store was produced and
for computing advisory distance when its object remains available. It is not
proof of byte identity.

## Obligations

### O1 — Content identity survives commit rewriting and detects changed bytes

<!-- proof: symbol=computeEvidenceContentHash file=scripts/lib/store-provenance.mjs roundtrip=scripts/tests/store-provenance.test.mjs -->

### O2 — Additive JSONL merging preserves branch records and refuses semantic conflicts

<!-- proof: symbol=mergeJsonlTexts file=scripts/lib/union-sorted-jsonl-merge.mjs roundtrip=scripts/tests/store-provenance.test.mjs -->

### O3 — Branch-local measurement snapshots cannot authorize landing

<!-- proof: symbol=landBranch file=scripts/lib/conductor/land.mjs roundtrip=scripts/tests/integration-conductor.test.mjs -->

## Consequences

An unchanged rebase no longer destroys provenance, and changed source bytes can
no longer pass merely because a recorded commit is an ancestor. Additive records
survive concurrent branches without last-writer loss. Snapshot production has a
single authority and stays compatible with ADR-034's manual, off-critical-path
measurement model.

The shared digest deliberately covers the repository inputs as one conservative
set rather than maintaining four subtly different dependency inventories. This
can request an unnecessary refresh when an unrelated input changes, but cannot
silently bless a store after a relevant input changes. The union driver is not a
semantic conflict resolver: conflicting values under one durable ID remain an
operator decision.
