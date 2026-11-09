# ADR-900: Obligation-coverage worked example (test fixture only)

**Status:** Accepted
**Date:** 2026-08-04

> Test fixture for `@arbor/governance`'s obligation-coverage resolver
> (`packages/arbor-governance/src/obligation/**`). Not a real decision
> record and never lives under `decisions/` — see this workstream's final
> report for why the resolver must be proven against real symbols, real
> files, and real (already-collected) tests rather than synthetic doubles.

## Context

The obligation-coverage resolver needs one end-to-end proof that a
well-formed record resolves fully, using capabilities that already exist and
are already tested in this repository — not fixtures invented for the
occasion.

## Decision

Cite three real, independently-verifiable capabilities as obligations, each
with a proof comment pointing at its real symbol, source file, and test file.

## Obligations

### O1 — EvidenceLedger provides a tamper-evident hash chain over campaign events

<!-- proof: symbol=EvidenceLedger file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/hash-chain-integrity.test.ts -->

### O2 — canonicalizeForHash is the single canonicalization implementation every hash-chained record must use

<!-- proof: symbol=canonicalizeForHash file=packages/arbor-core/src/canonical.ts roundtrip=packages/arbor-core/tests/canonical.test.ts -->

### O3 — parseKeymap turns a keymap spec into typed key bindings

<!-- proof: symbol=parseKeymap file=packages/arbor-config/src/keymap.ts roundtrip=packages/arbor-config/tests/keymap.test.ts -->

## Consequences

None — this is a test fixture, not a real architectural decision.
