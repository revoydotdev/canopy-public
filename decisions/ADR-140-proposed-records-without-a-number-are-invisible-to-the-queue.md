# ADR-140: A Proposed Record Without A Number Is Invisible To Its Own Gate

**Status:** Accepted
**Date:** 2026-08-27
**Authoring Revision:** becfe7e489148709d3813c9338836d53857b9af3
**Content ID:** sha256:7df523c9fbe42bf28ad0d59c3112bb41b3b6b38040943e6af2e6ed3d24452d40

## Context

`gate:decision-queue` exists because this repository was good at recording
that a decision was owed and bad at being reminded of it. Its own skill
documentation names the 2026-08-18 audit that motivated it: eight records at
Proposed, one for eleven days, and nothing that would have said so.

On 2026-08-27 that gate reported `flagged_proposed: 0` while eight Proposed
records sat in `decisions/`. Every bucket read zero — `lapsed`, `due_soon`,
`over_age`, `hazards`, `operator_calls`. The queue was not stale and was not
misconfigured. It was answering a narrower question than its name implies,
and answering it correctly.

The mechanism is one character class. `proposedRecords`
(`scripts/decision-queue.mjs:177`) enumerates `decisions/` and skips every
entry that does not match `/^ADR-\d+-.+\.md$/`. A record authored by
`adr-registry.mjs new` is written as `ADR-PENDING-<slug>.md` and carries no
number until `allocate` runs. It therefore fails that test, and the queue
never sees it. `recordStatuses` (`scripts/decision-queue.mjs:157`) applies
the identical filter, so the record is absent from the status map the rest
of the report is derived from as well.

Two things compound it.

**The pending file is usually untracked.** `allocateDecision`
(`scripts/lib/adr-registry.mjs`) documents this in its own D2 comment before
staging a deletion: "the pending file is almost never tracked (authoring via
`new` never git-adds it)". So an unallocated Proposed record is typically
invisible to `git status --short` in a busy tree, invisible to reviewers of
the branch, and invisible to the gate — three independent surfaces, all
blind for the same reason.

**The remedy already in the corpus addresses the other half.** `AGENTS.md`
tells an author "Interview coverage keys on the ALLOCATED number, not the
PENDING slug, so allocate before interviewing or record an explicit
rebinding." That is correct and it is advice. It tells a careful author how
not to produce a mismatched ledger entry; it does not make an un-allocated
record visible to the gate that exists to notice un-worked records. A
convention an agent must remember is precisely the class of thing this gate
was built to stop relying on.

The exposure is bounded but real: a record cannot lapse a *dated* commitment
while unallocated, because it has no due date. What it can do is sit at
Proposed indefinitely — the eleven-day case from the founding audit — while
the gate that would have surfaced it reports green.

## Decision

**The queue counts a Proposed record from the moment it exists on disk, not
from the moment it is assigned a number.**

1. `proposedRecords` also enumerates `ADR-PENDING-<slug>.md`. Such a record
   enters the queue with `kind: "proposed_record"` exactly as a numbered one
   does, aged from its `**Date:**` line by the same `daysBetween` call, and
   subject to the same `max_proposed_age_days` flag. Its `id` is its slug —
   `ADR-PENDING-<slug>` — because it has no number to key on and inventing
   one here would collide with the allocator's ledger.

2. `recordStatuses` is left alone. It maps *numbered* records to statuses for
   citation and supersession checks, where a pending slug has no meaning and
   an entry keyed on one would be a false member of that map. This ADR
   widens what the queue notices, not what the status map claims exists.

3. **Allocation rebinding stays an explicit, recorded act.** When a pending
   record is later allocated a number, an interview that covered it under its
   slug does not automatically cover `ADR-NNN`. The existing remedy — the
   verbatim-copy rebinding record, already used in
   `decisions/interviews.jsonl` on 2026-08-26 and again on 2026-08-27 — is
   the mechanism, and this ADR does not replace it with an inference. A
   coverage rule that silently equated a slug with a number would let one
   answer discharge an item the operator was never asked about under the id
   the ledger records.

4. **The gate's report distinguishes the two.** An unallocated Proposed
   record renders with its slug id and a note that it holds no number yet,
   so a reader is told why it has no citation identity rather than left to
   infer that the queue is confused.

## Consequences

The founding failure mode — a record sitting at Proposed while the gate
reports green — closes for the case that produced it today. The gate stops
being conditional on an authoring step the author may not have taken yet.

The queue will get louder, and correctly so: any `ADR-PENDING-*.md` left in
a working tree past `max_proposed_age_days` now flags. This is a real cost
for the drafting workflow — an author who scaffolds a record and thinks for
a week will be told about it. That is the intended behavior, and the escape
hatch is the one that already exists: allocate it, or delete the scaffold.

An untracked pending file is visible to the gate only in the tree it lives
in. This ADR does not fix that; a scaffold in a sibling worktree stays
invisible to a run in this one. The blindness is narrowed from "any
unallocated record anywhere, including the checkout you are standing in" to
"an unallocated record in a checkout nobody runs the gate in", which is the
smaller and more honest exposure.

## Alternatives / Roads not taken

**Require allocation at scaffold time — make `new` always allocate.**
Rejected: the split exists for a reason. `allocate` claims a number in a
shared cross-worktree ledger, and claiming one for every abandoned draft
would burn numbers and produce gaps in a sequence this repository keeps
contiguous on purpose. The reservation ledger already carries stale entries
from worktrees that never landed; making that the default would grow it.

**Have the gate refuse to run while any `ADR-PENDING-*.md` exists.**
Rejected: this converts a reporting gap into a hard block on unrelated work,
and punishes the ordinary act of drafting. The queue's discipline is that
an owed decision is *surfaced*, on a schedule, not that drafting is
forbidden.

**Fix it in `AGENTS.md` — strengthen the existing convention.** Rejected on
the same ground the gate itself rests on: this repository already knows that
a documented convention with no mechanism behind it is the thing that failed.
A safeguard that is documented but not wired is worse than none, because it
creates false confidence — and a green `flagged_proposed: 0` is exactly that
confidence, printed.

**Teach coverage to treat a slug and its later number as the same item.**
Rejected: see Decision §3. It would let an operator answer about
`ADR-PENDING-foo` and silently discharge `ADR-141` without the rebinding
being recorded anywhere a reader could audit.

## Obligations

### O1 — The queue's Proposed-record enumeration currently skips every unallocated record, and this is verifiable by reading one line

`proposedRecords` (`scripts/decision-queue.mjs:177`) filters entries with
`/^ADR-\d+-.+\.md$/` at `scripts/decision-queue.mjs:186`, which no
`ADR-PENDING-<slug>.md` filename can satisfy. `recordStatuses`
(`scripts/decision-queue.mjs:157`) applies the same test at
`scripts/decision-queue.mjs:167`. Observed directly on 2026-08-27: eight
Proposed records present, `flagged_proposed: 0` reported.

<!-- unverifiable: this states the CURRENT filter's behavior, established by reading scripts/decision-queue.mjs and by the observed 2026-08-27 report, not a new capability a roundtrip test exercises -->

### O2 — `deriveDecisionQueue` is the single derivation every bucket in the report is computed from, so widening its Proposed input cannot leave one surface updated and another stale

`deriveDecisionQueue` (`scripts/decision-queue.mjs:510`) is the exported
entry point that assembles `lapsed`, `due_soon`, `upcoming`, `over_age`,
`flagged_proposed`, `operator_calls`, and `hazards` from the commitment
producers; there is no second path that renders a bucket from its own
independent scan. Decision §1 therefore has one place to change.

<!-- proof: symbol=deriveDecisionQueue file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

### O3 — Interview coverage keys on the id the queue emits, so a slug-keyed item and its post-allocation number are distinct ids by construction

`canonicalCoverageId` (`scripts/decision-queue.mjs:471`) and
`coverageIndex` (`scripts/decision-queue.mjs:477`) resolve coverage against
the emitted id. An `ADR-PENDING-<slug>` item and an `ADR-NNN` item are
therefore separate keys, which is what makes Decision §3's explicit
rebinding necessary rather than optional.

<!-- proof: symbol=canonicalCoverageId file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->

### O4 — Decision §1's widened enumeration has no roundtrip proof yet because it is unimplemented

This ADR records a defect and authorizes the change; it does not make it.
No test can exercise a pending-record queue item until `proposedRecords`
emits one.

<!-- unverifiable: Decision 1 is future implementation work this record authorizes but does not perform, so no proof can resolve against the current tree -->

**Implemented (Decision §1).** `proposedRecords` (`scripts/decision-queue.mjs`)
now enumerates `ADR-PENDING-<slug>.md` alongside numbered records, matching
the same `PENDING_PATTERN` shape `scripts/lib/adr-registry.mjs` uses to
recognize a scaffolded-but-unallocated record. A matched entry gets
`kind: "proposed_record"`, `id: "ADR-PENDING-<slug>"`, ages from the same
`**Date:**` line via the same `daysBetween` call, and carries
`unallocated: true` so the human report can render Decision §4's note
("holds no number yet") — `main`'s `unallocatedNote` helper does exactly
that for the `over_age` and `flagged_proposed` sections.
`recordStatuses` was left untouched, per Decision §2. `canonicalCoverageId`
performs no slug<->number rebinding, per Decision §3 — a slug id and its
later allocated number remain distinct coverage keys.

<!-- proof: symbol=proposedRecords file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->
<!-- proof: symbol=canonicalCoverageId file=scripts/decision-queue.mjs roundtrip=scripts/tests/decision-queue.test.mjs -->
