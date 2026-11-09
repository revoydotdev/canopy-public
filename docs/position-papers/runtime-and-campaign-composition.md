# Runtime and campaign composition (`@arbor/mcp`)

`@arbor/mcp` is the assembly point where tree-search intent becomes executable campaign
behavior.

## Core function

The package owns:

- `ArborRuntime` construction (`src/runtime.ts`),
- campaign manager and tree supervisor (`src/manager.ts`),
- command/query catalog with typed capabilities (`src/runtime-catalog.ts`),
- operation/task/job registries and idempotent command acknowledgement,
- approval, recovery, and interruption command flows,
- transport adapters (CLI/MCP/web/TUI integration points).

The result is "one runtime, many surfaces":
every transport is a projection over the same command/query schema, not an independent
or competing authority.

## Why this shape

The architecture must avoid an "A2A" style drift where each transport grows its own
policy. `RuntimeCatalogRouter` prevents that by making capability explicit per command
kind, and by making unsupported variants visible rather than silently faked.

Practical implications:

- no hidden transport-specific approvals,
- no parallel tree-state mutation paths,
- easier operator reasoning (a single operation ledger and event stream).

## Research grounding

This shape is justified by several frontier and in-repo sources:

- `docs/roadmaps/01-mcp-client.md`, `docs/roadmaps/11-user-commands-and-plugin-registry.md`
  (capability boundaries and command shaping),
- `docs/research/remote-session-security-implementation-note.md` and
  `docs/research/public-transport-security-architecture-proposal.md` (transport as
  explicit boundary policy),
- `docs/research/frontier-gap-literature-2026.md` (cross-surface integration gaps).

The catalog-based control model is the concrete mechanism for the principle that
authorities must be explicit.

## Design rationale by surface

- **CLI:** human-initiated task submission and supervision path should never bypass runtime
  idempotency.
- **MCP:** plugin and external tools should call catalog verbs, not mutate runtime directly.
- **Web:** API endpoints are wrappers around catalog commands/queries.
- **TUI:** operator actions become catalog commands, while projections remain read-only where
  appropriate.

## Evidence and governance posture

The recent 7-day work strengthened this layer through:

- catalog proof inventory updates tied to ADR-074 (enumerated gate battery),
- arbiter and routing governance updates (ADR-062 onward),
- additional run reports and evidentiary outcomes through `claim-ledger` and visual-intelligence
  store refreshes.

## Current risks

- Some transports intentionally remain configured-but-unexposed by default (remote/public ingress).
- `job` and `task` queues are bounded; operational throughput is intentionally capped by
  design to preserve auditability.
- Recovery remains authority-driven and operator-visible by contract (ADR-012/ADR-016 posture).

## Direct references

- Runtime composition: `packages/arbor-mcp/src/runtime.ts`
- Campaign manager loop bindings: `packages/arbor-mcp/src/manager.ts`
- Catalog routing and contracts: `packages/arbor-mcp/src/runtime-catalog.ts`
- Interrupt/recovery entry points: `packages/arbor-mcp/src/recovery*`, `packages/arbor-mcp/src/liveness*`
- Transport and integration points: `packages/arbor-mcp/src/cli.ts`, `server.ts`, `webui.ts`,
  `src/tui.ts`, `src/task-composer*.ts`
