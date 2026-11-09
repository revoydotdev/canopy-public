# ADR-135: A Claimed Node's Score Cannot Steer Sibling Selection

**Status:** Accepted
**Date:** 2026-08-27
**Authoring Revision:** 3e7ffa215cf325197b8f0065d2df1e48470650b6
**Content ID:** sha256:72046c5dd43fbc823da8f81b39d033147120bb67c46cc8c1a6f9351620a3c4bc

## Context

arXiv **2606.27409** ("Delayed Verification Destabilizes Multi-Agent LLM
Belief", Jun 2026) models verifier delay as delayed consensus on a graph
with grounded corrector nodes, and derives a closed-form stability
threshold: correction that is too strong or too delayed turns consensus
into oscillation. The paper's own stabilising exit is grounded/execution-
based verification as an absorbing boundary. This system already places its
Critic gate after the Specialist and already has an execution-based
`verified` provenance tier (`packages/arbor-core/src/tree.ts`'s
`verifyNode`), so the paper's failure mode does not indict that placement —
read plainly, it clears it. This ADR does not manufacture a problem out of
that reading.

The paper does motivate a narrower, real question about this system's own
vocabulary. Alongside `verified` (machine-checked: `provenance.tag ===
"verified"`), a node can also become `claimed` — the critic approved it, but
either the critic itself approved without a verification command
(`provenance.tag === "critic_approved"`) or provenance was otherwise
non-verified (`tree.ts:141-145`). A `claimed` node's work is real and its
critic review is real, but its provenance is, by that type's own doc,
"asserted by an agent but not machine-verified." That is the closest local
analogue to the paper's failure mode: an ungrounded belief that could, if
wired carelessly, propagate through the very structure (`selectNode`'s UCT)
that decides what the search does next.

Direct reading of `packages/arbor-core/src/tree.ts` and
`packages/arbor-core/src/scoring.ts`, and their caller
`packages/arbor-mcp/src/manager.ts`, settles the question rather than
leaving it open:

1. **`selectNode`'s candidate loop** (`tree.ts:47-62`) only considers nodes
   with `node.state !== "pending"` filtered out — i.e. only `"pending"`
   nodes are ever returned. A `claimed` node can never be selected again;
   selection is not a menu it competes on.

2. **`selectNode`'s `categoryVisits` accumulation** (`tree.ts:29-45`) only
   counts a node's `visit_count` toward its category's UCB denominator when
   the node is `"expanding"` or (`"pending"` and ancestor-valid). A
   `"claimed"` node's `visit_count` is invisible to this loop — it falls
   through neither branch. A claimed sibling with an inflated `visit_count`
   cannot suppress exploration of the rest of its category, by construction.

3. **`backpropagate`** (`tree.ts:184-215`) *is* called for a claimed
   success — `manager.ts:978`'s `backpropagate(campaign.tree, nodeId, 1)`
   runs unconditionally on `newState === "verified" || "claimed"`, updating
   `value_estimate` on the node and every ancestor to the root. This is the
   one place a claimed node's outcome does touch shared tree state outside
   itself.

4. **But `value_estimate` is never read by production scoring.**
   `scoring.ts`'s `scoreClassicAction` — the function `selectNode` actually
   calls under `DEFAULT_SCORE_POLICY = { mode: "classic" }`
   (`types.ts:729`) — computes its exploitation term from
   `action.estimated_gain`, `action.estimated_cost`,
   `ctx.accuracy_regression_rate`, `ctx.crash_regression_rate`, and
   `ctx.best_known`, and its exploration term from `ctx.total_visits` and
   `categoryVisits` (item 2, above). None of these read `value_estimate`.
   `value_estimate` is written by `backpropagate` and read back only for
   snapshot/status reporting (`manager.ts:2180`, `:2789`) — never as a
   scoring or selection input. Grepping the whole tree confirms this:
   `value_estimate` has exactly one production reader path, and it is
   observability, not decision-making.

5. **`ctx.best_known` — the one context field the classic scorer reads that
   a claimed node could in principle move — is gated to verified-only.**
   `manager.ts:931-942`'s `isAcceptedForMemory = newState === "verified"`
   comment states this explicitly: "Only a genuinely verified result may
   [write memory or raise the scoring baseline]." `campaign.best_score`
   (the source `ctx.best_known` is derived from at each call site) is only
   assigned when `isAcceptedForMemory && score > campaign.best_score`
   (`manager.ts:982`) — a claimed result cannot raise it.

6. The separate `scoreAgentUct` path (`scoring.ts`) is real code but gated
   behind an explicit, non-default `ScorePolicy.mode === "agent_uct"`; its
   `reward_estimate` is supplied by `packages/arbor-eval/src/agent-uct.ts`,
   an eval-only fixture with its own reward table, never by
   `campaign.tree`'s `value_estimate`. It does not read production campaign
   state and is out of scope for this property.

The investigation this ADR set out to do landed on a negative result: a
`claimed` node's score, visit count, and value estimate do not steer
sibling selection today. That is a verified property of the current code,
not an inference, and it is worth recording and protecting rather than
"fixing" a problem that reading the code does not show.

## Decision

**Record, as an accepted invariant, that a `claimed` node cannot steer
sibling selection — and add a regression test that fails the moment any of
the mechanisms in Context items 1–5 stop holding.**

No production code changes. The property already holds by construction:
`selectNode` only returns `"pending"` nodes, `categoryVisits` only counts
`"expanding"`/alive-`"pending"` visits, `scoreClassicAction` never reads
`value_estimate`, and `campaign.best_score`/`isAcceptedForMemory` gate the
one scoring input a claimed node could move to verified-only. This ADR's
mechanism is the test added to
`packages/arbor-core/tests/tree.test.ts` (see O1): it builds two same-
category siblings, drives one to `"claimed"` with an inflated
`visit_count`, backpropagates its claimed success (raising its
`value_estimate` above zero, confirmed by assertion), and then asserts
`selectNode` still picks the untouched pending sibling under a
high-exploration config that would expose either a categoryVisits leak or a
value_estimate read if one existed.

## Consequences

This is a documentation-and-test change, not a behavior change, so nothing
about campaign selection, scoring, or memory-write gating becomes easier or
harder to use. What changes is durability: the property that makes
ungrounded (`claimed`) provenance safe to carry in the tree without it
corrupting search direction is now pinned by a test in the same file that
already tests `selectNode`'s other UCB-hygiene properties
("`selectNode UCB category visits exclude dead (failed/pruned) nodes`",
directly above the new case), rather than living only in the comments this
ADR cites. A future change to `categoryVisits`' state filter, to
`scoreClassicAction`'s inputs, or to the `isAcceptedForMemory` gate that
adds a `value_estimate` read or widens the claimed-node exemption will fail
this test before it fails in a running campaign.

This ADR does not claim `claimed` nodes are inert everywhere. They are
real: `verifyNode` records their output, `backpropagate` updates their own
and their ancestors' `value_estimate`, and `failNode`'s backtrack search
explicitly treats `"claimed"` as a valid branch-from state
(`tree.ts:174`) — a claimed node's subtree can still be built on. The
narrower, correct claim this ADR makes is only about *selection input*:
nothing about a claimed node's own score or visit history biases which
*other* pending node gets picked next.

## Alternatives / Roads not taken

**Treat the paper's stability-threshold formula as directly applicable and
add a corrective damping term to claimed-node influence.** Rejected: there
is no claimed-node influence on selection to damp. Adding a mechanism to
suppress an effect that direct reading shows does not exist would be
inventing complexity to match a paper's shape rather than this system's
actual behavior — exactly the discipline this ADR was asked to hold to.

**Exclude claimed nodes from `backpropagate` entirely, so `value_estimate`
never reflects unverified success.** Considered, then rejected as
unnecessary and slightly harmful: `value_estimate` is read only for
reporting (item 4 above), where an operator legitimately wants to see a
claimed subtree's running outcome average distinguished from an
unexplored one. Removing it there would degrade observability to close a
selection-influence gap that does not exist.

**Widen this ADR to also formalize `best_known`'s verified-only gate as new
governed behavior.** Rejected: `isAcceptedForMemory` and its comment already
exist and are unrelated to this investigation's origin (ADR review of
2606.27409); re-litigating an already-decided invariant here would blur two
separable decisions into one ADR.

## Obligations

### O1 — A claimed sibling's inflated visit count and raised value_estimate cannot suppress or redirect `selectNode`'s pick of the pending sibling in its category

`packages/arbor-core/tests/tree.test.ts`'s new case ("ADR-claimed-nodes-do-not-steer-selection: a claimed sibling's visits do not inflate its category's UCB count, and the claimed node itself is never re-selected") drives a node to `"claimed"` with `visit_count = 50` and a `backpropagate`d positive `value_estimate`, then asserts `selectNode` still returns the untouched pending sibling under a high-exploration config — proving both mechanisms (categoryVisits exclusion, value_estimate non-use) at once, in the real `selectNode`/`scoreAction` code path, not a reimplementation of it.

<!-- proof: symbol=selectNode file=packages/arbor-core/src/tree.ts roundtrip=packages/arbor-core/tests/tree.test.ts -->
