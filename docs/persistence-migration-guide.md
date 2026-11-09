# revoy2 Persistence and Migration Guide

**Status:** describes the shipped implementation as of 2026-08-02.

This guide documents how revoy2 persists state, the JSONL→SQLite backend
relationship, sealed snapshots, and the handling of legacy unwitnessed rows.

---

## 1. Persistence overview

revoy2 persists two kinds of authority:

- **The audit ledger** (`@arbor/audit`): append-only, hash-chained evidence for
  traces, gates, communications, memory facts, interruptions, telemetry, and
  output descriptors. Raw oversized output is content-addressed.
- **The KB** (`@arbor/kb`): a provenance-typed derived knowledge projection with
  two backends: **JSONL** (sealed v1 hash-chain snapshots) and **SQLite**
  (behind a config flag).

The ledger/tree/runtime facts are authority. KB search views, memory views,
metrics, SSE state, and TUI models are projections: bounded, rebuildable,
deterministic, and incapable of blessing legacy/unwitnessed data.

---

## 2. JSONL → SQLite

The KB supports two backends selected by config (`backend: "jsonl" | "sqlite"`):

- **JSONL**: append-only entry files with atomically published, sealed v1
  hash-chain snapshots so tail truncation is detectable.
- **SQLite**: a relational backend behind a config flag.

Both backends validate and preserve all provenance variants (`verified`,
`claimed`, `critic_approved`, `generated`). JSONL and SQLite round-trips are
tested for every provenance variant.

---

## 3. Sealed snapshots and hash-chaining

- **Audit records** are append-only with SHA-256 chain links. Tampering,
  truncation, reordering, duplication, and conflicting records are detected on
  replay.
- **KB streams** are published as atomically sealed SHA-256 snapshots so tail
  truncation is detectable. Compatibility with legacy entry-only files is
  retained through an explicit migration and version path.

---

## 4. Legacy unwitnessed-row handling

Startup excludes legacy unwitnessed rows with diagnostics. `saveKBProjection`
is an **exact replacement** operation: it atomically replaces all derived KB
rows from the witnessed fact set and does not merge stale rows back in. Legacy
unwitnessed rows are diagnosed/excluded, never silently promoted.

A remembered fact cannot exist without witnessed evidence. Deleting a derived KB
projection and rebuilding from the ledger produces the same scoped facts.

---

## 5. Migration rules

- **Explicit migration path:** legacy entry-only files are handled through an
  explicit migration and version path, never silently.
- **Exact replacement, not merge:** rebuilding a projection replaces stale rows;
  merging preserves stale/unwitnessed rows and violates ADR-014.
- **Evidence before state:** gate checkpoints, traces, memory facts, and
  telemetry are journaled before the governed node transition.
- **No repo files in the ledger:** checked-in repo instructions stay in
  checked-in files (like AGENTS.md); they are never copied into the ledger.
- **Raw evidence survives pruning:** raw evidence remains durable when a
  projection is pruned, consolidated, or compacted.

---

## 6. Recovery and persistence

- Startup reconciliation restores active campaigns, elapsed-budget state,
  iteration counters, KB, audit, and boulder metadata as one coherent runtime
  view.
- Partial or corrupt checkpoints are quarantined or reported with typed
  diagnostics instead of silently starting a fresh campaign with the same
  identity.
- The persisted snapshot remains the state source of truth. Gate checkpoints
  and traces are evidence used to diagnose and authorize a new attempt; they are
  not a replay log (ADR-012).

---

## 7. Known limitations

- The untracked Phase 5.2 conformance tests covering hash-chain integrity and
  KB stream tail-truncation detection (e.g. `hash-chain-integrity.test.ts`,
  `scale-thresholds.test.ts`) are not yet green as of 2026-08-02; see
  `docs/release-readiness.md`.
