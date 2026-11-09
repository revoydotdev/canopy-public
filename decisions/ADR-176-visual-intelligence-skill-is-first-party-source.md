# ADR-176: The Visual-Intelligence Skill Is First-Party Source, Not a Vendored Copy

**Status:** Accepted
**Date:** 2026-09-29
**Authoring Revision:** 9c5265ad0e0271f4f94162f4aabcd5ab0a9e287a
**Content ID:** sha256:cd4cfb62588e75af44780a8d48778dc0c3c6305f23b72aed71aa778ba46f492e

## Context

This record supersedes ADR-031 ("The Visual-Intelligence Skill Is Vendored Into
the Repository").

ADR-031 moved the `repository-visual-intelligence` skill into
`.claude/skills/repository-visual-intelligence/` so the committed graph could be
regenerated and verified from a checkout. That part was right and stays. What
it also did was model the directory as a *copy* of an original living at
`~/.claude/skills/repository-visual-intelligence`: its VENDOR.md rule 1 forbade
editing the files in place, its VENDOR.json pinned a SHA-256 per file, and
`gate:vi-vendor` blocked the build on any edit, with the remedy "make the change
upstream and re-vendor (`bun run vi:vendor`)".

ADR-031's own pre-acceptance correction already established that the skill is
the repository owner's work, not a third party's. The model survived that
correction anyway, and on 2026-09-29 it stopped describing anything real:

- **There is no upstream.** `~/.claude/skills/repository-visual-intelligence`
  does not exist on the operator's workstation. `gate:vi-vendor` reports
  "upstream installed: no", so `vi:vendor` — the only sanctioned way to change
  the files — cannot run. The rule "change the original" names a file that does
  not exist.
- **The files are already being changed here, correctly.** The 2026-09-28 work
  on the skill's `vi-extract-ts.mjs` and `graph-manifest.schema.json`
  (`f0027d72`, `90b1af6c`, merged in `f50c56f3`) fixed real extraction defects
  in the only copy there is. `gate:vi-vendor` then blocked every push from
  master for having done so.
- **The operator ruled on it directly.** On 2026-09-29 the operator stated:
  "repository-visual-intelligence is not vendored, its ours."

## Decision

**`.claude/skills/repository-visual-intelligence/` is first-party source code
of this repository. It is edited in place, reviewed like any other source, and
is not a copy of anything.**

Retired with the vendored model:

- the skill's VENDOR.md and VENDOR.json, the vi-vendor.mjs script, the `gate:vi-vendor` and
  `vi:vendor` scripts, and `gate:vi-vendor`'s entries in
  `scripts/execution-profile.json` (including its role as a prerequisite of
  `gate:vi-reproducible` and `gate:vi-prepush-policy`) and
  `scripts/gate-manifest.json`.
- The directory's `vendored_sources` entry in
  `scripts/reuse-compliance-policy.json`: it is not reused third-party code, so
  it carries no reuse inventory or attribution obligation.

Retained from ADR-031, restated here so nothing it established is lost:

- `scripts/vi-refresh.mjs` resolves the extractor from the repository, never
  from `$HOME`.
- `gate:vi-reproducible` regenerates the graph and compares structure.
- The skill's hooks remain installable project-locally via
  `bun run vi:install-hooks`.

Drift between two copies — the risk ADR-031 built the hash gate against — is
removed at the root rather than detected: there is one copy. If a copy is ever
installed under `~/.claude/skills/` again, it is downstream of this directory.

## Consequences

- Fixes to the extractor, templates and hooks land where they are exercised,
  with ordinary review and the ordinary test and gate battery, instead of being
  blocked by a gate whose remedy cannot run.
- The integrity signal ADR-031 provided (a hash per file) is gone. Git history
  is the record of change for this directory, as it is for every other source
  directory.
- ADR-032's hook-liveness wrapper (`.hook-liveness/wrap.sh`) was built around
  the rule that the hooks could not be edited. That rule no longer holds, but
  the wrapper is still correct and its liveness evidence is unaffected, so it
  stays; folding the instrumentation into the hooks is now permitted, not
  required. ADR-032 remains Accepted and is not amended by this record.
- Comments elsewhere that describe these files as "not editable (VENDOR.md
  rule 1 / ADR-031)" are corrected in the same change.

## Alternatives / Roads not taken

- **Re-hash in place (`vi:vendor` or a hand-rewritten VENDOR.json).**
  Blesses the 2026-09-28 edits but keeps a model the operator has said is
  false, and the next fix would be blocked again. `vi:vendor` cannot run
  anyway: it copies from an upstream that does not exist.
- **Recreate `~/.claude/skills/repository-visual-intelligence` as the
  original.** Restores the literal preconditions of ADR-031 by moving the
  source of truth off the repository and onto one workstation — the exact
  problem ADR-031 was written to solve.
- **Keep the gate as advisory.** An advisory check for a condition that is not
  a defect is noise; editing first-party source is not a finding.

## Obligations

### O1 — ADR-031 carries a back-reference naming this record

A reader arriving at ADR-031 must be able to see, without leaving the file,
that its vendoring model is superseded and by which ADR.

<!-- unverifiable: an ADR cross-reference is a documentation-integrity property of the corpus, not a behaviour any exported symbol can witness; gate:adr-retirement-integrity checks the supersession in both directions. -->

### O2 — No gate or script treats the directory as a vendored copy

`gate:vi-vendor`, `vi:vendor` and the vi-vendor.mjs script do not exist, and the
directory has no `vendored_sources` entry in the reuse-compliance policy.

<!-- unverifiable: this obligation is the absence of a gate, script and policy entry; no exported symbol can witness an absence. gate:execution-profile rejects a profile naming an undefined script, and gate:reuse-compliance reads the policy directly. -->
