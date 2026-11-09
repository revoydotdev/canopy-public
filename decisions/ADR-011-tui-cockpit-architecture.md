# ADR-011: TUI Cockpit Uses Unidirectional Projection over Canonical Runtime Services

**Status:** Accepted
**Date:** 2026-08-01

**Superseded in part.** Two later records retire specific pieces of this one;
the rest stands unchanged. Recorded here because a reader arriving at either
site needs to find the record that now governs, and because a supersession
declared only in the retiring record is invisible from the retired one.

- **ADR-036** supersedes this record's *provisional Ink renderer* decision
  (below): `@opentui/core` replaced Ink behind the same `RendererPort`.
- **ADR-037** supersedes this record's obligation **O4**: a structured scene
  replaces the port-existence obligation, so that O4 is no longer the live
  statement of what the renderer contract must prove.

## Context

Revoy2 needs a primary operational TUI, but the current canonical runtime is an
in-process `CampaignManager` with snapshot queries. Some adjacent capabilities
exist independently—AgentRadio, loop callbacks, persistence functions, config,
worktrees and a polling Web UI—while durable supervision, command identity,
cancellation acknowledgement and a replayable event stream do not yet exist.
Putting these missing semantics in widgets would create parallel orchestration
and divergent state, violating repository boundaries and governance guarantees.

## Decision

Build the cockpit as a renderer-independent Elm-style model/update/effect core
over a typed `CockpitClient`. Canonical services remain authoritative. Add a
sequenced application event projection and structured task supervisor at the
runtime integration boundary, shared by every presentation/transport surface.
Screens consume immutable projections and emit typed intents. They never call
domain infrastructure directly. Commands use operation IDs and idempotency keys;
cancellation is acknowledged by the runtime. Streams are cursor-based and
bounded. TUI persistence contains presentation state only.

## Consequences

The design supports deterministic headless testing, renderer replacement,
reconnect/resume and safe partial failure without duplicating domain state. It
requires foundational runtime contracts before many requested controls can be
honestly exposed. Existing MCP and Web UI mappings should converge on the same
command/query/event catalog rather than remain parallel interfaces.

## Alternatives considered

1. Direct terminal components over CampaignManager. Rejected: tight coupling,
   no remote path, hard-to-test effects and duplicated state synchronization.
2. CLI/subprocess command wrapper. Rejected: timeout cannot prove cancellation
   and can orphan or duplicate durable work.
3. Polling dashboard. Rejected as the primary model: transient lifecycle states
   can be missed and high-volume streams do not scale.
4. Renderer framework as architecture. Rejected: rendering choice must remain an
   adapter detail behind pure state, update and view contracts.

## Renderer decision

**Superseded by ADR-036**, which adopted `@opentui/core` behind this same port.
The provisional choice below is the record of what was decided in 2026-08-01.

Use Ink provisionally behind a renderer port because it supports the repository's
Node/TypeScript execution model and headless stream injection with lower native
packaging risk. This is not permission for component-owned I/O. OpenTUI may be
reconsidered only after an isolated compatibility/performance spike proves its
runtime, native artifact, CI, teardown and deterministic-test requirements.

## Obligations

### O1 — Screens dispatch through the typed runtime port, never domain infrastructure directly

<!-- proof: symbol=RuntimePort file=packages/arbor-tui/src/runtime-port.ts roundtrip=packages/arbor-tui/tests/runtime-port.test.ts -->

### O2 — Every runtime command carries an operation ID and idempotency key

Cancellation and dispatch are acknowledged by the runtime; they are never
inferred from a client-side timeout.

<!-- proof: symbol=RuntimeCommandMeta file=packages/arbor-tui/src/runtime-port.ts roundtrip=packages/arbor-tui/tests/runtime-port.test.ts -->

### O3 — Queries are cursor-based and bounded, not an unbounded poll

<!-- proof: symbol=cursorPage file=packages/arbor-core/src/cursor-pager.ts roundtrip=packages/arbor-core/tests/cursor-pager.test.ts -->

### O4 — Rendering is an adapter behind a pure renderer contract

**Superseded by ADR-037**, which replaces this port-existence obligation with a
structured scene. Retained as the record of what was originally required.

The renderer can be replaced or driven headlessly without touching the
model/update core, supporting deterministic testing and reconnect/resume.

<!-- proof: symbol=RendererPort file=packages/arbor-tui/src/renderer.ts roundtrip=packages/arbor-tui/tests/renderer-shell.test.ts -->

### O5 — Every declared screen/control surface is mechanically reconciled against the runtime catalog

No fake, dead, or disconnected control can pass silently: the wiring audit
checks every declared surface against the catalog's `supported: true` set.

<!-- proof: symbol=catalogConflicts file=packages/arbor-tui/src/input-catalog.ts roundtrip=packages/arbor-tui/tests/wiring-audit.test.ts -->
