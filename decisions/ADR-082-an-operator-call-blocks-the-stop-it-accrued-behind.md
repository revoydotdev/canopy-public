# ADR-082: An Operator Call Blocks The Stop It Accrued Behind

**Status:** Accepted
**Date:** 2026-08-19
**Authoring Revision:** a793195f569c69c6e9985aa7bcbbbc6d00cf240d
**Content ID:** sha256:2b3becf3260fc2d5504157c54a4930600d5d099124e4cd0d1dfaa4939bd290b3

**Scope.** This record supersedes only ADR-081's scheduling clause — the
decision to list `gate:decision-queue` in `HOOK_ADVISORY`. Everything else in
ADR-081 stands: the derived queue, the interview ledger, the deferral-with-a-date
mechanic, and the honest statement of what the gate can and cannot prove.

## Context

ADR-081 built a queue that makes owed decisions impossible to overlook, then
made it advisory at Stop on this reasoning:

> an agent cannot hold an interview with itself mid-task, so failing the Stop
> battery on it would wedge every session over a decision only the operator can
> make

**That reasoning is wrong, and it was falsified within the hour by the record
that stated it.** The agent does not interview itself. It asks the *operator*,
through the multiple-choice question surface, and that is exactly how the first
interview under ADR-081 was run — seven items decided, three records accepted,
three rejected, one waiver answered with scheduled work. The operator was
present the whole time. Nothing was wedged.

So the exemption bought nothing and cost something specific. A whole class of
item was left free to accrue behind a warning nobody had to act on: decisions
only a human can make, carrying no deadline, which every gate run faithfully
reported and no mechanism ever forced. The live instance at the time this was
written: **63 orphaned visual-intelligence triage rows**, reported on every
single gate run for weeks, disposable only by a human, and never once asked
about. `gate:vi-findings` printed them. Nothing required an answer. The
disposition of "the gate reports it, deleting is your call" is precisely how a
backlog forms when nobody is scheduled to make the call.

A second instance was found the same day and is the same shape: eleven snapshot
worktrees left by interrupted test runs. `gate:worktree-hygiene` passes on them
by design — its two detectors cover pruneable registrations and dead-PID locks,
and these are neither — so nothing looked at them at all.

## Decision

**Operator calls enter the queue, and the queue vetoes the Stop.**

Two changes, and they only work together:

1. **A new item class, `operator_call`.** Decisions only a human can make, with
   no deadline attached. They are due **immediately** and stay due until an
   interview records a disposition. They are always **grouped**: 63 orphaned
   rows are one decision — prune or retain — not 63. A queue that asked 63
   times would be answered once, carelessly.

2. **`gate:decision-queue` is removed from `HOOK_ADVISORY`.** It vetoes the Stop
   battery like any other stop-tier gate.

The pressure valve is the deferral that ADR-081 already built: an interview may
postpone an item, but the postponement carries its own date, and when that date
passes the item returns. A decision may be delayed; it may not be dropped.

## Consequences

**What this actually guarantees, stated precisely.** Claude Code sets
`stop_hook_active` when it re-enters Stop after a hook has already blocked, and
gate-stop.sh honors it — mandatory loop safety, without which a genuinely
unresolvable gate would wedge a session in a permanent block/retry cycle. So the
real guarantee is **one forced surfacing per turn boundary**, every turn, until
the queue is answered — plus a hard, unescapable block at pre-push, where
`stop_hook_active` does not apply.

That is deliberately not the same as "impossible to end a session", and saying
otherwise would be the overclaim this repository treats as worse than no
mechanism. What it does make impossible is *silent* accrual: an operator call
cannot sit unreported behind a warning, and it cannot be outwaited, because it
has no expiry to run out.

**Easier.** A class of decision that had no owner now has a schedule. The
question is asked while the context that produced it is still in the room,
rather than being rediscovered by an audit weeks later.

**Harder, deliberately.** Ending a turn with decisions owed. That is the whole
point, and it is the cost the operator asked for explicitly.

**A real risk, named.** Interview fatigue is the failure mode that would kill
this: an operator call firing every run trains its reader to answer carelessly,
which is worse than not asking. Two mitigations are built in — grouping, so a
class is one question; and the dated deferral, so a considered "not now" is a
first-class answer rather than something the mechanism punishes. The stranded-
worktree probe additionally ignores anything under two hours old, so a live
ADR-078 fixture is never mistaken for debris. That two-hour figure is a
heuristic and is labelled as one in the source.

**Not decided here.** Which further operator calls to enrol. Three were
considered and only two enrolled: triage orphans and stranded worktrees.
Deletable branches were left out because `branch-accounting` currently reports
none, and enrolling a class with no live instance would be speculative.

## Obligations

### O1 — An operator call has no expiry and cannot be outwaited

<!-- proof: symbol=deriveDecisionQueue file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

The same repository state must fail the queue on the day it appears and still
fail it years later. Asserted directly against a far-future date.

### O2 — A class is one question, not one per instance

<!-- proof: symbol=operatorCalls file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

Multiple orphaned rows produce exactly one queue item carrying a count.

### O3 — An interview clears it, and a dated deferral re-raises it

<!-- proof: symbol=coverageIndex file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

Recording a disposition clears the item; a deferral with a date clears it only
until that date passes.

### O4 — It never fires on a repository with nothing to dispose of

<!-- proof: symbol=operatorCalls file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

A clean repository produces no operator call. An item that fires on a healthy
tree is the fastest possible route to being ignored.

### O5 — The gate vetoes the Stop battery

<!-- unverifiable: the veto is a roster fact in scripts/gate-all.mjs's HOOK_ADVISORY, not a symbol under packages/*/src. Exercised by scripts/tests/procedure-tables-freshness.test.mjs, which asserts the extracted advisory set. -->

`gate:decision-queue` is absent from `HOOK_ADVISORY`, so a red queue fails
`gate:all --tier stop --advisory hook-default` — the exact invocation
gate-stop.sh makes.
