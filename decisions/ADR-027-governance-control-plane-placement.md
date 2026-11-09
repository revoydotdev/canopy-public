# ADR-027: The governance control plane is a bounded package over the existing ledger

**Status:** Accepted
**Date:** 2026-08-04

> **Authored as Draft on `feat/adr-governance-control-plane`.** The
> implementing agent does not hold acceptance authority (see ADR-045-tier
> conventions and the checks-and-balances non-negotiable in AGENTS.md: no agent
> both proposes and approves). This record exists so the placement decision the
> implementation depends on is visible and reviewable rather than improvised in
> code, and it required ratification by a human reviewer before the branch
> merged.
>
> **Accepted 2026-08-06** by revelri (repository owner), on review, including
> the test-scope `@arbor/kb` amendment recorded below. The four bindings in the
> Decision section are ratified as written; `@arbor/governance` is now a real
> consumer-backed package (`arbor-mcp`'s `selfhost.ts` and
> `governance-projection.ts`), satisfying binding 4's reachability condition.

## Context

The ADR governance architecture audit (`docs/adr-governance-audit/`) prescribes a
control plane: canonical records, an append-only governance event stream, a
materialized graph projection, a policy engine, an MCP surface, and CLI/skill
access. Implementing it requires answering a question no accepted ADR covers:
**where does this code live, and what does it reuse?**

Three facts from the audit constrain the answer, all independently re-verified on
this branch:

1. **`EvidenceLedger` already chains per `campaign_id`** (`arbor-audit/src/audit.ts`,
   `latestCampaignHash`), and `verifyIntegrity()` has four non-test callers that
   fail closed. A reserved stream therefore gets an independent, already-tested
   hash chain with no change to the ledger's internals.
2. **The projection pattern is real, not aspirational.** `metrics-projector.ts`
   and `memory-projector.ts` are pure, `verifyIntegrity()`-gated functions with
   deterministic sort keys and snapshot-bound cursors.
3. **`@arbor/core` must never import from another package** (AGENTS.md; verified
   independently in the clean-room audit). Governance needs `core`'s types, so it
   cannot live inside `core`.

A fourth constraint comes from the repository's own dead-code gate: a new package
with no consumer is unreachable from the three declared entry points, and
`gate:reachability` fails the build. Substrate without a caller is the "Unreached"
defect shape Phase 6 exists to eliminate.

## Decision

**Create one new package, `@arbor/governance`, that depends on `@arbor/core`,
`@arbor/audit` and (test-scope only) `@arbor/kb`, and reuses their mechanisms
rather than reimplementing them.**

> **Amendment (2026-08-04, while still Draft).** The original decision named only
> core + audit. Implementation surfaced a real need for `@arbor/kb`: the integrity
> probe suite compares the audit ledger's per-record chain against the KB stream's
> `previous_hash`/`sequence`/`tip_hash` seal, and that comparison is the evidence
> for which guarantees each chain actually provides. The import is confined to
> `tests/`; no `src/` module depends on `@arbor/kb`. Recorded here rather than left
> as an undeclared import, because an undeclared cross-package dependency is the
> exact defect the audit found between `arbor-mcp` and `arbor-opencode` (both
> import each other with neither declared, working only by npm workspace hoisting).

Concretely, four bindings are decided here:

1. **Canonicalization is `@arbor/core`'s `canonicalizeForHash`.** Landed in
   `2001052`, which also collapsed the four divergent implementations and fixed
   `output-evidence.ts` emitting non-parseable JSON. Governance adds no fifth
   canonicalizer; a fifth is a governance violation, not a refactor.
2. **Governance events append to the existing `EvidenceLedger` under the reserved
   `campaign_id = "governance"`,** stored at `<dir>/audit/governance.jsonl`. A
   separate `GovernanceLedger` class is rejected: it would duplicate tested
   hashing, verification, and persistence for no functional gain.
3. **The graph is a third pure projector** beside the telemetry and memory
   projectors, with the same shape — integrity-gated, deterministically sorted,
   snapshot-cursored, and never authoritative. Losing it is a non-event; it
   rebuilds from the stream.
4. **`@arbor/governance` must be reachable from a declared entry point before it
   lands as production scope.** Its first consumer is `arbor-mcp`'s CLI/router,
   which is an entry point. Until that wiring exists, any dangling export carries
   a dated allowlist entry citing **this ADR** — the first use of the allowlist's
   `adr` field, which the audit found has never been exercised in 76 entries.

## Consequences

**Positive:**

- Reuses two proven hash chains, a proven projection pattern, and a proven
  catalog/router shape instead of building parallel infrastructure.
- Keeps governance out of `@arbor/core`, preserving its no-internal-dependency
  invariant.
- Makes the package boundary the enforcement boundary: governance code cannot
  quietly acquire campaign-mutation authority, because it does not depend on the
  campaign manager.

**Negative:**

- Adds an eleventh package, its workspace entry, and a root `tsconfig.json`
  project reference. `gate:lockfile` and the root references must be updated
  together or the package silently goes un-typechecked — the exact G-18 defect.
- Governance events share a JSONL file convention with campaign ledgers, so
  concurrent appends on separate branches conflict textually. Mitigated by
  serializing governance appends to the integration branch; a merge driver is
  deferred until a second author exists.

**Neutral:**

- Nothing about campaign execution changes. Governance is a build- and
  review-time concern and is deliberately not consulted at campaign runtime.

## Alternatives considered

1. **Put governance inside `@arbor/audit`.** Rejected: `arbor-audit` is the
   evidence ledger for campaign execution. Folding a documentation-governance
   domain into it would couple two lifecycles with different change rates and
   different consumers, and would put graph/policy/query code behind a package
   whose job is append-and-verify.
2. **Put governance inside `@arbor/mcp`.** Rejected: `arbor-mcp` is already the
   largest package (50 files) and the audit's "overlap magnet." Governance needs
   to be consumable by CLI, CI scripts, and gates that should not depend on the
   campaign manager.
3. **A separate `GovernanceLedger` with its own chain implementation.** Rejected
   for the reason in Decision point 2 — duplication of tested infrastructure with
   no offsetting benefit, against this repo's stated DRY/AHA discipline.
4. **No new package; implement governance entirely in `scripts/*.mjs`.** Rejected:
   the existing gates are untyped `.mjs` outside the workspace graph, so they get
   no typecheck, no coverage floor, and no reachability analysis. A control plane
   asserting authority over the repository should not itself be the least-checked
   code in it. Scripts remain the *invocation* surface; the domain lives in TS.

## Obligations

### O1 — Governance reuses `@arbor/core`'s single canonicalizer; it introduces no second canonicalization implementation

<!-- proof: symbol=canonicalizeForHash file=packages/arbor-core/src/canonical.ts roundtrip=packages/arbor-core/tests/canonical.test.ts -->
<!-- proof: symbol=GovernanceRecordStore file=packages/arbor-governance/src/record/store.ts roundtrip=packages/arbor-governance/tests/record/store.test.ts -->

### O2 — Governance events append to the existing `EvidenceLedger` under the reserved `campaign_id = "governance"`; there is no separate `GovernanceLedger` chain implementation

<!-- proof: symbol=EvidenceLedger file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/reserved-campaign-guard.test.ts -->

### O3 — `@arbor/governance` is reachable from a declared entry point (`arbor-mcp`'s governance projection), not dangling substrate

<!-- proof: symbol=buildGovernanceSnapshot file=packages/arbor-mcp/src/governance-projection.ts roundtrip=packages/arbor-mcp/tests/governance-projection.test.ts -->

### O4 — `@arbor/governance` depends on `@arbor/core` and `@arbor/audit` in production code; `@arbor/kb` is confined to `tests/`, with no `src/` module importing it

<!-- unverifiable: structural claim about the import graph (no @arbor/kb import anywhere under packages/arbor-governance/src, confirmed by direct search), not a behavior a single symbol/roundtrip citation can stand for; no dedicated regression test enforces it. -->

No proof attached. Confirmed by direct search (no `@arbor/kb` import
anywhere under `packages/arbor-governance/src`), but this is a structural
claim about the import graph, not a behavior a single symbol/roundtrip
citation can stand for, and no dedicated regression test enforces it.
`package.json` now lists `@arbor/kb` under `devDependencies`, matching
"test-scope only" as this obligation claims — the earlier note here about
a full (non-dev) dependency is stale; that has since been corrected.

## Test implications

- `canonicalizeForHash`'s determinism suite (`arbor-core/tests/canonical.test.ts`,
  22 cases) already covers the hashing foundation this ADR binds to.
- Adding the package requires proving the G-18 shape cannot recur: a test or gate
  asserting every workspace member appears in the root `tsconfig.json` references.
- No existing test is invalidated by this ADR; the `2001052` migration kept the
  full suite green at 1676 passing.
