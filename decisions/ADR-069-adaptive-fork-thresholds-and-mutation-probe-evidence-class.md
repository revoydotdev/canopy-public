# ADR-069: Adaptive Fork Thresholds and a Mutation-Probe Evidence Class

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** d3842aacc3a0e8a1ab967d69b4e2770291d21a57
**Content ID:** sha256:c8cd42d0a60460d386ae2c18f86206415d22287a65582938e05263803ba20369

## Context

Cycle-4's research manifest (qa-bench/manifests/CYCLE4-MANIFEST.md — external
research-tooling output, never checked into this repository, synthesized
from cycle4-adaptive-scheduling.md / cycle4-mutation-
hardening.md, arXiv 1311.2851, 1702.00046, CoHarden 2607.19843, and Ojdanic
2112.14566) identified two remaining gaps ADR-067's staggered racing left
open. First, `DEFAULT_RACE_FORK_MS` (25000ms) was a single guess taken from
bench v4's wall-time decomposition; by cycle-4 the persistence directory's
audit ledgers hold real history of specialist dispatch duration, so a
learned threshold is now possible instead of a fixed one. Second, the
declared acceptance command a specialist's work is judged against is,
structurally, only a WEAK oracle: CoHarden/Ojdanic's finding that most
relevant mutants live *outside* a diff's literal changed lines means a
critic that only re-runs the declared test suite cannot distinguish "this
suite is thorough" from "this suite happens not to touch the broken
behavior." Both gaps are additive to ADR-067's existing racing/telemetry
machinery, not replacements for it.

**Honesty finding that shaped both decisions below (X-1's ledger
investigation, done before design, per this workstream's brief):**
inspecting every `observation.type` emitted across ~56 real bench ledgers
under `qa-bench/{ab,ab2,ab3,fastify}/**/.arbor/audit/*.jsonl` (247
`phase_timing`, 92 `usage_cost`, 90 `role_model_identity`, 60
`node_cost_attribution`, 4 `race_outcome`, 1 `tool_economy` records) showed:

- **No task-category field exists anywhere in the ledger schema.**
  `campaign_id`/`node_id`/`operation_id`/`epoch` are the only identity
  fields any record carries. The manifest's ideal of a per-task-CLASS
  learned threshold is therefore not implementable against what the
  ledgers actually contain this cycle.
- **`phase_timing` never times the specialist call itself.** Only
  `select`/`expand`/`backprop`/`critic` are timed phases. `expand`'s own
  `duration_ms` is pure bookkeeping (7-45ms across every sample inspected)
  — the real specialist generation happens *between* the `expand`
  `phase_timing` event and the specialist's own `usage_cost` event (emitted
  once `specialize()` returns), which brackets the real wall time (verified
  against a real ledger: `expand` @ `...:35.964Z`, specialist `usage_cost`
  @ `...:20:04.866Z` → 28.9s, corroborated by that node's `critic`
  `phase_timing` starting at `...:20:04.893Z`).

## Decision

### X-1: `resolveLearnedForkThresholdMs` (`packages/arbor-opencode/src/
race-threshold.ts`)

A new pure, synchronous function scans `<persistenceDir>/audit/*.jsonl`
(bounded: newest ≤50 files by mtime, individually-unreadable/malformed
files and lines skipped silently) and computes, for every
`(campaign_id, node_id, epoch)` that has both an `expand` `phase_timing`
event and a `:specialist`-suffixed `usage_cost` event, the delta

```
specialist_wall_ms = timestamp(usage_cost) - timestamp(phase_timing "expand")
```

— the simplest honest signal the current ledger schema actually supports
for "how long did the specialist take," named explicitly here rather than
silently substituted for the manifest's "specialist `phase_timing` wall"
framing, which is not what gets emitted. With ≥5 such deltas, the
threshold is `p50(deltas)` (plain sort — no streaming estimator, matching
the manifest's explicit deferral of that machinery), clamped into
`[MIN_RACE_FORK_MS, MAX_RACE_FORK_MS]` exactly as the existing fixed
`resolveForkThresholdMs` clamps. With fewer than 5, or no readable ledgers
at all, the function returns the unchanged existing fallback
(`resolveForkThresholdMs(env)`), tagged `source: "default"`.
`taskCategory` is accepted as a parameter (forward-compatible with the
manifest's per-class ideal) but is **deliberately not used to filter
observations** this cycle — every call computes one GLOBAL p50 — per the
honesty finding above; this is a recorded deviation, not an oversight.
`ARBOR_RACE_FORK_MS` (the existing env override) always wins over a
learned value, tagged `source: "env"`.

The chosen threshold and its provenance ride `RaceOutcomeObservation`
(`@arbor/core/types.ts`) as three new, purely additive optional fields:
`threshold_ms?: number`, `threshold_source?: "learned" | "env" |
"default"`, `threshold_observations?: number`. `race.ts`'s
`RaceSpecializeInput` gains matching optional `thresholdSource` /
`thresholdObservations` fields; when a caller supplies them,
`raceSpecialize` threads them into every telemetry-emitting branch
(fork-free, degraded-no-fork, and full-race outcomes alike). A caller that
never supplies them sees telemetry byte-identical to pre-ADR-069 — no
existing consumer's shape changes.

### X-2: `probeMutations` (`packages/arbor-mcp/src/mutation-probe.ts`)

A new module, composed exactly like `test-amplifier.ts`'s
`amplifySiblingSites` (env-gated off by default, injectable
`MachineVerificationCommandPort`, silent degradation on every failure
mode, one pure exported entry point), generates up to 8 string-level line
mutants over the UNION of the current diff's changed lines and the
caller's sibling-scan-flagged sites (deduplicated by `(file, line)`, diff
sites first). Four operators, no AST dependency, tried in priority order
per line (first applicable operator wins; a line matching none is
skipped): comparison flip (`===`↔`!==`, `<=`→`<`, `>=`→`>`, `<`→`<=`,
`>`→`>=`, longest-token-first so `<=`/`>=` are never mistaken for bare
`<`/`>`), boolean negation of a single-line `if (...)` condition, numeric
constant ±1 (first standalone integer literal), and early-`return` line
removal (blanked in place, preserving line numbers).

Each mutant is applied one at a time: original file bytes are captured
before the write, the mutant is written, the caller's declared acceptance
command runs through the injectable command port (early-kill timeout
`min(20s, remaining budget)`, 60s total budget across the whole probe),
and the original bytes are restored in a `finally` — guaranteed
byte-identical restoration on every exit path, including the command port
itself throwing. A mutant the command still exits 0 against (a
"survivor") produces one evidence-only finding
`{site, mutant_description, survived: true}`; anything else (non-zero
exit, or the command never reaching a real exit at all — timeout,
cancellation, spawn failure, output cap, or a thrown port call) is treated
identically as "killed, no finding either way," mirroring the amplifier's
compile-gate posture. The probe stops after 2 survivors regardless of how
many candidate mutants remain.

Findings are evidence, never authority: a surviving mutant means the
declared acceptance command cannot distinguish that specific mutation —
weak-oracle evidence for the critic, exactly the same evidence class
`amplifySiblingSites` already established (ADR-066) — and is never fed
into `recordResult` or treated as a blocking outcome.

### ADR-069's own scope boundary

Both X-1 and X-2 are, by this workstream's file ownership, disconnected
from their production call sites: `race-threshold.ts`'s
`resolveLearnedForkThresholdMs` is not called from `loop.ts`'s existing
`resolveForkThresholdMs(env)` site, and `mutation-probe.ts`'s
`probeMutations` is not composed into `arbor-mcp/src/cli.ts` alongside
`amplifySiblingSites`. `loop.ts` and `cli.ts` are both explicitly outside
this change's file ownership per the cycle-4 manifest (owned by the
sibling `Y` workstream / self-integration). These are documented,
intentional integration points — see Consequences — not omissions;
`scripts/reachability/allowlist.json` carries dated (`2026-08-22`)
`ADR-069`-tagged entries for every symbol only reachable from this
workstream's own tests until that wiring lands.

## Consequences

**Threshold-provenance ledger-visibility rule — SATISFIED (verified
2026-08-18).** `arbor-audit`'s `race_outcome` validator now accepts
`threshold_ms` / `threshold_source` / `threshold_observations`
(`packages/arbor-audit/src/audit.ts:557-559,2406-2409`), so the prohibition
stated below has been lifted by the acceptance it was waiting for. The original
rule is retained as the record of the constraint that applied at authoring
time: `arbor-audit`'s validator did not yet accept these fields (that union
lives in `arbor-audit/src`, outside this change's ownership, exactly as ADR-067
already established for the base `RaceOutcomeObservation` fields). A
caller MUST NOT set these fields on an observation journaled through a
real `EvidenceLedger` until the validator's acceptance lands — doing so
before that lands would either be silently dropped or rejected depending
on the validator's exact strictness, neither of which this workstream can
verify without touching `arbor-audit`. This module's own tests therefore
assert the returned telemetry shape directly against `raceSpecialize`'s
return value, never through a real ledger round-trip. Discharging this is
the documented integrator obligation alongside the two wiring points
above.

**Evidence-only posture is load-bearing, not incidental.** `probeMutations`
never determines merge/verification outcomes, matching ADR-066's
`amplifySiblingSites` precedent exactly: a weak oracle surviving a mutant
is informative to a human or critic reviewing the node, never a gate.
Widening this into an actual blocking gate would need its own ADR (the
manifest's explicit deferrals list several adjacent ideas — partial-signal
early loser cancellation, StrykerJS-grade full mutation testing — as
deliberately out of scope for exactly this reason).

**Global rather than per-class threshold is a real accuracy cost.** A
learned p50 blending fast trivial edits with slow complex refactors will
systematically under-threshold the former (never actually harmful — a fork
after an already-verified fast node's threshold elapses simply never
happens) and may over- or under-threshold the latter depending on the
corpus's mix at learn time. This is accepted as strictly better than a
single hand-picked constant, but it is not the manifest's per-class ideal;
revisiting this once the ledger schema gains a category field (a change
this ADR does not itself make) is the natural supersession path.

**No behavior changes for an untouched caller.** Every new field on
`RaceOutcomeObservation` and `RaceSpecializeInput` is optional; a caller
that never adopts `resolveLearnedForkThresholdMs` or supplies
`thresholdSource` sees `race.ts` behave exactly as ADR-067 left it.
`probeMutations` performs zero file writes or command-port calls unless
`ARBOR_MUTATION_PROBE=on` is set.

## Obligations

### O1 — The learned threshold is provably bounded, honestly-provenanced, and never silently substitutes a category it cannot actually observe

<!-- proof: symbol=resolveLearnedForkThresholdMs file=packages/arbor-opencode/src/race-threshold.ts roundtrip=packages/arbor-opencode/tests/race-threshold.test.ts -->

`resolveLearnedForkThresholdMs(persistenceDir, taskCategory, env)` returns
`source: "env"` whenever `ARBOR_RACE_FORK_MS` is set (regardless of ledger
contents), `source: "default"` whenever fewer than 5 real
`specialist_wall_ms` deltas are extractable from `<persistenceDir>/audit`,
and otherwise `source: "learned"` with `thresholdMs` equal to the clamped
p50 of exactly the extracted deltas and `observations` equal to their
count. Calling it with different `taskCategory` values against the same
ledger contents returns identical results (asserted directly), which is
the honest expression of "this field is accepted but not yet filtering
anything."

### O2 — The specialist-wall statistic is derived only from real ledger record shapes, never fabricated

<!-- proof: symbol=collectSpecialistWallObservations file=packages/arbor-opencode/src/race-threshold.ts roundtrip=packages/arbor-opencode/tests/race-threshold.test.ts -->

`collectSpecialistWallObservations` extracts a delta only for a
`(campaign_id, node_id, epoch)` triple that has both a `phase_timing`
observation with `phase: "expand"` and a `usage_cost` observation whose
`operation_id` ends `:specialist` (never confusing a `:critic`-suffixed
`usage_cost` row for a specialist one); malformed JSON lines, missing
fields, and an absent/unreadable audit directory all degrade to fewer (or
zero) observations rather than throwing.

### O3 — Threshold provenance is additive and never changes existing telemetry shapes for an unmigrated caller

<!-- proof: symbol=raceSpecialize file=packages/arbor-opencode/src/race.ts roundtrip=packages/arbor-opencode/tests/race.test.ts -->

`raceSpecialize`'s returned `outcome.telemetry` carries no
`threshold_ms`/`threshold_source`/`threshold_observations` keys at all
when the caller's `RaceSpecializeInput` omits `thresholdSource`; when
supplied, all three fields are threaded through every telemetry-emitting
branch (fork-free-verified, degraded-no-fork, and full dual-attempt race),
with `threshold_observations` defaulting to `0` when omitted alongside a
supplied `thresholdSource`.

### O4 — A mutation probe never runs, writes, or spawns anything unless explicitly enabled, and always restores the exact original bytes

<!-- proof: symbol=probeMutations file=packages/arbor-mcp/src/mutation-probe.ts roundtrip=packages/arbor-mcp/tests/mutation-probe.test.ts -->

`probeMutations` returns `[]` with zero calls to `read_file`/`write_file`/
`command_port.run` whenever `ARBOR_MUTATION_PROBE` is not exactly `"on"`.
When enabled, every mutant's target file is restored to its pre-mutation
byte content before `probeMutations` returns from that mutant's
iteration — including when `command_port.run` itself throws — verified by
asserting the file's final content equals the original in both the
killed-mutant and command-port-throws cases.

### O5 — A mutation finding is evidence-only: a survivor is reported, never blocking, and is bounded by both a survivor cap and a mutant cap

<!-- proof: symbol=probeMutations file=packages/arbor-mcp/src/mutation-probe.ts roundtrip=packages/arbor-mcp/tests/mutation-probe.test.ts -->

A mutant the acceptance command still exits `0` against produces exactly
one `{site, mutant_description, survived: true}` finding and nothing else
in `probeMutations`'s return value (no exception, no side channel).
Dispatch never exceeds `MUTATION_PROBE_MAX_MUTANTS` (8) total mutants
across every candidate site, and stops entirely once
`MUTATION_PROBE_MAX_SURVIVORS` (2) survivors have been found, verified
against a fixture with more than 8 candidate sites and a fixture whose
first several mutants all survive.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority separate
from the implementation and authoring authority used in this tranche.
