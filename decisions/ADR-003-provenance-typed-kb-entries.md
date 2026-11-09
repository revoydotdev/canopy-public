# ADR-003: Provenance-Typed KB Entries

**Status:** Accepted
**Date:** 2026-07-31

## Context

The Knowledge Base accumulates findings across tree-search iterations. Without provenance tracking, the KB is just data — there's no way to distinguish a finding that was machine-verified from one that was merely asserted. This distinction matters because the scoring function adjusts priors based on KB entries: trusting an unverified claim would poison future iterations.

## Decision

Every KB entry carries a provenance tag from a closed enum:

- `verified`: A command was run (`cmd`) and exited with the expected code (`exit`). Machine-checkable.
- `claimed`: Asserted by an agent (`claimant`) but not machine-verified.
- `critic_approved`: Approved by a Critic agent (`critic`) with a rationale, but no verification command was run.
- `generated`: Machine-generated artifact (`generator`) from known inputs (`input_hash`).

Only `verified` provenance allows a tree node to transition to the `verified` state. `critic_approved` nodes become `claimed` — they're good enough to branch from, but the audit trail distinguishes them from machine-verified work.

## Consequences

**Positive:** The KB is trustworthy. The scoring function can weight verified entries higher than claimed entries when adjusting regression priors. The audit trail distinguishes verified from claimed branches, so an auditor can see exactly which results are machine-proven.

**Negative:** Agents must run verification commands (tests, linters, builds) to get `verified` status. This adds latency — a `claimed` result is faster but less trustworthy.

**Neutral:** The provenance types are a closed set. Adding a new type (e.g., `human_approved`) requires a code change, not just data.

## Alternatives Considered

1. **No provenance (flat data).** Rejected: the KB becomes untrustworthy. The scoring function can't distinguish verified from asserted, so it would adjust priors based on unverified claims.

2. **Binary trust flag (trusted/not-trusted).** Rejected: loses the distinction between machine-verified, critic-approved, and generated. The audit trail needs this granularity.

3. **Free-text provenance.** Rejected: not machine-parseable. The scoring function needs a structured tag, not a description.

## Source

Derived from revoy-spec's `.revoy` format (ADR-010), which makes provenance a first-class type: `!verified(cmd⇒exit)`, `!claimed`, `!generated`. The concept is independently implemented here.

## Obligations

### O1 — Provenance is a closed four-tag type (`verified` / `claimed` / `critic_approved` / `generated`), each carrying required fields, not a free-text description

<!-- proof: symbol=Provenance file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-core/tests/tree.test.ts -->

### O2 — Only `verified` provenance transitions a tree node to the `verified` state; `critic_approved` becomes `claimed`

<!-- proof: symbol=verifyNode file=packages/arbor-core/src/tree.ts roundtrip=packages/arbor-core/tests/tree.test.ts -->

### O3 — A KB entry crossing a runtime boundary (JSONL import, MCP-facing write) with malformed or incomplete provenance is rejected, not silently accepted

<!-- proof: symbol=isValidKBEntry file=packages/arbor-kb/src/kb.ts roundtrip=packages/arbor-kb/tests/kb.test.ts -->
