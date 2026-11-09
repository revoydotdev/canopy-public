# Frontier-Harness Feature & Polish Research Snapshot

**Purpose:** a dated, diffable research snapshot of revoy2's native "arbor" harness against four
frontier agent harnesses — **Claude Code**, **OpenAI Codex (CLI)**, **Zoo Code** (Zed/Roo
lineage), and **OpenCode**. It is not a current product score, feature promise, or claim of
frontier parity.

**Generated:** 2026-08-12 · **revoy2 @** `345423c` · supersedes the revoy2-only
`executive-comparison-chart.md`.

**Evidence boundary:** this is a historical comparison snapshot of revoy2 at
`345423c`, not a current capability inventory. Its revoy2 cells are claims
graded against that revision; external columns are synthesized from the cited
research corpus and can be unknown where evidence is silent. In particular,
the weighted scores and “leader” language are taxonomy-dependent comparisons,
not observed benchmark outcomes. Later implementation, changed product
behavior, or newer external versions are outside this snapshot. Regrade both
sides against revision-bound evidence before using the matrix for release
decisions; the [canonical 1.0.0 roadmap](roadmap-1.0.0-and-documentation-governance.md#phase-1--measure-the-real-baseline-and-finish-the-release-contract)
owns the current baseline requirement.

**How this was built.** The four external columns are synthesized from our own reference /
clean-room research corpus (`docs/clean-room-research-report.md` and its citing documents,
`docs/frontier-intra-agent-comms.md`, `docs/full-harness-ownership-brief.md`,
`docs/research/*`). The revoy2 column was graded against the source tree at the revision above,
with file:symbol evidence and a strict "wired into the live loop, not just a tested module" bar.

## Read this before trusting the score

1. **This tracks presence, not polish.** A ✅ means the capability existed and was wired at the
snapshot revision — it does
   **not** mean it is as refined as a competitor's. On UX maturity (live cost HUD, palette feel,
   IDE integration) Claude Code, Codex, and OpenCode lead; several revoy2 ✅s landed in the last
   few days and are correct-but-young. Polish parity is called out per-row in the executive read,
   not in the emoji.
2. **The taxonomy is revoy2-authored, so it flatters revoy2.** It deliberately includes
   tree-search cognition, typed provenance, structural checks-and-balances, and a built-in eval
   harness — revoy2's design center, which mainstream harnesses consciously *do not* pursue.
   revoy2 topping the weighted score reflects category selection as much as capability. Read the
   *shape* (where each harness is strong/weak), not the horse-race number.
3. **External cells carry real uncertainty.** Our corpus explicitly marks Claude Code
   "binary (PLUGIN/DOCS)", so many Claude Code cells fall back to general knowledge and its true
   coverage is almost certainly **higher** than the corpus-derived cells show (its hooks, skills,
   slash commands, plan mode, and cloud scheduling are first-party real). `❓` marks genuine
   corpus silence — not a "no".

## Legend

| Mark | Meaning |
|---|---|
| ✅ | Present and wired (for revoy2: implemented in the live path and tested) |
| 🟡 | Partial — exists but narrow, behind-flag, substrate-only, or not wired into the live loop |
| ❌ | Absent |
| ❓ | Unknown — sources are silent and no confident call can be made |

## Parity scorecard

Snapshot coverage of the 39 categories (✅ = 1, 🟡 = 0.5, ❌/❓ = 0). **Presence, not polish;
taxonomy is revoy2-authored — see caveats above.**

| Harness | ✅ | 🟡 | ❌ | ❓ | Weighted |
|---|---|---|---|---|---|
| **revoy2** | 31 | 4 | 4 | 0 | **≈85%** |
| OpenAI Codex | 25 | 9 | 5 | 0 | ≈76% |
| Claude Code | 20 | 13 | 5 | 1 | ≈68%* |
| OpenCode | 21 | 8 | 6 | 4 | ≈64% |
| Zoo Code | 16 | 10 | 11 | 2 | ≈54% |

\* Claude Code is corpus-thin (binary internals); its real coverage is higher than shown.

## The matrix

Grouped by capability area. Cells are status-only for scanning; the one-line approach per cell
is in **Per-category detail** below.

| # | Capability | revoy2 | Claude Code | Codex | Zoo Code | OpenCode |
|---|---|:--:|:--:|:--:|:--:|:--:|
| | **A · Tooling & Extensibility** | | | | | |
| 1 | MCP client | ✅ | 🟡 | ✅ | 🟡 | ✅ |
| 2 | MCP server (self-expose) | ✅ | ❓ | 🟡 | ❌ | ❓ |
| 3 | Core tool suite (read/write/edit/shell/git) | ✅ | ✅ | ✅ | ✅ | ✅ |
| 4 | Directory / file discovery | ✅ | ✅ | ✅ | ✅ | ✅ |
| 5 | Skills / capability bundles | ✅ | ✅ | ✅ | 🟡 | ✅ |
| 6 | Hooks & lifecycle injection | ❌ | ✅ | ✅ | 🟡 | ✅ |
| 7 | Custom slash / user commands | 🟡 | ✅ | ✅ | ✅ | ✅ |
| 8 | Plugin / extension marketplace | ❌ | ✅ | ✅ | 🟡 | 🟡 |
| | **B · Agent Orchestration** | | | | | |
| 9 | Subagent spawn & management | ✅ | ✅ | ✅ | ✅ | ✅ |
| 10 | Agent-to-agent comms fabric | ✅ | ❌ | 🟡 | ❌ | ❌ |
| 11 | Agent roles / profiles | ✅ | ✅ | ✅ | ✅ | ✅ |
| 12 | Prompting infrastructure | ✅ | 🟡 | ✅ | 🟡 | 🟡 |
| 13 | Foreground switching / capability routing | 🟡 | 🟡 | 🟡 | ✅ | 🟡 |
| | **C · Execution & Planning** | | | | | |
| 14 | Plan mode (plan→confirm→execute) | ✅ | ✅ | ✅ | 🟡 | ❓ |
| 15 | Tree-search / MCTS cognition | ✅ | ❌ | ❌ | ❌ | ❌ |
| 16 | Verification / critic gate | ✅ | 🟡 | 🟡 | ❌ | 🟡 |
| 17 | Task decomposition / delegation | ✅ | ✅ | ✅ | ✅ | ✅ |
| | **D · Reliability & Isolation** | | | | | |
| 18 | Crash recovery / continuation | ✅ | ✅ | 🟡 | ✅ | 🟡 |
| 19 | Worktree / filesystem isolation | ✅ | 🟡 | ❌ | ❌ | ❓ |
| 20 | OS-enforced sandbox | ❌ | 🟡 | ✅ | ❌ | ❓ |
| 21 | Cancellation / interruption (typed) | ✅ | ✅ | ✅ | 🟡 | ✅ |
| | **E · Context & Economy** | | | | | |
| 22 | Token discipline / budget & epochs | ✅ | ✅ | ✅ | ✅ | ✅ |
| 23 | Context compaction / folding | ✅ | ✅ | ✅ | ✅ | ✅ |
| 24 | Persistent memory / KB | ✅ | ✅ | 🟡 | ✅ | 🟡 |
| | **F · Long-Horizon & Automation** | | | | | |
| 25 | Loop / cron / scheduled autonomy | ❌ | 🟡 | ❌ | ❌ | ❌ |
| 26 | Headless / CI / non-interactive | ✅ | ✅ | ✅ | ❓ | ✅ |
| | **G · Governance & Safety** | | | | | |
| 27 | Provenance typing / evidence-first | ✅ | ❌ | ❌ | ❌ | ❌ |
| 28 | Permission tiers / approval mediation | ✅ | ✅ | ✅ | ✅ | ✅ |
| 29 | Audit ledger / durable telemetry | ✅ | 🟡 | 🟡 | ❌ | 🟡 |
| 30 | Checks & balances (no self-approval) | ✅ | ❌ | 🟡 | ❌ | ❌ |
| | **H · Interaction & UX** | | | | | |
| 31 | UI/UX surface richness | ✅ | ✅ | ✅ | ✅ | ✅ |
| 32 | User-interview / question-asking | ✅ | 🟡 | ✅ | ✅ | ✅ |
| 33 | Command palette / keybindings / config | ✅ | ✅ | ✅ | 🟡 | ✅ |
| 34 | Streaming + cost/token display | 🟡 | ✅ | ✅ | ✅ | ✅ |
| | **I · Interop & Deployment** | | | | | |
| 35 | Remote / cloud session ingress | 🟡 | 🟡 | 🟡 | ❓ | ✅ |
| 36 | Multi-provider / model routing | ✅ | 🟡 | ✅ | ✅ | ✅ |
| 37 | Eval / benchmark harness | ✅ | ❌ | ❌ | ❌ | ❌ |
| | **J · Extended axes** | | | | | |
| 38 | Output fidelity / raw-capture under truncation | ✅ | 🟡 | ✅ | 🟡 | 🟡 |
| 39 | Config source-provenance (per-knob origin) | ✅ | 🟡 | ✅ | 🟡 | ✅ |

## Per-category detail (one-line approach per harness)

**A · Tooling & Extensibility**
1. **MCP client** — revoy2 ✅ governed tool-ports injected per session, fail-closed (`cli.ts:723 toolPortsForSession`) · CC 🟡 plugin/SDK boundary, internals binary · Codex ✅ declarative `mcp_requirements.rs` · Zoo 🟡 Roo-lineage, unconfirmed · OpenCode ✅ native MCP client.
2. **MCP server** — revoy2 ✅ `arbor-mcp serve` stdio server exposes the runtime · CC ❓ · Codex 🟡 `codex mcp` reported, unconfirmed · Zoo ❌ · OpenCode ❓ `serve` API, MCP conformance unclear.
3. **Core tool suite** — all ✅: file read/write/edit, search, shell, git are table stakes everywhere.
4. **Directory discovery** — revoy2 ✅ `repository.list` (bounded/sorted, elides .git) · CC ✅ Glob/Grep/LS · Codex ✅ · Zoo ✅ · OpenCode ✅.
5. **Skills** — revoy2 ✅ governed catalog, authority can only *reduce* · CC ✅ native Skills · Codex ✅ `skills_config.rs` · Zoo 🟡 modes/rules, not formal skills · OpenCode ✅ one `/skills` proxy opens a sub-picker and inserts `/<skill> `; individual skills are **not** registered as palette commands (corrected by roadmap 22 §9.1).
6. **Hooks / lifecycle** — revoy2 ❌ no pre/post-tool or session event bus · CC ✅ rich hook system · Codex ✅ pre/post-compact hooks · Zoo 🟡 some events, no cross-cutting system · OpenCode ✅ `tool.execute.before/after`, `permission.ask`.
7. **Custom slash / commands** — revoy2 🟡 fixed CLI subcommands only, no user-defined · CC ✅ · Codex ✅ · Zoo ✅ · OpenCode ✅ `command.ts` sidecar.
8. **Plugin marketplace** — revoy2 ❌ · CC ✅ · Codex ✅ `marketplace.rs` · Zoo 🟡 `modes.yml`/`mcps.yml` assets · OpenCode 🟡 `plugin.ts`, maturity unclear.

**B · Agent Orchestration**
9. **Subagent management** — revoy2 ✅ `declarative-subagent-executor` via governed context · CC ✅ Task tool · Codex ✅ multi-agent handler · Zoo ✅ boomerang subtasks · OpenCode ✅ `BackgroundJob` registry.
10. **A2A comms** — revoy2 ✅ `a2a-bridge`/`a2a-wire` in runtime catalog · CC ❌ · Codex 🟡 typed mailbox, in-memory, lost on crash · Zoo ❌ one-shot child→parent only · OpenCode ❌ forward-push, no durability.
11. **Agent roles** — revoy2 ✅ typed role profiles + per-role tool policy · CC ✅ YAML agents · Codex ✅ `role.rs`+personalities · Zoo ✅ `.roomodes` · OpenCode ✅ `Info` catalog.
12. **Prompting infra** — revoy2 ✅ layered role-conditioned, capability-gated · CC 🟡 binary-internal · Codex ✅ base→per-model→role→personality (deepest) · Zoo 🟡 mode = template · OpenCode 🟡 static per-`Info`.
13. **Foreground switching** — revoy2 🟡 `NodeCard` routing exists, not the default `selectNode` path · CC 🟡 user-picked · Codex 🟡 caller-passed name · Zoo ✅ model-driven `switch_mode` · OpenCode 🟡 `/agents`.

**C · Execution & Planning**
14. **Plan mode** — revoy2 ✅ task-composer plan→confirm/reject→admit · CC ✅ Enter/ExitPlanMode · Codex ✅ `ModeKind::Plan` · Zoo 🟡 architect mode · OpenCode ❓.
15. **Tree-search / MCTS** — revoy2 ✅ UCT tree controller (`arbor-core/tree.ts`); **unique** · CC/Codex/Zoo/OpenCode ❌ all linear ReAct-style.
16. **Verification / critic** — revoy2 ✅ worktree machine verifier + panel of critics · CC 🟡 review workflows · Codex 🟡 `approvals_reviewer` field · Zoo ❌ · OpenCode 🟡 completion-challenge.
17. **Decomposition** — all ✅: revoy2 plan-action delegation · CC TodoWrite · Codex multi-agent · Zoo boomerang · OpenCode subtasks.

**D · Reliability & Isolation**
18. **Crash recovery** — revoy2 ✅ effect-classifier + governed `recover` (never replays indeterminate effects) · CC ✅ resume/continue · Codex 🟡 resume, crash semantics undetailed · Zoo ✅ task-history JSON · OpenCode 🟡 session persist, crash-safety unclear.
19. **Worktree isolation** — revoy2 ✅ per-node worktree leases at the tool boundary · CC 🟡 community-skill workaround · Codex ❌ · Zoo ❌ shares host workspace · OpenCode ❓.
20. **OS sandbox** — revoy2 ❌ app-level path/command allowlist only (roadmap 05) · CC 🟡 sandboxed-bash reported · Codex ✅ **OS-enforced** read-only/workspace/full tiers (leader) · Zoo ❌ · OpenCode ❓.
21. **Cancellation** — revoy2 ✅ typed AbortSignal through the loop · CC ✅ Esc · Codex ✅ `interrupt_agent` · Zoo 🟡 cancel, typing unclear · OpenCode ✅.

**E · Context & Economy**
22. **Token discipline** — revoy2 ✅ `ExpansionTokenEpoch` immutable epochs · CC ✅ · Codex ✅ `COMPACT_..._MAX_TOKENS` · Zoo ✅ condense thresholds · OpenCode ✅ `PRUNE_PROTECT` guards.
23. **Compaction / folding** — revoy2 ✅ deterministic `foldToRecentTail` + curated summary · CC ✅ auto-compact · Codex ✅ typed trigger→strategy→status (most formalized) · Zoo ✅ non-destructive `condenseParent` · OpenCode ✅ anchored-summary.
24. **Persistent memory / KB** — revoy2 ✅ SQLite KB wired to manager/TUI · CC ✅ CLAUDE.md/memory files · Codex 🟡 AGENTS.md · Zoo ✅ per-mode rule files · OpenCode 🟡 AGENTS.md.

**F · Long-Horizon & Automation**
25. **Loop / cron** — revoy2 ❌ campaigns bounded by iteration/second budgets, no scheduler · CC 🟡 scheduled/cloud agents reported · Codex ❌ · Zoo ❌ · OpenCode ❌. *(Ambient in the CLI harness driving them, native in almost none.)*
26. **Headless / CI** — revoy2 ✅ exit-code/stdio driven · CC ✅ `-p` print mode · Codex ✅ `codex exec` schema output · Zoo ❓ · OpenCode ✅ `run`/`serve`.

**G · Governance & Safety** *(revoy2's design center)*
27. **Provenance typing / evidence-first** — revoy2 ✅ closed `verified|claimed|critic_approved|generated` union; only `verified` retires a node (`arbor-core/types.ts:21`); **unique** · CC/Codex/Zoo/OpenCode ❌ plain transcripts, no typed provenance.
28. **Permission / approval** — revoy2 ✅ high-risk tool-scope approval · CC ✅ permission modes · Codex ✅ `AskForApproval`+sandbox_mode · Zoo ✅ per-action approve · OpenCode ✅ default-ask gateway.
29. **Audit ledger** — revoy2 ✅ hash-chained tip-sentinel ledger + repair log; **leader** · CC 🟡 transcripts · Codex 🟡 spans/metrics · Zoo ❌ task-history only · OpenCode 🟡 event stream.
30. **Checks & balances** — revoy2 ✅ structurally forbids same-actor propose+approve; **unique** · CC ❌ · Codex 🟡 role separation, not enforced · Zoo ❌ · OpenCode ❌.

**H · Interaction & UX**
31. **UI/UX richness** — all ✅: revoy2 opentui TUI + web dashboard · CC TUI+IDE+web · Codex deep TUI · Zoo VS Code GUI · OpenCode adaptive TUI. *(Polish differs — see executive read.)*
32. **User-interview** — revoy2 ✅ task-composer clarification, answer-gated confirm · CC 🟡 clarifying behavior, dedicated tool uncertain · Codex ✅ `request_user_input` · Zoo ✅ `ask_followup_question` · OpenCode ✅ permission gateway doubles as ask.
33. **Palette / config** — revoy2 ✅ bounded keymap grammar + JSONC · CC ✅ settings/keybindings · Codex ✅ TOML chord grammar (deepest) · Zoo 🟡 editor settings + sidecars · OpenCode ✅ comment-preserving JSONC.
34. **Streaming + cost display** — revoy2 🟡 devtools streaming + exact token/cost accounting, but no live cost HUD · CC ✅ · Codex ✅ · Zoo ✅ per-request cost · OpenCode ✅.

**I · Interop & Deployment**
35. **Remote / cloud ingress** — revoy2 🟡 remote-ingress seam but only a loopback transport, no listener · CC 🟡 cloud product reported · Codex 🟡 · Zoo ❓ · OpenCode ✅ `serve` local+remote HTTP (leader).
36. **Multi-provider routing** — revoy2 ✅ native provider config + per-role models · CC 🟡 mainly Anthropic (Bedrock/Vertex) · Codex ✅ · Zoo ✅ (Roo strength) · OpenCode ✅.
37. **Eval harness** — revoy2 ✅ `arbor-eval` + `ProductionHarnessEvaluator`; **unique** · CC/Codex/Zoo/OpenCode ❌ none ship a built-in eval product.

**J · Extended axes**
38. **Output fidelity / raw-capture** — revoy2 ✅ raw-output-is-evidence, content-addressed · CC 🟡 · Codex ✅ bounded-capture + `/raw` · Zoo 🟡 · OpenCode 🟡.
39. **Config source-provenance** — revoy2 ✅ loader layers defaults/file/env with origin · CC 🟡 · Codex ✅ deepest layering · Zoo 🟡 · OpenCode ✅ source-tagged layers.

## Executive read

### Where revoy2 already leads (its moat is real)
The **governance + cognition spine** is a genuine differentiator, not a checkbox:
- **Tree-search cognition (15)**, **typed provenance / evidence-first (27)**, **structural
  checks-and-balances (30)**, **hash-chained audit ledger (29)**, and a **built-in eval harness
  (37)** are categories where revoy2 is ✅ and *every* mainstream harness is ❌. These are
  architecturally load-bearing and hard to retrofit — they're the reason recovery (18) and
  telemetry (29) are trustworthy rather than best-effort.
- **A2A comms (10)** and **worktree isolation (19)** are ✅ where competitors are ❌/🟡: revoy2's
  A2A is durable and in the runtime catalog, versus Codex's crash-losable in-memory mailbox and
  OpenCode's explicitly non-durable forward-push.
- **Crash recovery (18)** is best-in-class: the effect-classifier proves revoy2 *never replays an
  indeterminate effect*, a property no competitor's resume feature claims.

### Where revoy2 has real gaps (prioritized)
1. **Extensibility chrome — the biggest cluster.** Hooks (6) ❌, plugin marketplace (8) ❌,
   user-defined slash commands (7) 🟡. Every frontier harness treats these as core; this is the
   most visible "it's a harness, but not *extensible* like theirs" gap. Cheapest high-leverage
   win: a pre/post-tool + session-lifecycle **hook bus** (6) — it also unlocks (7) and (8).
2. **OS-enforced sandbox (20) ❌.** Codex's OS-level tier is the leader; revoy2 refuses unsafe ops
   honestly but confines at app level only. Already roadmapped (05); the single biggest
   *safety* parity gap.
3. **Loop / cron / long-horizon autonomy (25) ❌.** No native scheduler — campaigns self-bound by
   budget. (Note: this doc is being produced *by* a `/loop` in the CLI harness; the ambient
   capability exists around revoy2, not in it.)
4. **Remote/cloud ingress (35) 🟡.** Seam exists, only loopback transport implemented; OpenCode's
   `serve` is the reference. Roadmapped (LR-NH-03).
5. **Foreground capability-routing (13) 🟡.** `NodeCard` routing is built but the live loop still
   uses baseline UCT selection — wiring, not code.

### Polish parity (the separate lens you asked to track)
Presence ≠ refinement. On **UX polish**, Claude Code, Codex, and OpenCode lead: live cost/context
HUDs (34), mature palettes and IDE integration (31, 33), and years of ergonomics. Many revoy2 ✅s
(MCP client, skills, crash recovery, `repository.list`) landed within days of this snapshot and
are correct-but-young. **Codex is the harness to study for polish** — deepest config/prompt
layering, OS sandbox, formalized compaction, and a first-class `request_user_input`.

### Bottom line
revoy2 is **ahead on the governance-and-cognition axis it was designed around** (tree-search,
typed provenance, checks-and-balances, durable audit, eval) and **at or near parity on the
execution core** (tools, roles, planning, recovery, isolation, context economy). Its parity debt
is concentrated in **operator-facing extensibility** (hooks → commands → plugins), **OS-level
sandboxing**, and **long-horizon/remote deployment** — all roadmapped, none architectural
blockers. Closing the hook-bus cluster and the OS sandbox would move it from "governed and
capable" to "governed, capable, *and* extensible like the frontier."

---

*Maintenance: regrade the revoy2 column against code each time a roadmap lands; refresh external
columns when the reference corpus is updated. Keep the caveats section honest — the score is a
shape, not a trophy.*
