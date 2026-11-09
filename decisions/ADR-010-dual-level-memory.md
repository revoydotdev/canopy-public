# ADR-010: Canonical Retained Memory

**Status:** Accepted
**Date:** 2026-07-31

## Context

The KB needs durable reusable patterns while still allowing campaign-scoped
queries. The previously implemented second in-memory map duplicated failure
mode entries without changing any observable read: every id was already in the
canonical store before the second query branch considered it.

## Decision

Use one **canonical retained-memory store**. Every knowledge entry is retained
once; reads apply campaign, type, tag, and capability filters. A future
ephemeral memory feature must define distinct visibility, expiry, and retrieval
semantics before adding a second store.

## Consequences

**Positive:** One authoritative representation makes persistence and visibility
auditable; no read branch can silently differ from its retained evidence.

**Negative:** There is no ephemeral rejection-notepad behavior today. It must
be specified and independently tested if product requirements call for it.

**Neutral:** Campaign-specific filtering remains available over the same store;
it is not evidence of a separate memory tier.

## Alternatives Considered

1. **Duplicate short-term memory.** Rejected after G-38: the former duplicate
   was neither independently visible nor independently durable, so retaining it
   would have asserted semantics the implementation did not provide.

2. **Vector-store-backed memory.** Rejected for Phase 0: adds embedding model dependency. Track for Phase 3 if semantic search over KB entries becomes valuable.

## Source

The prior dual-level inspiration was reconsidered after G-38 established that
the implemented second map was a no-op. This ADR keeps only semantics the
runtime can evidence.

## Obligations

### O1 — `success_pattern` and `parameter_finding` entries persist as long-term memory, on disk under distinct files (`kb/success-patterns.jsonl`, `kb/parameter-findings.jsonl`), and survive across campaigns

<!-- proof: symbol=saveKBProjection file=packages/arbor-kb/src/persist.ts roundtrip=packages/arbor-kb/tests/persist.test.ts -->

### O2 — Every retained KB entry has one canonical in-memory representation and campaign filtering happens on query

<!-- proof: symbol=KnowledgeBase file=packages/arbor-kb/src/kb.ts roundtrip=packages/arbor-kb/tests/kb.test.ts -->
