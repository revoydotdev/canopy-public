# ADR-040: Opt-in Remote Session Ingress

**Status:** Rejected
**Date:** 2026-08-08

Authored as Proposed: implementation does not confer acceptance authority.

## Context

Direct parent-child threads are durable and replayable, but a remote process
cannot be treated as a local TUI process merely because it can produce a
message-shaped payload. Multi-agent communication protocols commonly leave
authentication, authorization, integrity, and session isolation optional or
inconsistently enforced. The risks are magnified by persistent state and long
horizons: an apparently plausible message can acquire authority far beyond the
connection that delivered it.

The local-session proof establishes continuity of a process-held key only. It
does not authenticate a remote principal, scope an external agent to a tree
edge, preserve replay state across restart, or authorize an approval decision.

## Decision

1. `RemoteRuntimeIngress` is an **opt-in, host-composed** boundary for only
   `bus.thread.send`, `bus.thread.ack`, and approval request/decision
   commands. It is not an HTTP server, SSE service, A2A endpoint, or OpenCode
   plugin transport.
2. A host enrols a remote Ed25519 public key in `RemoteSessionAuthority` with
   a key-bound, host-trusted enrolment certificate id, actor id, expiry,
   direct parent-child audiences, and optional approval authority. The
   certificate id deterministically binds `(session, actor, key id, public
   key)`; it is a local trust-registry certificate, not a public-PKI claim.
3. Every accepted remote command signs its canonical kind, metadata, params,
   session/key/certificate identity, timestamp, and nonce. The authority
   checks the signature, key/certificate binding, expiry/skew, revocation,
   direct-edge audience, and a durable nonce replay set **before** dispatch.
   The replay set is bounded by fail-closed capacity; markers are never
   evicted merely to admit an old replay.
4. Rotation atomically revokes the prior key; session revocation denies all
   later proofs. The accepted verifier attribution is persisted in both the
   operation record and a remote direct-thread's append-only communication
   record, without persisting credentials or public-key material there.
5. Authenticated actor identity must equal the metadata actor, message author,
   approval proposer, or approval decider as applicable. The existing approval
   service independently rejects self-approval, so proposer and decider remain
   distinct durable roles.

## Consequences

The authority ledger remains canonical. Remote delivery is a narrow ingress,
not proof that a network, A2A, SSE, or OpenCode transport is implemented.
The bounded loopback host described by ADR-041 remains the default local path.
A later accepted decision now composes this boundary behind an opt-in bounded
HTTP/TLS host and ephemeral operation grants; no listener starts unless
explicitly requested.

The operating defaults for that later decision are deliberately conservative:
no listener by default; mTLS for service-to-service peers or DPoP for clients
that cannot hold certificates (one selected binding, never an invented bearer
scheme); operator-owned CA or managed workload identity; KMS/HSM-equivalent
production key custody; and campaign + direct-edge + host audience with no
cross-campaign wildcard. Those defaults are not evidence that any of those
deployment facilities has been provisioned.

The design takes a defense-in-depth direction supported by AgentTrust's
pre-execution verdict boundary, AgentCanary's trajectory/persistent-state
evaluation, the comparative protocol analysis' call for mandatory message
integrity and session isolation, and the multi-agent threat survey's finding
that existing frameworks leave substantial coverage gaps. See the associated
research note for exact sources and implementation mapping.

No future multi-hop delegation safety case may make verification of an agent's
stated natural-language intent load-bearing. SentinelAgent's Delegation Chain
Calculus ([arXiv:2604.02767](https://arxiv.org/abs/2604.02767)) reports that
intent preservation is the probabilistic outlier among its seven delegation
properties and demonstrates severe failure under semantic ambiguity and
adversarial paraphrase. Future work must instead preserve deterministic
authority narrowing, policy, reconstructibility, cascade containment,
scope/action conformance, and output-schema conformance through signed,
audience-scoped capabilities and fail-closed checks.

## Obligations

### O1 — Independent review verifies remote ingress security semantics

Before acceptance, independent review must verify host enrolment/key and
certificate binding, expiry/skew, rotation/revocation, nonce replay persistence
and capacity denial, direct-edge scope, signature coverage, durable attribution,
idempotency behavior, self-approval denial, and restart-derived handoff state.

<!-- unverifiable: ADR-040 remains Proposed pending independent security review and hostile-transport evaluation. -->
