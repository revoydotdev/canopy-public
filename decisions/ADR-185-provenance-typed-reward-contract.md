# ADR-185: Search Reward Is Measured And Provenance-Typed; Priors Are Never Rewards

**Status:** Accepted
**Date:** 2026-10-06
**Authoring Revision:** fd77110c437db4ea710b479739ff5395b4f98bee
**Content ID:** sha256:675a31a6c12c408d1f98fc456cbb8a32cce4e8a5e5ef5093a568fa1ce80d7653

## Context

ADR-133 §2 told `CampaignManager.recordResult` to stop backing up literal
`1`/`0` and to back up "the node's own score" instead. That number is
`scoreAction(node.action, score_ctx, categoryVisits, score_config)`. It is the
*selection* formula: planner gain/cost priors, regression penalties, a
best-known gap, and the exploration bonus `C·√(ln N / (1 + n_cat))`. So after
ADR-133 the manager backed up the scheduler's own estimate as if it were an
outcome. The audit of the search core (`docs/research/uct-search/AUDIT.md`,
defect D1) traced three consequences:

- On success, `backpropagate` received `score`, and the same `score` raised
  `campaign.best_score`. A node verified late in a campaign (larger `N`)
  reported a larger "reward" for identical work, because of the exploration
  bonus.
- On failure, `backpropagate` received `scoreBefore`, the node's pre-failure
  `score`. That is `0` for every node that never verified (`createChild`
  sets it), and the selection prior for a revived one. Either way it is not
  a measurement.
- `haltCheck`'s `below_threshold` compared that prior-derived `best_score`
  against `min_score`. A threshold halt therefore said something about the
  planner's estimates, not about results.

The repository already has one unforgeable measurement: the
composition-owned machine verifier. A `!verified` result is a binary
terminal pass. A staged verification that fails reports which of its
stages passed before the failing one. The critic panel produces a
confidence, but it is a model judgement with no recorded calibration
against verifier outcomes.

The operator decided on 2026-10-06 (`docs/research/uct-search/PLAN.md`, "Operator
decisions", items 4 and 6):

- critic estimates get weight 0 until a recorded calibration earns them a
  weight;
- ADR-133 is superseded by a provenance-typed reward contract.

## Decision

**This record supersedes ADR-133.** It replaces ADR-133 §2's backup rule
outright. It carries ADR-133 §1, §3 and §4 forward unchanged, so retiring
ADR-133 leaves none of its other commitments ungoverned (see "Carried
forward" below).

1. **The reward contract lives in `@arbor/core` as a pure function.**
   `combineReward(observations, config)` (`packages/arbor-core/src/reward.ts`)
   takes typed `RewardObservation`s and returns a `BackedUpReward`. The
   result carries `value`, `source`, `measured`, the evidence's
   `provenance_tag`, and every observation's weighted `components`. The rule
   is:
   - a `terminal` observation, which requires `!verified` provenance, is
     worth exactly **1**;
   - otherwise the value is `min(τ, w_g · stage_fraction + w_e · estimate)`.
     The defaults are `w_g = τ = 0.9`, and `τ < 1` is enforced. A failed
     outcome therefore can never reach a verified one, even when every
     stage passed;
   - an `estimate` contributes `w_e = calibration.weight` only when it
     carries a `RewardCalibration` naming the ledger record that earned it.
     An uncalibrated estimate is recorded as a component with weight 0;
   - with no terminal and no graded observation, the value is an
     **unmeasured 0**. `measured: false` says so: absence is not a low
     score.

   Invalid input throws `RewardContractError` instead of being coerced. The
   result is order-independent, so a replay of the same observations
   reproduces it byte for byte.
2. **Planner priors are never backed up.** No observation type has a field
   for `estimated_gain`, `estimated_cost`, a selection score or an
   exploration bonus, and `combineReward` reads only the fields it names.
   The node's selection `score` is still computed and still recorded as
   `node.score` and as the trace's `score_after`. `getBestPath` and the eval
   harness's `bestScore` read it there. It is never passed to
   `backpropagate` and never raises `best_score`.
3. **`recordResult` and `recordFailure` back up the contract's value.**
   - On a transition to `verified`, the manager builds a `terminal`
     observation from the result's own `!verified` provenance.
   - On every failure path it passes no terminal observation, whatever tag
     the result arrived with. A `verified` claim that the evidence gate, the
     task-echo check or the replay check refused is not a pass.
   - A failed machine verification may carry
     `verification_failure.stages = { passed, total }`. That becomes the
     `graded` observation.
   - The critic's `confidence`, when the critic is not the specialist,
     becomes an uncalibrated `estimate`.
   - Both methods return the `BackedUpReward` alongside their existing
     fields.
4. **`best_score` is the best measured reward.** It rises only on a
   `measured` reward: a verified pass, or a measured failure's stage
   fraction. A claimed result carries no measurement, so it cannot raise
   `best_score`. That is the 3220c8ed memory-pollution guard, now held by
   the type rather than by a state check alone.
5. **The below-threshold halt now reads measured quality.** `haltCheck`'s
   `bestScore` and `min_score` are on the contract's [0, 1] scale. As
   before, `measuredBestScore` passes a value only once some node has
   verified. A pre-verification partial is progress, and halting on it would
   reintroduce the 2026-08-08 defect, where a campaign ended after its first
   failed expansion.

**Carried forward from ADR-133, unchanged.**
- §1: `runVerificationCommand` measures `duration_ms`. This is implemented.
- §3: `backpropagate`'s min-form (weakest-link) aggregator, including the
  implemented first-write rule recorded under ADR-133 O1. It stays in force
  until the Beta-posterior statistics planned for the search core (plan
  Stage 2, operator decision 6) replace it in a record of their own.
- §4: `agent_uct` remains the only consumer of `value_estimate`, and
  `DEFAULT_SCORE_POLICY` stays `classic`.

**Why this is a correctness fix, not selection-math tuning (ADR-131).**
ADR-131 Decision §1 forbids changing selection math "as pure
improvements-by-inspection" without live-ablation evidence. This record
changes no part of the selection formula: no constant, weight, term or
policy in `scoreAction`, `selectNode` or `scoreAgentUct`. It changes the
*source* of the backed-up value from a quantity that is not a measurement
to one that is. The test is whether an ablation could justify the old
behaviour. It could not. No experiment can make "the scheduler's prior
estimate of an action" a measurement of what that action achieved, so
correcting it does not need one. The new contract's own numbers (`τ`,
`w_g`) are not tuned either. They state the invariant that a failure ranks
below every verified pass, and the critic weight is fixed at 0 by operator
decision until a calibration exists.

The record also discloses one coupling honestly. `ManagerScoreContextAdapter`
(`loop-adapters.ts`) feeds `snapshot.best_score` into `ScoreContext.best_known`,
and the classic formula's `m_gap = gain / best_known` scales exploitation
relative to exploration. Changing what `best_score` means therefore changes
`best_known` once something has been measured. Before this record, after the
first verification it held that node's selection score; now it holds 1, or a
measured partial before verification. That is a selection-visible
side-effect of a source correction. It is not a tuning choice made here.
Restoring exact selection neutrality means sourcing `best_known` from the
best verified node's `score` in that adapter. That change is outside this
record's implementing file scope and is named as follow-up work, not
claimed as done.

## Consequences

- `value_estimate` along a verified path is 1, and along a failed path it
  is that failure's measured partial or an unmeasured 0. A marginal success
  and a strong one now back up the same value. That is intended: a
  `!verified` pass is binary, and ADR-133's "strength" was the prior.
- `best_score` reports measured quality. Expect 1 for any campaign that
  verified something, a fraction below 0.9 for one that has only measured
  failures, and 0 otherwise. Campaign snapshots persisted before this
  record keep their old prior-scale `best_score`. Because the update is a
  running max, a resumed old campaign keeps reporting the old value.
- **Behaviour change in the halt.** Once a node verifies, the measured best
  is 1. With `min_score` in [0, 1], `below_threshold` can then no longer
  fire. Before this record it fired when the verified node's *prior* fell
  below `min_score`, for example a low gain/cost action. That halt was a
  statement about estimates and is gone. `min_score > 1` would now halt
  immediately after the first verification. Campaigns still halt on budget,
  convergence, no remaining nodes, or manual request. Budget-optimal
  stopping on measured value is plan Stage 5's job.
- The graded channel needs a producer. `worktree-machine-verifier.ts`
  already records per-stage results, but its failure outcome does not carry
  the planned stage total, and `loop.ts` does not yet pass `stages` into
  `verification_failure`. Until both are wired, every production failure
  backs up an unmeasured 0, the same value it effectively backed up before.
  The contract and the manager seam are in place. The producer is follow-up
  work in files outside this record's implementing scope.
- The `BackedUpReward` record is returned to the caller and is fully
  reproducible from its observations. It is not yet journaled as its own
  durable ledger field. The trace keeps `score_after` as the node's
  selection score. Making the reward itself durable needs an additive field
  on `TreeNode` or on the audit trace packet, which is follow-up work.

## Alternatives / Roads not taken

**Keep ADR-133 and only amend §2.** Rejected by operator decision on
2026-10-06. ADR-133's Decision binds §2 and §3 together ("each half is inert
without the other"), so a §2-only amendment would leave a record whose
stated rationale no longer holds. This record carries §1, §3 and §4 forward
explicitly instead.

**Back up the critic's confidence directly, uncalibrated (the LATS and
SWE-Search pattern).** Rejected by operator decision. An uncalibrated model
judgement in the backed-up value is a self-report entering an
authority-bearing number. It would also let the critic's agreement inflate
a result the verifier never saw.

**Back up `1` on success and `0` on failure (pre-ADR-133).** Rejected. It
discards the one real graded signal the verifier already produces, the
stage fraction, and so cannot rank a near-miss above a total failure.

**Let a measured partial trigger the below-threshold halt before anything
verifies.** Rejected. It would halt a campaign after one fully failed staged
attempt, the 2026-08-08 defect in a new form. Any stopping rule on measured
value belongs to plan Stage 5, with live evidence.

**Make `best_known` selection-neutral in the same change.** Deferred, not
rejected. It is a one-line source change in `loop-adapters.ts`, outside this
record's file scope, and is recorded above as the follow-up that restores
exact selection neutrality.

## Obligations

### O1 — The backed-up reward is a pure function of measured, provenance-typed observations, in which no planner prior can appear and only a `!verified` pass reaches 1

`combineReward` returns 1 only for a `terminal` observation carrying
`!verified` provenance. It bounds every other outcome by `τ < 1`, weighs an
uncalibrated estimate at 0, and is order-independent. Property tests show
that smuggling `estimated_gain`, `estimated_cost`, a selection score or an
exploration bonus onto observations never changes the result, and that
replay in any order is byte-identical.

<!-- proof: symbol=combineReward file=packages/arbor-core/src/reward.ts roundtrip=packages/arbor-core/tests/reward.test.ts -->

### O2 — `recordResult` backs up 1 with `!verified` provenance on a verified pass, and the measured stage fraction on a failed verification, never the node's selection score

The manager integration tests drive real `recordResult` calls. A verified
pass backs up `value: 1, provenance_tag: "verified"` to the node and the
root, while `node.score` still holds the selection prior. A failed staged
verification with 2 of 3 stages passed backs up `0.9 · 2/3` with
`provenance_tag: "generated"`. A refused `verified` claim backs up an
unmeasured 0. Across 25 randomised gain/cost/context priors, every backed-up
value and `best_score` is identical. Two runs of the same outcomes produce
byte-identical rewards and tree values.

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager.test.ts -->

### O3 — The below-threshold halt compares measured quality, and an unmeasured or pre-verification value never trips it

`haltCheck` treats `bestScore === null` as "nothing measured" and never
halts `below_threshold` on it. The manager passes it a value only once a
node has verified, so a measured pre-verification partial below
`min_score` does not halt the campaign. The manager integration test covers
this with `min_score: 0.7` against a 0.6 partial.

<!-- proof: symbol=haltCheck file=packages/arbor-core/src/scoring.ts roundtrip=packages/arbor-core/tests/scoring.test.ts -->

### O4 — The graded channel's production producer and a durable reward record are not yet implemented

The verifier-to-loop path does not yet populate
`verification_failure.stages`, and `BackedUpReward` is returned but not
journaled as its own ledger or snapshot field. Both live in files outside
this record's implementing scope, so they are recorded here as open, not
claimed.

<!-- unverifiable: the stage-count producer (worktree-machine-verifier.ts, loop.ts) and a durable reward field (TreeNode or the audit trace packet) do not exist yet to roundtrip against -->
