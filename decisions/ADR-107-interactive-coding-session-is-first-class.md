# ADR-107: An Interactive Coding Session Is A First-Class Surface

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 886ad211a3762ac4580253056a2a39e6e909b0cc
**Content ID:** sha256:08d0b4c8f77c774b58ed8c4d542187df8be7ac4ac861413844f0134827367338

## Context

A four-agent parity audit run 2026-08-26 against revoy2 @ 5afc268f graded arbor against Claude Code and Codex CLI and found that arbor has no interactive coding session. `bun packages/arbor-mcp/bin/arbor-mcp.mjs --help` confirms it: the top-level surface is roughly forty commands — `ledger`, `evidence`, `governance`, `audit`, `verification`, `adopt`, `recover`, `campaign`-adjacent nouns — and there is no `arbor chat`. The finding holds, but its framing needs a correction once the tree is actually read: the *surface* is missing, but the *engine* underneath it already exists, in three places.

`packages/arbor-mcp/src/task-composer.ts` is documented as "Pre-campaign authority. It never executes model tools itself and it cannot admit a campaign without a confirmed, schema-validated proposal." `TaskComposer.plan()` calls a planner once per draft, and `confirm()` runs `classifyAndRepairMutatingActions(draft.proposal, ...)` before one `admission.admit(...)` call — plan-once, confirm-once, run-once, not a conversational loop. `packages/arbor-tui/src/screens/task-composer.ts` matches: its header comment says the screen "is deliberately only a bounded projection... It has no model/provider, campaign-manager, or connector import and therefore cannot turn a task, proposal, or question into execution authority by itself," and its caption reads "Describe the outcome you want. Revoy plans, checks, and starts safe work automatically." `arbor tui` is an operator cockpit for supervising campaigns, not a chat surface — the audit's characterization there holds.

But `packages/arbor-harness/src/native-worker.ts`'s `NativeHarnessWorker` already runs a real multi-turn loop up to `NATIVE_MAX_TURNS_DEFAULT = 24` (`packages/arbor-mcp/src/native-agent-executor.ts:154`), and between every turn it drains a steering inbox (`native-worker.ts:469-478`) and folds each message into governed context as a `human_input` record — the primitive of a chat turn, already wired. Approval is already per-tool-call, not per-keystroke: `approvalRequired(policy, call.risk)` (`native-worker.ts:1093-1094`) interrupts only on `"always"` policy or a `"high"`-risk tool under `"on_risk"`, resolved through `NativeApprovalPort.decide(...)`. `packages/arbor-mcp/src/live-native-session-registry.ts`'s `LiveNativeSessionRegistry` already exposes `steer(sessionId, messageId, text, provenance)` to redirect a running session and `interrupt(sessionId, reason)` to abort one — a live, attachable session concept today, but reachable only through `arbor session <availability|resume|fork|respawn>`, which requires an id from a campaign already in flight, not a fresh terminal chat. `arbor acp` (`AcpIdeJourney` in `packages/arbor-mcp/src/acp-ide.ts`), the closest thing to an editor-facing interactive surface, rejects a second `prompt()` call: `"an ACP session accepts one task submission"` (`acp-ide.ts:173`). Even the IDE bridge is single-shot.

The honest gap is narrower than "no interactive engine." It is: no command opens a live native session from a terminal prompt, and no UI renders one turn-by-turn while queuing an operator's next message as steering. This reframes the decision from "build a chat loop" to "expose the loop that already runs under an admitted campaign, without a second, ungoverned mutation path beside it."

## Decision

**1. An interactive session is a campaign, with turns as steering into an admitted node — not a parallel command loop.** The first message opens the session exactly as `TaskComposer.submit()`/`confirm()` do today: it plans, classifies actions via `classifyAndRepairMutatingActions`, and calls `admission.admit(...)` to create the campaign and its root node. Every message after that is not a new admission; it is a `NativeSessionSteeringMessage` queued through `LiveNativeSessionRegistry.steer(...)` and drained by `NativeHarnessWorker`'s existing per-turn loop between turns, recorded to governed context the same way `native-worker.ts:472` already records a steering message today.

**2. Approval mediation reuses the existing per-tool-call gate; this decision adds no new gate.** `approvalRequired(policy, call.risk)` already governs every tool call inside a native session's turn loop regardless of whether the turns originate from a batch campaign plan or from live operator steering. A chat turn interrupts only on a high-risk tool under `on_risk`, or every tool under `always` — never per keystroke, per message, or per turn.

**3. `arbor tui` grows a live session screen, not a competing surface.** A new screen renders `LiveNativeSessionRegistry.list()`/`inspect()`/`events()` as a scrolling turn transcript and offers a composer that calls `steer()`/`interrupt()` — reusing the same `RuntimePort` dispatch discipline `task-composer.ts` already uses, so no screen gains write authority the runtime does not already expose.

**4. `arbor session` becomes reachable without a prior campaign run.** Today `arbor session <action> <id>` requires an id from a campaign already in flight. A new `arbor session start` opens one directly from the terminal, admitting a campaign the same way `TaskComposer.submit()` does, then attaching to the resulting live session for turn-by-turn use.

This does **not** touch `arbor acp`'s one-submission-per-session invariant. ACP sessions are editor-initiated; lifting that boundary so an external IDE gets a standing multi-turn tool loop is a distinct trust decision this ADR does not make.

## Consequences

Operators get a true iterate-in-session workflow — type, watch a turn execute, redirect — without waiting for a full campaign to finish and running `arbor adopt` to see it. Every turn stays inside the existing ledger, evidence, and admission machinery; no new "session ledger" is invented. The cost: the TUI needs rendering machinery no current screen has — a live-updating transcript and an input path usable mid-turn — since every existing screen, including `task-composer.ts`, is a bounded snapshot projection, not a stream consumer. `arbor session start`'s first-message admission still pays the full `TaskComposer.plan()` planner round trip before the first turn runs, so "instant" chat is not literally instant; only later turns are cheap steering. Approval-fatigue risk is bounded but not eliminated: a session calling many high-risk tools under `on_risk` still interrupts on each one, by design — this decision does not relax that policy to make chat feel faster. What this explicitly does **not** change: `arbor run`, `arbor recover`, `arbor adopt`, the ledger/evidence CLI surface, the campaign tree model, or the ACP one-submission invariant. Campaigns remain the batch/autonomous mode; interactive sessions are a second front door onto the same admitted-campaign substrate, not a replacement for it.

## Alternatives / Roads not taken

**A standalone REPL calling `NativeAgentExecutor` directly, admitting the campaign only after the session ends.** Rejected: this is precisely "every turn in a chat is an un-admitted action" — retroactive admission after live tool calls and file mutation defeats admission's purpose, which is to gate a mutating action *before* it happens, not notarize it afterward.

**Lift `AcpIdeJourney.prompt()`'s one-submission limit and make the IDE bridge the interactive front door.** Rejected here: an editor-initiated ACP session and an operator-initiated terminal session are different trust boundaries — the bridge intentionally treats a prompt as atomic. A standing multi-turn IDE loop is a separate decision, not a side effect of this one.

**A TUI chat pane calling `NativeAgentExecutor` without `TaskComposer`/admission, for a faster "just run it" mode.** Rejected: it bypasses the same `classifyAndRepairMutatingActions` → `admission.admit` gate that makes every other mutating action attributable, reintroducing the ungoverned path the audit was checking for.

## Obligations

### O1 — The steering seam a chat turn will use is real today, not proposed machinery

`LiveNativeSessionRegistry.steer()` already queues a redirect into a running native session and `interrupt()` already aborts one; a session's "send message" and "stop" actions are calls into this existing registry, not new state. The roundtrip test exercises registration, steering, draining, and interruption against the real registry, not a stub.

<!-- proof: symbol=LiveNativeSessionRegistry file=packages/arbor-mcp/src/live-native-session-registry.ts roundtrip=packages/arbor-mcp/tests/live-native-session-roundtrip.test.ts -->

### O2 — Per-tool-call approval mediation, not per-turn or per-keystroke, is the existing gate a chat session inherits unchanged

`NativeHarnessWorker` already drains steering between turns and gates each tool call through `NativeApprovalPort` via `approvalRequired(policy, risk)`. This decision adds no new approval mechanism; it relies on this one running exactly as it does for batch campaigns today, already exercised turn-by-turn by the worker's own test suite.

<!-- proof: symbol=NativeHarnessWorker file=packages/arbor-harness/src/native-worker.ts roundtrip=packages/arbor-harness/tests/native-worker.test.ts -->

### O3 — `arbor session start` admits a campaign before any live turn runs

The first message of an interactive session must classify its actions and call `admission.admit(...)` exactly as `TaskComposer.confirm()` does before any tool call; a session opened this way must be indistinguishable, from the ledger's perspective, from a campaign submitted through `arbor task`. `sessionStartCommand` (`cli.ts`) dispatches one `taskcomposer.submit` with `auto_confirm: true` — the same call `arbor task`'s bare submit makes — then only ever steers/interrupts the resulting live session; it never admits a second time. The roundtrip test drives a real `main(["session","start",...])` against a deferred, never-settling `CampaignRunner` and asserts the campaign/root node already exist in the manager's ledger snapshot while proving no live turn ever dispatched (the runner's promise never resolves).

<!-- proof: symbol=sessionStartCommand file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/session-start-admission.test.ts -->

### O4 — The TUI's live session screen renders only through `RuntimePort`, gaining no write authority beyond what `task-composer.ts` already has

The proposed screen must read `LiveNativeSessionRegistry.list()`/`inspect()`/`events()` and dispatch `steer`/`interrupt` the way every existing screen dispatches through `RuntimePort`, never importing the registry, campaign manager, or connector directly — the discipline `packages/arbor-tui/src/screens/task-composer.ts`'s header comment states for itself. `liveSessionScreen` (`packages/arbor-tui/src/screens/live-session.ts`) projects only live (attachable, non-terminal) `harness.session.list`/`harness.session.attach` results as a turn-by-turn transcript and declares `harness.session.steer`/`harness.session.interrupt` in its surface, reusing the exact same reducer dispatch (`update.ts`) `harness-sessions` already exercises — generalized to the two screens rather than duplicated. The roundtrip test asserts the module's own import list names neither the registry nor a connector, and exercises the attach/steer/interrupt round trip through `update.ts`. Composition-root wiring (`packages/arbor-mcp/src/tui.ts`'s per-screen on-focus query and palette action-id dispatch) is a sibling boundary outside this file set — see the implementation report.

<!-- proof: symbol=liveSessionScreen file=packages/arbor-tui/src/screens/live-session.ts roundtrip=packages/arbor-tui/tests/live-session-screen.test.ts -->
