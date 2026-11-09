# Roadmap 16 — Trunk contract & branch-dependency provenance (postmortem R-A)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 3498984f (2026-09-22)
Authority: Retained implementation brief for trunk contract and branch-dependency provenance; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — trunk contract, preflight and submit checks observed at 2348ddbb; branch examples are authoring-time
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22).** The [1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md) governs release order and priority; this file is a retained implementation brief, not an active queue. Its handoff is [here](handoffs/16-trunk-contract.md).
>
> **Status checked at `2348ddbb` (2026-09-22): implementation present.** The committed trunk contract, preflight and submit checks, conductor integration, and focused Git-fixture tests are tracked. The example declaring `feature/mcp-client` is historical; the tracked contract now declares `master`.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1–§2 and §8 first
(invariants, read-list, repo gotchas). Read
`docs/postmortems/multi-worktree-branch-integration.md` §1.1, §1.5, §2.A in full before designing.

**Why this exists (honest framing):** the working checkout was on `feature/mcp-client` (the de-facto
trunk, every recent commit landed there) while the `master` ref sat 23 commits stale. All eight roadmap
branches forked from the stale ref, so each conflicted with 23 commits of already-landed work it had
never seen, and `git rebase master` silently no-op'd because "master" was technically an ancestor of
the stale point every branch actually forked from. Separately, roadmap 11's branch was stacked on seven
other roadmap branches with no record of that fact — a plain rebase tried to replay seven duplicate
commits against master's now-canonical versions of the same work. Neither failure mode required bad
judgment; both required only the absence of a written-down, checked fact.

## 1. Read this first

- **`docs/postmortems/multi-worktree-branch-integration.md` §1.1 and §1.5** — the two concrete incidents
  this roadmap prevents. Read them as the acceptance criteria: a fixture reproducing each must be caught
  by this roadmap's preflight, not merely documented as a lesson.
- **`docs/roadmaps/README.md`** — the current worktree-creation instruction:
  `git worktree add ../revoy2-<slug> -b feature/<slug> master`. This roadmap does not change that
  command — it adds a **preflight check** that runs before it, and a **declaration file** the resulting
  branch carries.
- **Recall memory `trunk-is-feature-mcp-client`** (referenced in this session's own memory index) — the
  exact drift this roadmap closes was still true as of this dispatch: "the de-facto trunk is branch
  feature/mcp-client, not the stale master." A working trunk-contract mechanism would have made that a
  repo-readable fact instead of an operator's private memory note.
- **ADR-023** (no rollback target — worktree isolation plus the ledger suffice) — this roadmap's
  declaration file is a *preflight/provenance* record, not a new safety mechanism competing with that
  ADR's reasoning; state the distinction in the new ADR's text.

## 2. Design

1. **`.arbor/integration.jsonc`** (new, committed at repo root, single-writer — the operator/integrator
   updates it, not implementing agents): the durable trunk declaration.
   ```jsonc
   {
     "trunk_ref": "feature/mcp-client",   // the branch/ref that IS the integration base, right now
     "trunk_head_at_declaration": "4ae6396",
     "declared_at": "2026-08-12T00:00:00Z",
     "note": "master is stale pending an explicit re-point; do not fork from master while this is true."
   }
   ```
   This is intentionally a **file**, not a convention — `git symbolic-ref` or a README sentence is exactly
   the "nothing in-repo declared which was canonical" gap A1 names. A file is `git diff`-able,
   `grep`-able by tooling, and can't silently go stale the way a comment can (a preflight check, §2 step
   2, keeps it honest).
2. **Preflight check** (`scripts/trunk-preflight.mjs`, zero deps): run at worktree-creation time (a
   thin wrapper roadmap 01's `git worktree add` instruction becomes, or a standalone command an agent
   runs manually before authoring). Reads `.arbor/integration.jsonc`, confirms:
   - the branch about to be created (or the current branch, if checking an existing one) has
     `trunk_ref`'s current head as an ancestor — if not, **refuse** with the exact remediation ("rebase
     onto `<trunk_ref>` before continuing," not a generic warning);
   - `master` and `trunk_ref` are not both plausible bases (i.e., if `git merge-base master
     <trunk_ref>` is not `master`'s own head, meaning master has diverged rather than just trailing) —
     surface this loudly rather than silently trusting whichever the agent happened to pass.
   This closes A1/A2 directly: the ambiguity the postmortem hit (which ref is real trunk) becomes a single
   file read instead of tribal knowledge, and a fork from the wrong base is refused before any work is
   done on it, not discovered hours later at integration.
3. **`depends_on` provenance.** Extend the roadmap-authoring handoff-note template
   (`docs/roadmaps/handoffs/`) with a required field: `depends_on: []` — a list of other roadmap slugs (or
   branch names) this branch's work builds on, populated by the authoring agent at branch-creation time
   (it is the one who knows, e.g., "I am building commands/plugins on top of the not-yet-landed hook bus").
   `scripts/trunk-preflight.mjs` also validates this field is present (may be empty) before allowing work
   to proceed — an empty list is a deliberate, checked claim of independence, not an omission. This is the
   direct fix for A3/postmortem §1.5: roadmap 12's conductor (if implemented) or a manual integrator both
   read this field to compute the DAG edges the merge order depends on, instead of discovering the
   stacking relationship by having a rebase try and fail to replay duplicate commits.
4. **Re-pointing trunk is an explicit, logged act.** When `master` is finally fast-forwarded to match the
   de-facto trunk (or the reverse — the de-facto trunk is rebased onto a corrected `master`), the
   operator updates `.arbor/integration.jsonc` in the same commit, so the file's history *is* the
   trunk-topology history — a future postmortem investigating "which ref was canonical when" reads this
   file's git log instead of reconstructing it from memory.

## 3. The safety case

This is a preflight/provenance tool, not a new authority surface — it never grants, executes, or
approves anything; it only refuses to let work start from a base the repo itself says is wrong, and
records a claim (`depends_on`) that downstream tooling reads. The property worth proving:

- **A fork from a non-trunk base is refused, not warned.** Assert: given `.arbor/integration.jsonc`
  declaring `trunk_ref: X`, attempting to validate a branch forked from stale `Y` (where `X` has diverged
  ahead of `Y`) exits non-zero with the specific remediation message — not a soft warning a script can
  ignore.
- **A stacked branch without a `depends_on` declaration is flagged.** Assert: a branch whose commit range
  actually contains commits also present, verbatim, in another named branch (the exact roadmap-11 shape —
  detectable via matching commit messages/patch-ids, `git cherry` or `git patch-id` comparison) but whose
  handoff note declares `depends_on: []` is flagged as an inconsistency at preflight time, not discovered
  at rebase time.
- **The trunk declaration is itself checked against reality.** Assert: if `.arbor/integration.jsonc`
  claims a `trunk_head_at_declaration` that is *not* actually an ancestor of the live `trunk_ref`'s current
  head (i.e., the file itself has gone stale — nobody updated it after trunk advanced), the preflight
  check reports the file as stale rather than trusting it uncritically; a stale trunk-declaration file is
  exactly as dangerous as no file, and must not be a false sense of safety.

## 4. Wiring

- `.arbor/integration.jsonc` seeded with the current real state (`trunk_ref` read from whatever this
  roadmap's own implementation branch was actually forked from — verify with `git log`, do not guess).
- `scripts/trunk-preflight.mjs`, invoked from `docs/roadmaps/README.md`'s worktree-creation step (update
  that doc's instructions in this same roadmap — a roadmap that adds a preflight check but doesn't wire it
  into the documented worktree-setup flow is not done, per this repo's own "done means wired" standard).
- `docs/roadmaps/handoffs/` template — add the required `depends_on` field; update any *existing* handoff
  notes for roadmaps 01–11 retroactively only if trivial (this is optional backfill, not required scope —
  state the decision explicitly in the ADR rather than leaving it ambiguous).
- Roadmap 12 (integration conductor), if it exists or lands later, reads `depends_on` directly from the
  handoff notes this roadmap makes required — note that dependency explicitly in both roadmaps' handoff
  notes so neither implementer has to rediscover it.

## 5. Tests

- The three §3 property assertions.
- Regression fixtures for both original incidents: (a) a two-ref divergence fixture reproducing the
  `master`/de-facto-trunk drift, confirming the preflight refuses a fork from the stale one; (b) a
  duplicate-commit fixture reproducing roadmap 11's stacking, confirming an undeclared `depends_on` is
  flagged.

## 6. Deliverables

- An ADR (next number, via roadmap 13's registry if landed) — **The integration base is a checked,
  git-committed declaration, not an inferred convention; branch stacking is a declared, checked fact, not
  a rebase-time discovery.** Cite the postmortem's §1.1 and §1.5 incidents directly as the ADR's
  motivating cases (this roadmap's whole justification is those two specific failures — the ADR should
  name them, not paraphrase them). Distinguish this from ADR-023's rollback-target reasoning in one
  sentence. Index it in `decisions/README.md`.
- The implementation, wired and green (`npm run build`; `npx vitest run`; zero new deps; bun installs),
  including the `docs/roadmaps/README.md` update.
- A handoff note under `docs/roadmaps/handoffs/` stating this roadmap's own `depends_on` (none — it is a
  foundational piece other roadmaps in this set, especially 12, depend on).

**Risk:** Low. Pure preflight/provenance tooling, no runtime behavior, no trust boundary. The only
operational risk is a stale `.arbor/integration.jsonc` being trusted uncritically — closed by the third
§3 property, which is why it is written as a hard requirement rather than a nice-to-have.
