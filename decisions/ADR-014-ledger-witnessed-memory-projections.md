# ADR-014: Runtime Memory Is a Ledger-Witnessed Projection

**Status:** Accepted
**Date:** 2026-08-01

## Context

ADR-010 established useful short-term and long-term KB scopes, while ADR-003
requires provenance on every KB fact. The clean-room memory comparison in
Appendix E adds a stricter durability insight: a system should have one
cross-thread authority, and consolidation must remain a projection rather than
replace raw evidence. Independently authoritative KB and audit stores could
otherwise disagree after a crash or partial write.

Repository instructions are a different scope. Checked-in `AGENTS.md` and other
repo intent must remain files in the repository; copying them into runtime
memory would create stale competing instructions.

## Decision

The append-only audit ledger is the authoritative witness for runtime memory.
The KB retains ADR-010's campaign and cross-campaign query scopes, JSONL/SQLite
materializations, capability projection, and provenance types, but becomes a
rebuildable materialized view over ledger-witnessed memory facts.

A memory-producing transition journals the provenance-typed fact and its source
evidence before the governed node transition becomes observable. The projected
KB entry carries the evidence pointer and deterministic identity. Rebuilding or
deleting a projection cannot delete its ledger evidence. Projection mismatch is
a recovery diagnostic, not permission to invent or silently discard facts.

Each node persists a memory mode: `accumulate` retains relevant raw evidence;
`consolidate` permits bounded derived projections. Children inherit the mode at
branch time. Backtracking does not erase witnessed evidence. Consolidation is
provenance-typed, bounded, subtree-scoped, and never upgrades trust.

Runtime context combines checked-in repo intent with capability-filtered facts
relevant to the selected node's ancestry/subtree. Global runtime memory is not
blanket-injected into every leaf. Presentation/session state is never runtime
memory authority.

## Consequences

**Positive:** Crash recovery has one authority; KB indexes can be rebuilt; raw
evidence survives pruning/compaction; repo instructions cannot become stale
ledger copies.

**Negative:** Existing KB snapshots require a migration/witnessing policy, and
memory-producing transitions gain an additional durable checkpoint.

**Neutral:** ADR-010's dual-level semantics remain, but its storage wording is
superseded where it implied an independently authoritative memory store.

## Test implications

- Rebuilding an empty KB projection from a ledger yields identical scoped facts.
- A projected fact without a valid ledger witness is rejected or quarantined.
- Crash tests stop between memory journaling, projection publication, and tree
  transition, with deterministic reconciliation at every boundary.
- Branches inherit memory mode; backtracking retains evidence; consolidation
  cannot change provenance or expose critic-only facts.
- Repo instruction files are referenced/read as repo context and never copied
  into runtime memory records.

## Alternatives considered

1. **Keep KB and audit independently authoritative.** Rejected because partial
   writes can produce irreconcilable memory after restart.
2. **Remove the KB.** Rejected because bounded typed query projections and
   ADR-010's scopes remain valuable.
3. **Store summaries as authority.** Rejected because summarization is lossy and
   can launder provenance.

## Obligations

### O1 — A memory-producing transition journals the fact and its evidence as its own ledger record kind

<!-- proof: symbol=MemoryFactRecord file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/memory-fact.test.ts -->

### O2 — The KB is a rebuildable materialized view, never independent authority

An empty projection rebuilt from the ledger yields identical scoped facts
with evidence pointers.

<!-- proof: symbol=projectMemoryFacts file=packages/arbor-mcp/src/memory-projector.ts roundtrip=packages/arbor-mcp/tests/memory-projector.test.ts -->

### O3 — A child inherits its parent's memory mode at branch time

Each node persists `accumulate` or `consolidate`; a child does not default
independently.

<!-- proof: symbol=createChild file=packages/arbor-core/src/tree.ts roundtrip=packages/arbor-core/tests/tree.test.ts -->

### O4 — Checked-in repository instructions never reach the ledger as a memory fact

AGENTS.md/CLAUDE.md content stays a repo-context reference and is never
copied into a witnessed record.

<!-- proof: symbol=resolveRepoInstructions file=packages/arbor-prompts/src/repo-instructions.ts roundtrip=packages/arbor-prompts/tests/repo-instructions-ledger-exclusion.test.ts -->
