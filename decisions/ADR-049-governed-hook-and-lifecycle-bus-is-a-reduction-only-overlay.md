# ADR-049: Governed Hook and Lifecycle Bus Is a Reduction-Only Overlay

**Status:** Accepted
**Date:** 2026-08-12

## Context

The native harness needs operator-visible pre-tool, post-tool, and lifecycle hooks. That surface crosses ADR-024's tool trust boundary. Generic middleware that can rewrite requests, add tools, or grant access would create a second authority path and violate ADR-028 and ADR-038.

## Decision

A runtime hook is a bounded governed overlay. It may observe already-redacted evidence or reduce an admission decision; it never mutates a request/result, grants authority, widens a scope, adds context, or fabricates provenance.

`HookCatalog` loads immutable, filename-identified JSON descriptors that name a handler from a closed in-process registry. It rejects kind/event/handler combinations that exceed the declared capability. No code or shell command is loaded from a descriptor.

`HookBus` provides three closed hook kinds:

- `veto` runs before a tool port's existing preflight. Effective admission is `base_allow AND all_hook_allows`; an allow from a hook cannot overturn a base denial.
- `observe` receives bounded, redacted tool-audit, phase, or ledger-transition projections. Its return type contains no decision or mutation.
- `lifecycle` observes session/node boundaries, plan confirmation, and interruption. Only `session_start` can use a deny-capable handler, and it runs before provider/model dispatch.

Throws, invalid veto results, and measured time-bound overruns deny. Observe failures are recorded and dropped. Every firing writes a bounded `hook_fired` record to the durable harness-session journal; `neverFired()` exposes declared hooks without invocation evidence.

This runtime bus is distinct from ADR-032's dev/CI git-hook attestation and never writes `.hook-liveness/`.

## Non-goals

- Request or result mutation hooks.
- Operator-provided shell hooks or arbitrary code-from-disk handlers.
- User-defined commands and plugin packaging; those are follow-on surfaces.

## Consequences

Operators gain an enforceable, evidence-bearing hook surface without gaining a new authority source. The initial registry is deliberately closed and requires a reviewed code change for new behavior. In-process synchronous handlers are measured after return rather than forcibly preempted; they cannot perform shell or external I/O.

## Obligations

### O1 — Catalog loading rejects escalation

<!-- proof: symbol=HookCatalog file=packages/arbor-mcp/src/hooks/catalog.ts roundtrip=packages/arbor-mcp/tests/hooks/catalog.test.ts -->

Invalid kind/event/handler combinations fail with `hook_escalation` before dispatch.

### O2 — Composition is intersection-only

<!-- proof: symbol=HookBus file=packages/arbor-mcp/src/hooks/bus.ts roundtrip=packages/arbor-mcp/tests/hooks/bus.test.ts -->

For every wrapped tool call, `effective_allow` implies `base_allow`.

### O3 — Veto failures fail closed and are attributed

<!-- proof: symbol=HookBus file=packages/arbor-mcp/src/hooks/bus.ts roundtrip=packages/arbor-mcp/tests/hooks/bus.test.ts -->

Throwing, invalid, or over-time veto handlers return a refusal naming the hook and emit evidence.

### O4 — Observe hooks cannot fabricate authority

<!-- proof: symbol=HookObserveHandler file=packages/arbor-mcp/src/hooks/contracts.ts roundtrip=packages/arbor-mcp/tests/hooks/bus.test.ts -->

The observe return type has no admission, tool, mutation, context, or provenance field.

### O5 — Tool and session vetoes are live

<!-- proof: symbol=NativeAgentExecutor file=packages/arbor-mcp/src/native-agent-executor.ts roundtrip=packages/arbor-mcp/tests/hooks/e2e.test.ts -->

A tool veto prevents the underlying port from executing, and a session-start veto prevents the model boundary from being crossed.

### O6 — Runtime liveness evidence is durable

<!-- proof: symbol=HarnessSessionJournal file=packages/arbor-mcp/src/harness-session-journal.ts roundtrip=packages/arbor-mcp/tests/harness-session-journal.test.ts -->

Bounded hook invocation records persist and replay independently of dev-hook attestation.
