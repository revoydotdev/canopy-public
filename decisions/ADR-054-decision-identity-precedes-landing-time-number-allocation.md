# ADR-054: Decision Identity Precedes Landing-Time Number Allocation

**Status:** Accepted
**Date:** 2026-08-12

This is the last manually numbered revoy2 decision. The registry it establishes assigns every later number at landing time.

## Context

Parallel roadmap branches repeatedly selected the same apparent next ADR number. Two branches chose 044 and two chose 047. Worse, local sequential numbers share their visible token space with citations into revoy-spec: an attempted local ADR-045 would have changed ADR-027's deliberately external tier citation into an apparently local reference.

Django's fork-and-merge migration model and Atlas's non-linear execution mode demonstrate the useful separation: stable identity is created with the work, while canonical arrival order is assigned at integration. ADR-029 already establishes the relevant concurrency discipline inside revoy2: one writer owns a persistence surface at a time.

## Decision

Decision identity and human-facing decision number are separate facts. An author creates `ADR-PENDING-<slug>.md` with a SHA-256 content id over its title, creation date, and authoring revision. A pending draft is not an allocation and does not contribute to `adr_total`.

At landing, one allocator holds a lock in Git's common directory, reads `decisions/registry.json`, skips every permanently reserved cross-namespace number, assigns the next available number, renames and rewrites the draft, updates the decision index and registry, and commits only those files. The integration conductor invokes this allocator after rebasing and before verification.

The registry is the source for both allocation and the governance ADR count. Legacy local decisions that already overlap external citation numbers remain disclosed in both allocations and the reserved set; new allocation can never repeat them.

## Consequences

Authoring branches cannot race for a number because they contain no number to race over. Landing order determines numbering exactly once. Cross-namespace reservations are machine-verified against the decision corpus, and a missing reservation makes the canonical build fail.

The registry is a single-writer artifact. Direct edits remain possible to a repository writer, but verification catches duplicate numbers, missing files, missing reservation reasons, and citation coverage drift.

## Obligations

### O1 — Sequential and concurrent allocations never repeat a number

<!-- proof: symbol=allocateDecision file=scripts/lib/adr-registry.mjs roundtrip=scripts/tests/adr-registry.test.mjs -->

### O2 — Reserved cross-namespace numbers are skipped

<!-- proof: symbol=nextAllocation file=scripts/lib/adr-registry.mjs roundtrip=scripts/tests/adr-registry.test.mjs -->

### O3 — Every discovered cross-namespace decision citation is reserved

<!-- proof: symbol=verifyRegistry file=scripts/lib/adr-registry.mjs roundtrip=scripts/tests/adr-registry.test.mjs -->

### O4 — Pending drafts do not contribute to the governance ADR count

<!-- proof: symbol=deriveRepositoryCounts file=packages/arbor-governance/src/counts/derive.ts roundtrip=packages/arbor-governance/tests/counts/derive.test.ts -->
