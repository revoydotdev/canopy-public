# ADR-033: Completeness Claims Carry a Durable Record and a Required Discharge

**Status:** Accepted
**Date:** 2026-08-07

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR governance
by ADR-024's ratification note), and POL-05 flags any record arriving already
accepted as never having traversed the lifecycle.

## Context

This repository has strong gates for whether the **code** is right and none for
whether its own **assertions** are backed. Those are different populations, and
the second is far larger than it looks.

There are exactly **2 literal `TODO`/`FIXME` comments** under `packages/*/src`.
The real backlog of unfinished work is not written as TODOs — it is written as
claims of completion. Counted on 2026-08-07: 81 tranche-completion markers in
ROADMAP.md, 30 substrate markers, 39 `**Status:**` lines, 38 gap-register rows,
one status line per record in `decisions/`, one index row per record in
`decisions/README.md`, and 10 of the last 60 commit messages asserting closure
of a `G-NN`.

(That the corpus size is stated as a ratio rather than a number is deliberate:
the count-drift gate flagged an earlier draft of this very paragraph for
hardcoding a total that the addition of this record then invalidated. A count
captured once and never re-derived is the drift this repository already gates
against; restating it here would have been a claim of exactly the kind this
record is about.)

Of those surfaces, `gate:docs-truth` validates ROADMAP
tranche markers and register citations, `gate:obligations` validates ADR proof
citations, and **nothing validates the index or the commit messages at all**.

Three defects found by hand during one audit, all the same shape — a claim
nothing was obliged to back:

1. **`decisions/README.md` disagreed with the ADR files in four places.**
   ADR-027, 028 and 029 read `Accepted` in-file and `Draft`/`Proposed`/`Proposed`
   in the index; ADR-030 was absent from the index entirely.
   `packages/arbor-governance/src/record/corpus.ts:57` explicitly **excludes**
   README.md from parsing, and no other script in the repository reads it, so
   nothing could ever have noticed.
2. **A completion marker at `ROADMAP.md:514` uses a glyph no gate reads.**
   `docs-truth.mjs` matches one marker only. The claim was invisible.
3. **Commit messages assert closure with nothing linking them to the register.**

ADR-025 already named the underlying dynamic in a different register: a signal
nothing blocks on gets skimmed, and POL-04 fired 29 times unacted. A claim that
nothing is even *obliged* to record is the limit case.

## Decision

**Every machine-detectable completeness claim becomes a durable record with a
declared discharge requirement, and a new claim that is unbacked blocks
locally.**

1. **`.claim-ledger/claims.jsonl` (committed)** — one record per claim:
   `{id, source, repository_path, line, claim_text, asserted_value,
   discharge_requirement, discharge_status, discharge_evidence, first_seen,
   last_verified, content_hash}`. Sources: `roadmap_heading`,
   `roadmap_status_line`, `roadmap_unvalidated_marker`, `roadmap_partial_marker`,
   `gap_register_row`, `adr_file_status`, `adr_readme_index_entry`, and
   `commit_message_closure`.

2. **Identity excludes discharge.** `content_hash` covers
   `(source, path, claim_text, asserted_value)` only. A claim's text is what
   makes it that claim; its discharge is expected to change as code changes.
   Folding discharge into identity would make every discharge flip read as a new
   claim — and the gate blocks on new claims, so the ledger would block on its
   own bookkeeping.

3. **One file, two modes.** `scripts/claim-ledger.ts` is both producer
   (`--refresh`) and gate. Splitting them is how `.visual-intelligence/`'s
   refresh recipe came to exist in two places that disagreed;
   `packages/arbor-governance/src/vi/exceptions.ts` states the general rule: *"Two stores means two
   truths, and the older one silently wins."*

4. **Rules.**
   - **CL-A (blocking)** — a *new* claim (id absent from the committed store)
     whose status is `undischarged` or `contradicted`.
   - **CL-B (blocking, unconditional)** — any `decisions/README.md`
     index-vs-file mismatch, missing row, or broken link. A row that disagrees
     with its own file is a structural bug with no legitimate excuse; the four
     that existed were fixed before this gate was wired, so it starts clean.
   - **CL-R (ratchet)** — `CLAIM_LEDGER_FLOOR = 1`, measured, may fall and must
     not rise.

5. **Reuse, not refork.** ADR parsing and proof resolution come from
   `@arbor/governance` (`buildObligationCoverageReport`, `sha256Hex`) — the same
   code `gate:obligations` runs. ROADMAP validation defers to
   `node scripts/docs-truth.mjs --json`, spawned as a subprocess exactly as
   `docs-truth.mjs` spawns `reachability.mjs`. This file inventories claims; it
   does not re-decide what those two already decide.

6. **A `PreToolUse` guard** (originally the shell hook .claim-ledger/claim-guard.sh, now
   the native veto handler `veto.claim-completeness-guard` behind the
   `claim-completeness-guard` hook descriptor) denies an edit that
   adds a completeness marker with no proof syntax in the same change, and
   **fails open on every ambiguity**. It sees only a diff fragment, so it cannot
   distinguish a genuinely unproven claim from one whose proof sits three lines
   above the edit window. The gate is the authority; the guard is a nudge.

### An obligation with no proof is legal, and this gate must agree

The first implementation marked an accepted ADR `undischarged` when it declared
obligations and none resolved. That flagged **ADR-008**, which declares three
obligations, attaches no proofs, and explains exactly why: a filesystem-layout
claim is not expressible as a symbol/file/roundtrip triple, and forcing one
*"wouldn't genuinely verify the claim."* `obligations-gate.ts` calls this legal
and honest.

Rule M-B covers a proof that fails to resolve. Declaring no proof is legal only
with an adjacent machine-readable `<!-- unverifiable: ... -->` reason; M-C
blocks silence while preserving `unverifiable` as distinct from a false proof.
Punishing a record for being honest about what it cannot prove is the opposite
of what this ledger is for.

### An unvalidated marker is recorded as unvalidated, never as discharged

The completion glyph at `ROADMAP.md:514` is deliberately kept **out** of the
validated marker set. Folding it in would make the ledger report it discharged
on the strength of a gate that never looked at it — inventing the confirmation
whose absence *is* the finding. It is recorded as `roadmap_unvalidated_marker`,
and the most this ledger honestly establishes is whether a proof comment is
**present**; presence is not resolution.

### Markers are scoped per file

The same glyph means different things in different documents. In ROADMAP.md it
asserts a tranche is complete; in an ADR the completion vocabulary is the
record's own `**Status:**` line, and the glyph is almost always prose — a table
describing markers, a comparison, a quoted example.

The first version of the `PreToolUse` guard matched the glyph everywhere and
immediately denied **this ADR**, whose Context section tabulates the marker
surface. That is the false-positive class `gate:anti-stub` already learned the
hard way. Scoping was the fix; downgrading the guard to warn-only would have
been the wrong one.

## Consequences

**Positive.** `decisions/README.md` gets its first check in the repository's
history. The unvalidated-marker claim becomes visible and counted. 139 claims
that previously had no record now have one, with provenance carried forward
across refreshes.

**Negative, and load-bearing.** This measures **citation integrity, not
correctness** — the identical ceiling `obligations-gate.ts` and `docs-truth.mjs`
already document, inherited wholesale because this defers to both. A discharged
claim means a file exists, a symbol resolves, a test is collected, an index row
matches. It does not mean the work is right.

**Negative.** Claims written in prose the extractor does not recognise are
invisible by construction. The marker vocabulary is a closed set, and a claim
phrased outside it is not merely unvalidated — it is unseen. That is exactly what
`ROADMAP.md:514` demonstrated, and adding it to the ledger does not prove there
is no fourth marker somewhere.

**Negative.** Commit-message closures are recorded and **never** blocking.
Natural-language subjects are too heuristic to gate a push on. This is
deliberate restraint, and it means the commit/register link is reported, not
enforced.

**Negative.** Per ADR-025 this is `REPORTED+`, never `BLOCKED`. Pre-push is
bypassable with `--no-verify`, and the `PreToolUse` guard only binds sessions
that installed the hooks.

## Alternatives considered

1. **Extend `docs-truth.mjs` instead of adding a ledger.** Rejected: docs-truth
   validates ROADMAP and nothing else. ADR statuses, the index, and commit
   messages are outside its scope, and widening it would give one script four
   unrelated responsibilities.

2. **Block on the whole existing backlog.** Rejected: it would have blocked work
   on day one over a pre-existing marker, which trains people to bypass the gate
   — the failure ADR-025 documents.

3. **Gate on commit messages.** Rejected: heuristic natural-language parsing
   gating a push produces false denials whose only remedy is `--no-verify`,
   which then becomes habitual and disables the gates that *are* reliable.

4. **Normalise the stray marker so `docs-truth` handles it.** Probably the right
   end state, but it is a content decision about what that tranche actually is —
   complete, or substrate — and belongs to whoever owns the tranche, not to the
   gate's author.

## Obligations

### O1 — Every completeness claim in a recognised surface has a durable record

<!-- unverifiable: the whole-extraction pipeline runs inside scripts/claim-ledger.ts's unexported main(); none of the file's 5 exported symbols cover the 7-source-kind claim this obligation makes. -->

`scripts/claim-ledger.ts --refresh` writes 139 records across 7 source kinds.
Verified by running it and reading `.claim-ledger/claims.jsonl`.

*No proof comment: the extractor is a repository script, not an export under
`packages/*/src`, so `symbol=` cannot resolve against it. Citing an unrelated
symbol to satisfy the parser would be the false proof this record argues
against — the same reasoning ADR-008 gives for its own three obligations.*

### O2 — A new unbacked claim fails the gate

<!-- unverifiable: the CL-A rule is implemented inside scripts/claim-ledger.ts's unexported main(), not behind any of the file's 5 exported symbols. -->

Verified by appending an unproven completion heading to ROADMAP.md and observing
CL-A fail, then reverting.

### O3 — The ADR index is checked against the ADR files

<!-- proof: symbol=findAdrIndexDefectsFromEntries file=scripts/claim-ledger.ts roundtrip=scripts/tests/adr-acceptance-gate.test.mjs -->

Verified by deleting ADR-030's index row (the real historical defect) and
observing CL-B fail, and separately by making a row's status contradict its
file.

### O4 — An obligation with no proof is not treated as a failure

<!-- unverifiable: the discharge-status classification (accepted/unresolved/unverifiable) is scripts/claim-ledger.ts's unexported adrClaims(), not one of the file's 5 exported symbols. -->

ADR-008 declares three obligations with no proofs and a stated reason. The gate
reports it `unverifiable`, not `undischarged`.

### O5 — A completion marker outside the validated vocabulary is reported, not silently discharged

<!-- unverifiable: the roadmap_unvalidated_marker classification lives in scripts/claim-ledger.ts's unexported roadmapClaims(), not one of the file's 5 exported symbols. -->

The stray marker at `ROADMAP.md:514` is recorded as `roadmap_unvalidated_marker`
and counted against the ratchet floor.
