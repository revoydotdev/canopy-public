# ADR-026: The Campaign Tree-Search Loop Is a Supervised Job, Not an Auto-Driven Library Call

**Status:** Accepted
**Date:** 2026-08-04

## Context

Before wave 1, `runCampaign`/`runOneCampaign` (`arbor-opencode/src/loop.ts`)
had exactly one production caller anywhere in the repository: `demo.ts`'s own
direct invocation. `RuntimeCatalogRouter` already declared a full `job.*`
command family backed by a real `JobScheduler`/`TaskSupervisor` — durable
task records, cancellation, retry policy, reconciliation on restart — and the
loop did not use any of it. Every other supervised capability in revoy2
(recovery, output capture, devtools tracing) is a job or a ledger-witnessed
operation; the campaign loop, the thing the whole system exists to run, was
the one exception, reachable only from one CLI subcommand's own bespoke
driver code.

This mattered beyond tidiness. A loop with no supervised-task identity has no
durable record another operation can reference, no `job.cancel` to hook into,
no reconciliation-on-restart story, and no uniform place for `arbor serve`/
`webui`/`tui` to expose "is a campaign currently running, and can I stop it."
Three deployment shapes were live options once the choice was framed as "how
does the loop actually get driven on a real run, not just in `arbor demo`":

1. **A supervised job** — `job.submit` with a dedicated `job_kind` binds the
   loop to the existing `JobScheduler`/`TaskSupervisor` machinery, the same
   authority every other long-running revoy2 operation already uses.
2. **The opencode plugin drives it** — `arbor-opencode/src/plugin.ts`
   (`arborPlugin`), the library export the opencode host loads, triggers a
   campaign run itself, tying campaign execution to opencode's own process
   lifecycle rather than revoy2's job system.
3. **Auto-resume on crash/restart** — the runtime notices an incomplete
   campaign at startup and silently resumes it, rather than requiring an
   operator or caller to re-submit.

## Decision

**Option A.** The campaign loop is a supervised job, submitted through the
existing `job.submit` command with a dedicated `job_kind`
(`CAMPAIGN_RUN_JOB_KIND = "campaign.run"`, `arbor-mcp/src/runtime.ts:61`) —
`RuntimeCatalogRouter`'s `job.submit` stays the sole command authority that
creates one; this does not introduce a second dispatch path or a new
top-level `campaign.run` catalog kind.

Concretely, as implemented (commits `47f33a4`, `c57a47e`, `f1565ce`,
`2c26c7c`):

1. **`ArborRuntime.runCampaignJob`** starts `campaignRunner.run` against the
   job's own supervisor `AbortSignal` (`supervisor.signalFor(taskId)`), so
   `job.cancel` already stops a live run through the existing
   `TaskSupervisor.requestCancellation` path — no second cancellation
   channel. Finalization reads the task's actual terminal state back off the
   supervisor rather than trusting the runner's own report, so it is correct
   regardless of *why* the signal was aborted.
2. **`campaign.halt` and `tree.interrupt` are bound to the live run, not just
   the ledger.** `CampaignManager.isHalted` (commit `f1565ce`) is checked at
   the top of every loop iteration, fixing a real bug the job-as-supervised
   design surfaced: a manual `campaign.halt` was previously noticed one
   iteration late, misreporting the stop as `"no_nodes"` instead of
   `"manual"`. `interrupt` (`runtime.ts:280-312`) cancels the active
   `campaign.run` supervised task when the interrupted subtree includes the
   node currently being expanded — the loop has exactly one in-flight
   specialist/critic dispatch and one shared `AbortSignal`, so this is the
   only way an interrupt reaches work already in flight, not merely the
   ledger-level record of the interruption.
3. **`CampaignRunner` is a typed, optional composition-root seam**
   (`RuntimeCompositionOptions.campaign_runner`), matching the established
   pattern for `recovery_leases`/`model_capabilities`: absent by default (a
   bare `new ArborRuntime()`, used pervasively by tests, never touches
   opencode or the filesystem), and `job.submit` for `campaign.run` is
   rejected `unavailable` — typed absence, not a silently inert job — when
   no runner is supplied. `cli.ts`'s `createCliRuntime` is the production
   caller that composes a real one (real opencode subprocess executor, real
   `WorktreeManager`, real loop config ports) for every CLI transport
   (`arbor run`/`serve`/`webui`/`tui`), not just `arbor demo`'s own direct
   call. `arbor demo` is kept as an alias; `run` is the primary command name,
   reflecting that this is no longer demo-only.
4. **No auto-resume.** Nothing in `ArborRuntime` or `createCliRuntime`
   notices an incomplete campaign at startup and re-submits it. Recovery
   after an interruption or crash stays exactly what ADR-012 already
   requires: an explicit, durable, operator- or auditor-authorized runtime
   operation with its own idempotency key and fresh lease, never an
   automatic startup mutation. This ADR does not change ADR-012; it confirms
   that binding the loop to the job/task supervisor did not quietly acquire
   auto-resume semantics along the way — a job's terminal state (cancelled,
   failed, completed) is a durable fact for an operator to act on, not a
   trigger for the runtime to act on by itself.

## Consequences

**Positive:**

- The campaign loop now has the same supervised-task identity every other
  long-running revoy2 operation has: a durable task record, `job.cancel`,
  reconciliation on restart, and a uniform surface for `arbor
  serve`/`webui`/`tui` to query "is a campaign running, can I stop it."
- `campaign.halt`/`tree.interrupt` now genuinely reach in-flight work on a
  real run, not just the ledger — closing a real latency/misreport bug
  (`f1565ce`) that a job-shaped loop made visible by giving cancellation an
  actual target to reach.
- No new authority was invented for cancellation — `job.cancel` and
  `tree.interrupt`'s active-node case both resolve to the same
  `TaskSupervisor.requestCancellation` call. One cancellation channel, not
  two competing ones.
- `arbor run` (formerly `arbor demo`) is genuinely the same code path every
  other transport uses, not a special case that happened to be the only
  thing that worked.

**Negative:**

- **The opencode plugin (`arbor-opencode/src/plugin.ts`, `arborPlugin`)
  still does not drive `campaign.run` jobs.** Confirmed by direct search:
  zero references to `job.submit`, `CAMPAIGN_RUN_JOB_KIND`, or `runCampaign`
  anywhere in `plugin.ts`. An opencode host loading `arborPlugin` gets
  agent/prompt registration and tool bindings, not a way to start a
  supervised campaign from inside an opencode session. This is Option B,
  explicitly not chosen — but it means the loop is reachable today only
  through revoy2's own CLI/MCP/webui surfaces, not from within opencode
  itself. This is a real, user-facing gap for anyone expecting "install the
  plugin, drive a campaign from opencode's own UI," and should be named
  plainly in release-facing documentation rather than left implicit.
- No auto-resume means an operator (or automation acting on their behalf)
  must notice a halted/interrupted/crashed campaign and explicitly
  re-submit or run recovery — there is no "just restart the process and it
  picks back up" behavior. This is a deliberate consequence of not
  overriding ADR-012, not an oversight, but it is a real operational cost
  compared to Option C.

**Neutral:**

- `RuntimeCatalogRouter`'s command surface did not grow — `job.submit` with
  a new `job_kind` value is additive to an existing, already-authoritative
  command, not a new top-level capability requiring its own catalog entry,
  contract, or roundtrip-conformance row beyond what `job.*` already has.

## Test implications

- A `campaign.run` job roundtrips through `job.submit` → `job.cancel` →
  terminal-state finalization against a real `TaskSupervisor`, not a mock:
  `arbor-mcp/tests` (commit `2c26c7c`, "roundtrip and resume-mid-flight
  coverage for `campaign.run` jobs").
- A manual `campaign.halt` is noticed on the very next loop iteration and
  reports `halt_reason: "manual"`, not `"no_nodes"` — regression coverage
  added alongside the `f1565ce` fix.
- `tree.interrupt` against the actively-expanding node cancels the
  supervised task and is observable via the task's terminal state, not just
  a ledger interruption record.
- `job.submit` for `campaign.run` rejects `unavailable` (not silently
  no-ops) when no `campaign_runner` is composed — proving the typed-absence
  contract holds for a bare `new ArborRuntime()`.
- No test claims the opencode plugin drives a campaign — that would be a
  false claim this ADR explicitly disclaims in Consequences above.

## Alternatives considered

1. **Option B — the opencode plugin drives the loop.** Rejected for this
   pass: `arborPlugin` is a library export the host loads for agent/prompt
   registration; giving it its own campaign-driving responsibility would tie
   campaign execution to opencode's process lifecycle (a session ending,
   opencode itself restarting) rather than revoy2's own supervised-job
   lifecycle, and would need its own cancellation/reconciliation story
   independent of `TaskSupervisor` — duplicating machinery Option A already
   provides. Not rejected as permanently out of scope: a future ADR could
   have the plugin *submit* a `campaign.run` job through the same
   `job.submit` path rather than drive one itself, which would close the gap
   named in Consequences without re-litigating this decision.
2. **Option C — auto-resume on crash/restart.** Rejected: this is exactly
   the shape ADR-012 already rejected for node-level recovery ("recovery is
   an explicit, durable runtime operation, never an automatic startup
   mutation") and Phase 6.2's correction warns against generally ("no gate
   conceives a capability nobody has designed" — auto-resume for a
   *campaign-level* job is a materially different trust decision than
   node-level recovery, since it can silently restart real tool-executing
   work with no human back in the loop). If auto-resume is wanted later, it
   needs its own ADR weighing exactly that trade-off, not an implicit
   inheritance from making the loop job-shaped.
3. **Leave `runCampaign` as `demo.ts`'s private driver, add a second,
   parallel `job.submit`-compatible entry point for other transports.**
   Rejected: this is precisely the "five gaps are one gap" pattern
   `docs/full-harness-ownership-brief.md` §2.3 warns against — a second
   authority for the same capability drifts from the first one silently.
   `cli.ts`'s `createCliRuntime` composing one real `CampaignRunner` shared
   by every transport, with `arbor demo` reduced to an alias, keeps exactly
   one path from "start a campaign" to "the loop actually runs."

## Obligations

### O1 — The campaign loop is started only through `job.submit` with the dedicated `CAMPAIGN_RUN_JOB_KIND`; there is no second, competing entry point into the tree-search loop

<!-- proof: symbol=CAMPAIGN_RUN_JOB_KIND file=packages/arbor-mcp/src/runtime.ts roundtrip=packages/arbor-mcp/tests/campaign-job-runner.test.ts -->

### O2 — `job.cancel` and `tree.interrupt` against the actively-expanding node both resolve to the same `TaskSupervisor` cancellation path — one cancellation channel, not two

<!-- proof: symbol=ArborRuntime file=packages/arbor-mcp/src/runtime.ts roundtrip=packages/arbor-mcp/tests/campaign-job-runner.test.ts -->

### O3 — A manual `campaign.halt` is noticed on the very next loop iteration and reports `halt_reason: "manual"`, not a stale `"no_nodes"` misreport

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager.test.ts -->

### O4 — Nothing in `ArborRuntime` notices an incomplete campaign at startup and silently re-submits it; recovery after an interruption or crash stays an explicit, operator-authorized action

<!-- proof: symbol=ArborRuntime file=packages/arbor-mcp/src/runtime.ts roundtrip=packages/arbor-mcp/tests/campaign-job-runner.test.ts -->

### O5 — `campaign_runner` is an optional composition-root seam: a bare `new ArborRuntime()` never touches opencode or the filesystem, and starting a `campaign.run` job without one is rejected rather than silently no-oping

<!-- proof: symbol=ArborRuntime file=packages/arbor-mcp/src/runtime.ts roundtrip=packages/arbor-mcp/tests/campaign-run-status-runtime.test.ts -->

`campaign-run-status-runtime.test.ts`'s "records a durable refusal with no
fake task when no campaign runner is configured" case constructs an
`ArborRuntime` with no `campaign_runner`, submits a `campaign.run` job
through the real `RuntimeCatalogRouter`, and asserts the attempt records
`supervisor_task_id: null` and `refusal.code: "no_campaign_runner_configured"`
rather than a fabricated task — the absent-runner path this obligation
claims, exercised end to end rather than left to `runCampaignJob`'s return
type alone.
