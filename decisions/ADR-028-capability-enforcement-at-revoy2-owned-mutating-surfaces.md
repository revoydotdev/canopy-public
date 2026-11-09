# ADR-028: Capability Enforcement at revoy2-Owned Mutating Surfaces

**Status:** Accepted
**Date:** 2026-08-05 (proposed); accepted 2026-08-06 by revelri

This record exists because ADR-024 Decision point 4 named it. That record
ratified the *host* tool-dispatch boundary (boundary 1) and explicitly refused
to let that answer cover boundary 2 — revoy2's own mutating MCP surfaces —
stating that `capability.ts`/capability-token.ts (capability-token.ts was later deleted; see ADR-024's O4) remaining unwired is "a
deferred decision, not a ratified non-goal" and that "a follow-up gap or ADR
should pick this up explicitly."

## Context

`packages/arbor-core/src/capability.ts` (landed `690cabd`, 2026-08-02) is the
dependency-free decision function used at the catalog boundary:

- `enforceAction(actionClass, tier)` throws `CapabilityError` before a mutation
  when the caller's tier does not meet the action class's required tier.
The former path-scoped token module was removed on 2026-08-08: no genuine
revoy2-owned mutating surface names a filesystem path, so keeping minting and
glob-matching machinery would have been dormant authority rather than
enforcement. Its six reachability waivers were retired by deletion.

`capability.ts`'s own docstring names the intended callers — "any mutating
surface (MCP tool handler, CLI mutator, the ops edit server) can enforce it
identically with no authority of its own." The `ops_edit` example is stale
(deleted in wave 5 under G-17), but the shape it named is not.

**What changed since ADR-024 was drafted.** `packages/arbor-mcp/src/tools.ts`
now exposes `RuntimeCatalogRouter`'s command/query kinds as two standard,
`tools/list`-discoverable MCP tools (`arbor_command`/`arbor_query`), reachable
by any MCP client rather than only this repo's own CLI and webui. Its mutating
kinds include `job.submit`, `campaign.halt`, `recovery.retry`/`abandon` and
`approval.approve`/`reject`. Neither `tools.ts` nor `runtime-catalog.ts`
imports `enforceAction`. So boundary 2's live example is now
an externally reachable surface, not an internal handler.

**What already guards that surface.** `RuntimeCatalogRouter` has its own
capability model: every catalog entry declares a `capability` string, and
`authorized(entry)` checks it against an optional `granted_capabilities` set.
That is a real check — an audit this session proved it fail-closed for
`output.raw` — but note two properties. It is a *transport policy* supplied by
whoever constructs the router, and when `granted_capabilities` is undefined
every capability is granted. It answers "may this transport call this kind",
not "may this actor mutate this resource at this tier".

So the question this record must decide is not "is boundary 2 unguarded" — it
is whether revoy2 wants a second, orthogonal, resource-and-tier-level check in
front of its own mutations, or whether the transport-level capability model is
the intended and sufficient answer.

## Decision

**Option 1, accepted 2026-08-06 by revelri (repository owner): wire
`enforceAction` into `RuntimeCatalogRouter`'s mutating kinds.**

Implemented the same day. The concrete shape:

- **Action class is derived, not tabulated.** `catalogActionClass(entry)` maps
  `direction: "command"` to `preview-confirm` and every query to `read`. Every
  command in the catalog mutates durable state and `preview-confirm` is
  `capability.ts`'s only mutating class, so a per-kind column would be an exact
  restatement of `direction` — a second source of truth for one fact. The
  function is the single place to encode a divergence if a kind ever needs one.
- **Tier is a router option.** `RuntimeRouterOptions.caller_tier` defaults to
  `senior`, matching `granted_capabilities`'s existing omit-to-grant
  convention. This is the load-bearing compatibility choice: revoy2's own
  composition roots are trusted in-process callers, and defaulting to `junior`
  would have silently disabled every command on every current surface. A
  transport that accepts instructions from a party it does not control passes
  `junior` explicitly — that is the case this gate exists for.
- **One evaluation point.** `denialReason(entry)` runs the transport capability
  policy and then the tier gate, and every dispatch site already funnelled
  through `authorized(entry)`, so no mutating kind can be accidentally exempt.
  The refusal a caller receives names whichever check actually rejected it.

**Correction to this record's own option list.** Option 1 was described below as
retiring "all twelve `G-14` waivers". It initially reached only
`enforceAction` and `CapabilityError`; the remaining reporting functions now
have a genuine consumer in `capability.introspect`, which derives every kind's
action class, mutability, and minimum tier from the catalog. The path-scoped
token half was removed rather than given an invented consumer.

The options as originally set out, retained as the record of what was weighed:

1. **Wire `enforceAction` into `RuntimeCatalogRouter`'s mutating kinds.**
   Retires all twelve `G-14` waivers by wiring rather than renewal, which is
   this repository's stated preference. Requires mapping each mutating catalog
   kind to an `ActionClass`, and deciding what tier an MCP client holds — which
   the router does not currently model, since `granted_capabilities` is a flat
   string set with no tier concept. The open sub-question ADR-024 flagged
   remains: whether `preview-confirm`-tier gating is the right shape for every
   existing caller.

2. **Wire path-scoped tokens, for path-scoped mutations.** Rejected and later
   removed: most current mutating kinds (`campaign.halt`, `job.submit`) name
   no path, so no honest consumer existed.

3. **Declare the transport capability model sufficient and delete both
   modules.** Makes boundary 2 a ratified non-goal — the thing ADR-024
   explicitly declined to do — and retires the waivers by deletion. Cheapest,
   and forecloses a capability the repo has already built and tested.

4. **Keep them dormant against a named future surface.** Requires stating which
   surface and by when, or it is waiver renewal with extra steps, which the
   reachability gate's dated-expiry design exists to prevent.

## Consequences

**Boundary 2 is now enforced, not merely recorded.** A caller the router treats
as `junior` cannot reach any mutating catalog kind, whatever capabilities it
holds. `packages/arbor-mcp/tests/capability-tier-enforcement.test.ts` proves
both halves separately, because they fail differently: *totality* (every
supported command maps to a gated, mutating action class — checked against the
real catalog) and *enforcement* (the router consults that mapping before
acting — checked end-to-end on both command dispatch paths, since a permission
refusal surfaces as a rejected acknowledgement on one and a failed result on
the other).

**No current surface changes behaviour.** Nothing in revoy2 constructs a router
with `caller_tier: "junior"` today, so this is a capability the repository now
has rather than a restriction it now imposes. That is deliberate — the gate had
to land without breaking the trusted in-process callers — but it means the
honest strength claim is PREVENTED *for a caller that passes `junior`*, and
nothing at all for one that does not. Stating otherwise would be the
documented-but-unwired shape this ADR exists to close.

**The capability reporting functions are observable**, rather than waived:
`capability.introspect` reports the same derived mapping the router enforces.
The path-scoped token half is deleted.

**ADR-024 point 4 is discharged.** `capability.ts` is no longer "a deferred
decision, not a ratified non-goal"; it is wired at the boundary ADR-024
declined to cover, and boundary 1 is untouched.

Whichever option is chosen, `capability.ts`'s tier model has no concept of a
shell command, a file-write syscall or an opencode tool name — ADR-024
established that, and it is why boundary 1 was ratified separately. Nothing
here reopens boundary 1.

## Obligations

### O1 — Action class is derived from catalog direction, not tabulated per kind: every `command` maps to `preview-confirm`, every query maps to `read`

<!-- proof: symbol=catalogActionClass file=packages/arbor-mcp/src/runtime-catalog.ts roundtrip=packages/arbor-mcp/tests/capability-tier-enforcement.test.ts -->

### O2 — Caller tier defaults to `senior` so every existing trusted composition root keeps working unchanged; only a transport that explicitly passes `junior` is gated

<!-- proof: symbol=RuntimeRouterOptions file=packages/arbor-mcp/src/runtime-catalog.ts roundtrip=packages/arbor-mcp/tests/capability-tier-enforcement.test.ts -->

### O3 — A caller the router treats as `junior` cannot reach any mutating catalog kind, whatever transport capabilities it holds

<!-- proof: symbol=RuntimeCatalogRouter file=packages/arbor-mcp/src/runtime-catalog.ts roundtrip=packages/arbor-mcp/tests/capability-tier-enforcement.test.ts -->

### O4 — The catalog exposes derived action-class reporting, and no dormant path-scoped token surface remains

<!-- unverifiable: The read-only authority report is directly unit-tested; it has no durable write/read lifecycle, so a roundtrip citation would overclaim. -->
