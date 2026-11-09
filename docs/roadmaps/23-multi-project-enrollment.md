# Roadmap 23 — Multi-project creation, enrollment, and management

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 73fb8068 (2026-09-22)
Authority: Retained implementation brief; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — authoring-time design for multi-project enrollment (target); the brief itself relabels its former 1.0.0 spine role as historical
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22):** this brief is retained as design and implementation history. Its priorities and ordering are subordinate to the [Canopy/revoy2 1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md). Treat implementation and research claims as bounded to the evidence recorded in this brief; verify current status against code and sealed evidence before relying on them.

**Historical lane label:** this brief called multi-project enrollment the 1.0.0 spine. Current
release sequencing is defined by the linked canonical roadmap above; this brief remains design input
for cross-repository enrollment and management.

**Status of this document:** implementation brief. Nothing here is authorized by being written
down; each tranche still needs its own ADR. Every claim below was read directly from the
repository at `af3b313` on 2026-08-18 and is reproducible with the command shown.

---

## §0 The goal, stated so it can be falsified

> revoy2 can automatically and infallibly create, enroll, and manage multiple projects/repos
> within its governance system.

Three verbs. Two are partially built for an external repo and one is absent — but the
partial two stop short in a specific, checkable way:

| Verb | Means | Today |
|---|---|---|
| **Create** | scaffold a new repo already conformant to the revoy2 standard form | **overlay only** — `arbor project enroll <path> --new` |
| **Enroll** | bring an *existing* repo under governance, generating its profile and evidence stores | **overlay only** — `arbor project enroll <path>` / `--backfill` |
| **Manage** | run gates, campaigns, and evidence refresh against N repos, with a registry of which | absent |

> **Correction (2026-08-18).** The first draft of this table read "absent" for all
> three verbs. That was wrong, and wrong in this repository's characteristic
> direction: it asserted a gap without checking. `packages/arbor-mcp/src/project-lifecycle.ts`
> and the `arbor project` subcommand (`cli.ts:1572`) have existed since 2026-08-14.
> The real defect is narrower and more interesting than absence — see §2.5.

"Infallibly" is the load-bearing word and it is not decoration. This repository's entire
governance posture is that a claim without a mechanism is a liability. A multi-project harness
whose enrollment "usually works" is worse than none, because it would issue governance
guarantees over repos it never actually checked.

---

## §1 What already exists — the honest starting line

ADR-073 (`decisions/ADR-073-project-profile-and-conformance-spec.md`) did the hard conceptual
work. It separated *"this is what a revoy2-family project's shape is"* from *"this is revoy2, a
specific instance of that shape."* That distinction is the whole foundation, and it is built:

- **`arbor.profile.jsonc`** declares this repo's shape: `schema_version`, `project_id`,
  `language`, `source_roots`, `citation_roots` (ADR-080; optional, defaults to
  `source_roots` when unset — the roots the ADR-citation scan walks, a weaker claim than
  "this is a package tree"), `governance` (`decisions_dir`, `evidence_stores`, `arbor_dir`),
  and `commands` (`typecheck`, `test`, `reachability`).
- **`scripts/lib/project-profile.mjs`** loads it, with a deliberately split failure posture —
  `loadProjectProfile` throws a structured `ProjectProfileError`; a lenient path falls back to
  `DEFAULT_PROFILE`.
- **`scripts/project-conform.mjs`** checks conformance and passes today (13 checks: required,
  `required_via_profile`, and optional).

The **enrollment lifecycle** is built too, and independently of ADR-073:

- **`packages/arbor-mcp/src/project-lifecycle.ts`** — `inspectProjectOverlay`, `enrollProject`,
  `repairProjectOverlay`, with `ProjectOverlayState` of
  `not_enrolled | ready | incomplete | invalid | moved` and findings carrying `remediation` and
  a `repairable` flag.
- **`arbor project status|enroll|repair [path]`** (`cli.ts:1572`) — the operator surface, with
  `--new`, `--backfill`, `--dry-run`, `--apply`, `--json`.

So the vocabulary *and* an enrollment lifecycle both exist. What is missing is the join between
them, plus the ability to manage more than one at a time.

---

## §2 The structural blockers, each with its evidence

### B1 — The conformance function generalizes; its entry point does not — **CLOSED by W1**

`evaluateConformance(repoRoot = REPO_ROOT)` (`scripts/project-conform.mjs:86`) takes a repo
root as its first parameter. But `main()` calls `evaluateConformance(REPO_ROOT)` (line 146),
and `REPO_ROOT` is `resolvePath(__dirname, "..")` (line 29) — the revoy2 checkout the script
happens to live in. There is no `--root` flag.

The library is already multi-project. The CLI is single-project.

**Closed 2026-08-18** by `--root` (`scripts/tests/project-conform-root.test.mjs`). Retained here
because W4's acceptance test depends on it: without `--root` there is no way to ask whether a
freshly enrolled project is conformant.

### B2 — Only 4 of 30 gates consume the profile seam

```
grep -ln "project-profile" scripts/*.mjs scripts/*.ts
→ project-conform.mjs  registration-integrity.mjs  adr-trace.mjs  docs-truth.mjs
grep -oP '"gate:[a-z-]+"' package.json | wc -l
→ 30
```

ADR-073 migrated four scripts onto the seam and stopped. The other twenty-six still resolve
their own paths. Ten of them derive `REPO_ROOT` from `__dirname/..` directly; only two
(`tui-catalog-parity.mjs`, `vi-refresh.mjs`) accept a `--root`.

This is the bulk of the work and it is unglamorous: a mechanical migration, one gate at a time,
each with a regression test proving it produces the same verdict for revoy2 when pointed at
revoy2 explicitly as it does implicitly today.

### B3 — `--fix` scaffolds directories, not projects

`attemptFix` (`scripts/project-conform.mjs:126`) is the only enrollment-shaped primitive that
exists, and it is deliberately tiny. It handles `result.kind === "dir"` only, creating the
directory and a `.gitkeep`. Anything else returns:

> `{ attempted: false, reason: "not mechanically fixable (would require inventing content)" }`

That refusal is *correct* and must be preserved in spirit. Enrollment cannot fabricate a
project's `arbor.profile.jsonc` by guessing — a wrong profile silently mis-scopes every gate
that reads it. Enrollment must **derive** what it can prove (source roots by inspection,
commands by reading the manifest) and **refuse** the rest, exactly as `attemptFix` refuses now.

### B2.5 — The enrollment surface and the governance surface do not know about each other

**This is the central defect, and it is a split brain rather than a hole.**

Two independent notions of "a project" exist and neither references the other:

| | Enrollment surface | Governance surface |
|---|---|---|
| Owner | `packages/arbor-mcp/src/project-lifecycle.ts` | ADR-073 / `scripts/lib/project-profile.mjs` |
| Artifact | `.arbor/project.json` + `.arbor/{commands,skills,plans,runs}` | `arbor.profile.jsonc` |
| Entry point | `arbor project status\|enroll\|repair` | `bun run gate:project-conform` |
| Knows about the other | no | no |

The enrollment surface is genuinely good. It has an overlay manifest with a
schema version, five lifecycle states including `moved` (root-mismatch
detection), findings that carry `remediation` and a `repairable` flag,
`--dry-run`, and a `repair --apply` path. None of that needs rebuilding.

But it does not emit an `arbor.profile.jsonc`, so **an enrolled project is not
a conformant project.** Reproduced directly:

```
$ arbor project enroll /tmp/proj-new --new --json
   → creates .arbor/{commands,skills,plans,runs}, .arbor/project.json, arbor.jsonc
$ ls /tmp/proj-new/arbor.profile.jsonc
   → No such file or directory
$ node scripts/project-conform.mjs --root /tmp/proj-new
   → [FAIL] decisions-dir, decisions-registry, decisions-readme,
     evidence-claim-ledger, evidence-completion-depth, ...
```

So `arbor project enroll --new` reports success, and the project it just
created fails every required conformance element. Both halves are behaving
correctly on their own terms; nothing joins them. That is the gap.

### B4 — There is no registry of projects

`.arbor` is a per-repo state directory. Nothing anywhere records "these are the N repos under
governance." `trust.session.enroll`
(`packages/arbor-mcp/src/trust-session-contracts.ts:14`) is enrollment of a *remote worker
session*, not a project — a genuinely different noun, and reusing its machinery would be the
wrong seam.

Without a registry there is no "manage": no way to ask which projects are enrolled, which are
failing gates, or which have stale evidence.

---

## §3 Tranches

Ordered so each lands independently and leaves the tree green.

**W1 — `--root` for the conformance CLI. — LANDED 2026-08-18.** Close B1. Thread an explicit root through
`main()`, defaulting to the current behavior. Test: point it at a fixture repo with a valid
profile and at one with a malformed profile; assert the structured error. Small, and it makes
every later tranche demonstrable.

**W2 — The project registry. — LANDED 2026-08-18** (ADR-076). Close B4. A declarative registry (path, project_id, profile
hash, last-verified revision) plus the query surface to read it. Needs an ADR: the registry is
a new durable governance artifact and its authority model is a real decision — in particular
whether a registry entry is a *claim* (subject to the claim ledger) or a *fact*.

**W3 — Gate migration onto the profile seam. — PARTIAL.** Close B2, in batches. Each migrated gate gets a
test asserting root-explicit and root-implicit verdicts agree for revoy2. This is where
"infallibly" is actually earned; a gate that silently resolves the wrong root under a second
project is precisely the false-guarantee failure §0 names.

**W4 — Join enrollment to conformance. — LANDED 2026-08-18.** Close B2.5, the central defect. `enrollProject`
additionally derives and writes an `arbor.profile.jsonc`, seeds the evidence stores the profile
declares, and registers the result (W2). Derivation must refuse what it cannot prove — source
roots by inspection, commands by reading the manifest — preserving `attemptFix`'s existing and
correct refusal posture. **The acceptance test is the reproduction in B2.5 inverted:** a freshly
enrolled project passes `project-conform --root <path>`. Today it fails every required element.

> **How the anti-drift property was actually established.** ADR-073 anticipated that a
> scaffolder would consume `CONFORMANCE_SPEC`/`resolveElementTargets` directly, "which is what
> prevents the checker and the scaffolder from silently drifting apart." The implementation does
> not import them — `packages/arbor-mcp` taking a dependency on `scripts/lib` would invert the
> package boundary. The property is instead held by a **coupling test**:
> `scripts/tests/project-conform-enrollment.test.mjs` runs the real `evaluateConformance`
> against a really-enrolled project, so any element added to `CONFORMANCE_SPEC` that enrollment
> does not produce fails immediately. Verified by injecting a new `required` element into the
> spec: the acceptance test failed, and passed again on restore. Different mechanism from the one
> ADR-073 imagined, same guarantee, and without the bad dependency.

**W5 — `create` becomes a real guarantee. — LANDED with W4.** `--new` already scaffolds an overlay; once W4 lands
it scaffolds a *conformant* project. Mostly falls out of W4 rather than being separate work,
which is the opposite of what this roadmap's first draft assumed.

**W6 — Multi-project management surface. — LANDED 2026-08-18.** Run a gate battery across the registry; report
per-project status. Only meaningful once W1–W4 hold.

---

## §4 What this roadmap deliberately does not decide

- **Whether governance state is centralized or federated.** W2 needs an ADR and this brief does
  not pre-empt it. A central registry with per-repo `.arbor` state is the obvious shape, but
  "obvious" is not "decided."
- **How a non-TypeScript project runs its gates.** `commands` in the profile are bare
  package.json script names today. A Python or Rust project needs a different invocation model,
  and ADR-073's schema does not yet express one. This blocks nothing until a second project
  actually exists, which is why it is named rather than solved.
- **The 1.0.0 API surface itself.** Per SemVer, `1.0.0` is what *defines* the public API as
  stable. `package.json` is at `0.2.0`. Cutting 1.0.0 is a separate decision that should follow
  this capability, not accompany it.

---

## §5 The honest risk

The temptation in W3 is to migrate gates quickly by threading a root parameter and calling it
done. That would produce a harness that *accepts* a second project and quietly checks the wrong
files — every gate green, every guarantee void. The whole value of this repository is that its
gates state what they do and do not prove. A multi-project gate must prove it read the second
project's files, and the regression test for each migration is the only thing that can
establish it.

---

## §6 Known limits of the delivered capability

Recorded here rather than left in commit messages, because "infallibly" in §0 is
only meaningful if the places it does not yet hold are written down.

**L1 — PARTIALLY CLOSED 2026-08-18.** `ProjectRegistryReport` now carries `present`, so
an absent registry file reads differently from one legitimately holding zero entries.
Making absence *fail* is still blocked on the centralized-vs-federated decision — see
`docs/proposals/l1-project-registry-ci-visibility.md`. Original text follows.

**L1 — CI sees an empty registry, so the registry gate passes trivially there.**
`.arbor/` is gitignored, correctly: registry entries hold machine-specific absolute
paths, and committing them would be meaningless across checkouts. The consequence is
that `gate:project-registry` on a fresh clone or a CI runner evaluates zero entries and
passes. The gate's own strength statement says this ("An empty registry passes
trivially; that is a fact about how many projects are governed, not evidence that none
should be"), so it is honest rather than hidden — but it means registry discharge is an
operator-local guarantee, not a CI-enforced one. Closing it needs a decision about where
durable multi-project state lives, which is exactly the centralized-vs-federated
question ADR-076 explicitly declined to settle.

**L2 — CLOSED 2026-08-18.** `enroll --new` now `git init`s and makes an initial commit
for a target it scaffolds from nothing, so the most natural first command produces a
registered project. An existing repository is structurally unreachable: the `.git` check
runs before any git subprocess. Original text follows.

**L2 — `enroll --new` does not `git init`, so a brand-new project is enrolled but
unregistered.** `registerProject` refuses without a resolvable git revision rather than
fabricating provenance, which is the correct refusal. But it means the most natural
first command produces a conformant, enrolled, *unregistered* project until the operator
commits and re-enrolls. Either enrollment should initialise a repository, or the flow
should tell the operator the second step is required. Today it reports the refusal and
leaves it there.

**L3 — the VI pipeline is not fully retargetable.** `vi-refresh --root` runs step 1 and
the entry-points guard against a foreign project and then stops, naming the steps it
cannot honor, because `scripts/vi-emit.ts` hardcodes its own repo root. Stopping is the
right behavior — continuing would silently merge revoy2's own `decisions/` corpus into
another project's graph — but it means visual intelligence remains single-project.

**L4 — five gates are not retargetable, two of them permanently.**
`roundtrip-shape` and `anti-stub-rules` have no path resolution to migrate at all.
`closed-enum-hygiene` and `install-git-hooks` are inherently repo-specific on evidence:
the first cross-validates named documents about revoy2's own governance vocabularies,
the second installs hooks whose bodies invoke revoy2-specific gate scripts, so a `--root`
there would install hooks that fail immediately. `live-provider-soak` runs this repo's
own campaign bin. `arbor project manage` reports each of these as `not_applicable` with
a reason rather than counting them as passes, which is the honest handling of a gate that
cannot speak about another project.

---

## §7 End-to-end demonstration (2026-08-18)

Run against the real CLI at `714d4067`, from an isolated governing directory so it wrote
no state into this repository. Recorded because §0 says "infallibly", and a capability
claim with no transcript behind it is the shape this whole document exists to distrust.

**Create** — `arbor project enroll <dir> --new` on an empty directory produced
`state: ready`, `profile: created`, `registered: true` with a resolved revision, and the
scaffold below. `project-conform --root <dir>` then **PASSED** — the B2.5 defect state,
where enrollment succeeded and conformance failed 17 of 17 required elements, is closed.

```
AGENTS.md  arbor.jsonc  arbor.profile.jsonc  decisions/README.md
.arbor/{project.json,commands,plans,runs,skills}  .claim-ledger  .completion-depth
```

**Enroll (backfill)** — a second, pre-existing repo with its own `package.json` and
`src/` was enrolled to `state: ready`, derived `commands.typecheck`/`commands.test` from
its real scripts, and **refused** `commands.reachability` because it declares no such
script. Registration itself was refused `conformance_failed`: backfill will not fabricate
a decisions corpus for someone else's repository. Both refusals are the designed
behavior, not failures.

**Manage** — `arbor project manage` over the registry reported, for the one registered
project: `discharge_ok: true`, six retargetable gates discovered, and per-gate outcomes

| status | count | gates |
|---|---|---|
| `pass` | 3 | `project-conform`, `anti-stub:blocking`, `typecheck-tests` |
| `fail` | 3 | `lockfile`, `tui-catalog-parity`, `vi-reproducible` |
| `not_applicable` | 22 | every gate that cannot target another project |

The three failures are correct: a minimal scaffold has no lockfile, no TUI catalog, and
no committed VI graph. The 22 `not_applicable` are the load-bearing number — none of them
is counted as a pass, which is the §5 property that makes this a guarantee rather than a
green light.

**Known gap this exposed.** `manage`'s output does not surface the `present` field L1
added, so a run against an absent registry is not distinguishable in that view. Named as
a follow-up in `docs/proposals/l1-project-registry-ci-visibility.md`; verified here as
`registry present: None` in the JSON.
