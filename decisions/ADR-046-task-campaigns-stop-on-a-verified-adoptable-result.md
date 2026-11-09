# ADR-046: Task Campaigns Stop on a Verified Adoptable Result

**Status:** Accepted
**Date:** 2026-08-12

Authored as Proposed: implementation authority is not acceptance authority.

## Context

`arbor task confirm --wait` currently waits for the whole supervised
`campaign.run` promise.  The production loop is a bounded tree search, so a
task process can remain alive after an acceptable result exists.  More
importantly, the CLI process owns that in-flight promise: an external wait
timeout kills the specialist/critic cycle with no opportunity to finalize its
result.

The preserved live OpenRouter evidence contains four repetitions of that
failure.  In each campaign the specialist session durably reached terminal
`verified` and the Lenticel session durably reached terminal `completed`, but
the tree retained only admission and isolation checkpoints and its selected
node remained `expanding`.  The latest campaign started at
`2026-08-12T04:22:25Z`; the harness journal stopped around the two-minute outer
wait boundary.  The supervised task was subsequently reconciled as failed.
There is no node-verification checkpoint, result trace, or post-critic loop
event, proving `CampaignManager.recordResult` was not reached.  The manager's
verified transition itself is covered and correct in isolation.  The root
cause is therefore process lifetime: the outer waiter killed the process in
the critic-to-record window, not a missing tree transition.

The same production runner serves exploratory campaigns and generalist tasks.
Those intents should not have identical stopping policy.  A generalist task
needs the first independently verified, adoptable result; an exploratory
campaign may continue searching.

## Decision

1. The canonical campaign loop gains a closed execution strategy:
   `tree_search`, `first_verified`, or `direct_single_action`.  This is a
   stopping/selection policy inside the existing runner, never a second
   execution authority.
2. `direct_single_action` names the one admitted pending node.  The loop sends
   that node through the ordinary isolation, specialist, verification, critic,
   result-recording, capture, and cleanup path without a UCT choice.  It stops
   only after that node is durably `verified`.
3. `first_verified` retains ordinary UCT selection but stops after the first
   node becomes durably `verified`.  `tree_search` retains existing exhaustive
   behavior.
4. Production derives the strategy conservatively from durable admitted plan
   shape. One pending depth-zero action is direct. Multiple actions or a plan
   requesting decomposition remain tree search because today's durable plan
   has no alternatives/acceptance marker that can prove one verified action
   satisfies the whole task. A future caller that owns such an acceptance
   predicate may explicitly select `first_verified`.
5. A successful task stop records the typed halt reason `verified_result`
   through the existing automatic-halt gate path.  It does not manufacture
   verification: `recordResult` and its evidence gate must already have
   transitioned the node to `verified`.
6. Result capture runs in the existing `finally` path before worktree release.
   The wait projection prefers a verified node over a higher-scoring
   unverified node, so a successful settlement reports the adoptable result.
7. Fire-and-forget campaign failures receive a bounded runtime diagnostic.
   The supervised task still fails canonically; the rejection is no longer
   silently discarded.

## Consequences

Generalist tasks have a bounded, truthful completion point while exploratory
search remains available.  The direct path shares every governed seam and
cannot self-approve or bypass a gate.  A verified result can be returned and
adopted before an operator's outer wait deadline.

The plan-shape policy is intentionally conservative. Multi-step and
decomposition intent keep full search. Future durable acceptance predicates
may authorize `first_verified`, but cannot weaken the requirement for a real
verified node and captured result.

## Obligations

### O1 — The canonical campaign loop stops task strategies only after `recordResult` durably returns a verified node, while tree search retains exhaustive behavior

<!-- proof: symbol=runCampaign file=packages/arbor-opencode/src/loop.ts roundtrip=packages/arbor-opencode/tests/loop.test.ts -->

### O2 — Production derives direct execution only from an unambiguous single-action durable plan and does not create a second runner or bypass existing gates

<!-- proof: symbol=deriveProductionExecutionStrategy file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/cli.test.ts -->

### O3 — The wait projection surfaces the verified adoptable node and campaign-run rejection diagnostics remain bounded and observable

<!-- proof: symbol=awaitConfirmedCampaign file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/campaign-run-wait.test.ts -->
