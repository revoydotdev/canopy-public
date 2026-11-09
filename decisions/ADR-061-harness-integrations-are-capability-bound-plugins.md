# ADR-061: Harness Integrations Are Capability-Bound Plugins

**Status:** Accepted
**Date:** 2026-08-13
**Authoring Revision:** d446d7710c62df7ce18a807613a98bf7f1daad68
**Content ID:** sha256:805f21a81406e57dae2c9de110746d9f2c2f8b41a2f2df7b9ad42c10a7eb5e81

## Context

Revoy2 owns a native session, model, tool, governance, and campaign-control
surface, but its historical package graph conflates that control plane with one
upstream harness. `@arbor/opencode` contains both Revoy-owned generic campaign
machinery and an OpenCode plugin, while the production campaign runner also
constructed OpenCode executors, reviewers, and decomposers directly. That makes
an integration look like the product's execution authority and makes removing
or replacing it an invasive runtime edit.

The existing connector registry already admits truthful capability descriptors,
but descriptors are not executable bindings. A second untyped map from a
connector name to an implementation would let descriptor admission and dispatch
drift apart.

## Decision

External harnesses are subordinate, capability-bound integration plugins.
`@arbor/harness` owns a generic `HarnessIntegrationRegistry<T>` that atomically
pairs an admitted connector descriptor with one opaque host implementation.
Selection remains capability-first, health-aware, deterministic, and
fail-closed. The registry does not know campaign-loop types, provider SDKs,
credentials, or upstream wire schemas.

`@arbor/mcp` owns the temporary structural campaign binding
`CampaignHarnessIntegration`: executor, independent reviewer, and optional
decomposer factories. The production campaign runner receives a registry of
those bindings and contains no hard-coded OpenCode fallback. It still owns the
sole `campaign.run` authority; an integration cannot start, admit, approve,
verify, recover, or adopt a campaign by itself.

OpenCode is a transitional built-in adapter under `integrations/`, registered
with an explicit descriptor. It is deprecated as a direct product dependency.
Migration completes in separately verifiable steps:

1. capability-bind executable integrations and remove upstream construction
   from the generic runner;
2. move Revoy-owned generic loop/worktree/critic contracts out of the
   misleading `@arbor/opencode` package;
3. move OpenCode process/provider code into an installable integration package;
4. remove `@arbor/opencode` from `@arbor/mcp` dependencies and project
   references, leaving native execution usable with no upstream harness
   installed.

No step may silently weaken an explicit native selection into a plugin
fallback. Credentials remain integration-owned opaque leases or explicitly
configured connector credentials; plugin discovery grants no authority.
Provider API-key aliases, OAuth sessions, SDK credential chains, and helper
processes are plugin-side credential sources. The generic harness sees only a
scoped lease or a credential-free subprocess boundary. In particular, a Claude
Code integration may invoke the authenticated CLI, but must never locate,
parse, copy, or project Claude Code's OAuth store.

## Consequences

New harnesses can implement one bounded port and compete on declared,
evidence-backed capability rather than adding branches to the campaign runner.
Degraded integrations remain inspectable but cannot receive new work. The
OpenCode package is not removed by this first step: generic contracts and
legacy self-host/demo paths still import it, and those remaining edges are
reported migration debt rather than disguised as completion.

## Obligations

### O1 — Descriptor and implementation selection cannot drift

<!-- proof: symbol=HarnessIntegrationRegistry file=packages/arbor-harness/src/integration-registry.ts roundtrip=packages/arbor-harness/tests/integration-registry.test.ts -->

Only the implementation paired with the capability-selected healthy descriptor
is returned, and a degraded adapter is excluded from dispatch.

### O2 — The production runner contains no upstream fallback construction

<!-- proof: symbol=createProductionCampaignRunner file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/harness-composition.test.ts -->

The runner receives and selects `CampaignHarnessIntegration` bindings. It does
not import or construct an OpenCode executor, reviewer, or decomposer.

### O3 — Explicit native unavailability remains fail-closed

<!-- proof: symbol=createProductionCampaignRunner file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/harness-composition.test.ts -->

An explicitly selected but unavailable native adapter fails before integration
selection; a registered external integration cannot turn that refusal into a
fallback run.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority separate
from the implementation and authoring authority used in this tranche.
