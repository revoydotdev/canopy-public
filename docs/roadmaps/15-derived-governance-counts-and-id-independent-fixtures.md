# Roadmap 15 — Derived governance counts & id-independent fixtures (postmortem R-D)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 3498984f (2026-09-22)
Authority: Retained implementation brief for derived governance counts; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — renderer, marked targets and pre-commit enforcement observed at 2348ddbb
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22).** The [1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md) governs release order and priority; this file is a retained implementation brief, not an active queue. Its handoff is [here](handoffs/15-derived-governance-counts.md).
>
> **Status checked at `2348ddbb` (2026-09-22): implementation present.** The renderer, marked targets, pre-commit enforcement, and focused tests are tracked. The historical “can land independently” note means no dependency on the conductor's operation; count derivation does consume the decision registry schema.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1–§2 and §8 first
(invariants, read-list, repo gotchas). Read
`docs/postmortems/multi-worktree-branch-integration.md` §1.7, §2.D in full, and
`../research/concurrent-integration-frontier-brief.md` §5 before designing.

**Why this exists (honest framing):** the literal ADR count is hand-written in four places
(`AGENTS.md:54`, `.claude/skills/revoy2-implementation-audit/SKILL.md:26`,
`docs/release-readiness.md`, `decisions/README.md`'s own row count), and every ADR addition drifts all
four, tripping `checkCounts`/`SUR-05`. The operator had to hand-edit counts on every one of the eight
branches. This is a single-writer assumption (one ADR added at a time, one human keeping counts in sync)
surviving into a multi-writer world where it silently becomes eight edits, not one.

## 1. Read this first — the important finding is that half of this already exists

- **`packages/arbor-governance/src/counts/check.ts`** (read in full this roadmap depends on — do not
  skim). It **already** derives `RepositoryCounts` (including `adr_total`) from the filesystem and
  **already** flags any doc claim that has drifted (`SUR-05`). Its own doc comment states the design
  discipline precisely: it deliberately recognizes only a narrow set of phrasings
  (`"<N> ADRs"`/`"<N> ADR"`, the compound test-count/test-files shape) to avoid false positives, and it
  deliberately does **not** derive `test_count` because that requires an actual `vitest run`, not a
  static approximation — "the honest source of truth is an actual `vitest run`... left as an optional
  input... rather than something this 'pure' module fakes statically." **Read this reasoning before
  changing anything** — it is the right discipline and this roadmap must not weaken it.
  **The gap is not derivation. `checkCounts` derives correctly today.** The gap is that it is a
  *checker*: it tells you the four docs are wrong, but a human still has to go edit all four by hand to
  make it pass. This roadmap builds the missing *generator* half.
- **`packages/arbor-governance/src/counts/derive.ts`** — the `RepositoryCounts` type and its derivation
  logic; this roadmap extends its output surface (adds a render/injection step), it does not change what
  it counts.
- **`AGENTS.md:54`, `.claude/skills/revoy2-implementation-audit/SKILL.md:26`,
  `docs/release-readiness.md`, `decisions/README.md`** — grep-confirm the exact current phrasing of each
  count claim before writing the template-injection markers; do not assume the postmortem's prose is a
  complete enumeration (search the whole repo for `"\d+ ADRs?"` to be sure no fifth location exists).
- **`../research/concurrent-integration-frontier-brief.md` §5** — Log4brains' complementary discipline
  ("the published artifact is always regenerated, never hand-edited") is the design target; the brief
  explicitly rules out adopting Log4brains itself (Node CLI + static-site-generator runtime dependency,
  and it solves ADR *numbering*, which revoy2 already has a different answer to via roadmap 13) — adopt
  only the discipline.

**Not to be confused with:** this roadmap does not touch ADR *numbering* (roadmap 13's job) — it touches
how the *count* of already-numbered ADRs gets reflected in prose docs. A reader of both roadmaps should
come away understanding these are adjacent but distinct: 13 answers "what number does this ADR get," 15
answers "how do the four docs that mention ADR counts stay honest without a human editing all four."

## 2. Design

1. **One canonical source, three generated copies (not four independent hand-edits).** Pick the cheapest
   correct mechanism given each file's format:
   - `decisions/README.md`'s row count is *already* derivable by literally counting its own table rows —
     it needs no injection, it needs a **test** (already partially present via `checkCounts`) asserting
     row count matches `derive.ts`'s filesystem scan. Leave as-is; do not add machinery where a test
     already suffices.
   - `AGENTS.md` and `docs/release-readiness.md` are prose docs where the count appears inline in a
     sentence. Add a narrow, explicit template marker at each site —
     `<!-- governance:adr_total -->51 ADRs<!-- /governance:adr_total -->` — and a <!-- sur-05:historical -->
     `scripts/render-governance-counts.mjs` (zero deps, reuses `derive.ts`) that rewrites the text between
     the markers to the current derived value. This is intentionally **not** a general templating engine;
     it is a two-line sed-equivalent over a small, explicit, grep-able set of marker pairs, matching the
     conservatism `checkCounts` itself models.
   - `.claude/skills/revoy2-implementation-audit/SKILL.md` gets the same marker treatment — it is a doc,
     not executable skill logic, so it is safe to rewrite mechanically.
2. **`checkCounts` becomes a pre-commit-time render-then-verify pair**, not a verify-only gate: extend
   `scripts/claim-ledger-precommit.mjs` (or add a sibling
   `scripts/render-governance-counts-precommit.mjs`, matching its shape) to run the render step and then
   assert `git diff --quiet` on the three marked files — i.e., **commit fails if the rendered value
   doesn't match what's committed**, which is strictly stronger than today's "commit succeeds with a
   drifted doc, `SUR-05` catches it later" flow, and removes the "hand-edit on every branch" tax entirely:
   an agent just runs the render script (or the pre-commit hook does it for them) instead of hand-counting.
3. **Id-independent fixtures (D2).** Grep `packages/*/src/**/*.test.ts` for any test that hardcodes a
   literal `045` or `086` (or any other live ADR number) as an example of "cross-namespace citation that
   must not resolve." Rewrite each to use a **synthetic out-of-range id** (e.g., `9999`) that can never
   collide with a real future ADR, and assert the **property** — "a citation whose target number is not in
   `registry.json.allocations` (roadmap 13) or `registry.json.reserved` never resolves" — rather than
   pinning the specific historical example. This directly closes D2: a future ADR-999 landing legitimately
   can no longer accidentally flip a governance test that was really testing "citations outside our
   namespace stay unresolved," because the test no longer depends on 045/086 specifically remaining
   unallocated forever.

## 3. The safety case

This is a doc-generation and test-hygiene roadmap; it does not cross a trust boundary. Its correctness
property is narrow and mechanical, but worth stating precisely because it is the difference between "the
gate looks green" and "the gate is green because the doc is actually correct":

- **Render is idempotent and matches derivation.** Assert: running the render script twice in a row
  produces no further diff, and the rendered value for `adr_total` always equals
  `derive.ts`'s live filesystem count — never a cached or previously-rendered value.
- **A stale marker fails the commit, not just the CI gate.** Assert: hand-editing a marked count to a
  wrong value and attempting to commit (via the precommit hook fixture harness the repo already uses for
  `claim-ledger-precommit.test.mjs` — copy its structure) is rejected before the commit lands, not merely
  flagged after.
- **Fixture citations are id-independent.** Assert: the rewritten cross-namespace-citation tests still
  pass when run against a registry state where 045/086 have been (hypothetically, in the test fixture
  only) allocated — proving the test now checks the *property*, not the *specific historical numbers*.

## 4. Wiring

- `scripts/render-governance-counts.mjs` + marker comments added to `AGENTS.md`,
  `docs/release-readiness.md`, `.claude/skills/revoy2-implementation-audit/SKILL.md`.
- Extend the existing pre-commit hook chain (alongside `scripts/claim-ledger-precommit.mjs`) rather than
  adding a second, parallel hook-invocation path — reuse whatever hook-registration mechanism those
  already use.
- `package.json`: a `governance:render` script entry, callable standalone (an agent authoring an ADR runs
  it once before committing, instead of hand-editing three files).
- Rewrite the D2 fixtures identified in §2 step 3 in place (this is the one place this roadmap touches
  test files outside its own new code — keep the diff to exactly the hardcoded-id lines, do not refactor
  the surrounding tests).

## 5. Tests

- The three §3 property assertions.
- End-to-end: bump the filesystem ADR count by adding a fixture ADR file in a scratch copy of the repo,
  run `governance:render`, confirm all three marked docs update to the new count and `decisions/README.md`
  still needs zero changes (its count was never hand-written to begin with).
- Regression test replaying the exact postmortem scenario: eight simulated ADR additions in sequence,
  `governance:render` run once at the end (not eight times), all four locations end at the correct final
  count — this is the concrete proof the "hand-edit counts on every branch" tax is gone.

## 6. Deliverables

- An ADR (next number, via roadmap 13's registry if landed) — **Governance counts are rendered from a
  single derivation, never hand-edited; commit-time verification fails a stale count instead of merely
  flagging it later.** Cite the existing `counts/check.ts` design discipline as the derivation this
  roadmap extends, not replaces, and the frontier brief's Log4brains-discipline citation. State plainly
  that D2's fixture rewrite is part of this roadmap's scope, not a follow-on. Index it in
  `decisions/README.md`.
- The implementation, wired and green (`npm run build`; `npx vitest run`; zero new deps; bun installs).
- A handoff note under `docs/roadmaps/handoffs/` — note this roadmap has no hard dependency on roadmap 13
  (id allocation) or roadmap 12 (conductor); it can land independently and first, since it only touches
  count-rendering, not number-allocation.

**Risk:** Low. Doc-generation and test-hygiene only; no trust boundary, no runtime behavior change. The
only real risk is scope-creep into a general templating system where the existing narrow, conservative
`checkCounts` discipline (deliberately declining to derive `test_count` because it can't be done
honestly-statically) should instead be respected and mirrored, not overridden.
