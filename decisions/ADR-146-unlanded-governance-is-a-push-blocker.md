# ADR-146: A Claimed Number And An Unlanded Record Are Debts The Claimant Must Discharge

**Status:** Superseded
**Date:** 2026-08-27
**Authoring Revision:** acee003d
**Content ID:** sha256:f9adfb1e12454ad8353373a266622129cc03dfa3af855559e757212395ecb803

**Superseded by ADR-153.** ADR-153 replaces this record's unimplemented
content-specific debt gate with the narrower branch-accounting and shared-
reservation controls that are actually built.

## Context

On 2026-08-27 a routine worktree sweep found three **Accepted** decision
records that existed only on branches nothing had merged: ADR-096 (campaign
semantic identity), ADR-097 (durable authority transitions), and a record that
had claimed ADR-095. They had been sitting there since 2026-08-25.

Two distinct failures produced that, and neither was visible to any gate.

**A partial landing.** The same worktree line of work produced an audit and the
decisions that audit concluded. Earlier the same day, its *documents* were
merged into master. Its *decisions* were not. The repository therefore held an
audit whose conclusions were absent — a state that reads as complete to every
reader and every gate, because what is missing is precisely what nobody can
see. Nothing noticed, because every gate examines the tree it is run in, and
these records were in a different one.

**A number claimed twice.** `decisions/registry.json` on master mapped 95 to
"A Search Claim Is Evidenced By Live-Model Evaluation" (allocated 2026-08-26).
The branch's registry mapped 95 to "Semantic Authority Requires Current
Applicability and Retained History" (allocated 2026-08-25). Both allocations
were legitimate acts by their allocator. The registry is a shared ledger, but
allocation happens in a worktree, and a worktree's copy of the ledger cannot
see a sibling's. The earlier claim lost, because the later one had already
accrued live citations.

The deeper problem is accountability. An agent that runs `adr-registry.mjs
allocate` takes a number out of a shared, contiguous sequence — a durable,
repository-wide act — and then may simply stop: end its session, abandon its
branch, leave. The number stays claimed. Nothing asks the claimant what became
of it. Every existing governance mechanism here keys on records that are
present: `gate:decision-queue` reads `decisions/`, `gate:adr-registry` verifies
allocations against files it can see, `gate:obligations` walks accepted
records. All of them are blind to a record that was claimed and never landed,
which is the one case where the claim itself is the only evidence.

This is the same shape this repository has now hit repeatedly: a capability, a
parameter, an event hook, a union member that exists and is never reached. Here
the unreached thing is a governance record, and the boundary it fell through is
a worktree.

## Decision

**A claimed number and an unlanded governance record are debts, attributed to
their claimant, and the push that would leave them outstanding is refused
unless the debt is explicitly deferred.**

1. **Allocation writes a claim receipt.** `adr-registry.mjs allocate` records,
   alongside the allocation, the claiming session: the branch, the worktree
   path, the commit at claim time, and an operator-supplied or
   environment-derived actor id. A number leaves the shared sequence with a
   name attached to it.

2. **`gate:governance-debt` runs at prepush and enumerates two debts.**
   *Unlanded records*: a decision record present on any local branch and absent
   from the push target. *Dangling claims*: an allocation in `registry.json`
   with no corresponding record in the push target.

3. **The gate blocks, and deferral is a first-class answer.** A debt is
   discharged by landing the record, by releasing the claim, or by an explicit
   dated deferral in `scripts/branch-accounting/dispositions.json` with a
   reason — the mechanism that already exists for unaccounted branches. A
   deferral is a decision, so it enters `gate:decision-queue` and returns on
   its expiry. What the gate forbids is not deferral; it is *silence*.

4. **The claimant is told, in-session, what it still owes.** A session that
   allocates a number carries that claim in its own working state, and the
   stop-tier battery reports outstanding claims made by this session before it
   can report green. An agent that claimed ADR-095 and wandered off should
   have been told, by its own gates, that it had.

5. **A collision is a hard error, not a lost race.** Allocation consults every
   local worktree's registry, not only the current tree's, and refuses a number
   another worktree has already claimed. Resolving a collision after the fact
   costs a renumbering and rewrites a record's identity; refusing it up front
   costs one retry.

## Consequences

The failure that motivated this becomes impossible to reach silently. A branch
holding an Accepted record cannot be left indefinitely without either landing
it or saying, on the record and with a date, that it is being left.

Push gets slower and occasionally more annoying, which is the intended trade.
This gate exists to make a specific kind of silence expensive.

Deferral being first-class matters more than the blocking. A gate whose only
answer is "land it now" gets bypassed, and a bypassed gate is worse than none —
this repository already has the `ARBOR_SKIP_DECISION_GATE` escape hatch and
knows what it costs. An explicit dated deferral keeps the debt visible and
keeps the operator in the loop without stopping work.

The claim receipt introduces attribution, which this repository has otherwise
avoided. It is deliberately narrow: it records which session took a number from
a shared sequence, not who wrote what. Without it the gate can report that a
number is dangling but not who should answer for it, and an unattributed debt
tends to become everyone's and therefore nobody's.

Cross-worktree allocation cannot be made fully race-free without a lock the
repository does not have. Decision 5 closes the common case — a sibling
worktree that already holds a claim — and does not close two allocations racing
within the same instant. That residue is disclosed rather than papered over.

## Alternatives / Roads not taken

**Extend `gate:branch-accounting`.** It already enumerates unmerged branches
and already supports dated dispositions, which is why Decision 3 reuses its
store. But it answers "is this branch accounted for?", and the failure here was
a branch that WAS accounted for — contained, merged-clean by its own reckoning
— while the governance records on it were not. Same store, different question.

**Forbid allocation outside the primary checkout.** Would prevent the collision
outright, and would also break the worktree-per-concern model this repository
depends on, including the concurrent agents that produced the work being
governed. Rejected as a cure that removes the patient.

**Make allocation lazy — number a record only when it lands.** Attractive, and
wrong for this corpus: records cite each other by number while still in draft,
and `gate:adr-citations` resolves those citations. Deferring the number would
make a draft uncitable and push the collision into the merge instead of the
allocation.

**Warn instead of block.** Rejected on this repository's own evidence: the
audit-documents-without-decisions state persisted for two days in plain view of
a green battery. A warning is what a green battery already was.

## Obligations

### O1 — A decision record on a local branch and absent from the push target blocks the push.

`gate:governance-debt` enumerates records present on any local branch and
missing from the push target, and exits non-zero unless each is discharged or
carries a dated deferral — so an audit's conclusions cannot stay behind while
its documents land.

<!--
proof: symbol= file= roundtrip=
-->

### O2 — An allocated number with no landed record is attributed and reported.

Every allocation carries a claim receipt naming the claiming branch, worktree
and commit, and the gate reports any allocation with no corresponding record in
the push target against that claimant — so a number taken from the shared
sequence has someone to answer for it.

<!--
proof: symbol= file= roundtrip=
-->

### O3 — Deferral is available, dated, and returns.

A debt may be deferred through `scripts/branch-accounting/dispositions.json`
with a reason and an expiry, which satisfies the gate and enters
`gate:decision-queue`, so the deferral itself is a decision that comes back
rather than a permanent exemption.

<!--
proof: symbol= file= roundtrip=
-->
