# ADR-141: Orchestration Belongs To The Harness, Not To A Connector

**Status:** Superseded
**Date:** 2026-08-27
**Authoring Revision:** edcb26973fc4d82f587cf2a4b3fc454230ef94bf
**Content ID:** sha256:8e08255c7a219649f76ee025f55978c23ffd64048521f37767b2b4e50a0d1ba6

**Superseded by ADR-142** (2026-08-27). This record's thesis — that
orchestration belongs to the native harness and that opencode, codex,
claude-code and bedrock are connector plugins subsumed by revoy2's
governance model — stands. Its cost estimate does not: the claim below
that the change is exhausted by moves, renames and import rewrites was
measured on 2026-08-27 and falsified. 16 arbor-mcp source files import 35
symbols from @arbor/opencode, 13 of them value imports, so moving the
spine leaves those edges intact and does not collapse loop.ts's mirrors.
ADR-142 states the real shape and the real cost.

## Context

revoy2's stated adoption model is that an organization keeps working the way
it already works: in an IDE, through its harness of preference governed via
the revoy2 connector, or whole-hog through the canopy harness. In that model
opencode, codex, bedrock, and claude-code are peers — connector plugins,
subsumed by the governance model, orchestrated by revoy2 shelling out to
them for their particular strengths.

The package graph says something else.

**`@arbor/mcp` — the native harness — depends on `@arbor/opencode`.** Its
`package.json` lists `"@arbor/opencode": "*"` among ten dependencies, and
`packages/arbor-mcp/src/selfhost.ts` imports `runCampaign` from it directly.
The orchestration spine of the entire system —
`packages/arbor-opencode/src/loop.ts`, ~3083 lines implementing the
halt-check → `selectNode` → `expandNode` → dispatch specialist → dispatch
critic → `recordResult` → decide cycle — lives inside a package named after
one vendor. The arrow points from the harness to a connector.

**The spine is already vendor-neutral in substance.** `loop.ts` imports
`@arbor/core`, `@arbor/audit`, `@arbor/mcp`, `@arbor/campaign-support`, and
two local siblings. Nothing opencode-specific. All twelve occurrences of the
string "opencode" in the file are comments, and several are the file
objecting to its own placement.

**The misplacement has a measurable cost, already paid three times.** Because
`@arbor/mcp` imports `@arbor/opencode` at runtime, `loop.ts` cannot import
back — even `import type` completes a cycle in the TypeScript project-
reference graph, not merely the runtime module graph. So the file maintains
three hand-written mirrors instead:

1. `CampaignManagerPort` — a structural match for `@arbor/mcp`'s
   `CampaignManager`, declared locally with the reason stated in full at
   `packages/arbor-opencode/src/loop.ts:109-127`.
2. `ExecutorContextComposition` — "structural mirror of
   `NativeContextCompositionObservation` (@arbor/harness). Defined
   independently rather than imported so arbor-opencode never gains a
   dependency on arbor-harness" (`packages/arbor-opencode/src/loop.ts:405-408`).
3. `TURN_BUDGET_EXPANSION_CEILING = 32` — duplicated from
   `claude-code-campaign.ts`'s `SPECIALIST_MAX_TURNS_DEFAULT`, with the
   instruction "**Keep the two values in sync by hand if either changes**"
   (`packages/arbor-opencode/src/loop.ts:779-787`).

The third is a documented DRY violation with a manual synchronization
requirement — precisely the duplicated knowledge this repository's own
conventions forbid, accepted here only because the dependency direction left
no alternative. The first two are defensible as ports; the reason they exist
is not.

## Decision

**The orchestration spine moves out of the connector package, and the
harness/connector dependency arrow inverts.**

1. **The neutral spine relocates.** `loop.ts`, `race.ts`,
   `race-threshold.ts`, and `context-economy.ts` leave
   `packages/arbor-opencode/` for a vendor-neutral package. These four are
   already free of vendor-specific logic; this is a move, not a rewrite.

2. **What remains in `arbor-opencode` is the actual connector.**
   `plugin.ts`, `permissions.ts`, and `skills/` are genuinely
   opencode-shaped: an opencode plugin entry point, opencode's permission
   grants, opencode's skill wiring. That package becomes a peer of the
   codex, bedrock, and claude-code connectors rather than the host of the
   loop they all run under.

3. **`agents.ts` moves to core vocabulary, not to the connector.** The
   eleven botanical personas are consumed by the native role composer —
   `defaultNativeRoleFor`'s enumeration is the entire subject of ADR-136 —
   so they are shared vocabulary the harness depends on, not one connector's
   configuration. Leaving them in a connector package would recreate the
   same inverted arrow in miniature.

4. **The three mirrors collapse into imports once the arrow flips**, and
   `TURN_BUDGET_EXPANSION_CEILING` stops being hand-synchronized. This is
   the observable payoff and the check that the move actually worked: if any
   of the three still has to be a mirror afterwards, the inversion was
   incomplete.

5. **No behavior changes.** This decision is exhausted by moves, renames,
   and import rewrites. No function's logic is altered, nothing is added,
   nothing is removed. `runCampaign` computes exactly what it computes
   today.

## Consequences

The dependency graph starts describing the product's own thesis: a harness
that governs, and connectors it drives. A reader tracing "where does
orchestration live" arrives at a neutral package rather than at a vendor
name, and a future connector author has an obvious place to plug in rather
than an obvious package to be confused by.

The cost is a wide, mechanical diff. Every importer of `@arbor/opencode`'s
moved symbols changes; `tsconfig` project references change; `package.json`
dependency lists change; `scripts/reachability/entry-points.json` names
`arbor-opencode/src/plugin.ts` as one of four reachability entry points and
must be re-pointed; the visual-intelligence graph and the claim ledger both
re-derive. The blast radius is large precisely because the misplacement was
load-bearing.

This is a refactor with no test to prove it "works" beyond the existing
suite continuing to pass — which is the honest situation for a move, and the
reason Decision §4 names a structural check (the mirrors collapse) rather
than a behavioral one. If the suite passes and the three mirrors become real
imports, the move is correct; if the mirrors survive, it is not.

Nothing about governance, authority, or the tree-search algorithm changes.
An operator sees no difference. This ADR buys architectural legibility and
one retired hand-sync obligation, not capability.

## Alternatives / Roads not taken

**Leave it and document the arrow.** Rejected: it is already documented, in
three separate comments in the file that suffers from it, and the
documentation has not stopped the cost from being paid three times. A
comment explaining why a workaround exists is not a substitute for removing
the need for the workaround.

**Rename `arbor-opencode` to something neutral and leave the contents.**
Rejected: this hides the problem rather than fixing it. The package would
then contain both the vendor-neutral spine and opencode's own plugin and
permissions, so the next connector author still finds opencode's
configuration sitting inside the shared orchestration package, and
`arbor-mcp` still depends on a package containing one vendor's plugin entry.

**Invert by having `arbor-opencode` stop importing `@arbor/mcp` types
entirely, keeping the mirrors permanently.** Rejected: this is the status
quo formalized. It accepts a hand-synchronized constant as permanent, and
the ports-as-mirrors pattern is only defensible when it buys genuine
decoupling — here it buys nothing, because the two packages are not
independently deployable and never will be.

**Move the spine into `@arbor/core`.** Rejected as too broad: `core` holds
the tree, scoring, and persistence — data structures and pure functions
whose testability depends on having no orchestration in them. `runCampaign`
drives worktree leases, dispatches models, and awaits critics; folding it
into `core` would put I/O and lifecycle concerns into the one package that
is currently free of both.

## Obligations

### O1 — The harness currently depends on the connector, and the orchestration spine is inside the connector package

`packages/arbor-mcp/package.json` lists `"@arbor/opencode"` as a dependency,
and `packages/arbor-mcp/src/selfhost.ts` imports `runCampaign` from it.
`runCampaign` is declared in `packages/arbor-opencode/src/loop.ts`. Verified
by reading all three.

<!-- unverifiable: this states the CURRENT package graph, established by reading package.json and the import sites, not a new capability a roundtrip test exercises -->

### O2 — `runCampaign` is the single orchestration entry point the move must preserve, and it is exercised by the existing suite

`runCampaign` is the one function every campaign dispatch path reaches —
`selfhost.ts` calls it directly and `task-composer-admission.ts` reaches it
through `runCampaignJob`. A move that preserves its behavior is a move that
preserves orchestration, which is what makes the existing suite an adequate
check for a pure relocation.

<!-- proof: symbol=runCampaign file=packages/arbor-opencode/src/loop.ts roundtrip=packages/arbor-opencode/tests/loop.test.ts -->

### O3 — The three hand-maintained mirrors exist because of the dependency direction, and their collapse is the structural check that the inversion succeeded

`CampaignManagerPort` (`loop.ts:109-127`), `ExecutorContextComposition`
(`loop.ts:405-408`), and `TURN_BUDGET_EXPANSION_CEILING` (`loop.ts:779-787`)
each carry a comment naming the dependency direction as their reason for
existing. Decision §4 makes their replacement by real imports the test of
whether the arrow actually flipped.

<!-- unverifiable: states the CURRENT presence and stated rationale of three declarations, verified by reading loop.ts; the post-move assertion cannot be roundtrip-tested until the move is performed -->

### O4 — This decision performs no behavior change, so no new roundtrip proof is owed for the move itself

The ADR is exhausted by moves, renames, and import rewrites. Its correctness
condition is that the existing suite continues to pass unchanged, not that a
new capability appears.

<!-- unverifiable: a non-addition claim; the check is the unchanged existing suite passing after the move, which cannot be expressed as a proof triple over a symbol this ADR introduces -->
