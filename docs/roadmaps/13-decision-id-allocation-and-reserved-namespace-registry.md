# Roadmap 13 — Decision-id allocation & reserved-namespace registry (postmortem R-B)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 3498984f (2026-09-22)
Authority: Retained implementation brief for decision-id allocation; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — allocation registry, allocator and build gate observed at 2348ddbb; handoff counts are historical snapshots
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22).** The [1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md) governs release order and priority; this file is a retained implementation brief, not an active queue. Its handoff is [here](handoffs/13-decision-id-registry.md).
>
> **Status checked at `2348ddbb` (2026-09-22): implementation present.** The allocation registry, allocator, build gate, and focused throwaway-repository tests are tracked. Counts in the handoff are historical snapshots, not current registry totals.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1–§2 and §8 first
(invariants, read-list, repo gotchas). Read `docs/postmortems/multi-worktree-branch-integration.md` §1.4
and §2.B in full, and `../research/concurrent-integration-frontier-brief.md` §1 before designing.

**Why this exists (honest framing):** eight parallel branches each guessed "the next ADR number" off
different bases. Two guessed 044, two guessed 047. One guessed **045**, which is silently poisonous:
`decisions/ADR-027` already cites `revoy-spec:ADR-045` cross-namespace, so a local `revoy2:ADR-045`
flips a deliberately-unresolvable governance citation to `derived` — a correctness bug in the *governance
system itself*, not just a numbering annoyance. This roadmap makes that collision structurally impossible
rather than something a future agent has to remember not to do.

## 1. Read this first (the seams you generalize — do NOT build parallel ones)

- **`decisions/README.md`** — the current index; sequential-integer, hand-appended. This roadmap does
  not change the ADR *numbering format* (still `ADR-0NN-slug.md`, still human-facing, still cited by
  number elsewhere in the repo) — it changes how a number is **assigned**, from "the authoring agent
  guesses" to "a registry allocates, once, at integration."
- **`packages/arbor-governance/src/counts/check.ts`** (read in full) — `checkCounts`/`SUR-05` already
  derives `adr_total` from the filesystem; this roadmap's registry is a natural place to also derive
  the *next available* number and the *reserved* set, so `checkCounts` and this registry share one
  source of ADR-numeric truth (do not build a second derivation of the same fact — roadmap 15 builds the
  count-injection half; this roadmap owns the *allocation* half; both read the same registry file).
- **ADR-027** (governance control plane placement) — the file that cites `revoy-spec:ADR-045`
  cross-namespace; grep the whole `decisions/` tree for any other cross-namespace citation before writing
  the reserved set (do not hardcode "045 and 086" from the postmortem's prose alone — verify by search).
- **`../research/concurrent-integration-frontier-brief.md` §1** — Django's fork-then-`--merge`-migration
  model and Atlas's `non-linear` execution mode are the two directly reusable patterns: **decouple
  identity from number**; assign the number **once**, at the point where arrival order is finally known
  (i.e., at conductor `land` time, roadmap 12 phase 4), not at authoring time.

**Not to be confused with:** this is not a general CRDT/ULID runtime dependency (Automerge, ULID
libraries) — the frontier brief explicitly rules that out for a zero-runtime-dependency repo. The
"collision-free identity" primitive this roadmap needs is small enough to hand-roll: a content hash of
`{title, author_branch, created_at}` is sufficient collision-free identity for a *pre-numbering*
placeholder; it does not need a general sequence-CRDT.

## 2. Design

1. **`decisions/registry.json`** (new, committed, single-writer at integration time only): the reserved-
   namespace source of truth.
   ```jsonc
   {
     "next_available": 53,
     "reserved": [45, 86],          // cross-namespace citations — grep-verified, never locally reusable
     "reserved_reason": {
       "45": "cited cross-namespace by ADR-027 as revoy-spec:ADR-045",
       "86": "cited cross-namespace by <file> as revoy-spec:ADR-086"
     },
     "allocations": [
       { "number": 44, "slug": "graded-brokered-os-confinement", "placeholder_id": "..." }
     ]
   }
   ```
   `next_available` and `allocations` are derived/appended by the conductor (roadmap 12 phase 4) or by a
   standalone `scripts/adr-registry.mjs allocate` command when the conductor isn't in scope yet;
   `reserved`/`reserved_reason` are hand-maintained (a genuinely rare, deliberate, cross-namespace-citation
   event — not a per-ADR-landing operation) and validated by a test that greps `decisions/*.md` for
   `revoy-spec:ADR-\d+` citations and asserts every one is in `reserved`.
2. **Authoring-time placeholder.** An agent authoring a new ADR on a feature branch does **not** pick a
   number. It creates `decisions/ADR-PENDING-<slug>.md` (a stable, collision-free filename — two branches
   both authoring `ADR-PENDING-foo.md` and `ADR-PENDING-bar.md` never collide because slugs are chosen
   independently and a filename collision on identical slugs is a legitimate, rare, human-resolvable
   naming clash, not a numbering race). The file's frontmatter carries a `content_id` field: a hash of
   `{title, created_at, git rev-parse HEAD}` at authoring time — the "decision identity" the frontier
   brief's Automerge precedent argues for, separate from the number it will eventually receive.
3. **Allocation at landing.** `scripts/adr-registry.mjs allocate <branch-slug>` (invoked by roadmap 12
   phase 4, or standalone): reads `registry.json.next_available`, skips any value in `reserved`, assigns
   it, renames `ADR-PENDING-<slug>.md` → `ADR-0NN-<slug>.md`, rewrites internal number references inside
   the file (its own self-referential title if any), appends the row to `decisions/README.md`, and writes
   the new `next_available`/`allocations` entry back to `registry.json` — all four writes are one atomic
   commit, made by the single writer that is doing the landing (never by the authoring branch itself,
   which is the structural fix for the two-branches-guess-044 collision: **an authoring branch cannot
   commit a real number, because it never has one to commit**).
4. **Reservation is permanent and growable.** Adding a new cross-namespace citation (e.g., a future ADR
   cites `revoy-spec:ADR-120`) is a one-line addition to `registry.json.reserved` with a required
   `reserved_reason` entry — the test in step 1 makes forgetting this addition a build failure, not a
   silent citation-resolution bug (this is the structural fix for the 045 flip: an agent adding a
   cross-namespace citation and an agent adding a local ADR can no longer collide silently, because the
   citation-add is required to touch the same file the allocation-check reads).

## 3. The safety case (one property test — this is the whole roadmap)

Prove the registry makes both original collisions structurally impossible:

- **No two allocations ever produce the same number.** Assert: allocating for two branches in sequence
  (simulating landing order) never repeats a number, and `next_available` strictly increases.
- **A reserved number is never allocated.** Assert: with `reserved: [45, 86]` and `next_available: 44`,
  three sequential allocations produce `44, 46, 47` — 45 is silently skipped, never handed out, and the
  skip is logged (not merely invisible).
- **Every cross-namespace citation is reserved.** Assert: a fixture ADR file containing
  `revoy-spec:ADR-999` with `999` absent from `registry.json.reserved` fails the citation-coverage test —
  this is the pre-merge version of the contradiction the postmortem's claim-ledger gate caught only
  post-hoc.
- **An authoring branch cannot self-assign a real number.** Assert: `ADR-PENDING-*.md` files are
  rejected by `checkCounts`'/the ADR-index test as *not yet counted* (they are drafts, not decisions) —
  so a branch that never gets landed by the conductor never inflates `adr_total`, and a branch that *does*
  get landed only inflates it at the single allocation step.

If those four hold, two agents guessing "the next number" independently is no longer possible by
construction — there is no number to guess until landing.

## 4. Wiring

- `scripts/adr-registry.mjs` (allocate/verify subcommands, zero new deps).
- `decisions/registry.json` seeded with the current state: `next_available: 53`, `reserved: [45, 86]`
  (and any additional cross-namespace citation found by the grep-verification step — run it against the
  live `decisions/` tree as part of this roadmap's implementation, do not assume 045/086 are the only
  two without checking).
- `packages/arbor-governance` — extend (do not fork) `counts/check.ts`'s notion of `adr_total` to read
  `registry.json.allocations.length`, so the derivation and the allocation share one source rather than
  two independently-drifting counts.
- Roadmap 01's worktree-creation instructions (`docs/roadmaps/README.md`) gain one line: "if the roadmap
  requires a new ADR, author it as `ADR-PENDING-<slug>.md`; do not choose a number."
- `docs/roadmaps/README.md`'s roadmap-authoring template should reference this file's authoring-time
  convention so every *future* roadmap brief inherits it without re-explaining.

## 5. Tests

- The four §3 property assertions.
- End-to-end: author two fixture `ADR-PENDING-*.md` files on two branches, land both through
  `adr-registry.mjs allocate` in sequence, confirm distinct sequential numbers and a correctly updated
  `decisions/README.md`.
- Regression fixture for the exact postmortem collision: two branches both requesting allocation
  "concurrently" (simulated by calling `allocate` twice against the same starting registry state without
  an intervening write) must not both succeed with the same number — the registry write must be
  atomic/single-writer (reuse ADR-029's "one writer process per persistence directory" invariant; this
  roadmap's registry is a persistence directory of one file and inherits that ADR's discipline).

## 6. Deliverables

- An ADR (next number — allocated the old way, by hand, since this roadmap doesn't exist yet when it
  lands; note this explicitly in the ADR's own text as the last manually-numbered decision) — **Decision
  identity is assigned at authoring time; decision number is assigned once, at landing, from a registry
  that permanently reserves cross-namespace-cited numbers.** Cite ADR-029 (one writer per persistence
  directory) as the concurrency-safety precedent this reuses, and the frontier brief's Django/Atlas
  precedent for decoupling identity from arrival-order numbering. Index it in `decisions/README.md`.
- The implementation, wired and green (`npm run build`; `npx vitest run`; zero new deps; bun installs).
- A handoff note under `docs/roadmaps/handoffs/` — flag explicitly that roadmap 12 (integration
  conductor) and roadmap 15 (derived governance counts) both depend on this file's `registry.json` schema;
  land this roadmap first if sequencing is a choice.

**Risk:** Low-medium. Touches the governance/ADR surface but adds a single-writer registry file and a
naming convention — no new trust boundary, no runtime behavior change, pure repo-hygiene tooling. The
risk is entirely in getting the reserved-set grep-verification right at implementation time: an
undetected cross-namespace citation this roadmap misses reproduces the exact 045 bug it exists to
prevent, so the citation-coverage test (§3) is the roadmap's real safety case, not a formality.
