# ADR-130: An ADR's Prose Citations Are Checkable, Not Decorative

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 996e74254711b5910fb7c71cf8ff66fd672404cd
**Content ID:** sha256:dc2f8ce4df0208c24689ed82f1462d6fcae4c8aff78e8f2b6578ab66f63e51a3

## Context

`gate:obligations` verifies that every proof triple RESOLVES — that
`symbol=`/`file=`/`roundtrip=` names a real exported symbol at a real
declaration site with a test a vitest glob actually collects. It reports 0 M-B
and 0 M-C across 124 records and 472 obligations. That check is real and it
works.

It says nothing whatever about the rest of the document.

An ADR's Context, Decision, Consequences, and Alternatives sections are dense
with citations — a `path/to/file.ts:123` reference, dependency versions, test
counts, symbol names,
"see the comment at X". None of it is checked. A single audit batch on three
ADRs turned up: `@opentui/core` cited as `0.5.1` against an actual `0.5.3`;
`tui.ts:26` where the referenced code now sits at `:32`; `index.ts:173` now
`:190`; `vitest.config.ts:32` now `:34`; and a test count of "51 files / 668
tests" against an actual 67 / 878. Every one of those ADRs was fully green.

The failure mode is worse than ordinary staleness because of what an ADR is for.
These records exist so a future reader can recover the *why* — and a reader who
follows a citation to the wrong line, or reads a version number that was true a
month ago, is not merely under-informed. They are misinformed by a document
whose entire authority rests on being the durable account. An ADR can be fully
green while describing a repository that no longer exists.

This is the same shape as the defect this session found repeatedly in code: a
capability that exists, is typed, is tested, and is never actually reached. Here
it is a claim that exists, is formatted correctly, sits inside a gated document,
and points at nothing.

Two further observations sharpen the scope. First, the drift is not uniform:
line numbers rot by construction — any edit above them moves them — while symbol
names and file paths are stable under exactly the same edit. Second, the
existing proof triple already demonstrates the checkable form. `symbol=` plus
`file=` survives refactoring that `file:line` cannot. The corpus already knows
how to write a durable citation; it just does not require one outside the
Obligations section.

## Decision

**1. A prose citation is a claim, and claims in this corpus are checked.** A new
gate parses ADR bodies for citation-shaped references and verifies each against
the repository. A citation that cannot be resolved fails, in the same way an
unresolving proof triple fails today.

**2. The checkable set is bounded deliberately.** The gate verifies what it can
verify mechanically and unambiguously:
- `path/to/file.ts` — the file exists.
- `path/to/file.ts:N` — the file exists AND has at least N lines. Whether line N
  still contains the intended thing is not decidable, which is the point of
  Decision 4.
- A dependency version stated for a named package — matches that package's
  manifest.
- A `symbol` named as existing at a `file` — resolves the same way a proof
  triple's does, reusing `resolveProofComment`'s machinery rather than a second
  implementation.
Prose that merely mentions a filename in passing is not a citation; the gate
must not flag ordinary English that happens to contain a dot.

**3. Counts and measurements are explicitly OUT of scope.** "51 files / 668
tests" was wrong, and it will be wrong again the day after any fix. A test count
in an ADR is a snapshot of a moving number and pretending to check it would
either fail constantly or require re-running the suite inside a documentation
gate. The honest remedy is not to check them but to stop writing them: a count
belongs in a report, not in a durable decision record.

**4. Line numbers are discouraged, not forbidden.** A `file:line` citation is
accepted where it resolves, but the gate reports the count of them as an
advisory ratchet — they are the form guaranteed to rot, and a corpus trending
toward `symbol`+`file` citations is trending toward durability. This is a
pressure, not a prohibition: sometimes the line genuinely is the referent.

**5. It ratchets rather than blocking on day one.** The corpus is 124 records
deep and nobody has checked any of this. The gate lands with a floor at the
measured count of currently-unresolvable citations and refuses any increase, on
the same pattern `gate:adr-sections` already uses for missing Alternatives
sections. Existing drift is then paid down deliberately instead of blocking
every commit until 124 documents are audited at once.

## Consequences

The corpus stops being able to lie quietly. A reader following a citation lands
where the citation says, or the gate said so before they got there. For records
whose whole purpose is to be trusted years later by someone who was not in the
room, that is the property that matters most.

Writing an ADR gets more constrained. An author cannot cite a file that does not
exist, and will be nudged away from line numbers toward symbols. That is a real
cost paid at authoring time for a benefit collected at reading time — the usual
shape of documentation discipline, and the usual reason it is skipped.

The gate can be wrong in a way `gate:obligations` cannot. Proof triples have a
rigid grammar; prose does not. A citation detector will have false positives —
English that looks like a path — and false negatives. It must therefore fail
only on high-confidence, well-formed citations, and a conservative detector that
misses some drift is correct here, while a zealous one that flags prose will be
disabled within a week and check nothing at all.

Retired and superseded records will drift by design, since they describe a
repository that deliberately no longer exists. The gate must exempt them or it
will demand edits to documents whose value is precisely that they were not
edited.

## Alternatives / Roads not taken

**Sweep the corpus once and add no gate.** Rejected as the primary answer,
though the sweep is still needed. Without enforcement the corpus drifts straight
back — this session alone moved enough code to invalidate line numbers across
several ADRs, and no reviewer catches a stale `:123` by eye.

**Ban line numbers outright.** Rejected as too blunt. Occasionally the line is
genuinely the referent — a specific comment, a specific guard clause — and an
absolute prohibition would push authors toward vaguer citations, which are worse
than a rotting precise one. The ratchet applies pressure without forbidding
judgement.

**Check counts and measurements too.** Rejected, per Decision 3. It would make
the gate a liar's mirror: either constantly red on numbers nobody intended as
durable, or requiring a test run inside a docs gate. Stop writing them instead.

**Extend `gate:obligations` rather than adding a gate.** Rejected on separation
of concerns. `gate:obligations` answers "is every obligation witnessed"; this
answers "does the prose point at what it claims". Merging them would make one
red result mean two unrelated things, and this repository's own remedy work
(ADR-113) is about failures naming their own cause.

**Do nothing; treat ADR prose as informal.** Rejected, and it is the real
alternative worth naming. If ADR prose is informal then its citations carry no
weight and readers should not rely on them — but readers do rely on them,
because the document is presented as the authoritative record. Either the
citations mean something and are checked, or they mean nothing and should not be
written. The status quo takes both benefits and pays for neither.

## Obligations

### O1 — A citation naming a file that does not exist fails the gate

The gate must reject an ADR citing a path with no corresponding file, which is
the highest-confidence and most damaging class of drift.

<!-- proof: symbol=resolveFileCitation file=scripts/adr-citations.mjs roundtrip=scripts/tests/adr-citations.test.mjs -->

### O2 — A dependency version cited in prose matches the manifest

The `@opentui/core 0.5.1` versus actual `0.5.3` case must fail, since a version
is exactly checkable and a wrong one silently misinforms.

<!-- proof: symbol=resolveVersionCitation file=scripts/adr-citations.mjs roundtrip=scripts/tests/adr-citations.test.mjs -->

### O3 — Ordinary prose is not flagged as a citation

English that merely contains a dot or resembles a path must not fail the gate; a
detector that cries wolf gets disabled and then checks nothing.

<!-- proof: symbol=extractCitations file=scripts/adr-citations.mjs roundtrip=scripts/tests/adr-citations.test.mjs -->

### O4 — Retired and superseded records are exempt

A record describing a repository that deliberately no longer exists must not be
made to fail, or the gate demands edits to documents whose value is that they
were never edited.

<!-- proof: symbol=isRetired file=scripts/adr-citations.mjs roundtrip=scripts/tests/adr-citations.test.mjs -->
