# ADR-175: Critic Approval Requires an Actual Critic; a Waived Review Is Not an Approval

**Status:** Accepted
**Date:** 2026-09-28
**Authoring Revision:** 82ce26a10946cbc6e98617ceddb1cef0607cef14
**Content ID:** sha256:1daa501b5893df90ab3311def2cf0d577ff09d155efacb6495208d8d797c5ca9

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR
governance by ADR-024's ratification note).

revoy2's non-negotiable is that no agent both proposes and approves an
action. The direct governance tier (ADR-062) waives critic dispatch for
small, single-action campaigns — a legitimate and declared design. The
defect this record addresses is not the waiver; it is that the waiver is
reported through a field whose name asserts the opposite of what happened.

Every line cited below was read directly in this working tree on
2026-09-27, not taken from an ADR or a test name.

**The waiver synthesizes an approval-shaped verdict.** On the direct tier
`packages/arbor-opencode/src/loop.ts:2265-2271` constructs:

    critic = {
      approved: true,
      rationale: "governance waived by arbiter (direct tier): specialist output accepted without critic review",
      critic_agent: "arbiter-direct",
      measurement_validated: true,
      token_usage: { kind: "unavailable", reason: "direct tier waives critic dispatch; no critic call was made" },
    };

The verdict simultaneously asserts `approved: true` and, one field later,
that no critic call was made. `loop.ts:2592` then passes
`critic_approved: critic.approved` to `manager.recordResult`.

**The only self-approval guard cannot fire.** `manager.ts:879` reads
`params.critic_approved && params.critic_agent === params.specialist_agent`.
The waiver's `critic_agent` is the literal `"arbiter-direct"`, which
cannot equal a specialist agent's name, so the guard is bypassed by
construction rather than by defeating it.

**The disclosure is durable and inert.** `loop.ts:2602` sets
`review_waived: { by: "arbiter-direct", reason: "direct tier: critic review
waived by the arbiter at task intake" }`. That field is typed
(`arbor-core/src/types.ts:385`) and threaded to the audit ledger
(`manager.ts:3807-3813`) and to snapshots
(`manager.ts:1017,1074,2227,2834,2893`). Every one of those sites writes
or projects the value. **None branches on it** — not node retirement, not
the convergence counter, not `best_score`, not KB extraction, not
backpropagated score. A consumer reading `critic_approved` therefore
cannot distinguish a critic's approval from a tier's waiver.

**The path is not a corner case.** `deriveProductionExecutionStrategy`
(`cli.ts:612`) selects the direct tier for a supervised `campaign.run`
whose root action is not decomposed and which has exactly one pending
node — the ordinary shape of a single-task run. The waiver is the
production default for the most common small campaign, not an
opt-in edge case.

## Decision

**`critic_approved` is true if and only if a critic call actually
occurred and returned approval. A waived review sets `critic_approved:
false` and carries its waiver solely through the distinct `review_waived`
field.**

Three changes, in one implementing commit:

1. `loop.ts:2265-2271` — the direct tier synthesizes
   `approved: false` with a rationale naming the waiver, and
   `loop.ts:2592` passes that value through unchanged. The waiver
   itself, its reason, and its durability are unaffected.
2. Every consumer of critic approval must handle the waived case
   explicitly rather than inferring it from `critic_approved`. The
   audit ledger's existing `waived_by`/`waived_reason`
   (`manager.ts:3812-3813`) is the record those consumers read.
3. Node retirement on a waived-but-verified result is unchanged in
   *mechanism* and made visible in *reporting*: the tier already permits
   a verified node to retire on the direct path, and this record does not
   withdraw that. What it withdraws is the representation of that
   retirement as critic-approved.

The self-approval guard at `manager.ts:879` is left as-is. It remains
correct for the case it was written for; the defect was never that it
was too weak, but that the waiver routed around it by construction.

## Consequences

**Positive.** `critic_approved` becomes trustworthy as a name. Any
future consumer that reads it — including a consumer not yet written —
gets a field that means what it says. The waiver stops being a value
that must be cross-referenced against `review_waived` to be understood
correctly, which is the failure mode that let this survive.

**Negative.** This is a behavior change on the most common campaign
shape. Any code, test, snapshot, or documentation that currently relies
on `critic_approved === true` for a direct-tier single-node campaign will
observe the change. That is the intent, but it means the blast radius
includes fixtures and projections outside the loop itself, and the
implementing commit must re-run the full `arbor-mcp` and `arbor-opencode`
suites rather than only the loop's own tests.

**Negative, load-bearing.** Nothing here makes the direct tier *safer*;
it makes it *honest*. A single-action campaign still retires without any
critic having read the specialist's output. A reader must not conclude
from this record that a direct-tier result is critic-vetted. If that
trade is unacceptable, the remedy is Alternative 3 below, not a
reinterpretation of this decision.

## Alternatives / Roads not taken

1. **Keep `critic_approved: true` and require each consumer to branch
   on `review_waived`.** Rejected: leaves a field named
   "critic approved" asserting an approval that did not occur, in the
   ledger and in every projection, and depends on every future consumer
   remembering to cross-check a side field. The defect was precisely
   that consumers could not tell the two cases apart; this keeps that
   true and adds a convention.
2. **Abolish the direct tier's critic waiver entirely.** Rejected as
   out of scope: it is declared ADR-062 design with its own rationale
   (critic dispatch is not worth its cost for a single decomposed-free
   action), and removing it is a different decision with a different
   cost profile. Recorded here as the available follow-up if a reader
   concludes the waiver itself is wrong.
3. **Defer — record the finding without changing behavior.** Rejected:
   a field that misreports the strongest governance event in the system
   will keep being read as an approval, and the cost of a later fix
   grows with every consumer added in the meantime.
4. **Derive `critic_agent` from the specialist on the waiver path so the
   existing guard fires.** Rejected: that would manufacture a *false
   accusation* of self-approval in the ledger to obtain a correct
   outcome, trading a misleading field for a misleading record.

## Obligations

### O1 — The direct tier is selected by a governed, exported, tested derivation

<!-- proof: symbol=deriveProductionExecutionStrategy file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/cli.test.ts -->

The production path that reaches the waived-critic branch is entered
through `deriveProductionExecutionStrategy`, not by accident. This
obligation exists because the record's Context asserts the waiver is the
default for ordinary single-node campaigns; that claim is checkable
against an exported symbol rather than only against prose.

### O2 — A waived review is durably distinguishable from a critic approval

<!-- unverifiable: requires the loop and manager changes this record authorizes; no test asserts the distinction until the implementing commit lands -->

`review_waived` reaches the audit ledger at `manager.ts:3807-3813`
carrying `waived_by` and `waived_reason`, so a reader of the ledger can
distinguish a tier waiver from a critic's approval without inspecting
live code. This is stated as unverifiable rather than proven because it
is a claim about a post-change state, and this record is authored before
that change exists.

### O3 — A critic approval implies a critic call

<!-- unverifiable: requires the loop change this record authorizes; no test asserts the implication until the implementing commit lands -->

After this record's change, `critic_approved === true` on any recorded
result implies that a critic call occurred and returned approval, because
the direct tier no longer synthesizes `approved: true`. This is the
record's central claim, and it cannot be discharged until the
implementing change exists.
