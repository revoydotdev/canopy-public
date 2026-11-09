# ADR-012: Interrupted Expansion Recovery Requires Fresh Authority and Evidence

**Status:** Accepted
**Date:** 2026-08-01

## Context

An abrupt stop can leave durable facts at different points: an isolation gate
checkpoint can be fsynced before the tree snapshot becomes `expanding`; a
snapshot can be `expanding` before a Specialist finishes; or a terminal trace
can be durable while its snapshot is not. The startup projection reports these
conditions but intentionally does not replay them. Treating incomplete work as
success, failure, or an active lease would make a crash an unaudited approver.

ADR-006 requires the isolation gate before expansion and durable evidence for
governed transitions. ADR-011 requires the canonical runtime—not a cockpit or
transport—to own commands, idempotency, supervision, and cancellation. This ADR
defines the authority required to turn a diagnostic into a safe next action.

## Decision

Recovery is an explicit, durable runtime operation, never an automatic startup
mutation. Crown owns selection and submits the recovery intent through the
canonical runtime. Cambium may coordinate it. Only an operator or authorized
auditor may authorize abandonment; Lenticel remains the independent authority
for an outcome. A Specialist (Seed or Heartwood) can resume or retry assigned
work but cannot clear its own interrupted state, approve its own result, or
reuse an unverified lease.

The persisted snapshot remains the state source of truth. Gate checkpoints and
traces are evidence used to diagnose and authorize a new attempt; they are not
a replay log. A recovery operation has its own operation ID and idempotency key,
references the affected campaign/node and prior operation, and records actor,
reason, expected snapshot version, and a fresh lease identity. Retrying the
same recovery request must return the same decision; a different decision for
the same interrupted attempt is a conflict.

Before any retry, the runtime must prove that the previous lease is inactive or
explicitly released, acquire a new exclusive lease, re-check the worktree and
starting commit, and durably record a passing (or explicitly bypassed) isolation
checkpoint for the new operation before the node can be dispatched. A lease is
scoped to one campaign, node, operation, worktree, and bounded expiry. After a
crash it is presumed stale, never presumed owned; ambiguity blocks retry and is
reported for operator resolution. A bypass uses `bypassGate()` and carries a
specific evidence deficit—it does not silently waive lease or commit checks.

No recovery action may synthesize `verified`, `claimed`, `failed`, a Critic
verdict, Specialist output, provenance, KB learning, or a terminal action
trace. A completed result found outside the durable trace is submitted as new
Specialist evidence and follows the normal Lenticel and evidence-gate path.

| Durable condition | Permitted next action | Required authority and evidence | Forbidden inference |
|---|---|---|---|
| `expanding` with valid isolation checkpoint and no terminal trace | Retry from the preserved snapshot, or abandon | Crown/runtime retry; fresh exclusive lease, isolation recheck/checkpoint, new operation ID. Abandonment needs operator/auditor authorization and reason. | The old Specialist is still running; the work succeeded or failed. |
| `expanding` without isolation checkpoint | Abandon, or return to pending only as an authorized recovery transition before a fresh retry | Operator/auditor resolution; durable recovery record explaining the evidence gap; fresh isolation before dispatch. | Isolation passed, a lease exists, or an old result may be accepted. |
| `pending` with isolation checkpoint | Treat as checkpoint-ahead diagnostic and initiate a fresh retry only after revalidation | Crown/runtime with fresh lease and isolation checkpoint; retain the orphan checkpoint as evidence. | The original expansion began. |
| Terminal trace conflicts with snapshot, orphan checkpoint/trace, corrupt or ambiguous lease | Quarantine/escalate; no automatic continuation | Operator/auditor investigates immutable evidence; a new campaign/node action only after a documented resolution. | Either durable artifact overrides the other. |
| Valid terminal snapshot and matching trace | Normal tree-search continuation | Existing ADR-006 evidence and Lenticel verdict rules. | Recovery authority is needed. |

Abandonment is a governance action, not a fabricated Critic rejection. It must
preserve the node and all evidence, release the confirmed lease, record the
operator/auditor decision and reason, and place the node in an explicit
non-selectable recovery outcome defined by the runtime state model. Whether that
outcome is `failed`, `pruned`, or a new terminal state requires a separately
typed state-machine change; until then, a diagnostic remains non-mutating.

Crash ordering is therefore: (1) validate the recovery command and expected
version, (2) resolve/revoke the old lease, (3) acquire and persist the new
lease, (4) run and persist the new isolation checkpoint, (5) persist the
authorized state transition, then (6) dispatch the Specialist. A crash at any
point leaves evidence for another diagnostic pass, never permission to skip a
step. Cancellation follows ADR-011: cancellation acknowledgement and cleanup,
including lease release, are runtime-supervised and durable rather than inferred
from a client timeout.

## Consequences

**Positive:** Restart is safe, idempotent, and auditable. Worktrees cannot be
concurrently reused based on stale memory, and no agent gains self-approval
power through recovery.

**Negative:** An interrupted node may require operator attention, and fresh
isolation/lease checks add latency before useful work resumes.

**Neutral:** This does not add a fifth blocking lifecycle gate. Recovery uses
the existing isolation gate plus durable runtime supervision, preserving the
four-gate model in ADR-006.

## Test implications

- Restart diagnostics must be read-only and stable across repeated startups.
- Recovery command tests must prove idempotent retry, expected-version conflict,
  actor authorization, and no duplicate dispatch or lease acquisition.
- Lease tests must cover expiry, explicit release, ambiguity, cross-campaign
  exclusion, crash before/after each durable step, and bypass deficits.
- Tests must prove no recovery path manufactures terminal state, provenance,
  Critic verdict, trace, or KB entry; a recovered result must pass independent
  Lenticel and evidence checks.
- Reconciliation tests must retain checkpoint-ahead, orphan, conflicting, and
  corrupt evidence for audit while refusing automatic replay.

## Alternatives considered

1. **Automatically replay audit records at startup.** Rejected: a checkpoint
   proves a gate evaluation, not dispatch completion or a terminal result.
2. **Let the previous Specialist resume by default.** Rejected: process and
   lease liveness cannot be inferred after a crash, and it would bypass fresh
   isolation evidence.
3. **Make recovery a new mandatory gate.** Rejected: it duplicates isolation
   semantics and expands ADR-006's accepted four-gate model without a distinct
   trust boundary.
4. **Allow Lenticel to abandon work alone.** Rejected: Lenticel approves or
   rejects results; operational abandonment needs accountable operator/auditor
   authority and must not be mistaken for a Critic verdict.

## Obligations

### O1 — A recovery attempt is a typed, durable runtime request, never an automatic startup mutation

It carries its own operation ID, idempotency key, and references to the
affected node and prior operation.

<!-- proof: symbol=RecoveryRequest file=packages/arbor-mcp/src/recovery-service.ts roundtrip=packages/arbor-mcp/tests/recovery-service.test.ts -->

### O2 — Only an operator or auditor actor role may authorize abandonment

Crown may initiate retry but cannot abandon a node unilaterally.

<!-- proof: symbol=RecoveryService file=packages/arbor-mcp/src/recovery-service.ts roundtrip=packages/arbor-mcp/tests/recovery-service.test.ts -->

### O3 — Retry requires the prior lease resolved and a fresh lease acquired before dispatch

An active or ambiguous prior lease blocks the retry rather than being
presumed safe after a crash.

<!-- proof: symbol=RecoveryLeaseAuthority file=packages/arbor-mcp/src/recovery-service.ts roundtrip=packages/arbor-mcp/tests/recovery-lease-adapter.test.ts -->

### O4 — A gate bypass carries an explicit evidence deficit

It never silently waives lease or commit checks.

<!-- proof: symbol=bypassGate file=packages/arbor-gate/src/gate.ts roundtrip=packages/arbor-gate/tests/gate.test.ts -->

### O5 — Repeating a recovery request under the same idempotency key returns the same decision

A different request under that key is reported as a conflict rather than
re-executed.

<!-- proof: symbol=RecoveryService file=packages/arbor-mcp/src/recovery-service.ts roundtrip=packages/arbor-mcp/tests/recovery-service.test.ts -->
