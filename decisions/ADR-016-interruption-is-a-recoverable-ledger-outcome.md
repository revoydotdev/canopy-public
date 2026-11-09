# ADR-016: Interruption Is a Recoverable Ledger Outcome

**Status:** Accepted
**Date:** 2026-08-01

## Context

The runtime has acknowledged task cancellation and the OpenCode loop propagates
an `AbortSignal`, but neither alone explains durable tree state after a process
stop. A partial expansion must not be mistaken for critic failure, completion,
or abandonment, and restart must not silently requeue it. Appendix F also
highlights subtree propagation and one operator path shared by signals and UI.

## Decision

`interrupted` is a recoverable node state/outcome. An interrupt request is a
typed, idempotent runtime command scoped to one node or owned subtree. The
supervisor propagates cancellation to child tasks; each acknowledgement and any
partial-output descriptor is journaled in the campaign audit chain before the
interrupted state becomes observable.

Signal handling, transport cancellation, operator steering, and future TUI
controls call the same command. They do not directly mutate task or tree state.
Interrupted work resumes only through ADR-012 fresh retry authority or becomes
terminal through its governed abandonment path.

Node lifecycle remains richer than message lifecycle. Streaming records use a
minimal `commentary | final` phase; node outcomes use a closed provenance-backed
union that distinguishes verdict, interrupted, timeout, context overflow, quota,
transport, and internal/cap-stall failures. Limit signals are not verdicts.

## Consequences

**Positive:** Cancellation is inspectable, branch-wide, restart-safe, and cannot
be conflated with checks-and-balances outcomes.

**Negative:** Cancellation may wait for child acknowledgement and durable
checkpointing; non-cooperative tools require timeout/escalation diagnostics.

**Neutral:** `abandoned` remains a separately authorized terminal state.

## Test implications

- Parent cancellation reaches every owned active descendant once.
- Duplicate requests/acknowledgements are idempotent; conflicting scope fails.
- A kill at each request/ack/evidence/state boundary reconciles deterministically.
- Interrupted nodes are never selected until authorized retry.
- A critic verdict and an interruption cannot occupy the same outcome.

## Alternatives considered

1. **Treat cancellation as failure.** Rejected because no critic verdict exists.
2. **Return interrupted nodes to pending.** Rejected because partial work would
   be silently duplicated.
3. **Keep cancellation only in the supervisor.** Rejected because its projection
   is not campaign evidence authority.

## Obligations

### O1 — `interrupted` is a distinct node outcome kind

It cannot be confused with a critic verdict, failure, or liveness signal.

<!-- proof: symbol=Interruption file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-mcp/tests/interruption-runtime.test.ts -->

### O2 — A subtree-scoped interrupt propagates to every owned descendant node

The resulting state survives a restart as typed ledger evidence.

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager.test.ts -->

### O3 — Acknowledgement and partial-output evidence are journaled before the interrupted state becomes observable

<!-- proof: symbol=InterruptionRecord file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-mcp/tests/interruption-runtime.test.ts -->

### O4 — A stale expected version is rejected without mutating node state

Duplicate interruption requests are idempotent.

<!-- proof: symbol=validateInterruptionCommand file=packages/arbor-mcp/src/interruption-contracts.ts roundtrip=packages/arbor-mcp/tests/interruption-runtime.test.ts -->
