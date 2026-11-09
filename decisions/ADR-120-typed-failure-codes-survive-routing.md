# ADR-120: A Typed Failure Code Survives To The Layer That Routes It

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** f8312bdb933bf2aa03fe29347f56d7ea9c67f59d
**Content ID:** sha256:22e706ef3ab4699fa6431eeb193ac9bd836cb2c271a536c00818039962010188

## Context

G1 makes actor-correctable scope and approval refusals recoverable inside a
session, so most of them never end a session at all — the model tries
again in the same turn window. That leaves a residual: sessions that still
end in `this.failed()` (G1's Decision §2 host-integrity codes, or a
recoverable refusal the model never worked around before turns or budget
ran out) still surface at the campaign/routing layer as a `NodeError`. What
that layer does with them today collapses a real distinction the codebase
already computed and then threw away.

`native-agent-executor.ts`'s `nodeError` (`:1276-1291`) is the function
that turns a closed session's event stream into a `NodeError`. It reads the
most recent `diagnostic` event and its `code` (`:1277-1278`:
`const code = diagnostic?.payload.code ?? "native_failure"`) — this is the
exact string `native-worker.ts`'s `failed()` recorded, e.g.
`action_scope_path_denied` from `admission.code` at `native-worker.ts:846`,
or `approval_denied`, or `tool_preflight_failed`. `code` is then used for
exactly two comparisons — `code === "model_retry_exhausted"` and
`inspection.terminal?.cause === "wall_clock_limit"` (`:1280`) — and for
every other value, including every policy-refusal code named above, the
function falls through to `:1290`: `return { kind: "internal_error",
recoverable: false, provenance, message: terminalMessage(inspection) }`.
The specific code that was available at the call site is read into a local
variable and discarded one line later.

`NodeErrorKind` (`packages/arbor-core/src/types.ts:210-217`,
`NODE_ERROR_KINDS`) is a closed, five-member union: `timeout`,
`context_window_exceeded`, `quota_exceeded`, `transport_error`,
`internal_error`. `loop.ts`'s `FAULT_MATRIX`
(`:1060-1066`) is a `Record<NodeErrorKind, ...>` — necessarily exhaustive
over that union — and maps `internal_error: { telemetry_outcome:
"failure", recovery: "abandon" }` unconditionally (`:1065`). There is no
branch inside `FAULT_MATRIX` that can see `action_scope_path_denied`; by
the time a `NodeError` reaches it, that fact no longer exists. A
deterministic guard operating exactly as designed — a specialist that
exhausted its turns still outside its authorized scope — is routed through
the identical path as a process crash, a malformed provider response, or
any other genuine `native_failure`.

This is live today independent of G1: `tool_preflight_failed`,
`invalid_tool_preflight`, `missing_trusted_intent`, and
`workspace_roots_mismatch` are host-integrity failures G1 deliberately
leaves terminal, and each already lands in this catch-all. G1 reduces how
often the fall-through fires; it does not eliminate it or fix what it
discards.

## Decision

**1. `NodeErrorKind` gains a `"policy_refused"` discriminant carrying the
real code, following the file's own precedent for a non-boolean payload.**
`NodeError`'s existing `context_window_exceeded` member already carries a
typed payload beyond `kind` — `signal: ContextOverflowSignal`
(`packages/arbor-core/src/types.ts:234`) — rather than flattening detail
into `message`. `NODE_ERROR_KINDS` (`:210-216`) gains `"policy_refused"`,
and `NodeError`'s union (`:224-237`) gains `(ProvenanceBackedOutcome &
{ kind: "policy_refused"; code: string; recoverable: boolean })`, mirroring
`transport_error`'s and `internal_error`'s existing `recoverable: boolean`
field. `code` is deliberately a `string`, not a second closed enum: the set
of policy codes a preflight or admission check can produce is owned by
`native-tool-host.ts` and neighboring hosts, not by `arbor-core`'s type,
and a closed enum here would recreate exactly the coupling `NodeErrorKind`
avoids by staying five members wide.

**2. `nodeError` recognizes the known policy-refusal codes before falling
through to `internal_error`.** A `POLICY_REFUSAL_CODES` set —
`action_scope_command_denied`, `action_scope_path_denied`,
`action_scope_missing_or_stale`, `approval_denied` — is checked in
`nodeError` (`:1276-1291`) ahead of the existing `model_retry_exhausted`/
`wall_clock_limit` branch. A match returns `{ kind: "policy_refused", code,
recoverable: true, ... }`; everything else still falls through to
`internal_error` exactly as today. The four codes are the same set G1
Decision §1 names as actor-correctable — this ADR does not invent a second
list, it reads the one G1 already drew.

**3. `FAULT_MATRIX` gets a `policy_refused` entry; recovery policy stays
`"abandon"` for now, deliberately.** The `Record<NodeErrorKind, ...>` type
requires an entry for every discriminant, so `:1060-1066` gains
`policy_refused: { telemetry_outcome: "failure", recovery: "abandon" }`.
This ADR does not change what happens to a `policy_refused` node today —
only that the loop, telemetry, and any future consumer can now tell it
apart from a crash. Deciding whether `policy_refused` should route to
`"retry"` or `"decompose"`, and how it should interact with `manager.ts`'s
`reviveNodeForScopeRetry` lane, is left to whichever decision takes that
up; this ADR supplies the fact, not the routing policy built on it.

## Consequences

Telemetry, dashboards, and any future recovery hook can distinguish "the
model tried something outside its authority and the guard worked" from
"the process crashed," where today both are one `internal_error`. A later
decision that wants to route `policy_refused` differently — for example,
gating `manager.ts:1055-1062`'s `reviveNodeForScopeRetry` on this typed
code instead of only a critic's post-hoc diff — has a fact to route on
that does not exist today.

This ADR changes no recovery behavior by itself: `policy_refused` maps to
`"abandon"`, identically to today's `internal_error` outcome for the same
underlying failures. That is a deliberate, stated boundary, not an
oversight — see Alternatives. It also does not reduce how many sessions
reach `nodeError` at all; that is G1's job. `POLICY_REFUSAL_CODES` is a new
string set that must be kept in sync with the codes `native-tool-host.ts`
actually produces — a small, explicit coupling, accepted because the
alternative (matching on a substring of `message`) is fragile, and the
codes it lists are load-bearing constants already, not incidental strings.

## Alternatives / Roads not taken

**Decide `policy_refused`'s recovery policy (retry/decompose) in this same
ADR.** Rejected: that decision depends on whether a scope amendment or
retry is even possible for the failed node, which is `manager.ts`'s and a
sibling decision's concern (the survey's own G5 names the disconnected
recovery-lane problem directly). Bundling routing policy into a
type-fidelity fix risks getting the type shape accepted while its intended
consumer is still unbuilt, or vice versa.

**Keep `code` inside `message` and pattern-match it downstream instead of
adding a `NodeErrorKind`.** Rejected: this is exactly today's failure mode
one layer down — a fact that exists gets encoded as unstructured text a
future reader must parse back out, instead of surviving as a typed field. A
`FAULT_MATRIX` keyed on a regex over `message` is strictly worse than one
keyed on the discriminant the type system already enforces exhaustively.

**Make `code` a second closed enum instead of `string`.** Rejected:
`arbor-core` would then import or duplicate every policy code
`native-tool-host.ts` (and any future host) defines, inverting the
package's dependency direction for no benefit over what `kind`'s five-way
switch already gives `FAULT_MATRIX`.

## Obligations

### O1 — `nodeError`'s catch-all currently discards `diagnostic.payload.code` for every non-timeout, non-retry-exhausted failure

`native-agent-executor.ts:1276-1291` reads `code` at `:1278` and uses it
only in the `:1280` comparison; every other value reaches `:1290`'s
`internal_error` return with `code` unreferenced. Confirmed by direct
reading, including the current five-member `NodeErrorKind`
(`packages/arbor-core/src/types.ts:210-217`) and `FAULT_MATRIX`'s
unconditional `internal_error -> "abandon"` (`packages/arbor-opencode/src/
loop.ts:1060-1066`).

<!-- unverifiable: this states the CURRENT control flow and type shape, verified by reading native-agent-executor.ts:1276-1291, arbor-core/src/types.ts:204-237, and loop.ts:1060-1066; not a claim requiring a roundtrip test -->

### O2 — The new `policy_refused` kind follows an existing typed-payload precedent, not a novel shape

`context_window_exceeded`'s `signal: ContextOverflowSignal` field
(`packages/arbor-core/src/types.ts:234`) is the exported precedent this
decision's `policy_refused.code: string` mirrors — a `NodeError` member
already carries structured detail beyond `kind`/`message` today.

<!-- proof: symbol=NodeError file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-opencode/tests/loop.test.ts -->

### O3 — `FAULT_MATRIX` remains total over `NodeErrorKind` after `policy_refused` is added

`Record<NodeErrorKind, ...>`'s exhaustiveness is enforced by the TypeScript
compiler, not by a runtime test — adding `"policy_refused"` to
`NODE_ERROR_KINDS` without a matching `FAULT_MATRIX` entry fails
compilation, not a passing test suite silently.

<!-- unverifiable: this is a compile-time exhaustiveness guarantee of code this ADR proposes; it becomes checkable by `tsc` once the member and the FAULT_MATRIX entry are both added, not by a roundtrip test of current behavior -->

### O4 — `POLICY_REFUSAL_CODES` names exactly the codes G1 Decision §1 makes recoverable, not a superset

The set this ADR checks in `nodeError` (`action_scope_command_denied`,
`action_scope_path_denied`, `action_scope_missing_or_stale`,
`approval_denied`) must stay identical to G1's actor-correctable list, so
the two ADRs do not silently diverge on which codes are "the recoverable
ones."

<!-- unverifiable: this is a cross-ADR consistency obligation between G1's Decision §1 code list and this ADR's POLICY_REFUSAL_CODES set; no single symbol/test pair proves agreement between two prose lists, and both lists describe code that does not yet exist -->
