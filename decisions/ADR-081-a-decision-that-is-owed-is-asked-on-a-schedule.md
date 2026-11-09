# ADR-081: A Decision That Is Owed Is Asked On A Schedule

**Status:** Accepted
**Date:** 2026-08-18
**Authoring Revision:** 614c041b0b425832b573b589a19ff5de6acd1968
**Content ID:** sha256:7eacab12b578cec9f8e3fbf0db88725cdff1c86c2522d25551d04d95e5c7778a

## Context

This repository dates its exemptions. Every waiver store carries an expiry, the
visual-intelligence triage gate refuses an undated `accepted_tradeoff`, and the
reachability allowlist states the principle outright: a decision with a shelf
life, not a permanent exemption. That discipline is real and it works.

What it does not do is put the deadline in front of anyone.

An audit on 2026-08-18 found eight records sitting at `Status: Proposed`, one of
them for eleven days; four of six operator decisions untouched since the day they
were written; and roughly 120 dated commitments spread across five stores in five
formats, with no single place that showed them together. **Nothing had lapsed.**
That is the point worth being precise about — this record is not written in
response to a broken promise. It is written because nothing in the repository
would have said so if one had broken, until some unrelated gate went red weeks
later for a reason nobody would connect to a promise made in August.

A deadline nobody is scheduled to look at is a reminder with no recipient.

Two shapes make it worse. The first is that the stores disagree about what a
commitment even looks like: three share the waiver primitive, two are JSONL
triage stores with their own schemas, and one is prose. Reading them all is a
research task, so it does not happen. The second is subtler and was found only by
measurement: `.visual-intelligence/findings/triage.jsonl` had 122 rows against 61
live findings — **exactly 50% orphaned**, because finding ids are content-addressed
and rotate whenever a finding's node set shifts. Anyone counting that file
directly would have overstated live exposure by about 2x, and a queue that cries
wolf is one nobody reads.

## Decision

The queue is derived, and being on it forces an interview.

`scripts/decision-queue.mjs` reads the five stores that already own the data and
never declares its own: Proposed records in `decisions/`, the three waiver stores
through `scripts/lib/waiver-store.mjs`, visual-intelligence triage,
completion-depth triage, and `docs/proposals/operator-decisions-*.md`. It
cross-checks every triage row against its findings store, so an orphaned row is
reported as an orphan and never counted as a commitment.

It blocks on four conditions:

1. **Lapsed** — a promise already broken.
2. **Due inside the horizon** (default 14 days) with no interview covering it.
3. **Proposed past a maximum age** (default 21 days) with no interview covering it.
   A record that has not taken effect is not neutral; anything depending on it is
   unratified, and indefinite Proposed is how that goes unnoticed.
4. **A dated commitment resting on an undated one** — the hazard that motivated
   the check. ADR-041 is the live instance: reachability entries expiring
   2026-09-08 justify themselves by citing a record that is itself indefinitely
   Proposed. Honoring the waiver's deadline depends on a decision that has none.
   Hazards group by the undated record, because one record cited by nine waivers
   is one decision, not nine.

The interview is recorded in `decisions/interviews.jsonl` — committed, because
`.arbor/` is gitignored and a ledger nobody else can see cannot discharge a
shared obligation. A record names the items covered and the operator's outcome
for each. **A deferral carries its own date**, and when that date passes the item
returns to the queue; without that, one interview would silence an item forever,
which is this same backlog wearing a hat.

**SUPERSEDED BY ADR-082 — the advisory clause below is retired (2026-08-19).**
`decisions/ADR-082-an-operator-call-blocks-the-stop-it-accrued-behind.md`
supersedes only this record's scheduling decision. The reasoning in the next
paragraph — that an agent cannot hold an interview mid-task — was falsified the
same day by this record's own first interview, which the agent ran by asking the
operator through the question surface. The exemption let operator-call items
accrue behind a warning nobody had to act on, so `gate:decision-queue` now
vetoes the Stop battery. Everything else in this record stands.

Scheduling and authority are set separately, as ADR-074 requires. The gate is
registered at the `stop` tier so it runs constantly, and listed in `HOOK_ADVISORY`
so it **warns** rather than vetoes at Stop — an agent cannot hold an interview
with itself mid-task, and failing the Stop battery on it would wedge every
session over a decision only the operator can make. It **blocks** at pre-push and
in `check`, where the operator is present and a push is the moment work is
claimed as done.

## Consequences

**What this proves.** That an interview was **recorded** covering each item that
is due. That is the same strength claim, and the same ceiling, as
`gate:vi-findings`' recorded-verdict requirement.

**What it does not prove.** That a human answered, or answered thoughtfully. The
ledger is bytes and bytes can be written by anyone, including the agent the gate
is meant to constrain. This is stated in the module header, in the gate's own
failure output, and in the `revoy2-interview` skill, because a gate that
overclaims its strength is the defect this repository treats as worse than having
no gate. The human-in-the-loop guarantee lives in the skill, which asks through
the operator-facing question surface rather than deciding on the operator's
behalf. **The honest summary is that this mechanism makes the backlog impossible
to overlook and makes faking a decision an explicit act rather than an accident.**

**Easier.** The five stores have one view. A commitment cannot be forgotten by
being in an unfamiliar format. New commitments cost nothing to enrol — they are
derived from the store, so nothing needs registering twice.

**Harder, deliberately.** Pushing while decisions are owed. That is the intended
friction and the reason the gate is not merely a report.

**A load-bearing default.** The horizon and maximum-Proposed-age are policy, not
physics. Set too tight they generate interview fatigue and the mechanism gets
widened until it means nothing; too loose and a lapse lands before anyone is
asked. They start at 14 and 21 days and are expected to move once there is real
experience of how often the interview actually fires.

**Not decided here.** Whether acceptance authority itself should be mechanically
distinguishable from authorship. Today an agent and the operator share one git
identity, so `scripts/lib/adr-acceptance.mjs` can enforce the *form* of acceptance
(status-only, separate commit) but not *who* performed it. This record makes the
consequence of that gap visible on a schedule rather than closing it.

## Obligations

### O1 — A lapsed commitment blocks

<!-- proof: symbol=deriveDecisionQueue file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

An expiry already in the past fails the gate. If this does not hold, the whole
mechanism is decorative.

### O2 — An interview covers an item, and a deferral inside it expires

<!-- proof: symbol=coverageIndex file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

Recording an interview that names an item clears it; a deferral carries its own
date, and once that date passes the item returns to the queue. Without the
second half, one interview would silence an item forever — the same backlog,
relocated.

### O3 — Orphaned triage rows are never counted as commitments

<!-- proof: symbol=visualIntelligenceCommitments file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

Only triage rows whose finding still exists enter the queue. Measured at 61
orphans against 61 live findings on the day this was written; counting them
would overstate live exposure ~2x, and a queue that cries wolf is one nobody
reads.

### O4 — A record cannot sit at Proposed indefinitely

<!-- unverifiable: scripts/decision-queue.mjs is a repository script, not an export under packages/*/src, so `symbol=` cannot resolve against it — the same reason ADR-008 and ADR-035 give for their own obligations. Exercised by scripts/tests/decision-queue.test.mjs. -->

Past the maximum age with no interview covering it, the gate fails. A record
that has not taken effect is not neutral: anything depending on it is
unratified.

**Superseded by ADR-129 (2026-08-26).** This claim no longer describes the
system. ADR-085 moved the enforced boundary off age entirely: an over-age
Proposed record is routed to `flagged_proposed`, which is visible and
non-blocking, and `deriveDecisionQueue` returns `ok` for exactly that case.
What blocks is `gate:adr-decision-followthrough` — a decision an interview
recorded, whose record's `Status:` never moved to match. The claim above was
true when written and is retained as the historical record; ADR-129 is the
decision that supersedes it.

*No proof comment: `scripts/decision-queue.mjs` is a repository script, not an
export under `packages/*/src`, so `symbol=` cannot resolve against it — the same
reason ADR-008 and ADR-035 give for their own obligations. Its behavior is
covered by `scripts/tests/decision-queue.test.mjs`, whose teeth are the deferral
expiry and the orphan exclusion, not merely the happy path.*
