# ADR-186: Search Policy Core and the @arbor/search-runtime Package

**Status:** Accepted
**Date:** 2026-10-06
**Authoring Revision:** fd77110c437db4ea710b479739ff5395b4f98bee
**Content ID:** sha256:0972f10897e3b40f2c0cc5ecd2d326d990a4a14991f36c3ad7b9c0f6186252dd

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances).

The production path does not search. It runs a priority-ordered worklist of
plan steps, one attempt per step, and no code path creates an alternative
attempt for the same step; the selection score cannot tell candidates apart on
evidence. The literature on budgeted, verifier-terminated code search at 3–30
rollouts points to three arms worth having: width (independent samples, judged
by the verifier), depth (refining a failed attempt with its feedback), and an
adaptive choice between them (AB-MCTS, arXiv 2503.04412, which decides wider vs
deeper by Thompson sampling). Even the adaptive arm barely beats flat repeated
sampling at small budgets, and sometimes loses.

ADR-131 forbids changing selection math by inspection: every change must cite
live-ablation evidence. That evidence (UCT plan Stage 0) does not exist yet. So
this record decides the **mechanism** only — a pure, replayable search core the
ablation and, later, the loop can share — and changes no production behaviour.

The operator decided on 2026-10-06: the step objective is the first verified
attempt; the budget unit is provider-measured USD with an attempt cap; ADR-002's
eq. 1 stays selectable as `arbor_eq1`; verifier-gated best-of-N is the permanent
baseline arm and ships as the default if adaptive search does not beat it; the
loop code lives in a new neutral package `@arbor/search-runtime`, with the pure
policies in `@arbor/core`.

## Decision

1. **A search step is a pure state machine in `@arbor/core`
   (`packages/arbor-core/src/search/`).** A step is one OR-node: attempts at the
   same plan step, each either GEN (fresh from the step base) or REFINE (a child
   of an observed, unverified attempt). `decideSearchStep` returns `dispatch`
   (with the new in-flight attempt and its replay record), `await` (an attempt
   in flight may still verify or unlock an arm), or `stop`.
   `applySearchObservation` lands one reward. No I/O, no clock, no other
   package; `@arbor/core` keeps its no-internal-dependency rule.

2. **Five selectable policies behind one config (`SearchPolicyConfig`).**
   - `abmcts_beta` — Thompson sampling over Beta posteriors, descending the
     attempt tree. At each node the existing children are aggregated behind one
     CONT arm: GEN (rewards of the node's direct children) is drawn against CONT
     (rewards of every deeper attempt below them), and only if CONT wins does a
     second draw pick the child by its subtree posterior. Without the
     aggregation, the maximum of many wide child posteriors biased the choice
     toward deeper; the seeded simulation showed it refining at least as often when
     refining hurt as when it helped. Rewards update the posterior as
     fractional pseudo-counts; each in-flight attempt adds `virtual_loss`
     pseudo-failures to every arm containing it.
   - `puct` — Q + c·P·√N/(1+n) with optional priors (`gen_prior_weight`, and an
     observation's `refine_prior` for its REFINE arm).
   - `arbor_eq1` — ADR-002's eq. 1, computed by the production `scoreAction`
     (one implementation), with the arm's visits as n_cat.
   - `best_of_n` — always GEN: verifier-gated repeated sampling, the baseline.
   - `refine_chain` — refine the latest attempt while refinable, else GEN.

   `max_refine_depth` and `max_width` bound the tree. With depth 0 and width N,
   every policy dispatches exactly best-of-N.

3. **Stopping.** The first observation carrying `!verified` provenance (exit 0,
   reward 1) ends the step. Otherwise the step stops at the attempt cap, when
   provider-measured spend reaches `max_usd`, or when no arm remains. A limit
   reached while an attempt is in flight yields `await`, because that attempt
   can still verify. A reward of 1 without `!verified` provenance never ends a
   step: reward orders work, verification retires it.

4. **Every decision is a replay record, and replay is exact.** Each decision
   draws from a generator whose whole state is one uint32, derived from
   (seed, step, decision index), so a decision can be re-derived alone. The
   record holds that state, every arm's statistics (posterior α/β and the
   draw, or the PUCT/eq. 1 score), the chosen arm per level, the action, and
   the attempt and spend counts before it. `replaySearchStep` rebuilds a step
   from its ledger events and re-derives each decision, comparing numbers with
   `Object.is`; the first divergence is reported with both records.

5. **The reward is consumed through a minimal input type, `SearchRewardInput`**
   (reward in [0, 1], `!verified` provenance or null, provider-measured
   `cost_usd`). It is the join point with the Stage 1 reward contract (lane U1,
   `packages/arbor-core/src/reward*.ts`), whose channel combiner supplies the
   scalar; this record does not define how channels combine.

6. **`@arbor/search-runtime` is a new workspace package**, depending only on
   `@arbor/core`. It exports `runSearchStep`, a sequential (K = 1) driver that
   writes each decision to a `SearchLedgerSink` before dispatching it
   (write-ahead) and each validated observation after, and the
   `SearchAttemptDispatcher` interface that UCT plan Stage 3 implements with
   worktree-leased GEN/REFINE dispatches. Under ADR-061 it is where new loop
   logic lands, not `@arbor/opencode`.

7. **Nothing in production calls any of this yet.** Per ADR-131 the policies
   stay off every production path until Stage 0 reports. The seeded simulation
   in `packages/arbor-core/tests/search/simulation.test.ts` is a correctness and
   regression lane over synthetic tasks with known latent success
   probabilities. It is not efficacy evidence.

## Consequences

**Positive.** The eval arms and the eventual production loop can come from one
code path (ADR-157's single-implementation rule applied to search). Every
selection decision is auditable and replayable from the ledger. Eq. 1 stays
testable as an arm.

**Negative, stated rather than implied.**

- `Math.log`/`Math.exp` are not required by ECMA-262 to be correctly rounded,
  so a Beta draw is bit-for-bit reproducible on one JavaScript engine; across
  engines (Node's V8 and Bun's JSC) a last-place difference is possible. Replay
  would report it as a mismatch, never hide it. Cross-engine replay has not
  been tested.
- The arm statistics (GEN over direct children, CONT over deeper attempts,
  child arms over whole subtrees) are this record's own definitions, written
  from the paper's description. They are not checked against the reference
  implementation, which clean-room rules keep us from copying.
- Under the first-verified objective a success ends the step, so the bandit
  learns only from graded failure rewards. If those carry little signal about
  whether refining pays, `abmcts_beta` can do no better than best-of-N; in the
  simulator's neutral regime it lands within 0.05 of it.
- The driver is sequential. `await` exists in the core for Stage 4's parallel
  width, which no driver produces yet.
- The workspace gains a fifteenth package; two documents that state a package
  count of 14 drift under `gate:sur-05`.

## Alternatives / Roads not taken

- **Flat Thompson over GEN plus every child arm.** Implemented first and
  measured in the seeded simulation at 16 attempts: it refined 50% of the time
  when refining helped and 56% when it hurt. With CONT aggregation the shares
  are 47% and 38%. Replaced by CONT aggregation.
- **One RNG stream per step.** Rejected: re-deriving decision k would need all
  k−1 earlier draws. A per-decision state makes each record self-contained.
- **Recording draws and replaying from them instead of re-deriving.** Rejected
  as the primary check: it would prove only that the argmax was taken, not that
  the draws came from the declared seed and posteriors.
- **Put the driver in `@arbor/opencode` or `@arbor/campaign-support`.**
  Rejected by the operator's 2026-10-06 decision and ADR-061.

## Obligations

### O1 — A step dispatches, awaits or stops exactly as the stopping rule says

<!-- proof: symbol=decideSearchStep file=packages/arbor-core/src/search/step.ts roundtrip=packages/arbor-core/tests/search/step.test.ts -->

Every policy stops at the first verified attempt, at the attempt cap and at the
USD budget; an in-flight attempt at a limit yields `await`; reward 1 without
`!verified` provenance does not stop a step.

### O2 — Only well-formed rewards land, and verification needs `!verified` provenance

<!-- proof: symbol=applySearchObservation file=packages/arbor-core/src/search/step.ts roundtrip=packages/arbor-core/tests/search/step.test.ts -->

Unknown or already-observed attempts, rewards outside [0, 1], negative cost,
and verification that is not exit-0 `!verified` with reward 1 are refused.

### O3 — Thompson posteriors carry exactly the observed rewards, and CONT gates GEN

<!-- proof: symbol=selectSearchAction file=packages/arbor-core/src/search/policy.ts roundtrip=packages/arbor-core/tests/search/step.test.ts -->

The GEN arm's α and β equal the prior plus the fractional reward counts, CONT
carries only deeper attempts, a child arm carries its subtree, virtual loss is
charged for in-flight attempts, and with depth 0 and width N every policy
dispatches exactly best-of-N.

### O4 — A ledger replays bit-for-bit, and a divergence is reported

<!-- proof: symbol=replaySearchStep file=packages/arbor-core/src/search/step.ts roundtrip=packages/arbor-core/tests/search/step.test.ts -->

Every policy's events replay to the identical state; a one-ulp change to a
recorded draw, a different seed, a decision after the stop, and an invalid
observation each fail at the offending event.

### O5 — The generator continues exactly from a recorded state

<!-- proof: symbol=createSeededRng file=packages/arbor-core/src/search/rng.ts roundtrip=packages/arbor-core/tests/search/rng.test.ts -->

A generator rebuilt from `state()` yields the identical stream, uniforms stay in
(0, 1), and a non-uint32 state is refused.

### O6 — Beta draws have the right distribution for shapes above and below 1

<!-- proof: symbol=sampleBeta file=packages/arbor-core/src/search/rng.ts roundtrip=packages/arbor-core/tests/search/rng.test.ts -->

Sample means match α/(α+β) to one decimal over 20,000 draws for five shape
pairs, including shapes below 1.

### O7 — An invalid configuration is refused before any decision

<!-- proof: symbol=validateSearchConfig file=packages/arbor-core/src/search/step.ts roundtrip=packages/arbor-core/tests/search/step.test.ts -->

Every malformed field is reported, and `decideSearchStep` throws on any problem.

### O8 — The runtime driver writes ahead and leaves a replayable ledger

<!-- proof: symbol=runSearchStep file=packages/arbor-search-runtime/src/driver.ts roundtrip=packages/arbor-search-runtime/tests/driver.test.ts -->

Each decision is in the ledger before its dispatch, every policy's ledger
replays to the driver's final state, and a wrong-attempt or invalid answer
throws with the attempt left in flight.
