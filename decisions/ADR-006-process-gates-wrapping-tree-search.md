# ADR-006: Process Gates Wrapping the Tree-Search Loop

**Status:** Accepted
**Date:** 2026-07-31

## Context

The tree-search loop (select → expand → critic → score → branch/backtrack) is the core execution model. But without trust boundaries, the loop can accept work that hasn't been properly isolated, verified, or audited. A Specialist could claim success without running tests; a campaign could start without a reviewed plan.

## Decision

Wrap the tree-search loop with four typed process gates:

1. **Admission gate** (before campaign start): Is the plan reviewed? Are resources available? Is config valid?
2. **Isolation gate** (before Specialist expansion): Is the worktree isolated? Is the starting commit correct? Is a lease acquired?
3. **Evidence gate** (after Critic approval, before node verification): Was a verification command run, or is this `!claimed` only?
4. **Audit gate** (after campaign halt): Does an independent auditor agree with the results?

Each gate produces a `GateRecord` (`pass`/`fail`/`bypass`) attached to the tree node. A `bypass` records an evidence deficit for later resolution. Gates are evaluated by pure functions in `packages/arbor-gate/src/gate.ts`.

## Consequences

**Positive:** The loop has trust boundaries. An auditor can trace exactly which gates passed, failed, or were bypassed. Bypasses are visible governance artifacts, not invisible operator discretion.

**Negative:** Gates add latency. Each gate is a function call, but the checks (especially isolation) may involve git operations. The admission gate blocks campaign start if the plan isn't reviewed.

**Neutral:** Gates are advisory in Phase 0 — a `fail` blocks the operation, but a `bypass` allows continuation with a recorded deficit. Phase 2+ can make gates fail-closed.

## Alternatives Considered

1. **No gates (trust the loop).** Rejected: the loop has no concept of evidence quality. A `!claimed` result would be treated the same as `!verified`.

2. **Single mega-gate at campaign end.** Rejected: too late to prevent wasted work. The isolation gate must fire before expansion, not after.

## Source

Derived from revoy-spec's `process_gate.v1` (ADR-086), which defines eleven lifecycle gates from intent to cleanup. The concept is independently implemented with four gates specific to the tree-search loop.

The 2026 *Code as Agent Harness* survey ([arXiv:2605.18747](https://arxiv.org/abs/2605.18747),
§3.4) independently frames Plan–Execute–Verify and deterministic sensors: critiques interpret
sensor output rather than replacing it, and verification—not model confidence—governs termination.
`checkHarnessPromotion` already goes beyond that survey and *Governed Evolution of Agent Runtimes*
([arXiv:2605.27328](https://arxiv.org/abs/2605.27328)) by requiring three-way separation, measured
improvement, replay plus independent holdout evidence, and no regression before promotion.

## Obligations

### O1 — The gate catalog is exactly four typed lifecycle gates, in canonical order: admission → isolation → evidence → audit

<!-- proof: symbol=GateType file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-gate/tests/gate-order.invariant.test.ts -->

### O2 — Each gate evaluation produces a `pass` / `fail` / `bypass` `GateRecord` that is attached to the tree node, not discarded

<!-- proof: symbol=attachGateRecord file=packages/arbor-gate/src/gate.ts roundtrip=packages/arbor-gate/tests/gate.test.ts -->

### O3 — A bypassed gate always records an evidence deficit; a bypass is never a silent pass

<!-- proof: symbol=bypassGate file=packages/arbor-gate/src/gate.ts roundtrip=packages/arbor-gate/tests/gate.test.ts -->

### O4 — The evidence gate is checkable against the result's provenance tag, so a `!claimed`-only result is distinguishable from a `!verified` one before node verification

<!-- proof: symbol=checkEvidence file=packages/arbor-gate/src/gate.ts roundtrip=packages/arbor-gate/tests/gate.test.ts -->
