# ADR-181: The Native Inject Lane Carries Tropisms, and Host Hooks Are Devolved to the Native Bus

**Status:** Accepted
**Date:** 2026-10-06
**Authoring Revision:** 0340135296b271230647f545eb6723873f64a822
**Content ID:** sha256:4953c366c79b2b506082df600ac7dda5b26a53e002547ce3953665880a35ee51

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances). This record RATIFIES
work that already landed; it adds no mechanism.

A slice of Arboretum M4 (`docs/proposals/arboretum-coordination-plane.md` §5,
§9 M4, §12 item 4) landed across `226d0f9a` (the inject lane and the Tropism
type), `2c133efb` (tropisms replace three SessionStart prose hooks),
`0f3ed28f` (the vetoes and tropisms are activated, not merely registered),
`cd98fe19` (the last two host hooks devolved, and the advisory `turn_end`
inject lane), `ba60b885` (native vetoes replace the read-only and
claim-completeness guards), `f5133b5f` (a native writer records the paths a
session edited) and `9a7ec933` (the stop-tier battery and its no-progress
breaker become native). They carry `ADR: 049`, `111`, `127`, `074`, `154` and
`160` trailers: each touched machinery those records govern, and none of them
records the hook kind, the lane rules or the devolution as a decision.

Before this work the native hook bus had two kinds, veto and observe, and no
path by which harness state reached the model; the governance behaviour lived
in 13 Claude Code and 3 Codex host hooks. Amendment 1 of the proposal makes
the native harness the only target, and ADR-177 (Accepted) depends on the host
hooks having been devolved.

## Decision

This records what the code at the authoring revision does.

1. **`inject` is a fourth hook kind.** `HookKind` is
   `observe | veto | lifecycle | inject`, and `HOOK_INJECT_EVENTS` are the
   lifecycle events plus `turn_end`. An inject handler returns a `Tropism`
   (`@arbor/prompts`): `{ id, trigger, lane, provenance: "generated",
   derived_from, body, expires_after_turns, enforcing_ref }`. It has no
   decision field, so an inject hook cannot refuse a tool call or a turn,
   start or stop a session, or grant authority.

2. **The catalog enforces two of the proposal's three lane rules.**
   `HookCatalog.validateTropism` drops a tropism whose lane is `ADVISORY` and
   whose body opens imperatively (`advisory_imperative`), a `CODE` tropism
   whose `enforcing_ref` is missing or names no declared hook
   (`code_unenforced`), and a malformed or over-bound one. `TropismInjector`
   enforces "derived, never constant": the same tropism over the same
   `derived_from` is rendered once per session until its
   `expires_after_turns` window closes, and a changed derivation re-renders at
   once. The proposal's third rule (a tropism may not reference an artifact the
   plane did not create) is not implemented.

3. **A tropism reaches the model as framed prompt text.** `resolveTropisms`
   bounds the composed scope to `TROPISM_BYTE_BUDGET` (4000 bytes), and the
   native executor composes the `session_start` scope into the first prompt
   and the `turn_end` scope into the next turn's prompt, inside a framed block
   the prompt contract treats as data. It is not a context-manager entry,
   which the native worker would never render.

4. **The native tropisms that ship.** `inject.governance-orient`,
   `inject.session-isolation`, `inject.owed-decisions`,
   `inject.operator-decision-queue` and `inject.repo-session-open` on
   `session_start`; `inject.evidence-staleness` and `inject.vi-graph-debt` on
   `turn_end`; `inject.vi-freshness` on `session_start`. Of the proposal's
   §5.4 catalog this covers `orient`, `sink` and a session-start form of
   `sibling`; `lease`, `continue`, `delta`, `rot` and `expiry` do not exist.

5. **Native vetoes and observers replace the host guards.**
   `veto.git-write-guard`, `veto.vi-readonly-guard` and
   `veto.claim-completeness-guard` on `tool_preflight`;
   `observe.vi-dirty-tracker` on `tool_write`, the sole writer of
   `.visual-intelligence/.dirty`; and `observe.stop-battery` on `turn_end`,
   whose verdict the worker's `turn_gate` (`stopBatteryTurnGate`) turns into a
   refusal the model reads.

6. **Registration is not activation.** Every replacement above ships with a
   descriptor in `DEFAULT_HOOK_DESCRIPTORS`, because a handler that is only in
   the registry is selectable and never dispatched. `gate:hook-devolution`
   (`auditDevolution`) holds the ledger of host hooks against their native
   replacements; at the authoring revision it reports 16 devolved and 0
   pending, and `.claude/settings.json` and `.codex/hooks.json` register no
   hooks.

## Consequences

**Positive.** The governance behaviour that used to depend on which external
host was running now fires inside the native harness, and the model reads
harness state through one bounded, typed channel instead of prose a shell
script printed.

**Negative, stated rather than implied.** The tropisms that would ENFORCE
behaviour — `lease`, `continue`, `delta` — do not exist, so every shipped
tropism is advisory text except where a separate veto or the stop battery's
turn gate already enforces the same thing. `session-isolation` reports at
session start only, not continuously. The deleted host scripts were removed,
not moved to an archive directory as the proposal's §5.5 described.

## Alternatives / Roads not taken

- **Append tropisms to the native context manager.** Rejected:
  `boundedHistory` drops an entry no conversation entry cites, so an appended
  fact never reaches the model. The `e2e.test.ts` negative control pins this.
- **Keep the host hooks beside the native ones.** Rejected by the operator
  (proposal Amendment 1, ADR-177 decision 3): two enforcement layers fire on
  different sessions and drift.
- **Treat a registry entry as activation.** Rejected in `0f3ed28f`: four host
  hooks had been deleted in favour of handlers nothing dispatched, and
  `arbor hook validate` reported success over the empty set.

## Obligations

### O1 — Inject is a hook kind whose handlers return a typed, bounded tropism

<!-- proof: symbol=resolveTropisms file=packages/arbor-prompts/src/tropisms.ts roundtrip=packages/arbor-prompts/tests/tropisms.test.ts -->

A composed tropism scope never exceeds `TROPISM_BYTE_BUDGET` and is rendered
as a framed data block.

### O2 — The catalog drops an imperative ADVISORY tropism and an unenforced CODE one

<!-- proof: symbol=HookCatalog file=packages/arbor-mcp/src/hooks/catalog.ts roundtrip=packages/arbor-mcp/tests/hooks/catalog.test.ts -->

`validateTropism` returns `advisory_imperative` and `code_unenforced`
diagnostics for the two shapes, and the injector renders nothing for them.

### O3 — A tropism is not re-injected while its derivation is unchanged

<!-- proof: symbol=TropismInjector file=packages/arbor-mcp/src/hooks/inject.ts roundtrip=packages/arbor-mcp/tests/hooks/inject.test.ts -->

Two injections with an identical `derived_from` render one block; a changed
derivation or a closed expiry window renders again; dedupe is per session.

### O4 — The shipped replacements are activated by default descriptors

<!-- proof: symbol=DEFAULT_HOOK_DESCRIPTORS file=packages/arbor-mcp/src/hooks/catalog.ts roundtrip=packages/arbor-mcp/tests/hooks/e2e.test.ts -->

The default descriptors, materialised into a real `.arbor/hooks`, load and fire
through `HookBus`.

### O5 — The orient tropism derives from live repository posture

<!-- proof: symbol=governanceOrientTropism file=packages/arbor-mcp/src/hooks/governance-tropisms.ts roundtrip=packages/arbor-mcp/tests/hooks/governance-tropisms.test.ts -->

The `session_start` orientation is computed from the repository it runs in,
not from constant text.

### O6 — The native read-only veto refuses what the deleted host guard refused

<!-- proof: symbol=viReadOnlyGuard file=packages/arbor-mcp/src/hooks/vi-readonly-guard.ts roundtrip=packages/arbor-mcp/tests/hooks/file-write-guards.test.ts -->

While a visual-intelligence run is armed, a write outside
`.visual-intelligence/` is refused.

### O7 — The native claim-completeness veto refuses what the deleted host guard refused

<!-- proof: symbol=claimCompletenessGuard file=packages/arbor-mcp/src/hooks/claim-completeness-guard.ts roundtrip=packages/arbor-mcp/tests/hooks/file-write-guards.test.ts -->

A completeness marker added without a proof comment in the same change is
refused.

### O8 — The edited-path record has a native writer

<!-- proof: symbol=viDirtyTracker file=packages/arbor-mcp/src/hooks/vi-dirty-tracker.ts roundtrip=packages/arbor-mcp/tests/hooks/vi-dirty-tracker.test.ts -->

A `tool_write` on a repository path appends it to `.visual-intelligence/.dirty`
once; the graph's own output and paths outside the repository are skipped.

### O9 — The stop battery's verdict refuses a turn natively

<!-- proof: symbol=stopBatteryTurnGate file=packages/arbor-mcp/src/hooks/stop-battery.ts roundtrip=packages/arbor-mcp/tests/hooks/stop-battery.test.ts -->

A red battery measured on `turn_end` reaches the model through the real
`NativeHarnessWorker` as a refusal, and the no-progress breaker releases.

### O10 — Every host hook is accounted for against its native replacement

<!-- proof: symbol=auditDevolution file=scripts/hook-devolution-gate.mjs roundtrip=scripts/tests/hook-devolution-gate.test.mjs -->

`gate:hook-devolution` fails a host registration with no ledger row, and a
devolved row whose descriptor no default entry names or whose seam does not
dispatch it.
