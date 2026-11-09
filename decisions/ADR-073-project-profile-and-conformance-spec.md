# ADR-073: Project Profile and Conformance Spec

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** b344364baa78765579b61bdd44917ad9c26b68b6
**Content ID:** sha256:2e36a9ca389f94c7359475342b34897d0558447ed9f65da5f80b626664f7a666

## Context

The cycle-4 conformance manifest (qa-bench/manifests/CONFORMANCE-MANIFEST.md
— external research-tooling output, never checked into this repository)
identified D5: this repository's structural facts were hardcoded literals,
so no second project could conform to "the revoy2 standard form" even in
principle. Two pieces of reproduced evidence:

- `packages/arbor-governance/tests/obligation/portability.test.ts:68`
  asserted `expect(root).toMatch(/revoy2/)` — a portability test that
  matched the *directory name* the repo happened to be checked out under,
  not anything about the repo itself. It failed in every worktree not
  literally named `revoy2`. Two independent cycle-4 build agents had
  already reported this exact failure and, lacking the context this ADR
  now records, dismissed it as "pre-existing, unrelated" rather than
  tracing it to its cause. This worktree (`wt-cony`) is itself one such
  differently-named checkout, which is what makes it usable as the
  regression proof below.
- Ten scripts (`anti-stub-rules`, `roundtrip-shape`, `closed-enum-hygiene`,
  `tui-catalog-parity`, `anti-stub`, `live-provider-soak`,
  `lockfile-check`, `docs-truth`, `vi-refresh`, `registration-integrity`)
  hardcoded a `packages/` source-root prefix directly in their logic, with
  no declared seam a differently-shaped project could override.

Both symptoms share one root cause: nothing in the repository declared,
machine-readably, "this is what a revoy2-family project's shape actually
is" separately from "this is revoy2, a specific instance of that shape."
Without that declaration, every script that needed to know the repo's
layout had no choice but to assume it was talking to this exact checkout.

## Decision

### Y-1: `arbor.profile.jsonc` + `scripts/lib/project-profile.mjs`

A new root-level `arbor.profile.jsonc` declares this repo's shape:
`schema_version`, `project_id`, `language`, `source_roots`, a `governance`
block (`decisions_dir`, `evidence_stores`, `arbor_dir`), and a `commands`
block (`typecheck`, `test`, `reachability`, as bare package.json script
names). It describes revoy2 as it already is — authoring it required no
change to the repo's actual layout.

`scripts/lib/project-profile.mjs` exports two entry points with
deliberately different failure postures. `loadProjectProfile(repo)` is
strict: it throws a `ProjectProfileError` carrying a structured
`errors: [{path, message}]` array (never a bare thrown string) on a
missing file, invalid JSONC, or a validation failure, and otherwise
returns a deeply frozen profile with every omitted field filled from
`DEFAULT_PROFILE`. `profileOrDefaults(repo)` never throws — it wraps
`loadProjectProfile` and falls back to `DEFAULT_PROFILE` on any failure at
all, including simple absence. `DEFAULT_PROFILE` intentionally encodes the
exact hardcoded assumptions the pre-profile scripts made (`source_roots:
["packages"]`, the four evidence-store directories, `.arbor` as the arbor
state dir), which is what makes `profileOrDefaults` a true no-op for a
repo — or a temporary state of this repo — with no `arbor.profile.jsonc`.

### Y-2: `scripts/lib/conformance-spec.mjs` + `scripts/project-conform.mjs`

`CONFORMANCE_SPEC` is one frozen array of `{id, kind, target, requirement,
remedy}` elements — `kind` is `dir` | `file` | `script` | `marker`;
`target` is either a literal path/script-name string or `{profilePath:
"dotted.path"}` naming a field to resolve against the loaded profile at
evaluation time. `resolveElementTargets(element, profile)` is the single
function that interprets `{profilePath}`; both the checker
(`evaluateConformance` in `scripts/project-conform.mjs`) and any future
scaffolder call it rather than re-deriving a path independently, which is
what keeps the spec a genuine single source of truth rather than a second,
driftable copy of the element list.

Classification is honest, not aspirational: `decisions/`, the four
evidence stores, `.arbor/`, the `AGENTS.md` governance-count marker, and
the three named gate scripts are `required` — structural facts this repo
genuinely has that any revoy2-family repo is expected to carry regardless
of profile. `arbor.profile.jsonc` itself is `required` for the same
reason (the whole point of this ADR is that a revoy2-family repo declares
one). `source_roots` and the three `commands` entries are
`required_via_profile` — their correct value legitimately varies by
project (a Rust sibling's source roots and typecheck command look nothing
like this repo's). `.claude/`, `ROADMAP.md`, `CHANGELOG.md`, `audit/`, and
`.hook-liveness/` are `optional` — Claude-Code-workflow or revoy2-specific
extras a sibling project plausibly would not have; they are reported but
never block the gate.

`bun scripts/project-conform.mjs` (`gate:project-conform`) evaluates every
element and exits non-zero only when a `required` or `required_via_profile`
element is unmet. `--fix`'s entire repair vocabulary is: create a missing
`dir`-kind element's target directory and drop an empty `.gitkeep` inside
it. It never touches `file`, `script`, or `marker` elements — those would
require inventing content (an ADR index, a wired script, a rendered
marker) that only a human or a real scaffold run can honestly produce.
Anything `--fix` cannot repair is reported as unfixable, never silently
skipped.

### Y-3: De-literalizing `docs-truth.mjs` and `registration-integrity.mjs`

`docs-truth.mjs`'s `checkPathCitation` tried a cited path both bare and
with a hardcoded `packages/` prefix (citations conventionally elide their
directory). It now tries the bare path plus each of
`profileOrDefaults(REPO_ROOT).source_roots` prefixed, in order.
`registration-integrity.mjs` located five well-known `arbor-mcp` source
files under a hardcoded `packages/arbor-mcp/src/` prefix; the new
`arborMcpSrcPaths(sourceRoots)` derives the same five paths from the first
declared source root. Both are proven byte-identical on this repo with a
real subprocess-level test (`scripts/tests/docs-truth-registration-
integrity-portability.test.mjs`) that runs each script's `--json` output
twice — once with the real `arbor.profile.jsonc` present, once with it
moved aside — and asserts the stdout is identical either way. Since this
repo's profile declares `source_roots: ["packages"]`, the same value
`DEFAULT_PROFILE` supplies when no profile exists, both code paths resolve
to the exact same strings.

The other eight scripts named in the manifest's D5 evidence
(`anti-stub-rules`, `roundtrip-shape`, `closed-enum-hygiene`,
`tui-catalog-parity`, `anti-stub`, `live-provider-soak`, `lockfile-check`,
`vi-refresh`) still hardcode `packages/`. Migrating them is explicitly out
of this change's bounded scope — a follow-up, not a silent omission.

### Y-3a: The portability test

`portability.test.ts`'s `resolveRepoRoot` regression test no longer
asserts `expect(root).toMatch(/revoy2/)`. It instead reads the resolved
root's own `package.json` and asserts `pkg.name === "revoy2"` — identity
derived from a fact about the repository, not from the path it happens to
be checked out at. This passes in any worktree regardless of directory
name; it is verified passing in this very worktree (`wt-cony`), which is
the regression proof the manifest called for.

### ADR-073's own scope boundary

This standard form — the profile seam, the conformance spec, and the
governance corpus it checks for (`decisions/`, the evidence stores,
`.arbor/`) — applies to revoy2-**family** repositories: repos that adopt
this repo's governance model as their own. It does **not** apply to a
foreign repository that arbor merely operates on as an integration or
automation target. An enrolled foreign target gets only `.arbor/` state
and (if it opts in) its own `arbor.profile.jsonc`; it never gets a copy of
this repo's `decisions/` corpus, evidence stores, or ADR machinery — those
are revoy2-family governance, not something arbor imposes on every repo it
touches.

## Consequences

**The profile is the invariant/varied seam, made explicit rather than
implicit.** Before this ADR, "what shape must a revoy2-family repo have"
existed only as an unstated set of assumptions baked into individual
scripts. Now it is one declared file plus one declared spec, checkable by
one gate. A sibling project in another language can be structurally
identical to this one by authoring its own `arbor.profile.jsonc` and
satisfying `CONFORMANCE_SPEC`'s `required`/`required_via_profile`
elements — it does not need TypeScript, npm, or a `packages/` layout to do
so, only the same governance corpus shape and a profile describing its own
layout and command wiring.

**The spec is the single source for both check and scaffold.**
`CONFORMANCE_SPEC` and `resolveElementTargets` are consumed directly by
`evaluateConformance` today; a future scaffolder (not built in this
change) consumes the identical exported objects rather than a
re-derived copy, which is what prevents the checker and the scaffolder
from silently drifting apart the way the original hardcoded scripts
drifted from any declared standard at all.

**The scaffolder was built 2026-08-18** (`enrollProject` plus
`project-profile-derivation.ts`, Roadmap 23 W4), and the anti-drift property
this paragraph names is held — but by a different mechanism than it predicted.
The scaffolder does **not** import `CONFORMANCE_SPEC`: `packages/arbor-mcp`
taking a dependency on `scripts/lib` would invert the package boundary.
Instead a coupling test runs the real `evaluateConformance` against a
really-enrolled project, so any element added to the spec that enrollment does
not produce fails immediately. Verified by injecting a new `required` element
into the spec and watching the acceptance test fail, then pass on restore.
Same guarantee, without the inverted dependency.

**Eight scripts remain hardcoded — a named, bounded follow-up, not a
silent gap. CLOSED 2026-08-18.** The eight were `anti-stub-rules.mjs`,
`roundtrip-shape.mjs`, `closed-enum-hygiene.mjs`, `tui-catalog-parity.mjs`,
`anti-stub.mjs`, `live-provider-soak.mjs`, `lockfile-check.mjs`, and
`vi-refresh.mjs`. Their disposition, each on evidence:

- **Migrated with `--root` and a retargeting test**: `anti-stub.mjs`,
  `lockfile-check.mjs`, `tui-catalog-parity.mjs`, `vi-refresh.mjs`
  (plus `typecheck-tests.mjs`, which was not on the original list).
- **Not applicable**: `roundtrip-shape.mjs` and `anti-stub-rules.mjs` have no
  path resolution at all — they are pure functions over an already-parsed
  `SourceFile`, so there was nothing to migrate.
- **Inherently repo-specific, deliberately unmigrated**: `closed-enum-hygiene.mjs`
  cross-validates named documents about revoy2's own governance vocabularies,
  and `live-provider-soak.mjs` runs this repository's own campaign bin. A
  `--root` on either would be a hollow flag. `arbor project manage` reports
  both as `not_applicable` rather than counting them as passes.

`vi-refresh.mjs` needed more than a prefix swap, exactly as this paragraph
predicted: `scripts/vi-emit.ts` hardcoded its own repo root, and
`@arbor/governance` hardcoded the decisions directory, the waiver allowlist,
`ROADMAP.md` and the gap register. All are now options — `decisions_dir` and
`allowlist_path` promoted to the profile schema as universal facts, the other
two left as options precisely because a roadmap and a gap register are not.
A cross-contamination test asserts a foreign project's graph carries its own
records and none of revoy2's.

Related but distinct, and still open: several scripts assume a `packages/*/src`
shape rather than a bare source-root prefix. That is Roadmap 23's B2, the
`source_roots` seam, not this follow-up.

**Back-compat is a proven property, not an assertion.** Every caller that
now reads `profileOrDefaults(...).source_roots` is proven byte-identical,
on this real repository, whether or not `arbor.profile.jsonc` exists on
disk (`scripts/tests/docs-truth-registration-integrity-portability.test.mjs`
runs both scripts' real `--json` output twice, with the profile file
present and then moved aside, and asserts equal stdout). A repo that never
adopts a profile — or hits a temporarily broken one — sees the exact
behavior it had before this ADR; `loadProjectProfile`'s validation
failures never leak into a caller using `profileOrDefaults`.

## Obligations

### O1 — `profileOrDefaults` never throws; `loadProjectProfile` validates and freezes with documented defaults

<!-- proof: symbol=profileOrDefaults file=scripts/lib/project-profile.mjs roundtrip=scripts/tests/project-profile.test.mjs -->

`profileOrDefaults(repo)` returns `DEFAULT_PROFILE` for a repo with no
`arbor.profile.jsonc`, an unreadable one, invalid JSONC, or a profile that
fails validation — proven directly against all four cases, plus a
nonexistent repo path. `loadProjectProfile(repo)` throws a structured
`ProjectProfileError` (an `errors: [{path, message}]` array, never a bare
string) on the same failure modes, and returns a deeply frozen,
per-field-defaulted profile on success, verified against this repository's
own real `arbor.profile.jsonc`.

### O2 — `CONFORMANCE_SPEC` and its target resolver are the single source both the checker and a future scaffolder consume

<!-- proof: symbol=resolveElementTargets file=scripts/lib/conformance-spec.mjs roundtrip=scripts/tests/conformance-spec.test.mjs -->

Every element of the frozen `CONFORMANCE_SPEC` array carries `id`, `kind`
(one of `dir`/`file`/`script`/`marker`), `target`, `requirement` (one of
`required`/`required_via_profile`/`optional`), and `remedy`.
`resolveElementTargets` is the one function that interprets a
`{profilePath}` target against a profile, resolving array fields to every
entry, string fields to a single-element array, and an unset field to `[]`
— verified against both literal and profile-derived targets, including a
profile that omits or empties the referenced field.

### O3 — `evaluateConformance` classifies every element honestly and the gate blocks only on unmet required/required_via_profile elements

<!-- proof: symbol=evaluateConformance file=scripts/project-conform.mjs roundtrip=scripts/tests/project-conform.test.mjs -->

`evaluateConformance(repoRoot)` reports `ok:true` for every `required` and
`required_via_profile` element on this real repository, correctly
classifies `decisions-dir`/`profile-file`/`gate-project-conform` as
`required`, `source-roots`/`command-typecheck` as `required_via_profile`,
and `claude-dir`/`roadmap-md` as `optional` — and on a fixture missing
every required element, every optional element still reports `ok:false`
without ever appearing in the blocking set, proving optional elements
never gate the run.

### O4 — `--fix` performs only mechanically safe directory creation and never invents file, marker, or script content

<!-- proof: symbol=attemptFix file=scripts/project-conform.mjs roundtrip=scripts/tests/project-conform.test.mjs -->

`attemptFix(repoRoot, result)` creates a missing `dir`-kind element's
target directory plus a `.gitkeep` inside it, and re-evaluating afterward
reports that element `ok:true`. For `file`, `marker`, and `script`-kind
unmet elements — a missing `decisions/registry.json`, an unmet
`AGENTS.md` marker, an unwired `gate:adr-registry` script — `attemptFix`
returns `attempted:false` and creates nothing, verified directly against
all three cases plus the already-satisfied no-op case.

### O5 — `docs-truth.mjs`'s path-citation resolver is profile-derived and byte-identical to the previous hardcoded prefix on this repo

<!-- proof: symbol=checkPathCitation file=scripts/docs-truth.mjs roundtrip=scripts/tests/docs-truth-registration-integrity-portability.test.mjs -->

`checkPathCitation` resolves a cited path against the bare path plus each
of `profileOrDefaults(REPO_ROOT).source_roots` prefixed, rather than a
hardcoded `packages/` prefix. `docs-truth.mjs --json`'s full output on
this repository is byte-identical whether `arbor.profile.jsonc` is present
or moved aside, proven with a real subprocess run of the actual script
against the actual repository — not a fixture and not a mock.

### O6 — `registration-integrity.mjs`'s arbor-mcp source paths are profile-derived and byte-identical to the previous hardcoded prefix on this repo

<!-- proof: symbol=arborMcpSrcPaths file=scripts/registration-integrity.mjs roundtrip=scripts/tests/docs-truth-registration-integrity-portability.test.mjs -->

`arborMcpSrcPaths(sourceRoots)` derives the five well-known `arbor-mcp`
source file paths from the first declared source root
(`arborMcpSrcPaths(["packages"])` returns exactly the five paths the code
previously hardcoded). `registration-integrity.mjs --json`'s full output
on this repository is byte-identical whether `arbor.profile.jsonc` is
present or moved aside, proven the same way as O5.

### O7 — The portability test derives repo identity from a fact about the repo, not the checkout's directory name

<!-- proof: symbol=resolveRepoRoot file=packages/arbor-governance/src/obligation/proof.ts roundtrip=packages/arbor-governance/tests/obligation/portability.test.ts -->

`resolveRepoRoot`'s regression test reads the resolved root's own
`package.json` and asserts `name === "revoy2"`, rather than matching the
literal string `revoy2` against the checkout path. The test passes in
this worktree (`wt-cony`), which is checked out under a directory name
that would have failed the old assertion — the regression proof the
manifest required.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority
separate from the implementation and authoring authority used in this
tranche.
