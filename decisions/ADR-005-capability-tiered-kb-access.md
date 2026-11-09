# ADR-005: Capability-Tiered KB Access

**Status:** Accepted
**Date:** 2026-07-31

## Context

KB entries include Critic reasoning, failure-mode analysis, and strategic findings. If a Specialist agent can read the Critic's reasoning, it can optimize for passing the Critic rather than for genuine quality — gaming the review instead of earning it. This defeats the checks-and-balances principle.

## Decision

KB entries carry a `tier` field: `specialist_visible` or `critic_only`. The KB read path enforces capability gating based on the caller's `CapabilityContext.tier`:

- **specialist** tier: sees only `specialist_visible` entries. `critic_only` entries return `absence: capability_required`.
- **critic** and **auditor** tiers: see all entries.

The gating happens at the envelope-construction layer, not in the storage layer — the KB stores everything, but the read path redacts based on capability.

## Consequences

**Positive:** Specialists cannot game the Critic by reading its reasoning. The Critic's analysis stays independent. This is the structural enforcement of the checks-and-balances principle from the Arbor paper.

**Negative:** Specialists have less context. A Specialist that knows why a previous approach failed might avoid it — but that's the Critic's job to communicate via constraints, not via reasoning leakage.

**Neutral:** The capability context is passed explicitly on every read. There's no implicit role detection.

## Alternatives Considered

1. **No capability gating (open KB).** Rejected: Specialists can game the Critic. The checks-and-balances principle requires that the Critic's reasoning is independent.

2. **Separate KBs per tier.** Rejected: duplicates data and risks divergence. The same entry might need to be visible to critics but not specialists — a single KB with gating is simpler.

3. **Field-level redaction.** Considered for Phase 3+: instead of hiding entire entries, redact specific fields (e.g., hide `root_cause` but show `failure_mode`). More granular but more complex.

## Source

Derived from revoy-spec's senior/junior capability gate (ADR-002), which uses an env-token to gate senior-only facts from junior sub-agents.

## Obligations

### O1 — Every KB entry carries a `tier` field (`specialist_visible` / `critic_only`); the KB store never returns an untiered entry

<!-- proof: symbol=KBEntryTier file=packages/arbor-kb/src/kb.ts roundtrip=packages/arbor-kb/tests/checks-and-balances.test.ts -->

### O2 — A caller whose `CapabilityContext.tier` is `specialist` cannot read a `critic_only` entry through `read()` or `query()`

<!-- proof: symbol=CapabilityContext file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-kb/tests/checks-and-balances.test.ts -->

### O3 — Every botanical agent maps to exactly one capability tier (orchestrator / specialist / critic / auditor); none is untiered

<!-- proof: symbol=CAPABILITY_TIER file=packages/arbor-opencode/src/agents.ts roundtrip=packages/arbor-opencode/tests/agent-bindings.test.ts -->
