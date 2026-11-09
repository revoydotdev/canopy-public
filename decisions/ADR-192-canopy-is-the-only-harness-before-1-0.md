# ADR-192: Canopy Is The Only Campaign Harness Before 1.0.0

**Status:** Accepted
**Date:** 2026-10-07
**Authoring Revision:** 01639c0f80b9c754e693d1b5d3baf4d83cbaf060
**Content ID:** sha256:26f618d2ebc4938af08d01d07765fad8449c8e9f205b448eb7e79fd110f03675

> **Amends ADR-061.** ADR-061 made every harness integration a capability-bound plugin selected through one registry. This record keeps that mechanism and narrows its default and its admissible set until 1.0.0. It also completes ADR-142's default flip for `arbor run`.

## Context

The operator directive of 2026-10-07 reads: "All work is to be conducted through the Canopy harness; all other harnesses are deprecated to post-1.0.0." The enforcement chosen was fail closed with an explicit opt-in.

Before this record, a campaign could be routed to a non-Canopy harness from several places, and three of them did so by default:

- `createCliRuntime` (`serve`, `webui`, `task`, the TUI, the scheduler, and `selfhost`'s runtime) read `ARBOR_HARNESS_INTEGRATION` with a default of `opencode`, so the opencode connector was registered next to the native lane on every runtime.
- `arbor run` resolved its lane through `resolveCampaignExecutorLane`, but always passed `native_available: false` and therefore always fell back to the opencode connector. Its `--executor opencode` flag needed no opt-in.
- `arbor selfhost` fell back to a direct opencode executor when no integration was selectable, or when `--verification-cmd` was given. Its decomposer fell back to the opencode decomposer even when the native integration was selected, because the native integration supplies none.
- `native.mode: "fallback"` existed only to force a connector.

Each default made sense locally. Together they meant no single place could say which harness ran a campaign, and the deprecated lanes kept running unless someone noticed.

## Decision

1. **Canopy (`revoy-native`) is the default everywhere, and nothing falls back from it.** `ARBOR_HARNESS_INTEGRATION` defaults to `native` through one resolver, `resolveConfiguredHarnessIntegrationId`, which both `createCliRuntime` and the doctor probe use. `resolveCampaignExecutorLane` defaults to native and throws `CanopyLaneUnavailableError` when the native lane is unready. It no longer returns a connector fallback. `arbor run` now runs the composed native integration's executor, reviewer and decomposer. That is ADR-142's last stage. Its readiness is read before the writer lock, from the same credential resolution (`resolveNativeCredentialSelection`) its composition uses.
2. **Every non-Canopy lane is refused at composition with a typed ADR-179 remedy.** The refused lanes are the opencode, claude-code and codex connectors (`ARBOR_HARNESS_INTEGRATION`), `arbor run --executor opencode`, `selfhost`'s opencode-direct path, and `native.mode: "fallback"`. Each throws `DeprecatedHarnessRefusal`. Its `refusal` is a v2 `GateRefusalProjection` with authority `capability`, correcting actor `operator`, action `grant_capability`, and code `deprecated_harness_lane`. That pair already exists in `RUNTIME_REFUSAL_REMEDIES`, because re-enabling a deprecated lane is a grant only the operator can make. ADR-179's table is unchanged.
3. **One opt-in mechanism, in config:** `connectors.allow_deprecated: true` with a required single-line `connectors.reason` (at most 200 characters) in `arbor.jsonc`, at any ADR-110 scope. There is no env-var opt-in, because every selection site can read config. The validator refuses an opt-in that has no reason, and refuses unknown `connectors` keys. The opt-in admits an explicit choice only. It never turns an unready native lane into a connector run.
4. **A used opt-in is run evidence.** A campaign that runs on an admitted deprecated lane gets a generated-provenance phase message on its root node in its own hash-chained ledger. The message names the lane, the selecting site and the operator's reason, and it is written before any turn runs. The writers are `createProductionCampaignRunner`, when the selected connector is not `revoy-native`, `runOneCampaign` and `runSelfhostCampaign`. The message is idempotent per campaign and lane.
5. **Not harnesses, so not gated:** the deterministic `arbor run` executor (a seeded offline double), injected test executors, and the Claude bridge, which is a provider endpoint of the native lane and not a harness. `ARBOR_CRITIC_TRANSPORT` selects a critic transport only inside an already-admitted connector lane, so the lane gate covers it.
6. **Native-lane requests to OpenRouter carry app attribution.** Canopy and an operator's other OpenRouter clients can share one key. The openai-compatible adapter therefore adds OpenRouter's documented attribution headers: `HTTP-Referer`, `X-OpenRouter-Title`, and `X-Title` as its backwards-compatible alias. They are added only when the endpoint is `https://openrouter.ai`, and their values are fixed, non-secret constants.

## Consequences

- An operator with `ARBOR_HARNESS_INTEGRATION=opencode` (or claude-code or codex) in their environment now gets a refusal from every `createCliRuntime` command until they unset it or opt in. That includes `arbor doctor`. The refusal text names both remedies.
- `scripts/self-hosted-demo.mjs` and `scripts/webui-demo-record.mjs` (claude-code) and `scripts/generalist-campaign-driver.mjs` (any integration) refuse until they write an opt-in config. That is deliberate under the directive.
- `arbor run --transport` and `--verification-cmd` belong to the opencode connector and are refused on the native lane. On the native lane, verification comes from `verification.acceptance_commands`.
- With no ready native lane, a campaign fails closed with a message naming `arbor doctor`. Previously the opencode connector ran it silently.

## Alternatives / Roads not taken

- **Warn and continue.** Rejected: the directive chose fail closed, and a warning is the silent default this record exists to end.
- **An environment-variable opt-in.** Rejected: every selection site already reads config, and a second mechanism would make "is this run opted in?" depend on two sources.
- **A new ADR-179 action such as `enable_deprecated_lane`.** Rejected: `capability` → operator/`grant_capability` already describes the correction exactly, and the directive prefers an existing pair.
- **Deleting the connector integrations.** Deferred to post-1.0. The directive deprecates them; it does not remove them. They stay reachable behind the opt-in.

## Obligations

### O1 — Without the opt-in, every deprecated lane is refused at composition with the operator/grant_capability remedy; with it, the lane composes

Proven against `createCliRuntime` for each connector and for `native.mode: "fallback"`, in both directions.

<!-- proof: symbol=createCliRuntime file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/canopy-lane-policy.test.ts -->

### O2 — The opt-in admits only with a reason, and the admission carries that reason

<!-- proof: symbol=admitDeprecatedHarnessLane file=packages/arbor-mcp/src/canopy-lane-policy.ts roundtrip=packages/arbor-mcp/tests/canopy-lane-policy.test.ts -->

### O3 — The campaign lane defaults to native and never falls back to a connector, even with the opt-in

<!-- proof: symbol=resolveCampaignExecutorLane file=packages/arbor-mcp/src/campaign-executor-lane.ts roundtrip=packages/arbor-mcp/tests/campaign-executor-lane.test.ts -->

### O4 — `arbor run` refuses an unready Canopy lane and an un-admitted `--executor opencode` before touching disk, and reports an admitted one

<!-- proof: symbol=demomain file=packages/arbor-mcp/src/demo.ts roundtrip=packages/arbor-mcp/tests/demo.test.ts -->

### O5 — A run on an admitted deprecated lane records the admission in its own ledger, and a Canopy run records none

<!-- proof: symbol=recordDeprecatedHarnessAdmission file=packages/arbor-mcp/src/canopy-lane-policy.ts roundtrip=packages/arbor-mcp/tests/canopy-lane-policy.test.ts -->

### O6 — `selfhost`'s opencode-direct path is refused without the opt-in and leaves no worktree behind

<!-- proof: symbol=runSelfhostCampaign file=packages/arbor-mcp/src/selfhost.ts roundtrip=packages/arbor-mcp/tests/selfhost.test.ts -->

### O7 — Native-lane requests to OpenRouter carry fixed attribution headers, and requests anywhere else carry none

<!-- proof: symbol=openRouterAttributionHeaders file=packages/arbor-harness/src/openai-compatible.ts roundtrip=packages/arbor-harness/tests/openrouter-attribution.test.ts -->
