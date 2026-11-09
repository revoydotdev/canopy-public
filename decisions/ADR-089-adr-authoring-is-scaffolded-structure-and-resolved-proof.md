# ADR-089: ADR Authoring Is Scaffolded Structure Plus a Resolved-Proof Author Tool

**Status:** Accepted
**Date:** 2026-08-24
**Authoring Revision:** 94f2634031eab52f4885136782f66c5cc58692e2
**Content ID:** sha256:2e795aa375671d1cf1d2648bf05a4d9daa2cb02fcecc1b63880c6b59c6cf65e4

## Context

ADR quality has depended on a model reading other ADRs and imitating their
shape — an emulated convention, not an enforced one. `scripts/lib/adr-
registry.mjs`'s scaffold (fixing D1) wrote only a metadata header plus three
empty stubs (Context/Decision/Consequences); Alternatives and Obligations
existed only as prose conventions a careful author might reproduce, and
nothing checked that any section, once headed, actually carried content.
Obligation proof comments (`<!-- proof: symbol=X file=Y roundtrip=Z -->`)
were hand-typed from memory and only checked by `gate:obligations` AFTER
allocation. ADR-088 shipped citing `validateAction` (never exported — only
`validateTaskComposerProposal` is) and `NativeRepositoryToolHost` (not a real
export; the factory is `createNativeRepositoryToolHost`) — both wrong, both
caught only after the record already carried a permanent number. The
allocation authority (`scripts/lib/adr-registry.mjs`) and the two content
checks (`gate:obligations`, and now `gate:adr-sections`) are correctly
separate authorities per this repository's own "authoring vs. allocation"
split (ADR-072), but nothing closed the gap between "the scaffold produced a
stub" and "the gate caught the stub" — a model could allocate a record whose
Alternatives/Obligations sections were never more than the scaffold's own
prompt text, and nothing would object until the acceptance-time
`gate:obligations` run, or never, since that gate is a POL-04 floor on
accepted records, not a section-presence check at all.

## Decision

Three mechanisms close the gap, each scoped to structure only — never prose
quality, which stays a human/model judgment call by design (the SCAFFOLD
class: structure guaranteed, content stays creative).

**1. `newPendingDecision` (`scripts/lib/adr-registry.mjs`) now scaffolds every
required section as a real heading.** Context, Decision, and Consequences
keep their existing HTML-comment prompts; the draft additionally gets
`## Alternatives / Roads not taken` and a full `## Obligations` skeleton — a
real `### O1 — <the durable, checkable claim this obligation upholds>` item
with a one-line prose prompt and a bare `<!-- proof: symbol= file=
roundtrip= -->` comment. The metadata header (Status/Date/Authoring
Revision/Content ID) and `contentId()`'s derivation are untouched — Content
ID is a function of title/created-at/authoring-revision only, never of body
prose, so this change cannot silently invalidate an in-flight draft's
identity.

**2. `bun run proof <symbol> [--file <path>] [--test <path>]`
(`scripts/adr-proof.mjs`, new) resolves a proof triple at authoring time,
before a single character is hand-typed into a proof comment.** It calls
`resolveProofComment` from `@arbor/governance` directly — the SAME function
`scripts/obligations-gate.ts` calls via `buildObligationCoverageReport` — so
a triple this tool accepts is guaranteed to resolve identically when
`gate:obligations` sees it later; there is no second grammar or resolution
path to drift out of sync with the first. Given only a symbol, it searches
`packages/*/src` for an unambiguous exported declaration (`--file`
disambiguates a multi-match); given `--test`, it additionally confirms the
roundtrip exists and is collected by `vitest.config.ts`'s `include` globs.
On success it emits the exact `<!-- proof: symbol=X file=Y roundtrip=Z -->`
comment ready to paste; on failure it names the specific reason — not
exported, ambiguous, missing, or not collected — reproducing and catching
the ADR-088 case (`validateAction`, `NativeRepositoryToolHost`) at authoring
time instead of after allocation.

**3. `gate:adr-sections` (`scripts/adr-sections.mjs`, new) asserts every
non-retired ADR (Proposed/Accepted; Retired/Superseded/Rejected are exempt)
has each required section present and non-stub.** "Non-stub" means: with
its own HTML-comment prompt(s) stripped, the section body still has content.
For Obligations specifically, an item counts as filled only if its title is
not the placeholder `<...>` form AND it carries either a proof comment with
at least one populated field, a non-empty `<!-- unverifiable: ... -->`
reason, or prose — deliberately NOT requiring prose in addition to a
resolving proof comment, because the existing corpus's real obligations
(e.g. ADR-011's O1) legitimately carry nothing but a proof comment.
Structure only: the gate never scores whether the prose is any good.
Context/Decision/Consequences/Obligations are unconditionally required
(measured 2026-08-24: already true of every non-retired ADR in this corpus).
Alternatives is a one-way ratchet at a floor of 49 (the count of non-retired
ADRs missing the heading on the day this gate shipped, before any
Alternatives convention existed) — see the gate's own header for why an
unconditional requirement there would fail the whole pre-existing corpus.
The gate runs at `stop` (fast, previewable before a human commits) and `ci`
(blocking, authoritative), mirroring `gate:obligations`'s own tier exactly.

**4. `docs/adr-authoring.md` (new) is the reference an author reads instead
of reverse-engineering conventions from examples** — what each section must
answer, the full proof-triple contract and its honest ceiling, and the
house voice (cite the mechanism, state the WHY, name roads not taken, prefer
a ratchet to a retroactive demand, say the honest limit out loud).

## Consequences

A model authoring a new ADR now gets every required section as a real
heading with a prompt, not an emulated convention it might reproduce
inconsistently; `gate:adr-sections` catches a section left as only that
prompt before the record accumulates more history. `bun run proof` turns a
hand-typed, memory-derived proof citation — the exact failure mode ADR-088
shipped with — into a resolved-or-rejected check the author runs before
typing the comment, using the identical resolver the gate will apply later,
so there is no second grammar to drift out of sync. Nothing about existing
accepted ADRs' historical Obligations content is touched or re-validated
beyond what `gate:obligations` (a separate, pre-existing gate) already
checks; `gate:adr-sections`'s Alternatives ratchet means the 49 pre-existing
records without that heading do not need a retroactive campaign to pass this
gate, only that the count never rises. This decision adds a new required-CI
gate (`gate:adr-sections`) to the execution profile and a new non-gate
`proof` script; both were verified against the real `decisions/` corpus
(86 ADRs, 0 violations at authoring time) <!-- sur-05:historical — measured
when ADR-089 was authored; the live ADR total has since grown --> before being wired in, so adoption
does not itself fail the very push that lands it.

## Alternatives / Roads not taken

1. **Enforce Alternatives unconditionally, immediately.** Rejected: measured
   at authoring time, 49 of 86 non-retired ADRs lack the heading — records
   written before any Alternatives convention existed. An unconditional
   requirement would fail the whole corpus on introduction, the same
   "gate fires on legitimate work, gets disabled wholesale" failure this
   repository has already measured (`obligations-gate.ts`'s own
   `POL_04_FLOOR` header cites two `--no-verify` incidents from exactly this
   shape). A one-way ratchet was chosen instead — new gap-free.

2. **Require prose in every obligation body, in addition to a proof
   comment.** Rejected after checking the real corpus: obligations like
   ADR-011's O1 legitimately carry nothing but a resolving proof comment and
   no extra sentence, and treating that as incomplete would be a false
   positive against real, already-shipped, already-verified work — punishing
   a terse-but-correct citation to force padding, not to catch an actual gap.

3. **Have `bun run proof` reimplement symbol/roundtrip resolution instead of
   calling `@arbor/governance`'s `resolveProofComment` directly.** Rejected:
   `packages/arbor-governance/src/obligation/proof.ts`'s own header already explains why a second parser
   for the same comment grammar is exactly the kind of duplicated knowledge
   that has drifted before in this repository (the marker vocabulary
   incident cited in `claim-ledger.ts`). Calling the identical function the
   gate calls is the only way to GUARANTEE agreement rather than merely
   intend it.

4. **Lock ADR content at write time (a PreToolUse-style hook blocking a save
   until every section is filled) instead of gating at stop/CI.** Rejected
   for the same reason `adr-trace.mjs`'s header rejects a declared-file lock:
   a write-time block on an in-progress, intentionally incomplete draft gets
   bypassed with `--no-verify` or worked around entirely the first time it
   fires mid-thought, and this repository already has two documented
   `--no-verify` incidents of exactly that shape. Detection at stop/CI,
   never a lock at write time, matches the split ADR-075 already
   establishes.

## Obligations

### O1 — `gate:adr-sections` fails a non-retired ADR whose required section is missing or still just its own HTML-comment prompt, and passes a complete one

<!-- proof: symbol=runSectionsAudit file=scripts/adr-sections.mjs roundtrip=scripts/tests/adr-sections.test.mjs -->

`runSectionsAudit` walks `decisions/*.md`, skips any record whose `**Status:**`
line starts with Retired/Superseded/Rejected, and reports a violation for
every non-retired record with a missing or stub Context/Decision/
Consequences/Obligations section — proven by `adr-sections.test.mjs`'s
`runSectionsAudit` suite (a complete fixture passes, a stubbed Decision
section fails, a Retired record with every section stubbed still passes
because it is skipped entirely) and its CLI test, which runs the gate
against this repository's own real `decisions/` directory and asserts it
currently passes.

### O2 — Obligations-section completeness never false-positives against the real corpus's own shape (a proof-only item with no extra prose is accepted; the scaffold's bare proof stub is not)

<!-- proof: symbol=checkObligations file=scripts/adr-sections.mjs roundtrip=scripts/tests/adr-sections.test.mjs -->

`checkObligations` treats an obligation item as filled when it carries a
proof comment with at least one populated `key=value` field, a non-empty
`unverifiable:` reason, or prose beyond its own HTML-comment prompt — proven
by `adr-sections.test.mjs`'s dedicated cases: ADR-011's real proof-only shape
(`symbol=RuntimePort file=... roundtrip=...`, no extra sentence) is accepted,
while the scaffold's bare `symbol= file= roundtrip=` stub (no populated
field) is rejected as unfilled, and a still-placeholder `### O1 —
<the durable, checkable claim...>` title is rejected regardless of its body.

### O3 — `bun run proof` resolves a real top-level export plus a collected roundtrip into a paste-ready comment, and fails — with the specific reason — on a symbol that is not exported at that file's top level (the ADR-088 shape)

<!-- proof: symbol=resolveProof file=scripts/adr-proof.mjs roundtrip=scripts/tests/adr-proof.test.mjs -->

`resolveProof` calls `@arbor/governance`'s own `resolveProofComment` — the
identical function `gate:obligations` uses — so a comment it emits is
guaranteed to resolve the same way later. `adr-proof.test.mjs` proves both
directions against the real repository: a genuinely exported symbol with an
existing, collected test resolves to the exact expected comment string, and
a symbol present in a file's source but not exported at its top level
(mirroring the real ADR-088 failure — `validateAction`/
`NativeRepositoryToolHost` were never real exports) fails with a
`not declared or exported` reason, both via the in-process API and via the
CLI's `--json` exit-code contract.

### O4 — `newPendingDecision`'s scaffold writes every required section as a real heading, including a genuine `### O1` obligation skeleton — and a filled-in copy of that exact scaffold passes `gate:adr-sections`

<!-- proof: symbol=newPendingDecision file=scripts/lib/adr-registry.mjs roundtrip=scripts/tests/adr-registry.test.mjs -->

`adr-registry.test.mjs`'s scaffolding suite asserts the written draft
contains real `## Context`/`## Decision`/`## Consequences`/`## Alternatives
/ Roads not taken`/`## Obligations` headings and the `### O1 — <the durable,
checkable claim this obligation upholds>` placeholder verbatim, and that
`allocate` still accepts the draft unmodified afterward (the Content ID
contract is unaffected by the added body text). `adr-sections.test.mjs`'s
dogfooding case additionally proves the loop closes end to end: the raw
scaffold fails `checkAdrSections` (it is a stub by design), and a copy with
every placeholder replaced — exactly as an author would do by hand — passes
with zero problems.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority separate
from the implementation and authoring authority used in this tranche.
