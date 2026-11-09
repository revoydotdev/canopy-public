# ADR-067: Staggered Verifier-Gated Specialist Racing

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** 91bac0e01d922d06c89b25808fa37eaf399b617e
**Content ID:** sha256:92388a19f045a366b7c7783d0c24d0a91f94746b915f6e467af0687f68638b59

## Context

Cycle-3's research manifest (qa-bench/manifests/CYCLE3-MANIFEST.md — external
research-tooling output, never checked into this repository, synthesized
from cycle3-parallel-racing.md, arXiv 1311.2851 and 1710.00414
"speculative/straggler execution", and SWE-Gym 2412.21139's verifier
framing) identified the largest remaining wall-time term in bench v4's
decomposition: specialist dispatch variance of 11-49s, dominated by a small
number of slow outliers rather than a uniformly slow population. A flat
N-way parallel dispatch (simultaneous racing) pays 2x cost on every node to
shave the tail on a minority of nodes — an unacceptable trade against the
bench's fixed accuracy/governance envelope, which this cycle holds constant.
The dispatch pipeline already has the two pieces a *staggered* race needs
without adding new machinery: OPT-1's `deferred_verification` (a specialist
result carries an independent, pipelined machine-verification promise that
never rejects and distinguishes "verified" from "attempted and failed" from
"nothing was attempted"), and per-node worktree isolation via
`WorktreeManager.acquireLease`/`releaseLease` (ADR-023), each lease keyed by
tree node id with its own git worktree and branch.

## Decision

A new module, `packages/arbor-opencode/src/race.ts`, adds staggered
first-verified-wins racing as a strictly opt-in wrapper around the existing
specialist dispatch — never a new dispatch model. `runCampaign` (`loop.ts`)
calls it only when ALL of:

- `ARBOR_RACE_SPECIALISTS === "2"` (env-gated, default off);
- the campaign's recorded governance tier (`manager.getCampaignSnapshot(
  campaign_id)?.governance?.tier`, ADR-062) is `"direct"` or `"reviewed"` —
  never `"governed"`, and never a campaign with no recorded tier at all;
- `config.use_worktrees` is true — racing requires the real isolation seam,
  not the fake `.tmp` path the loop uses when worktrees are off.

Attempt 1 dispatches exactly as before this ADR: same prompt, same already-
acquired worktree, routed through its own `AbortController` (still forwarded
from the loop's incoming signal) purely so it can be cancelled if attempt 2
wins. If attempt 1's `deferred_verification` has not settled with the
`{provenance}` (verified) shape by `ARBOR_RACE_FORK_MS` (default 25000ms —
the bench's measured p50 — validated and clamped to [5000, 300000]ms), the
loop forks a second attempt into a second REAL isolated worktree, acquired
through the identical `WorktreeManager.acquireLease`/`releaseLease` seam
attempt 1 used. Because that lease store is keyed strictly by tree node id
(one active lease per node, `worktree.ts`), a genuinely second, independently
leased worktree for the same node needs a distinct lease *key*
(`${node_id}::race-fork`) — the only extension to the seam; the acquisition
mechanism itself, its git worktree/branch creation, and its release path are
unchanged and reused as-is. The fork runs under its own `AbortController`.

Whichever attempt's `deferred_verification` resolves to the verified shape
first wins; the loser is aborted via its own signal and its worktree
released through the same lease path, on both an actual fork win and an
actual fork loss. If neither attempt ever verifies, both run to natural
completion (bounded by the executor's own turn/timeout limits, unchanged),
and the loop falls back to attempt 1's result — today's exact semantics.
Only machine verification ever selects a winner; a specialist's output text,
`final_message`, or a fast-but-unverified completion is never consulted.

Both attempts' token spend reaches the ledger (X-2): the winner through the
existing `recordUsageCost`/`emitCost` path, unchanged, and the loser through
the identical path tagged `outcome: "cancelled"` — except in the one case
where the loser's usage is genuinely unrecoverable (its `specialize()` call
was aborted before returning any provider-observed usage), which is never
represented as a fabricated zero-token `usage_cost` row. That case is
instead journaled honestly on a new, additive race-outcome observation
(`RaceOutcomeObservation`, `@arbor/core/types.ts`, mirroring how
`MarginalCostObservation`/`ArbiterDecision` already live there):
`{forked_at_ms, winner: "primary"|"fork"|"none", loser_wall_ms, cancelled,
loser_usage_unavailable_reason?}`, wired through a new optional
`LoopTelemetryPort.recordRaceOutcome` (loop.ts) — additive and
best-effort, matching every other telemetry recorder in that port
(`recordToolEconomy`, `recordContextEconomy`). This observation does not
join `@arbor/audit`'s closed `TelemetryObservation` union in this cycle:
`arbor-audit/src` is outside this change's ownership (Cycle-3's sibling
lineage-governance workstream owns it); a caller wires `recordRaceOutcome`
into its own ledger sink at integration.

## Consequences

On the minority of nodes whose specialist variance actually crosses the
fork threshold, expected wall time drops toward `min(t1, t2 + stagger)` and
expected cost rises to at most ~1.5x (never the 2x a flat parallel race
would cost every node) — the manifest's explicit deferral of "Simultaneous
N=2" to a later cycle. Fast nodes (the common case, verifying well inside
the threshold) never fork and pay zero incremental cost or latency: the
race gate's own first check is on the env var, and the fork timer only ever
starts after attempt 1 has already returned. The known adversarial risk
this record deliberately does not resolve: SWE-ABS (arXiv 2603.00520)'s
verifier-gaming caution — a specialist that games the verification command
itself (rather than doing genuine work) still wins a race exactly as it
would win a solo dispatch today, because racing changes nothing about what
`deferred_verification` trusts. This ADR only changes *how many* attempts
compete for the same verification gate, not what that gate accepts; that
risk exists independent of this change and is not deepened by it. The
`governed` tier is excluded entirely — a race's cancelled-loser accounting
and dual-worktree footprint are judged an unacceptable addition to a
campaign's audit surface at the tier the ledger treats as highest-stakes,
and the manifest does not ask for it there.

## Obligations

### O1 — The race gate is closed by default and refuses every ineligible tier, with no code path that engages it silently

<!-- proof: symbol=isRaceEligible file=packages/arbor-opencode/src/race.ts roundtrip=packages/arbor-opencode/tests/race.test.ts -->

`isRaceEligible(env, tier)` is `false` whenever `env.ARBOR_RACE_SPECIALISTS
!== "2"`, and `false` for `tier` values `"governed"`, `undefined`, and
`null` regardless of the env flag; it is `true` only for `"direct"` and
`"reviewed"` with the flag set. `runCampaign` additionally requires
`config.use_worktrees` before ever calling `raceSpecialize`
(`packages/arbor-opencode/tests/loop-race.test.ts`), so a worktree-less
config never forks even with a satisfied env/tier gate.

### O2 — No fork occurs before the threshold, and a fork occurs only once it elapses without a verified attempt 1

<!-- proof: symbol=raceSpecialize file=packages/arbor-opencode/src/race.ts roundtrip=packages/arbor-opencode/tests/race.test.ts -->

`raceSpecialize` calls `executor.specialize` exactly once, and no fork
worktree is ever acquired, when attempt 1's `deferred_verification`
resolves to the verified shape before `forkThresholdMs` elapses. Past the
threshold without a verified attempt 1, exactly one additional
`executor.specialize` call is dispatched into a worktree acquired via
`WorktreeManager.acquireLease({..., node_id: "<node>::race-fork"})`.

### O3 — Only machine verification picks the winner, the loser is always aborted and its worktree always released, and a both-fail race falls back to attempt 1 unchanged

<!-- proof: symbol=raceSpecialize file=packages/arbor-opencode/src/race.ts roundtrip=packages/arbor-opencode/tests/race.test.ts -->

The returned `result` is whichever attempt's `deferred_verification`
resolved to the `{provenance}` shape first; the other attempt's
`AbortController` is aborted (observed on its `signal.aborted`) and
`WorktreeManager.releaseLease("<node>::race-fork")` is called before
`raceSpecialize` returns, on both a primary win and a fork win. When
neither attempt ever verifies, the returned `result` is attempt 1's
unmodified `SpecialistResult` and `outcome.telemetry.winner` is `"none"`.

### O4 — Both attempts' real spend reaches the ledger, and an unrecoverable loser usage is never represented as a fabricated zero-token row

<!-- proof: symbol=raceSpecialize file=packages/arbor-opencode/src/race.ts roundtrip=packages/arbor-opencode/tests/loop-race.test.ts -->

`runCampaign` emits a `recordUsageCost` row for the winner via its existing
specialist-usage path, and a second `recordUsageCost` row
(`outcome: "cancelled"`) for the loser whenever the loser's `token_usage`
is a real, measured `TokenUsage`. When the loser's dispatch was aborted
before returning any usage, no `recordUsageCost` row is emitted for it;
instead `RaceOutcomeObservation.loser_usage_unavailable_reason` carries the
executor's own honest reason (or, if the losing `specialize()` call never
returned at all, a fixed honest string saying so), emitted through
`LoopTelemetryPort.recordRaceOutcome`.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority separate
from the implementation and authoring authority used in this tranche.
