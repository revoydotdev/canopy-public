# ADR-110: Configuration Resolves Through Declared Scopes, Not A Single File

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 5afc268fd12b3731abf2ba5b1ca52a3c941f8153
**Content ID:** sha256:1b06a0736a910213e559194f7438732e83ef64597aeb7307f85e8fc5d9707c35

## Context

Verified against `packages/arbor-config/src/` at 5afc268f: `loadConfig`
(`loader.ts:113-135`) resolves exactly two layers over the in-code defaults —
`<dir>/arbor.jsonc` (parsed by the string-aware `stripJsonc` scanner, merged
with `deepMerge`) and `ARBOR_CONFIG__*` env overrides (`env.ts`, ADR-020/G-07).
Its own docstring states the order plainly: "defaults -> file -> env." There is
no distinct user-scope file (`~/.arbor/arbor.jsonc` or equivalent) and no
project/organization split within arbor.jsonc itself — `<dir>` is a single
project-scoped location, always. `native-oauth-secret.ts`'s `~/.claude`/
`~/.codex` paths are a different thing entirely: they resolve one OAuth
secret, not general configuration, and do not participate in `loadConfig`'s
merge at all. Claude Code resolves enterprise -> project -> user; Codex
resolves global -> project. Neither of revoy2's two comparison harnesses is
this flat.

That said, the audit's uncertainty about `organization-policy.ts` does not
hold: it is wired, not speculative. `resolveCliOrganizationPolicy`
(`packages/arbor-mcp/src/cli.ts:1703-1711`) loads it from
`ARBOR_ORGANIZATION_POLICY`/`ARBOR_PROJECT_POLICY`/`ARBOR_USER_POLICY` env-
named paths and the result is used for real effect twice in `createCliRuntime`:
`organizationPolicy?.startup.safe_mode` participates in the `safeMode`
computation (`cli.ts:1719`), and `composition.organization_policy?.network.
allowed_domains`/`.native_approval.allowed_tools` gate the governed network
port and the native tool-approval port (`cli.ts:1451`, `1577`). So the
`organization`/`project`/`user` three-scope split the operator interface is
missing at the arbor.jsonc level *already exists* for the policy-floor
subset of knobs, via `composeOrganizationPolicy`'s `narrowList` ratchet
(`organization-policy.ts:179-196`, throws if a lower layer tries to weaken
`startup.safe_mode`). The gap is specifically that `loadConfig`'s general
preference config — everything in `ArborConfig` outside the three
policy-floor knobs — has no equivalent scope hierarchy, and the two systems
(`loadConfig` and `loadOrganizationPolicyLayers`) are entirely separate code
paths with no shared scope model between them.

The audit's provenance concern also does not hold as starkly as framed:
per-knob source attribution is not merely "does `doctor` report it" — it is
already a real, general mechanism. `composeEffectiveConfig`
(`packages/arbor-mcp/src/config-inspection.ts:93-135`) flattens the full
`ArborConfig` tree into a `ConfigLeaf[]` where every leaf carries its own
`source: ConfigSourceKind` (`"default" | "file" | "env" | "ledger" |
"injected"`), redacting secret-shaped paths structurally rather than by
value inspection. `doctor`'s `Config sources: defaults=…, file=…, env=…,
injected=…` line (`native-harness-readiness.ts:214`) is only the summary
view of that mechanism — the per-leaf detail (`EffectiveConfigView.leaves`)
already exists and is exposed through `config.get`. `"ledger"` is a reserved,
currently-unfed `ConfigSourceKind` — the same "typed absence, not silently
inert" pattern this package already uses elsewhere, per that file's own
comment. Genuinely new here is not provenance itself, but extending its
`ConfigSourceKind` union to cover the scopes this ADR adds.

`schema.ts`/`validator.ts` do real recursive shape validation: `loader.ts`'s
`assertKnownConfigShape` walks the defaults tree recursively rejecting a type
mismatch at any depth, and `deepMerge`'s `FORBIDDEN_MERGE_KEYS` set explicitly
throws on `__proto__`/`constructor`/`prototype` rather than silently merging
through them. `stripJsonc` is a string-aware two-pass scanner (quote-tracking
comment strip, then trailing-comma strip), not a regex — verified it correctly
special-cases a `"` inside a value so a provider endpoint URL is never
corrupted. Both are genuine strengths this decision preserves unchanged.

## Decision

**1. `loadConfig` grows a declared scope chain: defaults -> organization ->
user -> project -> env -> injected.** `loader.ts` gains a
`resolveConfigScopes` step that locates, in order, a checked-in organization
config (co-located with `organization-policy.ts`'s file, since both already
travel together operationally), a user config at
`$ARBOR_USER_CONFIG_DIR/arbor.jsonc` (default `~/.arbor/arbor.jsonc`,
mirroring the `~/.claude`/`~/.codex` convention `native-oauth-secret.ts`
already establishes for this repo's dotfile placement, without touching that
module's secret-only responsibility), the existing project `<dir>/
arbor.jsonc`, then `ARBOR_CONFIG__*` env, then any runtime-injected overlay.
Each scope is optional; an absent scope is a no-op layer, exactly as an absent
project arbor.jsonc already is today. `deepMerge` and
`assertKnownConfigShape` are reused unchanged per layer — this is an
additional fold over the same two functions, not a new merge algorithm.

**2. `ConfigSourceKind` grows to name every scope, and `composeEffectiveConfig`
folds them in the same order.** The union becomes `"default" | "organization"
| "user" | "project" | "env" | "ledger" | "injected"`, and
`composeEffectiveConfig`'s `record()` calls extend from four to six/seven
layers in the same precedence order as (1). This is the mechanism the brief
asks for — "which scope supplied each resolved value must be inspectable" —
delivered by widening the tagging this package already does per leaf, not by
inventing a new inspection surface. `doctor`'s summary line grows the same new
scope names.

**3. `organization-policy.ts`'s floor and `loadConfig`'s precedence coexist as
two different mechanisms over two different knob sets, made explicit rather
than accidentally parallel.** A precedence chain answers "what value wins";
a floor answers "what value may a lower scope not weaken." They are not
merged into one mechanism: arbor.jsonc's general preference knobs stay
pure precedence (project can freely override organization, matching how a
developer's local arbor.jsonc should be able to turn on a debug flag the
org config left off), while the specific policy-floor knobs
(`network.allowed_domains`, `native_approval.allowed_tools`,
`startup.safe_mode`) stay under `narrowList`'s ratchet, unreachable by
`loadConfig`'s ordinary override path. `resolveCliOrganizationPolicy`
continues to load the floor document separately from `loadConfig`'s scope
chain — the two loaders remain distinct because their guarantees are
distinct, and collapsing them would let a arbor.jsonc project override
silently narrow-or-widen a floor knob depending on merge order, which is
exactly the ambiguity a floor exists to prevent.

**4. The `user` scope is new; it is deliberately the weakest new addition,
not the strongest.** It sits below `project` in (1) so a project's checked-in
arbor.jsonc still governs for anyone working in that checkout — a personal
`~/.arbor/arbor.jsonc` is for machine-local preferences (a wider terminal
width, a local model endpoint override for offline dev) that should never
silently outrank a project's committed configuration, matching Claude Code's
enterprise -> project -> user ordering's placement of `user` last among the
non-env layers rather than Codex's flatter two-scope model.

## Consequences

An operator can now say "this is a machine preference" versus "this is a
project convention" versus "this is an organization-wide floor" without three
different files becoming three different undocumented conventions, and
`config.get`'s per-leaf `source` answers "where did this value come from"
across every one of those scopes, not just the two that exist today. A
governed harness that could only report `file`/`env` for a value already
looked less auditable than its own `organization-policy.ts` half — this
closes that asymmetry.

What gets harder: `loadConfig` now has five-to-seven ordered layers instead of
two, and every future change to precedence order is a change six/seven
call sites (loader, provenance loader, config-inspection, doctor's summary
formatter, and each layer's own file-existence check) have to agree on
identically — a single reordering bug silently changes which scope wins
project-wide. Discovering *why* a given leaf resolved to a particular value
now requires walking a longer chain instead of a two-layer diff, which is a
real cost even though the per-leaf `source` tag makes the final answer
inspectable. A user-scope file introduces a new place secrets could
accidentally land — `~/.arbor/arbor.jsonc` sits outside any project's git
history, which is exactly why it must never be treated as a substitute for
`native-oauth-secret.ts`'s dedicated secret path, and `config-inspection.ts`'s
`isSecretPath` redaction now has to hold across one more scope's leaves with
no weaker guarantee than it gives today.

This decision does not change `organization-policy.ts`'s floor semantics,
does not touch `native-oauth-secret.ts`'s secret-only OAuth paths, and does
not change `stripJsonc`'s parsing or `deepMerge`'s prototype-pollution guard —
all three are reused exactly as they exist today, only invoked once per new
scope rather than once.

## Alternatives / Roads not taken

**Fold the new scopes into `organization-policy.ts`'s existing
`OrganizationPolicyLayers` shape instead of extending `loadConfig`.** Rejected:
that type is deliberately narrow — three specific floor knobs, each with
`narrowList` ratchet semantics. Widening it to carry arbitrary `ArborConfig`
preference leaves would give every general preference knob floor semantics it
was never designed to have (a project could no longer freely turn on a debug
flag an org config left off), collapsing precedence and floor into one
mechanism that the brief specifically asks to keep coherent, not merged.

**A single merged config file per scope, resolved by explicit
arbor.organization.jsonc / arbor.user.jsonc / arbor.jsonc naming instead
of directory-based lookup.** Considered, not rejected outright — this is
close to what (1) does. The directory-lookup version was preferred because it
matches the existing `<dir>/arbor.jsonc` convention exactly for the project
layer (zero migration for every existing checked-in arbor.jsonc) and keeps
the organization/user paths as separately-named, separately-optional files
rather than baking scope into a filename convention nothing else in this
package uses.

**Add only a `user` scope and leave `organization` to `organization-policy.ts`
alone, unconnected to `loadConfig`.** Rejected: this is close to the current
state and repeats the exact asymmetry named in Context — one scope hierarchy
for the three floor knobs, none for everything else. An operator asking "is
this a project or user setting" for an ordinary preference knob would still
have no answer.

## Obligations

### O1 — Per-leaf source provenance for the full config tree already exists and is a real mechanism to extend, not build from nothing

`composeEffectiveConfig` produces a `ConfigLeaf[]` where every leaf in the
full `ArborConfig` tree carries its own `source`, composed in declared
precedence order from `defaults` through `injected`, with structural secret
redaction independent of the source tag. This is the seam Decision (2) widens
to name organization/user/project scopes instead of inventing a parallel
inspection mechanism.

<!-- proof: symbol=composeEffectiveConfig file=packages/arbor-mcp/src/config-inspection.ts roundtrip=packages/arbor-mcp/tests/config-inspection.test.ts -->

### O2 — `organization-policy.ts`'s floor is wired to real enforcement today, not speculative

`resolveCliOrganizationPolicy` loads a real `OrganizationPolicy` from
env-named paths and `createCliRuntime` uses it for `safeMode` and for gating
both the governed network port's allowed domains and the native
tool-approval port's allowed tools. This closes the audit's stated
uncertainty about whether this module has a caller: it does, with observable
effect on two live authorization decisions, and Decision (3) depends on this
being true — a floor coexisting with a precedence chain only matters if the
floor actually gates something.

<!-- proof: symbol=composeOrganizationPolicy file=packages/arbor-config/src/organization-policy.ts roundtrip=packages/arbor-config/tests/organization-policy.test.ts -->

### O3 — `loadConfig` now resolves the full declared scope chain, not just project file + env

`loader.ts`'s `resolveConfigScopes` locates the organization scope (via
`ARBOR_ORGANIZATION_CONFIG_DIR/arbor.jsonc`, absent by default), the user
scope (`$ARBOR_USER_CONFIG_DIR/arbor.jsonc`, default `~/.arbor/arbor.jsonc`),
and the existing project `<dir>/arbor.jsonc`, folding each through
`deepMerge`/`assertKnownConfigShape` in that order; `loadConfig` layers
`ARBOR_CONFIG__*` env on top of the result. `config.test.ts`'s "resolves
organization < user < project < env precedence over a constructed
multi-scope fixture" test proves the ordering directly over a fixture that
sets a conflicting leaf at every scope. `composeEffectiveConfig`
(`packages/arbor-mcp/src/config-inspection.ts`) independently proves
`organization < user < file < env < injected` for the per-leaf provenance
projection, so the chain's `injected` tail (a runtime-only layer that never
existed at the file-loading level `loader.ts` owns) is covered there rather
than duplicated here.

<!-- proof: symbol=resolveConfigScopes file=packages/arbor-config/src/loader.ts roundtrip=packages/arbor-config/tests/config.test.ts -->

### O4 — The `user` scope's default location now exists, at the precedence position this ADR commits to

`resolveConfigScopes` reads `$ARBOR_USER_CONFIG_DIR/arbor.jsonc` (default
`~/.arbor/arbor.jsonc` via `resolveUserConfigDir`), folded after
`organization` and before `project` — so a project's checked-in
arbor.jsonc still overrides a personal user-scope value, matching Claude
Code's ordering rather than treating `user` as strongest.
`config.test.ts`'s scope-chain fixture asserts exactly this: a user-scope
value is visible when the project doesn't touch that leaf, and is overridden
the moment the project does.

<!-- proof: symbol=resolveConfigScopes file=packages/arbor-config/src/loader.ts roundtrip=packages/arbor-config/tests/config.test.ts -->
