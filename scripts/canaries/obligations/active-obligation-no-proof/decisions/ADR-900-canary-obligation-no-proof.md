# ADR-900: the canary fixture for gate:obligations

**Status:** Proposed

## Context

This file exists only as a canary fixture
(`scripts/canaries/obligations/active-obligation-no-proof/`). It declares one
obligation and attaches NO proof comment to it.

That is rule M-C, which the gate's own header names as BLOCKING for active
Proposed and Accepted decisions: "An active obligation with no proof comment is
reported as M-C."

## Decision

`gate:obligations` must exit non-zero with an `[M-C]` finding and the summary
line `FAIL — every obligation must carry either resolving evidence or an explicit
unverifiable reason.`

This record is `Proposed`, not `Accepted`, and that is deliberate on two counts.
First, an Accepted record with zero obligations would additionally trip POL-04,
so the fixture would fail for two rules at once and a later change to either
could not be attributed. Second, M-C is scoped to active records precisely so
that Rejected and Superseded records can stay truthful historical evidence — a
fixture that proved the wrong scoping rule would not be testing the blocking
leg the gate is named for.

## Consequences

The seam is small because `@arbor/governance` had already built it:
`buildObligationCoverageReport` takes `repoRoot` and `decisionsDir`, and its own
doc comment says the `decisionsDir` override exists "so tests can point this at
a fixture directory without touching the real decisions/ tree". This CLI was
passing only `at`, so it was the sole thing preventing that.

## Obligations

### O1 — the canary obligation, deliberately unwitnessed

This obligation exists to be caught. It is the input the gate was built to
reject.

## Alternatives

A proof comment naming a file that does not resolve would trip M-B instead — the
sibling blocking rule, and the one whose severity the gate prints as `blocker`
rather than `warning`. Rejected as the primary shape because an empty proof
field is a rarer real input than a missing one, and the rarer fixture is the
better proof that the gate inspects its input at all.

## Consequences of the alternative

None; recorded for symmetry only.
