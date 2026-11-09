# ADR-074: Enumerating gate battery and Stop-hook end condition

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** 78363cfad3f32e810a11e26a11d7880f0f283640
**Content ID:** sha256:bb8af3d7dde985db6aee72e2f3fe8ce23c4db701e816f1ddbef850a914a8c819

## Context

This repository has accumulated a large number of `gate:*` scripts. They are
individually well built: each detects a specific class of defect, each prints
an exact one-line remedy, and each is wired into `package.json`. The roster of
which gates to actually *run*, however, lived in an operator's memory.

On 2026-08-15 that roster was measured against reality for the first time, and
the result decided this ADR:

1. `gate:typecheck-tests` was **failing on master with 14 accumulated type
   errors**. Nothing was broken about the gate. It was declared, it ran, and it
   printed a correct remedy. It had simply never been in anyone's remembered
   battery, because `tsc --build` does not cover test files — which is exactly
   why the separate gate exists. The errors accumulated across three merges,
   and one of them was real contract drift: a telemetry port mock never updated
   after ADR-067/071 widened the interface.

2. A first full enumerating sweep of all 27 gates found **five red on master**,
   every one of them red while work had repeatedly been declared complete:
   `gate:typecheck-tests`, `gate:anti-stub:blocking`, `gate:vi-findings`,
   `gate:vi-freshness` (the VI graph was 129 commits behind a budget of 25),
   and `gate:vi-reproducible` (a consequence of that staleness).

3. `gate:eval-regression` was also red, with six scripted-harness metrics off
   their baselines. This is recorded here as observed but is NOT addressed by
   this ADR.

The generalizable finding is not that any individual gate was wrong. It is
that **a battery assembled by hand drifts, no matter how disciplined the
hand.** Adding a gate and adding a gate *to the thing that runs gates* were
separate acts, and only the first one was enforced. A gate that runs nowhere
is indistinguishable from a gate that does not exist, except that it is more
expensive: it produces false confidence.

A second, narrower force: the mechanics around these checks carry ordering
constraints that exist only as operator knowledge. Refreshing the determinism
baseline while a test is red bakes the failure in as a recorded flake;
`gate:store-freshness` compares against *committed* stores, so a refresh must
be committed before verification means anything. Both were learned the
expensive way, twice each, on the same day.

## Decision

**1. The roster is derived, never remembered.** `scripts/gate-all.mjs`
enumerates `gate:*` from `package.json` at run time. It has no hardcoded list
of which gates exist.

**2. Omission is not an option the system offers.** Every declared gate must
carry a tier classification in `GATE_TIERS`. A gate present in `package.json`
but unclassified is a hard failure, as is the reverse, and on roster drift
**no gates run at all** — a green battery over a wrong roster proves nothing.
This inverts the failure mode that caused the incident: adding a gate without
deciding when it runs now breaks the battery loudly, where before it silently
ran nowhere.

**3. Three tiers, with boundaries drawn from measurement rather than
intuition.** `stop` (17 gates, ~3.7s wall), `fast` (+5 gates, ~27s), `full`
(suites, type-checks, coverage, evals; minutes). The stop/fast boundary is
empirical: five gates accounted for 23 of the 27 seconds an initial two-tier
split took, while the other 17 together cost 4.4s. Tiers are cumulative —
`--tier fast` includes the stop gates, because an operator asking for "fast"
never means "skip the 4-second drift checks."

**4. The cheap tier becomes a mandatory end condition.**
scripts/hooks/gate-stop.sh runs `--tier stop` on Stop and exits 2 on failure,
which blocks the stop and feeds the gate's own remedy text back to the model —
the one place that text can still change what happens next. The gates were
never the weak link; *remembering to run them* was.

**5. Two gates warn rather than veto, each for a stated reason**
(`HOOK_ADVISORY`). `gate:store-freshness` decides staleness from a content hash
of the working tree, so any uncommitted edit turns it red — blocking on it
would block every stop during normal work. `gate:vi-findings` requires a
recorded *human* verdict per finding, so a model clearing it would fabricate
precisely the human decision the gate exists to prove. Both still run on every
Stop, still print in full, and remain hard-blocking in `gate:all` everywhere
else. Only the veto is relaxed, and only where a veto would be meaningless or
unfixable by the party the hook addresses. A hook that blocks on what the
model cannot legitimately resolve does not produce a fix; it produces a
bypass, and a disabled hook checks nothing at all.

**6. The escape hatch is explicit and logged** (`ARBOR_SKIP_STOP_GATES`), and
`stop_hook_active` is honored so a gate needing a human verdict can never wedge
a session into a permanent block/retry cycle.

### Roads not taken

- **A blocking pre-commit battery.** Rejected: ADR-034 already established that
  pre-commit stays claim-ledger-only. A multi-second pre-commit gets bypassed
  with `--no-verify`, which is how agent Y ended up bypassing hooks earlier the
  same day.
- **Making every gate blocking on Stop.** Rejected per decision 5: it converts
  an interlock into a nuisance and trains the operator to disable it.
- **Auto-remediation from the hook.** Rejected. Detection and remediation are
  different authorities (the convention `worktree-hygiene.mjs` and
  `branch-accounting.mjs` already follow). The hook reports and blocks; a human
  or an explicit tool acts.
- **A single flat `fast`/`full` split.** Rejected on measurement: it produced a
  27-second Stop hook, which does not fit the budget of something firing at
  every turn boundary.

## Consequences

**Easier.** A new gate cannot be added to `package.json` and forgotten — the
battery refuses to run until it is classified. The stop-tier drift detectors
(staleness, registry integrity, roster/lockfile agreement, orphaned state) now
run at every turn boundary for ~3.7s. "Which gates are there" became a derived
fact with a single source of truth, and `--json` output makes gate results
machine-readable instead of prose to be grepped.

**Harder / costs.** Every Stop pays ~3.7s. Adding a gate now requires a
deliberate one-line tier decision. Two gates' Stop-time veto is relaxed by
design, which is a real reduction in strictness at that one site, mitigated by
their remaining blocking everywhere else.

**Surfaced, not resolved.** Refreshing the VI graph (129 commits stale) grew
the `gate:vi-findings` backlog to 22 violations — 20 untriaged plus 2 reopened
by content change. These require recorded human verdicts and are deliberately
left outstanding rather than bulk-triaged, since inventing 20 dispositions
would fake the exact artifact the gate certifies. `gate:eval-regression`'s six
red metrics are likewise recorded and unaddressed here.

**What this does NOT prove.** That the gates are individually correct, that
their coverage is sufficient, or that a green battery means the work is good.
It proves only that every gate the repository declares is actually run, and
that a declared-but-unrun gate is now impossible to create silently.

## Obligations

### O1 — roster drift is detected in both directions and blocks the whole battery

<!-- proof: symbol=auditRoster file=scripts/gate-all.mjs roundtrip=scripts/tests/gate-all.test.mjs -->

`auditRoster(declared, classified)` returns one problem per disagreement
between the gates `package.json` declares and the gates `GATE_TIERS`
classifies, in BOTH directions — a declared-but-unclassified gate and a
classified-but-deleted gate — and reports both at once rather than stopping at
the first. The declared-but-unclassified message contains a literal,
pasteable `"<gate>": "fast",` remedy. Proven directly as unit assertions, and
end-to-end against a throwaway fixture repository whose `package.json`
declares an unclassified gate: the battery exits 1 and the fixture's
file-writing gate never runs, establishing that no gate executes while the
roster is drifted.

### O2 — the roster is derived from `package.json`, never hardcoded

<!-- proof: symbol=enumerateGates file=scripts/gate-all.mjs roundtrip=scripts/tests/gate-all.test.mjs -->

`enumerateGates(repoRoot)` reads `scripts` from the given repository's
`package.json` and returns every `gate:*` key except `gate:all` itself, sorted.
Proven by comparing `--list` output against the real `package.json` parsed
independently in the test, asserting set equality rather than a pinned literal
so the proof cannot rot as gates are added or removed. Self-exclusion is
asserted separately, since a battery that enumerated itself would recurse.
Importing the module does not execute the battery — `main()` is guarded behind
a CLI check — which is what makes these obligations provable as unit tests at
all.
