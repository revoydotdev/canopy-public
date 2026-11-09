# ADR-901: the canary for gate:adr-citations, second record

**Status:** Accepted

## Context

The sibling of ADR-900 in the same canary fixture. It exists because
`gate:adr-citations` ratchets against a floor of 1 unresolvable citation in the
live corpus: one new violation does not exceed that floor, so a one-record
canary would pass. This record makes it two.

## Decision

`gate:adr-citations` must fail on this record too: the citation
`packages/arbor-core/src/canary-absent-901.ts` below is a second absent path.

## Consequences

With ADR-900 the gate's unresolvable count is 2 against a floor of 1, which is
what makes it exit non-zero at all.

## Obligations

None. Deliberately empty so this fixture cannot also be claimed as a
`gate:adr-status` status-suspect canary, which is a separate question.

## Alternatives

None considered; this record has no independent content beyond its role as the
second half of a two-record ratchet fixture.
