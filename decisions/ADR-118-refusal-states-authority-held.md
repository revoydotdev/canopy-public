# ADR-118: A Refusal States The Authority Held, Not Only The Authority Denied

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** f8312bdb933bf2aa03fe29347f56d7ea9c67f59d
**Content ID:** sha256:b2b1a1fcdc3a45ac7d4524c18408751bf2deb3ce55b93f7634f0fa99c5d79f6d

## Context

G1 makes scope and approval refusals reach the model as a `history`
`tool_result` instead of terminating the session silently. That fixes
*delivery*. It does not fix *content*: today's refusal text and the one
proactive authority note the codebase already sends both describe only what
was denied or omit the specialist's authority entirely, so even a delivered
refusal leaves the actor to guess what it may still do.

Two call sites, read directly:

- **The refusal itself.** `highRiskScopeFailure`
  (`native-tool-host.ts:242-278`) builds its `reason` string from only the
  denial: `:268` for a path outside `scope.write_paths` ("execution
  refused: write path exceeds the system-owned action scope") and `:274`
  for a command outside `scope.command_argv` ("execution refused: command
  argv exceeds the system-owned action scope"). `scope` itself —
  `this.resolveHighRiskScope?.(request) ?? null`, resolved at `:246` in the
  same function — holds `scope.write_paths` and `scope.command_argv` for the
  entire body of `highRiskScopeFailure` and is never read into either
  message. The function that refuses the action is holding the answer to
  "then what may I do instead" and does not say it.

- **The one proactive note that exists.** `coherenceScopeNote`
  (`native-agent-executor.ts:1229-1235`) already tries to prevent this
  class of refusal by telling a specialist its authorized paths and
  commands up front, folded into its prompt at `:579`. Its first line is
  `if (scope === null) return null;` — no note at all. Tracing `scope`
  (bound as `highRiskScope` at `:570`) shows this is genuinely ambiguous:
  `fixedReadOnly` short-circuits `tools` to `[]` and skips
  `specialistTools`/`coherenceScopeNote` entirely when a task is truly
  read-only (`:568, 571`), so reaching `coherenceScopeNote` at all means
  high-risk tools — `file.write`, `shell.execute` — are already composed
  via `nativeRepositoryToolPorts` (`:738`) and on the specialist's tool
  list. A `null` scope at that point means the manager granted *zero*
  write/command authority for a task that nonetheless offers high-risk
  tools; the specialist gets exactly the same (no) note it would get with
  full, unconstrained authority. It discovers it holds nothing only by
  trying and hitting `highRiskScopeFailure` — which, per G1, currently ends
  the session outright.

## Decision

**1. `highRiskScopeFailure` states the authority held alongside the
authority denied.** Both denial branches (`:268` path, `:274` command)
build their `reason` string from `scope.write_paths` /
`scope.command_argv` — the same fields already loaded at `:246` — using
`coherenceScopeNote`'s existing phrasing convention (`native-agent-executor.
ts:1229-1235`) rather than a second, divergent format: e.g. "write path
exceeds the system-owned action scope; authorized write paths: `a/b.ts,
c/d.ts`" or, when the relevant array is empty, "no write paths are
authorized for this task." This is prose composed at the refusal site, not
a schema change — `NativeToolPreflightResult`'s `reason: string`
(`native-worker.ts:256-258`) is unchanged, so G1's delivery mechanism
carries the richer text with no further wiring.

**2. `coherenceScopeNote` stops treating "zero authority" and "nothing to
say" as the same `null`.** When `scope === null` but the composed tool set
includes a high-risk port (`fixedReadOnly` is `false`), the note becomes
explicit: "No high-risk write or command authority is authorized for this
task; only read-only actions will succeed." The existing `scope === null`
early return is preserved only for the genuinely read-only case, where
`coherenceScopeNote` is never called today (`:568, 571`) — this decision
removes an ambiguous meaning from an existing call, it does not add a new
caller. The signature stays `(scope: NativeHighRiskToolScope | null):
string | null`; the caller at `:579` already handles a non-null return
identically.

**3. The two texts share one authority-description helper.** Both changes
render the same underlying fact — "here is what `scope.write_paths` /
`scope.command_argv` currently authorize, or that nothing is" — from the
same `NativeHighRiskToolScope | null` shape, so `highRiskScopeFailure`'s
refusal reason and `coherenceScopeNote`'s advance note are built by one
shared function rather than two independently-maintained strings that can
drift. This keeps the two moments — before the attempt and after a denied
one — describing authority identically, which matters once G1 makes the
refusal a mid-session message the model reads next to (or instead of) the
advance note it may have already seen.

## Consequences

A specialist that hits a scope refusal — now delivered per G1 — learns in
the same message what it may still do, closing the "another attempt,
another tool" gap the uncooperative-refusal test names directly: no second
denied guess is needed to discover the boundary. A specialist with zero
high-risk authority but high-risk tools on its list stops discovering that
fact only by spending a turn on a doomed `file.write` or `shell.execute`
call.

Nothing about what is authorized changes. `validHighRiskScope`,
`assertWritePathAllowed`, and `sameArgv` are untouched — this decision adds
description, not scope. The manager's decision to grant zero authority for
a task that still composes high-risk tools is left exactly as it is; this
ADR does not ask whether that composition choice is right, only that the
specialist be told about it before or instead of guessing. The shared
helper adds one more piece of prose two call sites must agree on
maintaining, a small, accepted cost against the alternative of a refusal
and an advance note that can silently drift apart.

## Alternatives / Roads not taken

**Only fix the refusal text (Decision §1), leave `coherenceScopeNote` as
is.** Rejected: a specialist with zero authority would still get no advance
warning at all, spending a turn to discover it via the now-improved but
still-reactive refusal. The advance note is the cheaper place to prevent
the wasted attempt in the first place.

**Only fix the advance note (Decision §2), leave the refusal reason
denial-only.** Rejected: an advance note can be stale by the time an action
executes (a skill-narrowed scope via `narrowScopeToSkill`, or a
mid-session change), and G1 makes the refusal itself model-visible — an
improved delivery channel carrying an unimproved message is only half the
fix the two ADRs together are meant to close.

**Have `coherenceScopeNote` always fire, even for a read-only task.**
Rejected: this restates what the tool list already conveys unambiguously
and adds prompt noise for the common case, with no refusal risk to
prevent.

## Obligations

### O1 — `highRiskScopeFailure`'s current reason strings name only the denial, never `scope`

`native-tool-host.ts:268` and `:274` construct their `reason` argument to
`failure(...)` from a fixed string; `scope.write_paths` and
`scope.command_argv`, both bound at `:246` and in scope for the rest of the
function, do not appear in either. Confirmed by direct reading.

<!-- unverifiable: this states the CURRENT text's content, verified by reading native-tool-host.ts:242-278, not a new capability a roundtrip test exercises -->

**Implemented (Decision §1).** `highRiskScopeFailure`'s two denial branches
(`native-tool-host.ts:268`, `:274`) now build `reason` from
`scope.write_paths` / `scope.command_argv` via `describeAuthorizedWritePaths`
/ `describeAuthorizedCommands` (`packages/arbor-mcp/src/native-tools/contracts.ts`), deterministically
bounded to `AUTHORITY_DESCRIPTION_ITEM_LIMIT` (20) entries so a scope with
hundreds of paths/commands cannot produce an unbounded refusal string.
`assertWritePathAllowed`, `sameArgv`, and `validHighRiskScope` are unchanged —
only the denial message's content changed, not what is authorized.

<!-- proof: symbol=describeAuthorizedWritePaths file=packages/arbor-mcp/src/native-tools/contracts.ts roundtrip=packages/arbor-mcp/tests/authority-refusal-text.test.ts -->
<!-- proof: symbol=describeAuthorizedCommands file=packages/arbor-mcp/src/native-tools/contracts.ts roundtrip=packages/arbor-mcp/tests/authority-refusal-text.test.ts -->

### O2 — `coherenceScopeNote` returns `null` for a null scope regardless of whether high-risk tools were composed

`native-agent-executor.ts:1229`'s `if (scope === null) return null;` does
not consult which tools `specialistTools` composed; the ambiguity between
"read-only task, no note needed" and "high-risk tools present, zero
authority granted" exists in the current code as read.

<!-- unverifiable: states current behavior verified by reading native-agent-executor.ts:560-581, 676, 738, 1229-1235; not a claim requiring a roundtrip test -->

**Implemented (Decision §2).** `coherenceScopeNote` no longer collapses "zero
authority" into the same `null` that means "nothing to say": a null or empty
scope now returns an explicit "No high-risk write or command authority is
authorized for this task; only read-only actions will succeed." It renders
authority through Decision §3's shared helpers, so the advance note and the
refusal cannot drift.

One deviation from the Decision as written, recorded rather than silently
absorbed: §2 asserts `coherenceScopeNote` "is never called today" in the
genuinely read-only case. That is inaccurate — the call site invoked it
unconditionally, so a null scope under `fixedReadOnly` would have received
the new zero-authority note when it should receive nothing at all. The
signature is preserved as §2 requires; the read-only case is instead gated at
the call site, which makes §2's stated invariant true rather than assumed.

<!-- proof: symbol=coherenceScopeNote file=packages/arbor-mcp/src/native-agent-executor.ts roundtrip=packages/arbor-mcp/tests/authority-advance-note.test.ts -->

### O3 — The shared authority-description helper is built from the same exported scope type both call sites already import

`NativeHighRiskToolScope` is exported from `native-tool-host.ts` (re-export
of `packages/arbor-mcp/src/native-tools/contracts.ts`, imported there via the
`.js`-suffixed ESM specifier ./native-tools/contracts.js per this repo's
module resolution) and imported by both
`native-tool-host.ts:31` and `native-agent-executor.ts:16` — the shared
helper this decision proposes has one existing type to build against, not
two to reconcile.

<!-- proof: symbol=NativeHighRiskToolScope file=packages/arbor-mcp/src/native-tools/contracts.ts roundtrip=packages/arbor-mcp/tests/native-approval-tier.test.ts -->

### O4 — The refusal-side text change does not alter `NativeToolPreflightResult`'s shape

Enriching `reason` with authority-held text keeps `reason: string` on
`NativeToolPreflightResult` (`native-worker.ts:256-258`) unchanged, so
G1's `history.push` delivery mechanism requires no further edit to carry
the richer message.

<!-- unverifiable: this is a non-regression claim about a type shape this ADR does not modify; it is checkable by type-checking the future diff against the unchanged NativeToolPreflightResult declaration, not by a roundtrip test of current behavior -->
