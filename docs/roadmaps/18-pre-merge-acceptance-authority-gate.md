# Roadmap 18 — Pre-merge acceptance/authority gate (postmortem R-G)

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
`docs/postmortems/multi-worktree-branch-integration.md` §1.8, §2.B (B3) in full before designing.

**Why this exists (honest framing):** two of the eight implementing agents (roadmaps 09 and 10) marked
their own ADRs `Status: Accepted` — a direct violation of ADR-044's own preamble, "implementation
authority is not acceptance authority." Nothing in the write-time path stopped it; the only backstop was
the claim-ledger's post-hoc contradiction gate, which caught it at the very end of integration because the
decision index said `Proposed` while the file said `Accepted`. That gate worked, but only because someone
happened to run it before landing and happened to notice the contradiction it flagged. This roadmap moves
that same check earlier and makes it a hard pre-merge refusal instead of a downstream signal an integrator
has to know to look for.

## 1. Read this first

- **ADR-044's own preamble** (`decisions/ADR-044-graded-brokered-os-confinement.md`) — read the exact
  sentence the postmortem cites ("implementation authority is not acceptance authority"). This roadmap's
  entire justification is enforcing that sentence mechanically instead of relying on every future
  implementing agent to have internalized it.
- **The claim-ledger contradiction gate** (`scripts/claim-ledger.ts`, `scripts/claim-ledger-precommit.mjs`
  — read both) — the existing mechanism that *did* catch this, post-hoc, at integration. Read exactly
  how it detects a contradiction between the decision index (`decisions/README.md`'s `Status` column) and
  a file's own frontmatter `Status:` line. This roadmap does not replace that detection logic — it moves
  the **same check** to run at a point where it can refuse a commit, not just flag a discrepancy an
  integrator must separately go looking for.
- **`decisions/README.md`** — confirm the exact `Status` values in current use (`Accepted`, `Proposed`, and
  the compound `Accepted (ratified ...; ... deferred to ADR-028)` form seen on ADR-024) before writing a
  validator — a naive equality check will false-positive on that compound form; the validator must parse
  the leading status token, not the whole cell.
- **ADR-026** (the campaign tree-search loop is a supervised job) and **ADR-024/028** (tool-execution
  enforcement is a host trust boundary) — cited here only for the *pattern* they establish: authority to
  *act* (implement) is deliberately kept separate from authority to *approve* (accept) throughout revoy2's
  governance model; this roadmap generalizes that same separation to the ADR lifecycle itself, which is
  slightly reflexive (the governance system governing its own governance artifacts) and worth stating
  plainly in the new ADR's text.

**Not to be confused with:** this is not a role-based access-control system (revoy2 has no notion of
distinct "implementer" vs. "acceptor" user accounts — every agent runs with the same repo write access).
The check this roadmap builds is **provenance-based, not identity-based**: it asks "did the *same commit*
that introduces this ADR also mark it Accepted," which is a reliable proxy for self-acceptance without
needing any authentication model revoy2 doesn't have and shouldn't build for this.

## 2. Design

1. **The rule, stated precisely.** An ADR file's `Status:` may be `Proposed` (or a compound status whose
   leading token is `Proposed`) in the **same commit** that first introduces the file. A commit that
   changes an ADR's `Status:` to `Accepted` (leading token) must be a **separate, later commit** from the
   one that created the file — this is the mechanical proxy for "an implementing agent may propose, only a
   separate, later, deliberate act may accept." It does not require knowing *who* made the later commit
   (no identity model needed) — only that acceptance is never bundled into the same commit as authorship,
   which structurally rules out "I wrote it and marked it Accepted in one motion," the exact shape of the
   roadmap 09/10 incident.
2. **`scripts/adr-acceptance-gate.mjs`** (new, zero deps, mirrors `store-freshness-gate.mjs`'s shape and
   its `--json` convention): for a given commit (default `HEAD`, or a range for the conductor's use),
   inspect each ADR file it touches:
   - if the file is **newly added** in this commit and its `Status:` leading token is anything other than
     `Proposed`, **refuse** ("a newly-authored ADR must be Proposed; only a later, separate commit may
     accept it").
   - if the file **already existed** before this commit and this commit changes its `Status:` leading
     token to `Accepted`, check whether this is the *same commit* that also modifies the file's substantive
     content (its Context/Decision/Consequences body, not just the Status line) — if so, **refuse** ("an
     acceptance commit must be status-only; do not bundle content changes with an acceptance").
   - reuse the claim-ledger's existing index-vs-file contradiction check (§1) as a second, independent
     signal: if `decisions/README.md`'s `Status` column and the file's own `Status:` disagree at any point
     in the history this gate inspects, refuse with the same message the claim-ledger already produces —
     do not reimplement that parsing, import it.
3. **Wire as a pre-commit hook AND a roadmap-12-conductor pre-land check.** Pre-commit catches the mistake
   at authoring time, on the implementing agent's own branch, before it ever reaches an integrator (this
   is the R-G ask precisely: "make the contradiction check a *pre*-merge gate, not a post-hoc catch"). The
   conductor check (if roadmap 12 exists) is defense in depth for a branch authored before this roadmap
   landed, or authored without the hook enabled.

## 3. The safety case

This is not a new trust or authority boundary in the ADR-024/028 sense — no tool gains capability, no
sandbox is involved. Its correctness property is about **not creating false negatives** (letting a
self-acceptance through) more than false positives (a legitimate acceptance commit blocked), because a
false negative here reproduces exactly the incident this roadmap exists to close:

- **Same-commit self-acceptance is refused.** Assert: a fixture commit that both adds
  `ADR-999-foo.md` and sets its `Status: Accepted` is refused by the gate, with the specific
  "same commit" reason in the output — this is the direct regression test for the roadmap 09/10 incident.
- **Legitimate two-commit acceptance passes.** Assert: commit 1 adds the ADR at `Status: Proposed`;
  commit 2, containing *only* a `Status:` line change to `Accepted` (diff touches no other line), passes
  cleanly — the gate must not be so strict it blocks the correct workflow, only the collapsed one.
- **Content-plus-acceptance bundling is refused even across otherwise-separate commits' worth of intent.**
  Assert: a commit that changes both an ADR's body text *and* flips its Status to Accepted in one commit
  is refused, even if the file itself was added in an earlier commit — bundling substantive edits with
  acceptance is exactly the kind of "one motion" self-authority the rule exists to prevent, not merely the
  narrower "created and accepted in the literal same commit" case.
- **The existing claim-ledger contradiction detector is reused, not reimplemented.** Assert (a code-shape
  test, not just a behavior test): `adr-acceptance-gate.mjs` imports the index-vs-file comparison function
  from `scripts/claim-ledger.ts` rather than containing a second parser for the same `Status:` grammar —
  two independent parsers of the same format is exactly the kind of drift-prone duplication this repo's
  own conventions (DRY, one authoritative source per fact) warn against.

## 4. Wiring

- `scripts/adr-acceptance-gate.mjs`.
- Pre-commit hook registration alongside `scripts/claim-ledger-precommit.mjs` — reuse the existing hook
  chain/registration mechanism rather than adding a second, parallel one.
- `package.json`: an `adr:acceptance-check` script entry, independently runnable.
- If roadmap 12 (integration conductor) exists at implementation time, wire `adr-acceptance-gate.mjs` as a
  required check in its phase 3 isolation gate, alongside `bun run build`/`vitest run` — note this
  explicitly in both roadmaps' handoff notes so neither implementer has to rediscover the connection.
- `docs/roadmaps/README.md` — add one line to the roadmap-authoring convention: an implementing agent
  proposes its ADR in the same commit as the file's creation and never sets `Status: Accepted` itself; a
  separate acceptance commit is an integrator/operator action.

## 5. Tests

- The four §3 property assertions.
- Regression fixture reproducing the exact roadmap 09/10 shape from the postmortem (a single commit
  creating an ADR file with `Status: Accepted` from the start) — this must be refused as the load-bearing
  acceptance test for the whole roadmap.
- A fixture reproducing the ADR-024 compound-status form (`Accepted (ratified ...; ... deferred to
  ADR-028)`) to confirm the leading-token parser handles it correctly and doesn't false-positive on the
  parenthetical.

## 6. Deliverables

- An ADR (next number, via roadmap 13's registry if landed) — **ADR acceptance is never bundled into the
  same commit as an ADR's authorship or content changes; a pre-commit gate enforces this mechanically,
  reusing the existing claim-ledger contradiction detector rather than duplicating its parsing.** Cite
  ADR-044's own preamble as the rule this roadmap enforces mechanically, and the postmortem's roadmap
  09/10 incident by name as the motivating case. Index it in `decisions/README.md`.
- The implementation, wired and green (`bun run build`; `bun run test`; zero new deps; bun installs).
- A handoff note under `docs/roadmaps/handoffs/` — this roadmap has no hard dependency on any other
  roadmap in this set and can land independently and early; note its optional integration point with
  roadmap 12 if that lands later.

**Risk:** Low. A pre-commit hook enforcing a rule already stated in ADR-044's own text; no new trust
boundary, no runtime behavior change, and the check reuses an existing, already-correct parser rather than
introducing a new one. The only meaningful risk is a false positive blocking a legitimate multi-part
acceptance workflow the design didn't anticipate — mitigated by keeping the rule narrow (same-commit
bundling only) rather than trying to infer intent more broadly.
