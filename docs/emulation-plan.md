# revoy2 Full TUI Emulation — Durable Plan

**Status:** living plan · **Owner:** Sisyphus · **Updated:** 2026-08-03

## Goal

Make `arbor demo` (and the cockpit it drives) a **faithful emulation of the
actual revoy2 TUI** — the `arbor tui` cockpit over a genuinely autonomous,
ledger-honest campaign. "Faithful" means: real worktree-backed specialists that
edit and verify (producing `!verified` nodes), the full 12-screen cockpit with
operator input, real loop-driven telemetry/token/communications/interrupt
seams, and — where the real deployment is decoupled (opencode plugin drives,
TUI watches) — an emulation that exercises the same canonical runtime
capabilities rather than papering over them.

**Golden rule (the user's mandate):** if a seam is *stubbed in production*, fix
it in **prod first**, then wire the emulation onto the now-real prod code —
never build the demo on top of a production stub.

---

## 0. Prod-stub audit (done 2026-08-03) — fix-in-prod inventory

Audited `packages/{core,mcp,opencode,tui,audit,gate,kb,prompts}/src` for stub
markers and dormant no-op bodies. **No explicit stub/TODO markers exist in
prod.** One genuine stub cluster was found, plus a set of dormant-but-real
capabilities that the cockpit simply does not reach.

### ✅ FIXED IN PROD: the harness telemetry zero-stub
**Location:** `packages/arbor-mcp/src/tui.ts` `runTui` (and duplicated in
`demo.ts`).
**The stub:** `telemetrySource: { fetch: async () => ({ campaign_id: "boot",
source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [] }) }`
— a hardcoded fake response, even though `CampaignManager.projectTelemetry(campaignId)`
returns real ledger-derived telemetry (ADR-017).
**The fix:** new `packages/arbor-mcp/src/cockpit-sources.ts` →
`createCockpitTelemetrySource(runtime)` returns the real `projectTelemetry`
projection (defensive empty on unverifiable ledger). Wired into both `runTui`
and the demo. Test: `packages/arbor-mcp/tests/cockpit-sources.test.ts`.

### ⚠️ DORMANT (not faked, but unreached) — decide + wire
`runTui`'s harness `client` is all no-ops:
`connect/disconnect/requestSnapshot/close/interruptCampaign = () => {}`.

| Method | Assessment | Action |
|---|---|---|
| `connect` / `close` | **Correct for in-process** — there is no remote transport; the runtime lifecycle is owned by `runTui` itself. Not an emulation stub. | Keep; document. |
| `requestSnapshot` | Redundant in-process (the demo/cockpit poll loop already re-reads). | Keep no-op; do NOT emulate a fake resync. |
| `interruptCampaign` | **Genuinely dormant.** The harness `interrupt_active_campaign` intent reaches a no-op, so an operator cannot interrupt a campaign from the TUI. | PROD FIX (next): wire to `runtime.interrupt` of the active campaign's in-flight (`expanding`) node via the catalog `tree.interrupt` path. Requires a tree-state accessor on `CampaignManager` to find the expanding node. |

Everything else the seams touch is **real in prod** (not stubbed): `WorktreeManager`
does real git worktrees; the runtime constructor wires real `ManagerTelemetryAdapter`,
`outputEvidence`, `tokenEpochs`, `selectionCommunications`, `interruptions` loop
ports; the 12 screen modules are real renderers. Those seams are **unflipped in
the emulation**, not stubbed in prod — see Group A.

---

## 1. Group A — Loop-driver seams (the engine)

The demo's `createDemoConfig` sets only: `max_iterations, specialist/critic_base_prompt,
caps, score_ctx, use_worktrees:false, branch_actions:null`. It omits every field below.
Except where noted, each is already-implemented-in-prod and just needs to be passed.

| # | Seam | Prod state | Emulation task |
|---|---|---|---|
| A1 | **Worktrees** | REAL (`WorktreeManager`, git worktree leases, branch-per-node) | Set `use_worktrees:true`; give the demo a `WorktreeManager` pointed at the repo; change the real executor to edit files in the isolated worktree. **Keystone.** |
| A2 | **Real verification → `!verified`** | gates + provenance are real | After a specialist edits the worktree, run the node's verification command (`verificationCmd`); only on exit 0 is provenance `!verified` (so the tree shows ✓ and `verified_count>0`). Gated on A1. |
| A3 | **11-agent set + category/NodeCard routing** | `selectNodeWithCard`, `task_skills`, `requestedTier`, real botanical prompts in `arbor-prompts` | Set `task_skills`; route specialist by `action.delegate_to` to the real botanical agent prompt; use `selectNodeWithCard`. |
| A4 | **Panel-of-critics (3.4)** | `panel` + `run_reviewer` REAL | Wire `panel` + `run_reviewer` (N critics reconcile, Lenticel binds). |
| A5 | **Communications (4D bus)** | ports + records REAL | Pass `communications` (runtime `loopPorts.communications`), `communication_limit`, `communication_budget`, `communication_clock`. |
| A6 | **Output evidence capture (4D.7)** | REAL `OutputEvidenceStore` | Pass `output_evidence` (runtime `loopPorts.output_evidence`) + `output_budget`. |
| A7 | **Token economy (ADR-015)** | REAL `TokenEpochService` + `token_epochs` | Pass `token_economy` (runtime `loopPorts.token_epochs`); real executor should report actual `token_usage` from the opencode response (currently `undefined`). |
| A8 | **Telemetry (ADR-017)** | REAL `ManagerTelemetryAdapter` | Pass `telemetry` (runtime `loopPorts.telemetry`) so phase-duration + provider-cost flow to the ledger + telemetry view. **The zero-stub fix (Section 0) unblocks reading this.** |
| A9 | **Interruptions (ADR-012/016)** | REAL | Pass `interruptions` (runtime `loopPorts.interruptions`); exercise cooperative cancel/overflow recovery. |
| A10 | **Compaction (ADR-018)** | REAL | Set `compaction_every_iterations` so ledger compaction fires from a loop hook. |
| A11 | **User-interview (ADR-019)** | REAL `awaitingUserInput` gate + interviews screen | Optionally emit a `RequestUserInput` mid-demo so the governed interview transition + interviews screen are exercised. |
| A12 | **KB depth** | REAL KB-injection | Improves automatically once A2 (verified) + A1 produce real evidence-driven memory; backtracking becomes meaningful. |

*Loop ports already composed in `ArborRuntime` → `CanonicalLoopPorts`; the demo
just needs to destructure them into `CampaignLoopConfig` (see Section 3 wiring).*

---

## 2. Group B — TUI-view seams (the cockpit the user sees)

The TUI installs **12 screen modules**: `agents, approvals, campaigns,
communications, config, devtools, diagnostics, interviews, jobs, operations,
output, tasks`. The demo renders **only `campaigns`** and has **no operator
input**.

| # | Seam | Emulation task |
|---|---|---|
| B1 | **Multi-screen routing** | Route to / feed projections for all 12 screens (surveillance→diagnostics, telemetry→telemetry, agentRegistry→agents, jobScheduler→jobs, approvals, operations, output, comms, config, interviews, devtools). Populate via the runtime port queries each screen's `surface` declares. |
| B2 | **DevTools screen projection** | Feed `devtools.stream` (already built) so the devtools screen shows the live stream + player-piano animations (spinner/flash already built). |
| B3 | **Operator / keyboard input** | Add an `InputRouter` + raw-mode key loop (as the real `runTui` has) so an operator can navigate screens, `campaign.halt`, `tree.branch/prune`, `tree.interrupt`, approve. Full emulation is operable, not watch-only. |
| B4 | **Telemetry view** | Now read the real telemetry source (Section 0 fix) → populate the telemetry view with real histograms/cost once A8 emits observations. |

---

## 3. Group C — Topology seam (the structural divergence)

The real deployment is **decoupled**: the opencode *plugin* (or a headless
`opencode run` / MCP client) drives `runCampaign` against a runtime *from
outside*, while `arbor tui` (a separate process) watches via
`RuntimePortAdapter` + MCP/SSE. The demo **fuses driver + TUI into one
process**.

| Option | Description | Effort |
|---|---|---|
| **C1 — keep fused, exercise real ports** (recommended) | Keep one-process for the demo's manageability, but pass all real loop ports (A1–A12) and add operator input (B3). Matches the marching-orders: real canonical runtime, real capabilities — just co-located. The external observer already emulates the decoupled *watcher*. | Medium |
| **C2 — true decoupling** | Run the driver as the opencode plugin / a separate `opencode run` (via `-f`), and the TUI as `arbor tui` watching the same persistence dir. Fullest fidelity but heavier + harder to demo reliably. | High |

**Recommendation:** C1 now (real ports + operator control, one process), keep
C2 as a flag/option for high-fidelity mode.

---

## 4. Group D — Data-realism consequence

Until A2 (verification) lands, the whole emulation is **all-`claimed`**: no ✓
verified nodes, no real cost/telemetry, weak backtracking. A2 is gated on A1
(worktrees). This is the most visible "not a real TUI" tell and should be the
first thing an operator sees corrected.

---

## 5. Sequencing (dependency-ordered)

0. ✅ Prod stub: telemetry zero-stub → fixed in prod (`cockpit-sources.ts`) + wired into demo + test.
1. **A1 worktrees + A2 verification + A3 real agents** → the keystone; makes the tree honest (✓ nodes), makes agents edit isolated worktrees. Prod-side: `WorktreeManager` already real; demo-side: `use_worktrees:true` + real executor edit/verify + `verificationCmd`.
2. **A8 telemetry** (read side done in 0; wire the `telemetry` loop port). Then B4 telemetry view is real.
3. **A5–A10**: pass remaining real loop ports into `CampaignLoopConfig` (unblocked by a shared wiring helper, see below).
4. **B1 + B2 + B3**: route all 12 screens + feed projections + add operator input.
5. **A4 panel, A11 interview, A12 KB** (optional but completes the picture).
6. **C1** as the running mode; **C2** optional high-fidelity mode.

### Shared plumbing to add first
A pure helper in `arbor-mcp` that turns `runtime.loopPorts` (`CanonicalLoopPorts`)
into the `CampaignLoopConfig` extra fields (telemetry, interruptions, output_evidence,
token_economy, communications, panel) — so the demo (and the real plugin) pass the
same real ports instead of omitting them. This is the single highest-leverage change
and unblocks A5–A10 at once.

---

## 6. Definition of "done" (acceptance)

- [ ] A1–A3: demo runs real worktrees; a verified specialist produces a `!verified` node; tree shows ✓ with `verified_count>0`.
- [ ] A5–A10: `CampaignLoopConfig` receives the real loop ports (telemetry/interruptions/output_evidence/token_economy/communications/compaction).
- [ ] A8/B4: telemetry view shows real phase-histograms + provider cost from the ledger (no zeros).
- [ ] B1–B3: all 12 screens routable; operator can navigate + halt/interrupt from the TUI.
- [ ] Gate: `npx vitest run` green, `npm run build` clean, `tsc` clean, `git diff --check` clean; demo still hermetic in `--executor deterministic`.
- [ ] Prod-stub rule honored: every emulated seam is backed by real prod code, not a demo-side replacement.

## 7. Known prod-stub follow-ups (Section 0 ❗)
- **`interruptCampaign` no-op in `runTui`** → wire to `runtime.interrupt` on the active campaign's `expanding` node (needs a public tree-state accessor). Do this in prod BEFORE B3 (operator interrupt) so B3 isn't built on the no-op.
- (constraint) real opencode `token_usage` is `undefined` today → surface provider cost from the opencode response for A7/A8 to be honest about cost.
