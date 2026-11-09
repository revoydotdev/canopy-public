# ADR-137: An Interview Answer Queues Its Own Discharge

**Status:** Accepted
**Date:** 2026-08-27
**Authoring Revision:** 2b780356df3a94ddb2919eaf2e3d9783641d5dbb
**Content ID:** sha256:38b29f834682663c7aaa4f2f7f7962fa0384a3fc6d78f1e958b068a38251ef1a

## Context

An interview records a decision. Carrying it out is a separate act, performed by
an agent, and therefore forgettable.

This is not hypothetical. On 2026-08-26 the operator answered "re-attest with
the same verdicts" for seven reopened visual-intelligence findings. The answer
was recorded verbatim in `decisions/interviews.jsonl`, `gate:decision-queue`
went green, and the actual `vi-findings.mjs --triage` writes were never made.
`gate:vi-findings` stayed red, and the agent reported the interview complete.
Nothing lied — the ledger accurately recorded what the operator said. The gap
was between the decision and its consequence.

The repository already has exactly one mechanism for this, and its narrowness is
the tell: `gate:adr-decision-followthrough` blocks when an interview recorded an
accept and the record's `Status:` never moved. That is one hardcoded pair — one
item kind, one consequence, one check. Every other decision this corpus can
record has no equivalent. A waiver answered "renew" is renewed only if someone
remembers. A `vi_triage` answered "re-attest" is re-attested only if someone
remembers. An `operator_call` answered "dispose" is disposed of only if someone
remembers — and on 2026-08-26 one such disposal ran, reported success, and
changed nothing, which was only caught because the outcome was checked.

The shape is familiar from ADR-127: a governance side effect that an actor is
trusted to perform is a governance side effect that will eventually be skipped.
ADR-127 established the principle for derived evidence. This applies it to the
one place the repository still depends on memory — the gap between an operator
saying what should happen and it having happened.

There is a second, subtler failure the current design permits. An interview can
record an answer whose consequence nobody ever specified. "Investigate first" is
a real answer with real follow-on work, but the ledger stores it as prose and no
mechanism knows a task is now owed. The backlog re-forms in a place the
decision queue cannot see, because the queue derives from commitment stores and
this commitment was never written to one.

## Decision

**1. An interview question may declare, per answer, a machine-checkable
discharge.** The declaration lives with the question, not with the answer:
whoever asks states what each option implies. Concretely, an option carries an
optional `discharge` naming (a) a predicate over repository state that must
become true, and (b) the mechanism that makes it true. For a `vi_triage`
answered "re-attest", the predicate is "the triage store holds a row for this
finding whose expiry is later than the interview date" and the mechanism is
`vi-findings.mjs --triage`.

**2. Recording the answer writes the discharge to a commitment store.** Not to
prose. The obligation becomes a first-class row the decision queue already knows
how to read, with an id, a due date, and the naming of what would satisfy it.
This is the load-bearing move: it converts "the agent should now do X" from
something remembered into something derived.

**3. An undischarged obligation blocks, on the same boundary everything else
blocks on.** Per ADR-128 the push is the inviolable line. A discharge obligation
past its due date fails there. The agent cannot report the interview complete
and move on, because the push refuses — which is the "unavoidable" the operator
asked for, implemented as a refusal rather than as a reminder.

**4. An answer with no checkable consequence declares that explicitly.** "Leave
it red until later" and "keep Proposed with a review date" genuinely imply no
immediate work. Those options carry `discharge: null` — a deliberate, visible
declaration, not an omission. An option that silently omits the field is a
question-authoring defect the interview tooling should reject, because a missing
declaration and a declared absence must not look alike.

**5. The gate proves an action occurred, never that it was correct.** A
discharge predicate can be satisfied by an agent writing the artifact without
doing the thinking — writing a triage row without re-examining the finding.
This ADR does not close that hole and must not claim to. It closes the strictly
smaller and still-worth-closing hole of the artifact never being written at all.
The honest strength claim is the same one `gate:decision-queue` already makes
about itself, and stating it here prevents the next reader from over-trusting
the mechanism.

## Consequences

The gap between deciding and doing stops being invisible. The specific failure
that motivated this ADR — seven answers recorded, zero carried out, interview
reported complete — becomes impossible to reach: the push refuses until the
triage rows exist.

Question authoring gets heavier. Every option must now be written with its
consequence in mind, and the person asking must know what would satisfy it.
That is real friction at the moment of asking, in exchange for a guarantee at
the moment of forgetting. It also has a good side effect: an option whose
discharge cannot be articulated is usually an option that was too vague to
answer well.

The discharge predicate is a new place to be wrong. A predicate that is too
loose passes without the work being done; one that is too tight blocks work that
was done correctly by another route. Both failures are worse than the status quo
in their local case, and the mitigation is that predicates are declared, visible,
and reviewable rather than implicit.

A partial interview becomes more expensive. Today an agent can answer three of
ten items and leave the rest; under this decision each answered item may add an
obligation that must be discharged before pushing. That is intended — a decision
half-carried-out is the failure being fixed — but a long interview now front-loads
more work before the next push.

## Alternatives / Roads not taken

**Extend `gate:adr-decision-followthrough` to more cases.** Rejected: it would
mean hardcoding another pair for every item kind, which is how the current
one-case mechanism came to be the only one. The generalization is the point.

**Have the interview skill perform the consequence immediately, inline.**
Rejected, and this is the closest alternative. It fails for answers whose work is
substantial ("investigate first", "wire it to a product surface") — the interview
would become the implementation session. It also puts the doing inside the asking,
so a failure mid-interview leaves an ambiguous record of what was decided versus
what was done. Recording the obligation and discharging it separately keeps those
two facts distinct.

**Trust the interview ledger and add nothing.** Rejected on evidence: the ledger
was accurate and the work still did not happen. The defect is not in the record.

**Block at interview time rather than at push.** Rejected: it would prevent the
operator from answering a batch of questions and returning to the work later,
which is the normal and desirable shape. The push is where an undischarged
decision starts affecting anyone else, and ADR-128 already establishes it as the
enforcement boundary.

## Obligations

### O1 — An answered option with a declared discharge produces a queued obligation

Recording an interview answer whose option declares a discharge must write a
commitment row the decision queue reads, not prose.

<!-- unverifiable: no implementation exists yet; this ADR is Proposed and deferred for operator review, so there is no symbol to bind a proof to -->

**Implemented (Decision §1, §2).** `scripts/lib/discharge-catalog.mjs` declares,
per `[item_kind][option]`, either `{ discharge: null }` (Decision §4) or
`{ mechanism, predicate }`, keyed against the option set the `revoy2-interview`
skill already offers (proposed_record: accept/reject/keep Proposed with a
review date/supersede; waiver: renew/act now/delete; vi_triage &
completion_depth: re-attest/fix/change the verdict; operator_decision: do it
now/schedule it/drop it; operator_call: do the disposal now/retain
deliberately/defer). `recordInterviewAnswer`
(`scripts/lib/discharge-store.mjs`) writes the interview record to
`decisions/interviews.jsonl` and, for every answer whose declared option
carries a predicate, a first-class row — `{ id, item_id, item_kind, option,
due, created_at, interview_held_at, mechanism }` — to
`decisions/discharge-obligations.jsonl`, in the same call, so the two cannot
diverge. `scripts/record-interview.mjs` is the real CLI entry point (`bun run
interview:record <payload.json>`), verified end-to-end against a scratch
fixture in this implementation pass.

One residual gap, recorded rather than silently absorbed: the
`revoy2-interview` SKILL.md still documents hand-writing
`decisions/interviews.jsonl` directly rather than calling
`recordInterviewAnswer`/`scripts/record-interview.mjs`. Updating that skill
file was out of scope for the agent that implemented this ADR (a hard
workspace constraint, not a judgment that it is unnecessary); the mechanism
exists and is callable, but nothing yet forces an interview conducted through
the skill to go through it.

<!-- proof: symbol=recordInterviewAnswer file=scripts/lib/discharge-store.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

### O2 — An undischarged obligation past its due date refuses the push

The guarantee is a refusal, not a reminder; a nudge is what this ADR exists to
replace.

<!-- unverifiable: no implementation exists yet; the pre-push boundary it would attach to is ADR-128's, which is itself accepted but not yet built -->

**Implemented (Decision §3).** No new enforcement mechanism was needed.
`dischargeCommitments` (`scripts/lib/discharge-store.mjs`) re-evaluates each
obligation's declared predicate LIVE against repository state — never a
stored "done" flag — and returns an item, shaped exactly like every other
`deriveDecisionQueue` commitment source, for every obligation still
unsatisfied. `deriveDecisionQueue` (`scripts/decision-queue.mjs:510`) folds
`dischargeCommitments(repo)` into its `items` array alongside
`waiverCommitments`/`visualIntelligenceCommitments`/
`completionDepthCommitments`; an item whose `due` date has passed lands in
`lapsed` unconditionally, the same logic every other lapsed commitment
already uses. `gate:decision-queue` is already selected by the prepush
profile (`scripts/execution-profile.json`, `"prepush": true`) per ADR-128's
push boundary, so an undischarged, overdue obligation refuses the push
through the mechanism that already exists — this ADR needed a new
commitment source, not a new gate.

<!-- proof: symbol=dischargeCommitments file=scripts/lib/discharge-store.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

### O3 — An option with no consequence declares `discharge: null` explicitly

A missing declaration and a declared absence must not be indistinguishable, or
the mechanism silently degrades to the status quo for every question whose
author forgot.

<!-- unverifiable: no implementation exists yet; this is a question-authoring validation rule with no current schema to cite -->
