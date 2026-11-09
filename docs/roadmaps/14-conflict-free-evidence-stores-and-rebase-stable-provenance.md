# Roadmap 14 — Conflict-free evidence stores & rebase-stable provenance (postmortem R-C)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 3498984f (2026-09-22)
Authority: Retained implementation brief for conflict-free evidence stores; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — content-bound freshness and sorted JSONL merge driver observed at 2348ddbb; decision is ADR-055
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22).** The [1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md) governs release order and priority; this file is a retained implementation brief, not an active queue. Its handoff is [here](handoffs/14-conflict-free-evidence-stores.md).
>
> **Status checked at `2348ddbb` (2026-09-22): implementation present.** Content-bound freshness, the sorted JSONL merge driver, conductor regeneration, and focused tests are tracked. The handoff's ADR is allocated as ADR-055; its “ADR-PENDING” wording is obsolete.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1–§2 and §8 first
(invariants, read-list, repo gotchas). Read
`docs/postmortems/multi-worktree-branch-integration.md` §1.6, §2.C in full, and
`../research/concurrent-integration-frontier-brief.md` §2 before designing.

**Why this exists (honest framing):** `.claim-ledger/`, `.determinism-baseline/`, `.completion-depth/`,
and `.visual-intelligence/observed/` are committed, generated evidence stores. Every one of the eight
concurrent branches touched all four, so every rebase/merge conflicted on all four, and — worse —
rebasing rewrites the commit SHA each store's manifest pins as "the revision this evidence describes,"
which `store-freshness-gate.mjs` correctly refuses to trust once that SHA is no longer an ancestor of
HEAD ("revision is not an ancestor of HEAD"). The postmortem's fix was to defer all four on every branch
and regenerate once at the end. This roadmap makes that the designed behavior, not an improvised
workaround, and fixes the provenance model so a future rebase doesn't reproduce the same orphaning.

## 1. Read this first (the seams you generalize — do NOT build parallel ones)

- **`scripts/store-freshness-gate.mjs`** (read in full — 189 lines, already read for roadmap 12). Its own
  header comment states the problem precisely: "a manifest whose revision is not an ancestor of HEAD" is
  explicitly refused, by design, as a store describing "a tree not in this history." That refusal is
  *correct* for a single-writer, single-line-of-development world; it becomes a false negative the
  instant the writing commit is rebased onto a new base. This roadmap does not change that refusal — it
  changes what "revision" *means* so a rebase doesn't invalidate it.
- **`scripts/lib/store-budgets.mjs`** — `CLAIM_LEDGER_BUDGET_COMMITS` and siblings; these are the
  per-store staleness budgets the postmortem's finding C3 says are "tuned for a single line of work."
  Read them before proposing new values; do not invent a number without checking what's there.
- **`scripts/claim-ledger.ts`** (630 lines) — the claim-ledger's own writer/refresh logic; this roadmap
  does not rewrite the ledger's content model, only how its manifest records provenance.
- **ADR-034** (determinism is measured off the critical path) — states *why* the determinism baseline is
  never regenerated in CI (a flake rate measured on a shared runner measures the runner); this roadmap's
  "regenerate once at integration" model must not contradict that ADR — regeneration happens at the
  conductor's landing step (roadmap 12 phase 5), which is an operator-invoked, off-critical-path action,
  consistent with ADR-034, not a CI job.
- **`../research/concurrent-integration-frontier-brief.md` §2** — Automerge's content-hash DAG is the
  reference architecture: causal history keyed by `hash(actor, counter, deps, op)`, never a commit SHA.
  The brief explicitly recommends **not** adopting a CRDT library (zero-dependency invariant) but
  **adopting the pattern**: hash the *evidenced content*, not the *commit that wrote it*.

**Not to be confused with:** this roadmap does not change what the four stores *record* (claim
provenance, determinism measurements, completion-depth results, vi-observed findings) — only *how their
manifest asserts freshness*. Do not redesign the claim-ledger's data model while implementing this.

## 2. Design

1. **Content-hash provenance, replacing ancestor-SHA pinning.** Each store's manifest currently records
   (inferred from `store-freshness-gate.mjs`'s ancestor check) a revision SHA it was produced at. Add a
   second, primary field: `content_hash` — a hash over the **input tree the store was derived from**
   (e.g., for the claim ledger: a hash of the sorted set of `EvidenceRef`s it ingested; for
   completion-depth: a hash of the reachability-fact inputs). The freshness gate's ancestor check becomes
   a **secondary, advisory** signal (useful for the "how many commits behind" distance metric it already
   computes) while the **primary** freshness question — "does this store's content still match what the
   current tree would produce" — is answered by recomputing the content hash cheaply (without running the
   full expensive producer) and comparing. This is directly the Automerge lesson: identity keyed to
   content, not to a git ref that rebase is free to rewrite.
2. **Union-mergeable write discipline for the two purely-additive stores** (claim-ledger,
   vi-observed — confirm additivity by reading their writer code; do not assume). For a store whose
   entries are independently-keyed and never mutated in place, the git-level conflict on the JSONL file is
   an artifact of line-based diffing, not a real semantic conflict: two branches both *appending* distinct
   entries produce a textually-conflicting file whose correct resolution is always "keep both, re-sort by
   key." Add a `.gitattributes` custom merge driver (`merge=union-sorted-jsonl`) for these two stores'
   files, backed by a small `scripts/lib/union-sorted-jsonl-merge.mjs` (zero deps — implements RFC-compliant
   git merge-driver stdin/stdout contract) that performs exactly that union-and-resort. This closes C1 for
   the additive stores without touching the two stores that are genuinely single-measurement snapshots
   (determinism-baseline, completion-depth), which stay "not committed on branches, regenerated once at
   integration" per §3.
3. **Not-committed-on-branches for the two measurement-snapshot stores.** `.determinism-baseline/` and
   `.completion-depth/` are, per ADR-034 and the postmortem, expensive, off-critical-path, single-writer
   snapshots — not append-only logs. These are the two stores the postmortem's "regenerate once at the
   end" fix targets most directly. Add them to a **branch-local gitignore overlay** (a `.gitattributes`
   `export-ignore`-style marker recognized by the roadmap-01 worktree setup, or — simpler and equally
   correct — a documented convention that feature branches run `<store>:refresh --scratch` locally for
   development feedback but never commit the result, and the conductor (roadmap 12 phase 5) is the only
   process that commits a real refresh, against the real trunk). State explicitly in this roadmap's ADR
   which of the four stores get the union-merge treatment and which get the never-commit-on-branch
   treatment — do not apply one strategy uniformly where the two store shapes differ.
4. **Re-derive budgets for concurrent cadence (C3).** With regeneration happening once per conductor run
   rather than continuously per-commit, the *number of commits since last refresh* metric
   `store-freshness-gate.mjs` computes changes meaning: it will legitimately spike right before a
   multi-branch integration and drop to zero right after. Change the budget check to accept either "within
   budget" or "a `regenerate-stores` run is scheduled/in-flight" (a small lockfile-style marker the
   conductor writes at phase 5 start and clears at phase 5 end) rather than flagging every pre-integration
   state as a violation.

## 3. The safety case

This roadmap does not cross a trust boundary (it is repo/build hygiene over already-existing evidence
stores) but it does touch a **correctness-of-evidence** property the governance system relies on
elsewhere (claim-ledger contradiction detection, ADR-033's "completeness claims carry a durable record");
a broken merge here silently corrupts evidence rather than losing it loudly, so the property tests below
are load-bearing:

- **Content-hash freshness survives rebase.** Assert: a store manifest produced at commit A, then commit A
  rebased to commit A′ (same tree content, different SHA, simulating a rebase that touched unrelated
  files elsewhere in the repo), still passes the freshness gate under content-hash comparison, where it
  would previously fail under pure ancestor-SHA comparison. This is the direct fix for postmortem finding
  C2.
- **Union merge never drops an entry.** Assert: two branches each independently appending N and M distinct
  entries to the same additive store, merged via the custom driver, yields exactly N+M entries (no loss,
  no duplication) sorted by key. Assert also that a genuine duplicate key (same entry appended on both
  branches, e.g. both re-ran the same claim check) collapses to one entry, not two.
- **A never-committed store is never silently trusted stale.** Assert: `store-freshness-gate.mjs` treats a
  feature branch's local scratch refresh of `.determinism-baseline/` as **not present** for gate purposes
  if that branch is checked as a landing candidate without having gone through the conductor's phase 5 —
  i.e., a branch cannot fast-forward on the strength of a refresh it ran locally and forgot to commit,
  because it was never supposed to commit it; the gate's authority stays exclusively with what the
  conductor produced against real trunk.

## 4. Wiring

- `scripts/lib/store-provenance.mjs` — content-hash computation per store, shared by
  `store-freshness-gate.mjs` (extend, do not fork) and each store's own refresh script.
- `scripts/lib/union-sorted-jsonl-merge.mjs` + `.gitattributes` entries for the claim-ledger and
  vi-observed store paths.
- `scripts/lib/store-budgets.mjs` — extend with the "regeneration in-flight" exemption from §2 step 4.
- `docs/roadmaps/README.md` and roadmap 01's worktree setup instructions gain one line: which stores are
  union-mergeable (commit freely) vs. never-commit-on-branch (refresh locally for feedback, let the
  conductor commit the real one).
- Verify against the real stores, not a fixture-only test: on a scratch worktree, actually trigger a
  union-driver merge on the real `.claim-ledger/` path with two divergent branches and confirm
  `bun run claims:refresh --verify` (or whatever the existing verify entrypoint is — confirm its exact
  name from `package.json` before writing the ADR) still passes after the merge.

## 5. Tests

- The three §3 property assertions.
- `store-freshness-gate.mjs` regression suite extended with a content-hash-vs-ancestor-SHA disagreement
  fixture (content matches, SHA is not an ancestor — must pass) and the inverse (SHA is an ancestor,
  content hash mismatches because someone hand-edited the store — must fail; this is a new failure mode
  the SHA-only check couldn't see at all, so it is a strict improvement, not just a rebase fix).
- Union-merge driver: standard git merge-driver contract test (stdin `%O %A %B` paths, correct exit
  codes for clean-merge vs. needs-manual-resolution).

## 6. Deliverables

- An ADR (next number, via roadmap 13's registry if it has landed, otherwise the manual process) —
  **Evidence-store freshness is content-hash-provenanced, not commit-SHA-pinned; additive stores merge by
  union, measurement-snapshot stores are never committed on feature branches.** Cite ADR-034 (why
  determinism stays off the critical path — this roadmap's "regenerate once at integration" model is
  compatible with, not a violation of, that ADR) and the frontier brief's Automerge precedent. State
  explicitly which of the four stores got which treatment and why (this is the one-sentence distinction a
  future reader needs — do not leave it implicit). Index it in `decisions/README.md`.
- The implementation, wired and green (`npm run build`; `npx vitest run`; zero new deps; bun installs).
- A handoff note under `docs/roadmaps/handoffs/` — flag the dependency direction with roadmap 12 (the
  conductor's phase 5 is this roadmap's primary caller) and note that if roadmap 12 hasn't landed yet, the
  `regenerate-stores` entry point this roadmap builds must still be independently invocable by an operator
  by hand, not only through the conductor.

**Risk:** Medium. Evidence-store correctness is load-bearing for downstream governance gates (claim-ledger
contradiction detection, SUR-05 count checks); a bug in the union-merge driver or the content-hash
computation corrupts evidence silently rather than failing loudly, which is the same shape of danger as
the sandbox `read` case (E2) even though the trust boundary is different. The mitigation is the same
discipline: property tests before wiring, never trust the merge driver's own "it merged cleanly" as proof
of correctness.
