# ADR-899: the retired record in the gate:adr-retirement-integrity canary

**Status:** Superseded

## Context

This file exists only as a canary fixture
(`scripts/canaries/adr-retirement-integrity/one-way-supersession/`). It is the
RETIRED half of a deliberately one-way pair.

Note what this record deliberately does NOT contain: it never names the record
that retired it, anywhere, in any paragraph. Its own Status line says
`Superseded` — which is the only signal a reader of this file alone gets, and a
bare status word names nobody.

## Decision

The retiring sibling in this fixture declares that it supersedes this record, so
`gate:adr-retirement-integrity` discovers the pair from the forward citation and
then finds no backward one.

## Consequences

The gate exits 1 and prints
`is missing a back-reference marking it superseded by <the retiring number>`.

This gate is addressable with no code change: `adr-retirement-integrity.mjs`
already accepts `--decisions-dir`, documented in its own header as a "fixture
override … lets tests exercise this against a throwaway fixture corpus instead
of mutating the real one".

An earlier draft of this fixture DID name the retiring record — inside the
sentence explaining that the back-reference was absent — and the gate accepted
it. See the report: the backward check is `/supersed/i` plus the number, per
blank-line-delimited paragraph, which the word "supersession" satisfies on its
own.

## Obligations

None. Deliberately empty; one fixture, one proven gate.

## Alternatives

Declaring the back-reference (which makes the gate PASS) was rejected: a canary
cannot assert success, because a gate that ignored its input and a gate that
correctly cleared it are indistinguishable from the outside.
