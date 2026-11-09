# ADR-106: Selection Backpropagates Value Along The Path It Selected

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 5afc268fd12b3731abf2ba5b1ca52a3c941f8153
**Content ID:** sha256:e564a13dce685f796453ccb28dcd34c9a32cdbbfcecd41a451c4688ce3274513

## Context

Verified against the current tree, not assumed: `packages/arbor-core/src/`
implements real selection over a real, production-driven tree. `tree.ts`'s
`selectNode` (lines 12-64) walks every node in `Map<string, TreeNode>`,
builds a `categoryVisits` map keyed by `action.category` from only the
"alive" nodes (pending-with-valid-ancestor or expanding — dead nodes are
excluded so a category's buried failures cannot suppress exploration of its
remaining viable arms), and scores each pending candidate through
`scoreAction`. `scoring.ts` (lines 34-101) genuinely has two formulas: the
classic UCB1-style term (`deriveClassicScoreTerms`, lines 108-149:
gain-per-cost times two regression penalties times a normalized performance
gap, plus a UCB exploration bonus) and a paper-cited `agent_uct` mode
(`scoreAgentUct`, lines 82-97) implementing
`\hat{Q}_t(s,a) + C√(ln(N_t(s)+1)/(N_t(s,a)+1)) − λ_t·ΔĈ_t(s,a)` with a
decaying `λ_t = λ₀/√t`. This is not ornamental: `packages/arbor-mcp/src/
manager.ts` (`selectNode`/`selectNodeWithCard`, lines 632-681, and
`scoreAction` called directly at line 917) and `packages/arbor-opencode/src/
loop.ts` drive real campaigns through this exact code path.

But `categoryVisits` is flat and bucketed by category across the *whole
tree*, recomputed from scratch on every `selectNode` call by summing
`node.visit_count` over all alive nodes sharing a category — it is not
accumulated per-edge along the path that was actually selected and expanded.
`createChild` (lines 70-92) initializes every new node's `visit_count: 0` and
never updates a parent's or ancestor's statistics. `beginExpansion` (lines
105-110) increments only the expanding node's own `visit_count`; it touches
no ancestor. `verifyNode` (lines 118-150) writes `score` and `state` onto
the node it is called on and nowhere else. `failNode` (lines 153-191) walks
the ancestor chain — but only to find the nearest still-valid node to
backtrack to (`verified`/`claimed`/`expanding`); it returns that node's id
and updates no visit count or value on any node it passes through. Grepping
`arbor-core` and `manager.ts` for `visit_count`, `categoryVisits`, and
`backprop*` turns up exactly this set of call sites and no others. **The
audit finding holds**: this is real UCB selection over live tree state with
a genuine cost-decay-aware alternative formula, but it is a multi-armed
bandit over `action.category` gated by ancestor-path validity, not
Kocsis & Szepesvári's UCT, which is defined by backpropagating simulation
value up the exact path selected on every iteration. "Governed best-first
search" is the more accurate name for what selection does today.

The split the audit flagged in `scoreActionWithPolicy`'s docstring also
holds: `agent_uct` mode is described in the source itself as "intentionally
explicit and separate from production Arbor scoring... so eval lanes can
compare ADR-002 against paper-style prefix-cost regularization without
silently changing campaign selection." Confirmed structurally:
`DEFAULT_SCORE_POLICY = { mode: "classic" }` (`types.ts` line 654) is what
`scoreAction` — the entry point `manager.ts` actually calls — uses via
`scoreActionWithPolicy`'s default parameter; no call site in `manager.ts` or
`loop.ts` passes an explicit `agent_uct` policy. The paper-faithful,
backprop-shaped formula exists, carries real `state_visit_count`/
`edge_visit_count` evidence types (`types.ts` lines 604-616), and does not
drive a single production campaign.

## Decision

**1. Introduce per-edge visit and value statistics accumulated along the
selected path.** Each `TreeNode` gains an edge-local `edge_visit_count`
(already named and typed for `agent_uct` evidence in `types.ts` — reused
rather than re-invented) and a `value_estimate`, distinct from the
whole-tree `categoryVisits` bandit count `selectNode` keeps for now.
`createChild` initializes both to zero, matching its existing
`visit_count: 0`.

**2. Backpropagate on terminal outcome, walking the same ancestor chain
`failNode` already walks.** A new `backpropagate(tree, nodeId, outcome)`
function in `tree.ts` runs after `verifyNode` or `failNode` reaches a
terminal state: it walks `parent_id` up to the root (`failNode`'s lines
170-191 already perform this walk for backtrack-target discovery,
generalized here to not stop at the first valid ancestor), incrementing
each ancestor's `edge_visit_count` and updating `value_estimate` via
running average. `manager.ts`'s `recordResult` invokes it once per terminal
transition — never mid-expansion, so a node's `edge_visit_count` reflects
completed subtree evidence, not in-flight guesses.

**3. Evidence-gated promotion and ancestor-walking backtrack are preserved
exactly as they are.** Backpropagation is additive; `failNode`'s ancestor
walk continues to select the backtrack target by state validity alone,
staying a separate concern from value bookkeeping so a defect in one cannot
silently corrupt the other.

**4. `agent_uct` mode becomes the backprop-consuming scorer; `classic` mode
stays category-bandit until the reward-signal question below is settled.**
Once edge-local statistics exist, `scoreAgentUct`'s evidence can be
populated from real tree state instead of only synthetic eval-harness
evidence. This ADR does NOT flip `DEFAULT_SCORE_POLICY` to `agent_uct` —
that changes what every production campaign selects, a separate,
consequential decision gated on the dependency below, not a side effect of
adding bookkeeping.

**This ADR depends on the live-model-evaluation ADR landing first**, stated
explicitly rather than left implicit. Backpropagation needs a reward signal
comparable across nodes at different depths and categories.
`deriveClassicScoreTerms` (lines 104-166) computes a hand-authored gain/cost
ratio scaled by regression penalties and a `best_known`-relative gap — a
ranking heuristic tuned to compare sibling *actions* at selection time, not
a validated value function whose magnitude means the same thing averaged up
an arbitrary-depth ancestor chain. Backpropagating an unvalidated heuristic
produces numbers shaped like MCTS values without the property that makes
MCTS values meaningful: that they estimate true expected outcome. The
live-eval ADR's real verification signal — a task's actual pass/fail against
a real test command — is the reward this ADR needs to backpropagate
something honest instead of manufacturing false rigor on top of `gain/cost`.

## Consequences

Selection gains real path-local memory: a subtree that has repeatedly
failed accumulates a lower `value_estimate` independent of its category's
tree-wide bandit count, so two nodes in the same category but different
subtrees are no longer treated identically. `agent_uct` becomes computable
from live data for the first time, closing the gap between its docstring
claim and what a campaign can actually feed it. Costs: every terminal
transition now does an O(depth) ancestor write in addition to `failNode`'s
existing O(depth) read; two visit-count concepts coexist
(`categoryVisits`'s flat count and the new per-edge count) until a
follow-on ADR decides whether `classic` mode should migrate off the flat
count entirely — a source of confusion this ADR accepts rather than
resolves. This does NOT change `DEFAULT_SCORE_POLICY`, does NOT change what
`verified`/`claimed`/`failed` mean, and does NOT retire the category-level
bandit — all three are explicitly out of scope pending the dependency and a
follow-on migration decision.

## Alternatives / Roads not taken

**Backpropagate under `classic` mode's existing gain/cost heuristic
immediately, without waiting on live evaluation.** Rejected: this is the
forced-proof pattern applied to a decision instead of an obligation.
Averaging an untested ranking heuristic up a tree produces a number shaped
like a value function without validation that it behaves like one — worse
than the current, honestly-scoped per-selection heuristic, because it would
look load-bearing while resting on nothing new.

**Flip `DEFAULT_SCORE_POLICY` to `agent_uct` in this same ADR, since the
formula and its evidence types already exist.** Rejected: the formula's own
docstring says it is intentionally kept separate from production scoring,
and changing what every campaign selects is a materially larger,
independently reviewable decision than adding bookkeeping. Bundling them
would make this ADR's obligations untestable in isolation.

**Keep the flat `categoryVisits` bandit as the only visit-count concept and
relabel it "backpropagation."** Rejected: this is the audit's finding
restated as a fix. A tree-wide sum by category is not path information —
sibling subtrees under different categories cannot influence each other's
exploration bonus, and a subtree's own repeated failures are invisible to
its ancestors. Relabeling would satisfy the title without changing the
behavior it promises.

## Obligations

### O1 — Selection over live production tree state is real today, verified independently of the audit's claim

`selectNode` computes UCB scores from live `TreeNode` state via
`scoreAction`, and is the exact function both `CampaignManager.selectNode`
and `arbor-opencode`'s loop dispatch call to choose the next node in a real
campaign — not a synthetic or eval-only path. This grounds the premise that
backpropagation is being added to a real mechanism, not a demo.

<!-- proof: symbol=selectNode file=packages/arbor-core/src/tree.ts roundtrip=packages/arbor-core/tests/tree.test.ts -->

### O2 — `scoreAction`'s classic formula is the one production campaigns actually use, confirming the `agent_uct` split named in Context

`scoreAction` is the entry point `manager.ts` calls directly (line 917); it
routes through `scoreActionWithPolicy`'s default parameter
`DEFAULT_SCORE_POLICY = { mode: "classic" }`, never `agent_uct`, absent an
explicit override no call site supplies. This is the resolving proof for
the "agent_uct is eval-only" claim this ADR treats as a hard dependency
constraint on when `DEFAULT_SCORE_POLICY` may change.

<!-- proof: symbol=scoreAction file=packages/arbor-core/src/scoring.ts roundtrip=packages/arbor-core/tests/scoring.test.ts -->

### O3 — Backpropagation walks the same ancestor chain `failNode` already proves reachable, without altering `failNode`'s own backtrack-target selection

The new `backpropagate` function must reuse `failNode`'s ancestor-walk
pattern for its own statistics update, and a test must show that running
`backpropagate` after a `failNode` call does not change which node
`failNode` returns as the backtrack target — proving the two concerns stay
additive rather than entangled.

<!-- proof: symbol=backpropagate file=packages/arbor-core/src/tree.ts roundtrip=packages/arbor-core/tests/tree.test.ts -->

### O4 — `agent_uct` evidence can be populated from real per-edge tree state once this ADR lands, closing the gap between its docstring claim and production data

Once `edge_visit_count`/`value_estimate` are populated by `backpropagate`,
`scoreAgentUct`'s `AgentUctScoreEvidence` can be constructed from live tree
state rather than only from `packages/arbor-eval`'s synthetic evidence —
this is what makes flipping `DEFAULT_SCORE_POLICY` a decidable question
instead of a permanently eval-only formula.

<!-- unverifiable: this obligation depends on both this ADR's backpropagate landing and the live-model-evaluation ADR's real reward signal existing to validate what value_estimate should mean; neither exists yet, and the dependency is the point being recorded -->
