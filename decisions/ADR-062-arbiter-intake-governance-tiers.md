# ADR-062: Arbiter Intake And Governance Tiers

**Status:** Accepted
**Date:** 2026-08-14
**Authoring Revision:** 80433c27438518bfa3d5f24aac17cd572c7cf977
**Content ID:** sha256:1400bee1099577ffc7aad2d1b2e0f0a0383cb18a0b9746e3ab255b4803834e01

## Context

An A/B bench against vanilla `claude -p` on a fastify repo (2026-08-15,
sonnet both sides) measured revoy2's full governed pipeline (planner →
admission → worktree isolation → specialist → critic → evidence) at 6–17×
wall time and 3.5–9× dollar cost on tasks a single dispatch handles at
parity. The same bench also showed the governance layer's real value: on a
planted-bug task, the critic correctly blocked a wrong specialist fix that
an ungoverned dispatch would have shipped.

Every `arbor task` submission unconditionally ran the full multi-action
planner and, once admitted, the full tree-search-plus-critic loop —
regardless of whether the task was a one-line typo fix or a security-
sensitive migration. There was no cheap, evidenced mechanism to route a
task to a narrower governance posture, and no durable record of why
governance was (or was not) applied to a given campaign.

Separately, a measured flow gap: when a critic rejects an implementation
node, the campaign backtracks once and halts `no_nodes` — even though the
rejection rationale is already captured (`retry-context-capsule.ts`), no
bounded retry ever consumes it.

## Decision

Introduce a closed `GovernanceTier` vocabulary — `direct` | `reviewed` |
`governed` — and an ARBITER intake classifier that runs at `arbor task`
submission time, before any expensive planning:

- **`direct`**: one specialist dispatch in an isolated worktree, machine
  verification if a command is declared, no planner decomposition, no
  critic. The loop's `direct_single_action` execution strategy gains an
  additive `review?: "critic" | "waived"` field; `"waived"` skips critic
  dispatch entirely and `CampaignManager.recordResult` records an explicit
  `review_waived: { by, reason }` marker — never a fabricated
  `critic_approved` verdict. Provenance stays honest (`claimed` unless
  machine-verified).
- **`reviewed`**: specialist + critic on a single root action, no
  multi-action decomposition. Reuses the same `direct_single_action`
  strategy with the (default) `review: "critic"` mode — no loop changes
  needed beyond the additive field.
- **`governed`**: the unchanged full path. Default whenever the arbiter is
  unsure, absent, or its output fails schema validation.

The arbiter itself (`packages/arbor-mcp/src/arbiter-intake.ts`) is a small,
swappable `ArbiterIntakePort` — either a single structured-output call
(mirroring `native-task-plan-contract.ts`'s pattern) or, as shipped by
default, a zero-cost deterministic heuristic
(`createHeuristicArbiterIntakePort`) over task-text signals (risk
keywords, narrow-verb short tasks). `classifyGovernanceTier` never throws:
an absent port, a transport failure, or malformed output all fall back to
`governed`.

The decision — `{ tier, rationale, blast_radius, source, decided_at }` — is
persisted durably as an additive field on both the task-composer draft
(`TaskComposerDraft.arbiter_decision`) and the admitted campaign
(`CampaignState.governance`), and surfaced by `arbor report` and the
`arbor task` human summaries. An explicit `--tier direct|reviewed|governed`
flag skips the arbiter call and records `source: "operator_forced"`.

Separately, a bounded critic-block retry closes the measured flow gap:
`CampaignLoopConfig.critic_retry?: { max_retries }` (default disabled;
production sets `max_retries: 1`). On a critic-rejected node still under
its cap (`TreeNode.critic_retry_count`, additive), the loop revives the
node to `"pending"` (`reviveFailedNode`/`CampaignManager.reviveNodeForRetry`)
instead of leaving it terminal — the next dispatch picks up the rejection
rationale via the existing retry-context capsule, keyed by the same node
id. Capped per node; never an unbounded loop.

## Consequences

A simple, low-blast-radius task now costs roughly one specialist call (plus
a free or near-free arbiter classification) instead of a planner round trip
plus a full critic-gated tree search — directly addressing the measured
6–17×/3.5–9× overhead for tasks that do not need it. Checks-and-balances
(ADR-001, "no agent both proposes and approves") is unchanged for
`reviewed`/`governed`; for `direct` it is explicitly waived and recorded,
never silently bypassed — an auditor can always distinguish "critic
approved" from "critic waived by arbiter" via `review_waived`. A
critic-block retry means a transient/borderline rejection gets one more
chance before the campaign gives up, at the cost of up to one extra
specialist+critic dispatch per rejected node.

The shipped default arbiter is a cheap heuristic only. **The
LLM-escalation-when-ambiguous half is now wired (2026-08-18)** via
`ARBOR_ARBITER_TRANSPORT=escalate`: the heuristic runs first and the native
port is consulted only when the heuristic's own decision lands in its sole
ambiguous branch, falling back to the heuristic when native is unready or
fails. It is opt-in and the default is unchanged, so the first sentence still
holds. `ArbiterIntakePort` was indeed the seam this predicted, and the
composition happened at `cli.ts`'s existing `task_composer_arbiter` call site
without touching any caller of `classifyGovernanceTier`. This paragraph read
"is not wired in this tranche" until the tranche after it closed the gap.

## Obligations

### O1 — A `direct`-tier result is never mistaken for a real critic verdict

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-opencode/tests/loop.test.ts -->

`recordResult`'s `review_waived` marker is additive and distinct from
`critic_verdict`; a waived-review node's `TreeNode.review_waived` is set and
its `critic_verdict` stays absent. The loop never dispatches
`executor.review` when `execution_strategy.review === "waived"`.

### O2 — The arbiter's decision is durable, replayable evidence

<!-- proof: symbol=classifyGovernanceTier file=packages/arbor-mcp/src/arbiter-intake.ts roundtrip=packages/arbor-mcp/tests/task-composer.test.ts -->
<!-- proof: symbol=appendIntentLifecycleRecord file=packages/arbor-core/src/intent-lifecycle.ts roundtrip=packages/arbor-mcp/tests/intent-admission-wiring.test.ts -->

The tier, rationale, blast radius, and source (`arbiter` vs
`operator_forced`) are persisted on the draft at submit time and copied onto
the admitted campaign, independent of the eventual campaign outcome.

### O3 — A malformed or absent arbiter classification never blocks or silently downgrades governance

<!-- proof: symbol=classifyGovernanceTier file=packages/arbor-mcp/src/arbiter-intake.ts roundtrip=packages/arbor-mcp/tests/arbiter-intake.test.ts -->
<!-- proof: symbol=validateIntentAdmission file=packages/arbor-core/src/intent-admission.ts roundtrip=packages/arbor-mcp/tests/intent-admission-wiring.test.ts -->

Every failure mode (no port, transport error, schema-invalid output) falls
back to the `governed` tier, never to `direct`/`reviewed` and never to a
thrown error that aborts submission.

### O4 — Critic-block retry is bounded and does not loop

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-opencode/tests/loop.test.ts -->

A node's `critic_retry_count` is incremented on every revive and the loop
only revives while it remains below `critic_retry.max_retries`; omitted
config preserves the exact pre-ADR-062 terminal-failure behavior.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority
separate from the implementation and authoring authority used in this
tranche.
