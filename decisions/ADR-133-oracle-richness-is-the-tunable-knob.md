# ADR-133: The Oracle's Richness Is The Tunable Knob, Not The Backup Formula

**Status:** Superseded
**Date:** 2026-08-27
**Authoring Revision:** 3e7ffa215cf325197b8f0065d2df1e48470650b6
**Content ID:** sha256:88586ae509c3b48452ef1ea94d9522f60f2ef440b2f51623f04d6f6268e4dc50

> **SUPERSEDED BY ADR-185** (2026-10-06 operator decision). ADR-185 retires this record's §2 backup rule: the value backed up on a terminal transition is no longer the node's own selection score but the provenance-typed reward contract (`combineReward`: 1 for a `!verified` pass, a bounded measured stage fraction otherwise, priors never). ADR-185 carries §1 (duration capture), §3 (min-form aggregator, including the O1 first-write rule) and §4 forward unchanged, so they remain in force under ADR-185 until a later record replaces §3.

## Context

ADR-106 (landed 2026-08-26, one day before this record) added
`packages/arbor-core/src/tree.ts`'s `backpropagate(tree, nodeId, outcome)`:
walk `parent_id` from a terminal node to the root, and at each node update
`edge_visit_count` and `value_estimate` via running average —
`value += (outcome - value) / edge_visit_count` (`tree.ts:213-214`). Its own
docstring already names the design tension this ADR resolves: `outcome` is
"kept as a plain finite number (not clamped to `[0, 1]` here) so a caller
with a richer reward signal is not forced through this function's own
opinion of the scale" (`tree.ts:200-202`). The function was built to accept
richness. Its only two callers do not supply any: `manager.ts`'s
`recordResult` calls `backpropagate(campaign.tree, nodeId, 1)` on every
verified success (`manager.ts:978`) and `recordFailure` calls
`backpropagate(campaign.tree, nodeId, 0)` on every failure
(`manager.ts:1031`) — literal integer constants, not a measured value. Every
terminal outcome this campaign manager has ever recorded collapses to one
bit before it reaches the function that was written to carry more.

That collapse is not the only place execution richness goes unused.
`packages/arbor-eval/src/live-verification.ts`'s `runVerificationCommand`
(the one function in the live lane that spawns a real verification process,
per its own header comment) captures `exit_code`, `stdout`, `stderr`, and a
`stdout_hash` — but no wall-clock duration, despite calling `spawnSync`
directly and being the obvious place to measure one. `verifiedProvenanceFromRun`
then discards `stdout` and `stderr` entirely once it derives a hash,
keeping only the digest. Nothing downstream ever sees how long a check took,
how much of a suite passed, or what the check actually printed — only
whether the one integer `exit_code` was zero. Selection-time scoring is
richer than this: `scoring.ts`'s `deriveClassicScoreTerms` (lines 109-149)
already combines `action.estimated_gain / action.estimated_cost` with
regression-rate penalties and a best-known-relative performance gap — but
those are the *planner's pre-execution estimates* of an action not yet run,
never the *post-execution measurement* of what actually happened. The
richness that exists in this codebase is either a guess made before
execution or a single bit recorded after it; nothing in between survives.

Two research threads converge on why both halves of this gap matter, in two
different domains from ours (agentic repository repair over a real
verification command), which this ADR states as an explicit transfer
assumption rather than an established finding:

- **Denser execution signal, not smarter aggregation, is where reported
  gains come from.** ORPS (arXiv 2412.15118, code generation, not agentic
  repair) profiles real execution metrics — not just pass/fail — into its
  tree search and reports 26.9% higher correctness and 42.2% improved code
  efficiency versus outcome-only supervision. CodeRM-8B (arXiv 2501.01054,
  also code generation) finds reward-signal quality scales with how many
  real unit tests back a verdict, not merely whether one exists — the same
  paper family this repo's own `types.ts:35` E-4 comment already cites for
  a narrower purpose (`command_executed` vs. `outputs_check`).
- **Mean-form credit assignment over a sparse binary reward drags value
  toward noise at low visit counts, and induces reward hacking.** PURE
  (arXiv 2504.15275) and "The Weakest Link Tells It All" (arXiv 2606.27739)
  — both process-reward-model research for LLM stepwise reasoning chains,
  not MCTS over repository-editing actions, a second explicit domain gap —
  independently propose min-form/weakest-link credit assignment over the
  canonical summation/mean form specifically because summation-form
  training collapsed in PURE's own experiments. `backpropagate`'s running
  average is exactly the mean form both papers single out, and this
  repository's regime — single-digit `edge_visit_count` per node, a
  strictly binary terminal reward — is the low-N, low-diversity setting
  both papers describe as the failure case, not a favorable one.

## Decision

**This ADR treats richer-signal capture and aggregator-form revision as one
decision, not two, and says why below — but states each half separately
because they change different code.**

Why one ADR: enriching only `outcome`'s scale without touching the
aggregator does not defuse PURE's finding — mean-form credit assignment
drags toward noise at low N regardless of whether the input happens to be
richer than a bare 0/1, because the failure mode is in the running-average
math, not the input's granularity. Enriching only the aggregator without
touching `outcome`'s scale caps the fix at the current input: min-form over
`{0, 1}` values is still only ever the campaign asking "did every attempt
succeed," not "how close did each attempt get" — the exact distinction
ORPS's gains are attributed to. Each half is inert without the other; two
ADRs would let one land as "Accepted" while contributing nothing
observable until its sibling also lands, which is a worse record than one
ADR naming the dependency directly.

1. **`runVerificationCommand` measures wall-clock duration around the
   `spawnSync` call it already makes**, and `VerificationRunResult` carries
   it as an additive field. This is the cheapest available real signal —
   no new instrumentation, just timing code that already runs.
   `verifiedProvenanceFromRun` threads it into `Provenance`'s `verified`
   tag as an additive field, not a replacement for `cmd`/`exit`/
   `stdout_hash`.

2. **`recordResult`/`recordFailure` stop passing literal `1`/`0` to
   `backpropagate`.** `CampaignManager` computes a real `outcome` from
   what is already available at the call site — at minimum, the node's own
   score, which both terminal paths already hold: the success path passes it
   to `verifyNode` (`packages/arbor-mcp/src/manager.ts:972`) and the failure
   path receives it as the `scoreBefore` parameter of the private
   `recordFailure` (`packages/arbor-mcp/src/manager.ts:1014`). Today that
   number is discarded and a constant is handed to `backpropagate` instead,
   at `packages/arbor-mcp/src/manager.ts:978` (success, literal `1`) and
   `packages/arbor-mcp/src/manager.ts:1031` (failure, literal `0`), so a
   marginal success and a strong one backpropagate identically. This does not
   require a new measurement pipeline; it requires not throwing away a
   number the caller already has.

3. **`backpropagate`'s running-average update becomes min-form
   (weakest-link).** `value_estimate` becomes `min(priorValue, outcome)` on
   first write and thereafter tracks the minimum outcome ever
   backpropagated through that edge, replacing the `priorValue +
   (outcome - priorValue) / priorVisits` line at `tree.ts:214`.
   `edge_visit_count` keeps accumulating exactly as today — visit-count
   bookkeeping and value bookkeeping stay the separable concerns ADR-106
   §3 already established. This is being decided now, one day after
   ADR-106 landed, because reverting a one-day-old formula is cheap and a
   later revision means migrating whatever has already accumulated on it.

4. **`agent_uct` mode remains the only consumer** (ADR-106 §4's
   dependency on the live-model-evaluation ADR is unchanged;
   `DEFAULT_SCORE_POLICY` still does not flip to `agent_uct` in this
   record). This ADR only changes what `value_estimate` means and how it
   is computed, not which production campaigns read it.

## Consequences

`value_estimate` becomes "the worst outcome this subtree has ever produced"
rather than "the average outcome," which is a strictly more pessimistic,
more conservative number — a subtree with one bad result never looks better
than its worst member again, matching the weakest-link framing directly.
Combined with §2, a "bad result" is no longer only "critic rejected it" but
also "it verified, but weakly" (a low `score`), so `value_estimate` can
distinguish a marginal success from a strong one instead of treating every
success as an identical `1`. The duration measurement in §1 is additive and
consumed by nothing yet — it is deliberately the smallest available signal,
not a claim that timing alone closes the ORPS gap; capturing partial
pass-rate or resource-use signal (the richer half of ORPS's own metric set)
is explicitly out of scope here and would need its own record once a
producer exists that can honestly populate it. Because min-form is more
pessimistic than mean-form, some previously-promising subtrees will score
lower under `agent_uct` once it is fed real data — accepted, because the
alternative is the reward-hacking-prone mean form PURE's experiments
collapsed on. This ADR touches no `classic`-mode call site and no gate;
`DEFAULT_SCORE_POLICY` stays `classic`, so no production campaign's
selection changes as a direct result of this record.

## Alternatives / Roads not taken

**Ship richer-signal capture now, defer the aggregator-form change.**
Rejected in the "why one ADR" reasoning above: PURE's finding is about the
aggregation function's shape, not the input's richness, so this half alone
would not address the regime (single-digit visits, currently-binary reward)
the finding actually targets.

**Ship the aggregator-form change now, defer richer-signal capture.**
Considered more seriously, since it is the smaller diff — but rejected for
the same reason in reverse: min-form over an unchanged `{0, 1}` domain is
strictly less informative than what §2's one-line `score`-instead-of-`1`
change buys for free at the same call site, and shipping the aggregator
alone would foreclose measuring whether the combination (not the formula in
isolation) is what the cited papers' gains depend on.

**Wait for the live-model-evaluation ADR (ADR-106's own stated dependency)
before touching `backpropagate` again.** Rejected: ADR-106 §4 gates
*flipping `DEFAULT_SCORE_POLICY` to `agent_uct`* on that dependency, not
*what `outcome` means or how it aggregates* — `classic` mode's own
selection heuristic is untouched by this decision, and the value stored by
`backpropagate` is dead weight for every mode until something reads it
regardless of which formula computes it. There is no dependency reason to
wait, only convenience, and ADR-106 landing a day ago is the argument for
acting now rather than after more has been built on the mean-form
assumption.

**Adopt PURE's full learned min-form-with-clipping training pipeline, or
LCA's Softmax-Weighted-Sum pooling, wholesale.** Rejected: both are
built for training a separate process reward model over LLM reasoning
traces, an entirely different system (a trained model that scores
intermediate steps) from this repository's tree (a plain data structure
whose nodes accumulate a running statistic). Adopting the *aggregation
principle* — weakest-link over summation/mean — is a defensible transfer;
adopting either paper's training machinery would be importing a system
this repository does not have and does not need for what `backpropagate`
does.

## Obligations

### O1 — `backpropagate` was already built to accept a richer reward signal than either of its two production callers supplies

`backpropagate`'s own docstring states `outcome` is deliberately not
clamped to `[0, 1]` so a richer-signal caller is not forced through the
function's own opinion of the scale (`tree.ts:200-202`), and its body
performs the mean-form running-average update this ADR's Decision §3
replaces (`tree.ts:213-214`). This grounds the claim that the gap is at the
call sites, not in `backpropagate` itself.

<!-- proof: symbol=backpropagate file=packages/arbor-core/src/tree.ts roundtrip=packages/arbor-core/tests/tree.test.ts -->

**Implemented (Decision §3), with one underspecification resolved.** §3 says
`value_estimate` becomes `min(priorValue, outcome)` "on first write". Taken
literally against the `0` a freshly-created node initializes to, a node's
first real success (`outcome = 1`) would compute `min(0, 1) = 0` and could
never rise above zero again — which contradicts both this ADR's own
"worst outcome ever produced" framing (a placeholder `0` is not an outcome
anything produced) and ADR-135's already-committed regression test, which
requires `value_estimate > 0` after a single backpropagated success. The
implemented rule is therefore: the first backpropagation on an edge sets
`value_estimate = outcome` outright, and every subsequent one takes
`min(priorValue, outcome)`. This is recorded rather than left in a code
comment because it resolves an ambiguity in the Decision text, and a future
reader comparing the two would otherwise find them in apparent conflict.

### O2 — Both of `backpropagate`'s current callers pass a literal integer constant, never a measured or computed value

`CampaignManager.recordResult` and its private `recordFailure` helper are
the only two call sites of `backpropagate` in the codebase
(`manager.ts:978`: `backpropagate(campaign.tree, nodeId, 1)`;
`manager.ts:1031`: `backpropagate(campaign.tree, nodeId, 0)`), confirming
every terminal outcome this manager has ever recorded collapses to one bit
before reaching the function this ADR revises.

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager.test.ts -->

### O3 — Selection-time scoring already blends multiple richer signals; execution-time backpropagation does not, confirming the asymmetry this ADR closes

`scoreAction`'s classic formula (`deriveClassicScoreTerms`,
`scoring.ts:109-149`) combines a gain/cost ratio, two regression penalties,
and a best-known-relative performance gap — all planner-estimated,
pre-execution values — while `backpropagate`'s post-execution `outcome`
carries none of that texture. This is the "richness exists on one side of
execution, not the other" claim Decision's introduction rests on.

<!-- proof: symbol=scoreAction file=packages/arbor-core/src/scoring.ts roundtrip=packages/arbor-core/tests/scoring.test.ts -->

### O4 — `runVerificationCommand` spawns the real process but captures no timing today, confirming Decision §1's starting point

`runVerificationCommand` calls `spawnSync` directly and returns
`cmd_label`, `ran`, `exit_code`, `stdout`, `stderr`, `stdout_hash`, and
`spawn_error` — no duration field exists on `VerificationRunResult` today,
despite this being the one function positioned to measure one cheaply.

<!-- proof: symbol=runVerificationCommand file=packages/arbor-eval/src/live-verification.ts roundtrip=packages/arbor-eval/tests/live-verification.test.ts -->

### O5 — Threading `score` (or measured duration) into `backpropagate` and switching its update to min-form is not yet implemented

Decision §1-§3 describe code changes — a duration field, a non-constant
`outcome` at the two call sites, and a min-form update in `backpropagate`
itself — that do not exist in the repository as of this record. No
roundtrip test can demonstrate a change that has not been made; this
obligation records the gap between this ADR's decision and its
implementation explicitly rather than silently.

<!-- unverifiable: this obligation describes the implementing tranche's future work (duration capture, non-constant outcome, min-form aggregation) — none of it exists yet to write a roundtrip test against -->
