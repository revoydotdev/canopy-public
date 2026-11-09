# Native harness and execution envelope (`@arbor/harness`, integrations)

revoy2 execution exists at two levels:

1. **Execution protocol layer** in `@arbor/harness` (model sessions, tool calls,
   credentials, terminal isolation, redaction, and deterministic session contracts),
2. **Integration layer** in `@arbor/mcp` (opencode-native, Claude-Code, and future
   connectors).

The key design position is: **execution adapters are replaceable; execution authority
and auditability are not.**

## What the harness does

`@arbor/harness` provides:

- a connector-neutral worker/session abstraction,
- deterministic context and budget bookkeeping,
- credential boundaries that do not leak secrets into stored evidence,
- structured model/tool execution contracts,
- native compatibility and fallback for transport-specific constraints.

Integration code composes this with campaign rules and evidence requirements before any
mutation can happen.

## Why this matters

If the execution layer can be swapped, so can its vulnerabilities. The only safe swap
path is a fixed contract:

- same command scope,
- same evidence envelope,
- same interruption/retry boundaries,
- same approval separation.

This is why ADR-061 requires integration pieces to be capability-bound plugins and why the
mcp package does not treat connectors as policy owners.

## Academic/research grounding

The harness architecture is grounded by several clean-room analyses:

- `docs/research/native-harness-primary-source-delta-2026-08-09.md`
- `docs/research/reference-harness-clean-room-spec.md`
- `docs/research/agent-harness-2025-2026-implementation-briefs.md`
- `docs/research/agent-auditing-engine-primary-source-delta-2026-08-10.md`

The main takeaways are durable session boundaries, explicit context/authority, and
separation between observed execution trace and claimed completion.

## Specific design choices

- **Execution session identity is bounded and resumable.** This prevents raw transcript replay
  from becoming silent continuity.
- **Token/cost evidence capture is explicit and adapter-specific.** Not all transports expose
  usage equally (hence ADR-063/ADR-069 refinements in the 7-day window).
- **Critic/validation is structurally separated from specialist execution.** A specialist
  cannot self-approve in its own execution context.

## Relevant files and flows

- `packages/arbor-harness/src/native-session.ts`
- `packages/arbor-harness/src/native-worker.ts`
- `packages/arbor-harness/src/protocol.ts`
- `packages/arbor-mcp/src/integrations/opencode-campaign.ts`
- `packages/arbor-mcp/src/integrations/claude-code-campaign.ts`
- `packages/arbor-mcp/src/native-campaign-budget*.ts`
- `packages/arbor-mcp/src/scoped-native-credential-broker.ts` and scoped-native
  credential integration points

## Current implementation state (last 7 days)

This period focused on:

- hardening native references and task-proposal boundaries,
- stabilizing continuation and restart surfaces,
- expanding native execution evidence refresh and anti-stub evidence freshness checks.

Those changes mostly reduce divergence risk between declared execution policy and actual
run-time behavior, while keeping connector internals replaceable via composition.
