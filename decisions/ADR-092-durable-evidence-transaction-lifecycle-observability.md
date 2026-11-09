# ADR-092: Durable Evidence Transaction Lifecycle Observability

**Status:** Accepted
**Date:** 2026-08-25
**Authoring Revision:** 4a118ed73ccdf1ee3d66da4b7512f5d3cbb28ed1
**Content ID:** sha256:2f61699f081923a9a26598c78b7db9c86a8883da5f44cc826d77c63b4e7f6ef6

## Context

The repository-common evidence lease in `scripts/evidence-transaction.mjs`
correctly refuses automatic lock theft.  Its durable state.json (created only
while a transaction holds the lock, never checked in) already
records an owner, source candidate OID/input digest, one coarse `phase`, and
`heartbeat_at`; `bun run evidence:status` reports the owner as live, dead, or
ambiguous without changing the lease.  That closed an earlier operational
failure in which an interrupted refresh left later producers with only
`owner_exists`/`not_lock_owner` and no sanctioned way to discover the exact
recovery command.

The same state is not yet a lifecycle observation contract.  `transition()`
does not retain when the current phase began, and status drops the source
identity and heartbeat age.  The only timer is started after the snapshot is
prepared and `producer_running` has begun; `createStagingWorktree`, the
synchronous frozen install, and synchronous build can therefore look exactly
like a stuck owner.  The spawned producer has no durable, bounded child
identity/state or transaction-owned deadline/cancellation outcome.  Its raw
output is accumulated only for the eventual caller, which is not safe status
data and cannot tell an observer whether the child is still alive.

ADR-091 now requires finalization progress to explain active gates without
making an operator query `ps`.  An evidence transaction is one of those long
running finalization stages, but an in-memory finalization stream cannot be
the authority for a lease that outlives, or is observed independently of, its
parent finalizer.  The evidence status surface must remain queryable directly
from the git-common-dir state, including after a parent or terminal transport
has disappeared.  It needs enough durable, redacted state to distinguish a
live fresh owner from a live but stalled one, and both from a dead or
ambiguous owner, without converting a stale heartbeat into permission to
steal the lease.

## Decision

Evidence transactions gain a durable lifecycle observation contract.  This is
an extension of `acquireEvidenceTransaction`, `evidenceTransactionStatus`,
and `runEvidenceRefreshTransaction`, not a second lease implementation.  The
directory lock remains the single writer authority; state observation remains
read-only; and explicit recovery remains the only action that can archive a
proven-dead lock.

### 1. Versioned, redacted lifecycle state

New lease state uses schema version 2.  It contains the existing transaction
and owner identity plus these required, status-safe fields:

```json
{
  "schema_version": 2,
  "transaction_id": "opaque-id",
  "owner": { "owner_id": "pid:…", "pid": 123, "process_start_identity": "…", "acquired_at": "…" },
  "source": { "candidate_oid": "<40-hex>", "input_digest": "sha256:…" },
  "lifecycle": {
    "phase": "candidate_build",
    "phase_entered_at": "…",
    "heartbeat_at": "…",
    "heartbeat_sequence": 11,
    "terminal": null
  },
  "producer": {
    "state": "running",
    "role": "evidence_refresh",
    "command_id": "arbor_evidence_refresh_delegated",
    "pid": 456,
    "process_start_identity": "…",
    "process_group_id": 456,
    "started_at": "…",
    "deadline_at": "…",
    "deadline_ms": 1800000,
    "cancel_requested_at": null,
    "exit_code": null
  }
}
```

`phase` is a closed lifecycle value:
`acquired`, `snapshot_prepared`, `dependency_install`, `candidate_build`,
`producer_running`, `normalizing_evidence`, `atomic_publish`, `completed`,
`failed`, `timed_out`, or `cancelled`.  Every transition atomically writes a
new `phase_entered_at`, advances `heartbeat_sequence`, and updates
`heartbeat_at`.  `lifecycle.terminal`, set before cleanup/release, carries
the closed outcome (`succeeded`, `failed`, `timed_out`, `cancelled`, or
`refused`), its timestamp, and a typed reason code.  A bounded, redacted
latest-terminal receipt is atomically retained beside the lock directory
after release so `evidence:status` can distinguish “no active transaction”
from “the immediately preceding transaction timed out/cancelled”; it is not a
second lock and never authorizes a writer.

The producer object is `null` before a producer is launched; once launched it
is retained through its terminal state and copied into the bounded terminal
receipt.  Its closed `state` values are `running`, `exited`, `timed_out`, and
`cancelled`.  It records only role, stable command ID, pid/start
identity/process group, timestamps, deadline, cancellation state, and exit
code.  It MUST NOT contain raw argv, working directory, environment,
delegation token or its digest, credentials, source patches, producer output,
or child stdout/stderr bytes.  Source identity is durable as the candidate
OID and input digest already used to bind publication; it is never inferred
from a changing checkout during status display.  Schema-v1 locks remain
readable as a conservative `legacy_incomplete` projection: they are never
silently rewritten, never treated as fresh by missing fields, and remain
recoverable under the existing proven-dead rule.

### 2. Heartbeat and status semantics are deliberately two-dimensional

The owner liveness check stays exactly process-identity based:
`live`, `dead`, or `ambiguous`.  Status independently derives progress
liveness from the durable heartbeat using an injected/readable clock and the
declared `EVIDENCE_HEARTBEAT_STALE_MS` threshold (30 seconds): `fresh`,
`stale`, `not_started`, `terminal`, or `unknown_clock`.  It returns the raw
`heartbeat_at`, computed non-negative `heartbeat_age_ms` when valid,
`phase_entered_at`/`phase_age_ms`, source identity, and the bounded producer
projection above.  It also returns a typed recommended action, never an
inference hidden in prose.

The owner publishes a heartbeat at acquisition, every transition, and at
least every ten seconds while snapshot preparation, dependency installation,
candidate build, or producer execution is active.  Snapshot/install/build
MUST therefore use a progress-aware asynchronous child runner rather than a
blocking `spawnSync` path that prevents the owner timer from firing.  The
timer is aggregate per transaction, not one timer per child; it is cleared
only after terminal state is durably recorded.  Heartbeats prove the owner
event loop is running and report child observation; they do not claim a
silent child is making useful work.

A stale heartbeat is a diagnosis, not a lease-expiry policy.  A status can be
`owner_liveness: "live", progress_liveness: "stale"`; that must recommend
waiting/inspecting the owner and MUST NOT expose a recovery command.  Only
`owner_liveness: "dead"` exposes the exact existing recovery command.
Ambiguous state exposes no recovery command and no auto-remediation.  This
separation prevents a suspended host, clock issue, or slow legitimate phase
from turning observability into accidental concurrent-writer authority.

### 3. Bounded setup/producer execution and terminal outcomes

`runEvidenceRefreshTransaction` owns a cancellable process-group runner for
snapshot setup, frozen install, candidate build, and the delegated producer.
Each stage receives an explicit declared deadline; the producer deadline is
passed as a validated positive value and defaults to 1,800,000 ms, matching
the current CLI refresh bound.  State and status show the deadline and its
remaining/overdue age.  No timeout may be derived from an absence of child
output.

On deadline expiry the transaction records `producer.state: "timed_out"`
and lifecycle `timed_out`, requests SIGTERM for the owned process group, then
uses the existing bounded kill grace before SIGKILL if necessary.  On an
owner-originated abort signal it records `cancel_requested_at`, terminates the
same owned process group, and records lifecycle `cancelled`.  A normal exit
records `succeeded` or `failed` with a bounded exit code.  In every path the
terminal state/receipt is written before staging cleanup and lease release.
The status command never sends a signal, and an unrelated contender cannot
cancel a live owner: it continues to receive `owner_exists` or a bounded-wait
refusal.  If the owner dies before it can record terminal state, status says
dead/ambiguous from the durable lock it can read; explicit recovery, not a
guessed terminal result, is required.

### 4. One projection for direct status, runtime, and ADR-091

`evidenceTransactionStatus` becomes the one redacted semantic projection.
`bun run evidence:status` renders it for humans and `bun run evidence:status
-- --json` emits it unchanged as JSON.  The native `arbor evidence status`
runtime/API projection, including the finalizer's evidence-closure view,
MUST consume that same object; no renderer may reread lock files or invent a
second stale/dead rule.  Human and JSON output must show the same status
class, phase, phase/heartbeat ages, source identity, producer state/deadline,
and recovery availability (formatting may differ).

ADR-091's finalization reporter consumes sanitized lifecycle snapshots/events
while it is the parent of an evidence closure so its `evidence_closure` stage
is not silent.  That is additive: `bun run evidence:status` remains a
standalone read-only command before, during, and after finalization, and an
interrupted finalizer cannot erase or replace the lease's durable authority.

TUI and web are required consumers of the runtime/API projection.  Their
evidence/finalization views MUST show phase, owner-liveness and progress-
liveness separately, heartbeat/phase age, source candidate identity,
producer deadline/terminal receipt, and whether recovery is available.  They
MUST NOT reconstruct status from lock files or expose recovery for a live or
ambiguous owner.  The projection is carried with ADR-094's freshness,
disconnect, and resynchronization envelope so a stale client observation is
not confused with a stale transaction heartbeat.

### 5. Delivery and acceptance teeth

Before this record can be accepted, a required
`gate:evidence-transaction-observability` MUST be registered in
`package.json` and the declarative execution profile, selected as required in
both prepush and CI.  It must validate the schema and run an isolated
transaction fixture suite; absence, redaction failure, stale/fresh
misclassification, renderer drift, missing heartbeat coverage, or an
unenrolled profile is blocking.  `gate:finalization-progress` from ADR-091
must additionally prove it consumes this sanitized projection rather than
polling process state.

The fixture suite, with injected clock and controllable child process groups,
MUST prove:

1. a live owner with a fresh heartbeat reports active phase, phase-entered
   time/age, source identity, and bounded child identity without a recovery
   command;
2. a live owner with an old heartbeat reports stale/no-progress honestly but
   cannot be recovered, stolen, or replaced automatically;
3. dead and ambiguous owners remain distinguishable, with recovery offered
   only for a proven-dead matching transaction, and recovery atomically
   archives rather than silently deletes the lock;
4. snapshot, install, build, and producer each heartbeat while active, and
   producer deadline/abort records timeout/cancel terminal state before
   group cleanup/release;
5. no status, receipt, human renderer, JSON renderer, or finalization event
   contains raw argv, environment, tokens/digests, paths, or producer output;
   and
6. direct CLI JSON, human CLI, runtime/API, TUI, web, and ADR-091 finalization
   projections parse to the same semantic status object, while standalone
   status remains available when no finalizer is attached; client freshness
   remains distinct from transaction heartbeat freshness.

Acceptance remains a separate operator act under ADR-059.  This ADR does not
authorize an evidence refresh, evidence rebind, recovery, or lock removal.

## Consequences

An operator can tell whether a transaction is actively making owner-level
progress, what exact source candidate it is bound to, whether it has reached a
deadline, and which bounded child it owns without reading `.git` by hand or
guessing from `ps`.  Finalization gains the same signal, while the durable
status command remains useful if the finalizer dies or was never involved.
The result makes a stale heartbeat visible without turning it into a false
claim that a live process is dead.

The cost is a state-schema migration, an asynchronous setup runner, atomic
terminal receipts, and an additional timer/writes during a long transaction.
These are intentional: durable lifecycle state is only credible if it records
the phases during which an observer actually needs it.  The fixed redaction
boundary means an operator seeking raw producer diagnostics must use the
controlled command output/log mechanism, not the lease status surface.

This does not weaken source-identity checks, change evidence publication's
atomicity, make local leases server authority, or permit one agent to cancel,
recover, or replace another live transaction.  A heartbeat says the owner is
observed alive at the control-plane level, not that a compiler, network, or
producer is productive.

## Alternatives / Roads not taken

1. **Treat a stale heartbeat as an expired lock and acquire it automatically.**
   Rejected: a suspended owner, clock anomaly, or busy event loop can be stale
   without being dead.  Reuse of a possibly live writer lease is the exact
   concurrent-publication risk the transaction exists to prevent.

2. **Add only a `ps` hint to the current status prose.** Rejected: host process
   listings are not durable, cannot prove candidate binding, are unavailable to
   CI/runtime consumers, and provide no common schema for ADR-091.

3. **Heartbeat only while the delegated producer runs.** Rejected: frozen
   install and build are often the longest silent portions.  An observer does
   not care that the implementation calls them “setup” if they look hung.

4. **Put raw command/output details in status for diagnosis.** Rejected:
   lease state is shared across worktrees and long-lived recovery archives;
   raw argv, environment, tokens, paths, and output expand disclosure far
   beyond an operational lifecycle projection.

5. **Let the finalization progress stream be the evidence-status API.**
   Rejected: that stream is parent-process-local and disappears with its
   parent.  The durable lease must remain independently observable; ADR-091
   is a consumer, never the source of lease truth.

## Obligations

### O1 — Evidence status distinguishes owner liveness from heartbeat progress and exposes redacted lifecycle identity

<!-- proof: symbol=evidenceTransactionStatus file=scripts/evidence-transaction.mjs roundtrip=scripts/tests/evidence-transaction-lifecycle.test.mjs -->

`evidenceTransactionStatus` now derives `owner_liveness` (process-identity
based: live/dead/ambiguous, unchanged from ADR-101) and `progress_liveness`
(heartbeat-based: fresh/stale/not_started/terminal/unknown_clock) as two
independent dimensions from schema-v2 lock state (`lifecycle.heartbeat`,
`lifecycle.phase_timestamps`, `lifecycle.deadline`, redacted
`lifecycle.children`), against an optional injected `clock`.
`scripts/tests/evidence-transaction-lifecycle.test.mjs` proves live/fresh,
live/stale (never exposing a recovery command), dead-legacy (archived, not
deleted), ambiguous, and a dead schema-2 transaction without a terminal-
success receipt (requires explicit `--reviewed --reason`) — each without
reading the host process list beyond the existing ADR-101 pid check.
`scripts/tests/evidence-transaction-schema.test.mjs` continues to prove the
`unsupported_schema_version` / legacy-schema-1 distinction this builds on.

### O2 — Every long evidence lifecycle phase heartbeats, and timeout/cancellation reach durable terminal state without lease theft

<!-- proof: symbol=runEvidenceRefreshTransaction file=scripts/evidence-transaction.mjs roundtrip=scripts/tests/evidence-transaction-lifecycle.test.mjs -->

`runEvidenceStagingSetup` and `runEvidenceRefreshTransaction` now run
snapshot/install/build/producer through an asynchronous, process-group-owned
child runner (`runOwnedChild`) instead of the blocking `spawnSync` path the
Context section named as the exact cause a stuck owner and legitimate long
phase look identical. `scripts/tests/evidence-transaction-lifecycle.test.mjs`
proves the owner's heartbeat timer keeps advancing while
`dependency_install`/`candidate_build` children are active (the event loop is
never blocked), that a producer exceeding its declared deadline is killed
(SIGTERM, then SIGKILL after a bounded grace) and reaches a durable
`timed_out` terminal receipt before staging cleanup and lease release, and
that an owner-originated `AbortSignal` cancels a running producer and records
`cancelled` — after which a new contender acquires cleanly, proving no lease
theft occurred.

### O3 — All operator and finalization surfaces project the same redacted durable status object

<!-- unverifiable: evidenceTransactionStatus is now the single redacted projection this ADR requires, but the runtime/API (packages/arbor-mcp, ADR-093's file ownership this tranche), TUI/web, and ADR-091's finalization progress reporter (scripts/finalize.mjs / scripts/enforcement-control-plane.mjs, ADR-091/108's file ownership this tranche) do not yet consume it — verified by grep: no package under packages/arbor-mcp/src calls evidenceTransactionStatus/evidenceTransactionReadStatus as of this ADR's evidence-transaction.mjs tranche. This resolves once those consumers call evidenceTransactionStatus directly and a cross-surface parity test proves it, which depends on files this tranche does not own. -->

`scripts/tests/evidence-transaction-lifecycle.test.mjs`'s redaction test
proves the CLI/JSON status object and terminal receipt never contain raw
argv, environment, delegation tokens/digests, source patches, cwd, or
producer output — the redaction half of this obligation. The cross-surface
parity half (CLI, runtime/API, TUI, web, and ADR-091's finalization all
parsing to the same semantic object) remains open until those consumer files
are wired to call `evidenceTransactionStatus` directly.

### Acceptance note

This record remains Proposed.  ADR-059 requires implementation and operator
acceptance to be separate acts; no authoring authority may accept this record
or exercise the evidence/recovery actions it governs.
