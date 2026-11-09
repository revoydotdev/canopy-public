# Roadmap 22 — Operator ergonomics (2026-08)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 73fb8068 (2026-09-22)
Authority: Retained research-and-build brief; findings are inputs to ADRs or the canonical roadmap and are not implementation claims.
Evidence scope: mixed — dated 2026-08 literature/protocol sweep re-verified against code at authoring time (observed) plus build and do-not-build proposals (target); not re-run since
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22):** this brief is retained as design and implementation history. Its priorities and ordering are subordinate to the [Canopy/revoy2 1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md). Treat implementation and research claims as bounded to the evidence recorded in this brief; verify current status against code and sealed evidence before relying on them.
**Lane:** standing correction lane (with 19, 20, 21). Same two-stage discipline: dispatched
research agents produced briefs; every claim about revoy2, about `@opentui/core`, and every
load-bearing claim in the agents' own briefs was then re-verified against the primary source
before it was written down. That pass **refuted one premise the research was given** (§9.1),
**downgraded one transplant to a from-scratch build** (§9.2), and **inverted the framing of the
single largest item** (§0).

**Sources, all cross-checked:**

| Source | Provenance | License posture |
|---|---|---|
| Claude Code **0.2.8** sourcemap (`~/Dev/refs/claude-code-sourcemap/`, held outside the repo) | early research preview | **Proprietary, "All rights reserved."** Full clean-room: behavioral specs only, no expression carried across |
| Claude Code **2.1.228** — current build | self-description surfaces only (`--help`, `doctor`, `auto-mode defaults`); **no `strings`/decompilation**, unlike the Codex pass | Proprietary; see `../research/claude-code-clean-room-reference-2026-08-12.md` |
| Claude Code **2.1.258** — current build | self-description surfaces (`--help`, `agents --help`, `doctor`) plus Anthropic's **published documentation** (`code.claude.com/docs`); a `strings`-class grep was run in error and is disclosed and contained | Proprietary; see `../research/claude-code-parallel-session-reference-2026-09-02.md` |
| **Codex CLI 0.147.0** (installed locally) | `codex app-server generate-ts` → 723 generated types; `codex debug prompt-input`; `strings` over the vendored binary | Apache-2.0 |
| **OpenCode** @ `14b37df39168eaf6a6faf862ec4a7bbe9c825bbd` | 196,608★ / 25,271f, pushed 2026-08-13 | MIT |
| **`@opentui/core@0.5.1`** — revoy2's own pinned dependency | read directly from `node_modules` | MIT |
| Frontier literature sweep | 24 papers surfaced, 10 pulled in full | — |

---

## §0 The bound: the largest item is not a gap, and the second largest is not catch-up

Two framings have to be corrected before anything here is actioned, because both were wrong in
this roadmap's own first draft.

**First: most of what looks missing is unused.** revoy2 pins `@opentui/core@0.5.1` and does not
use the parts of it that close the gaps this sweep set out to find. Verified directly against
`node_modules`:

| API in our pin | Verified location | revoy2 uses it |
|---|---|---|
| `triggerNotification(message, title?): boolean` | `renderer.d.ts:436` | **No** |
| `get capabilities(): TerminalCapabilities \| null` | `renderer.d.ts:435` | **No** |
| `FOCUS` event | `renderer.d.ts` event enum | **No** — every `focus` hit in `arbor-tui` is internal *pane* focus |
| `waitForThemeMode(timeoutMs?)`, `getPalette` | `renderer-theme-mode.d.ts`, `renderer.d.ts` | **No** |
| Kitty keyboard protocol (`useKittyKeyboard`, `buildKittyKeyboardFlags`) | `renderer.d.ts:42,125,143` | **No** |
| `testing/`: `mock-keys`, `mock-mouse`, `terminal-capabilities`, `test-recorder`, `spy`, `manual-clock` | `testing/*.d.ts` | **Mouse only** |

**And revoy2 is on a newer opentui than OpenCode.** We pin 0.5.1; OpenCode — 196k stars, daily
commits — pins 0.4.5. We are ahead of the reference on the substrate and behind it on using the
substrate. That is a much cheaper problem than the one this roadmap was originally scoped for.

**Second: the cost/context item is not catch-up work.** The first draft held Claude Code 0.2.8's
`TokenWarning` (silent below 60%, warn, error at 80%, remedy named inline, ceiling set *below* the
real limit to reserve room to run the fix) as a standard revoy2 was failing to meet. Verified
against OpenCode: it has **no threshold coloring and no context-aware inline remedy at all** —
exhaustive negative grep, `theme.warning`/`theme.error` never co-located with `percent`/`context`.
It papers over the gap with silent server-side auto-compaction plus a decontextualised rotating
onboarding tip. So one 2025 research preview had it, and the largest open-source harness in the
category does not.

**Building it puts revoy2 ahead of the frontier reference, not level with it.** Frame it as novel
work in the handoff, and do not justify it as parity.

**What this sweep does not establish.** No measurement. Every source here is an existence proof
that a mature harness ships a pattern — never evidence that the pattern works. The literature that
would measure it does not exist: see §10 for five separate empty findings where the published
record is silent on exactly the questions this roadmap answers from RE.

---

## §1 Files to read first

Repo — verify these yourself; every claim below was checked against them:

- `packages/arbor-tui/src/opentui-renderer.ts` — where `createCliRenderer` is called and
  `CliRendererConfig` is forwarded. **W1** lands here.
- `packages/arbor-tui/src/overlays.ts` — the bounded notification ring (≤100) and its persistent
  band. **W1** extends this, does not replace it.
- `packages/arbor-tui/src/status-bar.ts:75–120` — `deriveStatusBarZones`, seven zones, and
  `formatBudget`'s refusal to print `$0` for unpriced rows. **W7.**
- `packages/arbor-tui/src/screens/native-budget.ts` — budget as static table fields. **W7.**
- `packages/arbor-tui/src/screens/diagnostics.ts` — an *event/trace timeline*, **not** an
  installation/store health check. **W3** is a different thing; do not conflate them.
- `packages/arbor-tui/tests/opentui-{renderer,hit-test,bakeoff}.test.ts` — the three files using
  `createTestRenderer`. **W2.**
- `packages/arbor-tui/src/default-catalog.ts:184–213` — destructive actions and their confirmation
  copy. **W4.**

Dependency (read-only, in `node_modules`): `@opentui/core/renderer.d.ts`,
`renderer-theme-mode.d.ts`, `testing.d.ts`.

Prior roadmaps: **21 §W5** (approval binds to a canonical action fingerprint) — W5 here is its UI
half. **21 §W3** (observer independence) — bears on §9.3.

---

## §2 The three convergences

A convergence is the same structural answer reached independently by systems with no shared
authorship. These are weighted highest because neither party could have derived the other's
motivation.

### C1 — Notify on absence, not on completion

Three harnesses, three mechanisms, one contract:

| System | Presence signal | Gate |
|---|---|---|
| Claude Code 0.2.8 | stdin `data` activity, 6s threshold | notify only if no recent interaction; clock **reset when the wait begins**, so a long op finishing under the operator's eye stays silent; latched to fire once |
| Codex 0.147.0 | terminal focus reporting | `tui.notifications.notification_condition = "unfocused" \| "always"`, with `notification_method` an independent axis (`auto`/`osc9`/bel) |
| OpenCode | CSI DECSET 1004 focus/blur → `FocusState = "unknown" \| "focused" \| "blurred"` | default: suppress desktop notification unless blurred |

Note the shape all three share: **mechanism and condition are separate axes.** Codex makes this
explicit as two config keys. → **W1**

### C2 — Destructive confirmation by repeat, with the pending state visible

- Claude Code: `useDoublePress`, 2000ms window, drives a `pending` flag so the UI can render
  "press again"; guards against triple-press re-triggering.
- OpenCode: `escape` → interrupt. First press sets a 5s counter and **flips the footer hint** from
  `esc interrupt` to `esc again to interrupt`, highlighted. Only the second press aborts. And on
  abort, the affected part is annotated `· interrupted` and **left in place** — partial output is
  preserved, not discarded.

Two independent implementations, same three properties: a window, a *visible* pending state, and
auto-clear. → **W4**

### C3 — Approval memory has tiers, and the top tier is refused when the action can't be canonicalized

| System | Tiers |
|---|---|
| Claude Code 0.2.8 | none / "don't ask again for `<prefix>` in `<cwd>`" — and **suppressed entirely** for unsafe compound commands or suspected injection |
| Codex | `accept` / `acceptForSession` (in-memory, session-scoped) / `acceptWithExecpolicyAmendment` \| `applyNetworkPolicyAmendment` (config-persisted) |
| OpenCode | instance-memory "always" (dies on restart, UI says so literally) / config-file rule (persists) / TUI-local auto-approve toggle (per-client) |

Claude Code's refusal rule is the sharpest: *if you cannot canonicalize the action, do not offer to
remember it.* That is roadmap 21 §W5's CAVA-derived requirement — approval must bind to a canonical
action fingerprint — arrived at independently at the UI layer. → **W5**

---

## §W1 — Wire the substrate: capabilities, focus, notification, theme

**Grounding:** C1, plus §0's verification table.

**Verified gap:** revoy2's notification ring is **in-app only**. It is seen only by an operator
already looking at the TUI. revoy2's campaigns are long-horizon and roadmap 07 adds cron
scheduling — the entire premise of long-horizon autonomy is that the operator walks away.

**Change:**

1. Subscribe to the renderer's `FOCUS` event; hold a tri-state `"unknown" | "focused" | "blurred"`.
   **Tri-state, not boolean** — before the first focus event arrives you do not know, and OpenCode
   models exactly this. Defaulting unknown→focused suppresses the first notification of a session,
   which is the one most likely to matter.
2. Route existing notification-band entries above a severity threshold through
   `renderer.triggerNotification(message, title?)` **when focus is `blurred`**. Two independent
   config axes, per Codex: *mechanism* (`off | terminal`) and *condition* (`unfocused | always`).
3. **`triggerNotification` returns `boolean`** — it reports whether it actually emitted. Record
   that result. A notification the terminal silently dropped is exactly the "documented but not
   wired" failure the repo doctrine warns about; a `false` return must be visible, not swallowed.
4. Read `renderer.capabilities` at startup and put it in the ledger — this is the input to W3's
   terminal section and costs nothing once the renderer is up.
5. `waitForThemeMode(timeoutMs)` with an explicit default on timeout (OpenCode uses 1s → `"dark"`).

**Deliberately not doing:** shelling out to `notify-send`/`osascript`. Codex's binary contains no
OS-notifier integration at all — only terminal escapes — and OpenCode's only `osascript` calls are
unrelated clipboard fallback. Terminal-native degrades gracefully; a spawned notifier does not.

**Test:** focus `blurred` + severity above threshold → `triggerNotification` called; `focused` →
not called; `unknown` → not called; a `false` return is recorded, not discarded.

---

## §W2 — Send keys through the real renderer

**Grounding:** arXiv 2608.03743 (197 apps; 12% of test code exercises the interface; 45% of those
never send input) — read in full. **Scope caveat the paper's own benchmark imposes:** it covers
ratatui/bubbletea/textual/ink. **opentui is not in it.** The 12%/45% baseline does not include our
substrate.

**Verified state, and a correction to this roadmap's first draft.** revoy2 uses
`createTestRenderer` in three files and *is* in the 12% that exercise the interface. One test
delivers a real synthetic mouse click through opentui's native input pipeline → real stdin parsing
→ the real per-Renderable hit-grid (the ADR-037 capability proof, and genuinely rigorous). But
**no test sends keys through the real renderer** — `createMockKeys` appears nowhere. The 47 TUI
test files exercise the input *model* as pure functions (`keyboard`, `input-terminal`,
`input-catalog`) and separately exercise *rendering*. The two are never joined. So: in the 12% on
interface exercise, partially in the 45% on "checks a static frame." The first draft's "revoy2 is
in the 12%, not the 88%" was too flattering.

**Change — deliberately narrow.** OpenCode's own ratio is the guide: 39 of its 51 test files are <!-- sur-05:historical (count is OpenCode's repo, not revoy2's) -->
pure logic with no renderer at all, and only ~4–5 do synthetic-input interaction testing. Do not
chase coverage. Add exactly two kinds:

1. **Keybind dispatch through the real keymap path** using `mock-keys` — this catches rebinding and
   catalog-drift regressions that no unit test of a handler function can.
2. **One snapshot test** via `test-recorder` for the most layout-fragile widget.

**Do not treat line coverage as the target.** The paper's most transferable finding is that **line
coverage poorly predicts crash discovery**, which weakens it as a proxy for test effectiveness —
a direct caution about revoy2's own coverage-based gates. Its other under-reported finding: no LLM
dominated random exploration, and *automatically deriving launch inputs* produced the largest
practical gain, because many apps never start under test at all.

---

## §W3 — `doctor`: environment, terminal, and **ledger/store reconciliation**

**Grounding:** Codex 0.147.0, observed directly. The single best design document in the corpus.

**Verified gap:** revoy2's `diagnostics.ts` renders a bounded event/trace timeline from
`event.resume`. It is not an installation, environment, or store health check. Different concern
entirely.

**Change — the reconciliation half is the valuable half; build it first.**

1. **Store reconciliation with named mismatch classes.** Codex reconciles rollout files against its
   state DB and reports each divergence by name: stale rows, archive mismatches, duplicate thread
   ids, duplicate DB paths, malformed file names, missing rows, scan cap reached — plus a verdict
   line ("inventory agree"), storage accounting, and **source attribution**
   (`subagent:thread_spawn=133, cli=46, exec=2`). revoy2 has a hash-chained ledger and persisted
   campaigns and nothing that reconciles them against each other. Every mismatch class must be
   **typed and named**, never a prose blob — this is roadmap 21 §W1's lesson applied here before it
   is made.
2. **Environment/terminal section** — fed by W1's `capabilities`. Report the *decision and its
   reason* the way Codex does: `color output: disabled (stdout is not a terminal)`, not just a flag.
   Include per-stream `isTTY` (all three separately), multiplexer, and whether focus reporting is
   available — that last one determines whether W1's gate can work at all.
3. Auth/config sections report **booleans for what is stored**, never values.

**Test:** a deliberately corrupted store produces the correctly-named mismatch class, and a clean
store produces the agreement verdict.

---

## §W4 — Double-press confirm, and interruption preserves partial output

**Grounding:** C2.

**Verified state:** revoy2 confirms destructive actions (prune, cancel/interrupt, abandon recovery,
halt campaign) through a modal `confirmation` overlay, mutually exclusive with `compose`. That is
*right* for prune and halt — explicit, and it can show what is at stake. It is heavy for interrupt,
which is frequent and time-critical.

**Change:**

1. Double-press for **interrupt/cancel only**; keep the modal for prune, abandon, and halt. Window,
   visible pending state in the status bar, auto-clear. Do not re-trigger on a third press.
2. **On interrupt, annotate the affected node rather than discarding its partial result.** OpenCode
   leaves the part in place marked `· interrupted`. For revoy2 this is stronger than a UI nicety:
   a discarded partial expansion is an unwitnessed record, and the ledger is supposed to be
   authority. Check whether interruption currently drops anything.

**Test:** one press arms and renders the hint; two within the window interrupt; three do not
double-fire; the window expires and disarms; an interrupted node retains its partial evidence.

---

## §W5 — Tiered approval memory *(the UI half of roadmap 21 §W5)*

**Grounding:** C3. Roadmap 21 §W5 established that approval must bind to a canonical action
fingerprint. This is its rendering.

**Change:**

1. Three explicit scopes, **labelled with their durability in the option text itself** — OpenCode's
   copy literally says "until OpenCode is restarted." An operator must not have to guess whether a
   grant survives a restart.
2. **Suppress the persistent option when the action cannot be canonicalized.** This is the rule to
   take verbatim. It is the same requirement as 21 §W5's fingerprint binding, enforced where the
   operator can see it: if we cannot compute a stable fingerprint, we must not offer to remember.
3. Render approval requests **per action class**, not through one generic prompt. Claude Code
   0.2.8 ships specialised requests for bash / file-edit / file-write / filesystem with a typed
   fallback; OpenCode branches on `edit` (inline diff) / `bash` (`$ cmd`) / `webfetch` / `task` /
   `external_directory`. An operator approving a file write and an operator approving a network
   egress need to see different things.
4. **Decide the reject-cascade question deliberately.** OpenCode's rejection force-fails *every
   other pending request in the session*, not just the one clicked. That is a sharp edge worth
   choosing explicitly rather than inheriting by accident.

**Keep what revoy2 already does better.** The approvals screen structurally never offers
self-approval, because the backend forbids a proposer deciding their own request and the UI does
not render affordances the capability does not support. Neither reference has an equivalent. Do
not regress it.

---

## §W6 — Two small, self-contained wins

- **Frecency** for recall lists: `frequency / (1 + days_since_last_use)`, ~30 lines, observed in
  OpenCode for file-picker ranking. Applies to recent campaigns, nodes, worktrees. Note OpenCode
  does *not* apply it to session ordering — that stays `time.updated` desc. Copy the scoping
  decision, not just the formula.
- **Crash boundary**: full-screen replacement (not a stacked dialog), length-budgeted truncated
  stack trace, copy-as-issue / restart / quit. Check whether revoy2 has a top-level handler at all.

---

## §W7 — Thresholded budget surfacing with the remedy named *(novel — see §0)*

**Grounding:** Claude Code 0.2.8 only. **Absent in OpenCode** (verified by the agent's exhaustive
negative grep) and absent in Codex's TUI as far as the vivisection reached.

**Verified gap:** `screens/native-budget.ts` renders "Tokens remaining"/"Cost remaining" as table
fields. No thresholds, no warning state, no remedy. The status bar's `formatBudget` is
scrupulous — it refuses to print `$0` for unpriced rows because an unpriced row "must never be
counted as a real zero" — and it will not tell you the budget is running out or what to do.
**Epistemically impeccable and operationally mute.**

**Change, three properties, all from the 0.2.8 contract:**

1. **Silent until it matters.** Render nothing below the warning threshold. A persistent gauge
   trains the eye to ignore it.
2. **Headroom remaining, not consumption.** "34% remaining" beats "66% used" for a decision.
3. **The remedy is named in the same string.** *A warning that does not name its remedy is an
   interruption without a payoff.*

Plus the safety detail worth stealing: 0.2.8 sets the ceiling shown to the operator **below** the
real limit, reserving headroom to execute the remedy. Do not let the operator run out of room to
run the fix.

**Do not adopt OpenCode's answer** (silent automatic remediation with no warning). For a harness
whose doctrine is "no unwitnessed record," silently compacting under an operator is the wrong shape
even though it is what the largest reference does.

---

## §W8 — A **scoped** model-input transparency dump

**Grounding:** `codex debug prompt-input`, observed. It renders the literal structured message array
the model will receive — system instructions, skill inventory, permission contract, environment.

This matches revoy2's own idiom exactly: *structured is authority, rendered is projection.* A
command that dumps what a node's expansion prompt actually contains turns "trust the projection"
into "verify the projection against the real input."

**The named anti-pattern, and the reason this item carries a constraint.** Codex's dump includes
**every previously-approved command prefix on the machine, verbatim, from unrelated projects**, in
every fresh session's prompt. The surface that makes prompts auditable becomes the surface that
exfiltrates accumulated state.

**Change:** build the dump, and scope it — campaign-local, with cross-campaign approval state
excluded or redacted by construction. Apply the same structural-redaction discipline
`worktree-machine-verifier.ts:129` already applies to argv.

---

## §7 Don't-build decisions

| Candidate | Source | Reason |
|---|---|---|
| OS-notifier integration (`notify-send`/`osascript`/D-Bus) | — | Neither Codex nor OpenCode does it. Terminal-native degrades gracefully; a spawned notifier does not. §W1 covers it. |
| Silent auto-compaction on overflow | OpenCode | Contradicts "no unwitnessed record." §W7 takes the opposite branch deliberately. |
| N dynamically-registered palette commands for large catalogs | OpenCode (refuted premise, §9.1) | The proxy-command → sub-dialog → insertion pattern is cheaper and scales; relevant to task-composer and capabilities screens. |
| `@opentui/solid` reactive layer | OpenCode | Real and mature, but replacing revoy2's structured-scene rendering is an architecture change, not an ergonomics one. Out of scope; worth its own ADR if ever considered. |
| Virtual pet | Codex | Noted for completeness. No. |

---

## §8 Evidence grades

| Item | Source | Grade |
|---|---|---|
| opentui 0.5.1 API surface (`triggerNotification` signature, `capabilities`, `FOCUS`, `waitForThemeMode`, testing module) | Read directly from `node_modules` | **Verified** — highest confidence in this document |
| Codex protocol types (`ApprovalsReviewer`, `CommandExecutionApprovalDecision`, `GuardianRiskLevel`, `TurnSteerParams`) | `generate-ts`, 723 files; **4/4 spot-checked verbatim by me**, incl. the `[UNSTABLE]` marker; `ApprovalsReviewer` independently confirmed in binary strings | **Verified** |
| `codex doctor` output | Run directly | **Verified** |
| Codex `notification_method` / `notification_condition` enum values | Binary strings only; `osc9` confirmed present, `bel` inferred from a module name | **Medium** — the two-axis *shape* is solid, exact variant list is not |
| OpenCode findings | Agent read source at a pinned commit with file:line citations; I did not re-read the clone | **Medium-high** — internally consistent, precise citations, honest empties. Not independently re-read. |
| Claude Code 0.2.8 behavioral contracts | Read directly by me | **Verified for 0.2.8** — but 0.2.8 is an early research preview and says nothing about current Claude Code |
| arXiv 2608.03743 (TUI testing) | Read in full | **High** — 197-app survey; scope caveat: opentui not in benchmark |
| Frontier literature generally | 24 surfaced, 10 pulled | **Low relevance** — see §10 |

---

## §9 Refuted and downgraded on verification

**§9.1 — "OpenCode exposes skills as palette commands" is false.** This premise came from the
frontier sweep, was repeated in `harness-parity-matrix.md` row 5, and was written into the brief
the OpenCode agent was given. It found the opposite: there is exactly **one** palette command
(`/skills`) which opens a sub-picker that inserts literal `/<skill> ` text into the prompt.
`grep -rn "registerCommand" packages/tui/src` → zero hits. Individual skills are never registered
as commands. **Action: amend the parity matrix.** The real pattern is better than the imagined one
and §7 records it as the recommendation.

**§9.2 — The `<diff>` transplant is downgraded to a from-scratch build.** The OpenCode agent
identified a first-class `<diff>` renderable with typed props (split/unified, filetype, line
numbers, themed added/removed colors) and ranked it a transplant. Verified: **there is no diff
module anywhere in `@opentui/core@0.5.1`'s type surface.** It is a `@opentui/solid` primitive, and
revoy2 does not use `@opentui/solid`. OpenCode's prop shape remains useful as a *spec* — including
the width-threshold auto-select between split and unified — but this is a build, not a wiring job.
Not scheduled here.

**§9.3 — Guardian auto-review: prototype only, do not ship.** Codex's
`ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent"` routes approvals to a
differently-prompted sub-agent producing typed `riskLevel` / `userAuthorization` / `rationale`.
This is exactly the **observer independence** roadmap 21 §W3 identified as the load-bearing
property of a verification loop. It is also the thing nobody has measured, and OpenAI marks the
types `[UNSTABLE]` themselves. Roadmap 21 §W3 must produce revoy2's own `(c, r, f, b)` before this
is worth building. Prototype behind an eval lane.

**§9.4 — Rejection-carries-redirect is a design fork, not a best practice.** Claude Code 0.2.8
folds redirect into rejection ("No, and tell Claude what to do differently"). Codex separates them:
`decline`/`cancel` are bare enum values with **no payload for operator commentary**, and steering is
a distinct `turn/steer` RPC guarded by an `expectedTurnId` precondition, refused during `review`
and `compact` turns with a typed `activeTurnNotSteerable` error. revoy2 already has CAS /
expected-version semantics in its thread contract, so Codex's shape fits better. Recorded rather
than resolved.

---

## §10 Empty findings

**From the literature sweep** — these are absences in the *published record*, re-queried with
varied vocabulary before being recorded:

- Diff-review UX and reviewer fatigue **for coding agents**: no literature.
- Streaming-output latency perception for agent output: no literature (arXiv "streaming" hits are
  video/ML).
- Multi-agent fan-out visualization: no literature (hits are MARL/robotics swarms).
- Token/cost dashboard UX: no literature.
- **TUI screen-reader accessibility: no literature at all.** arXiv 2608.03743 explains why it and
  TUI testing are the same problem — a TUI "exposes neither [addressable objects nor an
  accessibility tree], presenting only a character grid rendered into a pseudo-terminal driven by a
  raw byte stream."

**Conclusion: on this topic the RE corpus outperforms the literature, and it is not close.** Roughly
two hours of `--help` and `doctor` against a locally-installed Apache-2.0 binary produced more
transferable contract than 24 surfaced papers.

**From the RE corpus** — absent even in the mature references, which is what makes §W7 and these
Tier-2 items novel rather than catch-up:

- **User idle/inactivity detection**: absent in OpenCode (exhaustive grep; every `idle` hit is
  agent-busy status). Absent in Codex beyond focus events.
- **Terminal capability *gating*** (degraded rendering, COLORTERM/SSH-aware fallback): absent in
  OpenCode's application code. Its only capability probe is the opentui-delegated palette query.
- **Cost/context thresholds + inline remedy**: absent in OpenCode (§0).

**A gap in our own corpus, now closed — with a durable artifact, not just a note.** Every
clean-room doc described Codex as "Apache-2.0; treated as black-box," while the parity matrix
called it a *"deep TUI"* and the outright leader on OS sandboxing. We had done deep RE on
proprietary, all-rights-reserved Claude Code **0.2.8** and left the permissively-licensed,
locally-installed, self-introspecting target unexamined.

Closed by **`../research/codex-clean-room-reference-2026-08-12.md`** — a full behavioral reference
with ten adopted constraints and five explicit non-adoptions, in the house style of
`audit/codex-a2a-messaging-reference.md`. The two docs asserting black-box status
(`reference-harness-clean-room-spec.md:14`, `default-native-executor-research-2026-08-09.md:13`)
are amended to point at it.

Three findings from that pass bear on roadmaps outside this one and are recorded there rather than
duplicated here:

- **Capability registries want stage and effective state as *independent* axes.** Codex's registry
  has 104 features across five stages, and **8 are `removed` yet still effectively `true`** — a
  state `RUNTIME_CATALOG`'s `supported: boolean` + prose `unavailable_reason` cannot express.
- **`codex remote-control pair` issues a short-lived out-of-band pairing code** (`--json`), and the
  TUI takes its bearer token by environment-variable *name*, never by value on a command line.
  That is roadmap **10**'s `consent_required` problem with a shipped answer.
- **`codex fork`** branches a prior session as an operator verb. revoy2 branches internally via UCT
  and exposes no equivalent.

**The same pass was then run against current Claude Code (2.1.228)** —
`../research/claude-code-clean-room-reference-2026-08-12.md` — because the vendored sourcemap is
**0.2.8**, an early research preview, and the corpus had nothing both deep and current. Scoped to
self-description surfaces only, with **no `strings` or decompilation**: Codex is Apache-2.0 and
Claude Code is all-rights-reserved, so the stopping point differs by license, not by difficulty.
Four findings bear on items in this roadmap and on others:

- **`--safe-mode` / `--bare`** — graded stand-down modes that disable accreted customization while
  **leaving governance, auth, and permissions fully in force**. revoy2 has an accreting
  customization surface (roadmaps 02, 06, 11, ADR-038) and no way to stand it down and still run.
  The sharpest missing affordance found in either pass.
- **`auto-mode`** — printable *effective* policy, printable shipped defaults, an AI **critique** of
  your own rules, and reset. Three tiers (`allow` 17 / `soft_deny` 65 / `hard_deny` 1), where a
  soft deny clears only on consent that **names the specific operation and target**, and where
  another agent's message, a scheduled firing, a problem report, and an agent-chosen target are all
  explicitly incapable of supplying consent. The scheduled-firing exclusion is load-bearing for
  roadmap **07**: a cron-fired campaign must not approve its own escalations.
- **`--ax-screen-reader`** — flat text, no decorative borders or animations. §10 records TUI
  screen-reader accessibility as a *total* literature empty finding; practice is ahead of
  publication, and revoy2 has no equivalent.
- **`claude doctor` is markedly shallower than `codex doctor`**, and its deep checkup is
  session-only — unavailable headless, which is where it would pay. **§W3 follows Codex's shape
  deliberately**, on evidence, from the deeper of the two references.

**The generalizable technique, and the reason this was cheap:** *ask the binary about itself*
(`--help`, `doctor`, `features list`, `debug prompt-input`, `app-server generate-ts`) before
reaching for decompilation. Five self-description surfaces yielded more transferable contract than
the deep source-level pass previously done on a proprietary competitor — at a fraction of the
effort and with a cleaner licensing posture. For Codex specifically the clean-room boundary is
*structurally* enforced: the shipped artifact is a stripped static-pie ELF, so there was no
expression available to be tainted by.

---

## §11 Cautions carried forward

- **Claude Code 0.2.8 is an early research preview under proprietary, all-rights-reserved terms.**
  Every contract taken from it in this roadmap is a behavioral spec written to be implemented
  without reference to that tree, in the same posture `arbor-gate/src/gate.ts` already documents.
  It evidences what problems were solved in 0.2.8 — nothing about current Claude Code.
- **Notification is an attention budget, not a feature.** Roadmap 21 §11 carries the
  reviewer-fatigue finding: a guard that escalates more is not automatically safer, because past
  the reviewer's capacity the extra escalations spend the attention the dangerous action will need.
  W1 makes revoy2 able to interrupt an absent operator. That capacity must be spent deliberately —
  severity-thresholded from the start, never "notify on every campaign event."
- **Availability is not detection is not interpretation.** The Dagstuhl oversight framework
  (2605.16278, roadmap 21 §11) separates the three preconditions for monitoring. revoy2's ledger
  maximises *availability*. W1 and W7 are the first items in this repo that address *detection*.
  Neither addresses interpretation, and no item here should be described as improving oversight
  quality — only its reachability.

---

## §12 Ordering

1. **W1** — wire capabilities, focus, notification, theme. A day. Closes the presence gap outright
   and produces W3's terminal inputs for free.
2. **W2** — keybind dispatch via `mock-keys` + one `test-recorder` snapshot. Narrow by design.
3. **W3** — `doctor`, **reconciliation half first**; the environment half depends on W1.
4. **W4** — double-press for interrupt, and check whether interruption discards partial evidence.
   That check may be a defect report rather than a feature.
5. **W5** — tiered approval memory. Composes with roadmap 21 §W5; do that one first or together.
6. **W6** — frecency, crash boundary. Any time; independent.
7. **W7** — thresholded budget with remedy. **Explicitly novel work (§0); do not justify as parity.**
8. **W8** — scoped transparency dump. Last, because the scoping constraint is the hard part.

W1 and W2 together are roughly two days and are almost entirely deletion of the phrase "revoy2
doesn't have that" from future briefs.

---

## §13 Handoff note

Write `docs/roadmaps/handoffs/22-operator-ergonomics.md` recording:

1. Whether `renderer.capabilities` and the `FOCUS` event behave as the type surface implies **under
   tmux and over SSH** — both are live in this repo's actual operating environment, and both are
   where terminal features usually break.
2. What fraction of `triggerNotification` calls return `false` in real use. A silently-dropped
   notification is worse than none.
3. **Whether interruption currently discards partial node evidence** (W4.2). If it does, that is a
   ledger-integrity defect, not an ergonomics gap, and should be raised as such.
4. The reject-cascade decision (W5.4) with its reasoning.
5. Any parity-matrix amendments made under §9.1.
6. Whether revoy2 has a top-level crash handler (W6).
