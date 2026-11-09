# ADR-043: Governed Crash Continuation Requires Effect Reconciliation

**Status:** Accepted
**Date:** 2026-08-12

Authored as Proposed, not Accepted: the authoring agent does not hold
acceptance authority. This record extends ADR-012's fresh-authority rule and
ADR-016's typed interruption outcome; it does not weaken either one.

## Context

ADR-012 correctly forbids an interrupted expansion from silently returning to
the pending queue. Its current implementation can resolve the abandoned lease,
acquire a new lease, recheck isolation, persist a retry transition, and submit
the canonical campaign loop. That is necessary, but it is not sufficient once
an interrupted session may have crossed a provider or tool effect boundary.

A crash can occur before dispatch, while a request is in flight, after an
external effect but before its result is settled, or after settlement but
before the session reaches a terminal record. Treating all four cases as an
ordinary retry can duplicate a write, shell command, or remote mutation.
Treating all four as permanently failed discards work whose result is already
durably observed or whose operation is independently repeatable.

The native harness already records bounded session events, tool audits, and
artifacts, but those records do not establish a write-ahead operation boundary,
an acknowledged idempotency key, a compensation capability, or the authority
under which a later session continues the work. In-memory recovery idempotency
also cannot arbitrate two recovery attempts after a process restart.

## Decision

Crash continuation is a two-stage governed protocol: **read-only
reconciliation first, newly authorized continuation second.** Recovery never
replays an old request or revives an old session.

### 1. Durable operation checkpoints

Before calling a provider or tool, the harness records a bounded operation
checkpoint with a stable operation id, effect class, and dispatch phase. It
records later acknowledgements and settlement as append-only checkpoints.
Arguments, credentials, provider payloads, and model text remain excluded.

An idempotency key is evidence only when the provider or tool contract
acknowledges that key and the acknowledgement is durable before the operation
is treated as retry-protected. A locally invented key is not protection.

### 2. Closed effect classification

Recovery projects every interrupted operation into exactly one class:

- `observed-complete`: durable evidence proves the effect completed;
- `observed-failed`: durable evidence proves the operation failed;
- `safely-idempotent`: no dispatch occurred, the operation is independently
  read-only/repeatable, or its idempotency key has a durable acknowledgement;
- `compensatable`: a durable compensation contract identifies a bounded
  inverse operation that still requires new authority;
- `indeterminate`: the evidence cannot prove any of the preceding states.

Classification is conservative. In particular, an in-flight mutation without
an acknowledged key is `indeterminate`, even when repeating it would often be
harmless. `arbor recover --campaign [--node]` previews these classifications
and the fresh admissions that authorization would require without invoking a
provider, tool, connector, or model.

### 3. Explicit disposition and durable authorization

`indeterminate` operations never continue automatically. An operator must
record an explicit disposition for each one. Compensation is likewise an
explicit, separately authorized action. Automatic continuation is permitted
only for an independently safe operation and only after all fresh authority is
admitted.

The continuation request, classification fingerprint, dispositions, admission
results, and outcome are durable. Its idempotency key is checked against that
durable record, so a restart returns the prior result or rejects conflicting
reuse rather than submitting a second continuation.

### 4. A new linked session under fresh authority

Authorization creates a new session linked to the interrupted session and its
durable checkpoint. It does not use native resume semantics and does not copy
the old transcript. The new session receives only a bounded provenance-bearing
continuation summary: operation classes, accepted dispositions, relevant
artifact/evidence references, and the new admission identity.

Before the new session becomes dispatchable, recovery re-runs and durably
records every applicable authority check: connector capability, credential
lease, campaign/node budget, worktree isolation, role policy, tool and approval
scope, high-risk scope, and model/capability revision. The abandoned execution
lease is resolved and replaced. Failure of any check leaves the continuation
non-dispatchable.

### 5. One canonical execution path

An admitted continuation is submitted as the existing supervised
`campaign.run` job. `RecoveryService.prepareContinuation` owns reconciliation
and preparation but gains no bespoke provider/tool redispatch path. The normal
campaign loop remains the only component that selects and executes the node.

## Consequences

Recovery can distinguish already-observed work from safe retry, compensation,
and genuine uncertainty without claiming knowledge it does not possess. A
process restart cannot erase recovery idempotency or lineage. Fresh authority
is visible before any resumed external call, and crash-injection tests can
assert the required ordering at every boundary.

The cost is additional write-ahead journal traffic, a closed recovery contract,
and operator involvement for uncertain effects. Providers and tools that do
not expose acknowledged idempotency or compensation remain conservatively
`indeterminate`; this is intentional.

## Obligations

### O1 — Preview classifies every interrupted operation without dispatch

<!-- proof: symbol=EffectClassifier file=packages/arbor-mcp/src/recovery/effect-classifier.ts roundtrip=packages/arbor-mcp/tests/recovery/effect-classifier.test.ts -->

The recovery preview returns one of the five closed classes for every
interrupted operation and performs no provider or tool call.

### O2 — Continuation cannot dispatch before fresh admission is durable

<!-- proof: symbol=RecoveryService file=packages/arbor-mcp/src/recovery-service.ts roundtrip=packages/arbor-mcp/tests/recovery/continuation-service.test.ts -->

The old lease is resolved, all fresh authority checks pass, and the admission
record is durable before the supervised campaign job can be submitted.

### O3 — Indeterminate effects require an explicit disposition

<!-- proof: symbol=buildContinuationPlan file=packages/arbor-mcp/src/recovery/continuation-plan.ts roundtrip=packages/arbor-mcp/tests/recovery/continuation-service.test.ts -->

No automatic path advances an `indeterminate` operation, and every accepted
operator choice is persisted with the continuation record.

### O4 — Idempotency acknowledgement precedes protected retry

<!-- proof: symbol=HarnessSessionJournal file=packages/arbor-mcp/src/harness-session-journal.ts roundtrip=packages/arbor-mcp/tests/recovery/continuation-journal.test.ts -->

Only a durable provider/tool acknowledgement, or an independently repeatable
contract, can classify a dispatched unsettled operation as safely idempotent.

### O5 — Continuation is a new linked session on the canonical campaign loop

<!-- proof: symbol=runRecoveryCommand file=packages/arbor-mcp/src/recovery/recovery-command.ts roundtrip=packages/arbor-mcp/tests/recovery/recovery-command.test.ts -->

Authorization records external continuation lineage and submits the existing
supervised `campaign.run`; it never resumes an old session or directly calls a
provider/tool.

## Roads not taken

- **Blind retry.** It can duplicate an effect whose acknowledgement was lost.
- **Transcript resume.** It inherits stale authority and expands the disclosure
  boundary beyond the bounded continuation summary.
- **Treat every interruption as indeterminate.** Safe, durable cases would
  require pointless operator work and observed results would be discarded.
- **An in-memory continuation registry.** It loses conflict detection at the
  exact process boundary this feature governs.
- **A recovery-only dispatcher.** It would create a second execution path that
  bypasses the campaign loop's selection, gates, and supervision.
