# ADR-900: the canary fixture for gate:adr-decision-followthrough

**Status:** Proposed

**Date:** 2026-09-20

## Context

This file exists only as a canary fixture
(`scripts/canaries/adr-decision-followthrough/decided-but-not-promoted/`). It
is a DECIDED record that was never PROMOTED: the interview ledger beside it
records `accept` for ADR-900, and this record is still `Proposed`.

That is the defect ADR-085 was written to close, in the gate's own words: "an
ADR could be interviewed, decided 'accept', and then sit at `Status: Proposed`
forever, because coverage — not acceptance — is what cleared the queue … The
system proved an interview was HELD; it never proved a decided ADR was
PROMOTED."

## Decision

`gate:adr-decision-followthrough` must exit non-zero naming ADR-900 as still
`proposed` with an interview already on record.

The fixture is three files. Two matter to this gate — the ledger record and this
file. The third, `scripts/interview/baseline.json`, is present only so the
`interviewAttestation` helper this gate's dependency chain reaches does not
throw; this gate calls `coverageIndex(readInterviews(repo), today)` with no
attestation predicate, so coverage here is deliberately unauthenticated. See
the report for why that is itself the finding.

## Consequences

The gate exits 1 and prints
`is still "proposed" but an interview already recorded a decision`.

The seam is one CLI block: `decisionFollowthrough(repo)` was already exported
and already parameterised; only `main()` was hard-wired to the script's own
parent directory.

## Obligations

None. Declared empty so this fixture cannot double as a `gate:adr-sections`
stub-obligation canary.

## Alternatives

A fixture whose record is `Accepted` would pass the gate. Rejected: a canary
cannot assert success.
