# Historical reachability allowlist — deletion manifest

> **Archive status (2026-08-09):** This is a historical deletion-analysis
> artifact. Do **not** execute deletions, renew waivers, or treat its counts as
> current from this file. The current authority is
> `scripts/reachability/allowlist.json` as enforced by `bun run
> gate:reachability`; the gate's generated report and the exact candidate
> revision determine present disposition.

Generated wave 2 (`wave2/eval-coverage` lane), 2026-08-04, from the 25
`RECOMMEND-DELETION-2026-08-04`-tagged entries in `allowlist.json` (14-day
expiry, 2026-08-18). This lane owns `packages/arbor-eval/**`, `scripts/**`,
`.github/**`, and `vitest.config.ts` — it cannot delete code under any other
`packages/**`, so this manifest exists to let a later lane execute the
deletions in one pass without re-deriving the reachability analysis.

**Method:** for every entry, independently re-verified (not just copied from
the allowlist's own claim) with `grep -rn '\b<symbol>\b' packages/*/src
packages/*/tests`, confirming every occurrence outside the declaring file is
either (a) a test file, or (b) the package's own `index.ts` barrel
re-export (a re-export is not a caller — the reachability gate does not
count it as one either). One near-miss is called out below.

## Group 1 — the dead `planning`/`planning-markdown` pipeline (13 exports)

Self-contained: `planning.ts` and `planning-markdown.ts` call each other and
share no live caller outside `packages/arbor-opencode/tests/planning.test.ts`.
No composition root (`packages/arbor-mcp/src/runtime.ts`,
`packages/arbor-mcp/src/demo.ts`, `packages/arbor-mcp/src/tools.ts`)
constructs or invokes either module.

| File:line | Symbol | Evidence |
|---|---|---|
| `packages/arbor-opencode/src/planning-markdown.ts:15` | `renderPlanMarkdown` | No caller outside `planning.ts:242` (itself dead, see Group 1 below) and `planning.test.ts`. |
| `packages/arbor-opencode/src/planning-markdown.ts:63` | `parsePlanMarkdown` | No caller outside `planning.test.ts`. |
| `packages/arbor-opencode/src/planning-markdown.ts:112` | `planToActions` | No caller outside `planning.test.ts`. |
| `packages/arbor-opencode/src/planning-markdown.ts:117` | `stepToAction` | No caller outside `planning.test.ts`. **Near-miss, checked and cleared:** `packages/arbor-mcp/src/demo.ts:77` defines its own unrelated, unexported, differently-typed `function stepToAction(step: DemoStep): Action` — a naming coincidence, not an import of this symbol. Confirmed no `import { stepToAction }` from `@arbor/opencode` anywhere in `arbor-mcp`. |
| `packages/arbor-opencode/src/planning-markdown.ts:129` | `planRootAction` | No caller outside `planning.test.ts`. |
| `packages/arbor-opencode/src/planning.ts:68` | `classifyIntent` | No caller outside `planning.test.ts`. |
| `packages/arbor-opencode/src/planning.ts:106` | `forcingQuestions` | No caller outside `planning.test.ts`. |
| `packages/arbor-opencode/src/planning.ts:116` | `slugify` | No caller outside `planning.test.ts`. |
| `packages/arbor-opencode/src/planning.ts:130` | `buildDraft` | No caller outside `planning.test.ts`. |
| `packages/arbor-opencode/src/planning.ts:205` | `applyXylemFindings` | No caller outside `planning.test.ts`. |
| `packages/arbor-opencode/src/planning.ts:242` | `synthesizeReview` | No caller outside `planning.test.ts`; calls the also-dead `renderPlanMarkdown`. |
| `packages/arbor-opencode/src/planning.ts:279` | `defaultPlanWriter` | No caller outside `planning.test.ts`. |
| `packages/arbor-opencode/src/planning.ts:293` | `createPlan` | No caller outside `planning.test.ts`; the pipeline's own top-level entry point — nothing calls it. |

**Suggested execution:** delete both files, their re-exports from
`packages/arbor-opencode/src/index.ts`, and `planning.test.ts`; remove the 13
allowlist entries from `scripts/reachability/allowlist.json`.

## Group 2 — arbor-core scattered primitives (9 exports)

| File:line | Symbol | Evidence |
|---|---|---|
| `packages/arbor-core/src/boulder.ts:78` | `readBoulder` | No caller outside `persist.test.ts`; re-exported from `index.ts` only. |
| `packages/arbor-core/src/discipline.ts:65` | `checkTodoDiscipline` | No caller outside `plan-gate-discipline.test.ts`; re-exported from `index.ts` only. |
| `packages/arbor-core/src/event-stream.ts:161` | `RuntimeEventProjection` | No caller outside `event-stream.test.ts`; re-exported from `index.ts` only. |
| `packages/arbor-core/src/messaging.ts:70` | `AgentRadio` (class) | No caller outside `messaging.test.ts`; re-exported from `index.ts` only. |
| `packages/arbor-core/src/messaging.ts:241` | `findLastMention` | Same file as `AgentRadio`; no caller outside `messaging.test.ts`. |
| `packages/arbor-core/src/messaging.ts:256` | `filterBySignal` | Same file as `AgentRadio`; no caller outside `messaging.test.ts`. |
| `packages/arbor-core/src/owned-artifacts.ts:16` | `REVOY_PHASE_BEGIN` | No caller outside `owned-artifacts.test.ts`; re-exported from `index.ts` only. |
| `packages/arbor-core/src/owned-artifacts.ts:17` | `REVOY_PHASE_END` | Same file; no caller outside `owned-artifacts.test.ts`. |
| `packages/arbor-core/src/owned-artifacts.ts:63` | `ownedArtifactReason` | Same file; no caller outside `owned-artifacts.test.ts`. |

**Note:** `AgentRadio`/`findLastMention`/`filterBySignal` and the three
`owned-artifacts.ts` exports are each a *complete, self-consistent
subsystem* (async messaging primitives; owned-artifact phase markers) with
real unit tests, not half-written stubs — they read as designed-ahead-of-use
capability, not dead weight from a removed feature. Confirm with the
`arbor-core` owner before deleting; a gap-register row (G-NN) documenting
"designed but never wired" may be the more honest outcome than deletion for
this group specifically, versus Group 1 and 3 which are genuinely orphaned
pipeline remnants.

## Group 3 — arbor-gate + arbor-opencode/types.ts (3 exports)

| File:line | Symbol | Evidence |
|---|---|---|
| `packages/arbor-gate/src/gate.ts:141` | `passedGate` | No caller outside `gate.test.ts`/`gate-order.invariant.test.ts`; re-exported from `index.ts` only. |
| ~~`packages/arbor-opencode/src/types.ts:11`~~ | ~~`ARBOR_AGENT_NAMES`~~ | **EXECUTED 2026-08-06.** Replaced by a plain `ArborAgentName` union; `CAPABILITY_TIER`'s keys are the runtime enumeration. |
| ~~`packages/arbor-opencode/src/types.ts:20`~~ | ~~`ARBOR_CATEGORY_NAMES`~~ | **EXECUTED 2026-08-06.** Replaced by a plain `ArborCategoryName` union; `ARBOR_CATEGORIES`'s keys are the runtime enumeration. |

**Executed beyond this manifest (2026-08-06),** on the operator's wire-or-delete
decision for the entries whose waivers were about to expire a second time:
`saveKB`/`loadKB` and their internal `mergePersistedEntries` helper
(`arbor-kb/src/persist.ts`), `panelToCriticVerdict`
(`arbor-opencode/src/critics.ts`), and `composeCanonicalLoopConfig`
(`arbor-opencode/src/canonical-adapter.ts`). Six allowlist entries retired by
deletion rather than renewal; 59 → 53.

## Not re-verified this pass

The allowlist also carries 22 `DEFERRED-WAVE1-TUI-CONTRACTS` and 13
`DEFERRED-WAVE1-LOOP-AS-JOB` entries (10-day expiry, 2026-08-14) explicitly
deferred pending wave1/lane A and B's in-flight work — those lanes may wire
these symbols in directly, so this manifest does not recommend deletion for
them. Re-run `bun run gate:reachability` after integration; anything still
flagged unused at that point is a candidate for the same treatment as above.

## Verification command

```
grep -rn '\b<symbol>\b' packages/*/src packages/*/tests
```
Every row above was produced this way against the wave-2 worktree
(`wave2/eval-coverage`, forked from `master` @ `255d529`) on 2026-08-04.
Re-verify before executing — sibling lanes may have changed these files.
