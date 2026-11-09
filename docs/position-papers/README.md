# Position Papers and Architecture Briefs

This folder contains the latest explanatory set for revoy2's architecture as of
**2026-08-16** (repo snapshot windowed to the past 7 days and current through
`HEAD` at commit `466a2fe`).

The intent is to make the repo readable by operators and maintainers who need both:

- a **human explanation** of why each component exists and what it does, and
- a **traceable basis** for why that design is the one implemented here.

## Map

- [A. Foundational premises and component map](./foundational-premises.md)
- [B. Core tree-search and selection engine](./core-tree-search-and-loop.md)
- [C. Runtime composition and campaign control (`@arbor/mcp`)](./runtime-and-campaign-composition.md)
- [D. Native harness and execution envelope (`@arbor/harness` + integrations)](./native-harness-and-execution.md)
- [E. Provenance, KB, gates, and audit ledger (`@arbor/kb`, `@arbor/gate`, `@arbor/audit`)](./governance-provenance-and-evidence.md)
- [F. Operator surfaces (`@arbor/tui`, CLI, web, MCP, prompts)](./operator-interface-and-supervision.md)
- [G. Evaluation and cost controls (`@arbor/eval`, `@arbor/config`)](./evaluation-and-cost-model.md)
- [H. Governance control plane and decision traceability](./governance-control-plane.md)
- [I. 7-day change digest + research coverage](./seven-day-recent-updates.md)

## Reading order

Most people start with:

1. [Foundational premises](./foundational-premises.md)
2. [Core loop](./core-tree-search-and-loop.md)
3. [Runtime composition](./runtime-and-campaign-composition.md)
4. [Operator interface](./operator-interface-and-supervision.md)
5. [Governance and evidence](./governance-provenance-and-evidence.md)
6. [Evaluation](./evaluation-and-cost-model.md)

For migration, auditability, or architecture disputes, read in this order:

1. [Governance control plane](./governance-control-plane.md)
2. [7-day digest](./seven-day-recent-updates.md)
3. Relevant ADRs in `decisions/` and `decisions/README.md`.

## Coverage and freshness policy

- The digest is updated from commit history and directly changed file sets.
- Component papers cite research and artifact evidence from `docs/research`, `decisions`,
  and package source boundaries.
- If a paper states a status as "implemented/partial/deferred", it refers to current
  repo code and gate posture, not future intention.
