# ADR-075: Decision-traceable work via derived traces and advisory claims

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** 15fee35cb87d4922a91dc9ea90caf42a0f41a7fb
**Content ID:** sha256:5ef5c74c0afe615ce6f6c23ef22752070c955084d3f705a70dc16a6f4bfe1ed1

## Context

Work in this repository is not reliably traceable to the decision that
authorizes it, and the corpus has been drifting away from reality in a way
nothing detects. Measured on 2026-08-15, not asserted:

- 44 of 74 ADRs (030–073) had sat `Proposed` since 2026-08-06 while describing <!-- sur-05:historical — a measurement dated 2026-08-15, stated as such in the line above; the live total has since moved -->
  shipped, gated, tested behavior. Acceptance simply stopped happening.
- The visual-intelligence graph ran 129 commits stale against a budget of 25.
- `gate:typecheck-tests` sat red on master with 14 accumulated type errors.
- 22 visual-intelligence findings were untriaged or reopened.

Each is the same shape, and it is the shape ADR-074 already named: **a rote
step with no forcing function silently stops happening.** ADR-074 solved that
for the gate roster by deriving it from `package.json` rather than from
memory. This decision does the equivalent for decision traceability.

The originating proposal was stronger: have each ADR declare the files it
touches, require an agent to "check out" the governing ADR before working, and
block writes to files not covered by a checked-out ADR — the ADR as an edit
key. That design is rejected in its literal form for three reasons, each
grounded in this repository's own measurements.

**A declared file list is a prediction, not a derivation.** It is written
before the work, but the true blast radius is learned during it. It would
become a changelog that drifts, and §Context above is a catalogue of how
quickly hand-maintained lists rot here.

**Cardinality collapses the lock.** Decisions like ADR-029 ("one writer process
per persistence directory") constrain an unbounded and growing set of future
files, while the highest-traffic files — `manager.ts` (~3.3k lines), `cli.ts`,
`audit.ts` (~2.8k lines) — would be claimed by nearly every ADR. A key that
opens almost every door is a formality, not a control.

**Write-time blocking gets bypassed.** On 2026-08-15, two of three delegated
agents used `git commit --no-verify`, both because a shared hook referenced a
script absent from their branch point. A guard that fires on legitimate work is
disabled wholesale, and a bypassed gate is worse than no gate because it
manufactures false confidence. Requiring an ADR before exploratory debugging
would additionally push authors to write junk ADRs as unlock keys, corrupting
the corpus the mechanism exists to protect.

## Decision

Keep the ambition — work must be traceable to a decision — and invert every
mechanism.

**1. The ADR↔file mapping is derived from git history, never declared.**
`scripts/adr-trace.mjs` builds the map from commits that claim an ADR. No ADR
declares a file list, so no file list can drift.

**2. The claim grammar fits existing history rather than imposing on it.**
Before choosing a grammar, real history was surveyed: there was no prior use of
an `ADR:` trailer anywhere, while inline forms were already pervasive —
conventional-commit scopes (`docs(ADR-074): …`), trailing parentheticals
including ranges and lists, and slash shorthand. All are recognized. The
`ADR:` trailer is added as the new unambiguous form the remedy text points to,
not as a retroactive requirement.

**3. Inline forms are matched in the subject line only.** Commit bodies in this
repository routinely discuss other ADRs in passing prose; counting those would
over-attribute files, which is the fabricated-trace failure this mechanism
exists to avoid.

**4. Enforcement is detection at push time, not prevention at write time.**
`gate:adr-trace` reports unclaimed commits only within
`merge-base(HEAD, master)..HEAD`, so pre-existing unclaimed history
structurally cannot enter the computation. This follows the convention already
established by `worktree-hygiene.mjs` and `branch-accounting.mjs`: detection
and remediation are different authorities.

**5. Claims are advisory records, not locks.** `scripts/lib/adr-claims.mjs`
records that a holder is working under an ADR; two holders may claim the same
ADR and both are recorded rather than one being refused. It reuses the
cross-worktree shared-ledger mechanism of `scripts/lib/adr-registry.mjs`,
which exists because per-worktree file copies defeated a naive lock — the exact
trap a claim ledger would otherwise fall into.

**6. Staleness is reported, never inferred into action.** A dead PID is
objective evidence and is reported; an old timestamp is not, and age-based
pruning is a pure size bound rather than a staleness judgment. This encodes
`worktree-hygiene.mjs`'s recorded incident, where a lock that "looked obviously
stale" named a PID that was in fact alive.

**7. Nothing auto-accepts an ADR, and nothing writes an inferred trace.**
`gate:adr-status` reports the disagreement between an ADR's declared status and
its observable reality, and always exits 0 while 34 known-suspect records
exist. `--backfill-report` proposes candidates only where the commit touched
the ADR file itself, and never writes. A fabricated trace is worse than a
missing one.

### Roads not taken

- **ADR-declared file manifests** — rejected above: prediction over derivation.
- **A write-blocking checkout hook** — rejected above: measured bypass rate.
- **Auto-accepting ADRs whose proofs resolve** — rejected. Acceptance is a human
  verdict; ADR-033 requires a proof triple and the pre-commit hook requires a
  separate status-only commit. Automating it would fabricate the very artifact
  those controls certify.
- **Making `gate:adr-status` blocking immediately** — rejected while 34 records
  are already suspect; a gate that is red on arrival trains bypass.

## Consequences

**Easier.** Which files a decision actually touched is now a query over history
rather than a maintained document. Unclaimed work in a branch is detectable.
The 44-record status drift is measurable for the first time, with per-record
evidence rather than a global impression.

**Harder / costs.** Commits should carry an ADR claim, which is a new habit and
a real friction. `gate:adr-trace` can only see what commit messages say, so a
commit that claims the wrong ADR produces a confident wrong trace — the
mechanism detects absence, not dishonesty.

**Bootstrap note.** The commits implementing this mechanism initially failed
`gate:adr-trace` because no ADR governed it yet. That was reported rather than
papered over with a fabricated trailer, and this ADR closes the gap.

**What this does NOT prove.** That claims are accurate, that every decision has
an ADR, or that a traced commit was authorized. It proves only that untraced
work in a branch is visible instead of invisible.

## Obligations

### O1 — the ADR↔file map is derived from history, and never over-attributes

<!-- proof: symbol=parseAdrReferences file=scripts/adr-trace.mjs roundtrip=scripts/tests/adr-trace.test.mjs -->

`parseAdrReferences(commitMessage)` recognizes the `ADR:` trailer plus every
inline form already present in this repository's history (conventional-commit
scope, trailing parenthetical including ranges and lists, slash shorthand),
returning a normalized, deduped, sorted list, and treats unparseable input as
"no claim" rather than an error. Inline forms are matched in the subject line
only, proven against a real commit body that mentions an unrelated ADR in
prose, so passing discussion never becomes attribution.

### O2 — claims are advisory and concurrency-safe, and staleness is never inferred into action

<!-- proof: symbol=claimAdrs file=scripts/lib/adr-claims.mjs roundtrip=scripts/tests/adr-claim.test.mjs -->

`claimAdrs({ repo, adrs, holder })` records a claim in a ledger shared across
worktrees via the git common directory, admits two holders claiming the same
ADR (recording both rather than refusing either), and rejects an ADR absent
from `decisions/registry.json`. Liveness is reported as `pid_alive` and never
acted on; pruning is an explicit size bound, not a staleness verdict. Proven
against real `git init` / `git worktree add` repositories rather than mocks.
