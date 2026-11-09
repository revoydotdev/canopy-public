# ADR-099: Native Execution Is The Default, Connector Delegation Is Opt-In

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 5afc268fd12b3731abf2ba5b1ca52a3c941f8153
**Content ID:** sha256:1887a621d473d8f62a333e369a401f2c7362b2401a27f03a3f289e449afa1dff

## Context

The four-agent parity audit run 2026-08-26 against revoy2 @ 5afc268f reported
that `arbor doctor` on a clean checkout selects `Mode selection: connector —
native.mode=native is unavailable (credential_absent); campaign execution
depends on the "opencode" connector`. That finding holds against the current
tree, but the mechanism behind it is more specific than "no credential is
present": `packages/arbor-config/src/defaults.ts` sets `native.mode: "auto"`
and leaves `native.provider_id`, `native.base_url`, and `native.model` at
`""`. `resolveNativeProviderSelection` (`packages/arbor-config/src/native-provider.ts`)
reads that config and, because `provider_id`/`base_url`/`model` are all empty,
returns `{ kind: "fallback", reason: "selection_incomplete" }` before it ever
consults a credential — the same result a clean checkout gets whether or not
`ANTHROPIC_API_KEY` is exported. `resolveNativeHarnessExecutionReadiness`
(`packages/arbor-mcp/src/native-harness-readiness.ts`) then reports
`credential_absent` for the same underlying reason once a credential
disqualifies it, but even a fully-credentialed shell falls back today because
selection, not credential presence, is what's incomplete out of the box.

`opencode-executor.ts`'s `OpenCodeLoopExecutor` and the three integrations
under `packages/arbor-mcp/src/integrations/` (`claude-code-campaign.ts`,
`codex-campaign.ts`, `opencode-campaign.ts`) are the connectors this default
routes to — each shells out to a real external CLI. The native path is not a
stub competing with them: `NativeAgentExecutor`
(`packages/arbor-mcp/src/native-agent-executor.ts`), `NativeHarnessWorker`
(`packages/arbor-harness/src/native-worker.ts`), and the
`anthropic-messages`/`openai-compatible` adapters are wired end to end and
reachable from `cli.ts:16`'s import of `NativeAgentExecutor`. Reaching this
genuinely-built path today requires an operator to already know it exists and
configure three fields it ships empty. A harness whose flagship
differentiator — running its own agent loop instead of shelling out to
someone else's CLI — is unreachable without undocumented configuration is
"native-possible," not "native-capable."

## Decision

**1. `native.mode` remains `"auto"`, but the default configuration ceases to
guarantee `selection_incomplete`.** `packages/arbor-config/src/defaults.ts`
ships a concrete default `native.adapter_id` (`"anthropic-messages"`),
`native.provider_id` (`"anthropic"`), and `native.model` (a pinned, documented
default model id), leaving only `native.base_url` to the adapter's own
built-in default where one exists. `resolveNativeProviderSelection` is
unchanged — this is a defaults change, not a selection-logic change — but its
`selection_incomplete` fallback now fires only when an operator has actively
blanked a field, not on a fresh checkout.

**2. Credential absence gets a setup path, not a silent downgrade.** When
`resolveNativeHarnessExecutionReadiness` reports `credential_absent` under
`mode: "auto"`, `arbor doctor` (via `buildNativeHarnessReadiness`'s
`missing_requirements`) prints the exact candidate env var from
`nativeProviderCredentialEnvCandidates` (`native-secret.ts`) and the one
command needed to set it, and the connector fallback it takes is logged at
campaign start — not just in `doctor` — as a demoted mode, naming the reason.
The doctor projection contract (`NativeHarnessReadinessProjection`) already
carries `missing_requirements`; this decision is about surfacing it at the
point of fallback, not only on request.

**3. Falling back to a connector becomes an explicit, named choice.**
`native.mode: "fallback"` already exists in the schema
(`packages/arbor-config/src/schema.ts`) as the forced-fallback state. This
decision makes it the documented way to opt into connector delegation on
purpose — pinned to a stated reason in arbor.jsonc (e.g. "no native
credential provisioned for this environment yet", "connector X required for
feature Y the native path doesn't cover") — rather than something that
happens by default because three string fields were left blank.

## Consequences

An operator who exports a supported provider's API key and runs `arbor doctor`
on a clean checkout gets `direct_native` selection without editing config
first — the native path stops being something you must already know to reach.
`opencode`/`claude`/`codex` connector delegation remains fully supported and
becomes the honest choice when an operator wants it (a capability only that
connector has, or credentials only that CLI already holds), not the silent
default. This does not change `resolveNativeProviderSelection`'s decision
table, `NativeProviderSelection`'s three-way return shape, or the
`native.mode: "fallback"` forced-fallback semantics — those are the
mechanism this decision reuses, not replaces. It also does not remove or
weaken any connector integration; `opencode-executor.ts` and the three
`integrations/` campaign modules are untouched.

The cost: a default `native.model` is now a real config claim about which
model a fresh checkout will call, and that claim goes stale as models are
deprecated — it needs the same staleness discipline `native.pricing`'s static
observation already carries, or it becomes a new source of drift. Pinning a
default provider also means revoy is choosing, by default config, which
vendor a fresh install talks to; that is a real decision this ADR is making
explicit rather than an accident of which fields happened to ship empty.

## Alternatives / Roads not taken

**Change `resolveNativeProviderSelection` to treat an incomplete selection as
`native`-preferred with adapter-supplied defaults, rather than shipping
concrete defaults in `arbor-config`.** Rejected: that would move a
provider-specific default (a model id, an adapter choice) into
`native-provider.ts`, which is deliberately provider-neutral and only
resolves the typed config it's given. Keeping the default in
`defaults.ts` keeps the selection function pure and testable against
config alone.

**Make `native.mode: "native"` (hard-fail, no fallback) the shipped default
instead of `"auto"`.** Rejected: a fresh checkout with no credential
configured would then fail closed on the very first campaign attempt with no
working path at all, which is worse for first-run experience than a fallback
that at least runs, even if it's not the mode this ADR wants as steady state.
`"auto"` with real defaults gets the same "native works out of the box once
credentialed" outcome without that cliff.

**Leave defaults empty and only improve the `doctor` message.** Rejected:
this was tried in effect already — `native-harness-readiness.ts`'s
`missing_requirements` already names the exact fields to set, and the audit
still found connector delegation as the observed default behavior. A better
error message does not change what happens when nobody reads it; the default
in the current tree runs a real campaign through `opencode` without any
prompt to fix `native.*` first.

## Obligations

### O1 — Selection is decided by pure config, never inspects a credential value

`resolveNativeProviderSelection` takes only the typed `NativeProviderConfig`
and returns one of `native`/`fallback`/`unavailable` — it is the seam this
decision's default-values change targets, and keeping it credential-blind is
what lets `buildNativeHarnessReadiness` layer credential state on top without
selection logic itself ever branching on a secret. This is the existing
mechanism the decision must not disturb while changing what `defaults.ts`
feeds it.

<!-- proof: symbol=resolveNativeProviderSelection file=packages/arbor-config/src/native-provider.ts roundtrip=packages/arbor-config/tests/config.test.ts -->

### O2 — Doctor's readiness projection already names the concrete missing fields for `selection_incomplete` and `credential_absent`

`buildNativeHarnessReadiness` populates `missing_requirements` with
machine-checkable `{ code, action }` pairs for every incomplete-selection and
absent-credential case today. This obligation demonstrates that the surface
this ADR's setup-path decision (§2) builds on already exists and is exercised
by a real test, not proposed net-new; only the point at which it's surfaced
(fallback time, not just `doctor` time) is new work.

<!-- proof: symbol=buildNativeHarnessReadiness file=packages/arbor-mcp/src/native-harness-readiness.ts roundtrip=packages/arbor-mcp/tests/native-harness-readiness.test.ts -->

### O3 — A fresh checkout with a supported credential exported resolves to `direct_native`, not `connector_fallback`

`defaults.ts` now ships concrete `native.adapter_id` (`anthropic-messages`),
`native.provider_id` (`anthropic`), `native.base_url`
(`https://api.anthropic.com`), and a pinned `native.model`
(`claude-sonnet-5`). Under the shipped `mode: "auto"` default,
`resolveNativeProviderSelection(DEFAULT_CONFIG.native)` now returns
`{ kind: "native", selected_by: "auto", ... }` for an otherwise-unmodified
config (`packages/arbor-config/tests/env.test.ts`), and
`buildNativeHarnessReadiness` composed with `DEFAULT_CONFIG` plus only a
present credential (no other override) returns
`{ execution: { kind: "direct_native", selected_by: "auto" } }` with an empty
`missing_requirements` array — demonstrated end to end by
`packages/arbor-mcp/tests/native-harness-readiness.test.ts`'s "ADR-099 O3"
case, which is this obligation's resolving proof below.

<!-- proof: symbol=buildNativeHarnessReadiness file=packages/arbor-mcp/src/native-harness-readiness.ts roundtrip=packages/arbor-mcp/tests/native-harness-readiness.test.ts -->
