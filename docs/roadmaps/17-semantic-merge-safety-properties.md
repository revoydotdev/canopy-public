# Roadmap 17 — Semantic-merge safety properties (postmortem R-F)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 73fb8068 (2026-09-22)
Authority: Retained implementation brief for a postmortem remediation; informs local technical scope only.
Evidence scope: mixed — postmortem-derived design (target) with authoring-time repository facts; implementation status must be re-checked against code and sealed evidence
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22):** this brief is retained as design and implementation history. Its priorities and ordering are subordinate to the [Canopy/revoy2 1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md). Treat implementation and research claims as bounded to the evidence recorded in this brief; verify current status against code and sealed evidence before relying on them.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1–§2 and §8 first
(invariants, read-list, repo gotchas). Read
`docs/postmortems/multi-worktree-branch-integration.md` §1.2, §2.E (E1/E2) in full, and
`../research/concurrent-integration-frontier-brief.md` §4 before designing.

**Why this exists (honest framing):** the postmortem's sharpest single finding. The first merge attempt
(a plain `git merge` of roadmap 05, the OS-sandbox branch, into trunk) produced a textual auto-merge of
`native-tool-host.ts` that **compiled and would have passed every test** — and silently left a `read`
call on the direct-filesystem path under the new async sandbox signature, **skipping confinement
entirely**. Nothing in the existing verification pipeline (build + full suite) would have caught it; it
was caught only because an operator read the merged region by eye and recognized the shape was wrong.
"Tests are necessary, not sufficient, for merge correctness" is the postmortem's own conclusion, and the
frontier brief's Merge-Bench finding (§4: even the best LLM resolves under 60% of real merge conflicts
correctly) is independent, dated evidence that neither textual auto-merge nor an LLM asked to resolve a
conflict can be trusted as the correctness oracle for this class of bug.

## 1. Read this first

- **`docs/postmortems/multi-worktree-branch-integration.md` §1.2** — the sandbox-`read` incident, in
  full, including the specific shape of the bug (an `async` sandbox signature change, and a direct-fs
  `read` call that should have been routed through the new broker but wasn't, after auto-merge). This is
  the roadmap's primary acceptance fixture — reproduce this exact shape as a regression test, not a
  generic stand-in.
- **Roadmap 05 (`docs/roadmaps/05-os-backed-sandbox.md`)** and its landed ADR — the specific invariant
  that was silently dropped ("every `file.*`/`shell.execute` path routes through the sandbox broker," in
  the postmortem's own R-F phrasing). Read the safety-case property test that ADR already ships with — if
  it exists and is a normal test, it ran and passed on each branch *in isolation* and still missed the
  merged, composed bug; that is exactly the isolation-green-≠-composition-correct gap (G1) this roadmap
  closes structurally.
- **Roadmap 06's §4** (`docs/roadmaps/06-governed-hook-and-lifecycle-bus.md`) — a worked example of
  exactly the kind of property this roadmap generalizes: "for any tool call, `effective_allow ⟹
  base_allow`." That property is already written as a normal vitest assertion. The only thing missing,
  repo-wide, is a **registry of which properties are merge-critical** and a way to **force them to re-run
  specifically across a merge/rebase diff**, not just as part of the ordinary full-suite run (which — as
  §1.2 proves — is not sufficient on its own if the merge tool produces code the *test file itself* didn't
  change but whose *target* now silently violates the property).
- **`../research/concurrent-integration-frontier-brief.md` §4** — SafeMerge's vocabulary (*semantic
  conflict-freedom*: the merged program introduces no behavior beyond the union of each branch's
  behavior) is the formal frame for what this roadmap builds informally; Merge-Bench's <60% LLM
  correctness ceiling is the citation for why an LLM must never be the merge-correctness oracle for
  trust-boundary code, only ever a *proposer* whose output the same property tests judge.

**Not to be confused with:** this is not a general program-verification project (no SMT solver, no
Boogie-style relational reasoning tool — the frontier brief explicitly marks SafeMerge/DeepMerge as
`skip`-the-tool, `adopt`-the-vocabulary). This roadmap is a **registry and CI wiring change**: declare
which existing property tests are merge-critical, and force them to run specifically as part of any
merge/rebase touching their declared file scope — the tests themselves already exist for several ADRs
(05, 06 above); this roadmap does not reinvent them.

## 2. Design

1. **`docs/merge-critical-properties.jsonc`** (new, committed): a registry mapping an ADR-declared
   invariant to (a) the file globs whose modification should trigger it, and (b) the vitest test id that
   asserts it.
   ```jsonc
   {
     "properties": [
       {
         "adr": "ADR-044",
         "statement": "every file.*/shell.execute path routes through the sandbox broker",
         "watch_globs": ["packages/arbor-harness/src/native-tool-host.ts", "packages/arbor-harness/src/native-worker.ts"],
         "test_id": "packages/arbor-harness/src/__tests__/sandbox-confinement.property.test.ts"
       },
       {
         "adr": "ADR-049",
         "statement": "effective_allow implies base_allow for every hook-composed tool decision",
         "watch_globs": ["packages/arbor-mcp/src/hooks/*.ts"],
         "test_id": "packages/arbor-mcp/src/hooks/__tests__/reduction.property.test.ts"
       }
     ]
   }
   ```
   Populate this by auditing every landed ADR's safety-case section for a stated invariant with a
   corresponding property test (roadmaps 02, 05, 06, 11 are the known candidates — confirm by reading each
   ADR's Consequences/safety-case text, do not assume the list above is complete).
2. **Merge-critical re-run, not just full-suite re-run.** Add `scripts/merge-critical-check.mjs`
   (zero deps): given a diff range (`<base>..<head>`, e.g. what a rebase or merge just produced), compute
   which `watch_globs` entries the diff touches, and **specifically re-run** those `test_id`s, reporting
   which ADR-declared property each one enforces in its output (so a failure reads "ADR-044's sandbox
   confinement invariant failed after this merge," not just "test 47 failed"). This is a *stronger*
   framing than "run the full suite" for two reasons the postmortem's §1.2 incident demonstrates: (a) a
   property test that exists but wasn't touched by either branch individually still needs to be re-checked
   against the *composed* result, and full-suite already does that — the real gap is (b) **making the
   check legible**: a full-suite green tells you nothing about *which* invariants were exercised by the
   specific lines a merge just rewrote; this registry makes that traceable, which is what lets an
   integrator (human or roadmap-12's conductor) know *which* merge-critical property to double-check by
   eye when a merge touches a watched file, even before running anything.
3. **Wire into the conductor's mechanical-conflict path (roadmap 12 §3 phase 3), if it exists.** A
   mechanical auto-resolution (import-list union, exhaustive-switch-arm splice) that touches a
   `watch_globs` file must run `merge-critical-check.mjs` before the isolation gate, not rely on the
   isolation gate's full-suite run alone to surface it — this makes the registry's traceability benefit
   (§2 step 2) actually load-bearing at merge time, not just informative after the fact. If roadmap 12
   hasn't landed yet, this roadmap still stands alone: `merge-critical-check.mjs` is directly runnable by
   an operator against any diff range, exactly reproducing what would have caught the sandbox-`read`
   incident by hand.
4. **New ADRs are required to populate the registry when they declare a safety-case property.** Extend
   the roadmap-authoring convention (`docs/roadmaps/README.md`) with one line: an ADR whose Consequences
   section states an invariant in the "X must always imply Y" shape must add a row to
   `docs/merge-critical-properties.jsonc` pointing at its property test, as part of that roadmap's own
   deliverables — this is how the registry stays current instead of drifting the way the four ADR-count
   locations did (roadmap 15's exact failure mode, applied here pre-emptively).

## 3. The safety case (this roadmap's own test, about testing)

- **The registry's file-glob match is conservative, not precise-but-fragile.** Assert: a diff touching
  any file within a declared `watch_globs` pattern triggers that property's re-run, even if the specific
  lines changed look unrelated — false positives (an unnecessary re-run) are the acceptable failure mode,
  false negatives (a missed re-run) are not. State this explicitly, mirroring `counts/check.ts`'s own
  stated conservatism principle.
- **The sandbox-`read` regression is caught.** Assert, as the load-bearing acceptance test: reproduce the
  exact §1.2 shape (a fixture "merge" that textually resolves cleanly, compiles, and would pass the
  general suite, but silently routes a `read` around the sandbox broker) and confirm
  `merge-critical-check.mjs` — via the registered ADR-044 property test — fails on it. If this specific
  fixture does not fail, the roadmap has not achieved its stated purpose regardless of what else it
  built.
- **A registry entry with no reachable test_id fails closed at build time**, not silently: `bun run build`
  or a dedicated lint step must fail if `docs/merge-critical-properties.jsonc` references a `test_id` that
  no longer exists (an ADR's property test was renamed/deleted without updating the registry) — an
  unreachable safety net is worse than none, per this repo's own governance philosophy (mirrors the
  hook-liveness reasoning in ADR-032, cited by analogy, not by mechanism).

## 4. Wiring

- `docs/merge-critical-properties.jsonc`, seeded from an audit of every landed ADR's safety-case section.
- `scripts/merge-critical-check.mjs`, callable standalone (`bun scripts/merge-critical-check.mjs
  <base>..<head>`) and from roadmap 12's conductor if/when it exists.
- `docs/roadmaps/README.md` — add the one-line registry-population requirement to the roadmap-authoring
  convention (§2 step 4).
- Verify with the real sandbox-confinement property test from roadmap 05, not a synthetic stand-in —
  confirm it actually exists and actually asserts the broker-routing property before building this
  roadmap's registry around it; if it does not exist in the form assumed here, that is itself a finding to
  report, not something to paper over with a new test invented for this roadmap alone.

## 5. Tests

- The three §3 property assertions, including the load-bearing sandbox-`read` regression fixture.
- Registry integrity: every `test_id` resolves to an existing test file/case; every ADR referenced exists
  in `decisions/`.
- End-to-end: a fixture diff touching two independently-registered properties' watch globs triggers both,
  and a fixture diff touching neither triggers neither (no false positives on unrelated diffs).

## 6. Deliverables

- An ADR (next number, via roadmap 13's registry if landed) — **A merge or rebase that touches a
  file globbed by a declared ADR safety-case property must specifically re-run that property's test,
  legibly attributed to the ADR; a full-suite green alone is not sufficient evidence a merge is safe.**
  Cite the postmortem's §1.2 sandbox-`read` incident by name as the motivating case, and the frontier
  brief's SafeMerge (semantic conflict-freedom vocabulary) and Merge-Bench (<60% LLM correctness ceiling —
  why an LLM proposing a resolution is never the oracle) citations. Index it in `decisions/README.md`.
- The implementation, wired and green (`bun run build`; `bun run test`; zero new deps; bun installs).
- A handoff note under `docs/roadmaps/handoffs/` — flag that this roadmap's registry should be
  cross-referenced by roadmap 12 (conductor) if that roadmap implements the "flag semantic conflicts"
  behavior in its §3 phase 3; the two roadmaps reinforce rather than duplicate each other (the conductor
  catches same-line textual conflicts; this roadmap catches clean-textual-merge-but-broken-invariant
  conflicts, which is the strictly harder and more dangerous case §1.2 demonstrates).

**Risk:** Medium-high. This roadmap's entire purpose is closing the single most dangerous failure mode the
postmortem found — a security property (sandbox confinement) silently dropped by a merge that looked
completely clean. Getting the registry's coverage wrong (missing an ADR's invariant) reproduces the exact
danger this roadmap exists to close, just with a false sense of safety instead of none. The mitigation is
the §3 acceptance fixture: this roadmap is not done until it demonstrably catches the real incident it is
named after, not a synthetic stand-in.
