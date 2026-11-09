# Foundational premises of revoy2

revoy2 is built around one hard architectural claim: **autonomous software work should
be treated as a governed search problem, not a sequence of ungoverned model prompts.**

That claim has three operational parts:

- **Search is the unit of control.** Work advances by proposing, evaluating, and
  branching candidate actions.
- **Governance is structural, not ceremonial.** Proposal and approval are distinct
  authorities, and each transition is represented as an evidence-bearing fact.
- **Observability is bounded by authority.** User-facing projections (status, logs,
  counts, and dashboards) are always derived views, never new sources of truth.

## Core premises by component

### 1) State and authority live in one core graph

The system chooses one authoritative state model and one campaign tree. Everything
else is projection:

- canonical campaign state and operation state are owned by `@arbor/mcp` runtime
  surfaces,
- provenance, envelopes, and ledger records are owned by the domain packages,
- operator screens and tools consume those projections.

This is codified in the package direction in `docs/architecture.md` and enforced by
imports and tests (`@arbor/core` has no upstream package dependencies).

### 2) Evidence precedes confidence

revoy2 distinguishes between:

- claims (e.g., model output),
- reviewed claims (critic assessment),
- and evidence-backed transitions (ledger-linked outcomes).

Only the strongest form can retire a search node. This is why `!verified` is a separate
provenance tag in `packages/arbor-core/src/types.ts` and why gates run before visible
state updates.

### 3) No component is an ungoverned bypass

Any component that can mutate campaign trajectory (selection, branch, retry, recovery,
approvals, interruptions, command dispatch) must pass through a command/query catalog
and checks in the runtime layer. This is the practical meaning of “single runtime”.

## Why this design versus the alternatives

Alternative designs often:
- trust one model stream,
- treat logs and final outputs as equivalent to evidence,
- or let each transport expose its own campaign authority.

revoy2 inverts each of those:
- no single model stream is trusted for authority,
- logs are inspected as provenance, not as substitute fact,
- each transport talks to one runtime contract (`RuntimeCatalogRouter`).

## Research grounding used in this architecture

The architecture is directly aligned to this chain of sources used in repo research artifacts:

- **Tree-search rationale:** `arbor` root papers and `arbor-core` scoring in ADR-002 (see
  `decisions/ADR-002-uct-scoring-with-regression-priorsors.md`) and `agent-uct` research
  notes.
- **Governance and trustworthy trajectories:** revoy-spec provenance model and
  `docs/first-principles-audit-report.md` framing.
- **Execution observability:** clean-room harness references in
  `docs/research/reference-harness-clean-room-spec.md`,
  `docs/research/native-harness-primary-source-delta-2026-08-09.md`.
- **Integrity and reviewability:** evidence-ledger posture from the ADR/gate suite and
  gate/freshness reports.

## Implementation footprint in the repo

The major boundaries are:

- `@arbor/core`: shared types, scoring, tree control
- `@arbor/mcp`: campaign runtime + catalogs + transports + manager lifecycle
- `@arbor/harness`: execution protocol + session/credential model + model/tool adaptation
- `@arbor/kb`: prior-failure and memory storage with capability-aware access
- `@arbor/gate`: admission/isolation/evidence/audit gates
- `@arbor/audit`: append-only hash-chain evidence and evidence retrieval
- `@arbor/tui`: operator projection only
- `@arbor/eval` + `@arbor/config`: reproducible measurement + policy inputs

That partitioning is what allows the architecture to remain explainable under change:
a new integration changes adapters and policy, but it should not rewrite the central
trust and lifecycle model.

## Status in the last 7 days

From 2026-08-09 through 2026-08-15, recent work concentrated on:

- allocator and governance ADRs (ADR-062 to ADR-075),
- gate battery enumeration and evidence refresh workflows,
- operator-facing evidence surfaces,
- native harness and campaign reliability hardening.

That activity is documented in the current-digest paper:
[7-day digest](./seven-day-recent-updates.md).
