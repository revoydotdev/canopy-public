# Runtime tuning environment variables

Reference for the env vars that gate optional runtime behavior in the Arbor
loop and its MCP-side ports. All are read straight from `process.env` (or an
injected `env` map in tests) — none are configured through `arbor.config`.

## Harness lane and connector selection

Canopy (`revoy-native`) is the only campaign harness before 1.0.0 (ADR-192).
It is the default everywhere: `ARBOR_HARNESS_INTEGRATION` defaults to `native`,
and nothing falls back from the native lane to a connector. The opencode,
claude-code and codex connectors are deprecated until after 1.0.0 and are
refused at composition (a `deprecated_harness_lane` refusal, operator action
`grant_capability`) unless `arbor.jsonc` sets, at any scope:

```jsonc
{ "connectors": { "allow_deprecated": true, "reason": "<why, one line, at most 200 chars>" } }
```

There is no env-var opt-in. The reason is recorded in the ledger of every
campaign that runs on an admitted deprecated lane. The opt-in admits an
explicit choice only; it never turns an unready native lane into a connector
run.

| `native.mode` | Native adapter + credential ready? | Actually selected |
|---|---|---|
| `native` / `auto` | yes | native lane |
| `native` / `auto` | no | **unavailable** — the campaign fails closed and points at `arbor doctor`; no connector fallback |
| `fallback` | n/a | refused (`deprecated_harness_lane`) unless the opt-in above is set |

To configure a native credential, see `docs/native-provider-auth.md`; run
`arbor doctor` to see which lane was selected and why. The report's
`mode_selection` field (`packages/arbor-mcp/src/operator-maintenance.ts`)
states the active lane, the resolved connector id, the configured
`native.mode`, and the concrete reason (including `credential_absent`) in one
place.

**`arbor-mcp selfhost`** no longer falls back to a direct opencode executor:
that path (and its opencode decomposer) is refused without the opt-in and
leaves no worktree behind. With the native integration selected it runs on the
Canopy lane.

## `ARBOR_RACE_SPECIALISTS`
- **Default:** unset — racing never engages.
- **Effect:** set to exactly `"2"` to opt into staggered first-verified-wins
  specialist racing (ADR-067). Also requires the campaign's governance tier
  to be `direct` or `reviewed`; a `governed` tree, or one with no recorded
  governance decision, never races regardless of this var.
- **Source:** `packages/arbor-opencode/src/race.ts` (`isRaceEligible`,
  `RACE_SPECIALISTS_ENV`).

## `ARBOR_RACE_FORK_MS`
- **Default:** `25000` (25s, `DEFAULT_RACE_FORK_MS`) when unset, blank, or
  non-numeric.
- **Effect:** wall-time threshold after which, if attempt 1's verification
  hasn't settled, a second specialist attempt is forked into a second
  worktree. Out-of-range values are clamped into `[5000, 300000]`
  (`MIN_RACE_FORK_MS`..`MAX_RACE_FORK_MS`) rather than ignored.
- **Source:** `packages/arbor-opencode/src/race.ts`
  (`resolveForkThresholdMs`, `RACE_FORK_MS_ENV`).

## `ARBOR_CRITIC_TRANSPORT`
- **Default:** unset — selects a critic transport only inside an already-admitted deprecated connector lane (ADR-192); the Canopy lane uses its own native critic.
- **Effect:** set to `"native"` to route critic review through a single
  non-streaming native model call instead of the CLI critic (avoids the
  ~19-24s CLI process floor measured in an internal A/B).
- **Source:** `packages/arbor-mcp/src/native-critic-transport.ts`
  (`ARBOR_CRITIC_TRANSPORT_ENV`); consumed in
  `packages/arbor-mcp/src/cli.ts` and
  `packages/arbor-mcp/src/integrations/claude-code-campaign.ts`.

## `ARBOR_NATIVE_CRITIC_MODEL`
- **Default:** unset — falls back to the configured `native.model` selection.
- **Effect:** overrides the model id used for the native critic call. Only
  takes effect when `ARBOR_CRITIC_TRANSPORT=native` is also set.
- **Source:** `packages/arbor-mcp/src/native-critic-transport.ts`
  (`ARBOR_NATIVE_CRITIC_MODEL_ENV`).

## `ARBOR_TEST_AMPLIFIER`
- **Default:** unset — disabled, zero model or command-port calls.
- **Effect:** set to `"native"` to opt into generated-oracle evidence (Y-3,
  ADR-066): for sibling-scan-flagged sites, asks a native model to write one
  inverted regression test per site (max 2, `TEST_AMPLIFIER_MAX_SITES`),
  then compile/execute-gates it before trusting it. Evidence-only, never fed
  into `recordResult`.
- **Source:** `packages/arbor-mcp/src/test-amplifier.ts`
  (`ARBOR_TEST_AMPLIFIER_ENV`).

## `ARBOR_MUTATION_PROBE`
- **Default:** unset — disabled, zero file writes or command-port calls.
- **Effect:** set to `"on"` to opt into the diff∪sibling mutation probe
  (ADR-069): generates bounded string-level line mutants and runs the
  declared acceptance command against each, reporting survivors as evidence
  only (never blocking, never fed into `recordResult`).
- **Source:** `packages/arbor-mcp/src/mutation-probe.ts`
  (`ARBOR_MUTATION_PROBE_ENV`).

## `ARBOR_MUTATION_HARDEN`
- **Default:** unset — disabled, no model or command-port calls beyond the
  base probe.
- **Effect:** set to `"on"` to opt into CoHarden-lite hardening of surviving
  mutants (ADR-071, PM-2): generates one killer test per survivor, trusted
  only if it passes against both the real code and the re-applied mutant.
  Requires `ARBOR_MUTATION_PROBE=on` as well; otherwise this var has no
  effect.
- **Source:** `packages/arbor-mcp/src/mutation-probe.ts`
  (`ARBOR_MUTATION_HARDEN_ENV`).

## `ARBOR_ARBITER_TRANSPORT`
- **Default:** unset — the zero-token heuristic arbiter intake port is used.
- **Effect:** set to `"native"` to prefer a model-backed intake classifier
  over the heuristic; falls back to the heuristic if the native provider
  isn't ready or the native call/decision fails its contract.
- **Source:** `packages/arbor-mcp/src/native-arbiter-transport.ts`
  (`ARBOR_ARBITER_TRANSPORT_ENV`, `composeArbiterIntakePort`).

## `ARBOR_CONTEXT_CAPSULE`
- **Default:** unset — repository context capsules are built and injected
  into planning and specialist prompts (the current default).
- **Effect:** set to `"off"` to skip building/injecting the capsule (E-1
  ablation, for measuring whether the capsule pays for its tokens). Any
  other value, or unset, keeps it on.
- **Source:** `packages/arbor-mcp/src/integrations/claude-code-campaign.ts`
  (`ARBOR_CONTEXT_CAPSULE_ENV`, `contextCapsuleDisabled`).
