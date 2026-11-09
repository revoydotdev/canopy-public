# Roadmap 12 — Integration conductor (postmortem R-E)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 3498984f (2026-09-22)
Authority: Retained implementation brief for integration conductor; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — conductor commands and throwaway-Git tests observed at 2348ddbb; design text reflects its authoring-time trunk naming
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22).** The [1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md) governs release order and priority; this file is a retained implementation brief, not an active queue. Its handoff is [here](handoffs/12-integration-conductor.md).
>
> **Status checked at `2348ddbb` (2026-09-22): implementation present.** The conductor commands, trunk-contract integration, allocation/regeneration paths, and throwaway-Git tests are tracked. The older design text's `master` examples and intermediate sequencing describe its authoring context; use the live trunk contract and current command implementation for operations.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1–§2 and §8 first
(invariants, read-list, repo gotchas: `tsc --build` only, zero deps, bun installs,
catalog-drift-in-three-places, structural redaction, stderr-is-not-protocol). Read
`docs/postmortems/multi-worktree-branch-integration.md` in full — this roadmap automates its §1.3–§1.8
and closes findings A3, C1–C3, E3, G1–G2. Read
`../research/concurrent-integration-frontier-brief.md` §3 and §6 before designing — they ground every
design choice below in a real, cited precedent.

**Why this exists (honest framing):** roadmaps 04–11 were implemented in parallel across 8 worktrees and
integrated by one operator, by hand, over hours: build the shared-file conflict matrix, derive a merge
order, and for each branch — rebase onto the *currently advancing* trunk, resolve conflicts, `npm run
build` + full `vitest run` in isolation, fast-forward, repeat. It worked. It is not repeatable, it does
not scale past "one operator, one afternoon," and every one of its steps is a mechanical transformation
of information already sitting in the repo (branch list, `git diff --stat`, the ADR index, the store
manifests). This roadmap turns that transformation into a program: **the integration conductor**.

## 0. The one thing that makes this revoy2 and not a generic merge bot

Bors/GitHub Merge Queue/Graphite operate on independently reviewable **pull requests** that are small,
disjoint by convention, and carry no governance obligation of their own. revoy2's unit of concurrent work
is a **roadmap branch**: it can carry a new ADR, touch every generated evidence store, and depend on
other roadmap branches landing first (roadmap 11 on top of 06+08+09). The conductor is not "batch these
PRs and fast-forward on green" — it is "resolve a dependency-ordered set of *governed* branches, each of
which may need its decision ids renumbered and its evidence stores regenerated as a condition of landing,
against a trunk that is itself moving while this runs." That is a strictly harder problem than any of the
merge-queue products in the frontier brief solve, which is why this is `build`, not `adopt`, per the
brief's §3 and §6 conclusions.

## 1. Read this first (the seams you generalize — do NOT build parallel ones)

- **The postmortem itself, §1.3–§1.8.** This is the reference implementation, executed manually once.
  Every conductor phase below has a corresponding numbered postmortem step; do not redesign the process,
  automate the one that already worked.
- **`scripts/store-freshness-gate.mjs`** (read in full — 189 lines). Already answers "how stale is store
  X relative to HEAD" and already refuses a manifest whose revision is not an ancestor of HEAD. The
  conductor's store-regeneration phase (§3 step 5) is the producer this gate already expects to exist;
  do not duplicate its distance-measurement logic, call it as the post-landing verification step.
- **`scripts/claim-ledger.ts`, `scripts/claim-ledger-precommit.mjs`** — the claim-ledger refresh/verify
  pair; the conductor's regeneration phase invokes the same `claims:refresh` the postmortem ran by hand
  (§1.6).
- **`decisions/README.md`** — the ADR index the conductor must append to, in landing order, once per
  branch (this roadmap does not allocate ids — that is roadmap 13's job; this roadmap *consumes*
  roadmap 13's reservation registry as the source of the number to write when a branch lands).
- **`docs/roadmaps/README.md`** — the roadmap index and worktree-creation convention (`git worktree add
  ../revoy2-<slug> -b feature/<slug> master`); the conductor operates over exactly this worktree layout.
- **`../research/concurrent-integration-frontier-brief.md` §3** — bors-ng's batch-and-bisect model and
  Graphite's "skip what's already validated" optimization are the two algorithms this roadmap's §3
  phases 2 and 4 directly port. §6 is why this is bespoke: no existing tool operates at roadmap-branch
  granularity with ADR obligations attached.

**Not to be confused with:** this roadmap does not replace `git`, does not introduce a new VCS (the
frontier brief explicitly rules out a Pijul-style swap — GPL license, immature ecosystem, disproportionate
to the actual problem), and does not run unattended in CI against `master` — every phase below produces a
plan or a report; the *landing* action (the actual fast-forward of `master`) stays an operator-approved
step, consistent with ADR-023's "no rollback target" reasoning and ADR-026's "supervised job" model.

## 2. Scope

The conductor is a CLI script (`scripts/integration-conductor.mjs`, zero new deps, following the shape of
`store-freshness-gate.mjs`) plus a small library it exposes for the phases below. It operates on a
**branch set** — a list of `feature/*` branches an operator names — and a **trunk ref** it reads from the
trunk contract (roadmap 16; until that lands, an explicit `--trunk` flag). It does not discover branches
on its own and does not push or delete anything.

## 3. Design — five phases, each independently runnable and independently verifiable

1. **Conflict graph + `depends_on` DAG.** For each pair of branches in the set, `git diff --stat
   <trunk>...<branch>` gives the file set each branch touches; the graph edge weight is `|files_A ∩
   files_B|`. Branches declaring `depends_on: [...]` in their roadmap handoff note (roadmap 16 requires
   this field) become DAG edges, not graph edges — a `depends_on` branch's unique commits are computed via
   `git rev-list <declared-base>..<branch>` (the roadmap-11 fix from postmortem §1.5, generalized: `git
   rebase --onto <trunk> <last-shared-commit> <branch>` replays only the branch's unique tail). Branches
   with zero file overlap and no DAG edge are the **fast path** (Pijul's commutativity property,
   frontier brief §3): they may be checked in either order without re-verification of each other's
   effect.
2. **Merge order.** Topological sort of the DAG, breaking ties by ascending conflict-graph weight (most
   isolated first — this is exactly the postmortem's manually-derived order: 05 → 04 → 07 → 10 → 06 → 08
   → 09 → 11). Output a plan file (`--json`) an operator reviews before phase 3 runs.
3. **Per-branch rebase-verify cycle**, in worktrees under a scratch directory (never the operator's
   working checkout — reuse the isolation discipline from `concurrent-git-index-race` memory: a sibling
   process's `git add -A` must never be able to sweep this branch's staged files):
   - `git worktree add <scratch>/<slug> <branch>`
   - rebase onto the *currently advancing* trunk ref (re-read after every prior branch lands — this is
     the postmortem's "re-rebase the next onto the advanced master" step, and the single most important
     correctness property: the conductor must never plan against a stale trunk snapshot, which was root
     cause A2).
   - **mechanical conflict auto-resolution**: import/export list unions, exhaustive-switch-arm insertion
     (detect a `case` added on both sides of a conflict marker touching the same discriminated union and
     splice both arms in source order — this is the E1 "three features' additions to one exhaustive
     switch" pattern, made mechanical because the shape is always "insert, don't replace"), and the four
     always-conflicting generated stores (§3 phase 5 below) — resolved by *deferral*, not merge (drop
     both sides, regenerate after landing, exactly as postmortem §1.6 did).
   - **flag, never silently resolve, a semantic conflict**: any conflict region where both sides modify
     the *same* line/statement (not merely adjacent lines) is reported to the operator with both original
     hunks and the file's owning ADR (if any, via roadmap 15's derived index) — this is E2's boundary; the
     conductor's job is to make the *mechanical* 80% cheap, not to auto-resolve the *semantic* 20% a
     merge-correctness property test (roadmap 17) exists to catch if it slips through anyway.
   - `npm run build` + `npx vitest run` inside the worktree — this is the isolation gate; a branch that
     fails here does not proceed regardless of what phase 1–2 predicted.
4. **Decision-id renumbering.** On isolation-gate green, if the branch carries a `Status: Proposed` ADR
   at a placeholder/reserved id (roadmap 13's allocation scheme), rewrite it to the next real number in
   landing order (skipping the roadmap-13 reserved set) and update `decisions/README.md`. This is
   deliberately the *last* mechanical step before fast-forward, because the number is only real once the
   branch's landing order is real.
5. **Store regeneration.** After all branches in the plan have landed, run each store's declared refresh
   command once (`claims:refresh`, `determinism:refresh`, `completion-depth:refresh`,
   `vi:observe`/whatever roadmap 14 lands as the vi-store refresh entry point) against the new trunk head,
   then run `store-freshness-gate.mjs` to confirm every store is now within budget. This closes C1–C3:
   stores are never carried through the rebase/merge cycle at all, they are produced once, at the end,
   against ground truth.

Each phase is a **separate subcommand** (`plan`, `land <branch>`, `renumber`, `regenerate-stores`) so an
operator can run phase 3 for one branch, inspect it, and only then proceed — this roadmap automates the
mechanics, it does not remove the operator from the loop, consistent with §0.

## 4. The safety case (this crosses no new trust boundary, but earns one property test anyway)

The conductor does not execute tool calls, does not grant capabilities, and does not touch the tool-trust
boundary (ADR-024/028) — it is a build/repo-hygiene script, the same class as `store-freshness-gate.mjs`.
Its correctness property is narrower and purely mechanical:

- **Never fast-forwards on red.** Assert: given a worktree where `npm run build` or `vitest run` exits
  non-zero, the conductor's `land` subcommand exits non-zero and does not touch the trunk ref. Test with
  a fixture branch containing a deliberate build break.
- **Never auto-resolves a same-line conflict.** Assert: given two branches that both modify the identical
  source line (not just the identical file), the conductor's mechanical-resolution step reports it as
  `semantic_conflict` and refuses to proceed past phase 3 for that branch without an explicit
  `--accept-manual-resolution` flag an operator sets after resolving it by hand. This is the direct
  answer to E2 — the conductor's whole purpose is to *never reproduce* the sandbox-`read` failure mode by
  guessing.
- **Never plans against a stale trunk.** Assert: the conductor's phase 3 re-reads the trunk ref
  immediately before each branch's rebase, not once at plan time; a fixture that advances trunk mid-run
  (simulating another branch landing concurrently) must be picked up by the next branch's rebase target.

If those three hold, the conductor is safe by construction — everything else (the mechanical
conflict-resolution heuristics, the ordering heuristic) is a quality-of-implementation concern that
`npm run build` + `vitest run` already backstop.

## 5. Wiring (done = wired, not merely built)

- `scripts/integration-conductor.mjs` + `scripts/lib/conductor/*.mjs` (graph builder, order planner,
  worktree driver, renumbering, store-regeneration driver).
- `package.json` script entries: `conductor:plan`, `conductor:land`, `conductor:renumber`,
  `conductor:regenerate-stores` (mirroring the existing `claims:refresh`/`determinism:refresh` naming).
- Verify end-to-end on a **real** multi-branch fixture, not a mock: create two throwaway branches off a
  scratch base with a deliberate mechanical conflict (adjacent lines) and a deliberate semantic conflict
  (same line), run `conductor plan` → `land` → confirm the mechanical one lands and the semantic one is
  correctly refused. This is the "isolation-green ≠ composition-correct" (G1) property, proven on purpose
  rather than discovered again by accident.

## 6. Tests

- The three §4 property assertions.
- Conflict-graph correctness: a fixture pair of branches with known overlapping/disjoint file sets
  produces the expected graph edges and merge order.
- Renumbering: a fixture ADR at a placeholder id lands at the correct next number, skipping a configured
  reserved range (feeds roadmap 13's registry).
- Store regeneration: after a fixture land, `store-freshness-gate.mjs` reports zero distance for all four
  stores.

## 7. Deliverables

- An ADR (next number) — **The integration conductor automates verified, dependency-ordered branch
  landing; it never fast-forwards on a failing isolation gate and never auto-resolves a same-line
  conflict.** Cite the frontier brief's bors-ng/Graphite precedent and the explicit "no VCS swap" decision
  (Pijul considered and rejected — GPL, immature, disproportionate). Index it in `decisions/README.md`.
- The implementation, wired and green (`npm run build`; `npx vitest run`; zero new deps; bun installs).
- A handoff note under `docs/roadmaps/handoffs/` per the roadmaps README, explicitly stating this
  roadmap's dependency on roadmap 13 (id allocation) and roadmap 15 (store regeneration commands) — if
  those land first, wire directly to their real entry points instead of the placeholder names in §3.

**Risk:** Medium-high. Not a new trust boundary, but the highest blast radius of any roadmap in this set
if its ordering or conflict-detection logic is wrong — a bad merge order or a missed same-line conflict
reproduces E2 at scale instead of catching it. The mitigation is architectural: every phase is
inspectable/interruptible (§3), and the safety case (§4) treats "refuse and ask" as the only acceptable
default when in doubt, never "guess and proceed."
