# ADR-025: The BLOCKED Tier Requires Platform Branch Protection revoy2 Does Not Have

**Status:** Accepted
**Date:** 2026-08-04

## Context

Phase 6's strength ladder (ROADMAP.md, "Strength ladder — be honest about what
each mechanism buys") defines three tiers:

- **PREVENTED** — the type system cannot express the defect.
- **BLOCKED** — expressible, but the build or CI refuses to merge it.
- **DETECTED** — expressible and mergeable, but a test fails loudly.

Six tranches claim **BLOCKED**: 6.1 (entry-point manifest), 6.2 (reachability
gate), 6.6 (seam contract — the contract-shape half only), 6.7 (docs-truth),
6.8 (CI itself), and 6.9 (coverage floors).

The exhaustive implementation audit (`audit/20-gate-honesty.md`, cross-cutting
finding) queried the repository's actual GitHub state directly:

```
$ gh api repos/revelri/revoy2/branches/master/protection
{"message":"Upgrade to GitHub Pro or make this repository public to enable
this feature.","status":403}

$ gh api repos/revelri/revoy2/rulesets
{"message":"Upgrade to GitHub Pro or make this repository public to enable
this feature.","status":403}
```

`revoydotdev` is on GitHub's free plan and the repo is private. Private repos
on the free plan cannot configure branch protection or rulesets at all —
there is no required-status-checks configuration, so nothing on GitHub's side
converts a red CI run into a refused merge or a refused direct push to
`master`. `.github/workflows/ci.yml` genuinely runs, genuinely computes the
correct verdict, and genuinely goes red on a real violation — that machinery
is not in question. What is missing is the enforcement step *after* red: a
human or an agent can merge or push straight past a failing run today, and
nothing stops them.

This is exactly the shape Phase 6 exists to catch, applied one layer up: a
document (ROADMAP.md) asserting a state (merge refusal) nothing currently
contradicts, because nothing currently exercises it. Claiming BLOCKED where
only a weaker property is achieved is the audit's own words back at itself —
ROADMAP.md's own preamble warns "Claiming PREVENTED where only DETECTED is
achievable is itself an unwitnessed claim."

## Decision

**Introduce a fourth strength tier, REPORTED, and retag the six affected
tranches to it.** REPORTED sits between DETECTED and BLOCKED:

- **REPORTED** — expressible and mergeable; a dedicated gate (not a semantic
  test buried in the general suite) computes the correct verdict and turns
  CI red on violation, but nothing on the merge path refuses it. Enforcement
  depends on a disciplined human or agent reading the run and declining to
  merge past it. This is what every currently-BLOCKED-claiming tranche in
  this repo actually delivers today.

This is Route 1 from the two the remediation brief offered ("add a fourth
rung that names what is actually delivered, and re-tag the affected
tranches" vs. "redefine BLOCKED and introduce a separate ENFORCED rung").
Route 1 was chosen over Route 2 because it is non-destructive: BLOCKED keeps
its original, correct definition ("the build or CI refuses to merge it") so
the tag remains meaningful and reusable the day real enforcement lands,
rather than requiring a second rename when that day comes. Nothing in this
repo currently earns BLOCKED under either route's wording — the practical
outcome is identical; Route 1 costs less churn.

**Two routes to real BLOCKED exist, and this ADR does not choose between
them — that is an operator decision, not engineering work:**

1. **Make the repository public.** GitHub enables branch protection rules
   (not full rulesets) on public repos regardless of plan. Trade-off: the
   clean-room provenance work, ADRs, and any pre-release material become
   world-readable.
2. **Put the `revoydotdev` org on a paid GitHub plan** (Team or higher).
   Trade-off: recurring cost, no code or design change required.

Neither requires this repository's code to change, and neither is something
an agent working inside the repo can decide on the operator's behalf — it is
recorded here as a known, costed choice, not left as an implicit gap the next
audit has to rediscover.

**Ship the enforcement that is achievable without either route: a local
`pre-push` git hook running the four blocking gates**
(`gate:reachability`, `gate:docs-truth`, `gate:lockfile`,
`gate:typecheck-tests`) plus `npm run build`. This gives real local refusal —
a push is aborted if any of them fail — for any contributor who has installed
the hook. It is explicitly *not* BLOCKED in the ladder's sense: it protects
only the machine that installed it, and `git push --no-verify` bypasses it
by design (a standard, well-known git escape hatch, not a defect). Both
properties are documented in the hook's own installer output and in
AGENTS.md, so this mechanism cannot itself become an overstated safeguard —
the exact defect this ADR exists to close would simply recur one layer down
if it did.

## Consequences

**Positive:**

- ROADMAP.md's strength ladder no longer claims an enforcement property that
  cannot be demonstrated on this repository as configured today.
- The two real paths to true BLOCKED are named, costed, and attributable to
  an operator decision rather than buried in a "someday" comment.
- Contributors who install the pre-push hook get real, immediate local
  refusal on the four gates that matter most — closer to the ladder's spirit
  than CI-only reporting, without requiring a plan upgrade or a public repo.

**Negative:**

- REPORTED is a genuinely weaker guarantee than BLOCKED, and this ADR does
  not close that gap — it only stops mis-describing it. Until one of the two
  routes above is taken, a disciplined-human/agent step remains the only
  thing between a red run and a merged one on the canonical (non-hook) path.
- The pre-push hook only protects pushes from machines that installed it;
  it is opt-in per clone and provides no protection against a contributor
  who never runs the installer, or who uses `--no-verify` carelessly rather
  than deliberately.

**Neutral:**

- No gate's underlying logic changes. This ADR is a documentation-accuracy
  and local-tooling decision, not a gate-strength decision — the six
  retagged tranches' actual mechanisms (the reachability walk, the
  docs-truth checker, the lockfile check, the typecheck-tests gate, CI's
  sequencing, the coverage thresholds) are unchanged and unweakened.

## Test implications

- No runtime test is implied by the tier rename itself (documentation-only).
- `scripts/install-git-hooks.mjs` is a repo-root utility script outside
  `packages/*/src`, the same category as `scripts/reachability.mjs` and
  `scripts/docs-truth.mjs` — none of which are vitest-covered
  (`vitest.config.ts`'s `include` is scoped to `packages/**/tests/**`); they
  are verified by running them for real, the same convention this repo
  already uses for its other gate scripts. Verified directly against a
  scratch `git init` repo (not this repository's own hooks, to avoid a side
  effect on the operator's checkout as a side effect of writing this ADR):
  first install writes an executable `pre-push` containing the marker
  comment; a second install is a no-op ("already up to date"); installing
  over a foreign pre-existing hook (no marker) refuses with exit code 1
  rather than overwriting it.

## Alternatives considered

1. **Do nothing; leave the six tranches claiming BLOCKED.** Rejected — this
   is the exact overclaim the audit flagged and this ADR exists to correct.
2. **Redefine BLOCKED to mean "CI computes and reports red" and introduce a
   new ENFORCED tier for true platform refusal (Route 2).** Rejected in
   favor of Route 1: redefining an existing, already-understood term out
   from under itself is more disruptive to a document with two dozen
   tranches referencing it, for no functional difference in what any reader
   learns.
3. **Buy the paid GitHub plan or make the repo public as part of this
   remediation pass.** Rejected — out of scope for an engineering change;
   this is explicitly an operator/business decision (cost, IP exposure) this
   ADR surfaces rather than makes.
4. **Ship the pre-push hook but skip the ladder restatement, on the theory
   that local enforcement is "good enough."** Rejected — an overstated local
   hook that quietly wasn't described as bypassable would repeat the exact
   defect this ADR exists to fix, one layer down; the hook is real but it is
   not BLOCKED, and both facts belong in the same place.

## Obligations

### O1 — `scripts/install-git-hooks.mjs` installs a `pre-push` hook running the four blocking gates plus `npm run build`, is idempotent on a second install, and refuses to overwrite a foreign non-marker hook

<!-- unverifiable: scripts/*.mjs is outside vitest.config.ts's include globs (packages/**/tests/**), so this repo-root script has no roundtrip-eligible test to cite; verified instead by running it for real against a scratch git init repo. -->

No proof attached. `scripts/*.mjs` is outside `packages/*/src` and is not
collected by `vitest.config.ts`'s `include` globs — this ADR's own Test
implications section names exactly this ("none of which are vitest-covered
... verified by running them for real"). There is no roundtrip-eligible
test file for this claim to cite; attaching one would be a false proof.

### O2 — ROADMAP.md's strength ladder retags the six previously-BLOCKED tranches (6.1, 6.2, 6.6 contract-shape, 6.7, 6.8, 6.9) to REPORTED rather than continuing to claim a platform-level merge refusal this repository does not have

<!-- unverifiable: documentation-accuracy claim about ROADMAP.md's prose, not code behavior — no symbol or test can stand as evidence; manually cross-checked, all six tranches carry the REPORTED (was claimed BLOCKED; retagged — see ADR-025) strength line. -->

No proof attached. This is a documentation-accuracy claim about
ROADMAP.md's prose, not a code behavior — there is no symbol, file, or
test that could stand as evidence for it under this record's proof
grammar. Manually cross-checked against ROADMAP.md as of this obligation's
writing: all six tranches carry a `REPORTED (was claimed BLOCKED;
retagged — see ADR-025)` strength line.
