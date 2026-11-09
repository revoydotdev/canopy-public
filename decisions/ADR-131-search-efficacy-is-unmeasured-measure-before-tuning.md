# ADR-131: Search Efficacy Is Unmeasured; Measure Before Tuning

**Status:** Accepted
**Date:** 2026-08-27
**Authoring Revision:** 3e7ffa215cf325197b8f0065d2df1e48470650b6
**Content ID:** sha256:37b960e3bcf2f71a12d1476328c2acf5890bd302168bb913d4002f24073333e2

## Context

On SWE-bench Lite, pure independent repeated sampling took DeepSeek-Coder-V2
from 15.9% (n=1) to **56% (n=250)** — Brown et al., *Large Language Monkeys*,
arXiv 2407.21787 — beating the contemporaneous single-sample state of the
art (43%) with no tree, no scoring function, no selection policy: just draw
more i.i.d. samples and keep any that verify. A frontier literature search
run for this ADR (arXiv, GitHub, HuggingFace, via the `frontier` MCP) found
**no compute-matched tree-search-vs-repeated-sampling study for coding
agents anywhere in the literature**. That is a recorded empty result, not a
failure to look: the two purpose-built agent-tree-search papers this
project already cites (Tree-GRPO, arXiv 2509.21240; Koh et al., arXiv
2407.01476 — see the companion ADR on the exploration term) both compare
tree-structured search against a *chain-based* or *single-trajectory*
baseline, never against unstructured repeated sampling at the same call
budget. Nobody has published the comparison this repository's core premise
depends on.

That premise is substantial. `packages/arbor-core/src/scoring.ts` (UCT
selection), `tree.ts` (node lifecycle, `selectNode`, `beginExpansion`,
`failNode`), ADR-106 (backpropagation along the selected path), and
`packages/arbor-mcp/src/manager.ts` (worktree isolation, leases, racing)
are all real, load-bearing machinery, built and iterated on the assumption
that scored tree search beats trying things independently and keeping
whichever attempt verifies. ADR-002 cites the Arbor paper's own throughput
numbers (+40–193%) as empirical support, but that paper measures tree
search against a *single unstructured agent* (its own §4.3 "Without DFS
search" ablation), not against the one comparison the Large Language
Monkeys result makes salient: repeated *independent* sampling at equal
compute. Selection math (the exploration term's axis, backprop mechanics,
category- vs. edge-level bookkeeping) has kept being tuned — most recently
ADR-106 — without that more basic question ever being settled for this
repository's own tasks and its own model.

The instrument to settle it already exists.
`packages/arbor-eval/src/live-ablation.ts`'s `runLiveAblation` runs
`LiveArm = "tree_search" | "linear"` over `defaultLiveTasks`
(`live-tasks.ts`) with the SAME `max_calls_per_run` for both arms —
compute-matched by construction, not by post-hoc normalization — real
on-disk fixtures, a real verification command run for real
(`live-verification.ts`), deterministic per-arm seeds via
`computeLiveSeed`, and a pre-dispatch cost ceiling
(`assertWithinCostCeiling`, `live-cost-guard.ts`). It also carries the
falsifiability discipline this ADR needs: `evaluateFalsifiability` is
non-suppressible — the report always states `triggered: true|false` and
never silently absorbs or re-runs a result that goes against the tree
hypothesis (ADR-095 Decision 4).

**What the instrument does and does not currently cover, read directly
from the code, not assumed:**

- **`linear` is neither pure independent repeated sampling nor sequential
  refinement with shared context — it sits in between, and that is a real
  gap against the literature's baseline.** Every attempt, in both arms,
  goes through `runOneAttempt` → `callLiveModel`, which constructs a fresh
  `NativeModelRequest` with `history: []` (`live-model-port.ts:125`) — no
  transcript of prior attempts is ever passed to the model. But
  `live-tasks.ts`'s `prompt(attempt)` appends one line when `attempt > 0`:
  `"A previous attempt (#N) did not pass verification; try a different
  fix."` (`live-tasks.ts:66`) — no diff, no stderr, no code from the failed
  attempt, just the fact that *a* prior attempt failed. Large Language
  Monkeys' repeated-sampling baseline carries no such hint at all (each
  sample is drawn independently from the same prompt); a from-scratch
  sequential-refinement baseline would carry the actual failure. This
  harness's `linear` arm is a specific third thing, and a result from it
  supports "independent-ish sampling vs. this repo's tree search," not
  cleanly "the literature's repeated-sampling baseline vs. this repo's tree
  search." Any report drawn from this instrument must say so explicitly
  rather than borrow the literature's baseline name for a baseline that
  differs from it.
- **The `tree_search` arm's selection mechanism is not yet exercised by
  this instrument in a way that could show a difference from `linear`,
  independent of the refinement-hint question above.** `runTreeSearchArm`
  pre-creates all `max_calls_per_run` sibling `branchAction`s up front
  (`live-ablation.ts:246-248`), every one with identical
  `estimated_gain: 50`, `estimated_cost: 5`, and `category: "live-fix"`
  (`:365-366`), and scores them against a single frozen `scoreCtx` constant
  (`:114`) that is never updated from real attempt outcomes. Reading
  `tree.ts`'s `selectNode` (`packages/arbor-core/src/tree.ts:12-63`):
  `scoreAction` is called with the same `categoryVisits` denominator for
  every pending sibling of the same category, so identically-parameterized
  siblings score identically at every call; ties are broken by strict `>`
  against `Map` iteration order, i.e. insertion order — the same order
  `branchAction`s were pushed in. The consequence, verified by reading, not
  assumed: under this harness's current construction, `selectNode` picks
  attempts in the same fixed sequence `linear`'s `for` loop already uses,
  every run. The two arms differ in real overhead this ADR does not dispute
  (`CampaignManager`'s worktree-isolation gate, lease acquisition, ledger
  writes, `haltStatus` checks) but, as built today, do not yet differ in
  *which attempt gets tried when* — the one thing UCB selection exists to
  change. A negative or null result from this instrument as it stands today
  would not distinguish "tree search doesn't help" from "this harness
  cannot yet produce a tree search that behaves differently from linear
  order." Closing that gap — giving sibling branches genuinely
  differentiated scores, e.g. by feeding real per-attempt outcomes back
  into `ScoreContext` between calls — is required before a `tree_search`
  vs. `linear` run through this instrument is evidence about selection,
  rather than evidence about running more attempts.

## Decision

**Efficacy is measured, honestly and with its current instrument gaps
disclosed, before selection math is tuned any further.**

1. No further changes to `packages/arbor-core/src/scoring.ts`'s selection
   formula, `tree.ts`'s selection/backtracking mechanics, or
   `manager.ts`'s scoring-adjacent wiring are undertaken as pure
   improvements-by-inspection. Every future selection-math change states,
   in its own ADR, what live-ablation evidence motivates it or why none is
   available yet.
2. Before `runLiveAblation` is run for a decision-grade result, the
   instrument gap identified above is closed: `runTreeSearchArm` (or a
   sibling harness) must let sibling branch scores diverge based on real
   observed outcomes — at minimum, threading `attemptResult` back into the
   `ScoreContext` passed to the next `selectNode` call, so UCB selection
   has something to select on. Running the ablation before this closes
   would produce a number that answers a narrower question than "does tree
   search help" and must not be reported as though it answers the broader
   one.
3. Once that gap is closed, `runLiveAblation` is run against
   `defaultLiveTasks` with a real model and credential
   (`resolveLiveModelConfigFromEnv`), and the held-out
   `FalsifiabilityFinding` is read and acted on exactly as ADR-095 Decision
   4 requires — including a negative result. This ADR does not pre-commit
   to what the result will be.
4. Until both a closed instrument gap and an actual held-out run exist,
   any claim that "search beats repeated sampling for this repository's
   tasks" is unverified and must be stated as such wherever it appears
   (READMEs, other ADRs' Context sections, roadmap copy).

## Consequences

**If tree search wins the held-out comparison once the instrument gap is
closed:** the existing selection/backprop machinery (ADR-002, ADR-106) has
a real, repo-specific empirical basis for the first time, and further
tuning (the companion ADR's third-arm proposal) is justified by evidence
rather than by paper-fidelity alone.

**If linear matches or beats tree search on the held-out set:** that is a
real, actionable outcome, not a failure of this ADR. `evaluateFalsifiability`
already generates the obligation text to file against `decisions/ADR-002-*.md`
verbatim — Decision §4's disclosure requirement is what would be exercised
first, since every place the repo currently asserts that tree search helps
would need that assertion qualified or withdrawn pending the ADR-002 filing.
`CampaignManager`'s worktree isolation, racing, and audit-ledger machinery
would likely still be defensible on operational grounds (reproducibility,
crash recovery, evidence) independent of a selection-efficacy win — but that
is a separate argument this ADR does not make for it. A negative result
would not, by itself, obligate ripping out the tree; it would obligate
being honest that the tree's *selection* premise, specifically, is
unsupported for this repository's own tasks.

This ADR's honest cost: shipping a decision-grade live-ablation run is
slower than continuing to tune scoring math on inspection alone, and
closing the instrument gap (Decision §2) is real, unscoped implementation
work this ADR does not itself perform. That slowdown is accepted because
tuning a selection mechanism nobody has shown adds value, on an instrument
that (today) cannot yet show a difference from not having it, is optimizing
noise.

## Alternatives / Roads not taken

**Keep tuning selection math on paper-fidelity and code-review judgment
alone, without a live measurement.** Rejected: this is the status quo this
ADR exists to stop. ADR-106 is a real example — a genuine improvement to
backprop mechanics, landed with no live-ablation evidence either direction,
because none existed to consult.

**Run `runLiveAblation` immediately, instrument gap and all, and report
whatever it says.** Rejected: given the analysis above, a run today would
almost certainly show `linear` and `tree_search` performing similarly
— not because search doesn't help, but because the harness cannot yet
produce a `tree_search` arm that selects differently from `linear`. Reporting
that as "search doesn't help" would be a false negative baked into the
instrument, exactly the kind of false confidence this repository's own
governance principles (see `decisions/ADR-117-*.md`'s pattern of reading
code, not assuming behavior) exist to prevent.

**Treat the Arbor paper's own reported gains (+40–193%) as sufficient
evidence and skip a repo-specific measurement.** Rejected: the paper
measures its full multi-agent system (Orchestrator, Domain Specialists,
Critic, KB) against a single unstructured agent on LLM-inference-kernel
optimization — a different task domain, different model tier, and a
different baseline (no baseline arm resembling independent repeated
sampling appears in its ablation, §4.3). Those numbers support that
Arbor's full system beats one agent with no harness; they do not speak to
whether *this repository's* selection math, on *this repository's* coding
tasks, beats trying several things independently and keeping whichever one
verifies — the exact comparison Large Language Monkeys makes salient and
the literature search for this ADR found nowhere else answered.

## Obligations

### O1 — `runLiveAblation` runs both arms at an identical, fixed verification-call budget (`max_calls_per_run`), so any efficacy comparison it produces is compute-matched by construction

Both `runTreeSearchArm` and `runLinearArm` are bounded by the same
`input.max_calls_per_run` (`live-ablation.ts:247` and `:322`), and
`runLiveAblation` estimates and gates cost once, before either arm runs
(`assertWithinCostCeiling`, `:128`), so a future efficacy claim from this
instrument cannot be an artifact of one arm getting more attempts or more
budget than the other.

<!-- proof: symbol=runLiveAblation file=packages/arbor-eval/src/live-ablation.ts roundtrip=packages/arbor-eval/tests/live-ablation.test.ts -->

### O2 — A held-out result where linear matches or beats tree search is always surfaced as a non-suppressible finding, never silently absorbed or re-run until it flips

`evaluateFalsifiability` always returns a `FalsifiabilityFinding` with an
explicit `triggered` boolean and, when triggered, ready-to-file obligation
prose naming `decisions/ADR-002-*.md` — there is no code path in
`runLiveAblation` that omits this field or re-runs the ablation to seek a
different outcome.

<!-- proof: symbol=evaluateFalsifiability file=packages/arbor-eval/src/live-ablation.ts roundtrip=packages/arbor-eval/tests/live-ablation.test.ts -->

### O3 — Before Decision §3's decision-grade run, sibling branch nodes in `runTreeSearchArm` must be able to score differently from one another based on real observed attempt outcomes — today they cannot

This obligation records a currently-true negative claim about the
instrument (verified by reading `live-ablation.ts:114`, `:246-248`,
`:365-366` and `tree.ts:12-63` together, per this ADR's Context section),
not a capability that exists yet to roundtrip-test. Closing it is unscoped
future implementation work this ADR does not perform, so no proof can
resolve against code that does not exist without either fabricating the
capability outside this ADR's own decision or forcing a proof that
demonstrates less than the claim — both of which the repo's proof
discipline (`gate:obligations` M-B) rules out.

<!-- unverifiable: describes a currently-absent capability (differentiated sibling scoring from real outcomes) that Decision §2 requires be built before a decision-grade run, not yet implemented by this ADR -->
