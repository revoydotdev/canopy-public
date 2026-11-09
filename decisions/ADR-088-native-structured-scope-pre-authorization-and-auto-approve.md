# ADR-088: Native High-Risk Actions: Structured-Mandatory Scope Pre-Authorization With Tier-Scoped Auto-Approve

**Status:** Accepted
**Date:** 2026-08-24
**Authoring Revision:** a6934253be353c88dcec7f829c3c90ac49128e10
**Content ID:** sha256:36bb930895c6ca0d4714a0d1cf759806eb03b1d2fdc1927592605fe5f2d8c824

## Context

A 2026-08-24 native-specialist bench series (recorded in the operator's
`native-parity-register` scratchpad) drove `arbor task` end to end at
`reviewed` tier and hit a chain of four per-tool-call pre-authorization
gates, each stopping a native (deepseek-v4-pro) specialist that a connector
(claude-code CLI) dispatch clears without incident:

1. **Adapter fatal-on-unknown-tool** — fixed earlier (a hallucinated tool
   name crashed the whole campaign node instead of producing a recoverable
   turn).
2. **`high_risk_tool_scope` missing** — the native planner did not reliably
   populate the structured scope field its own prompt asked for; fixed by a
   text-mining fallback (`extractDeclaredScope`,
   `CampaignManager.deriveNativeHighRiskToolScope`) that derives write/command
   authority from the action's own declared text when the planner leaves it
   null, bounded to non-`governed` tiers.
3. **Command argv not recognized** — the mining regex missed some
   verification-phrase wording and never split compound `A && B` commands;
   fixed by broadening phrase recognition and splitting compound commands.
4. **Approval denial** — even with an in-scope, correctly-derived
   `high_risk_tool_scope` and an authorized command argv, the specialist's
   `shell.execute`/`verification.run` call still failed with `"tool action
   was not approved"`. `NativeSystemPolicyApprovalPort`
   (`native-system-policy-approval.ts`) is a static, tier-blind tool-name
   allow-list (`file.write`, `file.patch`, `peer.query`, `peer.reply`, plus
   MCP connector tools) composed once in `cli.ts`; it never included the two
   tools a declared command actually dispatches through, at any tier.

The operator's own read of the pattern (`native-parity-register`'s
"ARCHITECTURE DECISION" entry) named the real problem: each gate is a
separate place a native specialist can get stuck, each demanding either
perfect planner-model structured-output adherence or another fragile
text-mining fallback. Two designs were on the table:

- **(A) Structured-mandatory + auto-approve within scope.** Make the scope
  field itself the single mandatory pre-authorization: an action that
  mutates repository state MUST carry (or have derivable) a
  `high_risk_tool_scope`, admission-checked and repaired/rejected up front;
  a tool call that lands within that already-verified scope is
  pre-authorized by construction, so a separate per-call approval on top of
  it is redundant, not additional safety. The critic (still dispatched at
  `reviewed`, per ADR-062) remains the independent post-hoc review.
- **(B) Isolation-first.** Drop the per-tool-call scope/approval gates
  entirely inside the specialist's isolated, OS-sandboxed worktree; audit
  the diff against the declared scope only at RESULT ADOPTION time (mirroring
  the connector lane's own worktree-isolation-plus-fenced-adoption model,
  WA-67's `--expand-scope`).

The operator chose **(A)**, explicitly rejecting (B) for this tranche: (B)
would have required extending trust to the OS sandbox as the sole real-time
enforcement boundary for every native tool call, a bigger and less
reviewable surface change than tightening an already-designed,
already-tested pre-authorization contract that was one field away from
working. (A) also composes directly with the two robustness fixes already
landed for gates 2–3 rather than obsoleting them.

## Decision

**1. `Action` gains a composer-owned mutation-intent field.**
`packages/arbor-core/src/types.ts`'s `Action` gains an optional
`mutating?: "read_only" | "mutating"`, documented as set ONLY by the task
composer's own classification at plan-materialization time — never trusted
from planner/model-authored proposal JSON. The schema enforces this
structurally: `task-composer-contracts.ts`'s `validateAction` does not list
`"mutating"` among the fields an incoming proposal may carry, so a planner
that emits one is rejected as an unsupported field, not silently adopted.
The field is optional (matching every other additive `Action` field —
`execution_role`, `skill_id`, `decomposition_depth`, `depends_on`) rather
than mandatory, because `Action` literals are constructed across every
package in the monorepo; making it required would force an unrelated,
unowned edit at every one of those call sites for a classification only the
task composer's own admission path needs.

**2. The composer validates — and repairs before rejecting.**
`task-composer.ts`'s new `classifyAndRepairMutatingActions(proposal, tier)`
runs inside `confirm()`, immediately before `admission.admit(...)`, on the
materialized action set (never persisted back onto the draft's own
`proposal`, which stays exactly what the planner produced for idempotent
replay). It reuses `arbiter-intake.ts`'s `MUTATING_VERBS`/
`READ_ONLY_INTENTS` heuristic, factored out as the shared
`classifyActionMutation`, to classify each of `proposal.actions` from its
own `description`. For `direct`/`reviewed` tier: a `"mutating"` action that
already carries a non-empty `high_risk_tool_scope` is left untouched; one
that does not is REPAIRED by mining `extractDeclaredScope` over the
action's own description plus its `acceptance_checks` — the exact same
declared-scope heuristic `CampaignManager.deriveNativeHighRiskToolScope`
already applies at dispatch time, so repair can only narrow authority to
what the action's own text names, never widen it. Only when nothing is
derivable does admission reject the whole plan with a legible,
action-identifying error — catching a malformed plan here, at admission,
instead of stranding a dispatched specialist mid-session on `"action scope
missing"` with no way to self-correct. `governed` tier (and an absent/null
tier, the same fail-safe default `classifyGovernanceTier` itself uses) is
exempt from the repair-or-reject requirement — actions are still tagged for
audit, but never mined or hard-rejected for an omitted scope. This mirrors
the EXACT tier boundary `deriveNativeHighRiskToolScope`'s own mining
fallback already draws: a governed multi-action plan deliberately leaves
many actions read-only by omission (real planner decomposition, not an
authoring gap), so applying the mandatory-scope rule there would over-grant
authority the plan never intended and regress today's governed admission
behavior. `proposal.root_action` is tagged for audit continuity only and
never required to carry a scope — it is the tree's anchor node, not
normally dispatched as executable work.

**3. Approval auto-grants within the tier that already enforces scope.**
`native-tool-host.ts`'s `preflight()` (run by `NativeHarnessWorker` for
every high-risk tool call BEFORE `approvals.decide` is ever reached — see
`native-worker.ts`) already refuses, unconditionally and at every tier, any
call whose target falls outside the action's declared-or-mined
`high_risk_tool_scope` (`highRiskScopeFailure`'s write-path/`sameArgv`
checks — untouched by this decision). By the time an approval decision is
needed, the scope check has already run: the declared/mined scope IS the
pre-authorization for this call. `cli.ts`'s approval composition
(`nativeApprovalAllowedTools`) now widens its allow-list with
`shell.execute`/`verification.run` — the two tools a declared command
argv actually dispatches through — but ONLY for a session whose campaign is
`direct`/`reviewed` tier; `governed` keeps today's narrower list (file
writes/patches and peer messaging only, never command execution), and an
unknown/evicted session fails to that same narrower list. `CampaignManager`
exposes the tier lookup as `governanceTierForSession(sessionId)`, backed by
a small (512-entry, FIFO-bounded, never persisted) cache populated as a side
effect of `deriveNativeHighRiskToolScope` — the one call every specialize
session already makes, with the matching `campaign_id`, before any tool
dispatch — so no new plumbing was added through
`NativeAgentExecutor`/`NativeHarnessWorker`, which own session mechanics,
not tier semantics. The independent critic (still dispatched at `reviewed`,
per ADR-062, never waived) remains the post-hoc review layer; auto-approval
replaces a redundant duplicate of the scope check, not the review that
actually catches a wrong implementation.

## Consequences

The four-gate blocker chain the register documented is closed
mechanistically rather than by another prose-mining patch: an
under-specified planner output is caught and repaired (or legibly rejected)
at admission, and a correctly-scoped, correctly-authorized high-risk tool
call no longer dead-ends on a redundant approval gate. `governed` tier's
posture is unchanged in both directions — no new mandatory-scope
enforcement, no widened approval allow-list — matching the isolation
diligence a full-decomposition multi-action plan already implies. Native
`reviewed`/`direct` tier reaches parity with the connector lane's
demonstrated harness-builds-itself proof for the one blocker class this
tranche targets; the operator's alternative (B, isolation-first) remains
available as a future, larger architectural move if a future bench finds
scope pre-authorization insufficient on its own — this decision does not
foreclose it, only defers it in favor of the smaller, already-tested fix.
The `mutating` field is a genuinely new closed-enum surface on `Action`;
because it is optional, every existing `Action`-constructing call site
outside the task composer (fixtures, other admission paths, other
packages) is unaffected and continues to admit exactly as before.

## Obligations

### O1 — A mutating action cannot be materialized without a scope at `direct`/`reviewed` tier

<!-- proof: symbol=classifyAndRepairMutatingActions file=packages/arbor-mcp/src/task-composer.ts roundtrip=packages/arbor-mcp/tests/task-composer.test.ts -->

`classifyAndRepairMutatingActions` classifies every action, repairs a
missing scope by mining the action's own description/acceptance checks, and
rejects with a legible, action-identifying error only when nothing is
derivable — proven by `task-composer.test.ts`'s `classifyAndRepairMutatingActions
(scope pre-authorization + auto-approve)` suite (tag/leave-untouched, mine-and-repair, reject-with-legible-error,
governed/unknown-tier exemption) and its `confirm()` end-to-end case, which
drives a real malformed reviewed-tier proposal through `submit()`/`confirm()`
and asserts the draft fails with the scope error rather than admitting.

### O2 — A model/planner cannot set `Action.mutating` directly

<!-- proof: symbol=validateTaskComposerProposal file=packages/arbor-mcp/src/task-composer-contracts.ts roundtrip=packages/arbor-mcp/tests/task-composer-proposal-parser.test.ts -->

`validateAction`'s closed allowed-field set for a parsed proposal action
does not include `"mutating"`; a planner/model that emits it is rejected as
an unsupported field via `validateTaskComposerProposal`'s existing
"unsupported or missing fields" check — the same structural mechanism that
already governs every other closed action field.

### O3 — A within-scope high-risk tool call reaches approval and is granted at `reviewed`/`direct` tier, never at `governed`

<!-- proof: symbol=nativeApprovalAllowedTools file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/native-approval-tier.test.ts -->

`nativeApprovalAllowedTools` widens the approval allow-list with
`shell.execute`/`verification.run` only for `direct`/`reviewed` tier,
unchanged (narrower) for `governed` and for an unknown tier.
`native-approval-tier.test.ts`'s end-to-end suite reproduces `cli.ts`'s
exact composition (`governanceTierForSession` +
`nativeApprovalAllowedTools` + `NativeSystemPolicyApprovalPort`) against a
real `CampaignManager`: a reviewed-tier session's `shell.execute` request is
denied before its scope is derived and approved after
(`deriveNativeHighRiskToolScope` runs, recording the tier), while the same
sequence for a governed-tier session stays denied.

### O4 — The scope preflight itself is unchanged: an out-of-scope call still refuses regardless of tier or approval

<!-- proof: symbol=createNativeRepositoryToolHost file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-tool-host.test.ts -->

This decision touches no line of `highRiskScopeFailure`'s write-path or
`sameArgv` command-argv matching. `native-tool-host.test.ts`'s existing
out-of-scope-refusal coverage is unchanged and still green, proving the
approval widening in O3 cannot itself grant an out-of-scope effect — it
only stops re-denying an already in-scope one.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority
separate from the implementation and authoring authority used in this
tranche.
