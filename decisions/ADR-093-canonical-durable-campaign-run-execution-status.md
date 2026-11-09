# ADR-093: Canonical Durable Campaign-Run Execution Status

**Status:** Accepted
**Date:** 2026-08-25
**Authoring Revision:** 5ae361570a72c59eb1ff99533a5963b779e5805e
**Content ID:** sha256:d749edca374524f8e57cf780ff9bad1ca3ea04ddcb6ac5b5b5766a1d6247f969

## Context

Campaign execution currently has several correct but partial sources of truth.
`TaskSupervisor` owns the supervised task state, cancellation handshake,
optional deadline, and persisted reconciliation requirement; `JobScheduler`
maps one queued job to that task; `ArborRuntime.runCampaignJob` owns the one
canonical dispatch and its in-memory settlement promise; `CampaignManager`
owns the durable tree, campaign resumability, and a bounded run diagnostic;
and `HarnessSessionJournal` owns redacted native-session lifecycle/effect
evidence.  Each describes a different authority boundary, and none should be
replaced by a status dashboard.

The result is an operational blind spot.  A queued job and a started task are
distinguishable only by joining two in-memory projections.  Progress is a
number without durable “when did it last change?” evidence, so a silent
healthy heartbeat cannot be distinguished from no progress.  `runCampaignJob`
already distinguishes cancellation request from acknowledgement correctly,
but `CampaignManager.cancelledRuns` and the runtime's
`campaignRunDiagnostics` are explicitly memory-only; after restart the
operator loses “the last run was cancelled” even though the campaign may
correctly remain resumable.  A failed dispatch/refusal can have no task at
all, so it has no durable attempt identity.  Recovered active supervisor
tasks require reconciliation, but their task/campaign/session facts do not
assemble into one restart-safe run read.

ADR-043 forbids replaying an interrupted session: recovery reconciles effects
first, then submits a newly authorized `campaign.run`.  ADR-029 keeps one
writer per persistence directory.  A status contract must therefore join the
existing records, not re-execute work, infer a live worker after restart, or
turn a reader into a reviewer/approver.  It must make the exact attempt and
its state legible across CLI, TUI, and web projections without fabricating
review ownership.

## Decision

The runtime gains one canonical, durable **campaign-run execution-status
projection**.  It is a read model over the existing supervision, job,
campaign, and native-session authorities.  The only new durable record is a
small attempt index that establishes identity and lineage where no existing
record can: it links to canonical records and never copies a campaign tree,
task lifecycle, session transcript, approval, critic verdict, or tool result.

### 1. A durable attempt identity joins existing authorities

Before `job.submit`/`runCampaignJob` can make a campaign run observable, the
runtime appends a `CampaignRunAttempt` identity record:

```json
{
  "schema_version": 1,
  "attempt_id": "crun_opaque-id",
  "campaign_id": "campaign-id",
  "attempt_ordinal": 3,
  "supervisor_task_id": "campaign-run:…",
  "operation_id": "campaign-run:…",
  "supersedes_attempt_id": "crun_prior-or-null",
  "created_at": "…",
  "refusal": null
}
```

The record is append-only, persistence-backed, and keyed by opaque
`attempt_id`; `(campaign_id, attempt_ordinal)` is unique.  A normal attempt
links exactly one `TaskSupervisor` task and its one `JobScheduler` job.  A
preflight/dispatch refusal also obtains an attempt record but has no task/job
link where nothing was admitted; it records only a closed refusal code,
bounded redacted diagnostic reference, and terminal timestamp.  This makes a
refusal observable without inventing a fake task.

Attempt creation is idempotent for one submitted run request: a transport
replay returns the existing attempt rather than allocating a second ordinal.
Only a deliberate new `campaign.run` admission after the predecessor is
terminal or reconciliation-required creates the next attempt.  This preserves
the scheduler's existing operation-idempotency rule instead of introducing a
second retry path.

The status projector resolves each field from the authority that owns it:

| Status fact | Existing authority |
| --- | --- |
| Queue/task state, cancellation handshake, progress, deadline, restart reconciliation | `TaskSupervisor` persisted snapshot |
| Queue admission/dispatch identity | `JobScheduler` |
| Campaign/tree terminality, resumability, run diagnostic reference | `CampaignManager` snapshot |
| Native session activity, terminal/recovery/effect evidence | `HarnessSessionJournal` |
| Attempt identity, ordinal, and supersession link | `CampaignRunAttempt` index |

The projector refuses an inconsistent join (missing required linked record,
cross-campaign link, duplicate ordinal, malformed index) as
`integrity_unavailable`; it never chooses a convenient source or invents a
terminal outcome.  A no-persistence runtime may expose an explicitly
`ephemeral: true` projection, but it must not claim restart durability.

### 2. Closed execution state with separate progress and heartbeat clocks

The projection exposes one closed `state`:
`queued`, `started`, `progressed`, `heartbeat`, `cancel_requested`,
`terminal`, or `refused`.  `queued` is an admitted, undispatched job;
`started` is a dispatched supervised task with neither a later progress nor
heartbeat observation; `progressed` means its progress value changed;
`heartbeat` means liveness was recorded without advancing the progress value;
and `cancel_requested` mirrors the supervisor's request state exactly.
`terminal` carries a closed `outcome` (`completed`, `failed`, `cancelled`, or
`timed_out`); `refused` is only an attempt that never became a runnable task.

`SupervisorTask` is extended at its existing persistence boundary with
`last_progress_at`, `last_heartbeat_at`, and monotonically increasing
`progress_sequence`.  `reportProgress` advances both the number and
`last_progress_at`/sequence; `reportHeartbeat` changes only
`last_heartbeat_at`.  The injected supervisor clock must never make
`last_progress_at` decrease: a backwards observation is rejected (or, for an
equal instant, ordered by the sequence), rather than silently rewriting a
newer durable observation.  The projection shows both timestamps and their
ages, so “heartbeat with no progress” is a truthful condition, not a failure
claim.  There is no hidden polling timer: runners call the explicit heartbeat
method at known meaningful boundaries.

The task's existing `deadline_at` is the sole optional `declared_deadline_at`
in the run projection.  A missing deadline remains `null`; status does not
invent a timeout.  When the supervisor records timeout, the projection reads
that terminal state.  `reason` is a closed bounded code and
`diagnostic_ref` is an opaque/redacted reference to the campaign diagnostic,
session record, gate record, or recovery record—not raw stack traces, model
text, tool input/output, credentials, paths, or provider payloads.

### 3. Cancellation acknowledgement, restart, and supersession are explicit

Cancellation is two facts, never one optimistic label.  A `job.cancel` or
tree interrupt first yields `cancel_requested`; only
`TaskSupervisor.acknowledgeCancellation` yields terminal
`outcome: "cancelled"`.  A runner outcome or error racing this sequence must
still read the supervisor's settled state, as `runCampaignJob` already does.
The projector may show a cancellation-request timestamp/diagnostic reference,
but it MUST NOT call request acknowledgement or stop a worker.

At startup `TaskSupervisor.restore` marks non-terminal records
reconciliation-required; the status projection labels the matching attempt
`reconciliation_required: true` and native-session evidence as
`worker_liveness: "unknown_after_restart"`.  It never treats a restored
`started` task as a surviving worker, never auto-cancels it, and never
replays its old session.  ADR-043's normal recovery path determines any fresh
continuation.  If the prior attempt was durably terminal-cancelled, that
terminal outcome survives restart while `CampaignManager`'s campaign tree is
still reported independently as resumable when it is not halted.

A later admitted run creates a new attempt, with a higher ordinal and
`supersedes_attempt_id` pointing to the previous latest attempt.  Supersession
changes which attempt is “latest”; it does not rewrite the old attempt, clear
its cancellation evidence, mark a campaign verified, alter a critic result,
or grant continuation authority.  Timestamp ties choose ordinal, never a
wall-clock guess.  An attempt cannot supersede a still-runnable task unless
the existing single-writer/supervisor admission has first made the previous
one terminal or reconciliation-required.

### 4. One canonical projection for every operator surface

`projectCampaignRunStatus` is the sole status constructor.  The CLI,
`arbor task ... --wait` settlement display, TUI campaign/jobs/tasks views,
web/API endpoint, and runtime event stream consume its same redacted object;
they may format it but may not rejoin supervisor/maps/journals themselves.
The projection returns a deterministic list ordered by campaign ID then
attempt ordinal and a single latest-attempt view.  It is read-only: a status
query has no dispatch, cancellation, recovery, approval, review, ledger, or
session side effect.

The contract explicitly has no review authority.  It may report a bounded
campaign/tree or session diagnostic reference, but critic approval/rejection,
scope approval, and result adoption remain owned by their existing independent
actors and evidence.  A terminal execution status means only the supervised
run settled; it never means a proposed action was approved or a tree node was
verified.

### 5. Delivery and acceptance teeth

Before this record may be accepted, required
`gate:campaign-run-status` MUST be registered in `package.json` and the
declarative execution profile, selected as required in prepush and CI.  Its
isolated, persistence-backed fixtures must validate the attempt-index schema,
the cross-source join, status state machine, timestamps, supersession, and
redaction.  The gate blocks a missing projection, a second renderer-side
join, an unsafely auto-reconciled worker, or missing required enrollment.

The fixture/integration suite MUST prove:

1. queued is distinct from started, and an accepted preflight/dispatch
   refusal is durable `refused` without a fabricated task;
2. progress cannot regress, `last_progress_at`/sequence are nondecreasing,
   and heartbeat updates liveness without falsifying progress;
3. declared timeout, ordinary failure, gate refusal, completion, cancellation
   request, and cancellation acknowledgement produce their distinct states;
4. restart hydrates an orphan as reconciliation-required rather than live,
   drives the existing ADR-043 reconciliation path, and preserves a prior
   terminal-cancelled attempt while its non-halted campaign remains resumable;
5. a subsequent attempt supersedes the prior latest attempt by ordinal/link
   without mutating that attempt's terminal record or review evidence; and
6. CLI, runtime/API, TUI, web, and wait views parse to the same semantic
   projection and contain no raw secrets, stack/model/tool text, paths, or
   duplicated review ownership.

Acceptance is separate under ADR-059.  This ADR authorizes neither a retry
nor a continuation; it makes existing execution state legible.

## Consequences

Operators can now answer “which exact run is queued, making progress, merely
heartbeating, cancelling, settled, or refused?” from a durable identifier
that survives a restart.  A cancelled last run no longer disappears merely
because the process did, and a newly resumed campaign is visibly a new
superseding attempt rather than a rewrite of history.  CLI, TUI, and web stop
contradicting one another because they consume one read model.

The cost is a durable attempt index, timestamps added to supervision, strict
join validation, and migration/reconciliation behavior for old snapshots.
Some observations remain honestly unavailable after a crash; the projection
must say reconciliation-required rather than pretending to know whether a
worker survived.  The additional status record cannot be used as an approval
or a shortcut around the critic/recovery process.

This does not replace `TaskSupervisor`, make the job queue an execution
authority, persist native transcript contents, or change ADR-043's fresh
authority/effect reconciliation.  It also does not transform campaign
completion into result verification or give a status renderer the right to
approve, reject, or adopt work.

## Alternatives / Roads not taken

1. **A new campaign-run state machine beside TaskSupervisor.** Rejected:
   parallel cancellation, timeout, and restart rules would inevitably drift.
   The canonical contract projects the supervisor; it does not compete with
   it.

2. **Persist `cancelledRuns` and `campaignRunDiagnostics` as a campaign-only
   flag.** Rejected: it cannot identify separate attempts, explain a queued
   versus started job, preserve supersession, or join session reconciliation.

3. **Treat a restored active task as live until a timeout.** Rejected by
   ADR-043: after restart the worker/controller cannot be assumed to exist,
   and an apparent resume could replay an unknown external effect.

4. **Treat cancellation request as cancellation completion.** Rejected:
   the worker can still be running or settle another way; the supervisor's
   request/acknowledgement separation is a real safety boundary.

5. **Let each CLI/TUI/web surface compose its own status.** Rejected: it
   recreates the current inconsistent joins and makes redaction/restart rules
   renderer conventions instead of one testable contract.

## Obligations

### O1 — Every campaign-run attempt has durable identity and projects existing authorities without a duplicate executor

<!-- proof: symbol=CampaignRunAttemptIndex file=packages/arbor-mcp/src/campaign-run-attempt-index.ts roundtrip=packages/arbor-mcp/tests/campaign-run-attempt-index.test.ts -->

The future join fixture must prove a normal attempt links exactly one task/job,
a refusal has no fake task, and malformed/cross-campaign links fail closed.

### O2 — Progress, heartbeat, deadline, cancellation, and terminal outcomes remain distinct and restart-safe

<!-- unverifiable: projectCampaignRunStatus (packages/arbor-mcp/src/campaign-run-status-projection.ts) demonstrates nondecreasing progress, deadline, cancel-request-vs-acknowledge, every terminal/refusal path, and restart reconciliation with fixtures in packages/arbor-mcp/tests/campaign-run-status-projection.test.ts and campaign-run-status-runtime.test.ts — but the distinct "heartbeat" state (liveness without progress) needs last_progress_at/last_heartbeat_at/progress_sequence on SupervisorTask, which Decision §2 places at TaskSupervisor's own persistence boundary, declared in packages/arbor-core/src/runtime-contracts.ts (SupervisorTask, validateSupervisorTask), a file outside this tranche's ownership; this resolves once that extension lands. -->

The required tests must demonstrate nondecreasing progress, heartbeat without
progress, request-before-acknowledgement cancellation, each terminal/refusal
path, and orphan reconciliation without replaying the prior session.

### O3 — Supersession and every operator surface preserve one redacted status truth without asserting review authority

<!-- unverifiable: ArborRuntime.getCampaignRunStatus (packages/arbor-mcp/src/runtime.ts) demonstrates supersession by ordinal/link without mutating the prior attempt's terminal record and redaction (no raw secrets/stack/tool text) in packages/arbor-mcp/tests/campaign-run-status-runtime.test.ts and campaign-run-status-projection.test.ts — but CLI, TUI, web, and runtime-event adapters that must consume this one projection instead of rejoining the authorities themselves are explicitly a later tranche's ownership (packages/arbor-mcp/src/cli.ts and packages/arbor-tui/ were withheld from this tranche's file ownership); this resolves once those adapters land and the cross-surface parity test runs against them. -->

The parity suite must compare semantic objects across every surface, preserve
old cancellation evidence after a later attempt, and prove status reads never
approve/reject/adopt a campaign result or leak protected diagnostics.

### Acceptance note

This record remains Proposed.  ADR-059 requires an implementation and a
separate operator acceptance; authoring this record does not create execution,
continuation, or review authority.
