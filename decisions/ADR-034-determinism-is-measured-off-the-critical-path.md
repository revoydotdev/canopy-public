# ADR-034: Determinism Is Measured Off the Critical Path

**Status:** Accepted
**Date:** 2026-08-07

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR governance
by ADR-024's ratification note), and POL-05 flags any record arriving already
accepted as never having traversed the lifecycle.

## Context

Every gate in this repository asks a single-revision, single-run question: does
this symbol exist, is it reachable, does its proof resolve, does its shape match
a stub pattern. None of them can see a test that passes nine runs in ten.

Checked on 2026-08-07: `package.json` contains no script matching
`perf|bench|latency|profile`. `gate:eval-regression` pins scripted-determinism
metrics for the eval harness alone. Nothing anywhere tracks flake rate. A flaky
test and a solid one are indistinguishable to every signal this repository
produces.

That gap lands precisely where it does the most damage. `gate:docs-truth` and
`gate:obligations` both discharge a completeness claim by pointing at a
`roundtrip=` test file, and ADR-033's claim ledger now inherits that same
mechanism for its own discharge evidence. If a cited test is flaky, the claim is
discharged by something that does not reliably hold — and both gates already say
they measure *citation integrity, not correctness*. Reliability of the cited
seam is the assumption underneath all three, and it was unmeasured.

## Decision

**Measure repeated-run behaviour for the cited seam set only, off the critical
path, and gate on the committed result.**

1. **Seams are the test files cited by a `roundtrip=` proof** in ROADMAP.md or
   an ADR — 64 of them at adoption. This is the same join key
   `docs-truth.mjs` and `obligations-gate.ts` already use, so three consumers
   share one definition of "seam" rather than a fourth existing anywhere. The
   full 189-file suite is out of scope: measuring it to learn about 64 would
   cost more and say less.

2. **`.determinism-baseline/current.jsonl`** holds one rollup per seam
   (`flake_rate`, `wall_clock_ms_median`, `wall_clock_ms_spread_pct`,
   `nondeterministic`, `git_revision`, `node_version`).
   **`runs.jsonl`** is the append-only history, so a flake that appears and
   disappears leaves a trace rather than being overwritten.

3. **Measurement is a manual, operator-invoked act.**
   `npm run determinism:refresh` runs the whole cited set N times (default 3) —
   one `vitest` invocation per repeat, not one per file, so three process starts
   rather than 192. It is **not** in `npm run check`, **not** in pre-push, and
   **not** in CI.

4. **The gate reads the committed baseline and never runs a test.**
   - **DB-B (blocking)** — a seam above the 20% flake ceiling.
   - **DB-R (blocking)** — cited seams with no baseline above
     `DETERMINISM_FLOOR = 0`. With the floor at zero this *is* the "new cited
     seam is unmeasured" rule: adding a `roundtrip=` citation without measuring
     it fails immediately. A separate DB-A rule would have been the same
     predicate written twice.
   - **Staleness is reported, never gated.** Forcing a refresh on age would
     reintroduce the cost this design exists to keep off the critical path.

5. **`nondeterministic` means mixed pass AND fail across identical runs.**
   All-fail is a broken test, which the suite already reports. Conflating the
   two would label every red test "flaky" and make the signal useless.

### Why measurement never runs in CI

A flake rate captured on a shared GitHub Actions runner measures **runner
contention**, not this code — the exact noise this axis exists to distinguish
from real nondeterminism. A number produced there would be confidently wrong,
and a confidently wrong number is worse than an absent one. The CI job validates
the committed store; it does not produce it.

### Why the script does not wrap itself in `captest`

This workstation runs a heavy always-on stack and full suites must be
memory-capped. The refresh command's own usage text says to run it under
`captest`. It deliberately does **not** self-invoke `systemd-run`: a script that
re-executes itself inside a transient scope is a new failure mode for marginal
convenience, and the box already has the operator-side convention.

### Scope cuts, stated rather than discovered

- **Allocation is not measured.** Per-file heap needs `--expose-gc` snapshots or
  process-level RSS sampling; neither is cheap or reliable at this granularity.
  A wrong number is worse than no number.
- **Token drift is not measured here.** `packages/arbor-eval` and
  `gate:eval-regression` already own it. A second token counter would be exactly
  the "two stores means two truths, and the older one silently wins" failure
  `packages/arbor-governance/src/vi/exceptions.ts` warns about.

## Consequences

### External determinism evidence (2026-08-12)

Causal Agent Replay ([arXiv:2606.08275](https://arxiv.org/abs/2606.08275), §3) documents why
hosted temperature-zero inference is still not an exact replay contract and reports action-match
rates instead of claiming reproducibility. That posture matches this ADR: determinism is measured,
bounded, and kept off the critical path rather than assumed from provider settings.

**Positive.** The reliability assumption underneath `gate:docs-truth`,
`gate:obligations` and ADR-033's ledger is now measured rather than assumed. At
adoption all 64 cited seams were baselined at 3 runs each and **none** was
nondeterministic — so the floor of 0 is a real measurement, not an aspiration.

**Negative, and load-bearing — this is the weakest gate in the repository.** A
green run means the LAST measurement was within tolerance. It says nothing about
code changed since. Because refresh is manual, the baseline is only as current
as the last person to run it, and staleness does not block.

**Negative.** Three runs is a thin sample. A seam that fails one run in fifty
will read as clean. The ceiling can only fall as evidence accumulates, and
`--repeat` exists so a suspicious seam can be interrogated harder.

**Negative.** Evidence is machine-specific: `git_revision` and `node_version`
are recorded precisely because a baseline measured on one machine is weak
evidence about another.

**Negative.** This is a real ongoing cost with no automation to absorb it. If
the flake-rate signal has not caught a genuine defect within a reasonable
window, deleting this is the correct response — not lowering the ceiling until
it appears useful.

## Alternatives considered

1. **Measure the whole suite.** Rejected: three times the cost to learn about a
   population three times larger than the one any claim depends on.

2. **Measure in CI on every push.** Rejected — see above; it would measure the
   runner.

3. **Gate on staleness.** Rejected: it converts a deliberately off-critical-path
   cost into an on-critical-path one, which is the decision this record exists
   to make.

4. **Build allocation and token tracking too.** Rejected as scoped above: one is
   unreliable to obtain, the other already has an owner.

5. **Do nothing, and rely on the suite going red.** Rejected: a flaky test does
   not reliably go red, which is the entire definition of the problem.

## Obligations

### O1 — Every seam a completeness claim cites has a measured baseline

<!-- unverifiable: scripts/determinism-baseline.ts declares no exported top-level symbol; both --refresh and the gate live in its unexported main(). -->

64 cited seams, all baselined at 3 runs each on 2026-08-07 under `captest`.
Verified by `npm run gate:determinism` reporting `unmeasured: 0`.

*No proof comment: the extractor and gate are repository scripts, not exports
under `packages/*/src`, so `symbol=` cannot resolve against them — the same
reason ADR-008 gives for its own three obligations. Citing an unrelated symbol
to satisfy the parser would be a false proof.*

### O2 — Adding a cited seam without measuring it fails the gate

<!-- unverifiable: the DB-R rule is implemented inside scripts/determinism-baseline.ts's unexported main(), which declares no exported top-level symbol. -->

Verified by adding a `roundtrip=` citation for an uncited test file and
observing DB-R fail at the floor of 0, then reverting.

### O3 — Measurement never runs in CI, pre-push, or `npm run check`

<!-- unverifiable: this is a claim about which scripts appear in package.json/CI config, not behavior any exported symbol witnesses. -->

`determinism:refresh` appears in none of them; only `gate:determinism` does.

### O4 — A broken test is not reported as a flaky one

<!-- unverifiable: the nondeterministic classification is inside scripts/determinism-baseline.ts's unexported main(), which declares no exported top-level symbol. -->

`nondeterministic` requires both a pass and a fail across identical runs.
