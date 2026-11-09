# ADR-078: Tests That Assert Over Repository State Run Against a Frozen Snapshot

**Status:** Accepted
**Date:** 2026-08-18
**Authoring Revision:** 6f0acbcec9e1dc64561ea488ccf1197043bfd31b
**Content ID:** sha256:b5425e4e1dc546ca4f7939c05a2fce5fc8bd1ebfd4d90bd97445f12f3cf72b99

Authored as Proposed, not Accepted: the authoring change does not hold its own
acceptance authority (ADR-059).

## Context

Two flakes with one cause landed hours apart on 2026-08-18, and neither was
noise.

**`scripts/tests/gate-failure-modes.test.mjs`** ran the four real gate scripts
against `REPO_ROOT` — the live checkout — for a ~500-second run.
`computeEvidenceContentHash(repo)` (`scripts/lib/store-provenance.mjs`) hashes
**every** non-generated, non-gitignored file under the repo it is handed. The
mechanism was proven directly, without involving any test: dropping one
untracked file anywhere in the tree changed the live hash
(`sha256:94960a42…` → `sha256:d097b686…`) while a frozen snapshot's hash did
not move. The suite's verdict was therefore a function of whatever else was
happening in the checkout, not of the code under test. `HEAD` itself advanced
twice during the investigation, purely from ambient activity.

**`scripts/tests/project-conform-enrollment.test.mjs`** spawned the real CLI
with this repository as its cwd. The registry is written under
`resolvePersistenceDir(environment.cwd, …)`, so fixture enrollments wrote
entries into revoy2's own `PERSISTENCE_DIR/project-registry.json`. That was inert only
while `enroll --new` could not register at all; the moment it began
initialising a git repository and succeeding, every run mutated production
state, and `gate:project-registry` then failed on entries whose fixture
directories the suite had already deleted.

Two independent instances is a class, not a coincidence. The shared shape is a
test whose subject is "the repository" rather than "a fixture," executed inside
a checkout that other work is concurrently mutating. This repository's normal
operating mode is several agents committing into one checkout, so that
concurrency is a standing condition, not an unusual one.

The cost is specific and worse than a red test. A flake in a governance harness
teaches its operators to re-run and move on, which is precisely the habit that
lets a genuine regression through. A gate that is sometimes wrong for reasons
unrelated to its subject is not a weaker gate; it is a gate that has stopped
meaning anything.

## Decision

**A test whose assertion ranges over broad repository state must execute
against a frozen snapshot of that state, not the live working tree. A test that
invokes a real entry point which writes durable state must supply its own
throwaway state directory.**

Concretely, three cases and their required handling:

1. **Broad-state readers** — anything hashing, walking, or counting across the
   repository (evidence stores, content hashes, file inventories). Freeze a
   `git worktree add --detach <tmp> HEAD` snapshot once at module load and
   point the test at that. `adr-claim.test.mjs`, `worktree-hygiene.test.mjs`
   and `e2e-adr-lifecycle.test.mjs` already used this idiom; it is now the
   rule rather than a local habit. Note the practical detail:
   `node_modules` must be hardlinked in (`cp -al`), because a symlink evades
   the `node_modules/` gitignore pattern and the walk then crashes on
   `readFileSync` with `EISDIR`.

2. **Real-entry-point drivers** — anything spawning the CLI or a gate that
   persists. Give it an isolated cwd or persistence directory. The subject of
   the test is the fixture, so the state it writes belongs with the fixture.

3. **Deliberately live assertions** — a test whose entire point *is* the real
   repository right now ("the committed stores match", "the real TRIAGE table
   has no untriaged findings"). These stay live, and that is correct. But they
   must fail only for their own reason. Where a live assertion is unavoidably
   sensitive to ambient mutation, that sensitivity is a defect in the
   assertion, not an acceptable cost.

**Narrow reads are explicitly not covered.** Reading `REPO_ROOT/package.json`
to check a gate roster is not racy in any practical sense, and wrapping it in a
worktree would cost real time and obscure the test. The rule is about
assertions whose verdict an *unrelated* file can change.

## Consequences

**Positive:**

- The class becomes decidable rather than discovered. A reviewer can ask "what
  is this test's subject, and can an unrelated file change its verdict?" and
  get an answer from the code.
- Determinism claims elsewhere in this repository — the determinism baseline,
  the reproducibility check — stop being undermined by a test layer that is
  itself nondeterministic.

**Negative:**

- A frozen worktree costs setup time per suite that adopts it, and the
  `cp -al` hardlink trick is a real portability assumption (same filesystem).
  Applying this rule indiscriminately would be a measurable slowdown, which is
  why the narrow-read carve-out above is part of the decision rather than an
  afterthought.
- It does not detect its own violation. Nothing yet fails when a new test
  reaches for `REPO_ROOT`; this record states a rule that is, for now, enforced
  by review.

**Neutral:**

- No production code changes. This governs the test layer only.

## Obligations

### O1 — The broad-state suite is isolated from ambient mutation

<!-- proof: symbol=computeEvidenceContentHash file=scripts/lib/store-provenance.mjs roundtrip=scripts/tests/store-provenance.test.mjs -->

`gate-failure-modes.test.mjs` resolves its gate invocations, `HEAD`, and
content hash against a worktree snapshot frozen at module load, so a file
appearing anywhere in the live checkout mid-run cannot change its verdict.

**Why the roundtrip cites `store-provenance.test.mjs` and not the suite it
describes.** Citing `gate-failure-modes.test.mjs` enrolled that file as a
determinism-measured seam, and `determinism:refresh` then executed it three
times *while rewriting the very store the suite asserts on* — a self-reference
that produced `pass_count: 0, fail_count: 3, nondeterministic: false`. The
failure was deterministic, not flaky; the measurement was simply meaningless.
`store-provenance.test.mjs` exercises `computeEvidenceContentHash` directly and
invokes no gate, so it can be measured without measuring itself. A test that
asserts on a gate's output cannot also be that gate's evidence.

### O2 — A test driving the real CLI writes its state into its own fixture

<!-- proof: symbol=registerProject file=packages/arbor-mcp/src/project-registry.ts roundtrip=packages/arbor-mcp/tests/project-registry-cli.test.ts -->

Enrollment tests supply their own governing directory, so a fixture
registration lands beside the fixture and never in revoy2's own
`PERSISTENCE_DIR/project-registry.json`.

## Test implications

- Touching an unrelated file mid-run does not change a broad-state suite's
  verdict; before isolation it demonstrably did.
- After a full run of the enrollment suites, this repository's registry holds
  the same entries it held before.
- The isolated suites still fail when the property they guard is genuinely
  broken — isolation must not be achieved by no longer checking anything.
