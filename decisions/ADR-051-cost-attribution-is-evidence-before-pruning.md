# ADR-051: Cost Attribution Is Evidence Before Pruning

**Status:** Accepted
**Date:** 2026-08-12

## Context

ADR-017 makes telemetry a ledger-derived projection, while the campaign loop already records provider usage per node. Cost can help avoid repeatedly expanding branches that consumed budget without verified progress, but a HUD or an in-memory accumulator cannot safely become search authority. Provider list prices are estimates, not billing evidence.

## Decision

1. Native usage and configured pricing have four independent dimensions: fresh input, output, cache read, and cache write. A configured schedule is incomplete unless it supplies all four rates.
2. Node finalization emits a durable `node_cost_attribution` telemetry record after its result evidence. It includes four-way token totals, attributable cost, ranked call spans, redundant-tool-call clusters, and whether the node produced verified progress.
3. A configured cost threshold may emit `expensive_unproductive`. The loop may use that recorded signal to suppress creation of further children from a merely claimed node. It never changes, hides, or rewrites the node outcome, and it never overrides verification or UCT selection.
4. Cost/status renderers rebuild from the evidence ledger on every refresh. They retain no running total and label configured list-rate amounts as estimates. External renderers receive a copied JSON projection on stdin and receive no campaign authority.
5. Redundant-tool detection is advisory. Similar calls are surfaced, never blocked automatically.

## Consequences

Cache-heavy work is ranked using its real configured cache rates instead of a fresh-input approximation. Operators can locate expensive spans and search can avoid expanding expensive, unverified branches only after the signal is durable. Hosts must update static pricing configuration with both cache rates; there is intentionally no compatibility fallback that silently bills cache reads as fresh input.

### Named budget-overrun risks and guarantee map (2026-08-12)

The incident catalog in [arXiv:2606.04056](https://arxiv.org/abs/2606.04056) identifies delegation-
fanout reuse and hidden reasoning-token accounting as production failure classes. revoy2 does not
currently delegate a reusable per-child monetary slice, so the first race is not present in that
shape; any future slice must be single-consumption. Provider reasoning tokens remain a trust
assumption: client-side `max_output_tokens` can understate billed work when a provider reports
hidden reasoning separately.

| Guarantee | Enforcing layer | Status | Trust assumption |
|---|---|---|---|
| A delegated budget slice is consumed once | Not implemented; required at any future delegation boundary | Not applicable today | No adapter invents child-local slices |
| Four visible token dimensions are attributed exactly | Native usage/cost authority + ledger telemetry | Tested | Provider usage report is truthful |
| Hidden reasoning does not masquerade as free | Typed provider observation; absent dimensions remain unpriced/unknown | Empirical | Provider exposes reasoning usage when billed |
| Pruning never precedes evidence | Loop finalization + ledger checkpoint | Tested | One-writer persistence holds |

## Obligations

### O1 — Configured native pricing bills all four token dimensions independently

<!-- proof: symbol=StaticNativeModelPricingAuthority file=packages/arbor-harness/src/usage-budget.ts roundtrip=packages/arbor-harness/tests/usage-budget.test.ts -->

### O2 — Node finalization attribution ranks spans and surfaces redundant calls without making the heuristic authority

<!-- proof: symbol=buildNodeCostAttribution file=packages/arbor-campaign-support/src/cost-attribution.ts roundtrip=packages/arbor-opencode/tests/cost-attribution.test.ts -->

### O3 — The live HUD is re-derived from ledger evidence and labels list-rate cost as an estimate

<!-- proof: symbol=projectCostHud file=packages/arbor-mcp/src/cost/hud-projection.ts roundtrip=packages/arbor-mcp/tests/cost-hud.test.ts -->

### O4 — External status-line rendering is bounded and receives copied JSON on stdin without shell evaluation

<!-- proof: symbol=ShellStatusLineRenderer file=packages/arbor-mcp/src/cost/hud-projection.ts roundtrip=packages/arbor-mcp/tests/cost-hud.test.ts -->
