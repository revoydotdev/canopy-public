# ADR-015: Context Economy Uses Model-Aware Expansion Epochs

**Status:** Accepted
**Date:** 2026-08-01

## Context

Output-policy foundations independently bound bytes, lines, and estimated
tokens. Appendix D shows that safe context management also needs provider-aware
capacity, reserved output headroom, explicit compaction epochs, and a separation
between deciding that management is required and performing it. A fixed
characters-per-token heuristic is useful as a fallback but is not sufficiently
accurate to authorize a model request.

## Decision

Every node expansion runs in a token epoch. The epoch records model/capability
identity, context capacity, reserved output, prefill usage, applied output limit,
limit source, counter source, one-shot warning state, and an idempotent context-
management claim. Epoch state is persisted with runtime/node recovery facts.

Eligible input capacity is `context capacity - reserved output`. Requested
output is clamped to the provider's advertised capability. A model-aware token
counter is authoritative when available; the existing character estimate is a
tagged fallback and cannot masquerade as provider-observed usage.

Context management has a pure prediction followed by one idempotently claimed
action. It first folds structural repo/audit context to identities, signatures,
hashes, provenance, and evidence pointers while retaining a bounded recent tail.
Model-generated summarization is optional and derived; raw evidence remains.
Elision and exhausted-context suppression are explicit in projections/events.

No token count, warning, or compaction marker is evidence of task liveness,
completion, approval, or a process-gate result.

Reasoning-model caveat (2026-08-12): `max_output_tokens` is not necessarily a billing ceiling when
a provider meters hidden reasoning tokens separately ([arXiv:2606.04056](https://arxiv.org/abs/2606.04056)).
Epoch preflight therefore bounds the client-visible request, not unreported provider spend; any
budget-annealed policy must use observed total usage or report that ratio as unresolved.

## Consequences

**Positive:** Nodes cannot plan against output-reserved capacity, capability
limits are observable, restart cannot double-compact an epoch, and structural
folding preserves provenance at lower context cost.

**Negative:** Provider adapters must supply capability/counter ports or clearly
operate in fallback mode. Epoch persistence and migration add state.

**Neutral:** Concrete limits remain revoy2 configuration, not copied constants
from compared projects.

## Test implications

- Model-aware and fallback counters are distinguished in every result.
- Reserved headroom and provider output clamps hold at boundary values.
- Warnings fire once per epoch and compaction claims are replay-idempotent.
- Kill/restart tests cannot run the same management action twice.
- Structural folding is bounded, deterministic, capability-filtered, and keeps
  evidence pointers; no-newline and adversarial inputs remain bounded.

## Alternatives considered

1. **Use four characters per token as authority.** Rejected because tokenizer
   behavior varies by model and content.
2. **Summarize whenever near the limit.** Rejected because it spends model
   budget and can discard provenance structure.
3. **Let each adapter invent limits.** Rejected because surfaces would diverge
   from the canonical runtime.

## Obligations

### O1 — Eligible input capacity is capacity minus reserved output, clamped at the boundary

Requested output is clamped to the provider's advertised capability.

<!-- proof: symbol=resolveTokenBudget file=packages/arbor-core/src/token-economy.ts roundtrip=packages/arbor-core/tests/token-economy.test.ts -->

### O2 — A model-aware counter is authoritative when available; the character estimate is a tagged fallback

The fallback cannot masquerade as provider-observed usage.

<!-- proof: symbol=CapabilitySource file=packages/arbor-core/src/token-economy.ts roundtrip=packages/arbor-core/tests/token-economy.test.ts -->

### O3 — A budget warning fires at most once per epoch and a management claim is replay-idempotent

A kill/restart cannot double-run the same context-management action.

<!-- proof: symbol=claimBudgetWarning file=packages/arbor-core/src/token-economy.ts roundtrip=packages/arbor-core/tests/token-economy.test.ts -->

### O4 — Structural folding is bounded, deterministic, and keeps evidence pointers

It reduces repo/audit context to identities, signatures, hashes, and
evidence pointers while retaining a bounded recent tail, remaining bounded
even on adversarial input.

<!-- proof: symbol=foldStructuralContext file=packages/arbor-core/src/token-economy.ts roundtrip=packages/arbor-core/tests/token-economy.test.ts -->

### O5 — A stale management prediction is rejected rather than reused

A below-threshold count can never gate work on outdated state.

<!-- proof: symbol=willManageContext file=packages/arbor-core/src/token-economy.ts roundtrip=packages/arbor-core/tests/token-economy.test.ts -->
