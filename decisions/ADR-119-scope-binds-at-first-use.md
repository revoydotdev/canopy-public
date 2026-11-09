# ADR-119: Scope Is Bound At First Use, Not Predicted At Plan Time

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** f8312bdb933bf2aa03fe29347f56d7ea9c67f59d
**Content ID:** sha256:afa7ad5379145e6222f9dadf3f73f1cd6fb12724f78bf0d3c771b4a6afa9bd12

## Context

ADR-088 closed the four-gate native-specialist blocker chain by making
`high_risk_tool_scope` the single mandatory pre-authorization: an action
that mutates repository state must carry a scope declaring the exact write
paths and command argv its executor is authorized to touch, checked once at
admission and enforced identically at every dispatch thereafter. That
enforcement lives in `native-tool-host.ts`'s `highRiskScopeFailure`, and for
commands specifically, in `sameArgv` (~1684-1686):

```
function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}
```

Byte-exact positional equality against the `command_argv` the planner
declared in `native-task-plan-contract.ts`'s `actionSchema` (`command_argv`
is a required key of `high_risk_tool_scope`, itself a required key of every
action — lines 25 and 40-46), declared before the specialist has run
anything. This is a real safety property, not incidental strictness: it is
what lets `cli.ts`'s auto-approve (ADR-088 §3) skip a redundant per-call
approval, because the scope check IS the approval. Weakening it without
replacement would reopen the gate ADR-088 closed.

The property breaks on a real class of commands: any argv whose exact form
depends on something only knowable while running — a generated project name
(`npm create astro@latest site -- --template minimal`), a discovered file
path, a test file chosen after exploration. The planner can only declare
`command_argv` for these by guessing a string it may never run, or by
declaring nothing and hitting "no scope authorized for this action" — the S2
clairvoyance demand this ADR closes. This is not hypothetical:
`deriveNativeHighRiskToolScope`'s own text-mining fallback (ADR-088 gate
2/3) exists because the planner's structured `command_argv` output is
already unreliable for exactly this reason, and mining prose is a fragile
proxy for a fact the planner does not yet have.

The codebase already anticipated this tension.
`native-task-plan-contract.ts`'s `normalizeHighRiskScope` (~99-104) carries
this comment: "Dropping descriptive provider extras can only narrow this
capability; the manager still enforces every declared path and argv
independently at execution time." That is an explicit statement that
plan-time declaration was never meant to be the *only* enforcement point —
execution-time re-checking was already load-bearing. This ADR extends that
posture: plan time declares *intent*, execution time pins down the literal
argv, exactly as `native-tool-host.ts` already re-checks independently of
what the plan says.

## Decision

**Scope binds at first use, within an intent declared at plan time — it is
not predicted at plan time.**

1. `native-task-plan-contract.ts`'s `high_risk_tool_scope.command_argv`
   entries gain a second, alternative shape alongside a literal argv array:
   an *intent* entry `{argv_prefix: string[], purpose: string}`, where
   `argv_prefix` names only the leading, plan-time-knowable tokens of a
   command (e.g. `["npm", "create"]`, or `["npm", "test"]` for an unknown
   spec file) and `purpose` is the same free-text the composer already
   requires elsewhere in a declared action. A literal full-argv entry
   remains valid and preferred whenever the planner genuinely knows the
   exact command — this is additive, not a replacement of exact declaration
   for the common case.

2. `native-tool-host.ts`'s `highRiskScopeFailure` gains a bind-on-first-use
   path for `shell.execute`/`verification.run`: when no literal
   `command_argv` entry matches via today's unchanged `sameArgv`, but an
   *unbound* intent entry's `argv_prefix` is a positional prefix of the
   attempted argv, the call is allowed and that intent slot is bound —
   recorded against the node, alongside the exact argv just observed, in
   the same governance-evidence ledger `CampaignManager` already uses for
   scope decisions (the `getScopeDecisions`/`approveScopeWidening` machinery
   backing `manager-scope-decision.test.ts`). Binding is monotonic and
   single-shot: once bound, every subsequent call against that slot is
   checked with today's unchanged, byte-exact `sameArgv` against the bound
   argv, not the prefix. A different argv under the same intent is refused
   exactly like an unauthorized argv today. The bind event is journaled the
   moment it happens — before the call it authorizes returns a result — so
   audit can see, per node, both what was declared and what was actually
   bound, without re-reading transcripts. That journaling, not a synchronous
   human decision in the turn, is what keeps the bind operator-visible (see
   Alternatives, in-turn negotiation).

3. `governed` tier is untouched, matching ADR-088's own boundary: intent
   entries are available at `direct`/`reviewed` tier only, where auto-approve
   within scope already applies; `governed`'s narrower, fully-literal
   declare-and-reject posture is unchanged.

## Consequences

A specialist can now execute a command whose exact form is genuinely
unknowable at plan time — a scaffolding tool, a generated name, a
discovered test path — without a guessed literal declaration and without
falling back to prose-mining. The planner's job at plan time shrinks to
naming a command's *category* (`argv_prefix` + `purpose`) for this class,
which is a fact it actually has, instead of a fact it does not.

The cost, stated plainly: for the *first* call under an intent slot, the
operator-visible pre-authorization is the command prefix and purpose, not
the exact argv — a specialist could run `npm create astro@latest
malicious-template` under an `["npm", "create"]` intent and it would bind
and execute before any human sees the literal string. This narrows
ADR-088's "bounded, operator-visible authority BEFORE work runs" from
*exact-command* to *category* granularity, for exactly the first use of
each declared intent slot. It is bounded, not open-ended: the prefix is
still declared and admission-checked before any execution, the bind is
recorded as durable evidence the instant it happens rather than silently,
and every call after the first reverts to today's full byte-exact
enforcement with zero drift. Every other property `highRiskScopeFailure`
enforces — write-path exactness, the `governed`-tier boundary, `sameArgv`'s
own comparison logic — is unchanged; `native-tool-host.test.ts`'s existing
exact-match coverage continues to hold for every literal-argv declaration
and for every post-bind call.

This does not solve `S2` universally by itself — a planner that declines to
name even an `argv_prefix` still gets `action_scope_missing_or_stale`,
correctly. It converts an unanswerable demand (name the exact future argv)
into an answerable one (name the command family you intend to run).

## Alternatives / Roads not taken

**Prefix/pattern/allowlist grammar, applied permanently rather than only
until first bind.** E.g. `command_argv` entries as glob/regex patterns
matched forever. Rejected: this converts authorization from "this literal
command" to "any command matching this shape," for the action's whole
lifetime, not just its first call. Argv is executed directly and never
shell-interpreted, so the risk is not injection — it is that a loose
pattern like `["npm", "*"]` authorizes `npm publish` or `npm uninstall`
under a scope the operator believed meant `npm create`. Strictly worse than
bind-on-first-use: it never converges back to exact enforcement.

**In-turn negotiation: specialist proposes argv, an approval gate decides
synchronously.** Rejected on two grounds. A human gate reintroduces exactly
the per-call approval redundancy ADR-088 §3 argued against for in-scope
calls. An automated gate is bind-on-first-use in substance, minus the
requirement that the binding be durably recorded and then re-enforced — a
weaker version of the chosen decision without its safety discipline.

**Narrow the problem: scaffolding commands as one declared category.**
Rejected as the general fix, though it is effectively what an `argv_prefix`
like `["npm", "create"]` already achieves for that one family. A
special-cased allowlist needs a new carve-out for every future shape of
"argv unknowable at plan time" — discovered test files, generated branch
names — each its own bespoke exemption. The intent/bind mechanism handles
any future case with the same one mechanism instead.

## Obligations

### O1 — `sameArgv`'s byte-exact check is unchanged, and governs every post-bind call exactly as it governs every literal declaration today

<!-- proof: symbol=createNativeRepositoryToolHost file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-tool-host.test.ts -->

`sameArgv` itself is not modified; `highRiskScopeFailure`'s existing
exact-match branch is extended with a prior bind-on-first-use branch, not
replaced. `native-tool-host.test.ts`'s existing exact-match coverage proves
today's literal-argv behavior; this decision adds coverage for the
intent-prefix and post-bind paths rather than touching that test.

### O2 — An intent entry can only ever narrow authority to what its declared `argv_prefix` and the observed first call jointly specify — it can never widen beyond what an equivalent literal declaration would have granted

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/scope-bind-manager.test.ts -->

Delivered 2026-08-26 by the tranche owning the full plan-execution-journal
vertical (`arbor-core/src/types.ts`, `persist.ts`, `runtime-contracts.ts`;
`arbor-mcp/src/task-composer-contracts.ts`, `task-composer.ts`, `manager.ts`,
`native-task-plan-contract.ts`, `native-tool-host.ts`,
`packages/arbor-mcp/src/native-tools/contracts.ts`). `CampaignManager.bindNativeHighRiskScope`
constructs the runtime scope handed to the host by splitting a declaration's
`command_argv` into literal entries (unchanged authority) and still-unbound
intents; `native-tool-host.ts`'s `highRiskScopeFailure` only ever widens an
unbound intent to the LITERAL argv actually observed on its first matching
call (`sameArgv` governs every call after), so the bound authority is always
a proper subset of what an equivalent literal `command_argv` entry would
have granted. `scope-bind-manager.test.ts` proves the intent-to-literal
promotion is exact (the promoted entry equals the observed argv, never the
bare prefix), and `scope-bind-native-tool-host.test.ts` proves a
non-matching later argv under the same intent is refused exactly like an
unauthorized argv today.

### O3 — A bind event is durable, attributable evidence at the moment it happens, not reconstructable only from later specialist output

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/scope-bind-manager.test.ts -->

Delivered 2026-08-26, closed in two passes. The first pass (same day) landed
`TreeNode.bound_scope_intents` (`arbor-core/src/types.ts`) as the durable
record rather than a new `ScopeDecisionKind` on the existing
`journalScopeDecision`/`approveScopeWidening` ledger machinery
(`@arbor/audit`): `@arbor/audit` was outside that pass's file ownership, and
`ScopeDecisionKind` is closed to `"approved_widening"`/`"revoked"` with no
`argv` field, so extending it would have required editing a file that pass
did not own. That left the operator's actual acceptance ground --
"the bind is journaled with the exact argv" (`decisions/interviews.jsonl`)
-- resting on mutable campaign state with no hash chain and no tamper
evidence, which a second pass (also 2026-08-26, now owning `@arbor/audit`)
closed: a `ScopeIntentBind`/`ScopeIntentBindRecord` kind
(`packages/arbor-audit/src/audit.ts`), modeled directly on
`ScopeObservationRecord`/`recordScopeObservation` (hash-chained,
`idempotency_key`-idempotent, additive to `AuditRecord` -- `ScopeDecisionKind`,
`scopeDecisionSigningPayload`, and `recordScopeDecision` are untouched, so no
existing signed chain's verification changes). `CampaignManager.recordScopeIntentBind`
-- reached ONLY via the `bind_intent` closure `bindNativeHighRiskScope`
embeds on the runtime scope, itself reachable ONLY from
`native-tool-host.ts`'s bind-on-first-use path -- now journals a
`scope_intent_bind` record (via `persistScopeIntentBind`'s staged/fsync
boundary when persistence is configured) BEFORE it touches the node's
working state; if that journal append throws for any reason, the bind is
REFUSED (`recordScopeIntentBind` returns `false`, the same shape
`bind_intent` already treats as "refuse the call") and `TreeNode.bound_scope_intents`
is never written -- an unjournaled bind is never a granted one. Only after a
successful journal append does it append one `BoundHighRiskIntent` (carrying
the exact observed argv) to the node's own persisted state and call the SAME
`persistCampaign` (fsync'd, atomic) every other durable node mutation in
this file uses. `TreeNode.bound_scope_intents` keeps its own, narrower job --
fast promotion of a bound intent back to a literal `command_argv` entry on
re-derivation -- while the ledger record is the tamper-evident provenance the
operator's acceptance actually rested on.
`scope-bind-manager.test.ts`'s "O3 durability" case proves the working-state
side: it binds an intent, constructs a BRAND NEW `CampaignManager` against
the same `persistence_dir` (a real process-restart simulation), and reads
the exact argv back via `getBoundScopeIntents`. `packages/arbor-audit/tests/scope-intent-bind.test.ts`
proves the ledger side directly: a bind appends a record whose `previous_hash`
links to the prior record's `content_hash`, and a tampered `bound_argv`
(mutated after a JSONL round trip) is caught by `EvidenceLedger.verifyIntegrity`
-- the same hash-chain verification every other record kind in this ledger
already relies on, not a new mechanism.

**Third pass — validator hardening found by review, not by a gate.** Two
asymmetries survived the first two passes, both cases of a new code path being
guarded less tightly than the existing path beside it:

1. `persist.ts`'s `isBoundScopeIntentList` — the snapshot LOAD-path validator
   for bound records — checked only that each `argv_prefix`/`bound_argv` token
   was a non-empty string, while its sibling `isCommandArgvEntry` in the same
   file bounded every token to 4096 bytes and rejected NUL. That gap mattered
   because `bindNativeHighRiskScope` promotes a bound intent back into LITERAL
   command authority, so this validator is the guard on exactly that promotion:
   a tampered snapshot could have carried an oversized or NUL-bearing token
   past a check the original declaration would never have survived. Both token
   lists and `purpose` are now bounded identically to the declaration
   validator. Five `scope-bind-persist.test.ts` quarantine cases cover it;
   reverting the tightening turns four of them red.

2. `native-tool-host.ts`'s `validHighRiskScope` applied the same weaker check
   to `command_intents` that it already applied strictly to `command_argv`
   two lines below. Now symmetric.

Separately, and for ADR-118's sake: the command refusal named only
`scope.command_argv`, so an actor holding an unbound intent was told it had
less authority than it actually did — the precise failure ADR-118 exists to
prevent, reintroduced by this ADR's new authority kind. The refusal now also
names the still-unbound intents and that the first matching call binds one,
bounded by the same `AUTHORITY_DESCRIPTION_ITEM_LIMIT` the literal describer
uses.

### O4 — `governed` tier never gains intent-entry authorization; its fully-literal declare-and-reject posture from ADR-088 is untouched

<!-- proof: symbol=createNativeRepositoryToolHost file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-tool-host.test.ts -->

This decision gates intent entries to `direct`/`reviewed` tier by
construction, mirroring the tier boundary ADR-088 O3 already proves for
approval widening; `native-tool-host.test.ts`'s scope-refusal coverage,
which exercises the tier-independent parts of `highRiskScopeFailure`,
continues to hold unmodified for `governed` sessions.
