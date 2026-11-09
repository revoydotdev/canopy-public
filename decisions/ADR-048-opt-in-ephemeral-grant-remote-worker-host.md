# ADR-048: Opt-in Ephemeral-Grant Remote Worker Host

**Status:** Accepted
**Date:** 2026-08-12

## Context

ADR-040 and ADR-041 established signed ingress and a transport-neutral wire contract but intentionally shipped no listener. Remote execution additionally needs invocation-scoped authorization and must not import a worker's verification claim as local authority.

## Decision

1. `remote-serve` is an explicit opt-in bound listener. Loopback HTTP is allowed for local operation; every non-loopback bind requires an operator-supplied TLS key and certificate, and wildcard binding requires an additional flag.
2. Every request needs both the existing Ed25519/JCS command proof (where applicable) and an opaque 256-bit operation grant. Grants live for 30 seconds through 5 minutes, name one session/campaign/operation and a closed capability set, are single-use, and persist only a SHA-256 digest.
3. Sensitive grants persist as `consent_required`. Only an affirmative host-side transition makes them ready; request traffic cannot self-consent.
4. A result crossing the boundary is first downgraded to `claimed`. Only an injected local verifier can restore `verified`. `remote_attested` is retained only when explicitly reported; otherwise the grade is `remote_unattested`.
5. The listener is bounded by request, response, and concurrent-request limits. The loopback transport remains unchanged.

## Consequences

The repository now has a real single-tenant remote worker host without making a hosted or multi-tenant claim. Deployment certificate issuance, revocation, and key custody remain operator responsibilities. The CLI's default result verifier conservatively retains claimed provenance; production deployments that want verified adoption must compose a local verifier.

## Obligations

### O1 — Operation grants are short-lived, exact-scope, single-use, durable, and never persist bearer material

<!-- proof: symbol=RemoteOperationTokenAuthority file=packages/arbor-mcp/src/remote/ephemeral-token.ts roundtrip=packages/arbor-mcp/tests/remote-operation-token.test.ts -->

### O2 — Non-loopback binds require TLS and all listeners require explicit opt-in

<!-- proof: symbol=AuthenticatedRemoteHttpHost file=packages/arbor-mcp/src/remote/http-listener.ts roundtrip=packages/arbor-mcp/tests/remote-http-listener.test.ts -->

### O3 — Remote verified claims are downgraded until a local verifier confirms them

<!-- proof: symbol=RemoteResultReconciler file=packages/arbor-mcp/src/remote/remote-reconcile.ts roundtrip=packages/arbor-mcp/tests/remote-http-listener.test.ts -->
