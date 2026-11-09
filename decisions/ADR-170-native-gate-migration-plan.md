# ADR-170: Native-Feasible Gates Migrate Into the Harness as the Source of Truth

**Status:** Accepted
**Date:** 2026-09-24
**Authoring Revision:** fb50b6227362f82a501524ff77e495525c3a7af5
**Content ID:** sha256:a02a2fad653927e2be63ad38551d2c0f78fbd6537302a817626e068a248e3f1f

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR
governance by ADR-024's ratification note).

This repository's ~65 quality/governance gates (`scripts/execution-profile.json`,
`scripts/gate-manifest.json`) exist because revoy2 has historically run *inside*
external harnesses (Claude Code, Codex, OpenCode) whose own tool-dispatch and
process lifecycle are opaque to it — ADR-024 established this precisely: "a
transport that accepts instructions from a party it does not control" is the
case revoy2's own in-process capability gate exists for, and the host's own
tool-dispatch boundary is explicitly *not* something revoy2 can or should
duplicate in-process (ADR-024, Alternative 2, rejected). Given that constraint,
wrapping checks in git hooks and a CI-orchestrated subprocess battery was the
only available enforcement surface, and it worked: this is the mechanism
behind every `gate:*` script and the pre-push hook (ADR-025's local-only
substitute for GitHub branch protection this repo cannot obtain).

**That constraint does not apply to revoy2's own native harness
(`packages/arbor-*`).** The native harness is not an opaque external process
revoy2 wraps — it *is* revoy2, running the campaign loop in-process with
direct, live access to tree/node state as it happens, not reconstructed after
the fact from git history or a subprocess's exit code. ADR-028 already proved
this works for revoy2-owned mutating surfaces (`enforceAction`'s capability-tier
check, invoked directly by `RuntimeCatalogRouter` before every mutating
dispatch — no subprocess, no git hook). A survey of the ~65 existing gates
(conducted 2026-09-24, methodology and full per-gate table below) found the
same is true for a much larger set than previously wired natively:

**~30 gates are already pure in-process computations with zero subprocess
dependency** — TypeScript-compiler-API AST scans (`anti-stub`, `reachability`,
`entrypoint-reachability`, `registration-integrity`, `closed-enum-hygiene`,
`tui-catalog-parity`, `package-boundaries`), or pure file/registry/JSON reads
(`adr-sections`, `adr-citations`, `adr-retirement-integrity`,
`adr-decision-followthrough`, `governance-counts`, `obligations`,
`remedy-coverage`, `merge-critical-check`, `audit-disposition`, `lockfile`,
`language-census`, `gap-status`, `project-conform`, `project-registry`,
`vi-vendor`, `reuse-compliance`, `stop-budget`, `stop-guard-releases`,
`repo-session-conformance`, `finalization-progress`, `eval-regression`,
`ledger-audit`). Each currently runs as a `scripts/*.mjs`/`*.ts` file spawned
as a subprocess by the CI/pre-push battery *only because that battery is the
one enforcement surface available to it* — not because the check itself needs
a subprocess boundary.

**One gate already proves the migration pattern works.**
`scripts/obligations-gate.ts` is not itself an implementation: it is a thin
CLI wrapper that imports `buildObligationCoverageReport` from
`@arbor/governance` and reports its result. The obligation-coverage logic
lives natively in the package; the external gate script is a connector to it,
not a duplicate implementation. `scripts/eval-regression-gate.ts` follows the
identical shape, calling `runBenchmark`/`runBaseline` from `@arbor/eval`
directly. Neither of these gates is "external tooling that happens to also
work" — they are native package functions with a CI-invocable wrapper, which
is exactly the shape this record proposes generalizing to the other ~30.

**Two categories genuinely resist this and should not be forced native.**
Git-provenance-binding gates (`vi-freshness`, `store-freshness`,
`branch-accounting`, `worktree-hygiene`, `adr-trace`, `adr-acceptance-staged`,
`decisions-precommit`, `hook-liveness`) are fundamentally about binding a
generated artifact's provenance to git commit ancestry or staging-area state —
concepts that exist only because content is versioned in git. The native
harness has no equivalent primitive (a campaign node is not a git commit), and
inventing one to replace these gates would mean reimplementing git's own
diff/ancestry machinery inside the harness for no real gain. Real-execution-oracle
gates (`gate:coverage`, `gate:typecheck-tests`, `gate:determinism`,
`gate:liveness`, `gate:hollow-parity`, `gate:opentui`) intentionally re-execute
real code (tests, `tsc`, benchmarks) as their verification technique — that is
not orchestration overhead to eliminate, it is the actual check. These ~17
gates stay external, unconditionally, under this record.

## Decision

**Migrate the ~30 native-feasible gates into `packages/arbor-*` as pure,
exported, in-process functions, callable from three places instead of one:**

1. **The native campaign loop, live**, via `packages/arbor-gate` — so e.g.
   `anti-stub`'s AST scan or `package-boundaries`' import check can run against
   a Specialist's proposed diff *before* it is even submitted to Lenticel, not
   discovered at push time after the fact. This is the actual point of the
   migration: earlier, cheaper, in-loop feedback that no external harness
   wrapping revoy2 could give it, because only revoy2's own process has this
   state live.
2. **The existing external CI/pre-push battery, unchanged in effect.** Each
   migrated gate's `scripts/*-gate.mjs` file is reduced to the
   `obligations-gate.ts`/`eval-regression-gate.ts` shape: import the native
   function, call it, print/exit on its result. `scripts/execution-profile.json`
   and `scripts/gate-manifest.json` do not change what they enforce or when —
   this record changes *where the logic lives*, not the CI contract, so no
   existing gate's blocking/advisory status, context wiring, or timeout
   changes as part of this migration.
3. **Any connected external harness, via the runtime catalog (MCP).** revoy2
   already exposes governance state this way — `governance.snapshot` and
   `governance.backlog` are real catalog query kinds any connected client can
   invoke (Claude Code, Codex, or a future harness alike), proven by
   `RuntimeCatalogRouter`'s existing test coverage. Migrated gates should be
   exposed the same way (new `*.check` query kinds, or folded into
   `governance.snapshot`'s projection), so a "bring your own harness"
   integration gets *the same governance verdicts revoy2's own native loop
   uses*, in real time, over MCP — not a stale post-hoc CI log. This is the
   concrete mechanism for the "1:1 with connectors" goal: one native
   implementation, three callers, not three implementations to keep in sync.

**Package placement** (proposed, not finalized — each individual gate's
migration commit settles its own exact module):
- ADR/governance-record gates (`adr-sections`, `adr-citations`,
  `adr-retirement-integrity`, `adr-decision-followthrough`,
  `governance-counts`, `remedy-coverage`, `audit-disposition`,
  `merge-critical-check`, `gap-status`) → `@arbor/governance`, alongside the
  existing `packages/arbor-governance/src/obligation/coverage.ts`/
  `packages/arbor-governance/src/record/transitions.ts` machinery they are the
  same kind of check as.
- Code-quality/reachability gates (`anti-stub`, `reachability`,
  `entrypoint-reachability`, `registration-integrity`, `closed-enum-hygiene`,
  `tui-catalog-parity`, `package-boundaries`, `lockfile`, `language-census`,
  `reuse-compliance`, `project-conform`, `project-registry`) → `@arbor/gate`,
  alongside `checkAdmission`/`checkIsolation`/`checkEvidence` as a new class of
  pure check the campaign loop can invoke.
- The remaining native-feasible gates (`vi-vendor`, `stop-budget`,
  `stop-guard-releases`, `repo-session-conformance`, `finalization-progress`,
  `eval-regression`, `ledger-audit`) stay wherever their existing native
  counterpart already lives (`@arbor/eval` for eval-regression, `@arbor/audit`
  for ledger-audit, etc.) — they are already close to this shape.

**Migration order**: gate-by-gate, smallest/lowest-risk first, each as its own
commit with the external `scripts/*-gate.mjs` file reduced to a wrapper in the
*same* commit that adds the native function — never a commit that adds native
logic while leaving the external gate as a parallel, divergence-prone
duplicate. Suggested first three (zero subprocess, zero git dependency, small,
already well-tested): `gate:anti-stub`, `gate:lockfile`, `gate:governance-counts`.

## Consequences

**Positive.** The native campaign loop gains real, in-loop enforcement for a
class of checks it currently has none of (code-quality/ADR-hygiene checks
happen only at push time today, per-node in a campaign never sees them).
"Bring your own harness" integrations (Claude Code, Codex, a future one) get
governance parity with the native loop for free, over the same MCP surface
they already use, rather than needing their own reimplementation or a stale
CI log. The `obligations-gate.ts`/`eval-regression-gate.ts` precedent means
zero new architectural pattern is invented — this is generalizing something
already proven, not a experiment.

**Negative.** ~30 gate migrations is real, ongoing work, not a single change
— this record sets direction and package placement, not a completion date.
Each migration must preserve the existing gate's exact CI-observable
behavior (same pass/fail conditions, same error messages where reasonably
possible) or `scripts/tests/pre-push-prose.test.mjs`-style drift-detection
tests will (correctly) flag the CI contract as changed when it should not
have.

**Negative, load-bearing.** This does not reduce the ~17 gates that stay
external. A reader must not conclude from this record that "the CI battery
is going away" — the git-provenance-binding and real-execution-oracle
categories are permanent, not a residual to shrink to zero over time.

## Alternatives / Roads not taken

1. **Leave all ~65 gates external and build a separate native governance
   system from scratch.** Rejected: duplicates working logic, and this
   repository's own culture (AGENTS.md) treats "building something that
   already exists" as its most-repeated defect class. `obligations-gate.ts`
   already proves the reuse-by-import shape works; reinventing it native-only
   would be exactly that defect.
2. **Force the git-provenance-binding and real-execution-oracle gates native
   too, for uniformity.** Rejected in Context above: these categories check
   concepts (git ancestry, real code execution) that have no meaningful
   in-process equivalent, or whose entire value *is* the external
   re-execution. Forcing them native would mean reimplementing git or faking
   a test run — both worse than the status quo.
3. **Migrate everything in one large commit.** Rejected: ~30 gates is enough
   surface that a single commit could not be meaningfully reviewed, and a
   mid-migration failure would leave no clean rollback point. Gate-by-gate
   commits, smallest first, are this record's explicit ordering.

## Obligations

### O1 — The generalize-by-import migration pattern this record proposes already works for one governance gate today

<!-- proof: symbol=buildObligationCoverageReport file=packages/arbor-governance/src/obligation/report.ts roundtrip=packages/arbor-governance/tests/obligation/report.test.ts -->

`scripts/obligations-gate.ts` is a thin CLI wrapper around this native,
exported, tested function — proving the target shape (native implementation,
thin external connector) is not aspirational but already load-bearing in this
repository.

### O2 — The same pattern independently works for a second, unrelated gate category (evaluation regression, not governance records)

<!-- proof: symbol=runBenchmark file=packages/arbor-eval/src/benchmark.ts roundtrip=packages/arbor-eval/tests/eval.test.ts -->

`scripts/eval-regression-gate.ts` wraps this native, exported, tested
function the same way — two independent existing gates following the
proposed shape, not one example generalized too far from a single data
point.

### O3 — Governance state is already exposed to any connected external harness via the same MCP capability catalog this record proposes exposing migrated gates through

<!-- proof: symbol=RuntimeCatalogRouter file=packages/arbor-mcp/src/runtime-catalog.ts roundtrip=packages/arbor-mcp/tests/runtime-catalog.test.ts -->

`governance.snapshot`/`governance.backlog` are real, tested catalog query
kinds reachable by any MCP-connected client today — the "1:1 with
connectors" mechanism this record proposes for migrated gates is an
extension of an existing, working precedent, not a new integration surface.
