# Operator interface and supervision layer

revoy2 separates:

- **control** (runtime commands and approvals),
- **insight** (screens, streams, diagnostics),
- **projection** (status/cost/read-only outputs).

`@arbor/tui` is the exemplar implementation of this split.

## What the operator layer does

The TUI and CLI/web surfaces provide:

- task composition and confirmation,
- campaign visibility (`tree`, `tasks`, `operations`, `communications`),
- approvals and rejections,
- interruption/recovery and live diagnostics,
- config inspection and keymap visibility,
- provenance-aware outputs (counts, evidence references, raw evidence only when authorized).

All actions flow through runtime catalog commands, so operator workflows do not depend on
transport-specific state copies.

## Why this design

If each surface had independent authority, every tool path would need its own safety proof.
By centralizing authority in the runtime and keeping TUI as a projection, operator actions stay
consistent across:

- local terminal,
- web UI,
- MCP tool invocation.

This reduces “feature drift” and makes onboarding checks cheaper (one behavior contract).

## Research grounding

This posture follows the operator control thesis in:

- `docs/tui-cockpit/orchestration-ledger.md`,
- `docs/operator-guide.md`,
- `docs/review-package.md`,
- and UI/interaction work in `docs/roadmaps/22-operator-ergonomics.md` plus related handoffs.

The harness studies in `docs/research/specialist-prompting-clean-room-delta-2026-08-11.md` and
`docs/research/ux-setup-integration-exemplars-2026-08-13.md` support keeping human interaction
surfaces stable and explicit while preserving execution integrity.

## Rationale for concrete choices

- **Palette/config grammar and capability visibility** in TUI reduce accidental destructive
  operations.
- **Command palette over ad-hoc terminal flags** keeps command provenance explicit.
- **Runtime projection refresh cadence** allows safe operator loops even under interrupted
  campaigns.
- **Task/operation registries** preserve bounded recovery paths and avoid orphaned work.

## Current strengths

- High coverage of operator command surfaces is paired with catalog-backed idempotent
  command acknowledgements.
- `native-budget` and status surfaces now handle missing provenance gracefully instead of
  fabricating values.
- Recent work strengthened task composer and plugin command surfaces with governed catalog
  admission.

## Relevant files

- `packages/arbor-tui/src/`
  - `index.ts`, `runtime-port.ts`, `default-catalog.ts`, `operator-selection.ts`, `screens/*`,
  `opentui-renderer.ts`, `headless.ts`, `input-terminal.ts`
- CLI/web entrypoints in `packages/arbor-mcp/src/cli.ts`, `server.ts`, `webui.ts`
- prompts and role profiles: `packages/arbor-prompts/src/*.ts`
- config path/validation: `packages/arbor-config/src/*`
