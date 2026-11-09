# ADR-050: Difficulty Routing Refines How UCT-Selected Nodes Execute

**Status:** Accepted
**Date:** 2026-08-12

## Context

Production already derives live NodeCards and calls `selectNodeWithCard`, preserving UCT on card mismatch. It lacked the adaptive execution half: difficulty-sensitive depth/model choice and evidence feedback.

## Decision

UCT remains the sole authority for which pending node is selected. After selection, an optional routing policy estimates calibrated difficulty in `(0,1)` from bounded action features and durable category outcomes. It refines only how that node executes:

- decomposition depth is `max(1, ceil(difficulty * L_max))`;
- model choice minimizes an explicit relative cost/latency objective among tiers meeting difficulty-derived quality;
- the decision is emitted as bounded routing evidence and passed to the executor;
- verified/claimed completion counts as success and typed failure counts as failure for later calibration.

Production native composition maps economical and capable decisions onto the configured Seed and Heartwood model identities. Missing overrides fall back to the selected native model without fabricating a distinct model claim.

## Consequences

Easy work uses shallower/cheaper execution and difficult work can use deeper/stronger execution without starving branches. The v1 calibrated head is transparent and deterministic rather than learned. Relative price/latency descriptors are policy inputs, not claims of provider-measured cost.

## Obligations

### O1 — UCT selection remains authoritative

<!-- proof: symbol=runCampaign file=packages/arbor-opencode/src/loop.ts roundtrip=packages/arbor-opencode/tests/loop.test.ts -->

Card mismatch and difficulty never replace or retire the UCT-selected node.

### O2 — Difficulty refines depth and model tier

<!-- proof: symbol=DifficultyRoutingPolicy file=packages/arbor-mcp/src/routing/routing-policy.ts roundtrip=packages/arbor-mcp/tests/routing/difficulty-routing.test.ts -->

Hard tasks receive a deeper bound and stronger tier than easy tasks.

### O3 — Outcome feedback is durable

<!-- proof: symbol=DifficultyCalibrator file=packages/arbor-mcp/src/routing/difficulty.ts roundtrip=packages/arbor-mcp/tests/routing/difficulty-routing.test.ts -->

Observed failures raise the reloaded estimate for that category.

### O4 — Production consumes both card and difficulty routing

<!-- proof: symbol=createProductionCampaignLoopConfig file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/routing/difficulty-routing.test.ts -->

The canonical production config contains task skills and the difficulty policy.
