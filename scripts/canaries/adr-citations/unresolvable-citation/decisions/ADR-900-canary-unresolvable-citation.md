# ADR-900: the canary for gate:adr-citations

**Status:** Accepted

## Context

This record exists only as a canary fixture for `gate:adr-citations`. It cites a
source path that does not exist, which is the exact defect ADR-130 was written to
catch: a citation in an ADR's prose that resolves against nothing.

## Decision

The citation `packages/arbor-core/src/canary-absent-900.ts` in this record's Context is
deliberately unresolvable, and `gate:adr-citations` must fail on it and on
ADR-901 beside it. Two
records are required rather than one because the live corpus carries a floor of 1
unresolvable citation and the gate is a one-way ratchet — a single new violation
does not exceed the floor, so a one-record canary would pass and prove nothing.

## Consequences

`gate:adr-citations` exits non-zero above the floor. The two-record shape is
load-bearing: halving this fixture turns the canary green without the gate
changing at all.

## Obligations

None. Declared deliberately empty; see the sibling canary for `gate:adr-sections`
for why an obligation-free fixture is the right shape here.

## Alternatives

Citing a file that exists but has too few lines was considered for the
line-number ratchet. Rejected: that check is advisory and non-blocking, so it
cannot carry a canary.
