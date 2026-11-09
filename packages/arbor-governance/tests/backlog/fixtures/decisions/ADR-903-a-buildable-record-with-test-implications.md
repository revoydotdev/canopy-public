# ADR-903: A buildable record that states its Test implications

**Status:** Accepted
**Date:** 2026-08-07

## Context

Synthetic fixture for the branch that reproduces a "## Test implications"
section verbatim.

## Decision

Persist every projection atomically, so a partial write is never observable.

## Consequences

Readers never see a torn projection.

## Test implications

A kill-during-write roundtrip must show either the old projection or the new
one, never a mixture of the two.
