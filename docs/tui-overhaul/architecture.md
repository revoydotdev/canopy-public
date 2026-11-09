# TUI Overhaul: Current Architecture Map (M0.1)

Scope: source-confirmed map of the runtime, TUI, action dispatch, persistence,
Git/worktree, and agent-lifecycle machinery as it exists on branch
`feat/tui-overhaul` (base `ebf63cc1`). Every claim below carries a
`path:line` citation and a tag: **source-confirmed** (read directly),
**measured** (a command was run against the repo and its output is quoted),
**hypothesis** (plausible but not directly read), or **unverified** (could
not be confirmed in the time available).

## 1. TUI launch chain

- Dev entrypoint `packages/arbor-mcp/bin/arbor-mcp.mjs:11` imports
  `main`/`ShutdownGate` from `../src/cli.ts` and calls `main(argv, undefined,
  shutdown)`. **source-confirmed**
- `cli.ts` routes the `tui` subcommand: `if (args[0] === "tui") { const {
  tuimain } = await import("./tui.js"); return tuimain(args.slice(1)); }`
  (`packages/arbor-mcp/src/cli.ts:3450-3452`). **source-confirmed**
- `packages/arbor-mcp/src/tui.ts`:
  - `export async function tuimain(argv: string[])` at line **4123**.
  - `export async function runTui(options: TuiLaunchOptions)` at line
    **4109**.
  - `async function runTuiUnsafe(options, registerStartupCleanup)` at line
    **709**.
  All three symbols and line numbers match the brief's starting points.
  **source-confirmed** (`packages/arbor-mcp/src/tui.ts:709,4109,4123`)
- `RuntimePortAdapter` — `export class RuntimePortAdapter implements TuiPort`
  at `packages/arbor-mcp/src/tui-adapter.ts:126`. **source-confirmed**
- `TuiShell` — `export class TuiShell` at
  `packages/arbor-tui/src/shell.ts:128` (constructor `:146`).
  **source-confirmed**
- Elm-style core: `packages/arbor-tui/src/model.ts` (49 lines,
  `initialModel` at `:10`) and `packages/arbor-tui/src/update.ts` (1580
  lines). `model.ts:24-27` documents that ADR-107 made the interactive
  `"console"` screen the boot default, with dashboard/cockpit projections
  now palette-reachable rather than default. **source-confirmed**
- `renderer.ts`: `renderScene` at `:149`, `renderCockpitScene` at `:288`
  (brief said ~291, off by 3), `heroHeight` hardcoded at `:308`
  (`Math.min(4, Math.max(0, rows - 4))`) — confirmed **hardcoded** (not
  configurable/measured from content). **source-confirmed**
  (`packages/arbor-tui/src/renderer.ts:149,288,308`)
- `opentui-renderer.ts` (717 lines) exists alongside `renderer.ts`; role
  (native OpenTUI backend vs. the plain-text `renderer.ts`) inferred from
  filename and gate `gate:opentui` in the tier list (§ gate-matrix.md) —
  **hypothesis**, not read in depth this pass.
- `frame.ts`: header comment explicitly ties `SceneFrame` to **ADR-037**
  (`packages/arbor-tui/src/frame.ts:2`); `SceneFrame` interface at `:93`;
  `hitTestFrame` at `:128`. **source-confirmed**

## 2. Command/query boundary

- `RuntimePort` (the screen-facing seam) is a closed interface at
  `packages/arbor-tui/src/runtime-port.ts:220`, with exactly two verbs —
  `command<K>()` and `query<K>()` — plus `activeOperationCount()`. Bounds are
  frozen in `RUNTIME_PORT_LIMITS` (`:238-246`): e.g. `max_command_params: 64`,
  `max_query_result_records: 1_000`, `active_operation_cap: 10_000`.
  **source-confirmed**
- This mirrors `RuntimeCatalogRouter` in
  `packages/arbor-mcp/src/runtime-catalog.ts`:
  - `export class RuntimeCatalogRouter` at line **541** (brief said ~541 —
    exact).
  - Public `dispatchCommand()` at line **556**, which delegates to a
    private `dispatchCommandObserved()` at line **574** — the doc comment at
    `:554` states "the real dispatch logic is unchanged, in
    `dispatchCommandObserved`". **source-confirmed**
  - `denialReason()` at line **2938** (brief said ~2934, off by 4).
    **source-confirmed**
  - `catalogActionClass()` at line **2992** (exact match).
    **source-confirmed**
- Enforcement: `enforceAction()` in `packages/arbor-core/src/capability.ts:129`
  raises `CapabilityError` when a `"preview-confirm"` (mutating) action class
  exceeds the caller's tier; `forbidden` always raises regardless of tier
  (`:129-139`). `isMutating()` (`:101-103`) treats `"preview-confirm"` as the
  only mutating class. **source-confirmed**
- Delegate spawn: `packages/arbor-mcp/src/sibling-spawner.ts` (16 lines) —
  `SiblingSpawner.spawn()` performs `manager.branch()`, acquires a worktree
  lease, registers a `TaskSupervisor` task, and on failure runs a documented
  compensation path (`recordSiblingSpawnCompensation`, lease release, prune,
  unregister). It is invoked from inside `RuntimeCatalogRouter` at
  `runtime-catalog.ts:2281` (`this.runtime.siblingSpawner.spawn(...)`), i.e.
  delegate spawn is a governed catalog case, not a side channel.
  **source-confirmed**
- Jobs: `packages/arbor-mcp/src/job-scheduler.ts` (144 lines). Job command
  kinds are enumerated directly in the catalog's `RuntimeCommandKind` union
  at `runtime-catalog.ts:232` (`"job.submit" | "job.cancel" | "job.retry" |
  "job.pause" | "job.resume" | "job.list"`) with catalog entries at
  `:389-394` and `case` handlers at `:2474,2494,2501,2531,2535` plus a
  `job.list` query handler at `:2548`. **source-confirmed**
- `packages/arbor-mcp/src/native-agent-executor.ts` (1594 lines) imports
  `HookBus` (`:29`) and accepts an optional `hook_bus` option (`:354`); a
  comment at `:318` states it goes through `RuntimeCatalogRouter` "exactly
  like `bus.thread.send`", i.e. side-agent messaging is also catalog-routed,
  not a separate path. **source-confirmed** (comment, not independently
  traced end-to-end — the actual call site inside the executor that invokes
  the router was not read this pass; treat the "exactly like" claim as
  **source-confirmed as an assertion in the code**, but the wiring itself is
  **unverified**).

## 3. Events

- `packages/arbor-core/src/event-stream.ts`: `export class
  RuntimeEventStream` (`:9`) with `publish()` (`:26`), `snapshot()` (`:47`),
  `resume()` (`:52`), and `subscribe()` (`:65`). `resume()` implements
  cursor-consistency: null cursor → fresh snapshot; wrong stream id or a
  cursor ahead of `nextSequence` → resync; a cursor behind the earliest
  retained sequence → resync with reason `"gap"` (`:53-58`).
  **source-confirmed**
- `RuntimeEventEnvelope` is defined at
  `packages/arbor-core/src/runtime-contracts.ts:133`; `validateRuntimeEvent`
  at `:338` validates at least three event families by name:
  `campaign.changed`, `tree.node_changed`, `gate.recorded` (`:347-349`).
  **source-confirmed**
- **Does the TUI subscribe or poll?** Both, layered. `tui.ts:3063` does
  `const haltWatchSubscription = runtime.eventStream.subscribe();` — a real
  subscription to the canonical event stream, whose purpose (per the doc
  comment at `tui.ts:3040-3059`) is to catch `campaign.changed` "halted"
  events for a campaign that may no longer be `getActiveCampaignId()` by the
  time a focus-triggered refresh would run. However, the subscription is
  *drained by a poll*: `const haltWatchTimer = setInterval(pollHaltTransitions,
  500);` (`tui.ts:3104`), and `pollHaltTransitions` calls
  `haltWatchSubscription.poll()` (`tui.ts:3084`) — there is no push callback
  registered on the subscription itself. In addition to this hybrid
  subscribe-then-poll path, the TUI runs several independent `setInterval`
  polls for other projections: a 2s task-composer/product-surface poll
  (`tui.ts:2459`), a 2s execution-status poll (`tui.ts:3125`), a 1s
  output-detail poll (`tui.ts:3147`), and a session-tail poll
  (`tui.ts:3112,3150`). **source-confirmed** — net finding: the event stream
  exists and the TUI *does* subscribe to it for one specific purpose (halt
  detection independent of screen focus), but the dominant refresh mechanism
  across the rest of the TUI is still per-projection polling on fixed
  cadences, not stream-driven reactive updates.
- `packages/arbor-mcp/src/webui.ts:341` also calls
  `this.runtime.eventStream.subscribe({ max_pending: SSE_MAX_PENDING })` and
  `:354-355` calls `resume()` to implement SSE resumption — the web UI's
  event delivery is subscription/resume-based (SSE), unlike the TUI's
  poll-drained subscription. **source-confirmed**
- `packages/arbor-mcp/src/liveness-runner.ts:73` constructs its own
  `RuntimeEventStream("liveness")` instance and reads `.eventStream.streamId`
  at `:179` — a separate, non-shared stream instance for liveness checks, not
  a consumer of the TUI/webui's runtime stream. **source-confirmed**

## 4. Persistence

- `packages/arbor-core/src/persist.ts:485`:
  `function atomicWriteWithFsync(path, temporary, contents)` — write-to-temp
  + fsync + rename pattern; called at `:551` when persisting a campaign,
  with a comment there tying it to crash durability. **source-confirmed**
- The brief's claim of a literal `.arbor/tree` path and ADR-007-tagged audit
  JSONL was **not independently located** in `persist.ts` in this pass (no
  `.arbor/tree` or `ADR-007` string matched directly in the grep run against
  this file) — **unverified**. The `.arbor/leases/` path (a sibling
  concern) *is* confirmed in `worktree.ts` (§6 below).
- `packages/arbor-mcp/src/harness-session-replay-store.ts` exists (the brief
  cited it under `arbor-core`; it actually lives under `arbor-mcp`, with a
  matching test at
  `packages/arbor-mcp/tests/harness-session-replay-store.test.ts` and a
  compiled artifact at `packages/arbor-mcp/dist/harness-session-replay-store.js`).
  **source-confirmed correction**: path is
  `packages/arbor-mcp/src/harness-session-replay-store.ts`, not
  `packages/arbor-core/src/harness-session-replay-store.ts` as the brief
  stated.

## 5. UCT (upper-confidence-tree) semantics

- `packages/arbor-core/src/scoring.ts:1-3` header: "Clean-room from Arbor
  paper §3.2, eq. (1) (arXiv 2606.12563v1)... UCT basis: Kocsis & Szepesvári
  2006." The formula documented at `:19-30`:

  ```
  h(a) = [g(a)/c(a)] · (1 − r_acc) · (1 − r_crash) · m_gap
         + C · √(ln N / (1 + n_cat))
  ```

  where `g`=gain, `c`=cost, `r_acc`/`r_crash`=regression rates, `m_gap`=gain
  relative to best known, `C`=exploration constant, `N`=total visits,
  `n_cat`=visits to this action's category. Exported functions:
  `scoreAction` (`:34`), `scoreActionWithPolicy` (`:78`), `scoreAgentUct`
  (`:89`), `deriveDecayingLambda` (`:108`), `haltCheck` (`:167`).
  **source-confirmed**
- Node states, enumerated by direct assignment in
  `packages/arbor-core/src/tree.ts`: `"pending"` (`:88,251,260,352,367`),
  `"expanding"` (`:114`), `"claimed"` (`:147,149,404`), `"verified"`
  (checked at `:131,145`), `"failed"` (`:173`), `"interrupted"` (`:327`),
  `"abandoned"` (`:382`), `"pruned"` (`:272`). A comment at `:239` labels the
  `failed → pending` transition ADR-062 ("revive a critic-rejected node").
  **source-confirmed**
- `campaign.tree` query: catalog entry at `runtime-catalog.ts:294` (`{ kind:
  "campaign.tree", direction: "query", capability: "tree.read", ... }`);
  handler at `:2806`; the 200-node page cap appears three times —
  `:1736`, `:1755` (`const limit = envelope.query.limit ?? 200;`) and
  `:2429` (`nodes.slice(0, envelope.query.limit ?? 200)`). **source-confirmed
  cap of 200, default and max both driven by the same literal**.
- TUI-side UCT rendering: `packages/arbor-tui/src/uct-header.ts` (767
  lines) and `packages/arbor-tui/src/uct-playback.ts` (46 lines);
  `uctNodes()` in `packages/arbor-tui/src/screens/console.ts:330`, used at
  `:433` to build the payload passed into the header projection.
  **source-confirmed**
- **Instrumentation gaps** (source-confirmed, not merely asserted by the
  brief):
  - No dedicated tree-event stream: `RuntimeEventEnvelope`'s validated
    event kinds are `campaign.changed`, `tree.node_changed`, `gate.recorded`
    (`runtime-contracts.ts:347-349`) — `tree.node_changed` carries only
    `campaign_id`, `node_id`, `state` (a state diff), not a structural tree
    delta (no parent/children, no score fields validated). Consumers must
    still re-fetch `campaign.tree` to reconstruct structure.
  - The 200-node page cap (`runtime-catalog.ts:1736,1755,2429`) means any
    UCT with more than 200 live nodes is truncated in a single
    `campaign.tree` response; nothing in the reviewed code paginates beyond
    the first page from the TUI side — **unverified** whether callers loop
    on an offset/cursor (no offset param was seen in the query shape read
    this pass).
  - Strict tree, no reroot/forest: `tree.ts` operates on a single
    parent-pointer tree per campaign (branch/prune/interrupt all take a
    single `nodeId` inside one tree); no `reroot` or multi-tree/forest
    function name was found in `tree.ts` — **source-confirmed absence** (by
    grep of exported function names) but not exhaustively read line-by-line,
    so treat as **source-confirmed (grep-level), not (full-read)**.

## 6. Git / worktrees

- `packages/arbor-campaign-support/src/worktree.ts` (1919 lines):
  `WorktreeLease` interface at `:65`; lease store documented at `:5` as
  living in `.arbor/leases/`; `claimLeaseSlot`'s per-slot mutex uses
  `<leasesDir>/<node_id>.lock` (`:45-46`); `PendingClaim` type at `:102`
  marks an in-flight claim via a `claim_token` field. **source-confirmed**
- `packages/arbor-mcp/src/repo-flight-git.ts` (170 lines) exports
  `isRepoFlightProvisionedWorkspace` (`:37`),
  `probeRepoFlightQuiescentConfinement` (`:79`),
  `probeRepoFlightGitCandidate` (`:91`),
  `createRepoFlightWorkspaceSnapshot` (`:121`), and
  `runRepoFlightGateCommand` (`:141`). **source-confirmed**
- `packages/arbor-tui/src/responsive-sidebar.ts:630` — a comment: "Human
  wording for a `git status --porcelain=v1` code" — confirms porcelain-v1
  parsing for the sidebar's git status rendering. **source-confirmed**
- **No filesystem watcher**: a repo-wide grep for `fs.watch`, `chokidar`,
  `FSWatcher` under `packages/arbor-campaign-support/src` and
  `packages/arbor-mcp/src` returned zero matches. **measured** (command:
  `grep -rln "fs.watch\|chokidar\|FSWatcher" packages/arbor-campaign-support/src packages/arbor-mcp/src` → empty).
- **No operator-facing worktree commands**: no `worktree.*` kind was
  observed in the `RuntimeCommandKind`/query-kind grep passes run this
  session (only `job.*`, `campaign.*`, `sibling`/spawn-adjacent, `result.*`,
  `taskcomposer.*` kinds were seen). This is **not an exhaustive negative
  proof** — the full `RuntimeCommandKind` union (3211-line file) was not
  read end-to-end — so tag as **unverified (absence claim, partial search
  only)**.

## 7. ASCII flow diagram (current state)

```
 keyboard / palette / menu
        │
        ▼
 input-catalog.ts (UiAction) ──► update.ts (Elm-style reducer, model.ts)
        │                                   │
        │                                   ▼
        │                         RuntimePortAdapter (tui-adapter.ts:126)
        │                         .command() / .query()
        │                                   │
        ▼                                   ▼
 TuiShell (shell.ts:128)          RuntimeCatalogRouter.dispatchCommand()
   16ms change-timer,                (runtime-catalog.ts:541,556)
   animation-timer (cadence)                │
        │                          catalogActionClass ──► enforceAction()
        ▼                          (runtime-catalog.ts:2992) (capability.ts:129)
 renderer.ts renderScene()                  │
   / renderCockpitScene()          ┌────────┼─────────────┬───────────────┐
        │                          ▼        ▼             ▼               ▼
        ▼                    job-scheduler  SiblingSpawner  native-agent-  persist.ts
 frame.ts SceneFrame          .ts (jobs)    .ts (delegate    executor.ts   atomicWriteWithFsync
   (ADR-037)                                 spawn, worktree  (side agents,
                                              lease via         via HookBus)
                                              worktree.ts)
        │
        ▼
 opentui-renderer.ts (terminal paint)

 Independent poll loops (tui.ts): haltWatchTimer 500ms (drains an
 eventStream.subscribe()), task-composer/product-surface 2s,
 execution-status 2s, output-detail 1s, session-tail — all re-query via the
 same RuntimeCatalogRouter, none are pushed to by RuntimeEventStream.publish()
 directly.

 RuntimeEventStream (event-stream.ts:9) is published to by the runtime and
 consumed independently by: TUI (poll-drained subscription, tui.ts:3063,3104),
 WebUI (SSE subscribe+resume, webui.ts:341,354), liveness-runner.ts (its own
 separate stream instance, not shared).
```

## 8. Gaps vs. target: governed-commands → runtime → events → read models → TUI

| Stage | Current state | Gap |
|---|---|---|
| Governed commands | Closed `RuntimeCommandKind`/`RuntimeQueryKind` unions dispatched through one router (`runtime-catalog.ts:541`), capability-enforced (`capability.ts:129`) | Confirmed single choke point for commands; **unverified** whether every UI entry point (see gate-matrix.md action entry-point matrix) actually routes through it end-to-end vs. some screens reading local model state only |
| Runtime | `CampaignManager`/`ArborRuntime` (referenced but not read this pass — **unverified** internals) wraps `TreeNode` state machine (`tree.ts`), gates (`arbor-gate/src/gate.ts`), leases (`worktree.ts`) | Runtime internals beyond the catalog surface were out of scope for this pass |
| Events | `RuntimeEventStream` publishes 3 validated event families; no structural tree-delta event, only `tree.node_changed` state diffs | Structural changes (new child, pruned subtree) are not directly observable on the stream; consumers re-fetch `campaign.tree` (capped at 200) |
| Read models | `campaign.tree` (200-node cap), `job.list`, devtools ring buffer (adapter-local, bypasses the router by design per `tui-adapter.ts:144-183`) | No confirmed pagination beyond the 200-node cap; devtools stream is an intentionally-justified exception to router-mediated reads, not a gap, but it is a second pattern a TUI overhaul must not silently generalize |
| TUI | Hybrid: one poll-drained event subscription (halt detection) + 4-5 independent fixed-cadence polls per projection | Target for the overhaul is presumably push-driven re-render off `RuntimeEventStream.publish()` directly, replacing per-projection `setInterval`s — this is a design gap, not a claim this audit confirms is planned anywhere in-repo (**unverified** whether such a plan exists in ADRs already merged) |

## 9. Corrections to the brief's starting points

- `renderCockpitScene` is at `renderer.ts:288`, not ~291 (off by 3, trivial).
- `denialReason` is at `runtime-catalog.ts:2938`, not ~2934 (off by 4,
  trivial).
- `harness-session-replay-store.ts` lives under `packages/arbor-mcp/src/`,
  not `packages/arbor-core/src/` as stated in the brief.
- The `.arbor/tree` path and an "ADR-007" tag on the audit JSONL were not
  located in `persist.ts` in this pass — flagged **unverified** rather than
  asserted.
