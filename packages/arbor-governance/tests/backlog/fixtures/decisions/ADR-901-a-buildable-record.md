# ADR-901: A buildable record with no Test implications

**Status:** Accepted
**Date:** 2026-08-07

## Context

Synthetic fixture. See brief.test.ts's header for why these tests no longer
pin real records.

## Decision

Route every dispatch through the single canonical adapter, so no caller
constructs its own transport.

## Consequences

One seam to test rather than several.
