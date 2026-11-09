# ADR-129: Age Alone Does Not Block; A Decided Record Does

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 996e74254711b5910fb7c71cf8ff66fd672404cd
**Content ID:** sha256:6622c6db53a7f5124721da4e389549b43639faa4ebf293ee010634f44c4763c1

## Context

ADR-081 ("A Decision That Is Owed Is Asked On A Schedule") carries an
obligation O4, "A record cannot sit at Proposed indefinitely", whose text
states:

> Past the maximum age with no interview covering it, the gate fails. A record
> that has not taken effect is not neutral: anything depending on it is
> unratified.

That is no longer how the repository behaves, and has not been since ADR-085
("Proposed ADRs Are Flagged From Day Zero, and a Recorded Decision Must Reach
the Record's Status"). ADR-085 nullified the age grace in the other direction —
a Proposed record is flagged from day zero rather than after a maturity window —
and in doing so it moved the *blocking* teeth off age entirely.

`deriveDecisionQueue` now routes an over-age Proposed record into
`flagged_proposed`, which is visible and non-blocking, and explicitly not into
`over_age`. `scripts/tests/decision-queue.test.mjs` pins this directly: for a
Proposed ADR past `maxProposedAgeDays` it asserts `report.ok === true`, with the
comment "A proposed ADR alone never fails the queue now — the SessionStart hook
is the proactive nudge and `gate:adr-decision-followthrough` carries the teeth."

So the enforced boundary is no longer *age without an interview*; it is *a
recorded decision that never reached the record's status*. Those are different
failures. Age measures neglect. Follow-through measures a broken promise — an
operator said "accept" and the record still reads Proposed. ADR-085 judged the
second worth blocking on and the first worth surfacing, which is the more
defensible line: a record nobody has needed yet is not the same defect as a
decision that was made and then dropped.

The claim was found by an audit agent re-checking obligations whose stated
reasons had gone stale. It escalated rather than rewriting, because correcting
an accepted ADR's own claim is an operator decision. The operator chose
supersession over in-place amendment, consistent with this repository's rule
that an accepted ADR is effectively immutable and a changed decision gets a new
record.

## Decision

**1. ADR-081 O4's claim is superseded, not amended.** ADR-081 remains Accepted
and its text stands as the historical record of what was decided at the time.
This ADR is the record that its O4 no longer describes current behaviour.

**2. The enforced boundary is follow-through, not age.** A Proposed record is
surfaced — by `flagged_proposed`, by the SessionStart hook, and by the decision
queue — from the day it is written. It does not block. What blocks is
`gate:adr-decision-followthrough`: an interview that recorded a decision, where
the record's `Status:` never moved to match. Age is a prompt; a broken
follow-through is a defect.

**3. O4 is discharged by supersession, and says so.** Its obligation text gains
a single line naming this ADR as the record that supersedes its claim, so a
reader arriving at ADR-081 is not misled. The obligation is not deleted and its
history is not rewritten — the claim was true when written.

**4. Nothing in the queue's behaviour changes.** This ADR records reality; it
does not alter `deriveDecisionQueue`, `gate:adr-decision-followthrough`, or any
threshold. If a future decision wants age to block again, that is a further ADR,
and it should argue why neglect deserves the same treatment as a broken promise.

## Consequences

ADR-081 stops asserting something the code contradicts, which matters more than
it sounds: an obligation is a durable claim, and a false one that sits green
teaches its reader that green means nothing. A reader who trusted O4 would have
believed an unattended Proposed record eventually fails the build. It does not,
and they would have found that out at the worst possible moment.

The corpus gains a second supersession record, and supersession chains cost
something to follow — a reader of ADR-081 must now also read this one. That is
the accepted price of immutability, and the discharge line in O4 makes the hop
explicit rather than leaving it to be discovered.

Nothing becomes more strict. A record can still sit at Proposed indefinitely
without failing a gate, exactly as today. Anyone who considers that wrong now
has a clean place to argue it, with the tradeoff already stated.

## Alternatives / Roads not taken

**Amend O4's text in place.** Rejected by the operator, and correctly: this
repository's own rule is that an accepted ADR is effectively immutable and a
changed decision gets a new record. Editing an accepted obligation to match
current behaviour would erase the evidence that the behaviour ever changed, and
would set the precedent that a stale claim can be quietly rewritten rather than
superseded — which is precisely the failure mode the immutability rule exists to
prevent.

**Record the consequence on ADR-085 instead.** Rejected as the primary vehicle:
ADR-085 is Accepted, so appending a new discharge claim to it has the same
immutability problem in miniature. A cross-reference from this ADR to ADR-085 is
enough, and it points the right direction — the reader wants to know what
superseded O4, not to discover it while reading about something else.

**Leave it and re-interview later.** Rejected: the claim is known-false now. A
dated deferral would put a false obligation back in the queue rather than
resolving it, and the queue's job is to surface what is owed, not to hold what
is already answered.

**Restore age-based blocking so O4 becomes true again.** Rejected. It would make
the ADR accurate by making the system worse: a record nobody has needed yet
would fail the build, which trains its reader to bypass the gate. ADR-085's line
— surface neglect, block a broken promise — is the better one, and this ADR
should not undo it merely to rescue a sentence.

## Obligations

### O1 — ADR-081 O4 carries a discharge line naming this record

A reader arriving at ADR-081 O4 must be able to see, without leaving the file,
that its claim is superseded and by which ADR.

<!-- unverifiable: an ADR cross-reference is a documentation-integrity property of the corpus, not a behaviour any exported symbol can witness; gate:adr-retirement-integrity checks retirement wiring rather than the text of a discharge note -->

### O2 — The queue still does not fail on a Proposed record's age alone

`deriveDecisionQueue` must continue to route an over-age Proposed record to
`flagged_proposed` and return `ok`, so this ADR describes behaviour that is
actually true rather than behaviour it wishes for.

<!-- proof: symbol=deriveDecisionQueue file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

### O3 — Follow-through remains the enforced boundary

A decision recorded in an interview whose record's `Status:` never moved must
still fail, so that superseding O4's age claim does not quietly remove the teeth
that replaced it.

<!-- proof: symbol=decisionFollowthrough file=scripts/adr-decision-followthrough.mjs roundtrip=scripts/tests/adr-decision-followthrough.test.mjs -->
