# revoy2 Recovery Guide

**Status:** describes the shipped implementation as of 2026-08-02.

This guide explains how revoy2 recovers from process kills, crashes, and
interruptions. The governing decisions are ADR-012 (interrupted expansion
recovery requires fresh authority and evidence) and ADR-016 (interruption is a
recoverable ledger outcome).

---

## 1. Core principle: recovery is explicit, never automatic

A process kill must not silently lose, duplicate, or strand campaign work, and
every trusted transition must be reconstructable from durable evidence. The
runtime never silently requeues partial work on restart. Recovery is an
explicit, durable runtime operation with fresh authority.

---

## 2. Startup reconciliation

On startup, the runtime reconstructs a coherent view from durable facts:

- Active campaigns, elapsed-budget state, iteration counters, KB, audit, and
  boulder metadata are restored as one coherent runtime view.
- Persisted `expanding` nodes and worktree leases are reconciled against actual
  state. A separate continuation marker whose count could become authoritative
  is never added.
- Partial or corrupt checkpoints are quarantined or reported with typed
  diagnostics instead of silently starting a fresh campaign with the same
  identity.
- Startup lease reconciliation deactivates stale leases and reports
  malformed/orphaned ones without deleting work.
- Reconciliation-only restore: task state is reconstructed from durable facts;
  reconciled pre-crash tasks are never silently treated as live.

---

## 3. Interruption as a recoverable outcome (ADR-016)

`interrupted` is a recoverable node state/outcome, distinct from critic failure,
operator abandonment, timeout, and a completed verdict.

An interrupt request is a typed, idempotent runtime command scoped to one node
or owned subtree (`tree.interrupt`). The sequence is:

```text
request → supervisor acknowledgement → state application
```

Each acknowledgement and any partial-output descriptor is journaled in the
campaign audit chain before the interrupted state becomes observable.

All of these route through the same canonical `tree.interrupt` command:

- **Ctrl-C**: CLI via `ShutdownGate`; TUI via a real SIGINT `SignalPort`; eval
  CLI via graceful handlers.
- **Transport cancellation**: MCP `arbor_interrupt_campaign` tool; web
  `POST /api/campaigns/:id/interrupt`.
- **Operator steering**: node/branch interrupt and programmatic steering.

Interrupted work resumes only through ADR-012 fresh retry authority or becomes
terminal through its governed abandonment path. It is never silently requeued.

---

## 4. Recovery authority (ADR-012)

Recovery is an explicit, durable runtime operation, never an automatic startup
mutation. The `RecoveryService` (`packages/arbor-mcp/src/recovery-service.ts`)
implements it:

- **`RecoveryService.prepare`** prepares fresh attempted leases with
  authorization/version/isolation checks.
- **`redispatchRecoveredNode`** composes a real redispatch of the recovered node
  with fresh authority: without manufacturing critic verdicts, failure KB
  entries, or verified transitions, and without silently treating reconciled
  pre-crash tasks as live.

Authority rules:

- Crown owns selection and submits the recovery intent through the canonical
  runtime.
- Cambium may coordinate it.
- Only an operator or authorized auditor may authorize abandonment.
- Lenticel remains the independent authority for an outcome.
- A Specialist (Seed or Heartwood) can resume or retry assigned work but cannot
  clear its own interrupted state, approve its own result, or reuse an
  unverified lease.

A recovery operation has its own operation ID and idempotency key, references
the affected campaign/node and prior operation, and records actor, reason,
expected snapshot version, and a fresh lease identity. Retrying the same
recovery request must return the same decision; a different decision for the
same interrupted attempt is a conflict.

Before any retry, the runtime must prove the previous lease is inactive or
explicitly released, acquire a new exclusive lease, re-check the worktree and
starting commit, and durably record a passing (or explicitly bypassed) isolation
check.

---

## 5. The recovery catalog commands

Two catalog commands expose recovery authority:

- **`recovery.retry`** (`capability: recovery.write`): fresh-authority retry of
  an interrupted node. The router builds a `RecoveryRequest` with
  `action: "retry"` and `actor_role: "crown"`.
- **`recovery.abandon`** (`capability: recovery.abandon`): operator/auditor-
  authorized abandonment. The router uses `command.authorization.authority` as
  the actor role.

Recovery results are typed: `ready` (retry prepared), `abandoned`, `planned`
(requires an integration), `blocked`, or `conflict`.

---

## 6. Supervision and stale-work policy

- The `TaskSupervisor` is bounded: terminal tasks are hidden by default
  (`include_terminal` opt-in) and operation tombstones are prunable.
- Lease release is kept in a `finally` block, with startup lease reconciliation
  as defense in depth.
- Active counts derive from live/reconciled state and cannot grow or remain
  wedged because completed tasks were retained.
- Cancellation is cooperative through `AbortSignal` and acknowledged by the
  runtime. A timeout requests cancellation but is not itself proof of process
  termination.

---

## 7. Operator recovery workflow

1. **Detect** the interrupted state via `campaign.snapshot` or the TUI
   diagnostics screen.
2. **Decide** whether to retry or abandon. Retry requires fresh authority;
   abandonment requires operator/auditor authority.
3. **Retry** with `recovery.retry` (fresh lease, fresh operation ID) or
   **abandon** with `recovery.abandon`.
4. **Verify** the node transitioned deterministically and no false critic
   verdict, failure KB entry, or verified transition was manufactured.

---

## 8. Known limitations

- The untracked Phase 5.2 conformance tests covering the recovery redispatch
  path (e.g. `tree-recovery.invariant.test.ts`) are not yet green as of
  2026-08-02; see `docs/release-readiness.md`.
