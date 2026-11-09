# TUI Overhaul: Gate/Hook Governance Inventory (M0.2)

The brief claims an "existing 17-gate/hook governance system." This document
inventories every runtime process gate, native hook event, and dev-governance
script gate found in source on branch `feat/tui-overhaul` (base `ebf63cc1`),
with the exact command used for every count. **No current set in this repo
has 17 members.** See §5.

All counts below are **measured** (a command was run this session and its
output recorded) unless marked otherwise.

## 1. Runtime ADR-006 process gates (`packages/arbor-gate/src/gate.ts`)

Header: "arbor-gate — Process gates wrapping the tree-search loop. Clean-room
from revoy-spec's `process_gate.v1` (ADR-086) concept" (`gate.ts:1-3`).
There are **4 core gate checkers** plus **3 harness-lifecycle checkers** that
reuse the same `GateResult` shape:

| Gate/checker | Function | Line | Applicability | Outcomes | Fail-open/closed |
|---|---|---|---|---|---|
| admission | `checkAdmission` | `gate.ts:60` | Before a campaign starts | pass / fail | fail-closed: any of `plan_reviewed`/`resources_available`/`config_valid` false → fail |
| isolation | `checkIsolation` | `gate.ts:72` | Before a Specialist expansion | pass / fail | fail-closed: worktree not isolated, wrong starting commit, or no lease → fail |
| evidence | `checkEvidence` | `gate.ts:85` | After Critic approval, before node verification | pass / fail | fail-closed for `verified` tag (requires exit 0 + non-empty `stdout_hash`; a `promoted_claim` must be contained in `evidence_text` via `containmentFailures`, `gate.ts:119`). A `null` `provenance_tag` is recorded as `unresolved`, which still yields `result: "fail"` (`makeResult`, `gate.ts:243`) |
| audit | `checkAudit` | `gate.ts:143` | After campaign halt | pass / fail | fail-closed: `auditor_agrees` false → fail |
| fold activation | `checkFoldActivation` | `gate.ts:151` | Context-fold proposal review | pass / fail (tagged `"evidence"`) | fail-closed: self-approval, missing source events/message ranges/retained claims, non-content-addressed omitted artifacts, negative token savings, or `fidelity_ratio < 1` all fail |
| harness activation | `checkHarnessActivation` | `gate.ts:164` | Harness-revision proposal | pass / fail (tagged `"audit"`) | fail-closed: forbidden component, self-approval, no source events, no expiry |
| harness promotion | `checkHarnessPromotion` | `gate.ts:174` | Cross-campaign harness promotion | pass / fail (tagged `"audit"`) | fail-closed: requires named human approver distinct from proposer/activator, prior activation, measured improvement, replay evidence, holdout evidence, and no detected regression |

A third outcome, **`bypass`**, exists structurally (`bypassGate()`,
`gate.ts:215`) for "a gate that couldn't fail closed" — it records a
`bypass_evidence_deficit` string for later resolution rather than silently
passing. `attachGateRecord()` (`gate.ts:230`) appends every `GateResult` onto
`node.gate_records`, so gate history is durable per tree node.
**source-confirmed** (`packages/arbor-gate/src/gate.ts`, full file read).

No explicit timeout mechanism exists in `gate.ts` itself — these are pure,
synchronous functions over already-collected evidence, not live process
calls with a wall-clock bound. **source-confirmed (absence)**.

## 2. ADR-111 native hook bus (`packages/arbor-mcp/src/hooks/{contracts,bus,catalog,handlers}.ts`)

### 2.1 Event taxonomy (`hooks/contracts.ts`)

| Kind | Events | Count | Citation |
|---|---|---|---|
| veto | `tool_preflight` | 1 | `contracts.ts:42` |
| observe | `tool_audit`, `tool_write`, `phase`, `ledger_transition`, `user_prompt_submit`, `pre_compact`, `notification`, `turn_end` | 8 | `contracts.ts:50` |
| lifecycle | `session_start`, `session_end`, `node_start`, `node_end`, `plan_confirm`, `interruption` | 6 | `contracts.ts:51` |

Total declared hook events: **15** (`HOOK_ALL_EVENTS`, `contracts.ts:64`).
Of the 6 lifecycle events, only `session_start` may deny
(`HOOK_LIFECYCLE_VETO_EVENT = "session_start"`, `contracts.ts:67`); the other
5 are structurally observe-only — binding a deny-capable handler to them is
rejected at catalog load (`catalog.ts:199-201`, `hook_escalation` error).
Default timeout: `HOOK_DEFAULT_TIMEOUT_MS = 50` ms (`contracts.ts:38`).
Bounds: `HOOK_MAX_DESCRIPTORS = 64`, `HOOK_MAX_DESCRIPTOR_BYTES = 8KiB`,
`HOOK_MAX_LEDGER_ENTRIES = 500` (`contracts.ts:24-29`). **source-confirmed**

### 2.2 Dispatch semantics (`hooks/bus.ts`)

Header (`bus.ts:22-27`): **"Fail-closed: a veto (or lifecycle-start) handler
that throws, exceeds its wall-clock bound, or returns an invalid decision
denies the action and is attributed to the firing hook by id. An observe
handler that throws is dropped and logged; the action it observed already
happened and proceeds unaffected."**

| Surface | Method | Line | Lifecycle phase | Outcomes | Timeout behavior | Failure handling |
|---|---|---|---|---|---|---|
| veto (tool_preflight) | `wrapToolPort` | `bus.ts:123` | Before a native tool call executes | allow / deny / error | bounded by `runBounded` (default 50ms, `timeoutMs`) | **fail-closed** — throw/timeout/invalid decision → deny, attributed to the hook |
| observe (tool_audit) | `wrapToolPortWithAudit` / `observeToolAudit` | `bus.ts:143,203` | After tool execution completes | observed / error | bounded | **fail-open for the observed action** — an observe handler error is "dropped and logged," the already-completed action is unaffected |
| observe (ledger_transition, phase) | `observeLedgerTransition`, `observePhase` | `bus.ts:210,215` | Session ledger events / campaign phase transitions | observed / error | bounded | same fail-open-for-action semantics as tool_audit |
| lifecycle (session_start, veto-capable) | `lifecycleSessionStart` | `bus.ts:245` | Session admission | allowed / denied / error(→denied) | bounded | **fail-closed** — same as tool_preflight veto |
| lifecycle (all others, observe-only) | `lifecycleObserve` | `bus.ts:283` | session_end, node_start, node_end, plan_confirm, interruption | observed / error | bounded | fail-open for the action; error only logged |

Composition guarantee: `wrapToolPort`'s doc comment states the effective
decision is `base_allow AND ⋀(hook.decide)` — "intersection only, so
`effective_allow ⟹ base_allow` holds by construction: a hook can flip an
allow to a deny, never the reverse" (`bus.ts:8-11`). **source-confirmed**

Every firing writes one bounded, redacted `HookFiredRecord` to the bus's own
ledger regardless of outcome (`bus.ts:26-27`, `ledger()` at `bus.ts:105`);
`neverFired()` (`bus.ts:108`) surfaces declared-but-unfired hooks — "the
ADR-032 failure mode, surfaced instead of reproduced."

**Critical gap found in source, not asserted by the brief:** the doc comment
on `lifecycleSessionStart` states plainly: *"This method is complete and
independently tested, but at HEAD it is not wired into a live session-admission
gate — see the handoff note for why (no existing composition seam can refuse
a session prospectively...)"* (`bus.ts:238-241`). This is a documented,
in-code admission that the one lifecycle hook capable of denying a session
**does not currently gate anything live**. **source-confirmed** — this is the
single most important finding of this inventory: a safeguard that exists,
passes its own tests, and is *documented as unwired*.

### 2.3 Catalog / default hook set (`hooks/catalog.ts`)

Two default hooks are seeded: `plan-confirm-notifier` (lifecycle,
`plan_confirm`, handler `lifecycle.session-boundary-notes`) and
`tool-execute-audit-log` (observe, `tool_audit`, handler
`observe.tool-audit-notes`) — `catalog.ts:38-49`. Both are documented as
"neither can deny or mutate anything" (`catalog.ts:36`). "Reduction at load"
(`catalog.ts:157-159`) rejects any descriptor whose kind/event/handler
combination exceeds what its declared `kind` permits, before it can ever be
dispatched — e.g. a plugin-supplied veto or session-start-deny hook requires
plugin tier `T4` (`catalog.ts:200,213`). **source-confirmed**

## 3. Repo dev-governance battery (`scripts/gate-all.mjs`, `gate-manifest.json`, `execution-profile.json`, `.claude/settings.json`)

### 3.1 Per-tier summary (measured live against this checkout)

Command run: `bun run scripts/gate-all.mjs --list --json` (output was tab-separated `tier\tgate-name` lines; despite `--json` the CLI printed the same list form — see raw output). Total lines returned: **59**.

```
stop: 41
fast: 8
full: 10
-----
total: 59
```

Cross-checked against `scripts/execution-profile.json` gate declarations
(command: `node -e "console.log(Object.keys(require('./scripts/execution-profile.json').gates).length)"` → **60**, which includes `gate:all` itself — `gate-all.mjs:129-133` explicitly filters `gate:all` out of `GATE_TIERS`, so 60 − 1 = **59**, matching the `--list` count exactly). Also cross-checked: `grep -c '"cost_class": "stop"' scripts/execution-profile.json` → **41**, matching. `node -e "console.log(Object.keys(require('./scripts/gate-manifest.json').gates).length)"` → **59** (this file also excludes `gate:all` implicitly, matching the roster). `grep -c '"gate:' package.json` → **60** (includes `gate:all` as a runnable script). All four independent counts agree once `gate:all` is accounted for: **59 real gates, tiered 41/8/10 (stop/fast/full)**.

Tiers are cumulative: `--tier fast` runs stop ∪ fast; `--tier full`/`all` runs everything (`gate-all.mjs:12`).

### 3.2 Full gate list by tier

**stop (41):** gate:adr-acceptance-staged, gate:adr-citations,
gate:adr-decision-followthrough, gate:adr-registry,
gate:adr-retirement-integrity, gate:adr-sections, gate:adr-trace,
gate:anti-stub:blocking, gate:audit-disposition, gate:branch-accounting,
gate:claim-ledger-precommit, gate:closed-enum-hygiene,
gate:completion-depth, gate:decision-queue, gate:decisions-precommit,
gate:entrypoint-reachability, gate:execution-profile,
gate:finalization-progress, gate:governance-counts, gate:hook-liveness,
gate:interview-attestation, gate:language-census, gate:ledger-audit,
gate:lockfile, gate:merge-critical-check, gate:obligations,
gate:organization-enrollment, gate:package-boundaries,
gate:project-conform, gate:project-registry, gate:registration-integrity,
gate:remedy-coverage, gate:reuse-compliance, gate:stop-budget,
gate:stop-guard-releases, gate:store-freshness, gate:tui-catalog-parity,
gate:vi-findings, gate:vi-freshness, gate:vi-vendor, gate:worktree-hygiene.

**fast (8, additive to stop):** gate:adr-status, gate:anti-stub,
gate:claim-ledger, gate:docs-truth, gate:eval-regression, gate:gap-status,
gate:liveness, gate:reachability.

**full (10, additive to fast):** gate:campaign-run-status, gate:coverage,
gate:determinism, gate:evidence-transaction-observability,
gate:hollow-parity, gate:opentui, gate:projection-lifecycle,
gate:typecheck-tests, gate:vi-prepush-policy, gate:vi-reproducible.

(This is the literal roster returned by `--list`; **measured**, not
hand-curated.)

### 3.3 `.claude/settings.json` hook registrations

Command: `node -e "const s=require('./.claude/settings.json'); let n=0; for (const v of Object.values(s.hooks)) for (const g of v) n += (g.hooks||[]).length; console.log(n)"` → **0** total command registrations. The five rows this table used to carry (13 registrations) were the host-hook surface before the devolution programme; each of the deleted scripts now has a native handler behind a descriptor in `DEFAULT_HOOK_SET`, activated by `HookBus` rather than by a shell command, so it is not counted here.

| Event | # hooks | Representative hook |
|---|---|---|
| SessionStart | 0 | none on the host — `scripts/hooks/session-close-start.sh` and the Codex lifecycle adapter were devolved to the native `inject.repo-session-open` handler behind the `repo-session-open` descriptor, which fires on revoy2's own `session_start` rather than the host's |
| PreToolUse | 0 | none — the three host guards (claim completeness, VI read-only, git-write) are native vetoes on `tool_preflight` |
| PostToolUse | 0 | none on the host — `scripts/hooks/evidence-staleness-nudge.sh` was devolved to the native `inject.evidence-staleness` handler behind the `evidence-staleness` descriptor, on the per-turn `turn_end` **inject** lane. It is the last registration this programme removed, and the inject lane is what let it keep its product: its whole output was model-facing `additionalContext`, which a ledger note is not |
| Stop | 0 (host) / 1 (native) | none on the host — `scripts/hooks/gate-stop.sh` was devolved to the native `observe.stop-battery` handler behind the `stop-battery` descriptor |
| SessionEnd | 0 | none on the host — `scripts/hooks/session-close-end.sh` was devolved to the native `lifecycle.repo-session-end` handler behind the `repo-session-end` descriptor, which records the end and can never close |

`.claude/settings.json` now carries no hook registrations at all, so the
`.hook-liveness/wrap.sh` conditional wrapper in `--mode conditional`, logging
to `.hook-liveness/invocations.jsonl`, has no revoy2 hook left to wrap. That
mechanism remains a
**process-level (Claude Code CLI hook) mechanism, distinct from both the
ADR-006 runtime gates and the ADR-111 native hook bus** — it fires on the
operator/agent's tool calls in the editing session, not on runtime campaign
events. **source-confirmed**

ADR-074's end condition — "on 2026-08-15 `gate:typecheck-tests` was found
failing on master... it had simply never been in the battery anyone ran by
hand" — was `scripts/hooks/gate-stop.sh`, a host `Stop` hook running
`gate:all --tier stop`. It is DELETED and devolved to native source
(`packages/arbor-mcp/src/hooks/stop-battery.ts`): the battery is MEASURED out
of band on the `turn_end` boundary and the verdict is CACHED on HEAD oid +
uncommitted dirty-path count + the tier/advisory fingerprint, and the refusal
is the worker's `turn_gate`. This matrix's host-hook count for `Stop` is
therefore 0; the end condition still holds, at the native seam. **source-confirmed**

## 4. Action entry-point matrix

For each entry point: whether it reaches `RuntimeCatalogRouter.dispatchCommand`
(`runtime-catalog.ts:556`), and what gates/hooks it traverses on the way.

| Entry point | Reaches dispatchCommand? | Path | Gates/hooks traversed |
|---|---|---|---|
| Keyboard | Yes | `input-catalog.ts` (`UiAction`) → `update.ts` reducer → `RuntimePortAdapter.command()` (`tui-adapter.ts:144`) → `router.dispatchCommand()` | `denialReason`/`enforceAction` capability check (`runtime-catalog.ts:2938`, `capability.ts:129`); ADR-006 process gates apply downstream inside the runtime, per command kind — **not independently traced per keybinding this pass** |
| Palette | Yes (same mechanism) | Palette items resolve to the same `UiAction`/command dispatch as keyboard — confirmed by `palette` appearing in `input-catalog.ts` alongside the same action model; the actual palette→command wiring line was **not individually traced** this pass | same as keyboard, **unverified in detail** |
| Menu | Hypothesis — no distinct "menu" dispatch path was found separate from palette/keyboard in the files read this session | n/a | **unverified** |
| Slash commands | No TUI-side slash-command dispatch was found; `slash` string hits were in `arbiter-intake.ts`, `opencode-server-executor.ts`, `sandbox/seatbelt-sandbox-broker.ts` — none of which are the TUI input layer | n/a | **"no path exists yet" from the TUI to a slash-command surface** — this needs a maintainer confirmation, tagged **unverified** rather than asserted-absent |
| Delegate spawn | Yes, confirmed | `RuntimeCatalogRouter` case handler at `runtime-catalog.ts:2281` calls `this.runtime.siblingSpawner.spawn(...)` directly inside the dispatch switch — delegate spawn is itself a catalog case, not a caller of the router | Capability check via the same `denialReason` path; worktree isolation via `SiblingSpawner`'s lease acquisition (`sibling-spawner.ts`, compensating rollback on failure) |
| Background job | Yes, confirmed | `job.submit`/`job.cancel`/`job.retry`/`job.pause`/`job.resume`/`job.list` are `RuntimeCommandKind`/query entries (`runtime-catalog.ts:232,389-394`) with case handlers at `:2474,2494,2501,2531,2535,2548` | Same capability gate (`job.write`/`job.read` capabilities declared per entry, `:389-394`) |
| Retry | Yes, confirmed | `job.retry` is one of the above job kinds (`runtime-catalog.ts:2501`); a separate `"retry"` action string also appears at `runtime-catalog.ts:2885` in an `expected_version`/`actor_id` mutation record | same job gate |
| Side agent | Asserted in-source, not independently traced | `native-agent-executor.ts:318` comment: side-agent messaging goes through `RuntimeCatalogRouter` "exactly like `bus.thread.send`"; the executor also accepts an optional `HookBus` (`:29,354`) | **HookBus veto/observe hooks (§2) apply if wired at the tool-port level via `wrapToolPort`/`wrapToolPortWithAudit`; whether native-agent-executor actually wraps its tool port with the bus was not confirmed this pass — unverified** |

## 5. Resolving the "17"

The number traces to **ADR-074** (`decisions/ADR-074-enumerating-gate-battery.md`,
accepted 2026-08-15), which introduced the three-tier battery after finding
gates that were declared but never run in practice (`gate:typecheck-tests`
failing on master with 14 accumulated errors despite being wired and
correct — ADR-074 §1). At acceptance time the repo had **27 total gates**;
the `stop` tier held **17 gates at ~3.7s wall**, `fast` added 5 more
(~27s total), and `full` the rest:

> "**stop** (17 gates, ~3.7s wall), **fast** (+5 gates, ~27s), **full**..."
> — `decisions/ADR-074-enumerating-gate-battery.md:65`

`scripts/gate-all.mjs`'s own doc comment (`:100-112`) still quotes this
2026-08-15 baseline almost verbatim ("stop — sub-second-ish, ~4.5s for all 17
together... while the other 17 gates together cost 4.4s") even though the
comment's own later paragraph (`:429-440`, the "drift notes") documents that
the number has since moved: *"the stop tier's own budget... had drifted from
a documented 17 gates at ~3.7s to 36 gates at ~11.8s, with no test and no
receipt to notice."*

Further drift markers, all in-repo:

- `docs/designs/extract-governance-layer.md:168` (a drift-tracking note
  itself): `jq '.gates | length' scripts/gate-manifest.json` → 56 declared;
  `grep -c '"cost_class": "stop"' scripts/execution-profile.json` → 38
  stop-classed; `node scripts/gate-all.mjs --list --tier stop | wc -l` → 36
  executed — three different counts from three different commands, none of
  them 17, all as of whenever that doc was last refreshed (dated snapshot,
  not live).
- `audit/tui-remediation-verification.md:528-531`: "A related moving-target
  note on this brief's own '17 gates' framing: counting `"gate:*"` scripts in
  `package.json` directly today returns **20**, not 17."
- The deleted `scripts/hooks/gate-stop.sh` header (quoted in
  `extract-governance-layer.md:168`) "still read 'Measured: 17 gates,
  ~3.7s wall' — stale against the current 36" as of that snapshot. Its own
  header had already retracted the figure before deletion, and ADR-156's
  ratchet (`scripts/gate-budget/stop-budget.json`) is what now holds the real
  series; that ceiling may only ever FALL and is untouched by the devolution.
- **This session's own live measurement** (§3.1): stop tier is now **41**
  gates, total gates **59**, package.json `gate:*` entries **60** (including
  `gate:all`).

**Plain statement:** every count this repo currently produces for "the stop
tier" or "the gate battery" — 17 (ADR-074 baseline), 20
(`tui-remediation-verification.md` snapshot), 27 (ADR-074's contemporaneous
total), 36 (the `gate-all.mjs` drift-note snapshot and the
`extract-governance-layer.md` snapshot), 38 (a stop-classed count from the
same snapshot), 56 (a manifest count from the same snapshot), and **41/59
(this session's live measurement)** — is a different number, taken at a
different time, by a different command, over a genuinely growing roster. **No
snapshot in this repo's history, including the current one, has 17 as its
live total.** The "17-gate" framing in any brief describing this system as a
fixed inventory should be treated as **stale by construction**, not merely
imprecise — the codebase's own repeated internal complaint (ADR-074, the
`gate-all.mjs` drift-notes comment, and the `tui-remediation-verification.md`
audit) is exactly that this number cannot be pinned once and reused; it must
be recomputed with the commands shown in §3.1 whenever it is cited. This
document does **not** invent a corrected fixed number for the same reason.

## 6. Trust boundary

Everything in §§1-3 is **application-level governance**: TypeScript
functions (`gate.ts`), an in-process hook bus with a catalog and a JSON
descriptor format (`hooks/*.ts`), and shell scripts wired through the Claude
Code CLI's own hook registration (`.claude/settings.json`). None of it is an
OS-level sandbox:

- The ADR-006 gates (`gate.ts`) are pure functions over data the caller
  supplies; a caller that constructs a fake `AdmissionCheck`/`EvidenceCheck`
  with the "right" booleans passes the gate without the underlying condition
  being true. Nothing in `gate.ts` independently re-verifies its inputs
  against the filesystem, git, or a process exit code — that verification, if
  it happens, happens upstream of the gate call, not inside it.
- The ADR-111 hook bus's veto path (`wrapToolPort`) only intercepts calls
  that go through the specific `NativeToolPort` it wraps; it is a
  composition-root decision (`native-agent-executor.ts` etc. choosing to
  wrap), not an enforced kernel/process boundary. A code path that never
  acquires a wrapped port never passes through any hook.
- `.claude/settings.json` hooks run as ordinary shell commands under the
  operator's own OS user, with no additional privilege separation from the
  Claude Code process itself; `git-write-guard.sh` and `vi-readonly-guard.sh`
  are advisory application checks, not filesystem permission enforcement.
- **Conclusion, stated plainly per the task instruction:** app hooks in this
  repository are a governance and evidence-production layer, not an OS
  sandbox. A determined or buggy process that bypasses the intended call
  paths (e.g. writes files directly instead of going through the gated
  command surface) is not stopped by anything inventoried in this document.
