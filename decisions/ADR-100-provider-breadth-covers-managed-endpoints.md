# ADR-100: Managed Provider Endpoints Are First-Class Adapters

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 5afc268fd12b3731abf2ba5b1ca52a3c941f8153
**Content ID:** sha256:e319c3d60fda10aed94e4f96a5de967f3e51caa36ee83f3c02416d3c7464e9cf

## Context

The 2026-08-26 four-agent parity audit against revoy2 @ 5afc268f found that
`packages/arbor-harness/src/model-adapter-registry.ts` registers exactly two
transport adapters. That verifies directly: `NATIVE_MODEL_ADAPTER_IDS =
["openai-compatible", "anthropic-messages"] as const` at line 19, and
`packages/arbor-config/src/types.ts`'s `NATIVE_PROVIDER_ADAPTER_IDS` (line 78)
carries the identical pair — the config-side allowlist and the runtime
registry agree, so there is no third adapter hiding behind a config value the
registry can't serve. There is no AWS Bedrock signer, no GCP Vertex OAuth
client, and no first-class Ollama adapter; a local Ollama install can only be
reached today by pointing `openai-compatible`'s `base_url` at Ollama's
OpenAI-compatible shim, which means Ollama-specific behavior (model pull
status, native tool-calling quirks, its own error shapes) is invisible to the
harness.

This is deliberate scope, not an oversight, and the constraint that produced
it is real and worth preserving: `packages/arbor-harness/package.json` and
`packages/arbor-config/package.json` declare no external runtime
dependencies at all — `arbor-harness` depends on nothing but the workspace
`@arbor/core`, and `arbor-config` has no `dependencies` block. Every existing
adapter is hand-written HTTP against a documented wire protocol, with no
vendor SDK to audit, pin, or absorb supply-chain risk from. Adding Bedrock or
Vertex the way most integrations would — pulling in
`@aws-sdk/client-bedrock-runtime` or `@google-cloud/vertexai` — would break
that invariant for the first time.

It doesn't have to. Bedrock's Messages-shaped `InvokeModel`/
`InvokeModelWithResponseStream` endpoints are reachable with a hand-rolled
SigV4 request signature (HMAC-SHA256 over a canonical request, using
`node:crypto` — no AWS SDK required for signing), and Vertex AI's Claude
endpoints are reachable with a hand-rolled GCP OAuth2 token exchange (a
signed JWT assertion exchanged at `https://oauth2.googleapis.com/token`,
again pure `node:crypto` plus `fetch`). Both are real, documented,
implementable-without-an-SDK integrations, not proposals to fake managed-cloud
support with strings.

Credential handling for a new mechanism has a real precedent to extend:
`packages/arbor-config/src/native-secret.ts`'s `NativeCredentialMechanism`
type is `"api_key" | "oauth_bearer"`, and its `NativeCredentialOverlay`
interface hands a secret only to an `inject` callback, never as retained
state; `native-oauth-secret.ts` already reads CLI-subscriber OAuth tokens
(`claude`/`codex`) under that same non-retained-secret discipline, even
though it documents, with empirical evidence, why those particular tokens
don't compose as a general native credential. That same shape — a typed
mechanism, a `present`/`inject` contract, no persisted secret — is what a
SigV4 signing-key pair or a Vertex service-account key needs too.

## Decision

**1. `NATIVE_MODEL_ADAPTER_IDS` and `NATIVE_PROVIDER_ADAPTER_IDS` grow two
entries: `"aws-bedrock-messages"` and `"gcp-vertex-messages"`.** Both are
Anthropic Messages-shaped wire protocols (Bedrock's `InvokeModel` body is the
same content-block schema `anthropic-messages.ts` already parses; Vertex's
Claude endpoint is the same shape under different auth/URL), so each new
adapter is primarily a signing/auth layer wrapped around the request
construction and response parsing `anthropic-messages.ts` already owns —
extracted into a shared internal module rather than duplicated three times.
Ollama gets its own `"ollama-native"` adapter id rather than continuing to
masquerade as `openai-compatible`, so its behavior (streaming shape,
tool-call format, local-only error modes) is represented honestly.

**2. SigV4 signing is a new, dependency-free module,
`packages/arbor-harness/src/aws-sigv4.ts`, implementing the canonical-request
and signing-key derivation algorithm directly against `node:crypto`'s HMAC
and SHA-256 primitives.** It takes a credential pair (access key id, secret
access key, optional session token) and produces the `Authorization` header
and required `x-amz-*` headers for one request. No `@aws-sdk/*` package
enters the dependency tree — the algorithm is public, exactly the "a mature
service wraps a dependable, documented protocol" case ADR-090 used to
justify LSP over bespoke extractors, applied here to a signing protocol.

**3. GCP OAuth token exchange is a new, dependency-free module,
packages/arbor-config/src/gcp-oauth-secret.ts (not yet built as of this
citation's last verification — item 2, `aws-sigv4.ts`, landed; this one is
still outstanding), implementing the JWT
service-account assertion flow (RS256-signed JWT, exchanged at Google's token
endpoint) directly against `node:crypto`.** It mirrors `native-oauth-secret.ts`'s
discipline: reads a service-account key file path from config or a
documented env var, never logs or retains the private key beyond the signing
call, and resolves to the same `NativeCredentialOverlay` shape every other
mechanism satisfies, with a new `oauth_service_account` value added to
`NativeCredentialMechanism`.

**4. Adapter-to-mechanism compatibility is enforced the same way
`resolveNativeHarnessExecutionReadiness` already enforces `oauth_bearer` ↔
`anthropic-messages`.** The `credential_mechanism_unsupported_by_adapter`
branch grows two more pairings (`aws_sigv4` ↔ `aws-bedrock-messages`,
`oauth_service_account` ↔ `gcp-vertex-messages`) rather than a generic
"any mechanism, any adapter" assumption — a SigV4 credential presented to the
Vertex adapter must fail closed exactly as `oauth_bearer` on
`openai-compatible` does today.

## Consequences

An operator running a Bedrock- or Vertex-provisioned Claude deployment, or a
local Ollama instance, gets first-class adapter behavior — correct error
shapes, correct streaming, honest capability reporting in `arbor doctor` —
instead of a best-effort `openai-compatible` masquerade or no path at all.
The zero-external-runtime-dependency posture is preserved and demonstrated to
generalize: three more managed-endpoint integrations without a single new
package in the dependency tree is evidence the constraint scales. This does
not change `resolveNativeProviderSelection`'s three-way return shape or the
native-execution default-selection decision — adapter breadth is orthogonal
to whether native is selected by default.

The cost is real: SigV4 and the GCP JWT/OAuth exchange are protocols this
team now owns test-and-maintain responsibility for, the way
`native-oauth-secret.ts` already owns interpreting two undocumented CLI
credential-store shapes. AWS and Google can both revise their signing/token
contracts without warning in a way a vendor SDK would absorb transparently;
a hand-rolled implementation means revoy inherits that drift risk directly.
Testing SigV4 and JWT signing correctly requires either live cloud
credentials in CI, or fixture-based tests against AWS's/Google's published
signing test vectors — the latter is the honest path, and it proves the
algorithm, not a live integration.

## Alternatives / Roads not taken

**Pull in `@aws-sdk/client-bedrock-runtime` and `@google-cloud/vertexai` like
most integrations would.** Rejected: this is the exact tradeoff the audit
flagged as worth preserving. Both adapters exist specifically to keep
`arbor-harness`/`arbor-config` at zero external runtime dependencies; taking
an AWS or GCP SDK dependency for two of five adapters would make "no vendor
SDK in the tree" a claim that was true only until this ADR, not a durable
property.

**Let Ollama continue to masquerade as `openai-compatible`.** Rejected: it
mostly works because Ollama's shim targets OpenAI compatibility, but
"mostly" is the failure mode `openai-compatible.ts` cannot see — a streaming
edge case or tool-call shape Ollama gets wrong surfaces as an opaque adapter
error with no Ollama-specific diagnosis.

**Wrap AWS's/Google's REST endpoints without doing our own signing — e.g.
require the operator to run a local sidecar (AWS SigV4 proxy, `gcloud
auth print-access-token` shelled out).** Rejected: this reintroduces the
"shell out to someone else's tooling" pattern the native-execution-default
decision is moving away from, and adds an operational dependency (a running
proxy, an authenticated `gcloud` CLI) that an in-process signer avoids.

## Obligations

### O1 — The registry's adapter allowlist is real, minimal, and exactly mirrors config's allowlist today

`NATIVE_MODEL_ADAPTER_IDS` is the two-entry constant this decision grows; its
current value (`["openai-compatible", "anthropic-messages"]`) is the
baseline the audit finding is checked against, and its agreement with
`NATIVE_PROVIDER_ADAPTER_IDS` in `arbor-config` is what makes "no adapter a
config value can select but the registry can't compose" a property worth
keeping true as the list grows.

<!-- proof: symbol=NATIVE_MODEL_ADAPTER_IDS file=packages/arbor-harness/src/model-adapter-registry.ts roundtrip=packages/arbor-harness/tests/model-adapter-registry.test.ts -->

### O2 — Config's adapter allowlist agrees with the runtime registry's, independent of the harness change

`NATIVE_PROVIDER_ADAPTER_IDS` is `arbor-config`'s independent copy of the
same two-entry list, resolved by `resolveNativeProviderSelection` before any
adapter is composed. Proving it demonstrates the config-side half of the
parity this decision must preserve when both lists grow to five entries —
a mismatch here would let config accept a selection the registry can't serve.

<!-- proof: symbol=NATIVE_PROVIDER_ADAPTER_IDS file=packages/arbor-config/src/types.ts roundtrip=packages/arbor-config/tests/config.test.ts -->

### O3 — The credential-mechanism/adapter compatibility gate already fails closed for a mismatched pairing, and is the seam the two new pairings extend

`resolveNativeHarnessExecutionReadiness`'s existing `oauth_bearer` ↔
`anthropic-messages`-only check is the real, exercised precedent for
"a credential mechanism is either compatible with the selected adapter or
readiness reports `credential_mechanism_unsupported_by_adapter`" — the exact
gate `aws_sigv4`/`oauth_service_account` must be added to, not a new
mechanism invented for this decision.

<!-- proof: symbol=resolveNativeHarnessExecutionReadiness file=packages/arbor-mcp/src/native-harness-readiness.ts roundtrip=packages/arbor-mcp/tests/native-harness-readiness.test.ts -->

### O4 — SigV4 signing is correct against AWS's published test vectors, without an AWS SDK in the dependency tree

The new signer must reproduce AWS's own documented signing test vectors
byte-for-byte (canonical request, string-to-sign, and final `Authorization`
header) using only `node:crypto`, and `arbor-harness/package.json` must still
list no `@aws-sdk/*` dependency after this lands — both the correctness claim
and the dependency-count claim are checkable in the same test run.

`packages/arbor-harness/src/aws-sigv4.ts` lands `signAwsSigV4Request`, and
`packages/arbor-harness/tests/aws-sigv4.test.ts` asserts its canonical
request, string-to-sign, and final `Authorization` header byte-for-byte
against three vectors from AWS's own SigV4 conformance suite (`get-vanilla`,
`post-vanilla`, `get-vanilla-query-order-key-case`, fetched 2026-08-26 from
`gems/aws-sigv4/spec/suite/` in the official `aws/aws-sdk-ruby` repository)
plus a fourth vector for a real Bedrock-shaped request (JSON body, session
token, a `:`-bearing model id in the path). `packages/arbor-harness/package.json`
carries no `@aws-sdk/*` dependency. This has never executed against a live
AWS endpoint -- no credentials, no network in this environment -- the proof
is the published test-vector match, not a live call.

<!-- proof: symbol=signAwsSigV4Request file=packages/arbor-harness/src/aws-sigv4.ts roundtrip=packages/arbor-harness/tests/aws-sigv4.test.ts -->
