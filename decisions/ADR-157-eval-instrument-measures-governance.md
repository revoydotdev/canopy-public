# ADR-157: The Live Ablation Separates Governance From Search, And Can Fail

**Status:** Accepted
**Date:** 2026-09-02
**Authoring Revision:** f1addae3157ddaed22fc6f95fb5f1cf360073e18
**Content ID:** sha256:a5ae28872b0f06d993e94064b7befbff46ec755946279f3c484d083744213bd4

## Context

ADR-095 built a live-model ablation to evidence the repository's central claim, with
methodology that is genuinely careful: success rate at a fixed verification-call budget so
provider latency cannot contaminate it, a held-out task subset so the result cannot be
overfit by the team reading it, a hard pre-dispatch cost ceiling, and a pre-registered
falsifiability clause that must surface a losing tree-search arm rather than absorb it.
ADR-131 then froze all further selection-math tuning until that instrument had produced a
decision-grade result, and required any claim that search wins to be marked unverified
until it had.

The instrument had never been run. `find / -name live-ablation.json` returns nothing.

Reading it before running it found three defects, each of which would have made a run
uninformative rather than merely weak.

**1. A ceiling effect.** The task suite was ten single-function exercises: an off-by-one in
an array sum, a `reverse` whose broken body returned its input unchanged, FizzBuzz with
swapped conditions, an anagram check that lowercased. Two were held out. A mid-tier model
solves essentially all of them on attempt 0. When attempt 0 succeeds there is nothing to
backtrack from and no sibling branch to select between, so every arm converges by
construction. A null result would have said nothing about search, which is the worst
outcome available to a pre-registered falsification design: it looks like evidence and is
not.

**2. No feedback channel.** `prompt(attempt)` appended only "a previous attempt did not
pass verification; try a different fix" — no failing output, no indication of which case
broke. Every attempt was therefore a near-independent draw. That makes all arms blind
repeated sampling and leaves the tree arm selecting between options it has no information
to distinguish. The comparison could not have come out any way but null.

**3. The arms confounded two variables.** `tree_search` was CampaignManager governance PLUS
UCB selection and backtracking; `linear` was a raw loop with neither. A difference between
them was attributable to search or to governance and there was no way to tell which. The
governance question — does the gate machinery improve outcomes — had no instrument at all,
in a repository whose entire premise is that governance is worth paying for.

A fourth defect sat underneath all of them: every attempt ran in ONE shared working
directory and rewrote the whole target file. With no per-branch state, branches are
indistinguishable and backtracking has nothing to return to, so tree search could not have
expressed its advantage even on a hard task with good feedback.

## Decision

**The instrument is rebuilt so that it can separate its arms, and so that a negative
result is informative rather than vacuous.**

1. **Three arms, each adjacent pair isolating one variable.**
   `ungoverned_linear` is a raw loop with no CampaignManager, no gates, no critic verdict
   and no provenance requirement. `governed_linear` adds the full governed campaign path
   but keeps fixed-order attempts. `governed_tree` adds UCB selection and backtracking.
   So `ungoverned_linear → governed_linear` isolates GOVERNANCE and
   `governed_linear → governed_tree` isolates SEARCH. Success is decided by the same real
   verification command in every arm, so the arms stay comparable and only the machinery
   around the attempt differs.

2. **Both governed arms share one implementation.** Selection is a parameter, not a second
   copy of the body. Two functions would let gate wiring, provenance or critic verdicts
   drift between them, and that drift would land inside the measured search effect
   indistinguishable from a real result.

3. **Failure feedback reaches the next attempt, identically for every arm.** The failing
   verification's stdout and stderr are summarised into the next prompt, truncated so one
   verbose run cannot swallow the context. This is not a thumb on the scale for the
   governed or tree arms; it is the precondition for any arm to beat chance, and
   withholding it equally from all of them is what made the old instrument inert.

4. **Every branch gets its own workspace.** A branch created after a failure inherits the
   failing branch's partial progress; a fresh branch starts from the pristine fixture. The
   prompt shows that branch's CURRENT file. This is what makes backtracking a real move
   with a different starting state rather than a relabelling of an i.i.d. draw.

5. **The task suite is rebuilt for tension, not merely for difficulty.** A task nobody
   solves is as uninformative as one everybody solves. Each task pairs an obvious fix that
   satisfies the headline requirement with a second requirement the tests also check:
   a stated invariant the obvious implementation violates, a language trap, a second bug
   behind the first, a requirement the doc comment contradicts, a complexity bound enforced
   by a real timeout, or a symptom whose cause is in another file. Each pattern appears
   more than once so no single trick carries the suite.

6. **The held-out set is the hardest part of the suite.** It is where the verdict is read,
   so it is the set whose power actually matters. A first pass at the rebuild left the
   held-out tasks solvable on attempt 0, reproducing the original ceiling in the one place
   it does the most damage.

7. **Every task is proven both broken and solvable, in CI.** A shipped task that already
   passes is a free win handed to every arm. A task that is unsolvable is worse: it is
   indistinguishable from a hard one in the aggregate and drags every arm toward zero while
   destroying the instrument's ability to separate them. Both directions are asserted per
   task against a reference solution held in the test file, never beside the prompts.

8. **Falsifiability covers both claims.** ADR-095 Decision 4 pre-registered the search
   clause; this adds its counterpart for governance. A finding is emitted for each claim,
   triggered or not, with both arms' rates side by side. A tie counts as a trigger: the
   burden is on the extra machinery to earn its place, not on the baseline to beat it.

9. **A ceiling effect is a property of the task-model pair, not of the tasks.** The suite
   is therefore run across capability tiers rather than against one model, and the report
   records which model produced which rates.

## First readings

Run 2026-09-02, three capability tiers, 13 tasks (9 calibration, 4 held out), n=3 per arm
per task, a fixed 3-verification-call budget, real models through OpenRouter with real
verification commands. Total measured spend USD 0.86.

Success rate by arm, as `ungoverned_linear / governed_linear / governed_tree`:

| Model | Calibration | Held out |
|---|---|---|
| mistral-small-3.2-24b | 0.96 / 0.89 / 0.89 | 0.58 / 0.75 / 0.58 |
| claude-haiku-4.5 | 1.00 / 1.00 / 1.00 | 0.83 / 0.58 / 0.67 |
| claude-sonnet-5 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |

Held-out effects:

| Model | Governance | Search |
|---|---|---|
| mistral-small-3.2-24b | +0.167 | -0.167 |
| claude-haiku-4.5 | -0.250 | +0.083 |
| claude-sonnet-5 | 0.000 | 0.000 |

**Neither claim is supported or refuted by this run, and the run is reported anyway.**

Both effects change sign between the two informative models. Sonnet 5 is saturated at 1.00
on every arm of both sets and carries no information at all; Haiku 4.5 is saturated on
calibration and informative only on held out. That is decision 9 confirmed empirically: a
ceiling belongs to the task-model pair, and a suite that separates arms for one model can
be inert for a stronger one.

The sampling is far too small to call anything. Held out gives 12 samples per arm, and the
per-task Wilson intervals in the reports span roughly 0.2 to 0.94. At 80% power and
alpha 0.05, detecting a 15-point difference in success rate around 0.6 to 0.7 needs about
**160 samples per arm**, roughly thirteen times what this run collected. The largest effect
observed here, 25 points, would still need about 55.

So the honest state after this work is not "governance helps" or "search helps". It is that
the question has moved from unmeasurable to measurable, one reading exists, it is
noise-dominated, and the cost of a decision-grade answer is now a known quantity rather
than an open one: roughly 50 held-out tasks at n=3, or 16 at n=10, per model, on a model
weak enough not to saturate.

## Consequences

The instrument can now return a result that means something, in either direction. That
includes the direction this repository would least like: if governance does not pay for
itself at equal verification-call budget, the finding is emitted with obligation prose
ready to file, exactly as a losing tree-search arm already was.

The arm rename is breaking. `tree_search` and `linear` no longer exist, and no alias is
provided, because those two names ARE the confound and keeping them would invite it back.
The report schema moves to `arbor.live-ablation/v2` for the same reason: a v1 consumer
reading a v2 report would silently see two of three arms.

What this still does not measure: whether governance improves work that a verification
command cannot score. Every task here has a crisp pass/fail oracle. The governance
machinery's stated purpose includes preventing unaudited claims, stub implementations and
unreachable code — defects that a passing test does not detect and this instrument
therefore cannot see. A governance effect near zero here is evidence about
verifiable-task throughput and is not evidence that the gates are worthless.

The suite is also small. Thirteen tasks at n=3 gives wide confidence intervals, and the
report prints them for exactly that reason. A single run is a reading, not a finding.

## Alternatives / Roads not taken

**Keep the two original arms and add a third.** Rejected: `tree_search` would still mean
governance-plus-search, so the search effect would remain unattributable. The
decomposition only works if the middle arm exists and the endpoints are honest about what
they include.

**Give the tree arm richer feedback than the linear arms.** Rejected as the obvious way to
manufacture a win. Feedback is identical across arms; only selection and governance differ.

**Use SWE-bench directly, as ADR-095 Decision 1's "SWE-bench-style" suggests.** Rejected
for now on contamination grounds this repository has already documented (ADR-134, and the
evaluation guide's note preferring a contamination-resistant live variant), and because a
self-contained fixture keeps "the task's actual test command runs" literally true with no
network checkout. The cost is that these tasks are smaller than real repository work, which
is disclosed rather than papered over.

**Run one model.** Rejected: a ceiling is a property of the task-model pair, and a single
strong model would have reproduced exactly the defect this record exists to remove.

## Obligations

### O1 — The arms decompose the two variables, and both governed arms share one body

`runGovernedArm` takes selection as a parameter, so governance is held identical across
`governed_tree` and `governed_linear` by construction rather than by review.

<!-- proof: symbol=LIVE_ARMS file=packages/arbor-eval/src/live-ablation.ts roundtrip=packages/arbor-eval/tests/live-ablation.test.ts -->

### O2 — Every task is proven both genuinely broken and genuinely solvable

Both directions are asserted per task, so a free-win task and an unsolvable task are each
caught before they can quietly flatten the comparison.

<!-- proof: symbol=defaultLiveTasks file=packages/arbor-eval/src/live-tasks.ts roundtrip=packages/arbor-eval/tests/live-tasks.test.ts -->

### O3 — Failure feedback reaches the next attempt, bounded, and identically for every arm

`summarizeFeedback` truncates a runaway failure rather than letting it swallow the prompt,
and returns nothing when there is nothing to say.

<!-- proof: symbol=summarizeFeedback file=packages/arbor-eval/src/live-tasks.ts roundtrip=packages/arbor-eval/tests/live-tasks.test.ts -->

### O4 — A losing governance arm is exactly as visible as a losing search arm

`evaluateFalsifiability` emits one finding per pre-registered claim, triggered or not, and
treats a tie as a trigger.

<!-- proof: symbol=evaluateFalsifiability file=packages/arbor-eval/src/live-ablation.ts roundtrip=packages/arbor-eval/tests/live-ablation.test.ts -->
