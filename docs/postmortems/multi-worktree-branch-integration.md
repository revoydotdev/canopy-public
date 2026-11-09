# Postmortem — Multi-Worktree / Multi-Branch Concurrent Development & Integration

**Date:** 2026-08-12
**Scope:** The concurrent implementation of roadmaps 04–11 across 8 isolated git worktrees/branches
by parallel agents, and their sequential integration into `master` (from stale `be6c6f0` →
`7bc4cae`, 51 ADRs, 3365 tests green). <!-- sur-05:historical -->
**Author:** integrator (primary agent), written immediately after the integration while the failure
modes are fresh.
**Status:** durable input for a `the-future` frontier-research dispatch and the roadmaps that follow.

---

## 0. Why this exists

Eight roadmaps were implemented **in parallel**, each by a separate agent in its own worktree, each
forked from an **old baseline** (`be6c6f0`) rather than the de-facto trunk. Every one built,
tested green, and honored its own safety case *in isolation*. Integration — merging all eight into
one trunk — is where the cost lived. This document is a logical stress test writeup: it treats the
integration friction as **signal about missing infrastructure**, not as one-off bad luck, and asks
at each stage: *what would have made this cheap and safe instead of expensive and error-prone?*

The integration succeeded (all green), but almost entirely on **manual, un-repeatable operator
judgment**. That is the core finding: revoy2 has strong *governance of a single line of work* and
**almost no governance of concurrent lines of work converging**.

---

## 1. What actually happened (timeline of friction)

1. **Branch-topology drift discovered mid-integration.** The working checkout was on
   `feature/mcp-client` (`4ae6396`), which was the *de-facto trunk* — every recent commit landed
   there — while the real `master` ref sat stale at `be6c6f0`, ~23 commits behind. All eight roadmap
   branches had forked from the **stale** baseline, so each conflicted with 23 commits of
   already-landed work (crash-continuation, `repository.list`/`glob`, `task-composer-admission`) it
   had never seen. A `git rebase master` silently no-op'd because "master" was an ancestor.

2. **First merge attempt (`git merge` into trunk) aborted.** The most-isolated branch (05, sandbox)
   still produced a deep semantic conflict in `native-tool-host.ts` (sandbox-broker rewrite vs. the
   list/glob read-tools), and git's auto-merge produced regions that **could not be confidently
   verified** — a `read` left on the direct-fs path under the new `async` sandbox signature would
   *pass every test but silently skip confinement*. Build+test is not a sufficient net for that
   class. The characterization "mostly mechanical / additive conflicts" was wrong; aborted and
   re-planned.

3. **Switched to per-branch rebase-in-worktree → verify-in-isolation → fast-forward.** For each of
   the 8, in dependency order (05 → 04 → 07 → 10 → 06 → 08 → 09 → 11): rebase onto the *current*
   master, resolve conflicts against the real code, `npm run build` + full `vitest` in isolation,
   then `--ff-only`, then re-rebase the next onto the advanced master. This kept master green at
   every step and each landing independently verified — but it is ~8× a manual, hours-long,
   high-touch process.

4. **ADR-number collisions surfaced repeatedly.** The 8 branches each guessed the next ADR number
   off different bases: two claimed 044, two claimed 047. Worse, one guessed **045**, which
   `decisions/ADR-027` already cites *cross-namespace* as revoy-spec's `ADR-045-tier`; creating a
   local `revoy2:ADR-045` made a governance citation test flip a deliberately-unresolvable citation
   to `derived`. 045 (and 086) are effectively **reserved**. Renumbered everything by landing order,
   **skipping 045**.

5. **Roadmap 11 re-contained already-landed commits.** Its branch was stacked on top of the
   MCP/skills/hook-bus branches, so a plain rebase tried to replay 7 duplicate commits (identical
   messages like "harden governed MCP client boundaries"), each conflicting against master's now-
   canonical version. Fixed with `git rebase --onto master <last-duplicate> <branch>` to replay only
   the 8 *unique* commits.

6. **Gate-store thrash on every single merge.** `.claim-ledger/`, `.determinism-baseline/`,
   `.completion-depth/`, `.visual-intelligence/observed/` are committed generated stores; every
   branch touched them, so every merge/rebase conflicted on them, and rebasing **orphaned their
   revision pointers** ("revision is not an ancestor of HEAD"). Deferred all of them and regenerated
   once at the end.

7. **Governance-count coupling.** The literal ADR count is hand-written in three docs
   (`AGENTS.md`, `.claude/skills/revoy2-implementation-audit/SKILL.md`, `docs/release-readiness.md`)
   plus the `decisions/README.md` index; each ADR addition drifts all four and trips
   `checkCounts`/`buildGovernanceSnapshot`. Had to hand-edit counts on every branch.

8. **Self-acceptance of ADRs.** Two agents marked their own ADRs **Accepted** (roadmaps 09, 10),
   violating revoy2's own "implementation authority is not acceptance authority" (ADR-044's own
   preamble). Caught only by the claim-ledger *contradiction* gate at the very end (index said
   Proposed, file said Accepted). Corrected to Proposed.

9. **Persistent stale LSP diagnostics throughout.** False `recovery_protection`/`Cannot find module`
   errors during every rebase/merge. A dispatched investigation confirmed: tsserver's per-file
   watchers coalesce/drop updates during large external filesystem rewrites (git checkout/rebase/
   merge across ~12 project-reference programs); no config fix; `tsc --build` + vitest are ground
   truth. This *worked*, but only because the operator knew to distrust the LSP — a fragile
   discipline.

---

## 2. Problems by stage (the durable catalogue)

### A. Branch/trunk hygiene
- **A1 — No authoritative "trunk" signal.** The real trunk (`feature/mcp-client`) and the `master`
  ref disagreed for the entire session; nothing in-repo declared which was canonical. Agents forked
  from the wrong base by default.
- **A2 — Fork-from-stale-baseline.** Parallel agents forked from an old point, guaranteeing each
  branch conflicts with *all* work landed in the interim, not just with each other.
- **A3 — Branch stacking without provenance.** Roadmap 11 silently contained 7 other roadmaps'
  commits; nothing recorded "this branch depends on / is stacked on branches X, Y, Z."

### B. ADR / decision-record numbering
- **B1 — Concurrent number allocation is a race.** Sequential integer ADR ids assigned by
  independent agents collide by construction. Observed: 044×2, 047×2.
- **B2 — Cross-namespace number collisions.** Local ids share an integer space with cited external
  (revoy-spec) ids; 045/086 are cited cross-namespace and must never be locally reused. This is
  invisible to an agent picking "the next number."
- **B3 — Status self-authority.** Nothing prevents an implementing agent from writing
  `Status: Accepted`; the only backstop is a downstream contradiction gate.

### C. Generated / evidence stores
- **C1 — Committed generated stores conflict on every branch.** Claim-ledger, determinism,
  completion-depth, vi-observed are all committed and all touched by every branch.
- **C2 — Rebase orphans store provenance.** The store-freshness gate requires the recorded revision
  to be an *ancestor* of HEAD; rebasing rewrites SHAs and breaks that, forcing expensive
  regeneration (esp. determinism re-measurement, vi:observe scenario runs).
- **C3 — Budgets are tuned for a single line of work.** `vi-observed` sat at 57/60; any 5-commit
  feature tipped it over budget. Concurrency multiplies commit distance and blows these budgets.

### D. Doc-derived governance
- **D1 — Hand-written counts.** ADR counts duplicated across four files; a single-writer assumption
  (one ADR added at a time, counts updated by hand) in a multi-writer world.
- **D2 — Fixtures pinned to specific ids.** Governance tests hardcode example ADR numbers (045, 086)
  whose "unresolvable" status is invalidated by new local ADRs.

### E. Merge mechanics & correctness
- **E1 — Deep semantic conflicts on shared hot files.** `cli.ts` (touched by 6 branches),
  `native-agent-executor.ts` (4), `loop.ts` (4), `harness-session-journal.ts`, `index.ts` (7).
  Examples that required real reasoning, not textual merging:
  - 06's session-start hook gate re-declared `const role`/`profileId` that master already computed
    (duplicate-declaration bug avoided only by reading the surrounding flow).
  - 08's `routing_tier` overlapped skills' `allowed_tools`/`extension_tools`/`structured_schema` in
    the *same* `model_for_role` signature and body; and 08's direct `const model = …` would have
    **duplicated** master's `composedModel`→`observeRecoveryModel` flow.
  - The journal `Entry` union and `replay()` dispatch had to fuse crash-continuation kinds
    (`operation_checkpoint`, `continuation_authorization`) with the hook-bus kind (`hook_fired`) and
    the sandbox `normalizeLegacyEntry` — three features' additions to one exhaustive switch.
  - 09's cost-pruning `!suppressCostExpansion` had to be woven into 04's `taskComplete` branch guard
    in `loop.ts` — two features modifying the same conditional.
- **E2 — Auto-merge produces unverifiable hybrids.** The sandbox `read` case demonstrates a merge
  that compiles and passes tests but silently drops a *security* property. Tests are necessary, not
  sufficient, for merge correctness.
- **E3 — No dependency/conflict-aware ordering.** Merge order (isolated-first; 06 before 11) was
  derived by hand from a manually-built shared-file matrix.

### F. Tooling / environment
- **F1 — LSP staleness under heavy git ops.** Diagnostics unreliable during exactly the operations
  integration requires; only operator discipline ("trust the build") saved it.
- **F2 — Concurrent git index race** (previously recorded): a sibling's `git add -A` sweeps another
  agent's staged files into its commit; isolated worktrees are the mitigation but weren't used
  uniformly.

### G. Verification model
- **G1 — Isolation-green ≠ composition-correct.** Each branch was green alone; interactions
  (e.g., 06+08+09+11 all editing `native-agent-executor`) only surfaced at merge and were caught by
  re-running the full suite post-merge — but E2 shows the suite can miss cross-cutting property loss.
- **G2 — "Done" was self-reported per branch.** Independent integrator verification (build + full
  suite + reading the safety-case tests + confirming wiring) was essential and entirely manual.

---

## 3. Root causes (the two sentences)

1. **revoy2 governs a single evolving line of work extremely well and has essentially no primitives
   for many lines converging** — no shared-resource allocation (ADR ids, store ownership), no
   trunk/base contract, no dependency provenance between branches, no integration conductor.
2. **Several correctness signals are single-writer by construction** (hand-written counts,
   ancestor-pinned store provenance, sequential id assignment, id-pinned fixtures), so concurrency
   turns them from guardrails into merge hazards.

---

## 4. What revoy2 should build (recommendations, by stage — seeds for roadmaps)

> These are hypotheses to be sharpened by the frontier-research pass (§5), not final designs.

- **R-A (trunk contract).** A durable, in-repo declaration of the integration base (a `TRUNK` marker
  / `.arbor/integration.jsonc`) and a preflight that refuses to start roadmap work forked from a
  non-trunk base, or auto-forks from trunk. Consider forbidding branch *stacking* without a declared
  `depends_on`.
- **R-B (decision-id allocation).** Remove sequential-integer races: either a **reservation ledger**
  (agents claim an id/range before authoring), **content-addressed decision ids** (hash- or
  ULID-based, human-aliased at integration), or **defer numbering to the integration conductor**
  (branches use stable placeholder slugs; numbers assigned once, gap-free, avoiding a
  cross-namespace **reserved set**). Encode 045/086 (and any future cross-namespace citations) as
  reserved.
- **R-C (mergeable / regenerable stores).** Make evidence stores either (i) **not committed on
  branches** and regenerated deterministically at integration, or (ii) **conflict-free by
  construction** (append-only, content-sorted, union-mergeable) with provenance that survives rebase
  (content hash of the tree, not an ancestor SHA). Re-derive store budgets for concurrent cadence.
- **R-D (derived governance counts).** `checkCounts`/`buildGovernanceSnapshot` should **compute**
  counts from the filesystem and *inject* them into rendered docs, never compare to hand-written
  numbers. Fixtures must not pin specific live ids; use synthetic/out-of-range ids or assert the
  *property* (cross-namespace non-resolution) independent of the example.
- **R-E (integration conductor).** A tool that: reads the branch set, builds the shared-file
  conflict graph + `depends_on` DAG, computes a safe merge order, for each branch rebases onto the
  advancing trunk, resolves the mechanical conflicts (imports/exports/union types) automatically,
  flags the *semantic* ones for review, renumbers decision ids, regenerates stores, and runs the
  isolation gate — i.e., automates §1.3–§1.8. The manual version worked; it should be a program.
- **R-F (semantic-merge safety).** Property checks that survive a merge, beyond example tests:
  e.g., "every `file.*`/`shell.execute` path routes through the sandbox broker," "the veto chain
  wraps every specialist tool port," expressed so a merge that drops them fails loudly (E2).
- **R-G (acceptance gate).** A gate that an implementing agent's decision record is `Proposed`, never
  self-`Accepted` (make the D1 contradiction check a *pre*-merge gate, not a post-hoc catch).
- **R-H (LSP/tooling discipline).** Codify "trust `tsc --build`/vitest, restart tsserver after big
  git ops" as an operator/agent protocol (or a hook that reindexes), so it isn't tribal knowledge.

---

## 5. Open questions for the frontier-research pass (`the-future` agent)

Query arXiv / current systems literature and OSS practice for prior art on each; return citations
and a recommendation per item. These are deliberately posed as research questions, not answers:

1. **Concurrent unique-id allocation without a coordinator** — CRDT-style / content-addressed /
   ULID / Hybrid-Logical-Clock approaches for assigning collision-free, human-meaningful ids
   (ADR numbers, migration numbers) across parallel branches. What do large monorepos and
   schema-migration tools (Rails/Django/Prisma/Atlas/Sqitch) actually do about the "two PRs both
   grab migration N" problem, and what does the research say?
2. **Conflict-free / mergeable structured stores** — append-only + deterministic-merge formats,
   semantic (AST/graph) merge, and provenance that is rebase-stable (tree content hashes vs. commit
   SHAs). CRDTs for repo-committed evidence; three-way *semantic* merge research.
3. **Automated multi-branch integration** — "merge queues," speculative/optimistic integration,
   conflict-graph scheduling, and the research on *stacked-diff* / patch-theory (Pijul/darcs) models
   that make base-drift and duplicate-commit problems structurally impossible.
4. **Merge correctness beyond tests** — property-based and type-level guarantees that a semantic
   property (a security invariant like sandbox confinement) cannot be silently dropped by a textual
   merge; verified/semantic merge literature.
5. **Governance-as-derivation** — deriving documentation facts (counts, indexes, status) from a
   single source so multi-writer edits never drift; and single-source decision-record systems
   (Log4brains, adr-tools, MADR) under concurrency.
6. **Multi-agent software-engineering integration** — current frontier work (2025–2026) on many
   coding agents producing branches that must converge: coordination protocols, ownership/locking of
   shared resources, and evaluation of integration cost.

---

## 6. Deliverables that should follow this postmortem

1. **Frontier research brief** (from the `the-future` dispatch): cited prior art + a recommendation
   for each §4 recommendation / §5 question, marking what to adopt vs. build.
2. **Roadmaps** (one per durable piece uncovered — written in the `docs/roadmaps/` house style),
   candidate set derived from §4:
   - *Decision-id allocation & reserved-namespace registry* (R-B).
   - *Conflict-free evidence stores + rebase-stable provenance* (R-C).
   - *Derived governance counts & id-independent fixtures* (R-D).
   - *Integration conductor* (R-E) — likely the highest-leverage.
   - *Semantic-merge safety properties* (R-F).
   - *Trunk contract & branch dependency provenance* (R-A).
   - *Pre-merge acceptance/authority gate* (R-G).
   Each roadmap must carry its own ADR obligation and a reduction/■safety case where it crosses a
   trust or governance boundary, consistent with roadmaps 01–11.

---

*Ground truth for this postmortem: master `7bc4cae`, 8 branches (roadmaps 04–11) integrated,
build exit 0, 3365/3365 tests passing, all four freshness gates green, ADRs 044 + 046–052 (045
reserved). The integration is correct; the process that produced it is not yet repeatable — that is
the work this document hands forward.*
