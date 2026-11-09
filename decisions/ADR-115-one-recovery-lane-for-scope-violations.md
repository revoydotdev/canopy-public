# ADR-115: Scope Violations Have One Recovery Lane, Not Two Disconnected Ones

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** f8312bdb933bf2aa03fe29347f56d7ea9c67f59d
**Content ID:** sha256:d8f459d3cd975765a57c907159b787f9b9cc436f708a384d546924e443b89024

## Context

A scope violation has a real, wired recovery lane in this repo — but only
for one of the two shapes it can take. `manager.ts`'s `reviveNodeForScopeRetry`
(~1056-1062) revives a machine-blocked node without consuming critic-retry
budget:

```
reviveNodeForScopeRetry(campaignId: string, nodeId: string): void {
  const campaign = this.getCampaign(campaignId);
  if (!campaign.tree.has(nodeId)) throw new Error(`Node ${nodeId} not found`);
  reviveScopeBlockedNode(campaign.tree, nodeId);
  this.persistCampaign(campaign);
  this.emit({ kind: "tree.node_changed", campaign_id: campaignId, node_id: nodeId, state: "pending" });
}
```

`loop.ts` (~2352-2549) wires it: `scopeObservation` comes from
`deferredUpgrade.scope_observation`, `blockedScopePaths` is populated only
when `scopeObservation?.enforcement === "blocked"`, `scopeBlocked` follows
from that, and `scopeRetryEligible` (`scopeBlocked && maxScopeRetries > 0
&& priorScopeRetries < maxScopeRetries`) is what gates the call to
`manager.reviveNodeForScopeRetry`. This is a real, cooperative lane — bounded
by `config.scope_retry.max_retries`, distinct from and not competing with
`critic_retry`'s budget — matching the taxonomy's calibration bar for what
a *good* refusal-recovery mechanism looks like.

The gate is the problem. `scopeObservation` is populated from
`deferredUpgrade`, which exists only after a specialist has produced a
candidate result and machine verification has run a post-hoc diff against
the declared scope — `recordResult` is called with the specialist's own
output, and only *then* does `loop.ts` learn whether the diff landed inside
or outside the declared scope. This is ADR-065's Y-1 graduated enforcement:
a real design, correctly evidence-only for the `"audit"` tier
(`~2424-2430`), correctly retry-eligible for the `"blocked"` tier.

But a preflight denial is a different shape entirely. `native-tool-host.ts`'s
`preflight()` (~217-230) refuses `action_scope_command_denied`,
`action_scope_path_denied`, and `action_scope_missing_or_stale` *before* any
tool call executes — there is no specialist output, no diff, no
`deferredUpgrade`, no `scope_observation`. A preflight-refused node never
reaches the `recordResult` call this lane's own gate depends on.
Structurally, `scopeRetryEligible` can never be `true` for the exact class
of violation the pre-authorization ADR-088 built exists to prevent in the
first place — the lane built to recover from "scope was violated" cannot
fire for the earlier, more common case of "scope was never satisfied to
begin with." One concept — a recoverable scope problem, worth one bounded
retry, not an abandoned campaign — has two disconnected pipelines: a live
one reachable only from a post-hoc diff, and none at all for a preflight
denial.

This ADR depends on **G3** (typed failure codes surviving to the routing
layer): `nodeError` in `native-agent-executor.ts` (~1276-1290) today
collapses a preflight refusal's specific code
(`action_scope_command_denied` etc.) into a generic `internal_error` before
it reaches `loop.ts`. Without G3's fix landing first, `loop.ts` has no typed
signal to route a preflight denial *by* — it would only see "internal error,"
indistinguishable from a crash, and could not tell a preflight scope denial
from any other failure to route it into this lane. G5 assumes G3 supplies
that typed code; it does not re-derive it.

## Decision

**A preflight scope denial and a post-hoc scope-blocked diff feed the same
recovery lane, gated by the same `scope_retry_count` budget, through one
shared entry point.**

1. `native-agent-executor.ts`'s `nodeError` (post-G3) preserves the specific
   preflight scope code — `action_scope_command_denied`,
   `action_scope_path_denied`, `action_scope_missing_or_stale` — instead of
   collapsing it to `internal_error`. `loop.ts` gains a second source for
   `scopeBlocked`: alongside the existing
   `scopeObservation?.enforcement === "blocked"` check, a preflight-denial
   code on the node's terminal failure sets the same boolean through the
   same variable, before the `scopeRetryEligible` computation
   (~2546-2548) reads it. Both sources converge on one shared `scopeBlocked`
   flag rather than each carrying its own gate.

2. `scopeRetryEligible`'s formula — `scopeBlocked && maxScopeRetries > 0 &&
   priorScopeRetries < maxScopeRetries` — is unchanged. A preflight denial
   spends the exact same `scope_retry_count` budget a post-hoc block spends;
   this is deliberate, not an oversight — a specialist that repeatedly fails
   preflight and a specialist that repeatedly gets blocked post-hoc are the
   same failure mode (declared or derivable scope does not match what the
   work actually needs) and should exhaust the same bounded allowance, not
   two independent ones that together double the effective retry budget for
   one concept.

3. `manager.reviveNodeForScopeRetry` and `reviveScopeBlockedNode` are
   unchanged — reused as-is for both call sites. This is a routing fix, not
   a new recovery mechanism: the lane ADR-065 built is correct and
   sufficient; it was simply unreachable from one of its two entry
   conditions.

4. The revived node's retry prompt (loaded from `saveRetryContext`'s
   capsule, same as today) is extended to distinguish the two causes in its
   injected rationale — "the declared scope did not cover this action's
   attempted write/command" (preflight) versus "the produced result wrote
   outside the declared scope" (post-hoc) — because a specialist correcting
   from a preflight denial needs to revise its *plan* (it never got to run
   anything), while one correcting from a post-hoc block needs to revise its
   *output* (it already ran something). Reusing one lane does not mean
   erasing the real difference in what the actor should do next.

## Consequences

A specialist whose action was denied at `native-tool-host.ts`'s preflight —
today a dead end unless G1's separate fix (routing the refusal itself back
into the transcript) also lands — gets the same bounded, budgeted retry a
post-hoc scope block already gets, rather than the campaign falling through
to `abandon` (per G3's `FAULT_MATRIX`) for a condition that is, by
construction, correctable: the scope was under-declared or mined
incorrectly, and a retry with a corrected or re-derivable scope can succeed.
This directly composes with G1 and G3: G1 gets the refusal's content back to
the actor, G3 gets its typed cause to the router, G5 gives the router
somewhere cooperative to send it.

The cost is bounded and explicit: the retry budget consumed by a preflight
denial is now shared with post-hoc blocks, so a campaign alternating
between the two failure shapes exhausts `scope_retry_count` faster than if
each had its own counter. This is intentional — a shared budget is what
keeps "one concept, one lane" true — but an operator tuning
`scope_retry.max_retries` is now tuning one number for two distinct failure
moments, not two. Nothing about `preflight()`'s own refusal logic changes;
this decision only affects what happens *after* a refusal.

## Alternatives / Roads not taken

**A second, independent retry counter for preflight denials.** Keeps the
budgets separate, so tuning one does not affect the other. Rejected: it
reintroduces exactly the "two disconnected pipelines for one concept" defect
this ADR closes, just with both pipelines now wired instead of one dead.
Two counters for the same underlying failure mode (scope mismatch) also
lets a campaign retry twice as much as `scope_retry.max_retries` was meant
to bound, defeating the budget's own purpose.

**Route a preflight denial into the existing `critic_retry` lane instead of
`scope_retry`.** Rejected: `critic_retry` exists for a critic's substantive
BLOCK verdict on produced work — conflating a mechanical pre-authorization
mismatch with a content judgment would make `critic_retry_count` conflate
two causes an operator may want to reason about separately (a corrected plan
vs. a corrected implementation), and `governed`-tier's `critic_retry`
eligibility rules (bounded via `isReviewedTier`) were never designed with a
pre-execution failure in mind.

**Leave the preflight-denial case a dead end, and only fix the transcript
visibility (G1) so the model can at least see why it failed.** Rejected as
insufficient on its own: G1 gets the refusal into context, but nothing in
`loop.ts` today revives the node for a corrected attempt — the campaign
still runs out of eligible nodes. Visibility without a routed retry leaves
the actor informed but still unable to act.

## Obligations

### O1 — `scopeRetryEligible`'s budget formula is unchanged by this decision; it is fed, not altered

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager-scope-decision.test.ts -->

`scope_retry_count` and `maxScopeRetries` bounding is exercised today by
`manager-scope-decision.test.ts`'s `CampaignManager` scope-decision suite;
this decision adds a second source for the local `scopeBlocked` variable
inside `packages/arbor-opencode/src/loop.ts` without
touching the counter, cap, or `reviveNodeForScopeRetry`/
`reviveScopeBlockedNode` themselves.

### O2 — A preflight scope denial reaches the same `scope_retry_count` accounting a post-hoc block already reaches, once G3 supplies the typed code

<!-- unverifiable: this obligation depends on G3's nodeError fix landing first (native-agent-executor.ts's nodeError still collapses preflight scope codes to internal_error today) and on loop.ts's second scopeBlocked source, neither of which exists in the tree yet -->

### O3 — The retry prompt distinguishes a preflight-cause revival from a post-hoc-cause revival in its injected rationale

<!-- unverifiable: the cause-specific rationale text this obligation describes is not yet implemented; saveRetryContext's capsule today carries one undifferentiated root-cause string for both cases -->
