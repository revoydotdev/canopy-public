# ADR-031: The Visual-Intelligence Skill Is Vendored Into the Repository

**Status:** Superseded
**Date:** 2026-08-07

> **Superseded by ADR-176 (2026-09-29).** The skill is first-party source of this
> repository, not a vendored copy: `VENDOR.md`, `VENDOR.json`, `gate:vi-vendor`
> and `vi:vendor` are retired. The repository-local extractor resolution,
> `gate:vi-reproducible` and project-local hook installation established below
> are retained and restated in ADR-176. This record is kept as the history of
> what was decided and why.

> **Correction (2026-08-07, before acceptance).** This record originally
> described the vendored skill as "someone else's MIT code" and reasoned about
> upstream as a third party outside this project's control. **That is wrong.**
> `repository-visual-intelligence` is the repository owner's own work. The
> correction is material rather than cosmetic: every mitigation below was
> designed against a risk model — an independent upstream that moves without
> warning — that does not apply. The real risk is different and, as it turns
> out, worse. See "What the correction changes" before ratifying.

Authored as Proposed. The implementing agent holds no acceptance authority
(AGENTS.md checks-and-balances, applied to ADR governance by ADR-024), and
POL-05 flags any record arriving already accepted as never having traversed the
lifecycle. This one warrants review in particular: it **reverses a
recommendation the same agent made two commits earlier**, on the operator's
instruction.

## Context

`.visual-intelligence/` is a committed, reviewable graph of this repository.
Regenerating it requires the `repository-visual-intelligence` skill's
TypeScript extractor, which lived only in a user's `~/.claude/skills/`.

Three consequences followed, and they compound:

1. **CI could not regenerate or verify the graph.** The freshness gate had to
   be reduced to measuring commit distance from the manifest — enough to detect
   *staleness*, useless against a graph that is simply *wrong*.
2. **A fresh clone could not refresh.** A mechanism available on one machine is
   not a mechanism.
3. **The committed graph was not reproducible from committed inputs, and
   nothing could have noticed.** It declared four entry-point roots sourced
   from .visual-intelligence/entry-points.json, a file that has never existed
   here. Running the invocation its own manifest records emits **zero
   reachability edges** behind a single warning line. The artifact looked fine.
   The defect survived precisely because verifying it required a tool the
   verifier did not have.

(3) is the decisive one. A verification artifact whose correctness cannot be
checked by the thing that consumes it is a claim, not evidence — the
distinction this repository has spent its whole Phase 6 on.

## Decision

**Vendor the upstream skill into `.claude/skills/repository-visual-intelligence/`,
and treat the vendored copy as canonical for this repository.**

- `scripts/vi-refresh.mjs` resolves the extractor from the repository, not from
  `$HOME`. Refreshing is now a property of the repository.
- `npm run vi:vendor` re-vendors and rewrites the provenance manifest together,
  because doing either alone leaves provenance that lies.
- `npm run gate:vi-vendor` recomputes a SHA-256 per vendored file. **Editing a
  vendored file blocks the build.** When upstream is also installed it reports
  divergence in both directions, so "we edited it" and "upstream moved" stay
  distinguishable; when upstream is absent it reports *unknown*, never
  agreement.
- `npm run gate:vi-reproducible` regenerates and compares **structure** —
  provenance stamps (`first_seen`, `last_verified`,
  `established_at_revision`) excluded, records key-sorted and compared as a
  multiset. Raw bytes cannot be compared: every record carries the revision, so
  a byte check would report DIFFERS forever and mean nothing.
- The skill's hooks become installable project-locally via
  `npm run vi:install-hooks`, opt-in, warning when a global registration would
  make every hook fire twice.

## Consequences

**This forks a dependency, and that cost was the argument against it.** It is
accepted deliberately, not overlooked. The mitigation is that the fork is
*detectable*: hashes make local edits a build failure, and upstream comparison
makes drift visible whenever the upstream copy is present.

The cost is not hypothetical. **The upstream extractor changed two minutes
after the first vendoring pass**, mid-task — the exact drift being warned
about, arriving faster than the warning. The change was valuable (see below)
and was adopted by re-vendoring, which is the intended workflow rather than an
exception to it.

**A refresh no longer rewrites the whole artifact.** The adopted upstream
change carries `first_seen` forward instead of restamping it every run.
Measured on this repository: a refresh went from **~50,000 changed lines to
~370**. That matters beyond tidiness — the stated justification for committing
a 28MB generated artifact is that it diffs line-by-line, and until now it did
not. It also weakens the merge-conflict argument that motivated single-writer
discipline, though that discipline is retained: the argument was never only
about diff size.

**CI can now answer a question it could not ask.** Reproducibility is checked
on every run, so the class of defect in Context (3) cannot recur silently.

**Enforcement remains local-only** for the pre-push path, the ceiling ADR-025
already documents: branch protection returns 403 on this plan, and
`git push --no-verify` bypasses hooks by design.

**Verification is portable; upgrading is not.** `gate:vi-vendor` and
`gate:vi-reproducible` run anywhere, but `npm run vi:vendor` can only run where
the upstream skill is installed. Re-vendoring therefore remains a one-machine
human act, and a stale `vendored_at` is invisible to CI: the hash gate proves
the copy is unedited, never that it is current. `vendored_at` is a date, not a
subscription.

## Compliance

- `npm run gate:vi-vendor` — the vendored tree matches `VENDOR.json`.
- `npm run gate:vi-reproducible` — the committed graph regenerates from
  committed inputs.
- `npm run gate:vi-freshness` — the graph is within its staleness budget.
- `.claude/skills/repository-visual-intelligence/VENDOR.md` — the rules for the
  directory, and the attribution.

**On this record's own provenance.** Two ADR-031 records were authored
independently for this same decision — one alongside the implementation, one
afterwards to close `VENDOR.md` and `scripts/vi-refresh.mjs`'s dangling
citations of a record that did not yet exist. Two records for one decision is
itself a governance defect, so they were consolidated here; the distinctive
reasoning from the second (the Compliance list, and the point that
`vendored_at` is a date rather than a subscription) is preserved above rather
than discarded with the file.

## What the correction changes

The skill is the repository owner's own work, so "upstream might move without
warning" was never the risk. The actual risk is sharper: **the original has no
version control at all.** It is a directory under `~/.claude/skills/` with no
git history, no `package.json`, and no version — unlike `gstack` in the same
directory, which is a real repository with a remote.

That inverts the assessment of the machinery this ADR installs:

- `vendored_at: 2026-08-07` anchors to nothing. There is no commit to diff
  against, so "has upstream moved, and how?" is unanswerable even with the
  upstream copy present. The gate can say *that* bytes differ, never *what
  changed* or *which direction is newer*.
- The 65-line divergence that appeared two minutes into vendoring was not an
  independent maintainer shipping a release. It was an unversioned working copy
  being edited. It could equally have been lost.
- `VENDOR.md`'s rule "do not edit these files; make the change upstream" is
  advice to the same person who owns both copies, enforcing a boundary that
  does not exist.

**The vendoring machinery is therefore half-useful until the original has a
canonical, versioned home.** The hash gate still earns its place — it detects
in-place edits, which is real — but the upstream-comparison half cannot mean
much when "upstream" is a mutable directory. This ADR should be read as an
interim measure, and the follow-up (Alternative 4) as the actual destination.

## Alternatives considered

1. **Leave the skill in `~/.claude/skills/` (the prior recommendation).** No
   fork, no drift. Rejected on the operator's instruction, and the Context
   above is why the instruction was right: it leaves CI unable to verify, a
   clone unable to refresh, and reproducibility unfalsifiable.
2. **Port the extractor to a typed `@arbor/visual-intelligence` workspace
   package.** Strictly better on ADR-027's own reasoning — `scripts/*.mjs` sits
   outside the typechecked graph, and *"a control plane asserting authority
   over the repository should not itself be the least-checked code in it."*
   Not attempted here, and the reason originally given — "a rewrite of someone
   else's code" — was factually wrong (see the correction at the top). The real
   reason is narrower: the skill is deliberately repository-agnostic, so
   absorbing it into revoy2's package graph would fight its design.
3. **Depend on the skill as an npm package.** Rejected at the time as "not
   published, nothing to depend on" — true of the state, not of the option.

4. **Give the skill its own repository and consume it as a pinned dependency.**
   The strongest option, and not available when this was written because the
   skill's ownership was misidentified. With a real repository, `npm` can take
   a pinned git dependency: CI installs it via `npm ci`, the lockfile records
   the exact commit, an upgrade is a reviewable lockfile diff, and **the
   vendored copy and its hash gate stop being necessary at all.** Provenance
   becomes a commit rather than a date. Deferred to its own decision because it
   requires creating a repository, which is the owner's call.

## Test implications

The gates are the tests: `gate:vi-vendor` must fail on an edited vendored file,
and `gate:vi-reproducible` must fail when the graph does not regenerate. Both
must be verified by breaking them deliberately rather than by observing a green
run, since a gate that passes because it measured nothing is the failure mode
this repository has hit repeatedly.

## Obligations

**None of these carry a proof comment, and that is the honest answer rather
than a gap.** Every obligation below is about behaviour in `scripts/*.mjs`, and
the proof resolver structurally cannot cite it: it searches `packages/*/src`
for *exported* symbols, while these are module-private constants and functions
in files outside the workspace graph. `roundtrip=` is equally unavailable —
vitest's collection globs are `packages/*/tests/**`, so no test file naming
these could resolve either.

Attaching a citation that merely *resolves* — pointing at some adjacent
exported symbol — would satisfy the grammar while verifying nothing, which the
gate treats as strictly worse than no citation because it converts "unverified"
into "apparently verified". ADR-025 reached the same conclusion for the same
reason about `scripts/`-scoped claims.

This is a real gap, not a technicality: it means the gates asserting authority
over this repository are themselves the least-checked code in it — precisely
what ADR-027's Alternatives #4 warned about. Closing it means either bringing
`scripts/` into the test graph or porting these to a typed package
(Alternatives #2 above). Recorded here so the next reader inherits the debt
rather than the impression of coverage.

### O1 — The extractor resolves from the repository, not from a user's home directory

<!-- proof: symbol=resolveRootArg file=scripts/vi-refresh.mjs roundtrip=scripts/tests/vi-refresh-root.test.mjs -->


### O2 — Editing a vendored file fails the build

<!-- unverifiable: scripts/vi-vendor.mjs (gate:vi-vendor) is an unexported CLI entrypoint with no top-level exported symbol; the proof grammar has no citation to attach. -->


### O3 — Divergence from upstream is reported when upstream is present, and reported as unknown when it is absent — never as agreement

<!-- unverifiable: the divergence/unknown reporting branches live in scripts/vi-vendor.mjs, which declares no exported top-level symbol for any behavior it implements. -->


### O4 — Re-vendoring rewrites the copy and its provenance together, and refuses to silently discard local edits

<!-- unverifiable: vi:vendor's update path is scripts/vi-vendor.mjs's unexported main(), so no symbol= citation can resolve against it. -->


### O5 — Reproducibility compares structure with provenance stamps excluded, because every record carries the revision

<!-- unverifiable: the stripping/key-sort comparison is graphDigest() in scripts/vi-refresh.mjs, a module-private function never exported at that file's top level. -->


### O6 — Graph staleness is bounded by a gate that runs without the extractor installed

<!-- unverifiable: scripts/vi-freshness-gate.mjs (gate:vi-freshness) declares no exported top-level symbol; it is a bare CLI entrypoint. -->


### O7 — Hook registration is opt-in and warns when a global registration would double-fire

<!-- unverifiable: scripts/vi-install-hooks.mjs declares no exported top-level symbol; it is a bare CLI entrypoint, so nothing in it can be cited. -->
