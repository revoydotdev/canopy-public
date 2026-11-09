# ADR-038: Governed Context Folding and Campaign-local Harness Overlays

**Status:** Accepted
**Date:** 2026-08-08

Authored as Proposed: implementation does not confer acceptance authority.
This keeps the ADR lifecycle compatible with the independent-review rule in
AGENTS.md and ADR-024.

## Context

Long-running tree searches need less context, but a summarizer or self-tuning
harness can become an unaccountable second authority. RLM-style recursive
context handling and ACE's grow-and-refine lessons
([arXiv 2510.04618](https://arxiv.org/abs/2510.04618)) are useful only when their raw inputs,
approval, evaluation, expiry, and rollback remain inspectable. The existing
conversation bus already provides durable bidirectional parent/subagent
messages; a context system must reference that bus rather than recreate it.

`audit/codex-a2a-messaging-reference.md` supplies the terminology used here:
conversation/context identity, task identity, sender-idempotent messages, and
artifacts are separate axes. This ADR adopts that separation internally; it
does **not** claim A2A wire conformance or import another system's protocol.

## Decision

1. Context artifacts are immutable SHA-256-addressed values exposed only by a
   bounded, read-only workspace view. This lane adds no persistent REPL, shell,
   filesystem enumeration, or execution capability.
2. `fold.granular` and `fold.deep` are non-destructive projections. A proposal
   contains distinct context/thread/task identities, source message byte ranges,
   retained claims,
   omitted and output artifact references, measured/expected token and fidelity
   fields, supersession, and rollback state. Raw artifacts and durable bus
   messages remain authoritative.
3. A fold, playbook delta, or harness revision activates only after a distinct
   Lenticel critic approves it. A campaign-local `PlaybookDelta` is never
   silently promoted into cross-campaign policy.
4. `HarnessRevision` is allowlisted to supplemental prompts, retrieval/index
   policy, and declarative subagent descriptors. It cannot
   mutate base prompts, provenance, gates, critics, capabilities, or executable
   skills. A subagent descriptor has bounded children and explicitly forbids
   recursive delegation; it cannot carry commands, tools, code, or skills.
5. Promotion records campaign-local evaluation evidence only; it does not make
   a revision a cross-campaign default. It requires a named human distinct from
   the proposer and activating critic, plus measured improvement, replay
   evidence, independent holdout evidence, and no detected regression.
   Outcome, fidelity, main/child token use, latency, regressions, and rollbacks
   are retained with the revision.
6. Retrieval/index and descriptor enactment are optional, separately composed
   structural ports. They are capability-gated (`context.retrieve` and
   `subagent.describe`), may return only references to context artifacts this
   service already owns, and are bounded before their content enters a
   checkpoint. The descriptor port prepares context only; it cannot spawn,
   delegate, execute, or grant tools.
7. Canonical runtime catalog commands and queries are the only operator/TUI
   path. The overlay projection exposes active state, evidence references,
   expiry, approver, and rollbackability without granting execution.

**Open amendment — recursion is not presumed beneficial.** SRLM
([arXiv 2603.15653](https://arxiv.org/abs/2603.15653)) reports that
uncertainty-aware self-reflective program search can match or outperform recursive
handling under matched budgets, and that recursion can regress tasks whose context
already fits. If O6's `context.retrieve` or `subagent.describe` ports are composed,
recursion versus self-reflection must be evaluated under O5's replay, holdout,
cost, latency, and no-regression bar; the RLM name supplies no authority.

## Consequences

The initial lane prefers bounded, recoverable evidence over autonomous
adaptation breadth. At the production loop's selection checkpoint, active,
unexpired fold artifacts, typed playbook guidance, and typed supplemental-prompt
fragments become bounded prompt context. Retrieval/index policy and declarative
subagent descriptors stay visible **unapplied** unless their corresponding
capability-gated adapter is explicitly composed. A retrieval adapter returns
only owned artifact IDs; a descriptor adapter returns only bounded artifact IDs
from an already validated non-executable descriptor. Neither port is a
retriever protocol, evaluator, launcher, A2A endpoint, SSE stream, or authority
to execute work. Fold message ranges are checked through a small
structural port over the existing audit-backed conversation bus, avoiding a
parallel message store or a second parent/subagent transport.

An overlay never replaces a task id, context/thread id, durable message
history, or artifact reference. The range verifier checks the referenced,
ordered durable conversation records; a fold's prose is only a projection.
Fold, playbook, and harness evidence references canonical thread/message ids
and ranges (including the bus record's correlation/ack/deadline state where
applicable), never copied transcript text.

The runtime catalog gains context, fold, playbook, and harness operations.
TUI surfaces can consume their query projections, but visual presentation is a
separate concern and cannot manufacture a second mutation path.

## Obligations

### O1 — Governed context remains a bounded projection, not a second authority

Before this Proposed record can be accepted, an independent reviewer must
verify that the canonical contracts continue to preserve distinct task,
context/thread, durable message-range, and artifact identities; that local
activation remains critic-separated and rollbackable; and that no execution or
A2A wire-conformance claim has entered this lane.

<!-- proof: symbol=validateGovernedContextCommand file=packages/arbor-mcp/src/governed-context-contracts.ts roundtrip=packages/arbor-mcp/tests/governed-context-catalog.test.ts -->

**REVIEWED AND SATISFIED 2026-08-19.** The independent acceptance review this
obligation required was held by the operator, who is not the implementing
party — the separation ADR-024's ratification note exists to preserve. Each of
the three claims was reviewed against cited evidence rather than against a
summary of intent:

1. **Distinct identities.** `packages/arbor-mcp/src/governed-context-contracts.ts:47`,
   `:50` and `:51` require a proposal `id` AND a separate `task_id` on every
   fold, playbook and harness proposal; `:70` requires each message range to
   carry its own `context_id`, `thread_id` and start/end communication ids.
   Four identity kinds, validated independently, never collapsed into one.
2. **Critic-separated and rollbackable activation.**
   `packages/arbor-mcp/src/governed-context-service.ts:149` gates every
   activation through `requireCritic(approver)`; `:156` `rollbackFold` records
   a `rolled_back` status with actor and timestamp. The roundtrip test
   (`packages/arbor-mcp/tests/governed-context-catalog.test.ts`) returns real
   `rollbackable_ids` from the canonical router, not a fixture.
3. **No execution or A2A wire-conformance claim.** The contracts contain no
   reference to A2A or wire format, and the roundtrip manifest entry states the
   exclusion explicitly.

**One limit the review named rather than papered over:** claim 1 rests on
contract-level validation — the identities are required and checked separately
— not on a behavioural test proving they cannot collapse at runtime. The
reviewer judged the contract evidence sufficient for acceptance. A test that
drives two proposals sharing a `task_id` but differing in `context_id` and
asserts they stay distinct through the projection would close the gap
properly, and is follow-up work rather than a condition of this acceptance.

With the review held, the implementation tests are review evidence that has
been used as such. They are still not promoted into the deterministic-seam
baseline; that remains a separate decision about what deserves flake
measurement, not a consequence of acceptance.
