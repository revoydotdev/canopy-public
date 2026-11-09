# ADR-071: Race None-Tie Arbitration and Mutation-Probe Hardening

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** 46e7d15f1b4775002a1b16adc62fa4e983fe20e3
**Content ID:** sha256:949f4cb90a15367ccc86e87714d3fa50ed8271a30dadece5a55e4690a65374f5

## Context

qa-bench/manifests/POSTM-MANIFEST.md's Agent X tranche (PM-1, PM-2 — external
research-tooling output, never checked into this repository) closes
two remaining gaps in the two evidence/racing modules ADR-067 and ADR-069
already landed:

1. **PM-1.** `raceSpecialize` (ADR-067) forks a second attempt when
   attempt 1's deferred verification hasn't settled by the fork threshold.
   When a race actually forks and BOTH attempts fully settle without either
   verifying (`winner: "none"`), today's behavior is to take attempt 1
   blindly — there is no seam for anything smarter to weigh in, even though
   a fast critic exists elsewhere in the harness that could plausibly judge
   between two unverified outputs before either goes to the real critic.
2. **PM-2.** `probeMutations` (ADR-069) reports a mutation SURVIVOR — a
   string-level mutant the declared acceptance command still passed —
   purely as evidence: a location the existing tests cannot distinguish.
   CoHarden (2607.19843) goes one step further: given a model capable of
   writing a test, it is possible to CHECK whether a plausible-looking
   "killer test" the model proposes is actually rigorous (kills the mutant,
   passes on real code) before trusting it, rather than trusting the model's
   test blindly (the "lax" CoHarden variant this ADR deliberately avoids).

Both gaps are additive to the existing modules, not replacements: neither
`raceSpecialize`'s verification-picks-every-verified-winner invariant nor
`probeMutations`'s evidence-only, env-gated, byte-identical-restoration
posture change.

## Decision

### X (PM-1): `tie_breaker` seam on `RaceSpecializeInput`
(`packages/arbor-opencode/src/race.ts`)

A new optional field,
`tie_breaker?: (a: SpecialistResult, b: SpecialistResult, signal?: AbortSignal) => Promise<"primary" | "fork" | null>`,
is consulted by `raceSpecialize` in exactly one place: after a race has
actually forked (a second worktree was acquired and a second `specialize()`
call dispatched) AND both attempts have fully settled without either
verifying. It is never consulted when verification already produced a
`"primary"` or `"fork"` winner, and never consulted on the no-fork fast path
(attempt 1 settles before the fork threshold elapses) — that path forks
nothing, so there is no second unverified result to arbitrate between.
`null` (no opinion), a thrown error (caught and treated identically to
`null`), or either attempt's `resultRef` being unusable (the losing
attempt's `specialize()` call itself rejected — see `RaceLoserJournal`'s
existing doc) all fall back to attempt 1, byte-identical to pre-ADR-071
behavior. The seam is deliberately executor-agnostic and constructs
nothing itself — the actual tie-breaking policy (e.g., wiring in the
existing fast critic) is composition-side, at the integrator's cli-glue
layer, exactly as ADR-067 left worktree acquisition and ADR-069 left the
learned-threshold caller composition-side.

`RaceOutcomeObservation` (`@arbor/core/types.ts`) gains one additive,
optional field: `tie_break?: "primary" | "fork" | "none_default"`, present
only on the forked `winner: "none"` telemetry branch. `"none_default"`
covers the no-tie-breaker, null-opinion, and thrown-tie-breaker cases alike
— all three are the same observable outcome (attempt 1 flows) and this ADR
does not fabricate a distinction the telemetry cannot actually support.
`arbor-audit`'s `race_outcome` validator now accepts this field
(`packages/arbor-audit/src/audit.ts:561,2409`, verified 2026-08-18), so the
restriction this paragraph originally stated — that a caller journaling through
a real `EvidenceLedger` must not set `tie_break` until acceptance lands — no
longer applies. It is corrected here rather than removed; the acceptance it
waited on is the same one ADR-069's threshold-provenance fields waited on, and
both landed together.

The module's header invariant comment is corrected to state the true
scope: machine verification alone still picks every VERIFIED winner; the
tie-breaker only ever chooses which UNVERIFIED result reaches the critic
next, and only on the one path where verification produced no opinion at
all.

### X (PM-2): CoHarden-lite hardening in `probeMutations`
(`packages/arbor-mcp/src/mutation-probe.ts`)

For each SURVIVING mutant (bounded by the existing
`MUTATION_PROBE_MAX_SURVIVORS`), a caller may now additionally supply
`harden_model_port` — the same `AmplifierModelPort` shape
`test-amplifier.ts` already exports and uses (imported, not duplicated) —
plus a `run_killer_test` builder mirroring `test-amplifier.ts`'s
`run_generated_test` contract. When both are present, the model port is
asked for ONE killer test per survivor: a test asserting the correct
behavior the mutant breaks. Per CoHarden's rigor gate, the generated test
is trusted only if it passes BOTH legs — exit `0` against the real,
unmutated code, and non-zero against the mutant re-applied. The real-code
leg runs FIRST and needs no extra file write at all: by the time hardening
begins, the base mutation loop has already restored the site file to its
original bytes for every survivor, so only the mutant leg needs a write,
and that write is restored in a `finally` with the same byte-identical
discipline the base probe already uses for every mutant application. A
test that is not rigorous by both legs — kills neither, kills the real
code, or the killer's own run never reaches a real exit — is discarded
silently, the same posture an unkilled base mutant already gets; the
finding stays a plain `{site, mutant_description, survived: true}`. A
rigorous killer upgrades the finding additively: `hardened: true`,
`killer_test_source: string` (the killer test's source, byte-capped at
`MUTATION_HARDEN_KILLER_SOURCE_MAX_BYTES` (4096) with a trailing
truncation marker when it would exceed that). The generated killer test
file itself is written to the worktree at a bounded, collision-resistant
path (mirroring `test-amplifier.ts`'s `defaultTestFilePath`) and
best-effort deleted afterward — its survival on disk is not load-bearing
for anything downstream, so a deletion failure is swallowed, never
propagated.

Both `ARBOR_MUTATION_PROBE=on` (the existing gate) AND the new
`ARBOR_MUTATION_HARDEN=on` are required; hardening makes zero model or
command-port calls when either is absent, `harden_model_port` is absent or
not `ready`, or `run_killer_test` is absent. Hardening has its own
`MUTATION_HARDEN_BUDGET_MS` (30s) wall budget, tracked from the moment the
hardening phase begins — additive to, never shared with or subtracted
from, the base probe's own `MUTATION_PROBE_TOTAL_BUDGET_MS` (60s).

**Still evidence only.** A hardened finding is not fed into `recordResult`
and does not become a blocking outcome; it merely rides a working,
CoHarden-rigor-checked test alongside the finding so an operator can adopt
it by hand. `probeMutations` (or `loop.ts`/`cli.ts`) is not itself wired to
call hardening automatically this tranche — same "this module does not
touch `loop.ts`/`cli.ts`" boundary ADR-069 already documented for the base
probe.

## Consequences

**PM-1** adds one optional field to a public seam and one optional field
to a public telemetry type; an unmigrated caller of either `race.ts` or
`RaceOutcomeObservation` sees byte-identical behavior and shapes to
pre-ADR-071. The tie-breaker's actual POLICY quality (e.g., how good a
particular fast critic is at picking between two unverified outputs) is
entirely composition-side and outside this ADR's proof obligations — this
ADR proves only that the seam's CONTRACT (when it is called, how its
answer is used, how failure degrades) is honored, not that any particular
tie-breaking implementation makes good decisions.

**PM-2** trusts a model-generated test only after an independent two-leg
machine check, not on the model's say-so — the CoHarden "rigorous" variant,
deliberately not the "lax" one that would accept a generated test without
checking it can actually distinguish the mutant. This still cannot prove
the killer test is a GOOD test beyond the one mutant it was checked
against (e.g., it could pass by asserting something narrower than the real
invariant); the rigor gate proves only "kills this specific mutant, passes
on real code," which is the honest and bounded claim this evidence class
makes, not a broader test-quality claim.

**No behavior changes for an untouched caller**, in both cases — the same
posture ADR-067's and ADR-069's own Consequences already established for
this module family.

## Obligations

### O1 — The tie-breaker is consulted ONLY on the forked, both-unverified `winner: "none"` path, never when verification already decided

<!-- proof: symbol=raceSpecialize file=packages/arbor-opencode/src/race.ts roundtrip=packages/arbor-opencode/tests/race.test.ts -->

`raceSpecialize` never invokes `input.tie_breaker` when `winner` resolves
`"primary"` or `"fork"` via verification, and never invokes it on the
no-fork fast path (attempt 1 settles, verified or not, before the fork
threshold elapses) — verified directly by a test that supplies a
tie-breaker recording its own call count against both a verified-win race
and a fast-settle no-fork race, asserting zero calls in both.

### O2 — A tie-breaker's answer, or its absence/null/throw, produces exactly the documented `tie_break` value and result

<!-- proof: symbol=raceSpecialize file=packages/arbor-opencode/src/race.ts roundtrip=packages/arbor-opencode/tests/race.test.ts -->

On a real forked `winner: "none"` race (both attempts' `specialize()` calls
outlast the fork threshold, both then fail verification): no tie-breaker
supplied yields `tie_break: "none_default"` and attempt 1's result; a
tie-breaker returning `"fork"` yields `tie_break: "fork"` and the fork
attempt's result; a tie-breaker returning `"primary"` yields
`tie_break: "primary"` and attempt 1's result; a tie-breaker returning
`null` or throwing both yield `tie_break: "none_default"` and attempt 1's
result — asserted directly for each case.

### O3 — `tie_break` is additive and absent from every telemetry shape it did not exist for before this ADR

<!-- proof: symbol=RaceOutcomeObservation file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-opencode/tests/race.test.ts -->

`RaceOutcomeObservation.tie_break` is optional; `raceSpecialize`'s returned
`outcome.telemetry` carries no `tie_break` key at all on the no-fork
fast-path branches (fork-free-verified, fork-free-unverified) and on the
degraded-no-fork-worktree branch — only the full forked-race branch ever
sets it, and only when `winner` is `"none"` there.

### O4 — A killer test is trusted as `hardened` only after passing BOTH CoHarden legs, and every mutant write remains byte-identically restored

<!-- proof: symbol=probeMutations file=packages/arbor-mcp/src/mutation-probe.ts roundtrip=packages/arbor-mcp/tests/mutation-probe.test.ts -->

A survivor is upgraded to `{hardened: true, killer_test_source}` only when
the generated killer test exits `0` against the real, unmutated code AND
non-zero against the mutant re-applied; a test that passes both, fails
leg 1, or fails to reach a real exit on either leg leaves the finding a
plain (unhardened) survivor. The mutant site file's bytes are restored
byte-identically after hardening's own leg-2 write in every case,
including when the leg-2 command port throws — verified directly against
a fake filesystem.

### O5 — Hardening never runs, writes, or calls a model/command port unless both env gates and both hardening inputs are present, and respects its own separate budget

<!-- proof: symbol=probeMutations file=packages/arbor-mcp/src/mutation-probe.ts roundtrip=packages/arbor-mcp/tests/mutation-probe.test.ts -->

Zero calls to `harden_model_port`/`run_killer_test`'s resulting command
port occur when `ARBOR_MUTATION_HARDEN` is not exactly `"on"`, when
`harden_model_port` is absent or not `ready`, or when `run_killer_test` is
absent — verified against a base probe run that still finds survivors
(the base `ARBOR_MUTATION_PROBE=on` gate stays engaged) in each case.
Hardening dispatch stops once `MUTATION_HARDEN_BUDGET_MS` — tracked from
the moment the hardening phase itself begins, independent of however much
of the base probe's own budget was consumed — is exhausted, verified with
an injected clock against a fixture with more survivors than the budget
permits attempting.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority separate
from the implementation and authoring authority used in this tranche.
