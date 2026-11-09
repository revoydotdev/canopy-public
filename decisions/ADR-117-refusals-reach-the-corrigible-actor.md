# ADR-117: A Refusal Reaches The Actor That Can Correct It

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** f8312bdb933bf2aa03fe29347f56d7ea9c67f59d
**Content ID:** sha256:0c1646fb201a2508425780a685e86057b2e53b789b87f611aa1b56d0e9bde455

## Context

The uncooperative-refusal survey's S3 shape ("dead-end refusal") has its
sharpest instance in the native session worker's own tool dispatch.
`native-tool-host.ts`'s `createNativeRepositoryToolHost` attaches both
`preflight(request)` and `execute(request, secret, signal)` to every
high-risk `NativeToolPort` (`file.write`, `file.patch`, `shell.execute`,
`verification.run`), and for a high-risk tool `preflight` always runs first,
before approval and before `execute` (`native-worker.ts:833-848`).

Reading the two dispatch branches side by side settles the asymmetry by
direct evidence, not inference:

- **`execute()` success.** `native-worker.ts:951-957` calls
  `this.recordToolResult(...)` (the canonical audit event) *and*
  `history.push(Object.freeze({ kind: "tool_result", ... }))`. `history` is
  the array folded into the model's next turn — the only line in the file's
  dispatch path that puts a tool outcome in front of the model.
- **`preflight()` denial.** `native-worker.ts:844-847`, on
  `admission.allowed === false`, calls the same `recordToolResult(...)` then
  `this.failed(sessionId, turn, admission.code, ...)`. Neither
  `recordToolResult` (`:1085-1091`, which only calls `this.engine.record`)
  nor `failed` (`:1076-1083`, which records a `diagnostic` event and calls
  `this.engine.fail`) ever touches `history`. The session terminates on the
  same turn the refusal is generated.

Because `preflight` always precedes `execute` for these tools, the
cooperative shape `execute()`'s success path demonstrates is structurally
unreachable for `action_scope_command_denied`, `action_scope_path_denied`,
and `action_scope_missing_or_stale` — the three codes
`highRiskScopeFailure` (`native-tool-host.ts:242-278`) produces. The actor
who could correct course — target a path inside `scope.write_paths`, drop a
command outside `scope.command_argv` — is the model, mid-session. It is
exactly the actor this refusal never reaches; the session is already over.

The same asymmetry repeats twice more, evidence the shape is systemic.
Approval denial: `native-worker.ts:886` records `resolution.rationale` into
the canonical event stream, then `:887-890` calls
`recordToolResult`/`failed` exactly as the preflight path does — captured,
never pushed to `history`. And a level up, in `task-composer.ts`'s planner
loop: `:295` comments `// schema_invalid: the response resolved but did
not parse/validate. Not retryable.`, and `:296` assigns `parsed.error`
straight into the failed draft's `planner.error` field — computed, never
fed back to the planner — even though the same function already retries a
sibling failure mode (`:277-282`, the `transient_transport` catch block
that `continue`s the loop on a rejected provider call).

The codebase already contains the correct shape, and says so itself:
`recordUncomposedToolCall` (`native-worker.ts:973-990`), for a tool name
outside the composed set, documents choosing *not* to call `this.failed()`
— "this never calls `this.failed()` -- the turn continues" (`:971`) —
instead building a `tool_result` naming what the model can actually call
(`:975`), recording it (`:982`), pushing it to `history` (`:989`), and
returning `this.isTerminal(sessionId)`. It is the pattern the scope- and
approval-denial paths should match.

## Decision

**1. Preflight scope denials and approval denials become a recoverable
`tool_result`, mirroring `recordUncomposedToolCall`'s shape exactly.** For
`action_scope_command_denied`, `action_scope_path_denied`,
`action_scope_missing_or_stale`, and `approval_denied`, dispatch
(`native-worker.ts:844-847`, `:887-890`) stops calling `this.failed()`. It
keeps the existing `recordToolResult(...)` call (the audit trail is
unchanged — the action is still refused and never executed), builds a
model-visible message from the same `code`/`reason` already computed,
pushes it to `history` via the identical `Object.freeze({ kind:
"tool_result", tool: call.tool, call_id: call.call_id, text, evidence })`
shape `recordUncomposedToolCall` uses at `:989`, then returns
`this.isTerminal(sessionId)`. The session continues; the next turn receives
the refusal as a `tool_result` and can attempt a different, in-scope
action. What the message must *say* — not only what was denied but what
authority is actually held — is G2's decision, not duplicated here; this
ADR fixes only the delivery channel.

**2. Codes indicating a host or wiring defect stay terminal.**
`missing_trusted_intent`, `tool_preflight_failed`, `invalid_tool_preflight`,
and `workspace_roots_mismatch` (`native-tool-host.ts:283-286`) mean
composition or the host is broken for this session, not that the model
asked outside its bounds — a model cannot retry its way around them.
`this.failed()` still ends the session for these. Routing every refusal to
`history` would blur "you asked outside your authority" with "this
session's plumbing is broken," which is a strictness regression by
omission.

**3. `task-composer.ts`'s schema-invalid planner response gets the
re-prompt treatment `:277-282` already gives a transient transport
failure.** On `!parsed.ok` (`:294-296`), instead of failing the draft
immediately, the loop feeds `parsed.error` back into the next
`this.planner.plan(...)` call as explicit request context and consumes one
of `MAX_PLAN_ATTEMPTS` — the same bounded recovery a network blip already
gets. Exhausting the attempts still fails the draft.

## Consequences

A model that trips a scope or approval boundary sees why and can try
something else in the same session, instead of the session ending on the
refusal turn. Composer drafts stop failing outright on one malformed
planner response the planner could plausibly self-correct, cutting one
class of wasted full-draft-cost failures.

Nothing about the guards loosens. `highRiskScopeFailure`,
`validHighRiskScope`, `assertWritePathAllowed`, and `sameArgv`'s
byte-exact comparison are untouched — a denied action is still denied,
never executed, still recorded identically in the audit trail. Only the
channel that already-computed information reaches changes: `history` in
addition to the audit stream, for codes an actor can act on. Host-integrity
failures stay terminal — this is a bounded change, not "never end a
session on a refusal." A session that keeps tripping the same boundary can
now run longer before failing, where it previously failed fast; accepted
because the alternative — structural unreachability of the cooperative path
— is the defect this ADR closes, and existing turn/budget ceilings still
bound the cost.

**Amendment (2026-10-07, UCT Stage 0 Revision 2.2 pilot, H6 and H7):** two
more model misses now reach the model instead of ending its session. (1) A
turn the provider cut off at its output-token limit. Every native adapter
reports a typed `stop_reason` (`output_limit` for OpenAI `length`, Anthropic
`max_tokens`, Ollama `length`), and the worker never accepts a cut-off turn
as a final result or as structured output. It records
`model_output_limit_continuation` and gives the model a continuation turn
that says the turn was cut off and asks it to act. Each continuation is an
ordinary turn, counted against `max_turns` and the usage budget; after
`MAX_OUTPUT_LIMIT_CONTINUATIONS` (2) consecutive cut-off turns without a tool
call, the next one ends the session as `model_output_limit`. (2) A
structured reply with no recoverable JSON value. Adapters report it as
`structured_output_unparsed` instead of throwing a protocol error, and the
worker spends the same bounded structured-output corrections on it as on JSON
the contract rejected, using the contract's own `unparsed_reason` when it has
one. Only after those corrections does the session fail
`structured_output_invalid`. In both cases the provider-reported usage of a
turn whose stream completed is recorded even when the turn then fails.

## Alternatives / Roads not taken

**A new host-issued mid-session channel, separate from `history`.**
Rejected: `recordUncomposedToolCall` already proves the existing
`tool_result` channel is sufficient. A second channel duplicates a solved
problem.

**Make every `this.failed()` call recoverable.** Rejected in Decision §2: a
genuine host defect (`invalid_tool_preflight`) would look, from the
model's side, like an ordinary refusal to route around — turns burned
retrying against plumbing that cannot succeed by definition.

**Retry the whole session from the calling harness above
`native-worker.ts`.** Rejected: this reintroduces the "another attempt,
another tool" failure the uncooperative-refusal test flags — full-cost
re-run instead of in-turn recovery, at the point the information already
exists.

## Obligations

### O1 — `preflight()`'s scope-denial branch currently never reaches `history`

`native-worker.ts:844-847` calls only `recordToolResult` (audit) and
`failed` (terminal) on a `preflight` refusal; `history.push` does not occur
between those lines. `NativeToolPreflightResult` (`:256-258`) is the
exported contract both `preflight()` implementations and the dispatcher
share, so this is a property of the current code, confirmed by direct
reading of `:820-991`, not a future claim.

Resolved by this ADR's implementation: the branch this obligation describes
no longer exists as written above. `RECOVERABLE_PREFLIGHT_CODES`
(`native-worker.ts`) now routes `action_scope_command_denied`,
`action_scope_path_denied`, and `action_scope_missing_or_stale` through
`recordRecoverableRefusal`, which does push to `history` (see O3's proof).
`missing_trusted_intent`, `workspace_roots_mismatch`, and the other
host-integrity codes are unaffected and still call `this.failed()`,
matching Decision §2. This obligation's own claim was about the
pre-fix code and stays unverifiable for that historical reason — it was
never meant to be re-proved against the code it motivated changing.

<!-- unverifiable: this obligation states the CURRENT control flow's absence of a history.push, verified by reading, not a new capability a roundtrip test would exercise -->

### O2 — The recoverable-refusal shape reuses `recordUncomposedToolCall`'s existing, tested pattern

`preflight()`'s result type, `NativeToolPreflightResult`
(`native-worker.ts:256-258`), is exported and exercised by
`packages/arbor-harness/tests/native-worker.test.ts`, which
`vitest.config.ts`'s include glob collects — the seam this decision extends
already has real test coverage to extend.

<!-- proof: symbol=NativeToolPreflightResult file=packages/arbor-harness/src/native-worker.ts roundtrip=packages/arbor-harness/tests/native-worker.test.ts -->

### O3 — A recoverable scope denial still never executes the denied action

`execute()` must remain unreached whenever `preflight()` returned
`allowed:false`, exactly as today, with only the terminal-vs-continued
outcome changing.

The recoverable-refusal branch has landed (`native-worker.ts`'s scope-denial
and approval-denial dispatch now calls `recordRecoverableRefusal` instead of
`this.failed()` for the codes named in O1, while `execute()` is still gated
behind the same `admission.allowed`/`resolution.approved` checks). Two new
`native-worker.test.ts` cases drive a denied-then-retried tool call through
the real worker and assert `executed` stays `false` across both the refused
turn and the recovered turn that follows it: "recovers from a host
action-scope preflight denial instead of ending the session, and the
refusal reaches the model's transcript" and "recovers from a denied
approval instead of ending the session, and the refusal reaches the
model's transcript".

<!-- proof: symbol=NativeHarnessWorker file=packages/arbor-harness/src/native-worker.ts roundtrip=packages/arbor-harness/tests/native-worker.test.ts -->

**Implementation note — an operator-facing regression this Decision caused,
and the correction.** Making approval denial recoverable had a consequence
the Decision did not anticipate: because a denied turn now continues, a model
that does not adapt re-proposed the identical call every remaining turn, and
each one put the same settled question to the operator again. Measured on the
real executor, one denied action became 23 approval prompts before the turn
budget ended the session. The guard held throughout — the action never
executed — but re-asking a human 23 times for a decision they already made is
its own defect, and the Consequences section's accepted cost ("a session that
keeps tripping the same boundary can now run longer before failing") was about
turns, not about repeated human interruption.

Corrected by recording the operator's decision for the exact tool and input
they ruled on (`approvalDenialMemo`, following the file's existing `readMemo`
precedent) and re-serving it on any unchanged repeat. Nothing is weakened: a
denial stays a denial, the action still never executes, and the refusal still
reaches the model on every turn, so this Decision's delivery guarantee is
untouched. Only the duplicate prompt is removed. The operator's own rationale
is now also carried in the refusal text the model receives — it was previously
recorded on the `approval_resolved` event, which the model does not read, so a
model was told only "not approved" and had nothing to adapt toward.

<!-- proof: symbol=NativeHarnessWorker file=packages/arbor-harness/src/native-worker.ts roundtrip=packages/arbor-harness/tests/native-worker.test.ts -->

### O4 — The composer's schema-invalid re-prompt still bounds attempts by `MAX_PLAN_ATTEMPTS`

Feeding `parsed.error` back into a retried `plan()` call must consume the
same bounded attempt budget the transient-transport branch already
consumes, so a persistently malformed planner cannot loop forever.

The schema-invalid branch in `task-composer.ts`'s `plan()` now shares the
`transient_transport` branch's loop and `MAX_PLAN_ATTEMPTS` counter,
carrying `parsed.error` forward as `retry_context` on the next `plan()`
call. `task-composer.test.ts`'s "retries a schema-invalid response with the
parse error as feedback (ADR-117 §3), and retries a transient provider
failure, failing only after exhausting the bound" drives a planner that is
persistently schema-invalid and asserts it is called exactly 3 times
(`MAX_PLAN_ATTEMPTS`) before the draft fails with an "after 3 attempts"
message, and a planner that is schema-invalid once then valid recovers on
attempt 2 with `retry_context` populated from the first attempt's parse
error.

<!-- proof: symbol=TaskComposer file=packages/arbor-mcp/src/task-composer.ts roundtrip=packages/arbor-mcp/tests/task-composer.test.ts -->

**Wiring gap found and closed.** `retry_context` was initially added to
`TaskComposerPlannerPort.plan()` and populated by the composer, but no
production planner rendered it: `taskComposerPlanningPrompt` (the prompt every
connector — native, Claude Code, Codex, OpenCode — composes from) did not
declare the field, so the value was passed into the port and dropped. The
retry therefore re-sent a byte-identical prompt and re-rolled the same
deterministic parse failure, at up to three times the planning cost — exactly
the waste the superseded "not retryable" comment existed to prevent, and a
strictly worse outcome than the behavior this Decision replaced. The prompt
now carries the rejection reason, so the retry has something to correct.

<!-- proof: symbol=taskComposerPlanningPrompt file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/task-composer-planning-prompt.test.ts -->
