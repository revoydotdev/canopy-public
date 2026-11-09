# Recent updates digest (past 7 days)

**Window:** 2026-08-09 to 2026-08-16 (inclusive of 560 commits, HEAD `466a2fe` on 2026-08-15)
**Primary evidence source:** `git log --since='7 days ago'` and changed-file analysis in repo.

## 1) Big-picture activity pattern

The last week is a **high-throughput governance and reliability phase**:

- **560 commits** touched **719 distinct files**.
- strongest code movement is in `packages/arbor-mcp` (915 changes), with major follow-up in
  `packages/arbor-tui` (222), `packages/arbor-opencode` (122), and `packages/arbor-harness` (114).
- infrastructure and evidence streams (`.visual-intelligence`, `.determinism-baseline`,
  `.claim-ledger`, `.completion-depth`) dominate verification and audit observability.
- 142 changes in `decisions/` and 34 direct updates to `decisions/README.md`.

## 2) Decision and governance updates

Decisions changed heavily in one lane, centered on:

- **ADR allocation and numbering updates** through ADR-075.
- **Gate/battery formalization** (ADR-074).
- **Traceability and evidence posture** (ADR-075), including advisory claim workflow.
- **Governance-count and obligation scaffolding** for machine-checkable ADR status.

New/updated decision files in the week (ordered by allocation):

- `decisions/ADR-062-arbiter-intake-governance-tiers.md`
- `decisions/ADR-063-external-ledger-attestation-and-waiver-outcome-ledger.md`
- `decisions/ADR-064-adaptive-turn-budgets-confidence-and-verification-strength.md`
- `decisions/ADR-065-graduated-scope-enforcement-and-structural-authority-provenance.md`
- `decisions/ADR-066-lineage-aware-scope-and-generated-oracle-evidence.md`
- `decisions/ADR-067-staggered-verifier-gated-specialist-racing.md`
- `decisions/ADR-068-durable-advisory-evidence-and-offline-ledger-audit.md`
- `decisions/ADR-069-adaptive-fork-thresholds-and-mutation-probe-evidence-class.md`
- `decisions/ADR-070-signed-scope-decision-inheritance.md`
- `decisions/ADR-071-race-none-tie-arbitration-and-mutation-probe-hardening.md`
- `decisions/ADR-072-authoring-allocation-separation-and-the-decisions-interlock.md`
- `decisions/ADR-073-project-profile-and-conformance-spec.md`
- `decisions/ADR-074-enumerating-gate-battery.md`
- `decisions/ADR-075-decision-traceable-work.md`

### Why this matters

This batch is not “just paperwork.” It records exactly where the architecture’s controls
were made explicit: arbitration, race handling, scope inheritance, traceability, and the
enforcement surface for gates.

## 3) Core codebase progress by package cluster

- **`packages/arbor-mcp`**: command/query catalog, campaign manager hardening, hooks,
  worktree verification paths, native and plugin integration, liveness, and scheduler changes.
- **`packages/arbor-tui`**: stronger operator screens and OpenTUI proofing for production rendering.
- **`packages/arbor-opencode`**: specialist loop and context/race/failure policy updates.
- **`packages/arbor-core`**: scoring/tree logic and task supervision alignment.
- **`packages/arbor-audit` / `packages/arbor-kb` / `packages/arbor-gate`**: evidence and admission/evidence gate consistency.
- **`packages/arbor-eval` / `@arbor-config`**: retrieval calibration surfaces and policy calibration work.
- **`packages/arbor-governance`**: obligation derivation and citation/coverage checks.

## 4) Research and artifact updates in the week

Research documents updated or added in the last 7 days include:

- `docs/research/agent-auditing-engine-primary-source-delta-2026-08-10.md`
- `docs/research/agent-uct-comparison-2026-08-10.md`
- `docs/research/agent-uct-primary-source-delta-2026-08-10.md`
- `docs/research/claude-code-clean-room-reference-2026-08-12.md`
- `docs/research/codex-clean-room-reference-2026-08-12.md`
- `docs/research/concurrent-integration-frontier-brief.md`
- `docs/research/default-native-executor-research-2026-08-09.md`
- `docs/research/frontier-gap-literature-2026.md`
- `docs/research/governed-overlay-evaluation-research-delta-2026-08-09.md`
- `docs/research/native-harness-primary-source-delta-2026-08-09.md`
- `docs/research/openrouter-native-planner-bakeoff-2026-08-09.md`
- `docs/research/openrouter-native-planner-bakeoff-v2-2026-08-09.md`
- `docs/research/openrouter-native-planner-bakeoff-2026-08-09.json`
- `docs/research/openrouter-native-planner-bakeoff-v2-2026-08-09.json`
- `docs/research/reference-harness-clean-room-spec.md`
- `docs/research/repository-retrieval-calibration-2026-08-14.md`
- `docs/research/remote-session-security-implementation-note.md`
- `docs/research/specialist-prompting-clean-room-delta-2026-08-11.md`
- `docs/research/skillprox-primary-source-delta-2026-08-10.md`
- `docs/research/unified-task-composer-research-delta-2026-08-09.md`
- `docs/research/ux-setup-integration-exemplars-2026-08-13.md`

The digest of these documents indicates a clear pattern: most new research is used to
anchor concrete implementation boundaries (task composition, native harness behavior, and
transport/opening conditions), not just to gather external comparisons.

## 5) Governance and operational artifacts

- `decisions/` governance corpus: `decisions/README.md`, `decisions/registry.json`,
  and `ADR-062` through `ADR-075` plus the associated `ADR-PENDING-*` variants.
- Evidence and evidence-scaffold stores:
  `.claim-ledger/*`, `.completion-depth/*`, `.determinism-baseline/*`,
  `.visual-intelligence/*`, and companion gate refresh/checkpoint scripts in `scripts/`.
- Release and roadmap posture: `docs/release-readiness.md`, `ROADMAP.md`,
  plus `docs/roadmaps/*` and updated handoff notes under `docs/roadmaps/handoffs/`.
- Related operating artifacts: `docs/postmortems/`, `docs/proposals/`,
  and selected `docs/merge-critical-properties.jsonc` / `scripts/registration-integrity.mjs`
  flows.

## 6) Evidence and freshness systems

Observed files with high churn are governance evidence stores:

- `.visual-intelligence/*` (manifest, graph, findings, observations, triage)
- `.claim-ledger/*`
- `.completion-depth/*`
- `.determinism-baseline/*`

This reflects a deliberate pattern: changes to behavior are paired with proof refresh and
reproducibility artifacts, especially for CI gate scripts and release-readiness claims.

## 7) Practical consequence for maintainers

In this week’s state, your best documentation entry points are:

- this position-paper index,
- `docs/architecture.md` for runtime boundaries,
- `docs/release-readiness.md` for gate posture,
- `ROADMAP.md` for phased obligations,
- `decisions/README.md` + `decisions/registry.json` for authoritative ADR state.

The next most productive action after reading is to reconcile one of:

1. `ADR-062` to `ADR-075` proof obligations in `decisions/`, or
2. `packages/arbor-mcp` runtime command contract and operator flows before changing any transport surface.
