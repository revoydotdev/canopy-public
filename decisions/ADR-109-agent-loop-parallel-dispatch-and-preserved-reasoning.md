# ADR-109: Tool Calls Dispatch In Parallel And Model Reasoning Is Preserved

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 5afc268fd12b3731abf2ba5b1ca52a3c941f8153
**Content ID:** sha256:34adc65f533474a3fac2678dc6cf160cf84e67853290fe89afdc444417df98a2

## Context

The 2026-08-26 four-agent parity audit against revoy2 @ 5afc268f flagged two
defects in `NativeHarnessWorker.run`'s per-turn loop
(`packages/arbor-harness/src/native-worker.ts`), and both verify against the
current tree.

First: when a model turn returns more than one tool call,
`NativeHarnessWorker` executes them with a plain `for` loop over
`response.tool_calls` that `await`s `this.executeTool(...)` on each iteration
before starting the next (lines 594–599). Claude's Messages API is explicit
that "one assistant message may contain multiple `tool_use` blocks" and that
callers should "execute them concurrently, then return all `tool_result`
blocks in a single user message" — splitting results across messages "silently
trains Claude to stop making parallel calls." The worker never violates the
single-message-of-results contract (every `history.push({ kind: "tool_result",
... })` site appends to the same shared array before the next model request is
built), but it pays the full serial latency of every tool in a turn first.

Second: `createAnthropicMessagesModelPort`'s stream/response parser
(`packages/arbor-harness/src/anthropic-messages.ts`, `applyEvent`, around
lines 379–389) treats any `content_block_start` whose `block.type` is neither
`"text"` nor `"tool_use"` as an "unrecognized block kind (e.g. `thinking`)"
and tracks it only as an opaque placeholder that "contributes nothing to the
response." This is a real forward-compatibility guard against protocol drift,
but its effect on `thinking` is to discard it: `NativeConversationEntry`
(`native-worker.ts:63-64`) has exactly three kinds —
`"model_text" | "tool_result" | "human_input"`, no `thinking` kind — and
`buildMessages` (lines 517-519) reconstructs each replayed turn as a single
plain-text `{ role, content: string }` message, discarding block structure and
any `signature` entirely. Anthropic's contract (confirmed via the `claude-api`
skill) requires echoing `response.content` back **unchanged** to preserve
thinking blocks across turns — "removing them can trigger ordering/signature
400s" — and adaptive thinking auto-enables interleaved thinking with no beta
header on current-generation models. None of that is reachable today: the
worker cannot request it, and even if the model produced it, the transport
would drop it before it reached `NativeConversationEntry`.

## Decision

**1. Tool calls in one turn dispatch with bounded concurrency, in a policy the
worker — not the adapter — owns.** `NativeHarnessWorker.run` replaces the
serial `for` loop (lines 594-599) with a dispatcher that classifies each
`toolCall` against `start.policy` before scheduling: any tool whose write
target collides with another call in the same turn, or whose risk tier
requires the write-path lock `NativeRepositoryToolHost` already serializes on
(`native-tool-host.ts`'s `NATIVE_DOCUMENTATION_WRITE_PATH_POLICY`), runs after
that conflicting call completes; everything else runs under a fixed, bounded
concurrency limit — not unbounded `Promise.all`, since a turn can carry many
calls and the worker already enforces call-count-scaled budgets. The returned
`tool_result` order still matches `response.tool_calls`' original order (a
stable order keeps `history` diffable, even though Anthropic pairs results by
`tool_use_id`, not position). One call throwing does not cancel its siblings:
each outcome becomes its own `is_error: true` tool_result, exactly as
`executeTool`'s existing per-call error path already produces serially. The
`AbortSignal` already threaded through `executeTool` is shared across the
batch, so an external interrupt cancels every in-flight call at once.

**2. `NativeConversationEntry` gains a `"thinking"` kind carrying the block's
text and its `signature` verbatim.** `native-worker.ts:63-64`'s union becomes
`"model_text" | "thinking" | "tool_result" | "human_input"`, with `thinking`
storing `{ text: string; signature: string }` — never redacted, since
`signature` is an opaque verification token, not model output. `applyEvent`
(the `content_block_start` branch, ~line 383) stops collapsing `thinking`
into the same opaque placeholder as truly-unknown block kinds: it tracks
`thinking` through `content_block_delta`/`content_block_stop`, accumulating
delta text and `signature_delta`. `buildMessages` (lines 517-519) stops
flattening history into single-string `{ role, content: string }` messages
for any turn carrying a `thinking` entry: that assistant message is rebuilt
as its original ordered content-block array — `thinking` (with `signature`),
then `tool_use` — exactly as shared/model-migration.md (an external
migration-guidance reference, not a file in this repository) requires for replay
("don't strip thinking blocks — removing them can trigger ordering/signature
400s"). Turns with no `thinking` entry keep today's plain-text collapse; this
is additive, not a rewrite of every message shape.

**3. Interleaved thinking is requested, not merely tolerated.** The request
builder sets `thinking: { type: "adaptive" }` when the composed
`NativeModelRequest` opts in (a new, default-off `request.thinking_enabled`
flag from `NativeHarnessWorkerOptions`), which auto-enables interleaved
thinking with no beta header on current-generation models. This is opt-in per
session composition, not a global default: it changes token spend and
latency, and `NativeUsageBudgetController` needs to see it to budget
correctly.

## Consequences

A turn with N independent tool calls (searches, reads, non-conflicting edits)
completes in roughly the slowest call's latency instead of the sum of all N.
Extended/interleaved reasoning becomes something the native worker can carry
end to end instead of silently discarding, closing a real capability gap
against Claude Code and Codex CLI, both of which already forward reasoning.
This does not change tool risk classification, `NATIVE_SUBAGENT_TOOL_RISKS`,
or any existing serialization the write-path policy already enforces —
concurrency layers on top of those gates, never around them — nor the
single-model-request-per-turn shape of the loop; only the intra-turn tool
phase parallelizes.

The costs are real: concurrent execution means the worker must reason about
partial-turn failure in a way the sequential loop never had to, and a bug in
the write-path collision detector is now a data-race risk, not a
latency-only bug. Carrying `thinking`/`signature` through `history` grows
every checkpoint and replay payload, and a corrupted or truncated signature
on replay is a new class of 400 the worker must classify, not silently drop.

## Alternatives / Roads not taken

**Unbounded `Promise.all` over every tool call in a turn.** Rejected: a turn
that spawns `subagent.execute` alongside several file reads would fire an
unbounded burst of high-risk calls at once, defeating credential-lease and
budget controls that assume roughly one in-flight external call per step.
Bounded concurrency with an explicit write-conflict rule gets the latency win
without that blast radius.

**Keep tool_use serial but fix only the thinking-block discard.** Rejected:
the fix for concurrent dispatch changes how history is assembled for a turn,
which is exactly where the thinking-preservation fix also has to land.
Splitting them risks landing an ordering change for concurrency that the
thinking fix would then have to redo.

**Store only `thinking.text` and regenerate a synthetic signature on
replay.** Rejected outright — a signature is a cryptographic artifact of the
model's own output, not data revoy can synthesize. A regenerated or omitted
signature is exactly the "ordering/signature 400" failure mode the skill
warns about.

## Obligations

### O1 — The native worker's turn loop is the real, reachable seam bounded-concurrency dispatch modifies

`NativeHarnessWorker` is the exported class whose `run` method owns the
per-turn tool-call loop this decision changes (the serial `for` at
native-worker.ts:594-599). Proving this symbol demonstrates the concurrency
change lands on the actual dispatch loop the audit inspected, with an
existing test suite that already exercises this worker end to end.

<!-- proof: symbol=NativeHarnessWorker file=packages/arbor-harness/src/native-worker.ts roundtrip=packages/arbor-harness/tests/native-worker.test.ts -->

### O2 — The Anthropic Messages adapter is the real, reachable seam thinking-block preservation modifies

`createAnthropicMessagesModelPort` is the exported factory whose internal
`applyEvent`/`buildMessages` functions this decision changes to stop
discarding `thinking` blocks and reconstruct structured replay messages —
the transport boundary where the discard currently happens (~line 383).

<!-- proof: symbol=createAnthropicMessagesModelPort file=packages/arbor-harness/src/anthropic-messages.ts roundtrip=packages/arbor-harness/tests/anthropic-messages.test.ts -->

### O3 — Concurrent dispatch never reorders or drops a `tool_result` relative to its `tool_use_id`

Every tool call in a turn produces exactly one `tool_result` entry in
`history`, matched to its originating call by `call_id`, regardless of
completion order under concurrent execution. This is the correctness
property bounded concurrency must not regress relative to today's serial,
trivially ordered loop.

<!-- proof: symbol=NativeHarnessWorker file=packages/arbor-harness/src/native-worker.ts roundtrip=packages/arbor-harness/tests/native-worker.test.ts -->

### O4 — A `thinking` block with its `signature` survives a full turn round-trip: produced by the adapter, carried in history, and replayed unchanged on the next request

This is the end-to-end claim the decision exists to satisfy: not just that
`thinking` is parsed instead of discarded, but that the exact `signature`
reaches the next outbound request byte-for-byte, since Anthropic's contract
ties replay validity to that value being unchanged.

<!-- proof: symbol=createAnthropicMessagesModelPort file=packages/arbor-harness/src/anthropic-messages.ts roundtrip=packages/arbor-harness/tests/anthropic-messages.test.ts -->
