# What stops the harness from running natively on its own repository — 2026-09-03

Scope: everything observed in this session, plus the standing record, that
prevents `arbor` from being pointed at `revoy2` itself and working on it the
way an operator would. Each item says what was seen, where the evidence is,
and what would clear it. Items are ordered by how early they stop a run.
Outstanding TUI work and owed decisions are listed at the end so this is the
one place to look.

Evidence roots: `artifacts/tui-pilot/2026-09-03-lifecycle-assessment.md`,
`artifacts/tui-pilot/2026-09-02-exemplar-checks.md` (EC-047…064),
`/mnt/sda2/revoy2/pilot/`, `qa-bench/selfhost-dogfood/` (2026-08-24 milestone),
the memory `harness-builds-itself-milestone`.

## Evidence boundary and disposition

This is a historical, date-bounded record whose title identifies the initial
assessment date. The table below records a remediation pass dated 2026-09-04;
“cleared” there means that pass reported a specific fix or run, not that the
entire self-hosting lifecycle is currently release-proven. The source paths,
operator files, and pilot directories cited in the original session may be
machine-local or may no longer describe the current checkout. Treat them as
provenance for the dated assessment, not as automatically reproducible proof.

Within this record, the provider-backed run 6 statements are observed claims
about that run. Lifecycle steps not exercised there—including crash recovery
and verified-result adoption—remain unproven for that cycle. The “shortest
path” below is a target sequence, and any missing artifact, unavailable
credential, or unrepeatable environment is unavailable evidence rather than a
pass. Current release claims must cite a fresh, revision-bound self-hosting
record; see the [1.0.0 roadmap](roadmap-1.0.0-and-documentation-governance.md#phase-1--measure-the-real-baseline-and-finish-the-release-contract).

This report remains historical after its 2026-09-04 remediation pass. The
“cleared” labels below describe that pass and its named pilot runs only; they
do not establish a current self-hosting release result. No current candidate
is certified by this report. The 1.0.0 acceptance record must bind its
self-hosting domain to the exact candidate and retain the run artifacts; if
credentials, provider access, or a repeatable environment are unavailable,
record the domain as unavailable with the reason.

## Status after the 2026-09-04 remediation pass

What changed, item by item. Evidence: the commits on `feat/native-selfrun`,
`/mnt/sda2/revoy2/pilot/haiku-bridge-20260903*` (four provider-backed
lifecycle runs through the Claude bridge, haiku), and the tests named in
each commit.

| # | state | what cleared it |
|---|---|---|
| A1 | **cleared** | keys come from the user-scope file `~/.config/revoy/revoy.env` (loaded after the project `.env`, never printed); OpenRouter is an ordinary provider (`native.closed_route` is the explicit opt-in) |
| A2 | **cleared** | the user-scope `~/.arbor/arbor.jsonc` pins `openrouter / anthropic/claude-haiku-4.5` with pricing and a budget; doctor reads `configured` for both |
| A3 | **cleared (documented)** | `arbor selfhost` now selects its executor through the harness-integration registry and takes the project's acceptance commands; the clone posture stands by design |
| A4 | **cleared** | `arbor doctor reconcile [--apply]` quarantined the six orphaned records of this checkout with a receipt; doctor names the command |
| A5 | **cleared** | `arbor.jsonc` is committed with `verification.acceptance_commands` (typecheck, then the vitest lane) |
| B1 | **cleared and proven (run 6)** | (prompt) the completion-evidence protocol names the exact acceptance commands; (logic) project-authored commands run on every tier; (system) a MINED write scope no longer refuses the test file the task asked for — the host binds it in the audit tier like the verifier already did, and the advance note says so; the project's acceptance commands join a mined scope's runnable argv; (logic) a FAILED machine verification on the native path is now handed to the loop and the critic instead of vanishing. Run 6: the specialist wrote the function and its test, the harness ran `bun test` (exit 0, `command_executed`), the critic approved |
| B2 | **cleared** | halted-unverified reads "Halted · nothing verified" (Console and status bar) |
| B3 | **cleared** | the Tree falls back to the specialist's `FAILED: <root cause>` |
| B4 | **cleared** | `devtools.stream` replays the durable `devtools.log` tail (ADR-021) |
| B5 | **cleared** | `task.list` marks restored, process-less tasks `interrupted`; status bar and Tasks say so |
| B6 | **cleared** | `arbor adopt` walks parent checkouts and `git worktree list`; ambiguity is a refusal that names every candidate |
| B7 | **L1–L3 and L9 (captured, command-verified) reached on the native lane through the bridge (run 6)**; adoption waits on the operator's exact scope authorization for the test file the mined scope did not name (owed decision D9) | tool calling is emulated in the bridge over the CLI's structured output; structured output itself was silently empty before (the CLI never streams it as text) |
| C1 | **restructured (ADR-160, Proposed)** | one rebind per session at `session:close --finish`, not one per commit series |
| C2 | **standing, by design** | the close receipt reports `push_allowed` and names the owed interviews |
| C3 | **cleared** | `bun run adr:resolve` resolves the governing record from history, proofs and neighbourhood; the commit-msg guard fills a unique confident trailer; an unregistered repository is ungoverned |
| C4 | **cleared** | the pre-commit hook exits 0 in any repository without this repository's own hook source |
| C5 | **owed decision D6** | unchanged |
| D1 | **unchanged** | the four standing failures remain (owed decision D2 and the SUR-05 drift); the suite is now hermetic against the operator's own config scope, which turned eleven more tests red today until fixed |
| E | **EC-057, EC-059 fixed**; EC-060 owed (D7) | the active rail tab wins its width; operator facts list one per line with a named remainder |

## A. Blockers that stop a native run before it starts

| # | blocker | observed | clears when |
|---|---|---|---|
| A1 | **No native credential.** `ARBOR_NATIVE_API_KEY`, `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` are present in `.env` and the environment as empty strings. `arbor doctor` on this checkout reports `Native credential: absent` and falls back to the `opencode` connector. | doctor output, this session | a real key is set; the native lane (`anthropic-messages` adapter, `claude-sonnet-5`, unpinned) has never been exercised on this repository |
| A2 | **The native lane is unpinned and unpriced.** Doctor: `Model/revision: anthropic / claude-sonnet-5 (unpinned)`, `Pricing: not_configured; budget: not_configured`. A native run would have no cost ceiling and no recorded revision. | doctor output | `native.model` pinned and a budget configured in `arbor.jsonc` |
| A3 | **The harness may not target its own checkout.** The isolation guard (`resolveHarnessSourceCheckout()`, dogfood fix D2) forbids the harness source checkout as a campaign target; self-hosting is legal only against a clone or a worktree. This is deliberate and correct, but it means "run natively on its own repo" is by construction "run on a clone of its own repo". | memory `harness-builds-itself-milestone`; `packages/arbor-mcp/src/selfhost.ts` | a documented `arbor selfhost` path that clones, runs and reports adoption back, which exists but only through the opencode connector so far |
| A4 | **This checkout's persistence needs reconciliation.** Doctor: `Persistence: needs reconciliation`, remedy "inspect the listed store mismatch, then repair only with the named recovery command". `.arbor/` here carries 61 recorded sessions and demo state from prior sessions. A self-hosted campaign would inherit that. | doctor output | `arbor doctor --json` mismatch repaired, or a clean persistence root for self-hosting |
| A5 | **No `arbor.jsonc`.** Doctor: `Migration: migration_available (no Arbor configuration exists)`. Every run uses defaults; theme, keymap, native model, budget, integration choice are all implicit. | doctor output | a committed project config for revoy2 itself |

## B. Blockers inside a run (observed on the provider-backed lifecycle pilots)

| # | blocker | observed | clears when |
|---|---|---|---|
| B1 | **The specialist did not run the authored acceptance command; the critic blocked it; the campaign halted with nothing verified.** Run 3: `! BLOCKED · lenticel: The authored acceptance command was not run; the only machine verification provided is weaker than a passed acceptance command`. The connector produced changes but no acceptance evidence. On revoy2 the acceptance command is `bun run test`/`tests:typecheck`, which the specialist would have to run inside its worktree. | `lifecycle-20260903T1553-full/run-01`, f0058 | the connector runs (or is handed) the acceptance command as part of the specialist turn; the 2026-08-24 selfhost proof did this only through explicit `--verification-cmd` flags |
| B2 | **A halted-unverified campaign presents as complete.** Same frame: `· Complete · ready for review` and status bar `Completion ready for review` two rows under `0 verified · 1 failed`. An operator or an outer loop reading the surface would proceed. EC-064. | same run | completion wording distinguishes halted-unverified from complete |
| B3 | **The failure reason is durable but not shown.** Run 1: the node failed with `fatal: not a git repository`; the Console said `halted (no_nodes)`, the Tree said `Outcome: —`. EC-061. A self-running harness cannot diagnose its own failed node from its own UI. | `lifecycle-20260903T1546/run-01` | the node's `failure_mode` fact is rendered on the Tree detail and the halt notification |
| B4 | **DevTools shows zero events for a run whose log holds them.** After the halt, DevTools read `streaming · 0 events` while `.arbor/devtools/devtools.log` had 10–21 records. EC-063. The diagnostic surface a self-run would rely on is empty exactly when it is needed. | both lifecycle runs | the DevTools screen replays the durable log (ADR-021 contract to read first) |
| B5 | **A resumed session with orphaned started tasks says "Thinking".** EC-053: durable tasks marked started with no process behind them render as work in flight. After any crash mid-run, `--resume` would show a live campaign that is not. | populated seed under `--resume` | reconciliation on resume marks such tasks interrupted, or the wording names the absence |
| B6 | **Adopt is cwd-sensitive and silent about it.** `arbor adopt --campaign X` returns `captures: []` from the target root; the capture store lives under the campaign worktree's `.arbor/adopt/` (dogfood D6, still open). An outer loop adopting its own result from the wrong cwd sees nothing and believes nothing was produced. | memory `harness-builds-itself-milestone` | adopt locates the campaign across persistence roots or says where it lives |
| B7 | **The lifecycle beyond L3 is unproven this cycle.** L5 recover needs a crashed node (the halt was governed, not a crash) and L9 finish needs a verified result (B1 prevented one). The 2026-08-24 proof reached adoption once, through opencode with explicit verification flags, before most of the TUI fixes landed. | derived matrix: lifecycle 4 of 9 | one run that reaches `verified_result` → Diff Review → adopt on a clone of this repository, recorded with the pilot apparatus |

## C. Governance cost that makes an unattended self-run impractical

| # | blocker | observed | clears when |
|---|---|---|---|
| C1 | **Every source commit series costs a rebind.** `evidence:rebind` took 8–12 minutes per pass this session (three passes), holds an exclusive lease, and precommit gates fail while it runs. A self-running harness committing to its own repo pays this per series and cannot commit during it. | this session; ADR-156 measured the stop tier at ~16 s per turn on top | the rebind's LSP phase (`[vi-lsp] references: n/10138`) is the cost; ADR-090's extractor swap is the recorded follow-on |
| C2 | **Pushes are blocked by the decision queue whenever a record is Proposed.** Cleared today by the interview for ADR-154…159, but any ADR the harness authors about its own work re-blocks pushes until a human interviews. That is by design (ADR-158), and it means a self-run can never push its own governed change without a human turn. | gate:decision-queue, this session | accepted as a standing property; document it in the self-hosting runbook rather than work around it |
| C3 | **The commit-msg guard needs a real ADR number for every governed path.** ADR-155 (accepted today) now requires the number to resolve. A harness authoring source under `packages/` or `scripts/` must know which ADR governs it or author one first, which returns to C2. | ADR-155 | the runbook names the governing ADR per package, or the harness reads `git log --format='%(trailers:key=ADR)'` for the path it touches, as the governance skill instructs |
| C4 | **Precommit runs the repo's own hook in every git repository on this workstation.** The global `core.hooksPath` points at revoy2's pre-commit; a seed project's first commit failed until the seed passed `core.hooksPath=/dev/null` (EC-022 class). Any worktree or clone the harness creates on this machine inherits it. | seed ledger, this session | the hook exits 0 outside revoy2, or the harness's clone/worktree step unsets `core.hooksPath` |
| C5 | **The Claude Code clean-room boundary is unresolved (EC-054).** Fifty exemplar findings and several code comments rest on a decompiled bundle the repo's own spec forbids. Not a runtime blocker, but a self-run that cites prior art would inherit it. | `docs/research/reference-harness-clean-room-spec.md`; EC-054 | operator ruling recorded in `2026-09-03-owed-decisions.md` D6 |

## D. Test and workstation state a self-run would trip over

| # | item | state |
|---|---|---|
| D1 | Four vitest failures are standing: `governance-projection` SUR-05 drift; `tui-operator-form-controls` (1) and `tui-result-adoption-stale-selection` (2), which seed durable state and launch without `--resume` — the fresh-launch filter hides it (owed decision D2). A self-run's `bun run test` acceptance is red before it starts. | 7665 pass / 7 fail this session; 3 of the 7 were store staleness |
| D2 | The full vitest lane takes ~2.5 minutes and the OpenTUI lane needs Bun; `captest` is the memory-capped wrapper for anything heavy, and the workstation's cooling is recorded as failed (2026-09-01). A self-run that fans out test workers will hit that. | memory `workstation-cooling-failed` |
| D3 | 18 gates run only at prepush/CI and were not previewed locally; `gate:opentui` and `gate:typecheck-tests` were run green here directly, the rest not. | gate:all output |
| D4 | `git worktree list` shows 22 prunable worktrees under `/tmp/canopy-ux-*` from earlier sessions; `gate:worktree-hygiene` passes, but a self-run creating worktrees adds to that pile. `git worktree prune` is a destructive act left for the operator. | this session |

## E. Outstanding TUI work (not blockers, carried from the pilot)

- EC-057 fact-strip density at 132 columns; EC-059 the active rail tab is the one elided; EC-060 light theme on a dark terminal; EC-053/061/063/064 as above.
- Unpiloted: X09 forms only partly (Submit Job, Ask, Enroll); M03 notifications with real traffic; M09 harness session steering; comms rows M04–M08 need a re-run of the tagged scenarios to register in the derived matrix.
- Standing debt from the handoff: `tui-live-session-stream` is flaky; legacy real-stdin tests assert on timing; startup readiness had a 30 s outlier once and there is no semantic ready marker (the pilot keys on `❯`).
- Architectural notes, no action: EC-029 paint model; EC-017 hand-rolled text buffer versus `TextareaRenderable`.

## F. Owed operator decisions

All eight are in `artifacts/tui-pilot/2026-09-03-owed-decisions.md`: D1 ctrl+shift chords (Ctrl+Shift+C exits), D2 fresh-launch filter, D3 peer surface, D4 OpenTUI-default ADR, D5 pilot-apparatus ADR, D6 clean-room boundary, D7 light theme, D8 failure-reason ownership. ADR-154…159 were decided today.

## The shortest path to a native self-run

1. Set a native key, pin the model, configure a budget (A1, A2, A5).
2. Run `arbor selfhost` against a clone with the acceptance command passed explicitly (B1), through the pilot apparatus so the run is a receipt, not a memory.
3. Adopt from inside the campaign worktree (B6).
4. Expect one interview per ADR the run authors (C2); budget a rebind per commit series (C1).
5. Fix B2 and B3 first among the TUI items: they are the two that would make an outer loop misread its own result.
