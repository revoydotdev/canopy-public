# ADR-084: A Junior-Tier Transport Needs A Surface It Can Reach

**Status:** Accepted
<!-- proof: symbol=enforceAction file=packages/arbor-core/src/capability.ts roundtrip=packages/arbor-mcp/tests/remote-caller-tier.test.ts -->
**Date:** 2026-08-20
**Authoring Revision:** f3dfa824bcd27933b44b55b3e3beaad32bd3fbc0
**Content ID:** sha256:027e85fd6270942435c6a6db1395013636a57b4c76c712ee77b70d9fe6fb5330

**Scope.** This record extends ADR-028's capability-tier decision to the case
ADR-028 named but did not encounter: a transport whose entire surface is
mutating. It does not reopen the tier model, the default, or O3's grant floor.

## Context

ADR-028 (Accepted 2026-08-06) established caller tiers and said plainly which
case the gate exists for:

> "revoy2's own composition roots are trusted in-process callers, and defaulting
> to `junior` would have silently disabled every command on every current
> surface. A transport that accepts instructions from a party it does not
> control passes `junior` explicitly — that is the case this gate exists for."

It also recorded, deliberately, that nothing constructed a junior router yet:
"this is a capability the repository now has rather than a restriction it now
imposes."

Eight days later the repository built `arbor remote-serve` — an authenticated
HTTP listener accepting signed envelopes from a party it does not control. That
is exactly the transport ADR-028 described, and it was never connected to the
tier. `enforceAction` has therefore never been able to fire: `caller_tier` is
optional and resolves to `senior` for every composition root in the repository.

The wiring was built and verified on 2026-08-19, then held, because it produces
an outcome ADR-028 did not anticipate.

**The remote surface is entirely mutating.** `RemoteRuntimeIngress.dispatch`
forwards exactly five kinds — `bus.thread.send`, `bus.thread.ack`,
`approval.request`, `approval.approve`, `approval.reject` — and rejects
everything else outright. It exposes no query kind at all.
`catalogActionClass` maps every `command` to `preview-confirm`
(`runtime-catalog.ts:2179`), and `preview-confirm` requires `senior`
(`capability.ts:31`).

So a junior remote caller is refused on **100%** of the surface. ADR-028's model
assumes a junior transport retains a read surface and loses only mutation. This
transport has no read surface to retain.

## Decision

**Declare the remote transport senior-only, and say so at the check** (path 3
of the three this record originally posed; decided by operator interview
2026-08-24, `decisions/interviews.jsonl`). The transport is trusted by
authentication rather than by tier: signed envelopes bound to a verified actor,
plus the `remote-grant` capability policy layered on top. The comment at the
`remote-serve` composition root states that the tier gate is not what protects
this transport, so nobody mistakes the senior default for an oversight.

Two paths were considered and not chosen:

1. **Give the remote ingress a read surface.** Forward selected query kinds, so
   `junior` means "reads only" rather than "nothing". Largest scope, and it
   expands the network-reachable surface, which is a security decision in its
   own right — one nothing currently motivates.
2. **Reclassify the five remote kinds.** All five are identity-verified —
   `verifyThread` and `verifyApproval` bind the envelope to an actor, and the
   ingress additionally refuses an `approval.request` whose proposer is not the
   verified actor. An action class between `read` and `preview-confirm` for
   identity-bound, non-destructive mutations would let junior reach them. This
   changes the meaning of the tier model and must not be done casually — and
   not for the sake of making a gate fire.

## Consequences

On the remote transport, `enforceAction` deliberately does not fire; that is
recorded at the check site rather than left implicit, and the repository must
not describe the tier gate as what protects `remote-serve`.

The "cannot fire on any surface" finding this record opened with is no longer
the whole picture: since authoring, the stdio `arbor serve` surface — whose
catalog is not entirely mutating — defaults to `caller_tier: "junior"` unless
the operator passes `--trusted-client`, so the tier gate is now a real control
there. This decision settles the remote transport specifically and changes
nothing about stdio.

Paths 1 and 2 would both have made the gate fire on remote by widening what an
uncontrolled party can do — 1 by adding reachable kinds, 2 by lowering the bar
on five existing ones. Neither is justified by any current need, and neither
should ever be adopted merely to make a gate green.

The held implementation is preserved: the seam and its reasoning are recorded in
a comment at `cli.ts`'s `remote-serve` composition root, and
`packages/arbor-mcp/tests/remote-caller-tier.test.ts` proves the mechanism and
documents the consequence. That test builds its own junior router rather than
importing the production composition, so it passes whether or not `cli.ts` sets
the tier — a limit stated in the file. Under path 3 the wiring stays unshipped
by decision; if a future record revisits remote's trust model, pinning the real
composition will need an exported seam.

**Amendment (2026-10-06, security review of `require_local_session`):** only
the TUI router requires a signed local-session proof; every other router runs
without one, and raw `output.raw` reads there are attributed to the label
`unauthenticated-local`. That is intended, not a gap. A local-session proof
carries its own public key, so it authenticates no one. It only binds an actor
id to a key, which matters where the in-process TUI adapter is the router's
only caller. On a transport-reached router the flag would add nothing, and it
would let a peer mint two keys and approve its own request. Each other surface
takes its authority from somewhere else: the in-process CLI from OS process
ownership, stdio `serve` from this record's tier (junior unless
`--trusted-client`), the loopback web dashboard from the bootstrap cookie
(anonymous requests are junior), and `remote-serve` from signed remote proofs
on commands only. Approvals stay refused on all of them without an
authenticated identity (D41). The raw read that `unauthenticated-local` reaches
is authorized by the approved two-party `output.raw` record alone, which is the
same resource-scoped design the TUI uses.
`packages/arbor-mcp/tests/router-session-boundaries.test.ts` drives each real
entry point, so moving the flag onto or off any of them breaks a test.

**Amendment (2026-10-06, operator decision on the same review):** the loopback
web dashboard no longer serves `output.raw` to an anonymous request, even with
an approved record: any local process can reach that port, so the raw read
there now also requires the operator session cookie. Anonymous web callers also
lose `kb.list` and critic_only `context.workspace` reads, and
`GET /api/campaigns/:id/kb` answers them at specialist visibility. Behaviour
behind the cookie, on stdio `serve`, and in the TUI is unchanged, and the local
session flag stays off the web routers. Pinned in
`packages/arbor-mcp/tests/webui-anonymous-disclosure.test.ts` and the web case
of `router-session-boundaries.test.ts`.

## Obligations

### O1 — A junior-tier caller cannot reach any mutating catalog kind, grants notwithstanding

<!-- proof: symbol=enforceAction file=packages/arbor-core/src/capability.ts roundtrip=packages/arbor-mcp/tests/remote-caller-tier.test.ts -->

`enforceAction` refuses `preview-confirm` for a `junior` caller, and no
transport-level grant can raise a caller's tier (ADR-028 O3). This is the
mechanism the senior-only decision leaves deliberately unwired on remote —
so it must stay provably real, not decay into a dead branch.

### O2 — Wiring junior onto the remote composition refuses 100% of its surface

<!-- proof: symbol=enforceAction file=packages/arbor-core/src/capability.ts roundtrip=packages/arbor-mcp/tests/remote-caller-tier.test.ts -->

The roundtrip proves the consequence this record decided around: every kind
`RemoteRuntimeIngress` forwards is `preview-confirm`, so a junior remote router
is refused on every request. If a future change gives remote a read surface,
this obligation's premise breaks visibly and the decision must be revisited.

## Roads not taken

**Shipping the junior wiring as-is.** It is correct per ADR-028 and it silently
disables a working feature with no migration path. A change that makes a
security control honest by breaking the thing it guards is not obviously right,
and it is exactly the kind of decision that should not be made by an agent
mid-task.
