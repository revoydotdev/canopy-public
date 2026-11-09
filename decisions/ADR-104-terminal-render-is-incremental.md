# ADR-104: The Terminal Renders Incrementally From A Stream, Not By Polling Snapshots

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 5afc268fd12b3731abf2ba5b1ca52a3c941f8153
**Content ID:** sha256:fd026b4d3391f2fcef54fd7c64b420e3bfc43c2620b0a631bee75e88077a7a7e

## Context

Verified against `packages/arbor-tui/src/` at 5afc268f: `TuiShell.draw()`
(`shell.ts:183-199`) calls `renderScene({ ...projection, navigation }, options)`
on every tick and hands the result whole to `render()`. The doc comment on
`TuiShellOptions.frame` (`shell.ts:17-23`) says this in so many words — a thunk
theme switch is sufficient "since `draw()` always rebuilds the whole
`SceneFrame` from scratch (never an incremental patch — `StdoutRenderer`'s
diffing is an output-layer optimization only, not a partial re-render)."
Output reaches the operator through `packages/arbor-tui/src/screens/output.ts`: `output.descriptor`
returns one bounded `MAX_PREVIEW_CHARS = 2_000` slice of already-captured
content (`output.ts:22,61-88`), and the screen advances only when its declared
queries — `output.descriptor`, `output.list` — are re-run and a new draw is
scheduled. There is no per-token event path from a running inference call to
this screen.

That gap is not a TUI oversight; it is the harness swallowing its own stream.
`AnthropicMessagesModelPort`'s `streamMessage` (`anthropic-harness/src/
anthropic-messages.ts`) really does parse Server-Sent Events incrementally —
`drainSse` (`:738`) is called against the growing `pending` buffer inside the
read loop (`:317-323`) and yields a `NativeInferenceDelta` per SSE event. But
every caller collects the whole generator before doing anything with it:
`native-agent-executor.ts:1038` re-yields through a passthrough wrapper with no
consumer in between, and both real call sites — `openai-compatible.ts:143`
(`for await (const delta of streamCompletion(...)) deltas.push(delta)`) and
`anthropic-messages.ts:175` (identical `deltas.push` pattern) — buffer into an
array before returning. `native-worker.ts:1292`'s `collectNativeStream` does
the same for the native tool-call path. By the time anything downstream of the
model port sees a response, the deltas have already been flattened into one
completed message. The TUI cannot render incrementally because nothing hands
it increments; `output.descriptor`'s 2000-char poll is downstream of a wall
that was built one layer earlier.

The full-`SceneFrame`-rebuild design in `shell.ts` was deliberate, and for a
real reason, not an oversight to reverse casually. ADR-011's O4 and ADR-037
establish it: the renderer contract had to become a pure function of
projection state precisely so a second, structurally different renderer
(`OpenTuiRenderer`, ADR-036) could be driven headlessly and hit-tested against
a `SceneFrame` snapshot rather than a mutated one (`shell.ts`'s own comment on
`scene()`: exposing the *last drawn* scene, not one recomputed at click time,
"is what makes the hit-test agree with what the operator actually saw"). Every
`arbor-tui/tests/` file that exercises `TuiShell` — `frame-pacing.test.ts`'s
two-clock tests, `opentui-hit-test.test.ts`, `painter.test.ts`'s `renderScene`
suite — asserts against a complete, addressable `SceneFrame`, not a diff
against a previous one. That is what determinism and structural hit-testing
buy today, and any streaming design has to keep both.

Also verified absent from `packages/arbor-tui/src/`: no markdown parser
anywhere in the package (`types.ts`/`update.ts`/`headless.ts` use
`language: "markdown"` only as a tag passed to an *external* editor, never
parsed in-process); no `@`-file mention autocomplete (zero matches for
`mention`/`autocomplete`); and no image paste — the sole hit for `image` is
the error fingerprint string `"taskcomposer:image-paths"` in `headless.ts:127`,
which names a rejection path, not a feature.

## Decision

**1. The model port's already-incremental SSE stream becomes an incremental
event, not a buffered return, for the interactive path.** `streamMessage`'s
`AsyncIterable<NativeInferenceDelta>` (exposed through
`createAnthropicMessagesModelPort`, `anthropic-messages.ts:159`) stays exactly
as it is at the transport. What changes is the consumer: the interactive
execution path in `native-agent-executor.ts` gains a delta sink — a callback
or async-iterable passthrough registered per in-flight turn — so a delta is
forwarded the moment `applyEvent` produces it, instead of only after
`finishStream` returns the complete array. `openai-compatible.ts:143` and
`anthropic-messages.ts:175`'s `deltas.push` loops remain the batch path used by
everything that genuinely wants a finished message (evaluation harnesses,
non-interactive runs); the interactive path gets a second, additive
consumption mode, not a replacement of the first.

**2. `TuiShell` keeps its full-`SceneFrame`-rebuild draw, and gains a
higher-frequency partial-content channel that participates in, but does not
replace, that model.** The change clock in `shell.ts` (`pendingChange`/
`frame_interval_ms`) already coalesces invalidations; a streaming delta becomes
another invalidation source at a shorter cadence, feeding accumulated partial
text into the same `projection()` the next `draw()` reads. `draw()` still
computes one complete `SceneFrame` per tick — the change is *how often* and
*from what state* a tick is triggered, not the rebuild-from-scratch contract
ADR-037 established. `StdoutRenderer`'s existing output-layer diffing (already
real, per the `shell.ts` comment) is what keeps a higher tick rate cheap on the
wire; nothing about this decision asks it to become a structural patch engine.

**3. `output.descriptor`'s bounded preview stays bounded, and gains a live
variant.** `MAX_PREVIEW_CHARS` (`output.ts:22`) remains the ceiling for a
completed capture — raw oversized output must never be rendered in full,
per that module's own roadmap-4B.3 contract. A running capture's *in-progress*
preview is a separate, explicitly time-bounded field on the same descriptor
shape (last N characters of an unfinished stream), not a widening of the
completed-output cap.

**4. Markdown rendering, `@`-mention autocomplete, and image paste are each
decided narrowly, deferred as separate work.** Incremental markdown rendering
requires a renderer that can re-flow partial, possibly-unbalanced markup on
every delta — building it on the general streaming channel from (1)/(2) is the
right sequencing, so it is out of this record's scope pending that channel
landing. `@`-mention autocomplete is an input-catalog addition
(`input-catalog.test.ts` already exercises catalog-driven completion for
commands; a file-path catalog is the same shape) and does not depend on
streaming — it is accepted as a follow-on, not designed here. Image paste is
explicitly rejected for this ADR: `headless.ts`'s `taskcomposer:image-paths`
fingerprint exists because the composer already classifies and rejects a
pasted image path today, and accepting real image bytes changes the transport
contract with the model adapters (`AnthropicMessagesImageInput`,
`anthropic-messages.ts:56`) in ways this record does not evaluate.

## Consequences

An operator watching a long specialist turn sees tokens arrive as they are
generated, closing the single largest felt-quality gap against Claude Code and
Codex CLI named by the audit. The transport-level work is nearly free — the
SSE parsing already exists — so this is a consumption-side wiring change, not
a new streaming implementation.

What gets harder: `native-agent-executor.ts` now carries two consumption
modes for the same `NativeInferenceDelta` stream (batch and incremental), and
every caller must be correct about which one it wants — an evaluation harness
that accidentally attaches to the incremental sink pays per-delta overhead for
no benefit, and an interactive path that forgets to attach one loses the
feature silently rather than erroring. The change clock's coalescing window
(`frame_interval_ms`) now has to be tuned against a much higher-frequency
invalidation source than terminal resize or state-machine transitions;
undertuning either starves the render of freshness or floods it with draws
that recompute a full `SceneFrame` for a one-token delta. `output.descriptor`
gains a second, more special-cased branch (finished vs. in-progress capture)
in a module whose docstring already promises a "bounded" preview — that
promise now has to hold for a shape that changes underneath the same query
between polls.

This decision explicitly does not touch `draw()`'s full-`SceneFrame`-rebuild
contract, `OpenTuiRenderer`'s hit-testing model, or `StdoutRenderer`'s
output-layer diffing — all three stay exactly as ADR-011/ADR-036/ADR-037 left
them. It also does not implement markdown rendering, `@`-mention autocomplete,
or image paste; it only clears the transport-side blocker two of those three
would otherwise share.

## Alternatives / Roads not taken

**Make `render()` itself incremental — a real `SceneFrame` diff/patch API.**
Rejected: this is the exact design ADR-037 evaluated and moved away from for
`OpenTuiRenderer`'s sake — a patch API would have to be understood by every
renderer implementation, including a future one, and the current
full-rebuild-plus-output-layer-diff split already gives `StdoutRenderer` cheap
wire output without forcing every consumer of `SceneFrame` to reason about
partial state. Re-opening it here, for a problem that is actually upstream of
rendering, would be solving the wrong layer.

**Poll `output.descriptor` faster instead of pushing deltas.** Rejected:
tightening the poll interval could not produce content that has not yet been
written anywhere, since nothing today writes partial content mid-stream —
`deltas.push` buffers the whole message before any store sees it. A faster
poll against the same buffered write point changes nothing; the fix has to be
upstream at the consumption point identified in Decision (1).

**Do nothing pending a bigger structured-scene rewrite.** Rejected: the
transport already does the hard part (real SSE parsing exists, tested,
shipped). Declining to wire an existing capability to its obvious consumer
because a future rewrite might also touch this area optimizes for a rewrite
that has no scheduled owner over a felt gap that is currently paid by every
operator, every session.

## Obligations

### O1 — The model transport already parses Server-Sent Events incrementally; the streaming decision has a real seam to build on, not a green field

`drainSse` runs inside `streamMessage`'s read loop against a growing buffer
and `createAnthropicMessagesModelPort` exposes an `AsyncIterable<
NativeInferenceDelta>` per streamed turn — this is the exact mechanism
Decision (1) proposes routing to an incremental sink instead of `deltas.push`.
Demonstrating this now, before the sink exists, is what makes the decision
verifiable rather than aspirational: the thing being wired already produces
real per-event data end-to-end against a live SSE body.

<!-- proof: symbol=createAnthropicMessagesModelPort file=packages/arbor-harness/src/anthropic-messages.ts roundtrip=packages/arbor-harness/tests/anthropic-messages.test.ts -->

### O2 — `TuiShell` rebuilds one complete `SceneFrame` per draw today, and that contract is unchanged by this decision

`TuiShell.draw()` calls `renderScene` fresh every tick and stores the result
as `lastScene`; no code path today produces or consumes a partial `SceneFrame`.
This obligation is a preserved-behavior claim, not a new-feature claim: it
demonstrates the baseline this ADR's Decision (2) explicitly keeps, so a
future reader can tell whether a later change actually introduced patching or
only added a faster invalidation source on top of the same rebuild.

<!-- proof: symbol=TuiShell file=packages/arbor-tui/src/shell.ts roundtrip=packages/arbor-tui/tests/frame-pacing.test.ts -->

### O3 — An interactive delta-forwarding sink forwards each delta the instant it is yielded, ahead of batch collection

`native-agent-executor.ts` carries `NativeAgentExecutorOptions.on_model_delta`
and `observeStreamingDelta`: when the composed model port exposes `.stream`
(the transport `NativeHarnessWorker.run` actually calls per
`native-worker.ts:647-649`), every `NativeInferenceDelta` is forwarded to the
sink the instant it is yielded — strictly additive to, and ahead of, the
worker's own `collectNativeStream` batch collection. `openai-compatible.ts`'s
and `anthropic-messages.ts`'s `deltas.push` loops are untouched, exactly as
Decision (1) specifies.
`packages/arbor-mcp/tests/native-agent-delta-forwarding.test.ts` drives this
through `NativeAgentExecutor.specialize` with a real model port whose
`stream()` deliberately blocks between its first and second delta on a
test-controlled gate: the sink observes and the test asserts on the first
delta while the model's generator is still paused mid-stream, which is only
possible if the forward happens as each delta is pulled through the
`for await` loop rather than after the whole stream (or `collectNativeStream`'s
batch) completes. A second case confirms a model port with no `.stream` is
never wrapped and the sink never fires, matching Decision (1)'s "additive,
not a replacement" contract.

<!-- proof: symbol=NativeAgentExecutor file=packages/arbor-mcp/src/native-agent-executor.ts roundtrip=packages/arbor-mcp/tests/native-agent-delta-forwarding.test.ts -->

### O4 — `output.descriptor`'s in-progress preview is now produced by a real streamed turn, not just rendered by a tested-but-unreachable receiver

The gap this obligation originally recorded — a real receiver
(`projectDescriptor`'s `preview.in_progress`/`descriptor.status ===
"in_progress"` branch) with no producer — is closed. `LiveNativeSessionRegistry`
(`arbor-mcp/src/live-native-session-registry.ts`) now holds a bounded
trailing-window text buffer per live native session: `pushDelta` appends and
trims to a fixed ceiling (redacting secret-shaped text with the same policy
`steer()` already applied to operator text), and `preview()` reads it back.
`cli.ts`'s `configuredNativeAgentExecutor` — the one real production
composition root for `NativeAgentExecutor` — sets `on_model_delta` to forward
every `kind: "text"` delta into that same shared registry the instant
`observeStreamingDelta` (O3) yields it, so O3's already-proven sink now has
a real production consumer instead of none. `runtime-catalog.ts`'s
`output.descriptor`/`output.list` handlers check `nativeSessionRegistry` for
a live session before (and, for `output.list`, alongside) the persisted
`OutputEvidenceStore`, deriving a content-hash-shaped id
(`liveSessionEvidenceId`) so a live row round-trips through the exact same
`evidence_id` field `arbor-tui/src/update.ts`'s existing row-selection
dispatch already sends — no change to that file, and no new catalog kind.
`arbor-mcp/src/tui.ts` polls the selected row's detail query once a second
while the `output` screen is focused, so the preview keeps advancing as more
deltas land; this is a faster invalidation source into the same
query/state/draw round trip every other poll in that file uses, not a
push-render path — `draw()` still rebuilds one whole `SceneFrame` per tick
from state that now includes the buffer's current contents.
`streaming-output-live-preview.test.ts` drives this through a real
`NativeAgentExecutor.specialize()` call against a model port gated mid-stream
(the same proof technique `native-agent-delta-forwarding.test.ts` uses for
O3) and asserts `output.descriptor`/`output.list`, queried through a real
`RuntimeCatalogRouter`, already show the partial text before the turn
settles — and that the row disappears once the session settles, since the
buffer is process-local and never persists.

<!-- proof: symbol=outputScreen file=packages/arbor-tui/src/screens/output.ts roundtrip=packages/arbor-tui/tests/screens-task-operation-output.test.ts -->
<!-- proof: symbol=LiveNativeSessionRegistry file=packages/arbor-mcp/src/live-native-session-registry.ts roundtrip=packages/arbor-mcp/tests/streaming-output-live-preview.test.ts -->
