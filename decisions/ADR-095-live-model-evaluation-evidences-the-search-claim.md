# ADR-095: A Search Claim Is Evidenced By Live-Model Evaluation, Not Simulated Outcomes

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 5afc268fd12b3731abf2ba5b1ca52a3c941f8153
**Content ID:** sha256:c186489fe462701a94b860dbb70f80209365443cc38920ad698cae7c5f2f6584

## Context

`packages/arbor-eval/` is the harness's only claimed measurement of whether
tree search works, and it never calls a live model. `tasks.ts`'s
`createLearningOutcomeGenerator` scores every campaign with
`deterministicHash(taskId, branchIndex, seed)` — a seeded FNV-1a-style hash
mapped through a `baseRate`/`learningBonus` curve — and picks a canned
rationale string from a five-entry array. `benchmark.ts`'s own G-25 comment
(lines 24-31) says it plainly: `verified` provenance is never produced
because "the benchmark never runs a real 'test' command"; every result is
tagged `claimed` with a fixed `claimant: "seed"`. There is no `fetch` call
and no API-key read anywhere under `packages/arbor-eval/src` — confirmed by
grep, not assumed. `metrics.ts` line 43 documents `kb_hit_rate` as
"stub-tracked" in its own docstring. `staged-native-safety.ts` is honest
about its own scope in its file header ("a synthetic regression evaluator...
not a model-security benchmark") and drives the real `NativeAgentExecutor`
against in-process scripted SSE fixtures, not a live model.

`gate:eval-regression` (`scripts/eval-regression-gate.ts`) already exists and
is honest about what it is: its header states it is "a REGRESSION DETECTOR
for the tree-search loop's decision behavior against a fixed synthetic
scenario set" and "NOT a quality measure of real campaigns." It pins six
metrics from `defaultTasks` at `RUNS_PER_TASK=3`, `MAX_ITERATIONS=50`, fails
on any `delta > TOLERANCE` (0.01), and its 2026-08-19 re-pin history shows it
catching a real production regression (`manager.ts`'s convergence counter).
It answers "did the deterministic algorithm change behavior," never "does
tree search beat the alternative." No test in this repository answers that
second question against a live model, and it is the repo's headline claim.

One eval in this package is not synthetic: `repository-retrieval-eval.ts`'s
`evaluateRepositoryRetrieval` runs a real `RepositoryGraphIndex` over real
cohort tasks, checks `required_path_groups` against actual retrieved paths,
computes real recall (`exact_task_recall`) and token-reduction
(`mean_projection_reduction`), separates `calibration` from `held_out`
cohort provenance so calibration can never promote the candidate, and
supports ablation arms via `evaluateRepositoryRetrievalAblation`. It proves
the pattern this ADR asks the tree-search claim to follow is buildable here
today — cited as the shape to generalize, not as evidence resolving the
tree-search question itself (it measures retrieval, not search).

## Decision

**1. A real task suite runs against a real provider with real
verification.** A new `arbor-eval` lane (e.g.
`packages/arbor-eval/src/live-tasks.ts`) replaces `deterministicHash`-scored
outcomes with: a suite of real, verifiable coding problems (a repo checkout
plus an actual test command, SWE-bench-style); a real model call through the
harness's existing model port abstraction
(`createOpenAICompatibleModelPort`, already used by `staged-native-safety.ts`
against fixtures — the live lane points the same port shape at a real
provider); and a `verified` `Provenance` produced only when the task's
actual test command runs and its stdout is content-hashed, closing the gap
G-25 named. `benchmark.ts`'s `claimedProv` becomes the honest tag for
scripted or unverified outcomes; the live lane earns `verified` the way
`CampaignManager.recordResult` already expects it to be earned.

**2. The ablation the repo's central claim depends on: tree-search-on vs
tree-search-off.** Each task runs twice per configuration — once through
`CampaignManager`'s branch/select/backtrack loop
(`selectNode`, `packages/arbor-core/src/tree.ts`), once through a linear
single-branch baseline with no UCB selection and no backtracking. Both arms
share prompt, model, verification command, and seed set. The comparison
metric is task success rate at fixed verification-call budget (not
wall-clock, so provider latency variance cannot contaminate the result),
plus the four existing roadmap metrics (`computeMetrics`) reused from the
scripted harness, now computed over real outcomes instead of a hash.

**3. Cost and determinism get explicit bounds.** A fixed, small task set
(target 8-12, roughly double `defaultTasks`' 5, chosen for
verification-command diversity) at a capped `n` per arm per task (target
`n=3`, mirroring `RUNS_PER_TASK`), with a hard per-run dollar ceiling
enforced *before* dispatch — the harness refuses to start a run that would
exceed it. This runs on a slower cadence than `gate:eval-regression`
(nightly/pre-release, not every push): it costs money, and the scripted gate
already catches algorithmic drift for free. Verdicts come from an n-of-m
rule over the capped run count per arm, reported with the raw per-seed
results and a confidence interval on the win rate — never one noisy call
standing in for "the answer." A held-out task subset never used to tune
scoring constants (`exploration_constant`, `NO_BASELINE_EPSILON`) is
reserved so the ablation cannot be overfit by the team reading its result.

**4. What happens if tree search does not win.** If the ablation shows the
linear baseline matching or beating tree search at equal budget on the
held-out set, the finding is filed as a governance obligation against
ADR-002 (Arbor's tree-search adoption) for the operator to act on — never
silently absorbed, re-run until it flips, or buried by loosening the
comparison for one arm only. The report format carries both arms' raw
results side by side so a losing tree-search arm is exactly as visible as a
winning one.

## Consequences

The repo gains its first eval that can actually falsify the tree-search
claim; today nothing can. Cost and latency enter the release cadence for the
first time — someone has to own the dollar ceiling and the API key.
Determinism moves from guaranteed (a seeded hash always reproduces) to
statistically bounded (an n-of-m verdict over noisy real calls) — worse in
isolation, acceptable only because the deterministic proxy has been proven
not to measure the claim at all. `gate:eval-regression` is unchanged and
keeps its free, every-push job. This does NOT change
`staged-native-safety.ts`: it stays a synthetic safety regression evaluator
against fixtures, where reproducibility matters more than live variance.

## Alternatives / Roads not taken

**Make `defaultTasks` live in place.** Rejected: those five tasks have no
verification command at all — prompts with a hand-authored
`expectedGoodOutcome` string. A live model against them produces a
`claimed`-tagged opinion, not `verified` provenance, and would not close
G-25's gap.

**Fold live evaluation into `gate:eval-regression`.** Rejected: that gate's
value is being free, deterministic, and run on every push. A paid,
non-deterministic step either slows every push or gets skipped by default
and rots — the failure mode the gate's own header warns against.

**Use an LLM-as-judge instead of a real test command.** Rejected for the
primary metric: it reintroduces the "canned rationale" problem this ADR
exists to remove, with a more expensive hash function. Real test commands
are used wherever available; an LLM judge is a documented fallback for
non-automatable tasks only, reported separately from the primary metric.

## Obligations

### O1 — The retrieval eval already demonstrates the real-verification pattern this ADR generalizes to search

`evaluateRepositoryRetrieval` computes `exact_task_recall` and
`mean_projection_reduction` against a real `RepositoryGraphIndex` snapshot,
separates `calibration` from `held_out` cohort provenance, and supports
ablation via `evaluateRepositoryRetrievalAblation` — proving a real,
ablation-capable eval is buildable here today. This resolves only the
pattern's existence, not tree search specifically.

<!-- proof: symbol=evaluateRepositoryRetrieval file=packages/arbor-eval/src/repository-retrieval-eval.ts roundtrip=packages/arbor-eval/tests/repository-retrieval-eval.test.ts -->

### O2 — `gate:eval-regression` is scoped honestly as a deterministic drift detector, and this ADR does not change that scope

The gate's own header states its scope and its 2026-08-19 history shows a
real catch. This ADR's obligation is negative: the live lane must not merge
into this gate's every-push, zero-cost path.

<!-- unverifiable: this is a constraint on a decision not yet implemented, properly checked by code review of the future PR that adds the live lane, not by a symbol/test roundtrip -->

### O3 — The live suite produces `verified` provenance only when its own task's test command actually ran

`packages/arbor-eval/src/live-verification.ts`'s `verifiedProvenanceFromRun`
is the sole place `live-ablation.ts` may obtain a `verified`-tagged
`Provenance`: it returns `null` — never a fabricated tag — unless
`runVerificationCommand` actually spawned the task's real command to
completion with `exit === 0`, mirroring `checkEvidence`'s
(`packages/arbor-gate/src/gate.ts`) existing `verified` contract. A `null`
result forces the caller onto the `claimed`/failure path
(`live-ablation.ts`'s `runTreeSearchArm`/`runLinearArm`), so the eval cannot
claim a stronger result than the scripted harness's `claimedProv` ever
could. UNEXECUTED AGAINST A REAL PROVIDER: the roundtrip test below proves
the provenance boundary itself (ran-but-failed and never-ran both refuse
`verified`); it does not call a live model — no credential was available in
the tranche that landed this obligation (see `live-model-port.ts`'s
`resolveLiveModelConfigFromEnv`, which refuses to substitute a scripted
result for a missing credential).

<!-- proof: symbol=verifiedProvenanceFromRun file=packages/arbor-eval/src/live-verification.ts roundtrip=packages/arbor-eval/tests/live-verification.test.ts -->

### O4 — The ablation reports both arms' raw per-seed results, so a losing tree-search verdict is exactly as visible as a winning one

`packages/arbor-eval/src/live-report.ts`'s `generateLiveAblationReport`
always renders a raw per-seed attempt table for both the `tree_search` and
`linear` arms of every task, alongside the aggregate success rate, n-of-m
verdict, and Wilson-interval confidence bound (`live-ablation.ts`'s
`summarizeArm`/`wilsonInterval`) — there is no aggregate-only render path.
UNEXECUTED AGAINST A REAL PROVIDER: the roundtrip test below drives the
renderer against a synthetic `LiveAblationReport` fixture, not a report
produced by an actual live-model run (see O3's note on credential
availability).

<!-- proof: symbol=generateLiveAblationReport file=packages/arbor-eval/src/live-report.ts roundtrip=packages/arbor-eval/tests/live-report.test.ts -->
