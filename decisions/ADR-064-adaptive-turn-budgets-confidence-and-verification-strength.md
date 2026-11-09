# ADR-064: Adaptive Turn Budgets, Critic Confidence, and Verification Strength

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** b694ac8c6e8ebe2a58d8091df556906b24767709
**Content ID:** sha256:32ce6a29b72abc5924c5272f2cc63b7dd00c1db03185f4a1d5e893d17297248e

## Context

Cycle-1's research manifest (qa-bench/manifests/CYCLE1-MANIFEST.md — external
research-tooling output, never checked into this repository, synthesized
from three arXiv briefs) identified three gaps in the ADR-062 critic-block-retry
seam that this tranche closes together, because all three extend the same
seam and change the same two durable contracts (`ArbiterDecision`,
`CriticVerdict`, and verified `Provenance`):

- **E-2 — flat turn ceiling** (arXiv 2607.13034, "E3: Estimate, Execute,
  Expand"): every specialist dispatch used the same flat max-turns ceiling
  regardless of the arbiter's own governance-tier classification, even
  though ADR-062 already distinguishes `direct`/`reviewed`/`governed` by
  blast radius. Measured field variance (arXiv 2604.22750: up to 30× token
  variance on identical tasks, self-prediction r≤0.39) is consistent with a
  max-context-first over-read pattern a tighter, tier-scoped starting
  budget can bound without costing success — the flat ceiling only ever
  needs to widen when a dispatch's own machine verification has genuinely
  failed.
- **E-3 — binary critic verdict, no calibration signal** (arXiv
  2607.05391): the critic contract carried only `approved: boolean` with no
  confidence signal, so a borderline BLOCK on the `reviewed` tier (a single
  action, no multi-node backtracking to fall back on) was indistinguishable
  from a high-confidence rejection — both terminated the campaign the same
  way, even though ADR-062's bounded critic-block retry already exists for
  exactly this kind of borderline case.
- **E-4 — verification is a boolean, not a strength** (arXiv
  2605.17029/2501.01054, correlated-cascade analysis in 2607.13918): the
  `verified` provenance tag and the loop's verification-informed critic
  note both treated "a command ran and exited 0" as one undifferentiated
  fact, whether that command was the plan's real acceptance command or only
  a declared-output-files existence check (`cli.ts`'s
  `createDeclaredOutputsVerifier`). Presenting the latter to the critic as
  "verification passed" overstates the gate's independence from the
  critic's own read of the same artifact — exactly the correlated-gate
  overcount 2607.13918 warns compounds silently.

## Decision

Extend three existing, additive contracts and one existing retry seam;
introduce no new gates or agents.

**E-2 (turn budget estimate).** `ArbiterDecision` gains an additive
`turn_budget_estimate?: number`, set by `arbiter-intake.ts`'s
`turnBudgetEstimateForTier`: `direct` → 12, `reviewed` → 16, `governed` →
32 (the existing flat default, unchanged for that tier). `claude-code-campaign.ts`'s
`resolveSpecialistMaxTurns` consumes it, but `ARBOR_CLAUDE_CODE_MAX_TURNS`
still wins over it exactly as it won over the flat default before this
tranche. The loop (`loop.ts`) tracks a per-node expanded budget
(`turnBudgetByNode`), doubled and capped at 32
(`TURN_BUDGET_EXPANSION_CEILING`) on a critic-block retry, but **only**
when that retry was caused by a real machine-verification failure (a
declared command ran and exited non-zero — distinguished from "nothing was
attempted" via the new `SpecialistWorktreeVerificationPort.verifyOutcome`,
additive alongside the existing null-collapsing `verify`). A retry
triggered instead by E-3's low-confidence-BLOCK path never expands the
budget.

**E-3 (critic confidence).** `CriticVerdict` gains additive
`confidence?: number` (`[0, 1]`) and `confidence_source?: "logprobs" |
"self_report"`. The native critic transport (`@arbor/harness`) exposes no
provider logprobs today, so only `self_report` is implemented in this
tranche — the model is asked to emit a numeric self-score in the same
structured verdict JSON (`nativeCriticVerdictInstruction`), extracted
independently of the strict verdict parser
(`extractCriticConfidence`) so a malformed confidence never fails the
whole verdict. The loop applies confidence only on the `reviewed` tier
(`direct_single_action` with `review !== "waived"`): a BLOCK with
`confidence < 0.5` routes to the existing bounded critic-block retry, even
when `critic_retry` was never configured (bounded to at least one retry).
`governed` tier is untouched — a BLOCK there stays terminal exactly as
before. Confidence never converts BLOCK to APPROVE, on any tier; absent or
malformed confidence reproduces exactly pre-E-3 behavior.

**E-4 (verification strength).** Verified `Provenance` gains additive
`strength?: "command_executed" | "outputs_check"`, populated by
`WorktreeMachineVerifier` from the declared `WorktreeVerificationCommand.strength`
(defaulting to `"command_executed"`, the pre-E-4 assumption, when a
composition declares none). The loop's verification-informed critic note
(ADR-062/4a5a8bb) now reads this field: an `"outputs_check"` verification is
worded as "declared outputs are present ... but the plan's acceptance
command was NOT run" and explicitly tells the critic to verify correctness
itself, never as "verification passed."

**Known follow-up — CLOSED (verified 2026-08-18).** This record was authored
while `cli.ts` sat outside the tranche's authorized file scope, and stated that
the one production `command_for_node` composition
(`createDeclaredOutputsVerifier`) did not set `strength: "outputs_check"`, so
it silently defaulted to `"command_executed"` and understated the correlation
risk this record exists to make explicit. That follow-up has since landed:
`packages/arbor-mcp/src/cli.ts:821` returns `strength: "outputs_check"` on the
declared-outputs-check command. The paragraph above described an open gap after
it was closed; it is corrected here rather than deleted, because the record of
what was open and when is the point.

## Consequences

A `direct`/`reviewed`-tier dispatch now starts at a materially tighter
turn ceiling (12/16 vs. the flat 32), with headroom to expand only when a
real verification failure earns it — never as a blanket increase. A
borderline `reviewed`-tier BLOCK gets one bounded second look instead of
terminating a single-action campaign outright, at the cost of up to one
extra specialist+critic dispatch, gated by the same cap ADR-062 already
uses. The critic's own certainty is now durable, queryable evidence
(`confidence`/`confidence_source` round-trip through `persist.ts`) instead
of being discarded after the approve/block decision is made — but it is
deliberately never given the authority to overturn a BLOCK. Verification
strength is now explicit, additive evidence rather than an assumed
constant, closing part of the correlated-gate overcount 2607.13918
describes; the `cli.ts` follow-up above is the remaining gap between this
record's intent and today's one production verifier composition.

## Obligations

### O1 — Turn-budget expansion never happens without a genuine machine-verification failure

<!-- proof: symbol=runCampaign file=packages/arbor-opencode/src/loop.ts roundtrip=packages/arbor-opencode/tests/loop.test.ts -->

`turnBudgetByNode` is only ever written inside the `machineVerificationFailed`
branch of the critic-block-retry path; a plain critic rejection or an E-3
low-confidence-BLOCK retry with no verification failure never expands the
node's budget, and the expansion is capped at `TURN_BUDGET_EXPANSION_CEILING`.

### O2 — Confidence can route a retry but can never convert BLOCK to APPROVE

<!-- proof: symbol=runCampaign file=packages/arbor-opencode/src/loop.ts roundtrip=packages/arbor-opencode/tests/loop.test.ts -->

`lowConfidenceReviewedBlock`/`confidenceRetryEligible` only ever feed the
existing revive-to-`"pending"` branch already gated on `critic.approved ===
false`; no code path reads `confidence` to change `critic.approved` itself,
on any tier.

### O3 — A weak (`outputs_check`) verification is never worded as "verification passed" to the critic

<!-- proof: symbol=runCampaign file=packages/arbor-opencode/src/loop.ts roundtrip=packages/arbor-opencode/tests/loop.test.ts -->

The verification-informed critic note branches on `provenance.strength`;
the `"outputs_check"` branch's text does not contain the phrase
"verification passed" and states the acceptance command was not run.

### O4 — All three additive fields round-trip through persistence, and a malformed value fails closed rather than being silently trusted

<!-- proof: symbol=loadCampaignResult file=packages/arbor-core/src/persist.ts roundtrip=packages/arbor-core/tests/persist.test.ts -->

`turn_budget_estimate`, `confidence`/`confidence_source`, and
`strength` all round-trip when present and absent, and an out-of-range or
type-mismatched value on disk is quarantined by `loadCampaignResult`
rather than trusted.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority
separate from the implementation and authoring authority used in this
tranche.
