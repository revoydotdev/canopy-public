# Governance, provenance, KB, and audit trail

This is the trust boundary of revoy2. The short version: model output can propose,
but only evidence-bearing transitions can retire a node.

## Component function

`@arbor/kb`, `@arbor/gate`, and `@arbor/audit` split these concerns:

- **KB (`@arbor/kb`)** stores prior-failure and campaign memory in capability-aware
  envelopes.
- **Gates (`@arbor/gate`)** enforce admission/isolation/evidence/audit preconditions.
- **Audit (`@arbor/audit`)** records immutable, hash-linked traces of governed transitions.

This creates a closed chain:

`candidate` → `KB-informed execution` → `critic` → `evidence record` → `state update`

## Why this matters

Without this chain:
- failure and success could be conflated,
- an agent could approve without authority evidence,
- and UI could display non-witnessed states.

With it:
- all critical transitions are anchored,
- absence is typed (no implicit zeros),
- replays and diagnostics can be reconstructed from durable records.

## Research and review foundation

Key grounding artifacts:

- `docs/first-principles-audit-report.md` and `docs/clean-room-audit-report.md`
- `decisions/ADR-003-provenance-typed-kb-entries.md`
- `decisions/ADR-006-process-gates-wrapping-tree-search.md`
- `decisions/ADR-056-governance-counts-are-rendered-from-a-single-derivation.md`
- `decisions/ADR-068-durable-advisory-evidence-and-offline-ledger-audit.md`
- `docs/research/agent-auditing-engine-primary-source-delta-2026-08-10.md`

This set is why recent ADR activity has been concentrated on gates, advisory evidence,
and traceability rather than adding new command surface.

## Why these designs, specifically

- **Typed provenance tags** (`verified`, `claimed`, `critic_approved`, `generated`) are
  structural assertions, not stringly-typed metadata.
- **Envelope reads with absence reasons** let the runtime distinguish not found,
  capability blocked, and retracted conditions.
- **Audit checkpoints are ordered and hash-aware**, so replay and tamper checks can fail fast.
- **Gate failures are explicit** (`bypassGate()` produces evidence deficits), never silent.

## Current implementation posture

From the 7-day snapshot:

- Evidence freshness work was materially expanded (claim ledger, visual intelligence,
  determinism baseline, completion depth).
- Advisory claim mechanics and ADR-075 traceability were added.
- ADR-074 made gate battery membership explicit and auditable.
- Decision traceability and evidence gating obligations gained registry-linked updates.

## File map for operators and reviewers

- KB contracts and reads: `packages/arbor-kb/src/kb.ts`, `packages/arbor-kb/src/persist.ts`
- Gate definitions and bypass contract: `packages/arbor-gate/src/gate.ts`
- Audit ledger + tip integrity: `packages/arbor-audit/src/audit.ts`,
  `packages/arbor-audit/src/tip-sentinel.ts`, `packages/arbor-audit/src/persist.ts`
- Governance count derivation: `packages/arbor-governance/src/counts/derive.ts`
- Envelope and cap enforcement in runtime: `packages/arbor-core/src/types.ts`, `packages/arbor-mcp/src/manager.ts`
