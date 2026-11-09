# Governance control plane (`decisions`, `@arbor/governance`, gate scripts)

This paper covers the parts that keep the architecture from drifting: decision traceability,
ADR inventory, and proof obligations.

## What it is

`decisions/` and `@arbor/governance` do three things:

- maintain the ADR register and metadata (`decisions/registry.json`, `decisions/README.md`),
- compute obligation coverage and evidence status,
- run control scripts/gates that cross-check docs, tests, and provenance claims.

In this repo, governance is not documentation-only; it is part of release posture.

## Why this matters

Without active governance, a mature codebase can still accumulate “aspirational claims”:
- surfaced as docs,
- never tested,
- no longer aligned to current reality.

The current governance model tries to minimize that by making claims
machine-adjacent:
- proof tags and checks in docs,
- ADR proofability checks,
- anti-stub and freshness gates that compare expected evidence state with actual files.

## Why the current mechanism is preferred

- **Decision inventory as machine-checkable metadata** supports non-ambiguous
  attribution (`next_available`, `allocations`, `reserved`).
- **Gate battery enumeration (ADR-074)** means you can show exactly what is required
  and what is missing at runtime.
- **Decision-traceable work (ADR-075)** creates evidence of ADR updates themselves,
  reducing governance blind spots.

## Recent governance trajectory (7-day window)

From 2026-08-09 to 2026-08-15, governance activity includes:

- ADR allocation wave: ADR-062 through ADR-075, plus registry and `decisions/README` updates.
- evidence-store and proof freshness gates: anti-stub, claim-ledger, determinism baseline,
  completion depth, visual intelligence updates.
- ADR-054 / ADR-056 driven count derivation and proof tagging updates.

This is not “document housekeeping”; it is the project’s own control-loop around its claims.

## Research / source grounding

Grounding for this governance stance lives in:

- `docs/first-principles-audit-report.md`,
- `docs/first-principles-audit-report.md` addendum and subsequent gate reports,
- `docs/ADR-completion-audit-review.md`,
- `docs/adr-governance-audit/*` compliance checks.

The frontier decision papers in `docs/research/frontier-gap-literature-2026.md` also motivate
governance as a hardening mechanism in long-horizon and multi-party settings.

## Relevant files

- `decisions/registry.json`
- `decisions/README.md`
- `packages/arbor-governance/src/counts/derive.ts`
- `scripts/gates/*` and gate entrypoints in package scripts.
- Docs with proof tags and obligations: `docs/architecture.md`, `docs/release-readiness.md`,
  and ADR-linked appendices.
