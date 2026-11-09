# ADR-179: Non-Gate Refusals Project The Same Typed Remedy

**Status:** Accepted
**Date:** 2026-10-06
**Authoring Revision:** 0340135296b271230647f545eb6723873f64a822
**Content ID:** sha256:fb05b353d3a2d2855d7a14c1c64f1aed8b57a7cdcab3fc896dfcb12b9f123002

> **Amendment 2026-10-06:** native tool preflight adds the refusal code `tool_refusal_loop` (a session re-proposing the same refused high-risk call a fourth time). It maps to the existing admission authority in this table: gate `admission`, correcting actor `campaign_planner`, action `repair_plan_or_config`. No new authority.

> **Amendment 2026-10-06 (worker-level loops):** the native worker applies the same limit and the same `tool_refusal_loop` code to refusals it issues itself, which the tool host never sees. Its remedy follows the refusal kind, through pairings already in this table: a repeated hook veto (`hook_denied`) or approval denial (`approval_denied`) maps to gate `tool_veto`, correcting actor `specialist`, action `revise_tool_call`; a repeated call to a tool outside the session's composed set (`tool_not_composed`) maps to gate `capability`, correcting actor `operator`, action `grant_capability`. No new authority.

> **Amendment 2026-10-06 (operator decision):** the `capability` authority gains a third `refused` pair, caller → `request_approval`. A read authorized only by an approved two-party record (`output.raw`) and refused because no matching approval exists (missing, pending, expired, rejected, self-approved, or for another action/resource) no longer gets `reauthenticate`, which would send the caller in a circle. The router attaches `projectApprovalRefusal` (code `approval_not_granted`) at the `output.raw` denial site, so `capabilityDenialProjection` preserves it rather than re-deriving a remedy from the summary text. `RUNTIME_REFUSAL_REMEDIES`, the mcp projection validator and the TUI port mirror change together; `schema_version` stays 2 (additive). Pinned through the real `arbor serve` stdio session in `packages/arbor-mcp/tests/router-session-boundaries.test.ts`.

## Context

ADR-113 made a gate failure carry a remedy, and the v2 refusal contract
(`RuntimeGateRefusalV2` in `packages/arbor-core/src/runtime-contracts.ts`,
projected by `packages/arbor-mcp/src/gate-refusal-projection.ts`) types that
remedy: a correcting actor, a stable corrective-action key, and the
remediation text, with every boundary rejecting an action handed to an actor
who cannot perform it. That contract was bound to the four campaign process
gates (`admission`, `isolation`, `evidence`, `audit`). Three refusal paths
that are not process gates carried no remedy at all:

- **MCP permission denials.** `capabilityDenialProjection` (`cli.ts`) turned a
  router `permission` error into JSON-RPC `-32001` with `kind`, `code`,
  `summary` and `session_id` only. A junior-tier `arbor serve` client was told
  it was denied but not that only the operator can clear it (by relaunching
  with `--trusted-client`), and a stale or forged signed-session proof read
  identically to a tier denial. The 1.0 roadmap's Phase 3 gate ("unauthorized
  and stale-session calls fail closed with a remedy") was unmet.
- **Budget refusals.** A denied campaign-budget reservation
  (`native-agent-executor.ts`, diagnostic `campaign_budget`) or a per-session
  usage-budget refusal (`native-worker.ts`, diagnostic `usage_budget`) became
  an `internal_error` NodeError whose only content was the reason string; the
  operator — the one actor who can raise a configured ceiling — was never
  named.
- **Native tool vetoes.** A governed hook's `tool_preflight` veto
  (`packages/arbor-mcp/src/hooks/bus.ts`, codes `hook_denied` / `hook_veto_failed`) was not in the
  worker's `RECOVERABLE_PREFLIGHT_CODES`, so a policy veto ended the session
  on the refusal turn through `this.failed()`. The model — the actor that
  could choose a different call — never saw the refusal. This is the exact
  dead-end shape ADR-117 closed for scope and approval denials, left open for
  the veto lane added after it.

## Decision

**1. The v2 contract widens to non-gate refusal authorities; no parallel type
is introduced.** `RuntimeGateRefusalV2.gate` becomes `RuntimeRefusalAuthority`
= the four gates plus `capability`, `budget` and `tool_veto`. The actor union
gains `caller`; the action union gains `grant_capability`, `reauthenticate`,
`raise_budget` and `revise_tool_call`. `schema_version` stays 2: the change is
additive, and every in-repository consumer (core validator, mcp projection
validator, TUI port mirror, CLI and TUI renderers) is updated in the same
change. v1 stays bound to the four gates.

**2. One table owns the allowed (actor, action) pairs.**
`RUNTIME_REFUSAL_REMEDIES` and `isAuthorizedRefusalRemedy` in core are the only
source; the mcp projection validator and the core runtime-error validator both
call them, so the two boundaries cannot drift. `refused` pairs: admission →
campaign_planner/repair_plan_or_config; isolation → runtime_host/restore_isolation;
evidence → specialist/attach_verified_evidence; audit → operator/resolve_audit_findings;
capability → operator/grant_capability **or** caller/reauthenticate; budget →
operator/raise_budget; tool_veto → specialist/revise_tool_call. `unavailable`
is always runtime_host/compose_gate_authority.

**3. Each refusal path projects its remedy at the boundary where its
correcting actor reads it.**
- MCP: the `-32001` error data carries `gate_refusal` (`projectCapabilityRefusal`).
  A tier or grant denial goes to the operator with the `arbor serve
  --trusted-client` command; any other permission refusal (missing, stale,
  malformed or mismatched session proof or identity) goes to the caller to
  re-authenticate. A remedy the router already attached is preserved.
- Budget: `nodeError` attaches `projectBudgetRefusal` as an optional `remedy`
  on the `internal_error` NodeError (routing kind and recoverability are
  unchanged). The persistence validator accepts it only as a complete v2
  remedy, and `arbor report` prints the node's correcting actor, action and
  remedy; `--json` carries it in the node outcome.
- Tool veto: the bus attaches `projectToolVeto` to the denial as an optional
  `remedy` on `NativeToolPreflightResult`. `hook_denied` joins
  `RECOVERABLE_PREFLIGHT_CODES` (ADR-117 §1's shape), and the model-visible
  tool result appends the remedy when — and only when — it names the
  specialist. `hook_veto_failed` projects `unavailable` to the runtime host and
  stays terminal (ADR-117 §2). A present but malformed remedy makes the
  preflight result invalid (`invalid_tool_preflight`), never silently dropped.

## Consequences

Every refusal on these three paths now names who can clear it and how, in the
same typed shape process-gate refusals already use, so a client, the operator
CLI and the model each receive a remedy they can act on. A policy veto no
longer ends a session: a non-adapting model spends turns re-proposing a
vetoed call until its turn budget ends the session, the cost ADR-117 already
accepted for scope denials; the guard itself never loosens (the base port
still never executes). Two existing tests that asserted the veto was terminal
were updated to assert the recovered shape.

The widened `gate` field means a strict external consumer that validated v2
against the original four gates will reject the new authorities; no such
consumer exists in this repository, and the alternative (a v3) would have
forced every gate-refusal producer to migrate for an additive change.
Classification of permission denials in `projectCapabilityRefusal` reads the
router's summary prefix (`CapabilityError:` / `missing capability `); a router
that attaches its own `gate_refusal` overrides it, which is the path to retire
that string match.

## Alternatives / Roads not taken

**A separate `authorization.refusal` / `budget.refusal` / `veto.refusal` type
per path.** Rejected: three shapes for one concept is the drift the v2
contract's single validator exists to prevent, and every consumer would need
three renderers.

**Map the new refusals onto the existing four gates** (e.g. a tier denial as
an `admission` refusal). Rejected: the admission gate's only authorized
corrector is the campaign planner, which cannot raise a client's tier, grant a
budget, or re-route a tool call — the remedy would name the wrong actor, the
exact defect commit `eba11b33` made the validator reject.

**Keep the veto terminal and only add the remedy to the session's failure
message.** Rejected: the model is the corrigible actor for a policy veto and
a terminal failure never reaches it — the ADR-117 dead end.

## Obligations

### O1 — One table authorizes every refusal remedy, at both boundaries

A remedy pairing an action with an actor the authority does not authorize is
rejected by the core runtime-error validator and the mcp projection validator
alike, for gate and non-gate authorities.

<!-- proof: symbol=isAuthorizedRefusalRemedy file=packages/arbor-core/src/runtime-contracts.ts roundtrip=packages/arbor-mcp/tests/gate-refusal-projection.test.ts -->

### O2 — Unauthorized and stale-session MCP calls fail closed with a remedy

Through the production stdio session, a junior-tier denial carries a
`capability` remedy for the operator naming `arbor serve --trusted-client`,
and a stale session proof carries one for the caller to re-authenticate.

<!-- proof: symbol=projectCapabilityRefusal file=packages/arbor-mcp/src/gate-refusal-projection.ts roundtrip=packages/arbor-mcp/tests/mcp-conformance.test.ts -->

### O3 — A budget refusal reaches the operator through the node outcome and `arbor report`

A denied campaign reservation yields a NodeError carrying the operator's
`raise_budget` remedy, which survives persistence and is printed by
`arbor report` (human and `--json`).

<!-- proof: symbol=projectBudgetRefusal file=packages/arbor-mcp/src/gate-refusal-projection.ts roundtrip=packages/arbor-mcp/tests/budget-refusal-remedy.test.ts -->

### O4 — A policy veto reaches the model with its remedy; a failed veto stays terminal

Through the real worker, `hook_denied` continues the session with the
specialist remedy in the next turn's tool result and never executes the call;
`hook_veto_failed` ends the session; a remedy for another actor is not
rendered; a malformed remedy is an invalid admission.

<!-- proof: symbol=NativeToolPreflightResult file=packages/arbor-harness/src/native-worker.ts roundtrip=packages/arbor-harness/tests/native-worker-refusal-remedy.test.ts -->

### O5 — The production hook bus attaches the veto remedy the worker delivers

A veto composed through `HookBus.wrapToolPort` and the real
`NativeAgentExecutor` reaches the model's transcript with the
`revise_tool_call` remedy, and the base port never executes.

<!-- proof: symbol=projectToolVeto file=packages/arbor-mcp/src/gate-refusal-projection.ts roundtrip=packages/arbor-mcp/tests/hooks/e2e.test.ts -->
