# Sequencing the OpenCode deprecation migration (ADR-061, steps 2-4)

**Status:** Proposal, not an ADR. Nothing here is authorized by being written down.

**Date:** 2026-08-18. Every citation below was read directly from this repository at
`96086b6`.

## Why this document exists

`docs/operator-ux-readiness.md` §"OpenCode deprecation migration" names four
structural steps remaining after ADR-061's first tranche (capability-bound
integration selection, already landed — see below) and states plainly:

> Until step 4 passes, the repository must describe OpenCode as a deprecated
> transitional dependency—not as already optional.

This document assesses the true current state of all four steps against the
code (not the doc's prose), and proposes how to sequence steps 2-4 into
landable, green-at-every-commit tranches. It does not execute steps 2-4. It
also does not re-litigate ADR-061's decision — that record stands; this is
implementation planning underneath it.

## What ADR-061's own numbering already delivered (verified)

ADR-061's own step list (in the ADR body, distinct from the doc's four
"remaining" steps) has a step 1: *"capability-bind executable integrations
and remove upstream construction from the generic runner."* This is real,
not aspirational:

- `packages/arbor-harness/src/integration-registry.ts` defines
  `HarnessIntegrationRegistry<T>` — an atomic pairing of an admitted
  connector descriptor with one opaque implementation.
- `packages/arbor-mcp/src/campaign-harness-integration.ts` defines the
  `CampaignHarnessIntegration` port (`createExecutor`, `createReviewer`,
  optional `createDecomposer`) — Revoy-owned, importing only `LoopExecutor`/
  `ReviewerRunner` *types* from `@arbor/opencode`.
- `packages/arbor-mcp/src/cli.ts:1188` — `createProductionCampaignRunner`
  constructs a `HarnessIntegrationRegistry<CampaignHarnessIntegration>` and
  selects through it. It does not construct an OpenCode executor, reviewer,
  or decomposer directly (ADR-061 obligation O2).
- `packages/arbor-mcp/src/integrations/opencode-campaign.ts` holds
  `createOpenCodeCampaignIntegration` — the OpenCode binding registered
  *into* that registry, explicitly commented `"Transitional built-in
  adapter; intended to move to an installable plugin package."`

So the production `campaign.run` path is already integration-selected, not
OpenCode-hardcoded. That is real progress the doc's four-step list doesn't
credit separately, and it's worth naming because it narrows what's actually
left: the four remaining steps are about the **legacy/adjacent call sites**
that bypass the registry, and about the **package boundary**, not about the
production runner's dispatch mechanism.

## Step-by-step assessment (evidence, not the doc's prose)

### Step 1 — "move Revoy-owned loop, worktree, critic, routing, and token contracts out of the mixed `@arbor/opencode` package"

**Status: not started. Confirmed by direct read of every file in
`packages/arbor-opencode/src/` (6,968 lines across 20 files).**

Two genuinely different categories live in this one package today:

**A. Revoy-owned, generic, no OpenCode SDK/schema coupling** (~5,276 lines,
verified by grep for `opencode`/`@opencode-ai`/`spawn`/`child_process` in
each file — hits are only in doc comments or class names, never in an
executable dependency):

| File | Lines | What it is |
|---|---|---|
| `loop.ts` | 2,767 | `runCampaign`, the deterministic tree-search loop, `LoopExecutor`/`ReviewerRunner` port contracts |
| `worktree.ts` | 744 | `WorktreeManager` — git worktree + lease management (spawns `git`, not opencode) |
| `retry-context-capsule.ts` | 537 | retry/failure-fingerprint capsule build/verify/project |
| `race-threshold.ts` | 207 | ADR-069 learned fork threshold |
| `critics.ts` | 232 | `PanelOfCritics`, `PANEL_CRITICS`, `reconcile` |
| `token-economy-boundary.ts` | 174 | token dispatch/overflow contracts |
| `sibling-scan.ts` | 204 | X-1 sibling-site completeness scan (spawns `git`) |
| `canonical-adapter.ts` | 77 | `modelCapabilityTokenBridge` |
| `recovery-lease.ts` | 74 | `OpenCodeRecoveryLeaseAdapter` — ADR-012 bridge; named "OpenCode" but structurally matches the MCP port to avoid an OpenCode→MCP dependency, not because it needs the OpenCode SDK |
| `output-boundary.ts` | 85 | `prepareOutput`, evidence capture |
| `cost-attribution.ts` | 63 | node cost attribution |
| `context-economy.ts` | 24 | context economy observation |
| `communications.ts` | 88 | selection communications |

**B. Genuinely OpenCode-specific** (~1,011 lines — these mirror OpenCode's
own plugin/agent/permission JSON schemas):

| File | Lines | What it is |
|---|---|---|
| `agents.ts` | 331 | `buildAllAgents`, `CAPABILITY_TIER`, `deriveDispatchForeground` — binds the 11 botanical agents to OpenCode's agent-config shape |
| `categories.ts` | 206 | `ARBOR_CATEGORIES`, `routeCategory`, `deriveCandidateNodeCard` — the 5-category taxonomy consumed by "the opencode task tool's category parameter" (categories.ts:4) |
| `permissions.ts` | 158 | builds "opencode v1 nested-glob" permission config |
| `types.ts` | 140 | hand-written mirrors of `@opencode-ai/plugin`'s `PluginInput`/`Hooks`, "declared locally so the package type-checks... without `@opencode-ai/plugin` installed" |
| `plugin.ts` | 176 | `arborPlugin` — the actual opencode plugin entry point (`config`/`dispose` hooks) |

**The entanglement that makes this not a clean split:** `agents.ts` and
`categories.ts` (category B — genuinely OpenCode-shaped) export
`deriveDispatchForeground`, `deriveCandidateNodeCard`, `CAPABILITY_TIER`,
and `routeCategory`, and these are imported by
`packages/arbor-mcp/src/runtime-catalog.ts:110` — the **native runtime
router**, which has nothing to do with OpenCode. The 11-agent/5-category
taxonomy was designed as OpenCode plugin config but has since become the
canonical Revoy dispatch taxonomy used by the native path too. Splitting
category A out cleanly is mechanical; category B cannot simply move to an
"OpenCode integration" package without either (a) breaking the native
runtime catalog's import, or (b) first extracting the taxonomy itself
(agent names, category names, tier assignment — the *data*, not the
OpenCode config-shape builders) into a still-more-generic home. That is a
real design decision this document does not make.

### Step 2 — "package OpenCode subprocess/provider code as an installable integration"

**Status: partially misdescribed by the doc. The actual OpenCode
subprocess/provider code does not live in `@arbor/opencode` at all — it
already lives in `packages/arbor-mcp/src/`.**

Evidence:
- `packages/arbor-mcp/src/opencode-executor.ts` (827 lines) —
  `import { spawn } from "node:child_process"` (line 15); spawns and tracks
  OpenCode CLI child processes directly.
- `packages/arbor-mcp/src/opencode-server-executor.ts` (762 lines) — uses
  "the platform's native `fetch` and a plain `spawn`, not the
  `@opencode-ai/sdk`" (its own doc comment, line 30) to drive `opencode
  serve`.
- `packages/arbor-mcp/src/opencode-decomposer.ts` (248 lines).

These 1,837 lines are already assembled into the registry-selected
`createOpenCodeCampaignIntegration` (`integrations/opencode-campaign.ts`),
but they sit as plain files inside `@arbor/mcp/src`, not as an installable
package with its own `package.json`. Step 2, accurately stated, is: *extract
`opencode-executor.ts`, `opencode-server-executor.ts`, and
`opencode-decomposer.ts` (plus `integrations/opencode-campaign.ts`) from
`@arbor/mcp` into a new installable package* — not a move out of
`@arbor/opencode`, which never held this code. `@arbor/opencode`'s
contribution to OpenCode subprocess drive is limited to category B above
(agent/category/permission config shape), which the new package would need
to depend on or absorb.

### Step 3 — "convert legacy `demo`, recovery fallback, provider-capability probe, and `selfhost` call sites to injected integrations"

**Status: not started. Confirmed not done** — these four call sites all
construct OpenCode executors/adapters directly rather than receiving them
through `HarnessIntegrationRegistry`:

- `packages/arbor-mcp/src/demo.ts` — imports `createOpenCodeLoopExecutor`,
  `createOpenCodePanelReviewer`, `createOpenCodeServerLoopExecutor`,
  `createOpenCodeDecomposer` directly (lines 11-18) and calls them inline
  (lines 285, 474, 481, 487) rather than through the registry that
  `createProductionCampaignRunner` uses.
- `packages/arbor-mcp/src/selfhost.ts` — same pattern; its own doc comment
  states "The executor is the REAL one (`createOpenCodeLoopExecutor`..." and
  calls it directly at line 605, `createOpenCodeDecomposer` at line 638.
- `packages/arbor-mcp/src/recovery-lease-adapter.ts:38` — constructs `new
  OpenCodeRecoveryLeaseAdapter(...)` unconditionally; no fallback selection.
- `packages/arbor-mcp/src/cli.ts:238` — `OpenCodeProviderCapabilityAdapter`
  class implementing `ProviderModelCapabilityPort`, constructed directly
  (`buildConfigInspection`, imported by `demo.ts:20`), not registry-selected.

None of these four sites go through `HarnessIntegrationRegistry`. This is
real migration debt, exactly as ADR-061's Consequences section already
admits: *"generic contracts and legacy self-host/demo paths still import
it, and those remaining edges are reported migration debt rather than
disguised as completion."*

### Step 4 — "remove `@arbor/opencode` from `@arbor/mcp` dependencies and TypeScript references; prove the native CLI/TUI/test lane with that package absent"

**Status: not started, and explicitly out of scope for this document per
the task's own guardrails.** Current surface: `packages/arbor-mcp/src/`
imports `@arbor/opencode` in 22 source files and 12 test modules (enumerated
below). `arbor-mcp/tsconfig.json:17` carries a project reference to
`../arbor-opencode`. `arbor-opencode/package.json` declares
`@opencode-ai/plugin` as an **optional peer dependency**, and it is **not
installed anywhere in this repository** (`node_modules/@arbor/opencode`
exists as the workspace-linked local package; no `@opencode-ai` directory
exists in `node_modules` at any depth). That confirms the doc's implicit
claim: `@arbor/opencode` today type-checks and runs its own test suite with
zero real OpenCode SDK present — the entanglement blocking step 4 is
`@arbor/mcp`'s dependency on `@arbor/opencode` as a *package*, not on the
OpenCode SDK as a *runtime*. Removing the dependency edge is a much larger
change than installing/uninstalling anything; it requires steps 1-3 to
already have relocated everything `@arbor/mcp` needs.

**Full import-symbol enumeration** (`@arbor/mcp/src` importing from
`@arbor/opencode`, by symbol):

- Values: `runCampaign`, `DEFAULT_LOOP_CONFIG`, `WorktreeManager`,
  `PanelOfCritics`, `routeCategory`, `resolveLearnedForkThresholdMs`,
  `verifyRetryContextCapsule`, `buildAllAgents`, `CAPABILITY_TIER`,
  `deriveDispatchForeground`, `modelCapabilityTokenBridge`,
  `OpenCodeRecoveryLeaseAdapter`, `deriveCandidateNodeCard`,
  `DEFAULT_NODE_CARD_SECRET`, `appendGovernedOverlay`, `FAULT_MATRIX`,
  `PANEL_CRITICS`, `composeSpecialistPrompt`, `projectTokenDispatchPrompt`
- Types only: `LoopExecutor`, `ReviewerRunner`, `CriticResult`, `LoopEvent`,
  `NeedsUserInputSignal`, `SpecialistResult`, `CampaignRetryContextPort`,
  `RetryContextCapsule`, `TokenEconomyConfig`,
  `GovernedOverlayCheckpointPort`, `ChangedFile`, `ReviewerVerdict`,
  `CampaignExecutionStrategy`, `CampaignLoopConfig`,
  `OpenCodeRecoveryLeaseOptions`, `CampaignReport`

Cross-referencing against the category A/B split above: every value/type in
this list traces to a category-A (generic) file **except**
`buildAllAgents`, `CAPABILITY_TIER`, `deriveDispatchForeground`,
`deriveCandidateNodeCard`, `DEFAULT_NODE_CARD_SECRET`, and `routeCategory`,
which trace to category B (`agents.ts`/`categories.ts`). This is the same
entanglement flagged under step 1: it is the reason step 4 cannot be a
simple "delete the import line" once category A moves — the taxonomy
symbols are real, live dependencies of `runtime-catalog.ts` and
`loop-ports-helper.ts` (native dispatch), not incidental.

## Proposed tranche sequence

Each tranche is scoped to land independently, green at every commit, with
the next tranche blocked only by the previous one — not by steps further
down the list.

**Tranche 1 — extract category-A contracts verbatim into a new package**
(e.g. `@arbor/campaign-loop` or similar; naming is a decision this document
does not make). Move `loop.ts`, `worktree.ts`, `critics.ts`,
`retry-context-capsule.ts`, `token-economy-boundary.ts`, `race-threshold.ts`,
`communications.ts`, `output-boundary.ts`, `cost-attribution.ts`,
`context-economy.ts`, `canonical-adapter.ts`, `recovery-lease.ts`,
`sibling-scan.ts` unchanged (rename `OpenCode`-prefixed identifiers only if
a follow-up wants that; not required for correctness). Re-export from
`@arbor/opencode` for one transitional period so `@arbor/mcp`'s 22 import
sites don't need to change in the same commit as the file move, or cut over
all import sites in the same tranche — either is compatible with this
sequence, the choice is an implementation-time call. **Cannot do in this
tranche:** touch category B, touch the four legacy call sites, or make any
claim about step 4.

**Tranche 2 — separate the taxonomy data from its OpenCode config-shape
builders.** Extract the *data* (11 agent names, 5 category names, tier
assignments, model defaults) from `agents.ts`/`categories.ts` into a
category-A-style generic module, leaving only the OpenCode-JSON-shape
builders (`buildAgentConfig`, `permissionsFor`, the opencode-schema
`OpencodeAgentConfig`/`PermissionConfig` types) as genuinely OpenCode-bound.
`deriveDispatchForeground`/`deriveCandidateNodeCard`/`CAPABILITY_TIER`
move with the data, since they consume it generically (verified above —
their bodies use `ArborAgentName`/routing, not OpenCode types). **Cannot do
in this tranche:** this is the highest-judgment step in the whole
migration — it is a real design decision about where the canonical
taxonomy lives, not a mechanical move, and should get its own review before
implementation, independent of this document.

**Tranche 3 — package `opencode-executor.ts` /
`opencode-server-executor.ts` / `opencode-decomposer.ts` /
`integrations/opencode-campaign.ts` out of `@arbor/mcp`** into an
installable OpenCode integration package that depends on tranche 2's
taxonomy package and the tranche-1 loop-contracts package for its port
types (`LoopExecutor`, `ReviewerRunner`, etc.). This is ADR-061's literal
step 2 (doc's step 2), now correctly scoped to where the code actually is.
**Cannot do in this tranche:** convert the four legacy call sites (that's
step 3/tranche 4) or remove `@arbor/opencode` from `@arbor/mcp` (step 4).

**Tranche 4 — convert `demo.ts`, `selfhost.ts`,
`recovery-lease-adapter.ts`, and the `OpenCodeProviderCapabilityAdapter`
call site in `cli.ts` to receive their OpenCode integration through
`HarnessIntegrationRegistry`** the same way `createProductionCampaignRunner`
already does, instead of constructing it directly. This is the doc's step
3, and is unblocked by tranches 1-3 producing installable, injectable
implementations. **Cannot do in this tranche:** remove the dependency edge
itself — these sites will still *use* the OpenCode integration package by
default; they just stop hard-constructing it.

**Tranche 5 (step 4, explicitly out of scope for this document and for the
task that produced it) — remove `@arbor/opencode`/the new OpenCode
integration package from `@arbor/mcp`'s required dependencies, prove the
native CLI/TUI/test lane with it absent.** Only attemptable once tranches
1-4 land and every remaining `@arbor/mcp` import is either from the
tranche-1/2 generic packages (kept) or from the tranche-3 OpenCode
integration package behind an optional/injected boundary (removable).

## What this document does not decide

- The name and exact module boundary of the new packages in tranches 1-3.
- Whether tranche 1 re-exports from `@arbor/opencode` transitionally or cuts
  over all 22+12 import sites atomically — both are compatible with this
  sequence.
- Where the taxonomy (tranche 2) canonically belongs — this is flagged as
  the highest-judgment step and deliberately left to a follow-up review.
- Whether `OpenCodeRecoveryLeaseAdapter`'s name should change now that it's
  confirmed structural (not SDK-coupled) — cosmetic, not blocking.
- Anything about step 4 itself beyond naming it as the terminal, currently
  unreachable tranche.

## Why no tranche was executed in this pass

Tranche 1 is the smallest genuinely mechanical candidate (verbatim file
moves, no logic change), but it still requires: creating a new package with
its own `package.json`, updating `arbor-opencode/tsconfig.json` and
`arbor-mcp/tsconfig.json` project references, and re-pointing or
re-exporting across the 22 `@arbor/mcp/src` files and 12 test modules that
import `@arbor/opencode`. This task's guardrails prohibit `bun run build`
and `bun run typecheck` (shared `tsc --build` state races with a sibling
agent), leaving only scoped `vitest` as verification. Vitest alone confirms
runtime symbol resolution for the tests that happen to exercise moved code;
it does not confirm the TypeScript project-reference graph is coherent, nor
catch a type error in a file no scoped test touches. A ~5,300-line,
13-file, cross-package move verified only by partial test coverage is not
"genuinely safe and self-contained" under these constraints — a
project-reference or `tsconfig` mistake would only surface the next time
someone runs the full build, on a branch this task does not own. This
document is therefore assessment and sequencing only; tranche 1 is ready to
execute in a follow-up pass that has `tsc --build` available for
verification.
