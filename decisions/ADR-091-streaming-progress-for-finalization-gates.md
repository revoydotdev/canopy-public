# ADR-091: Streaming Progress for Finalization Gates

**Status:** Accepted
**Date:** 2026-08-25
**Authoring Revision:** 645ef1d2b56eb394fb16b0b97ac1c1306e4a13be
**Content ID:** sha256:317e77ef4a944251f193de12169e6a09fe96a16dd12f7e0cf893c8a7c8b3ae67

## Context

`scripts/hooks/pre-push` deliberately performs work that is both expensive and
opaque at its most consequential moment: it makes a detached candidate
worktree, installs from the frozen lockfile, builds the candidate, then calls
`bun run enforcement:prepush`.  `scripts/finalize.mjs` composes the same
immutable battery after its source/evidence admission barriers.  The actual
scheduler, `executeGateDag` in `scripts/enforcement-control-plane.mjs`, knows
the execution profile's ordered waves, each gate's timeout, and every child
process result, but exposes only a completed aggregate report.  Its current
`execution_emissions` are post-wave summaries, not a live protocol.

That leaves an agent or operator staring at an apparently silent pre-push or
finalization command unable to distinguish three materially different states:
a slow frozen install/build, a gate that is still within its profile deadline,
and a wedged child or parent process.  The practical workaround has become
querying `ps`, which is outside the candidate-bound protocol, differs by host
and container, leaks implementation detail, and does not tell the reader
which declared gate or finalization phase owns a process.  Silence is not a
useful operational state for a governed gate battery.

The repository already has the ingredients that make this solvable without a
second scheduler: `execution-profile.json` owns ordered finalization phases,
gate waves, mutability, and per-gate deadlines; `runDeadlineProcess` owns the
child process group and timeout; and `preflight-push.mjs` owns the human
projection of the final report.  What is missing is one revision-bound,
streaming observation contract shared by the pre-push launcher and the local
finalizer.

## Decision

Pre-push finalization MUST emit a bounded, structured progress stream.  It is
an observation protocol, not a second source of scheduling, timeout, or
approval authority: `execution-profile.json`, `runDeadlineProcess`, and
`executeGateDag` remain authoritative.  A later implementation MUST route
both `scripts/hooks/pre-push` and `scripts/finalize.mjs` through the same
progress reporter while preserving the existing final aggregate report.

### 1. One versioned event schema and stable stage identity

Every event is a single JSON object with this required shape (additional
fields are permitted only under a versioned extension key):

```json
{
  "schema_version": 1,
  "kind": "revoy2.finalization_progress",
  "run_id": "opaque-per-invocation-id",
  "sequence": 17,
  "event": "stage_started",
  "workflow_id": "prepush_finalization",
  "context": "prepush",
  "stage": {
    "id": "gate/typecheck-tests",
    "kind": "gate",
    "ordinal": 17,
    "phase_id": "immutable_prepush",
    "wave": 4
  },
  "elapsed_ms": 5023,
  "deadline_ms": 120000,
  "remaining_ms": 114977,
  "liveness": "runner_alive",
  "child": {
    "role": "gate",
    "command_id": "bun run gate:typecheck-tests",
    "pid": 12345,
    "process_group_id": 12345
  }
}
```

`schema_version`, `kind`, `run_id`, a strictly increasing positive
`sequence`, `event`, `workflow_id`, `context`, `stage`, `elapsed_ms`,
`deadline_ms`, `remaining_ms`, and `liveness` are required on every event.
`elapsed_ms` is monotonic time since the reporter started; it is never wall
clock time and is the only duration basis used to compute `remaining_ms`.
`deadline_ms`/`remaining_ms` are `null` only for a stage with no declared
deadline (for example hook input parsing), and that stage must carry
`deadline_reason: "unbounded_setup"`.  A gate deadline is exactly its
profile `timeout_ms`, never a hand-maintained duplicate.  `run_id` is opaque
and deliberately excluded from candidate identity, manifests, and cache keys.

`stage.id` is stable and machine-addressable: `run`, `hook_admission`,
`candidate_snapshot`, `dependency_install`, `candidate_build`, a profile
finalization `phase_id`, or `gate/<package-gate-name-with-the-gate-prefix-
removed>` (for example `gate/typecheck-tests`).  Run-level events use the
`run` stage with ordinal zero and a null `phase_id`; each other event also
identifies the finalization phase and, for a gate, its profile execution wave.  Its
ordinal comes from the profile-derived plan, not completion timing.  If a
child exists, `child.role`, a redacted/stable `command_id`, `pid`, and process
group identity are emitted as soon as spawn succeeds.  Raw argv, environment,
working-directory paths, credentials, and unbounded child stdout/stderr MUST
NOT be copied into progress events.

### 2. Event vocabulary, terminal truth, and deterministic release

The vocabulary is closed for schema version 1:

`run_started`, `stage_planned`, `stage_started`, `heartbeat`,
`stage_terminal`, and `run_terminal`.  `stage_terminal` and `run_terminal`
carry one required `outcome` from `succeeded`, `failed`, `timed_out`,
`cancelled`, or `refused`; terminal events also carry `reason_code` and, when
a child was launched, `exit_code` (including `null` where no exit code is
observable).  A refusal is a first-class terminal outcome: malformed push
input, a non-master/multi-ref/remote mismatch, an unavailable candidate, or a
profile/snapshot-admission rejection MUST emit `refused` before the launcher
exits.  A child timeout MUST emit `timed_out`, and fail-fast descendants MUST
emit `cancelled` or `failed` with their blocked prerequisite rather than
silently disappearing.  Every invocation emits exactly one `run_terminal`,
including refusal and setup failure.

Plan and launch events are released in the stable profile order: finalization
phase order, then execution-wave order, then lexicographic gate name.  Gates
within a read-only wave may still execute concurrently.  Their wall-clock
completion is inherently not deterministic, so the reporter records it
internally when observed but releases terminal events at the wave barrier in
that same stable order; a heartbeat identifies an exited child awaiting the
barrier as `child_state: "exited_pending_wave"`.  This makes a replayable
event order without falsely claiming concurrent process timing is reproducible.
Each event receives its sequence only in this one release point.  No caller
may synthesize, reorder, or renumber events after the reporter.

### 3. Liveness that is useful but never overclaimed

The reporter emits `stage_started` immediately before work begins, then an
aggregate `heartbeat` at each five-second monotonic interval boundary while
any stage is active, and an immediate terminal event when the stable release
rule permits it.  If a suspended parent misses an interval, it emits one
heartbeat on its first subsequent scheduler turn and skips missed intervals;
it never bursts catch-up heartbeats.
Heartbeats name all active stages in stable order and include each stage's
elapsed/deadline/remaining values, known child PID/group, whether its child is
running or exited-pending-wave, and bounded byte counters for observed stdout
and stderr.  They prove that the parent reporter's timer/event loop is making
progress and that it has (or has not) observed a child exit; they do NOT claim
that a silent child is doing useful work.  Absence of a promised heartbeat is
therefore actionable evidence of a stalled reporter or transport, while a
continuing heartbeat with no byte growth says the child is alive but silent.

Cadence is deliberately bounded: at most one heartbeat is written per
five-second interval for the whole run, not once per concurrent child; start,
state-transition, and terminal events are exempt.  A heartbeat contains
counts and identifiers, never child log chunks.  The reporter flushes every
event synchronously to its selected stream.  This gives an operator a
five-second scheduled liveness bound without turning a 30-minute gate into
thousands of lines of duplicated output.

### 4. Human and JSON are renderings of the same events

The reporter owns semantic event objects first.  `renderProgressHuman(event)`
and `renderProgressNdjson(event)` are the only renderers; they consume the
same object, in the same sequence, and cannot each decide independently which
stage, deadline, outcome, or child is worth showing.  Human lines must expose
sequence, event, stable stage identity, elapsed/deadline/remaining time, and
terminal outcome/reason; JSON is one newline-delimited schema object per
event.  The final aggregate execution report remains a single JSON document
on stdout for existing automation; the streaming progress channel is stderr,
so it cannot corrupt that document.

`--progress=human|json|auto` selects only the renderer, not whether events
exist.  `auto` chooses human lines on an interactive TTY and NDJSON on a
non-TTY.  The checked-in pre-push hook and CI MUST use `auto`; CI/non-TTY
output is consequently uncoloured NDJSON, is not suppressed, and has the
same event count, sequence, and semantic fields as its interactive human
counterpart.  A local diagnostic command may choose an explicit renderer, but
the governed pre-push path has no silent-progress escape hatch.

### 5. Delivery and acceptance teeth

The implementation surface is deliberately concrete.  It MUST introduce one
shared reporter used by the shell-hook replacement/driver, finalizer,
immutable-battery setup, `runDeadlineProcess`, and `executeGateDag`; the hook
may remain a stable launcher, but it may not regain a separate handwritten
progress dialect.  The progress-aware runner is the only place that may own
the heartbeat timer, child attribution, and event sequence.  The profile
continues to own phase/wave/deadline values, and the aggregate manifest stays
candidate-bound exactly as it is today.

Before this record can be accepted, a required `gate:finalization-progress`
MUST be registered in `package.json` and `scripts/execution-profile.json`, be
required in both `prepush` and `ci`, and fail if the protocol's validator or
fixture suite is absent or red.  The gate and its tests MUST prove all of the
following against a fake monotonic clock and controllable child processes:

1. schema validation, stable stage identity, profile-derived deadline, and
   child PID/process-group attribution;
2. exact plan/launch/terminal ordering for concurrent waves, including the
   `exited_pending_wave` observation and a single terminal run event;
3. heartbeat liveness and the five-second global bound, including no heartbeat
   after a terminal event and no raw child-log duplication;
4. each terminal outcome (`succeeded`, `failed`, `timed_out`, `cancelled`,
   `refused`), including an early pre-push refusal before any snapshot exists;
5. semantic parity between human and NDJSON renderings, and non-TTY/CI's
   forced NDJSON behavior while stdout remains parseable as the final report;
   and
6. an installed-hook integration fixture showing progress before a deliberately
   slow gate completes, so success cannot be faked by a unit-only renderer.

`gate:finalization-progress` is a delivery interlock, not an advisory
dashboard: a missing event, a cadence violation, a schema mismatch, a
renderer divergence, or a bypassed pre-push/CI enrollment blocks the candidate
through the existing declarative battery.  Acceptance authority remains
separate under ADR-059; this authoring change does not claim the protocol is
implemented.

The operator cockpit is a required consumer, not a hypothetical future use.
The runtime catalog MUST expose the same redacted event objects and a bounded
active/latest-run snapshot to TUI and web.  Both surfaces MUST show reporter
freshness, current stage/deadline, child-state classification, disconnect or
stream-loss state, and terminal/refusal outcome; neither may substitute a
spinner for a reporter heartbeat.  Delivery may differ by transport, but its
freshness and resynchronization semantics MUST conform to ADR-094 and the
semantic-parity fixture above MUST include CLI, TUI, and web consumers.

## Consequences

Operators and agents gain an in-band answer to “is it working?” with the
declared stage, child, elapsed time, and deadline, rather than inferring it
from host process listings.  A streamed JSON protocol also lets a TUI, log
collector, or future remote receipt consume exactly the same semantics a
terminal reader sees.  The existing candidate-bound final report remains
compatible, so parsing it does not become a race against interleaved progress
text.

The cost is intentional complexity at the boundary where the hook presently
does some work in shell and the battery does other work in JavaScript.  The
driver/reporter must preserve timeout and cleanup behavior under failure,
must avoid leaking sensitive argv/environment data, and adds a periodic wakeup
for every active pre-push run.  The five-second, aggregate-only heartbeat
budget bounds that cost and the output volume.

This does not make a frozen operating system, dead terminal transport, or a
silent-but-still-running compiler magically diagnosable.  It makes the
reporter's own liveness observable and labels the stronger conclusion it
cannot make.  It also does not relax any gate, change candidate identity, or
turn local pre-push into server-side enforcement (ADR-025).

## Alternatives / Roads not taken

1. **Tell operators to use `ps`/`top` when output is quiet.** Rejected: the
   process tree has no stable mapping to profile stages, varies across hosts
   and containers, and is not available to a CI log reader.  It observes an
   implementation accident rather than the governed execution contract.

2. **Forward every child stdout/stderr chunk as progress.** Rejected: many
   tools are either silent or extremely chatty; raw forwarding leaks argv-like
   details and turns liveness into log spam.  Bounded byte counters plus a
   timed parent heartbeat distinguish those cases without treating a log as a
   protocol.

3. **Emit a heartbeat from each concurrent gate.** Rejected: a wide
   read-only wave multiplies lines exactly when the reader most needs a clear
   summary.  One aggregate heartbeat retains per-child attribution while
   preserving a predictable global output bound.

4. **Claim terminal-event order is naturally deterministic under concurrent
   execution.** Rejected: completion timing is scheduler-dependent.  The
   wave-barrier release rule keeps execution concurrent while making the
   observable protocol deterministic; it explicitly exposes a child that
   exited early rather than hiding it until the wave closes.

5. **Add a separate status command that polls the running battery.** Rejected:
   it recreates the original out-of-band observation problem, adds discovery
   and authorization questions for a live process, and still leaves plain
   hook/CI logs silent.  Progress must be produced by the run that owns the
   state.

## Obligations

### O1 — Every governed pre-push/finalization run emits a schema-valid, ordered, bounded-liveness event stream

<!-- proof: symbol=validateProgressStream file=scripts/finalization-progress.mjs roundtrip=scripts/tests/finalization-progress.test.mjs -->

The validator (`validateProgressStream` in `scripts/finalization-progress.mjs`)
rejects a missing, malformed, missequenced, over-cadent, or post-terminal
event, and `gate:finalization-progress` (`scripts/finalization-progress-gate.mjs`)
derives each gate's `deadline_ms` from the active execution profile's
`timeout_ms` via `executeGateDag`'s wiring, never a second table — proven in
`scripts/tests/finalization-progress.test.mjs`'s "schema, stage identity,
deadlines, child attribution" and "protocol validator" suites.

### O2 — Progress truthfully attributes child execution and every terminal outcome without exposing raw process data

<!-- proof: symbol=runDeadlineProcess file=scripts/enforcement-control-plane.mjs roundtrip=scripts/tests/finalization-progress.test.mjs -->

`runDeadlineProcess`'s `onSpawn`/`onOutput` observation hooks (additive,
scheduling-inert) let `executeGateDag` attribute PID/process-group identity to
a stage as soon as a real child spawns; the "liveness and heartbeat cadence"
suite spawns a genuine ~400ms child process and proves a heartbeat observes
its pid while it is still running. The "terminal outcomes" suite sweeps every
declared outcome (`succeeded`, `failed`, `timed_out`, `cancelled`, `refused`),
including an early `refused` run_terminal before any candidate snapshot
exists. `validateProgressStream`'s `childProblems` check rejects any child
object carrying argv/env/cwd/credentials/log-chunk fields; `gate:finalization-progress`
runs this as a delivery interlock, not an advisory check.

### O3 — Human, JSON, TTY, and CI renderings preserve one semantic event stream

<!-- proof: symbol=renderProgressHuman file=scripts/finalization-progress.mjs roundtrip=scripts/tests/finalization-progress.test.mjs -->

`parseHumanProgressLine` is the inverse of `renderProgressHuman`; the "human/NDJSON
semantic parity" suite parses both renderings of every fixture event back to
the same sequence/event/stage-identity/elapsed/deadline/remaining/outcome
fields, and `selectProgressRenderer` is proven to choose NDJSON off a TTY and
human on one. `runImmutableBattery`/`finalize.mjs`'s shared reporter always
writes the progress channel to stderr and the final aggregate report to
stdout as an independent JSON document (Decision §4); `gate:finalization-progress`
re-runs the same parity check as its own delivery interlock.

Two things this ADR's Decision §5 also required remain **not implemented by
this tranche** and are named here rather than silently dropped: (1) the
operator-cockpit TUI/web consumer (Decision §5, "The operator cockpit is a
required consumer") — that surface lives in `packages/arbor-tui`/`arbor-mcp`'s
web catalog, outside this tranche's file ownership; (2) the pre-push shell
hook's own `hook_admission`/`candidate_snapshot`/`dependency_install`/`candidate_build`
stages are only observed when `runImmutableBattery` performs that work itself
(the CI path, and pre-push's own redundant inner snapshot) — the outer shell
script (`scripts/hooks/pre-push`) still performs its own worktree/install/build
before invoking `bun run enforcement:prepush`, and those specific shell-level
steps do not yet emit through the shared reporter. Both are legitimate
follow-on work, not silently abandoned.

### Acceptance note

This record remains Proposed.  ADR-059 requires acceptance authority separate
from the implementation and authoring authority; the required delivery gate
and proofs described above must land and pass before an operator can accept it.
