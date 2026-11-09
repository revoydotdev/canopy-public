# ADR-156: The Stop Tier's Budget Is Measured And Only Falls

**Status:** Accepted
**Date:** 2026-09-02
**Authoring Revision:** 971fe16dc8e540827fb4828fcc27f811ce5922fb
**Content ID:** sha256:773e2fd1dbd6a13c950962d0a4a11056ca413cfb31b203ff23eec54de4b4e29c

## Context

ADR-074's three tiers are defined by cost. The `stop` tier is the set cheap enough to run
at every turn boundary, and its boundary was drawn from a real measurement: *"17 gates,
~3.7s wall"*. `scripts/gate-all.mjs`'s own header states the same measurement as ~4.5s, so
the two records already disagreed with each other.

Nothing ever re-measured it. `cost_class` is a declaration, and declarations do not decay
visibly, so every gate added with `cost_class: "stop"` taxed every turn boundary for free.

Measured on 2026-09-02, read-only, on this checkout: **37 gates, a median of ~16.4s across
runs** (readings ranged 11.8s to 16.4s on a loaded workstation). Roughly three times the
documented budget, at more than twice the gate count. No test anywhere asserted a
stop-tier budget; the only timing assertion in the whole gate test corpus was
`expect(gate.duration_ms).toBeGreaterThanOrEqual(0)`, which is a tautology.

The reporting limb existed and was never fed. ADR-147 decision 9 states that *"Timing is
part of the receipt, not folklore… A gate audit command renders all 53 contracts and last
measured costs with no blank cells."* `scripts/enforcement-audit.mjs` does render that
column, correctly. Its only producer was the CI aggregate enforcement report, which is gitignored
and kept as a 30-day artifact, so on any working clone every contract read `unmeasured`:

```
$ bun scripts/enforcement-audit.mjs --json | grep -c '"last_duration_ms": "unmeasured"'
57
```

That is the root cause. A system that cannot measure its gates assigns their tiers by
declaration and cannot notice the result drifting.

## Decision

**The tier that runs most often has a measured cost and a ceiling that only falls.**

1. **The battery records what it measured.** `gate-all.mjs` writes per-gate `duration_ms`
   and a per-tier total to the local measured-cost receipt under `.arbor/enforcement/`. It merges per gate
   rather than replacing the map, so a stop-tier run cannot blank the measurement of a
   gate that only runs at prepush or in CI.

2. **It is a separate file from the CI aggregate report, deliberately.**
   The CI aggregate enforcement report is the input to `validateAggregateExecutionReport` and the
   attestation chain. A local partial run must never overwrite it, or a Stop battery on a
   laptop could stand in for the authenticated CI verdict. `enforcement-audit.mjs` reads
   both and CI wins wherever it has a figure.

3. **A short rolling series, not a single reading.** Each tier keeps its last ten totals.
   Wall clock on a developer workstation is noisy, and a budget judged on one run either
   flaps under ordinary load or needs a ceiling so loose it proves nothing.

4. **`gate:stop-budget` is a ratchet in the shape of `gate:remedy-coverage`'s floor.**
   `scripts/gate-budget/stop-budget.json` holds `ceiling_ms`, the measurement that
   justified it, and the reasoning. The gate fails when the MEDIAN of the recorded series
   exceeds the ceiling. The ceiling may be lowered freely as the tier gets cheaper;
   raising it is a deliberate, reviewable edit that must carry its reason.

5. **It refuses to judge on too little data.** Below `min_samples` recorded runs it
   reports what it has and passes. A gate that judged one reading would be measuring the
   machine, not the tier.

6. **It reads the previous run, and says so.** This gate runs inside the stop battery, so
   it cannot see the run it is part of. The question a ratchet asks is whether the tier
   has grown, not what this instant cost.

7. **It is `required: false` and absent from CI**, under `local_history_only`. CI runs no
   stop battery and accumulates no series; a CI verdict here would judge an empty list
   forever, which is the check-that-cannot-fail shape `gate:hook-liveness` carries the
   same exclusion for.

This does not argue the tier is too expensive. 16s at a turn boundary may well be worth
paying — that is this harness's premise. The defect was that nobody chose it, nothing
reported it, and nothing stopped it becoming 30s.

## Consequences

Easier: adding a `cost_class: "stop"` gate now has a visible price. The audit command
finally renders real numbers for every gate the local batteries cover, which is what
ADR-147 decision 9 already claimed.

Harder: a genuine, justified increase in stop-tier cost now needs an explicit edit with a
recorded reason, rather than arriving as a side effect of adding a gate.

A known and accepted limit: 21 of 58 contracts still read `unmeasured` after a local stop
run, because they only ever execute at prepush or in CI. Those fill in when the wider
tiers or CI run. The column is no longer uniformly blank, which was the actual defect, but
it is not yet full and this record does not claim it is.

ADR-074's cited figures are left as written. They were true when measured, and an accepted
record is not edited to match later reality — that is what this record is for. The stale
restatement in scripts/hooks/gate-stop.sh's header is a source comment, not a decision,
and is corrected in the same change.

Not addressed here: the two gates that dominate the tier. `gate:completion-depth` (~4.0s)
and `gate:anti-stub:blocking` (~2.9s) are together about half the budget against a median
of roughly 50ms. Whether either belongs in this tier is a real question this record
deliberately does not answer; it now has a number attached to it, which it did not before.

## Alternatives / Roads not taken

**Assert a budget in a unit test instead of a gate.** Rejected: a test asserting wall clock
is the classic flaky test, and it would measure the CI runner rather than the tier as
developers experience it. The rolling median over real local runs measures the thing that
actually matters.

**Write into the CI aggregate enforcement report directly.** Rejected in decision 2: it is the
attestation chain's input, and a local run must never be able to stand in for CI.

**Commit the timing series.** Rejected: the stop battery runs at every turn boundary, so a
committed series would dirty the tree constantly and fight `gate:store-freshness`. The
committed artifact is the ceiling and its justification, which is the part that needs
review; the series is local runtime state.

**Make the gate advisory.** Rejected, narrowly. An advisory budget is a number nobody acts
on, which is the state this record exists to leave. The ceiling is instead set with enough
headroom (~1.5x the measured median) that ordinary load does not breach it, so the gate
speaks only when something structural changed.

## Obligations

### O1 — The battery records what it measured, without destroying other tiers' figures

`mergeMeasuredCosts` merges per gate and keeps a capped rolling series per tier, so a
stop-tier run cannot blank a CI-only gate's measurement.

<!-- proof: symbol=mergeMeasuredCosts file=scripts/gate-all.mjs roundtrip=scripts/tests/stop-budget-gate.test.mjs -->

### O2 — The ceiling can actually be breached, and is not moved by one slow run

`auditStopBudget` fails on a sustained breach, passes on a single spike surrounded by
healthy runs, and declines to judge below `min_samples`.

<!-- proof: symbol=auditStopBudget file=scripts/stop-budget-gate.mjs roundtrip=scripts/tests/stop-budget-gate.test.mjs -->

### O3 — The ceiling carries the measurement that justified it

`readBudget` fails closed on a missing, malformed or non-positive ceiling, and the
committed file records the measured median and the reasoning behind the headroom.

<!-- proof: symbol=readBudget file=scripts/stop-budget-gate.mjs roundtrip=scripts/tests/stop-budget-gate.test.mjs -->
