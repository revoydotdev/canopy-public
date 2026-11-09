# ADR-189: A Session Fork Reopens An Exhausted-Search Halt

**Status:** Accepted
**Date:** 2026-10-07
**Authoring Revision:** abb0abc0fa37b744f8140bfc3803572a94657299
**Content ID:** sha256:b5893e326d1d8e0ee907b7aa91a144b198fdb1956fae828050bb4daf9667745d

> **Amends ADR-043** (governed crash continuation): adds the one transition by
> which an operator session fork may reopen a halted campaign, and the
> restart reconciliation that transition owes under ADR-043's crash rules.

## Context

`harness.session.fork` dispatches its child through the ordinary supervised
`campaign.run`, whose selection picks nothing once a campaign is halted.
Commit b79a639a therefore made every fork from a halted campaign fail with a
conflict, and `harness.session.availability` report `fork: false` for any
halted campaign. That closed a real defect (a child, an authorization and a
lease for a session that could never start), but it also closed the case a
fork exists for: a search that ran out — `no_nodes`, nothing left to
select, or `converged`, the stall heuristic — is exactly when an operator
wants to try another direction from a finished session.

Not every halt means that. `budget_exhausted` (and the loop's
`max_iterations`) is a spending limit, and a fork must never be a way around
it. `manual` is an audited operator stop (ADR-118). `verified_result`,
`scope_unadoptable` and `stranded_work` each name a settled or recoverable
state that a fork does not address. Operator decision, 2026-10-06: forks
reopen `no_nodes` and `converged` halts; every other halt stays closed.

## Decision

**1. Reopenable halts are a closed set.** `FORK_REOPENABLE_HALT_REASONS`
(`packages/arbor-mcp/src/manager.ts`) is `no_nodes` and `converged`. Any other
halt is refused by the fork before anything is created, with an ADR-179
typed remedy (`haltedForkRefusal`, `runtime-catalog.ts`): a budget or
`max_iterations` halt goes to the operator (`budget` / `raise_budget`), every
other closed halt to the campaign planner (`admission` /
`repair_plan_or_config`, code `fork_halt_not_reopenable`).

**2. A reopen must be able to do its job, or it is refused.**
`CampaignManager.forkReopenPreview` also refuses a reopenable halt when
- the halt check, re-run with the reopened state, would halt again at once
  (`would_rehalt`, routed to `budget` / `raise_budget`): budget counters are
  never reset, so a campaign whose `max_seconds` elapsed while it sat halted
  stays closed; or
- the child would hang under a failed, pruned or abandoned ancestor, which UCT
  selection never picks, and would not be the sole pending node either — the
  only case the production loop dispatches directly
  (`fork_child_unselectable`, routed to `admission`).

**3. The reopen is a typed, attributable, write-ahead transition.** A new
ledger record kind, `campaign_reopen` (`@arbor/audit`), carries the operation
id, the actor and `authority: "operator"`, the overridden halt reason, the
source session, the reason, and the convergence counter before and after. Its
`reopened` phase is fsynced before the campaign's halt flag clears; a
`reverted` phase, valid only after its `reopened` phase, restores the halt.
The ledger validator rejects any other overridden reason, so a budget or
manual halt cannot appear as reopened even in a hand-edited ledger.

**4. Order of operations in the fork.** The child is branched first, then
the reopen is recorded and the halt cleared, then the existing fresh-identity
fork proceeds unchanged (continuation admission, staged authorization, a
freshly acquired lease, the canonical `campaign.run`). Branching first means
the durable reopen record always names a pending node that exists. If the fork
fails after the reopen, cleanup re-halts first (`revertForkReopen`) and only
then cancels the authorization and prunes the child, so an interrupted cleanup
leaves an inert orphan under a halted campaign, never an open campaign with
nothing to run.

**5. Convergence does not re-halt the reopened campaign before its child
runs; budget carries on.** The reopen resets `iterations_without_kb_entry` to
0 — the operator's fork is the new direction the stall heuristic said was
missing, and leaving the counter at `convergence_iterations` would make the
loop's first halt check re-halt `converged` before selecting anything. Nothing
else is reset: the campaign clock (`max_seconds`), `iterations_completed` and
the native campaign spend continue from where the halted campaign left them.
When the child is the only pending node it is dispatched directly; with other
pending nodes (a `converged` halt may leave some) selection is ordinary UCT
and the reopen grants a full convergence window.

**6. Restart reconciliation (ADR-043).** At startup — and when a deferred
audit replay completes — `reconcileForkReopens` finds any campaign whose
latest reopen is unreverted, that is still open, and that has no pending,
expanding, interrupted or awaiting-review node, and reverts it, recording the
`reverted` phase with a restart-reconciliation reason and restoring the
overridden halt. A reopened campaign that still holds its pending child stays
open, and the next run selects it.

**7. Availability tells the truth.** `harness.session.availability` reports
`fork: true` for a halted campaign only when `forkReopenPreview` would reopen
it, and names the halt it would reopen; otherwise `fork: false` with the
refusal detail.

## Consequences

An operator can continue a search that ran out without starting a new
campaign, and every such continuation is visible in the ledger with who did
it and which halt it overrode. Budget and audited manual halts remain final
for their campaign.

A crash after the reopen but before the fork's continuation is admitted
leaves an open campaign whose pending child carries no fork authorization; the
next ordinary `campaign.run` runs it under ordinary admission, as it would a
`tree.branch` child. The fork's session lineage is lost in that window; the
reopen record still names the child, the source session and the operator.

A `converged` reopen with other pending nodes does not guarantee that the
forked child is the next node selected.

## Alternatives / Roads not taken

- **Keep refusing every halted fork (b79a639a).** Leaves the exhausted-search
  case, the one forks exist for, with no path short of a new campaign.
- **Reopen any halt.** Turns a fork into a budget bypass and silently
  overrides an audited manual stop.
- **Reopen without resetting the convergence counter, or setting it to
  `convergence_iterations - 1`.** The former re-halts `converged` before the
  child is selected; the latter re-halts on the first iteration that selects
  any other pending node.
- **Record the reopen as a gate checkpoint or a recovery decision.** Neither
  type carries the actor and the overridden halt as typed fields; a dedicated
  record kind keeps the transition checkable by the ledger validator.
- **Reopen before branching the child.** A crash between the two would leave
  an open campaign with no pending node on every crash, not only the rare
  cleanup window that restart reconciliation covers.

## Obligations

### O1 — Only a no_nodes or converged halt is reopenable

A fork reopens a `no_nodes` or `converged` halt and dispatches its child; a manual or budget halt is refused with nothing created, shown end to end through the real runtime.

<!-- proof: symbol=isForkReopenableHaltReason file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/harness-session-fork-reopen-e2e.test.ts -->

### O2 — The reopen is a typed, validated ledger transition

A `campaign_reopen` record carries the operator actor and the overridden halt, a revert requires its reopen, and a tampered or non-reopenable reason fails ledger verification.

<!-- proof: symbol=validateCampaignReopen file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/campaign-reopen.test.ts -->

### O3 — A refused halted fork carries its ADR-179 remedy

The fork command's conflict carries a typed `gate_refusal`: `budget`/`operator`/`raise_budget` for a budget halt or a reopen that would re-halt, `admission`/`campaign_planner`/`repair_plan_or_config` otherwise.

<!-- proof: symbol=RuntimeCatalogRouter file=packages/arbor-mcp/src/runtime-catalog.ts roundtrip=packages/arbor-mcp/tests/harness-session-fork-reopen-e2e.test.ts -->

### O4 — Availability advertises a fork only for a reopenable halt

`harness.session.availability` reports `fork: true` for a halted campaign only when the fork would reopen it.

<!-- proof: symbol=ArborRuntime file=packages/arbor-mcp/src/runtime.ts roundtrip=packages/arbor-mcp/tests/harness-session-fork-reopen-e2e.test.ts -->

### O5 — Restart never leaves a reopened campaign with nothing to run

After a crash between the reopen and the fork's dispatch, restart keeps a campaign with its pending child open, and restores the overridden halt, with a recorded revert, for one with no runnable node.

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/harness-session-fork-reopen-e2e.test.ts -->
