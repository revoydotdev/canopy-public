# ADR-007: JSONL-Backed KB and Audit Ledger

**Status:** Accepted
**Date:** 2026-07-31

## Context

The KB and audit ledger need a persistence format. The format must be human-readable (for debugging and git-diffing), machine-parseable (for the scoring function), and simple (for Phase 0).

## Decision

Use **JSONL (JSON Lines)** — one JSON object per line. The KB's `toJSONL()` and `fromJSONL()` methods serialize and deserialize entries. The audit ledger works the same way.

PROV-AGENT ([arXiv:2508.02866](https://arxiv.org/abs/2508.02866), IEEE e-Science 2025) independently
uses `Campaign` as a top-level provenance activity and extends W3C PROV with agent/tool concepts.
This is convergent vocabulary, not an adoption of PROV as revoy2's internal authority model; if an
interoperability consumer appears, PROV is an export projection over this ledger.

## Consequences

**Positive:** Human-readable — you can `cat` or `head` the file and see structured data. Git-diffable — each entry is one line, so diffs show exactly what changed. No dependency — just `JSON.parse` per line. Idempotent import — duplicate ids are skipped.

**Negative:** No indexed queries. `kb.query()` iterates all entries. This is fine for hundreds of entries but will be slow for tens of thousands.

**Neutral:** The upgrade path to SQLite (Phase 3+) is straightforward — JSONL is a valid import source for SQLite's `.import` command.

## Alternatives Considered

1. **SQLite.** Rejected for Phase 0: adds a native dependency (better-sqlite3), binary files aren't git-diffable, and query performance isn't needed yet. Track for Phase 3 if the KB grows beyond ~10K entries.

2. **Plain JSON (single array).** Rejected: appending requires rewriting the entire file. JSONL supports append-only writes.

3. **YAML.** Rejected: multi-document YAML is less common and harder to parse incrementally (line-by-line).

4. **Custom binary format.** Rejected: not human-readable, not git-diffable, adds a parser dependency.

## Obligations

### O1 — The KB persists to disk as JSONL (one JSON object per line), human-readable and git-diffable

<!-- proof: symbol=saveKBProjection file=packages/arbor-kb/src/persist.ts roundtrip=packages/arbor-kb/tests/persist.test.ts -->

### O2 — The audit ledger persists to disk as append-only JSONL

<!-- proof: symbol=saveLedger file=packages/arbor-audit/src/persist.ts roundtrip=packages/arbor-audit/tests/persist.test.ts -->

### O3 — Importing a JSONL stream is idempotent: a duplicate id is skipped, not re-appended as a second entry

<!-- proof: symbol=KnowledgeBase file=packages/arbor-kb/src/kb.ts roundtrip=packages/arbor-kb/tests/kb.test.ts -->
