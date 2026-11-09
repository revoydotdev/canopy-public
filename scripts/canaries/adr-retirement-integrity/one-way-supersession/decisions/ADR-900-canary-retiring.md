# ADR-900: the retiring record in the gate:adr-retirement-integrity canary

**Status:** Accepted

## Context

This file exists only as a canary fixture
(`scripts/canaries/adr-retirement-integrity/one-way-supersession/`). It is the
RETIRING half of the pair.

## Decision

**Scope.** This record supersedes only ADR-899's obligation **O1** — the forward
direction, using the exact prose convention this repository's own supersession
records already use, so the gate's `supersedes\s+(?:only\s+)?ADR-0*(\d+)`
pattern discovers the pair.

ADR-899 does NOT carry a back-reference naming this record near the word
"superseded", which is precisely the half-direction the gate is named for.

## Consequences

`gate:adr-retirement-integrity` exits 1 and reports the missing backward
citation. The gate asserts the forward direction explicitly even though the pair
was discovered from it — so a fixture must carry a real `ADR-899` mention in
this file, not only the word "supersedes".

## Obligations

None.

## Alternatives

None considered; this record has no content beyond its role as the retiring half
of a deliberately one-way supersession pair.
