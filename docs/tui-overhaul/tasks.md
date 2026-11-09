# TUI overhaul — task register

Brief: `.revoy/briefs/governance-harness-tui-orchestrator-prompt.md` (gitignored operator brief).
Audited base: `ebf63cc18fab3fc4e24d5996e76630a92f71437b` on `master`. Integration branch: `feat/tui-overhaul`.

### Integrated-head source audit (2026-09-22)

Audit base: `3c828333a19901bf1b8aac37009b3d2fa0d6b80e`. At this exact
revision, `bun scripts/reachability.mjs --json` found 17 exported symbols with
no path from the declared production roots. This is a static source-graph
result, not by itself proof of absent user-visible behavior. Source review and
non-test caller search confirmed the findings are:

- `theme.ts`: `semanticGlyph`, `focusBorderGlyphs`, `SEMANTIC_GLYPHS` (tests
  only; theme palettes and semantic color use have separate live callers).
- `uct-model.ts`: `emptyUctGraph`, `applyUctEvents`, `fitUctGraph`,
  `initialUctReader`, `updateUctReader` (tests and package barrel only; the
  live Console's UCT header uses `uct-header.ts`).
- `interaction-polish.ts`: `measureInteractionStress`,
  `M7_INTERACTION_MATRIX` (test utility and documentation data; other M7
  status and reading-anchor helpers have live callers). Resolved 2026-09-23:
  deleted, since neither had a product role (see the M7 source-audit note
  below).
- `inspect.ts`: `redactInspectValue`, `createInspectService`,
  `DurableInspectRecordStore`, `MemoryInspectRecordStore`, `InspectService`
  (tests and package barrel only; the live Inspect rail uses another query and
  read-model path).
- `git-workspace-projection.ts`: `GitProjectionWatcher` (tests only). The
  production runtime-catalog call sites do not provide its optional
  `git_workspace` service, so the catalog handlers return unavailable.
- `record/store.ts`: `GOVERNANCE_INDEX_FILE` (barrel export only); the
  `GovernanceRecordStore` itself does have a non-test caller in
  `executeGovernanceRecordQuery`.

In the first full-suite run at the audit base, `bun run test:all` reported 4 failed tests, 8,839 passed,
and 1 skipped; `bun run test:opentui` passed 66/66. The four failures were the
empty claim-ledger fixture, stale evidence-store freshness, unmeasured
determinism seams, and the reachability communication proof. These results
describe the audited base and must be refreshed before later completion
claims.

Operator decisions (2026-09-18):
- scope for this run is **M0–M2, then checkpoint**;
- governance records **extend `decisions/` + `packages/arbor-governance`**, with no parallel `.harness/governance/` tree;
- implementation lanes used Luna and independent verification used Terra for this checkpoint.

A task is `done` only when its acceptance evidence exists on the integrated revision (`feat/tui-overhaul`). Evidence and commit columns are filled at integration.

Lanes:
- **L** lead (orchestration, ADRs, integration);
- **RP** runtime/provenance (`feat/tui-m1`);
- **TI** TUI/interaction (`feat/tui-m2`);
- **LV** live-view (M3+);
- **V** independent verifier, a separate Sonnet agent.

## M0 — Baseline and decisions

| id | owner | deps | status | deliverable | acceptance | evidence |
|---|---|---|---|---|---|---|
| M0.1 | L (Sonnet lane) | — | done | `architecture.md` | every claim cited `path:line` or tagged unverified | architecture.md (lead spot-checked hook counts vs `hooks/contracts.ts:42-64`) |
| M0.2 | L (Sonnet lane) | — | done | `gate-matrix.md` | every gate/hook mechanism counted from source; "17" traced and resolved or marked unresolved; nothing invented; UCT semantics + gaps | gate-matrix.md §1–§5: four plus three checkers for ADR-006, 13 hook events, 59 dev gates (41/8/10); "17" = ADR-074 historical snapshot |
| M0.3 | L (Sonnet lane) | — | done | `baseline.md` defects + `artifacts/tui-overhaul/baseline/reproduce.sh` | defects reproducible at 160×48 … 50×14 from the real binary | baseline.md D-01…D-06; `artifacts/tui-overhaul/baseline/frames/` |
| M0.4 | L (Sonnet lane) | — | done | `baseline.md` measurements | method, environment and sample count recorded; microbenchmarks not labelled as input-to-screen | baseline.md: render p95 0.042 ms (CPU only), idle CPU 1.6 %, RSS ~140 MB; keypress→flush **unverified** |
| M0.5 | L | M0.1–M0.4 | done | `ui-spec.md`, this register, ADR-161/162 | operator interview recorded 2026-09-19; both ADRs accepted through `adr:accept` | ADR-161/162 acceptance commits; `decisions/interviews.jsonl`; queue green |

## M1 — Governed contracts and trustworthy read models

| id | owner | deps | status | deliverable | acceptance |
|---|---|---|---|---|---|
| M1.1 | RP | M0.1 | done | read-side event port on `RuntimePort` (subscribe/resume) over the existing `RuntimeEventStream`, implemented in `RuntimePortAdapter` | resume goes through the capability-checked `event.resume` query; closing a subscription cancels nothing | `tui-adapter.test.ts`; ADR-161 O2 |
| M1.2 | RP | M0.2 | done | entry-point test: `arbor-tui` never imports `@arbor/mcp`, spawns processes or writes files; entry-point matrix in `gate-matrix.md` | test green; documented exceptions only | `wiring-audit.test.ts`; ADR-161 O3 |
| M1.3 | RP | M1.1 | done | `arbor-tui/src/read-model.ts` pure projection, wired into `tui.ts` | duplicates ignored, gap → resync, foreign stream rejected, terminal attempts not resurrected | `read-model.test.ts`; ADR-161 O1 |
| M1.4 | RP | M1.3 | done | real `RuntimeEventStream`-driven adapter tests (disconnect, backpressure) | disconnect doesn't cancel; backpressure closes loudly | `tui-adapter.test.ts` |
| M1.5 | RP | M1.3 | done | replay determinism + permutation property tests; capability-denied TUI command through the real router | identical replay → identical state; any divergence flagged as resync | `read-model.test.ts`, `tui-adapter.test.ts` |

## M2 — Responsive shell and first real slice

| id | owner | deps | status | deliverable | acceptance |
|---|---|---|---|---|---|
| M2.1 | TI | M0.5 | done | `layout.ts` + refactored `renderCockpitScene`: framed top band, three-tab rail, anchored composer | ui-spec §2 invariants hold for every viewport | `layout.test.ts` (459 cases), shell snapshots, M2 captures |
| M2.2 | TI | M2.1 | done | focus model, F6/Shift+F6, h/j/k/l, `/`, Esc, Shift+F10 menu via the one action registry | focus-transition tests through the real reducer | `focus-model.test.ts`, `tui-focus-routing.test.ts` |
| M2.3 | L | M1.3, M2.1 | done | one real governed action from composer → `dispatchCommand` → stream events → completion, visible in Inspect | action progresses while typing, resizing, switching tabs and opening a reader; draft intact | `tui-inspect-live-action.test.ts` submits through the focused composer, observes live Inspect state, resizes during execution, and verifies draft preservation |
| M2.4 | TI | M2.1 | done | semantic tokens, ASCII glyphs, grapheme cursor | monochrome/ASCII snapshots still distinguish focus, selection and severity | `screens-tree.test.ts` verifies ASCII selection and success/failure glyphs; `renderer-shell.test.ts` verifies focused ASCII pane chrome together with selected failure and verified rows; `theme-semantic-glyphs.test.ts`, `text-buffer-grapheme.test.ts` |
| M2.5 | TI + V | M2.1–M2.4 | done | layout property tests, cell snapshots at 5 viewports + undersized recovery, paste/draft tests, real-binary captures | green on the integrated revision; independent verifier re-runs | `bun run build`; `bun run tests:typecheck`; 503 targeted tests; real PTY captures at 160×48, 120×36, 100×30, 80×24, 60×18, 50×14 plus 120→60→120 recovery in `artifacts/tui-overhaul/m2/` |

## M3 — governance records and live document navigation

M3 is complete on the integrated revision.
The canonical source remains `decisions/`: ADR markdown is parsed by the
existing `@arbor/governance` record schema, while `GovernanceRecordStore`
provides the durable read/index boundary. No parallel `.harness/governance/`
tree is introduced.

| id | status | implementation/evidence |
|---|---|---|
| M3.1 | done | `packages/arbor-governance/src/record/store.ts` fixes the source directory contract and keeps malformed ADR files visible as invalid index entries. |
| M3.2 | done | `GovernanceRecordStore.create`, `parseRecord`, content hashes, revision history, collision-free numeric allocation, and atomic rename publication. |
| M3.3 | done | `fullRebuild`, fingerprint-based `ensureIndex`, stable generated index at `decisions/.governance-index.json`, and restart/rebuild equivalence tests. |
| M3.4 | done | bounded search, canonical record readers, ADR cross-link projection, interview state indexing, and runtime query contract. |
| M3.5 | done | malformed input, held/stale lock, collision, restart, cross-process contention, and atomic publication tests. |

Checkpoint verification: `bun run build`, `bun run tests:typecheck`, and the
focused governance parser/store suite. Remediation adds defensive malformed
query handling, bounded `limit`/`offset` paging, `interviews.jsonl` restart
state with distinct unresolved/answered rows, historical ID reservations, and
cross-process `O_EXCL` lock/stale-lock coverage. The lock contract is
explicitly single-writer: a competing process receives a busy result while a
complete prior index remains readable; publication itself is rename-atomic.
Terra exercised the runtime query route and real cross-process writer
contention; all M3 checks passed.

## M4 — live Git/worktree state and governed management

M4's projection, watcher, and governed-operation components are implemented
and tested, but source audit at the integrated revision found no production
construction of `GitWorkspaceService` or `GitProjectionWatcher`. The runtime
catalog has handlers for these operations, but its production router call
sites do not inject `git_workspace`, so those handlers report unavailable.
Treat M4 as an implemented/tested component slice pending production
composition and live-path evidence, not as a complete live vertical slice.

| id | status | implementation/evidence |
|---|---|---|
| M4.1 | partial | `packages/arbor-mcp/src/git-workspace-projection.ts` implements canonical repository/common/worktree paths and bounded structured Git reads without a shell; no production `GitAdapter`/`GitWorkspaceService` composition was found. |
| M4.2 | partial | `GitProjectionWatcher` caps watchers at two paths and coalesces notifications; it is only constructed in tests, with no live refresh subscription. |
| M4.3 | partial | `GitWorkspaceProjection` has the documented fields, but the projection is not produced by an audited production caller because `git_workspace` is not injected into production routers. |
| M4.4 | partial | Catalog handlers and `GovernedWorktreeOperations` implement the governed contract, but audited production router compositions omit `git_workspace`; end-user reads/mutations therefore return unavailable. |
| M4.5 | done | Real temporary-repository tests cover linked worktrees, detached HEAD, staged and untracked changes, conflict state, renamed and Unicode paths, watcher coalescing, stable identity, and governed cleanup refusal. |

Checkpoint evidence: `packages/arbor-mcp/tests/git-workspace-projection.test.ts`
(5 tests passed), `bun run tests:typecheck`, and `bun run build`.

## M5 — UCT fit, level-of-detail, and 20k-node rendering

M5's live UCT header is wired through `projectUctHeader` in the Console screen.
The separate `uct-model.ts` lifecycle/layout/reader helpers are implemented
and covered by 20,000-node tests, but the five exported helpers have no
production callers at the integrated revision. The tested semantic model and
reader controls are not composed into the live screen; keep those parts
partial until a real event-to-reader path is implemented and verified.

| id | status | implementation/evidence |
|---|---|---|
| M5.1 | partial | `uct-model.ts` implements the semantic lifecycle adapter and tests cover the listed transitions; no production caller feeds it live snapshots/events. |
| M5.2 | done | `projectUctHeader` retains exact edge metrics while selecting direct, braille, or elided output from viewport fit and density. |
| M5.3 | partial | Iterative rank assignment, append-only grouping, fit hysteresis, and bounded layout are implemented/tested in the uncomposed UCT model; production-path use is unverified. |
| M5.4 | partial | Pure reader state provides stable-id selection/filtering, explicit follow toggle, fit-compatible state, and modal expansion controls; no production caller wires these controls to the live reader. |
| M5.5 | done | `uct-model.test.ts` and `uct-header.test.ts` cover topology fixtures, delayed/duplicate/gap events, pruning/rerooting, 20k nodes, LOD counts, and rectangle bounds. |

Checkpoint evidence: focused UCT suite (16 tests, including reconnect
snapshot recovery), `bun run tests:typecheck`, and `bun run build`.

## M6 — noninterrupting action inspection and side questions

M6's `inspect.action` query and Inspect rail are live through a separate
runtime/read-model path. The side-question service described here
(`packages/arbor-tui/src/inspect.ts`) is implemented and tested but has no
production caller at the integrated revision. Snapshot-scoped side queries,
durable history, isolated scheduling, answers, and promotion therefore remain
component behavior without a live TUI route.

| id | status | implementation/evidence |
|---|---|---|
| M6.1 | done | `inspect.action` and the Inspect reader expose lifecycle, dependencies, gates, records, and evidence projections. |
| M6.2 | partial | Snapshot-scoped side queries keep separate drafts/history and durable append-only records with restart hydration in the service implementation; no production caller exposes them. |
| M6.3 | partial | Read-only enforcement, redaction, bounded scheduling, model degradation, and cancellation isolation are implemented/tested in `InspectService`; they are not wired through the runtime catalog/TUI adapter. |
| M6.4 | partial | Deterministic/model answers carry freshness and evidence IDs and unsupported conclusions are labeled unknown in service tests; production behavior is unverified. |
| M6.5 | partial | The service's promotion path is explicit, audited, restart-idempotent, and calls `taskcomposer.submit`; no production caller makes that path available to the operator. |

Checkpoint evidence: 49 focused Inspect/runtime tests, `bun run build`, and
`bun run tests:typecheck` with 0 errors across 14 packages. Terra exercised <!-- sur-05:historical — the package count at this dated checkpoint -->
the live TUI path, runtime catalog parity, restart hydration, cancellation
isolation, and promotion behavior.

## M7 — terse presentation and complete interaction polish

M7 is complete as a bounded interaction-policy and evidence slice on the
integrated revision. The renderer-independent policies preserve the existing
single action authority and read-model truth; they do not create a second
execution path.

| id | status | implementation/evidence |
|---|---|---|
| M7.1 | done | `backgroundStatusesFromModel`/`backgroundStatusLine` fold the live Console projection by stable identity and render urgent rows in the actual status bar; deterministic 3–8 line turn-boundary summaries remain the shared fallback policy. |
| M7.2 | done | The live renderer's contextual help/menu overlay invokes catalogue-backed `contextMenuItems`; every selected item exposes its keyboard route and authorization reason. `packages/arbor-mcp/src/tui.ts` now captures and reapplies `preserveReadingAnchor` while opening the real Console ADR/document reader, and invokes `restoreReaderFocus` on close/back to preserve identity/offset, focus, and selection. |
| M7.3 | done | Live status and contextual-menu rendering use semantic token carriers with the existing dark/light/contrast-safe theme and narrow-layout contracts; focus and selection remain distinct in monochrome. |
| M7.4 | done | The interaction matrix records keyboard-only, mouse-assisted, background-refresh, and narrow-layout journeys with shared invariants. |
| M7.5 | done | Status folding is bounded and deterministic, with no animation or timer-driven masking; focused tests cover compactness, urgent-state disclosure, and the 20,000-event key-repeat/scroll stress fixture. |

Deliverables: `m7-interaction-matrix.md`, `m7-theme-tokens.md`,
`m7-summary-policy.md`, the exported policy contract, and
`packages/arbor-tui/tests/interaction-polish.test.ts`. The existing M2 cell
snapshots/OpenTUI narrow-layout captures remain the renderer-level before/after
comparison; M7 adds the policy evidence that drives those surfaces.

Checkpoint evidence: 7 focused interaction-policy tests plus 23 live
interaction/reader tests (including stdin reader open/close and focus
restoration), `bun run build`, and the required `bun run tests:typecheck` at
the Terra checkpoint.

Source audit note: `preserveReadingAnchor` and `restoreReaderFocus` are called
from `packages/arbor-mcp/src/tui.ts`; background status and turn-boundary
projection are consumed by the live status bar. `measureInteractionStress`
(a test fixture utility) and `M7_INTERACTION_MATRIX` (documentation data)
never had production callers and never established live stress
instrumentation. Resolved 2026-09-23: both were deleted rather than given an
invented call site; the stress probe simulated a queue the live renderer does
not use, so its test proved nothing about the product.

## M8 — release hardening (deferred)

M8 remains deferred to the next go-ahead. Known inputs gathered in M0:

- **M3:** records live in `decisions/` (ADR markdown, `interviews.jsonl`, `registry.json`, `discharge-obligations.jsonl`), and their code-owned schema is `packages/arbor-governance/src/record/*`. The tooling is revoy2-self-hosted today (`docs/designs/extract-governance-layer.md`). Atomic writes in `scripts/adr-registry.mjs` are unconfirmed.

## Blockers and open questions

- **B-1** The brief's "17 gates" matches no current set in the repo (see `gate-matrix.md`). Recorded as an unresolved brief claim, not invented.
- **B-3** `HookBus.lifecycleSessionStart` is tested but not wired into live session admission (`hooks/bus.ts:236-241`, self-documented). This is a governance safeguard that exists but is not wired. It is out of TUI scope and flagged for the operator.
- **B-4** `theme.test.ts` has 1 pre-existing failure at the audited base (baseline.md).
- **B-2** Closed 2026-09-19: operator interview held; ADR-161 and ADR-162 accepted through the governed status-only path.
