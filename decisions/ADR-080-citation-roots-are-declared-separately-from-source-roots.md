# ADR-080: Citation Roots Are Declared Separately From Source Roots

**Status:** Accepted
**Date:** 2026-08-18
**Authoring Revision:** c84c07340f3db0d99ee67f7ff0a787a9869d8a17
**Content ID:** sha256:98684dd648a61d20b2c72588f116a30319e9574a839e4a4d96453614aefd837e

## Context

`arbor.profile.jsonc`'s `source_roots` was being asked to answer two
different questions, and the two answers had drifted apart.

Most consumers read it as **"this is a package tree."**
`scripts/typecheck-tests.mjs` requires a `tsconfig.tests.json` in every
immediate subdirectory of every declared root and **fails closed** when one
is missing — deliberately, because it once silently skipped a new workspace
member and printed PASS. `scripts/anti-stub.mjs`, `packages/arbor-governance/src/artifact/scan.ts` and
`packages/arbor-governance/src/counts/derive.ts` all assume a `<root>/<pkg>/src` layout.

`deriveCitations` reads the same key as **"this is a citation-bearing
tree"** — it walks every file under each root looking for `ADR-NNN`, and
what it finds becomes a `justifies` edge. That is a weaker and different
claim: a directory can hold governed code that cites decisions without
being a package tree at all.

This repository is exactly that case. Its governance machinery lives under
`scripts/` — the ADR registry, the trace tool, the merge-critical check,
the store-freshness gate. Because `source_roots` named only `packages`,
every citation in that machinery was invisible, and six accepted records
were reported as orphans that no code governs. That was not a records
problem; the implementing code existed and cited them correctly.

The obvious repair — append `scripts` to `source_roots` — was measured and
rejected. It would have made `typecheck-tests` fail on all eight
subdirectories of `scripts/` (`lib`, `tests`, `hooks`, `anti-stub`,
`reachability`, `observation`, `branch-accounting`, `tui-catalog-parity`),
none of which is a TypeScript package, and would have added the same eight
as phantom entries to the derived package counts. A currently-green
blocking gate would have gone red in eight places to fix a reporting gap.

## Decision

Citation scanning gets its own declared list.

`buildIntentGraph` accepts `citationRoots`, and the profile gains
`citation_roots`. **Unset means "same as `source_roots`"**, so every
existing profile — and every project that never needs the distinction —
behaves byte-identically to before. This repository declares
`citation_roots: ["packages", "scripts"]` while `source_roots` stays
`["packages"]`.

The two lists are now free to disagree, which is the point: declaring a
directory citation-bearing no longer asserts it is a package.

Measured effect on this repository: orphaned records fall from 21 to 15,
and `justifies` edges rise from 373 to 503, of which 129 target `scripts/`.
No record that was governed before becomes an orphan.

## Consequences

**Easier.** A project whose governed code does not live in a package tree
can be described honestly. The six records this repository's own tooling
implements are no longer reported as ungoverned, so the orphan count starts
meaning something again rather than being dominated by a known artifact.

**Harder, and named rather than hidden.** Dangling citations rise from 14
to 23. Eight of the nine new ones are fabricated ADR numbers inside
`scripts/tests/adr-trace.test.mjs` fixtures — the same shape as the 14
already present and already tolerated, so this is a difference of degree,
not of kind. The ninth is real and was previously invisible: a production
citation at `scripts/anti-stub-rules.mjs:68` to a record number outside
this repository's registry, adopted from a sibling project's numbering.
Surfacing it is the tool working, not failing.

**A trap this decision documents.** Under a citation root, writing a
record's literal id into a comment MINTS a citation edge. The first draft
of the `citationRoots` doc comment named six records while explaining them,
and thereby made `intent.ts` read as the implementation of a record it
merely discussed — silently moving it out of the orphan set. The comment
was reworded; the hazard is general, and is why explanatory prose about
records should not spell their ids inside scanned directories.

**Not decided here.** Whether dangling citations sited only in test
fixtures should be suppressed. The check runs before the test/production
split, so a fabricated id in a fixture is reported like any other. That is
a separate change to what a dangling citation means, and it is not made
here.

## Obligations

### O1 — An unset `citation_roots` behaves exactly as before

<!-- proof: symbol=buildIntentGraph file=packages/arbor-governance/src/vi/intent.ts roundtrip=scripts/tests/citation-roots.test.mjs -->

A profile that never mentions the key resolves it to `source_roots`, so no
existing project changes behavior. Asserted byte-identically, not merely
similarly: the citation set produced with the option omitted must equal the
set produced with it set to `source_roots`.

### O2 — A declared citation root that does not exist fails conformance

<!-- unverifiable: evaluateConformance (scripts/project-conform.mjs) is a resolvable exported symbol implementing exactly this check via the "citation-roots" element's fallbackProfilePath, but no existing roundtrip test declares a nonexistent citation_root and asserts it fails while an unset key still falls back — that specific fixture has not been written. -->

`source_roots` had a `required_via_profile` element asserting its directories
exist; `citation_roots` had none, so a typo silently scanned nothing and every
record was reported as an orphan governed by no code — the bug this record
fixes, wearing a records problem as a disguise. A declared-but-absent root
must fail `gate:project-conform`, while an unset key must still pass through
the fallback.

### O3 — Widening the citation set never orphans a record that was governed

<!-- proof: symbol=profileOrDefaults file=scripts/lib/project-profile.mjs roundtrip=scripts/tests/citation-roots.test.mjs -->

Adding a root may only move records out of the orphan set, never into it.
Asserted directly over this repository: the six records ADR-033, ADR-034,
ADR-048, ADR-059, ADR-072 and ADR-075 leave the orphan set, and every record
orphaned after the widening was already orphaned before it.

<!-- proof: symbol=buildIntentGraph file=packages/arbor-governance/src/vi/intent.ts roundtrip=scripts/tests/citation-roots.test.mjs -->
<!-- proof: symbol=profileOrDefaults file=scripts/lib/project-profile.mjs roundtrip=scripts/tests/citation-roots.test.mjs -->
