# ADR-097: Durable Authority Transitions Require Store-Owned Serialization and Cross-Store Coherence

**Status:** Accepted
**Date:** 2026-08-25
**Authoring Revision:** 999de38b53dbba1e528a1d20ad90829b73b751a9
**Content ID:** sha256:9b8b5de1930ab9eecb19afa1932a1a5c990530a2b51e75c6e0fd1bbd63d7358f

## Context

The audit found several stores that use atomic replacement correctly yet still
lose or duplicate authority transitions. Independent scheduler callers can
launch the same due run because there is no durable pre-launch claim. Native
campaign-budget and token-epoch services perform read-check-write sequences
without store-owned interprocess serialization, so concurrent reservations,
claims, settlement, reconciliation, or usage observations can overwrite one
another. SDK installation metadata can survive a registry revision/root
change, persisted plugin component bytes are accepted without binding to the
signed revision, and a durable verified-result row can be emitted as current
without joining live campaign/node disposition.

ADR-029 provides a broad one-writer process convention and ADR-055/092 provide
content-freshness and evidence-transaction mechanisms. Neither makes an
exported store service safe when two independently constructed instances share
a directory, nor does atomic rename coordinate multiple authority stores. Step
0 must define the owner and failure semantics before each affected service is
fixed independently.

## Decision

Every durable state transition that grants dispatch, spend, one-shot claim,
execution, or current-result authority MUST be owned by the narrowest durable
store service, not by an assumed outer CLI lock or by its consumers.

### 1. Store-owned transition protocol

Within a key-scoped interprocess lock or compare-and-swap boundary, the service
reloads current state, validates schema/integrity and semantic compatibility,
checks the expected version/idempotency key, computes one closed transition,
atomically publishes the successor, and returns a durable receipt. A caller
may act only on the receipt that grants authority. Atomic file replacement is
the publication primitive, not the concurrency protocol.

Schedules return `claimed`, `already_claimed`, `stale_version`, or
`unavailable` before launch and reconcile claimed-unsettled history after
restart. Campaign budgets return one durable reservation before dispatch and
serialize initialize, reserve, settle, and orphan reconciliation. Token epochs
serialize ensure, warning/management claims, and usage recording with explicit
`created`, `existing`, `claimed`, `idempotent`, `conflict`, or `recorded`
outcomes. Conflicting provider observations cannot be resolved by last writer
wins.

The protocol MUST work for two direct service instances sharing a persistence
directory. ADR-029's root writer lock remains defense in depth for normal CLI
composition but is not part of the service correctness proof.

### 2. Multi-store changes expose one recoverable lifecycle

When authority spans stores, a coordinator persists a versioned transaction
identity and intended before/after bindings before publishing. Readers return
`unavailable` or the last fully compatible authority while a transition is
pending; they never join a new registry row to old SDK metadata or a new
manifest to old payload. Recovery deterministically completes or rolls back
the named transition and retains its receipt. There is no same-id fallback.

SDK execution binds exact signed manifest/version, resolved root, tier,
activation, health policy, and rollback pairing. Plugin command/hook/skill
snapshots bind every component byte and aggregate digest to that signed
revision and immutable artifact/root identity before catalog registration.
Missing roots, changed trust, or mismatched snapshots register nothing.

Authority-bearing generated evidence uses an analogous complete staged
snapshot: manifest plus every payload digest/count is validated through the
reader before directory publication. ADR-092's transaction lease coordinates
the writer but does not substitute for payload identity.

### 3. Current-result authority is a live join

Durable verification evidence remains append-only history. A manager-owned
projection joins `(campaign_id,node_id)`, live campaign/node disposition,
result/capture identity, and supersession into `active_verified`, `historical`,
`subject_missing`, `node_not_verified`, `superseded`, or `unavailable`. ACP and
catalog current-result reads use only that projection; an explicitly
historical query may return the raw evidence.

### 4. Compatibility and retention

Settled budgets, completed epochs, schedule attempts, replaced SDK rows,
component snapshots, evidence snapshots, and verification results remain
inspectable history. Exact key or plugin id reuse never reactivates them.
Changed policy, pricing, ceilings, capability, model/context, registry
revision, root, trust, or subject disposition yields an explicit compatible,
rebase, historical, invalid, or unavailable result owned by the domain.

## Consequences

The system gains one mechanical answer to duplicate launch, double admission,
lost usage, split registry state, unauthenticated component replay, mixed
evidence, and stale current-result projection: no side effect occurs without a
store-owned receipt for a compatible transition. Direct composition becomes a
first-class test boundary instead of relying on CLI topology.

The cost is keyed locks/CAS, version fields, idempotency semantics, transaction
journals, recovery paths, compatibility projections, and two-process barrier
tests. Some reads will become explicitly unavailable during recovery rather
than presenting a convenient but incoherent value. Marketplace cache
revalidation, historical analytics, and UX-only stores remain separate
positive controls and are not rewritten for superficial uniformity.

## Alternatives / Roads not taken

1. **Rely on ADR-029's outer process lock.** Rejected because exported
   services and direct runtime composition can share storage without that
   caller convention.
2. **Use atomic rename alone.** Rejected because two writers can each read the
   same predecessor and atomically publish different successors.
3. **Reconstruct cross-store truth opportunistically at read time.** Rejected
   because same-id fallback can execute stale roots or component bytes and
   conceals incomplete publication.
4. **Delete historical rows after settlement or replacement.** Rejected
   because accounting, audit, rollback diagnosis, and verification provenance
   require history; the defect is retained authority, not retention itself.

## Obligations

### O1 — Competing direct service instances cannot duplicate or lose a granted transition

<!-- unverifiable: the store-owned transition protocol and two-process barrier suites are future implementation work. -->

Acceptance requires same-directory one-process and two-process barriers for
schedule claim, budget reserve/settle/reconcile, and token create/claim/usage,
including crash recovery and explicit loser dispositions.

### O2 — Cross-store execution and evidence readers expose only a fully compatible published generation

<!-- unverifiable: registry/SDK coordination, component authenticity, and complete evidence snapshot loaders are future work. -->

Acceptance requires crash-point, mutation, root-loss, trust-change,
manifest/payload split, and rollback fixtures proving old-compatible or
unavailable results, never mixed authority or catalog registration.

### O3 — Historical verification evidence cannot be presented as a current result after its subject changes

<!-- unverifiable: the manager-owned verification applicability projection and ACP/catalog equality tests do not exist at authoring time. -->

Acceptance requires live, missing, failed, pruned, retired, superseded, and
capture-mismatched fixtures across ACP and catalog plus an explicit historical
query that retains evidence without current authority.

### Acceptance note

This record remains Proposed. Acceptance is a separate operator act under
ADR-059 after the native decision interview selects the serialization,
coherence, and retention policy.
