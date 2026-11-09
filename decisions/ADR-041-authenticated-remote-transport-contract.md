# ADR-041: Authenticated Remote Transport Contract

**Status:** Rejected
**Date:** 2026-08-08

Authored as Proposed: types and tests in this change do not make a network
listener, public endpoint, or credential issuer available.

## Context

ADR-040 deliberately supplies a host-composed, signed ingress boundary rather
than a network service. Before any host exposes that boundary outside a trusted
process, independently implemented clients must agree on exactly what is
signed, how it is encoded, what is safe to retain as audit evidence, and how a
transport retry differs from an idempotent command retry. Ad-hoc sorted JSON
serializers are not a sufficient cross-language security contract.

The Ed25519 plus RFC 8785 choice independently converges with AIP
([arXiv:2603.24775](https://arxiv.org/abs/2603.24775)) and HDP
([arXiv:2604.04522](https://arxiv.org/abs/2604.04522)), both of which use the
same primitives for append-only delegation chains and offline verification.
That convergence supports this contract and its cross-language conformance
obligation; it does not adopt AIP's JWT/Biscuit formats or make either paper's
performance or security claims load-bearing.

## Decision

1. The prospective wire envelope is `revoy2.remote.transport.v1`, specified by
   `remote-transport-contracts.ts`. It contains an allowed catalog command,
   operation metadata, and the ADR-040 remote-session proof. It admits only
   direct-thread send/ack and approval request/decision kinds.
2. The exact signature preimage is the `RemoteTransportSigningEnvelope`: the
   envelope without `proof.signature`. It MUST be serialized as UTF-8 RFC 8785
   JSON Canonicalization Scheme (JCS) bytes before signing or verifying. An
   implementation MUST reject duplicate JSON members, non-I-JSON numbers
   (`NaN`, infinities), unsupported Unicode, or any alternate
   canonicalization label. It MUST NOT substitute host JSON-stringifier output
   or a locale-dependent key sort.
3. A verified audit record retains `proof_digest`, defined as
   `sha256:<lowercase hex SHA-256 of the exact JCS signing bytes>`, plus stable
   session/key/certificate/actor attribution and verification time. It MUST
   NOT retain a raw signature, raw proof, transport authorization header,
   client certificate, private/public key material, or secret in the command
   ledger. This is attribution evidence, not a credential cache.
4. A nonce is a cryptographically random, URL-safe value with at least 128
   bits of entropy. `(session_id, nonce)` is consumed atomically after a
   successful signature and authorization check and before catalog dispatch.
   A repeated nonce is always denied. A retry obtains a fresh nonce but keeps
   the same catalog `operation_id` and `idempotency_key`; the catalog remains
   the authority for exactly-once effect and idempotency conflict behavior.
5. Transport-facing failures use the closed error taxonomy in the contract.
   In particular malformed/untrusted/replayed input is not retried blindly;
   replay-store outage/capacity, rate limit, and transport unavailability are
   explicit retryable operational states. A host maps these to its binding's
   status codes without weakening the typed reason.

## Operating defaults and current boundary

A later accepted decision adds an opt-in bounded HTTP/TLS host using this
contract and ephemeral operation grants. The loopback host remains available
and no network listener has default activation. The optional A2A direct-thread
profile remains host-composed and is not a public A2A wire-conformance claim.

The accepted default deployment posture remains **no network listener**. If an
operator later authorizes one, service-to-service peers use mTLS and clients
unable to hold certificates use DPoP; a first binding selects one of those
models rather than shipping both. An operator-owned CA or managed workload
identity must issue and revoke credentials. Production private keys require a
KMS/HSM-equivalent custody boundary; local disk keys are development-only.
The sender audience is the host, campaign, and direct edge—never a
cross-campaign wildcard.

Before that authorization, per-peer request/storage quotas, a provider-enforced
currency spend cap, a distributed atomic replay store, encrypted channel
confidentiality, and a named independent security review remain external
prerequisites. Current byte/in-flight limits do not represent any of those
controls. The full disposition and sources are in
`docs/research/waiver-decision-brief-2026-08.md`.

## Non-goals

- No HTTP, TLS/mTLS, SSE, WebSocket, A2A, MCP, or OpenCode listener is
  introduced by this decision. The in-process loopback host is not a network
  listener.
- No CA, public discovery, trust-on-first-use, key generation/persistence,
  KMS/HSM integration, enrollment workflow, or distributed replay store is
  selected here.
- This is not an A2A wire-conformance claim and does not change the ledger as
  the sole command authority.
- The existing local-process canonicalization in ADR-040 is not silently
  declared cross-language compatible by this ADR; a future host must implement
  this contract and prove RFC 8785 test vectors before composition.

## Consequences

A later transport host has one compatibility target and can be tested with
shared signing vectors. It must separately decide channel authentication,
certificate issuance/revocation, key custody, quotas, confidentiality, and
distributed replay consistency. Until those decisions and adversarial tests
exist, ADR-040 remains an intentionally uncomposed boundary.

## Obligations

### O1 — Independent review verifies public-transport prerequisites

Before a remote listener is advertised, independent review must verify its RFC
8785 vectors across every supported implementation language, proof-digest-only
audit retention, nonce/retry semantics under concurrent restart, binding of
channel identity to session identity, key custody and revocation operations,
and the failure behavior of the shared replay store. The review must also fetch
and verify the then-current MCP revision; it may not inherit assumptions about
sessions, initialization, discovery, or request metadata from this authoring date.

<!-- unverifiable: ADR-041 remains Proposed pending a host implementation and independent security review. -->
