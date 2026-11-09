# ADR-085: Proposed ADRs Are Flagged From Day Zero, and a Recorded Decision Must Reach the Record's Status

**Status:** Accepted
<!-- proof: symbol=decisionFollowthrough file=scripts/adr-decision-followthrough.mjs roundtrip=scripts/tests/adr-decision-followthrough.test.mjs -->
**Date:** 2026-08-24
**Authoring Revision:** d08ace7d6bde5192100575a7e5fa245ce03aa3d9
**Content ID:** sha256:9c7009a42163e9e0884a121ed4d9d70976ec78de293828d3484dbacc801da0ff

## Context

The repository owes decisions on records at `Status: Proposed`, and it had a
mechanism to surface them — `scripts/decision-queue.mjs`'s `proposedRecords()`,
listed and (past a grace) blocked by `gate:decision-queue`, then resolved
through the `/revoy2-interview` flow. But three properties made that mechanism
feel, and functionally be, absent for proposed ADRs:

1. **It was reactive, not proactive.** A Proposed ADR was invisible for its
   first `DEFAULT_MAX_PROPOSED_AGE_DAYS` (7) days — a silent grace. On day 3, a
   material record like ADR-084 (the tier-enforcement wiring, which gates a core
   safety capability) sat unmentioned, aging toward a threshold with no signal.

2. **Coverage, not acceptance, closed the loop.** The queue was silenced when an
   interview *recorded* a decision about a record (added it to an interview's
   `covered` list). Nothing reconciled that record of a decision against the
   record's actual `Status:`. An ADR could be interviewed, decided "accept", and
   then sit at `Proposed` indefinitely — coverage kept the queue quiet.
   `scripts/adr-status-audit.mjs` states the gap directly: *"acceptance is out of
   this audit's scope."* The system proved an interview was **held**; it never
   proved a decided ADR was **promoted**.

3. **No promotion driver, and a hard block would deadlock.** Promotion
   (`Proposed` → `Accepted`) is a deliberate, separate, hand-authored status
   commit (ADR-059 / ADR-072: authoring ≠ allocation ≠ acceptance). That
   separation is correct — acceptance should be a witnessed human act — but
   nothing bridged "a decision was recorded" to "the status was carried
   through". Simply making an un-interviewed Proposed ADR *block* the queue is
   not an option: the record can only be cleared by an operator interview, which
   no agent may write (the ledger is operator-only), so a proposed ADR awaiting
   the operator — or a freshly authored one — would make every push fail.

## Decision

Split the two concerns — *surfacing* a proposed ADR and *enforcing follow-through
on a decided one* — and give each the right mechanism.

1. **Nullify the silent grace for proposed ADRs; flag them from day zero.** In
   `decision-queue.mjs`, a `proposed_record` no longer ages on
   `maxProposedAgeDays`; it is routed to a new `flagged_proposed` bucket that is
   **listed but never part of `blocking`**. (Operator-decision aging is
   unchanged — the grace variable still governs it.) The proactive forcing
   function is a new **`SessionStart` hook**, scripts/hooks/adr-proposed-flag.sh,
   wired in `.claude/settings.json`: every session it lists every `Proposed`
   ADR, interview-style, prompting a definitive greenlight (accept) or redlight
   (reject/supersede) via `/revoy2-interview`. It is silent when there are none.

2. **Coverage no longer clears a decided-but-Proposed record.** A new blocking
   gate, **`gate:adr-decision-followthrough`**
   (`scripts/adr-decision-followthrough.mjs`), reconciles the interview ledger
   against record status: every ADR a standing interview *covers* (via
   `coverageIndex`, which already expires stale deferrals) that is **not**
   currently deferred into the future must have reached a **terminal** status —
   `Accepted`, `Rejected`, `Superseded`, or `Retired`. Direction is irrelevant;
   a recorded decision never carried through to the record's `Status:` is the
   defect. The gate never fires on the mere *authoring* of a Proposed ADR — only
   on a *decided* one — so it cannot deadlock the pipeline.

Together: authoring is free, un-interviewed proposed ADRs are flagged every
session (nudge, never block), a deferral is a first-class dated "not yet", and a
recorded decision becomes an obligation to promote or reject that the build
enforces.

## Consequences

- The "decided but never promoted" state is now machine-caught, closing the
  gap `adr-status-audit.mjs` names. `gate:adr-decision-followthrough` is
  registered `cost_class: stop` (stop / prepush / ci), so a decided-but-Proposed
  ADR blocks a push until its status is carried through.
- Proposed ADRs gain day-0 visibility at the cost of one more `SessionStart`
  line when any exist; the hook is silent otherwise, so a clean queue adds
  nothing. This trades the old silent grace for a standing, honest nudge.
- `gate:decision-queue` no longer blocks on an un-interviewed proposed ADR. This
  is deliberate and is why the follow-through gate exists: the block moved from
  "aged, un-interviewed" (which deadlocks, since the agent cannot interview) to
  "decided, not carried through" (which is always the operator's own to clear).
- An expired deferral does not become a follow-through violation; `coverageIndex`
  un-covers it, and it returns to the flagged/hook surface as awaiting a fresh
  interview — the honest state.

## Obligations

### O1 — A Proposed ADR is flagged from day zero and never blocks by itself

<!-- proof: symbol=proposedRecords file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

`proposedRecords` routes every `Status: Proposed` record into the
`flagged_proposed` bucket with no age grace, and that bucket is excluded from
`blocking` — the queue surfaces it every session without deadlocking a push on
a record only the operator can clear.

### O2 — A recorded decision that never reached the record's status blocks

<!-- proof: symbol=decisionFollowthrough file=scripts/adr-decision-followthrough.mjs roundtrip=scripts/tests/adr-decision-followthrough.test.mjs -->

Every ADR a standing interview covers, and that is not deferred into the
future, must sit at a terminal status; a decided-but-Proposed record fails
`gate:adr-decision-followthrough` at stop/prepush/ci tiers.

## Alternatives considered

- **Hard-block every un-interviewed proposed ADR (grace = 0, still blocking).**
  Rejected: deadlocks the pipeline on any Proposed record the operator has not
  yet interviewed, including this ADR itself, with no agent-available escape.
- **Auto-promote on a recorded "accept" outcome.** Rejected: acceptance is a
  witnessed human act (ADR-059/072); auto-promotion from a free-text interview
  outcome would fabricate exactly the human decision the ledger exists to prove.
- **Parse the interview outcome text for accept/reject.** Rejected as brittle;
  the follow-through gate needs only "a decision was recorded" (coverage) and
  "the record is terminal" (status), neither of which requires reading direction.

proof: symbol=decisionFollowthrough file=scripts/adr-decision-followthrough.mjs roundtrip=scripts/tests/adr-decision-followthrough.test.mjs
