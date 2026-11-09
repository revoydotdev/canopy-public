# ADR-180: Gates Prove They Can Fail, and Report Unresolved Instead of Passing on Nothing

**Status:** Accepted
**Date:** 2026-10-06
**Authoring Revision:** 0340135296b271230647f545eb6723873f64a822
**Content ID:** sha256:5f2dd3046bdcb5c5feb94008e4950224122c81f9b522e58a6568aa6826d16527

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances). This record RATIFIES
work that already landed; it adds no mechanism.

Arboretum M1 (`docs/proposals/arboretum-coordination-plane.md` §7.1, §9 M1,
§12 item 1) landed in three commits — `db314555` (canary harness and tri-state
results), `35e2667d` (canary fixtures for 52 more gates, and an env overlay)
and `76467f20` (a canary cannot be proven without the gate running) — under the
`ADR: 074` trailer, because ADR-074 governs the gate battery those commits
touched. No record states the contract they established, so a reader of
`decisions/` cannot learn that a gate is expected to prove it can fail, or that
`unresolved` is a status the control plane emits and never counts as green.
ADR-177 cites "the Arboretum M1 lane" only as context.

The defect M1 answered is the proposal's finding R2: nothing executed a gate
body and asked whether it could fail. `scripts/adr-status-audit.mjs` exits 0 on
every path, including its failure path, and reports green; a gate that observed
an empty input and exited 0 reports green as well. Both are confident greens
that carry no evidence.

## Decision

This records what the code at the authoring revision does.

1. **A gate may declare a canary in `scripts/execution-profile.json`.**
   `canary: { fixture, expected_failure_reason, args?, git_repo?,
   link_repo_paths?, env? }` names a fixture directory under
   `scripts/canaries/` — a minimal repository root the gate was built to
   reject — and the reason it must fail with. `auditExecutionProfile`
   validates every key, rejects `canary.command`, and validates `env` as a map
   of POSIX names to scalars. At the authoring revision 57 of the profile's 62
   gates declare a canary.

2. **The census runner owns the spawn path.** `bun run guard:canaries`
   (`scripts/guard-canaries.mjs`) copies each fixture to a scratch directory
   and spawns the gate as `bun run <gate>` there; no profile entry can name a
   different program (`76467f20`). Each gate is classified by
   `classifyCanaryResult` as exactly one of `proven` (failed for the declared
   reason), `unproven` (passed the input it must reject), `misfired` (failed
   for an undeclared reason, so the canary or the gate moved) or `unmigrated`
   (no canary declared, listed by name). The census exits non-zero while any
   gate is `unproven`. `--self-test` runs a scratch gate whose body is
   `process.exit(0)` and requires it to classify `unproven`.

3. **Gate results are tri-state.** `GATE_STATUSES` includes `unresolved`, and
   `GREEN_GATE_STATUSES` is exactly `passed` and `cached`; `isGreenGateStatus`
   is the one predicate aggregates use. A gate that declares
   `observes: { min: N }` reports how much it looked at through one plain
   output line, `observed_count: <n>` (`parseGateObservedCount`). When such a
   gate exits 0 having observed fewer than N, or reported no count at all,
   `executeGateDag` records it `unresolved`, which fails the battery. A gate
   that declares no `observes` is never downgraded. At the authoring revision
   four gates declare it: `gate:adr-citations`, `gate:adr-sections`,
   `gate:adr-status` and `gate:hook-devolution`.

## Consequences

**Positive.** A gate's green can be checked against a demonstration that the
same gate goes red on the input it claims to check, and an empty input no
longer passes silently for the gates that opted in.

**Negative, stated rather than implied.** The proposal's Guard job is not
built: nothing runs the census on a gate-body change or on a schedule, and no
`unproven` result quarantines that gate's later greens. The census runs when
someone runs `bun run guard:canaries`. It is not a `gate:*` script and sits in
no execution context. The proposal's remaining §7.1 fixes (`gate:adr-status`
exit codes, `gate:claim-ledger` failing open, `gate:adr-trace` on a push to
master) are not decided here.

## Alternatives / Roads not taken

- **Let a canary name its own command.** Rejected in `76467f20` after a
  demonstrated bypass: a canary that ran `sh -c 'echo <reason>; exit 1'` was
  classified `proven` without the gate ever running.
- **Make `observed_count` a JSON channel.** Rejected: most gates have no JSON
  mode, and adding one to each is a larger change than the fact it reports.
- **Downgrade every gate that prints no count.** Rejected: silence from a gate
  that never declared an expectation is not evidence of an empty input, and
  downgrading it would turn the whole battery red at once.

## Obligations

### O1 — A canary is validated in the profile and cannot name its own program

<!-- proof: symbol=auditExecutionProfile file=scripts/enforcement-control-plane.mjs roundtrip=scripts/tests/guard-canaries.test.mjs -->

`auditExecutionProfile` rejects a canary with no expected reason, malformed
args, env or git keys, or any `command`.

### O2 — The census classifies a gate that passes its own canary as unproven

<!-- proof: symbol=classifyCanaryResult file=scripts/guard-canaries.mjs roundtrip=scripts/tests/guard-canaries.test.mjs -->

An exit 0 on the canary is `unproven`, never `proven`; a failure for an
undeclared reason is `misfired`; an undeclared canary is `unmigrated`.

### O3 — The runner spawns the real gate

<!-- proof: symbol=runCanary file=scripts/guard-canaries.mjs roundtrip=scripts/tests/guard-canaries.test.mjs -->

A canary that declares `command` is refused instead of run, and the negative
control (a `process.exit(0)` gate) classifies `unproven` with the census not ok.

### O4 — Unresolved is never green

<!-- proof: symbol=isGreenGateStatus file=scripts/enforcement-control-plane.mjs roundtrip=scripts/tests/guard-canaries.test.mjs -->

`unresolved` is a member of `GATE_STATUSES` and not of `GREEN_GATE_STATUSES`.

### O5 — The control plane downgrades an under-observing gate to unresolved

<!-- proof: symbol=executeGateDag file=scripts/enforcement-control-plane.mjs roundtrip=scripts/tests/enforcement-control-plane.test.mjs -->

A gate declaring `observes.min: 1` that exits 0 with `observed_count: 0`, or
with no count, is `unresolved` and the battery is not ok; a gate with no
declaration is unaffected.
