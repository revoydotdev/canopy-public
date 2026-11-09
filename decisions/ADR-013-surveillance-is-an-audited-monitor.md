# ADR-013: Surveillance Is an Audited Monitor, Not a Fifth Gate

**Status:** Accepted
**Date:** 2026-08-01

## Context

Long-running campaigns need early warning for repeated rejection, branch
oscillation, stale evidence, orphaned work, and inconsistent convergence
claims. Those signals span tree, runtime, and evidence projections. Treating
the detector as another lifecycle gate would silently expand the four-gate
governance model in ADR-006 and could let an observational heuristic become an
unreviewed authority over campaign state.

## Decision

Surveillance is a non-blocking, pure detector over an explicitly bounded,
immutable projection. It emits provenance-typed findings with deterministic
deduplication keys and evidence references. The runtime may append those
findings to its audit ledger, publish them as events, or present them to an
operator. Detection itself performs no I/O, holds no tree reference, changes no
node or campaign state, and does not add to `GateType`.

A finding is evidence, not a verdict. It cannot pass, fail, or bypass a gate;
approve or reject Specialist work; mark a node terminal; halt a campaign; or
authorize recovery. Crown or an operator may respond through existing typed
runtime commands and existing gates. Any automated response must be specified
and audited separately from the detector.

Inputs and per-kind history are bounded by configuration. The runtime supplies
the observation time, so replay does not depend on wall-clock reads. Stable
condition identity—not message count or arrival order—forms the deduplication
key. Findings use `!generated` provenance with a deterministic input hash.

## Consequences

**Positive:** Monitoring can improve operational awareness without acquiring
governance authority or destabilizing deterministic replay.

**Negative:** Findings do not stop unsafe work by themselves. A governed actor
must interpret them and issue an existing command when intervention is needed.

**Neutral:** Audit persistence and event delivery belong to integration layers;
the core detector remains dependency-free apart from core platform utilities.

## Test implications

- Each finding family is tested independently, including negative cases.
- Reordered equivalent inputs produce stable condition keys.
- Oversized projections are rejected before detection.
- Frozen inputs remain unchanged and `GateType` remains the four values in
  ADR-006.

## Alternatives considered

1. **Add a surveillance process gate.** Rejected because observations are not a
   new trust boundary and should not become implicit transition authority.
2. **Let the detector halt or prune directly.** Rejected because this bypasses
   runtime commands, checks-and-balances, and existing gate evidence.
3. **Maintain an unbounded monitor mailbox.** Rejected because pending counts
   are not durable authority and unbounded history is unsafe for long campaigns.

## Obligations

### O1 — Detection is a pure function over a bounded, immutable projection

It performs no I/O and mutates no campaign or tree state.

<!-- proof: symbol=detectSurveillanceFindings file=packages/arbor-core/src/surveillance.ts roundtrip=packages/arbor-core/tests/surveillance.test.ts -->

### O2 — Oversized input is rejected before detection runs, not silently truncated

<!-- proof: symbol=SurveillanceConfig file=packages/arbor-core/src/surveillance.ts roundtrip=packages/arbor-core/tests/surveillance.test.ts -->

### O3 — Each finding carries a stable, replay-deterministic deduplication key

The key is derived from condition identity, not arrival order or message
count.

<!-- proof: symbol=SurveillanceFinding file=packages/arbor-core/src/surveillance.ts roundtrip=packages/arbor-core/tests/surveillance.test.ts -->

### O4 — Surveillance never adds a fifth value to the gate catalog

`GateType` remains the four values ADR-006 accepted.

<!-- proof: symbol=GateType file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-gate/tests/gate-order.invariant.test.ts -->
