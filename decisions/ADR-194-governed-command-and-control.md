# ADR-194: Governed Command-and-Control Between Orchestrator and Subordinate Agents

**Status:** Accepted
**Date:** 2026-10-07
**Authoring Revision:** 852de3b8fa5fe408326b673b03a5954e547dd34d
**Content ID:** sha256:1007cbc9b84a590b13ecb6154916ba9e7a035f92ca6c9c95a462f2ede01fbe89

> **Builds on ADR-083 and the companion record "Communication Channels and the
> Ledger-Backed Inbox".** This record decides what travels on the `c2`
> channel and who may send it. It uses ADR-179's typed remedy for every
> refusal and ADR-005's capability tiers for every role.

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances).

The assessment (`docs/research/agent-comms/GAP-MATRIX.md`, R4 and R5) found
three gaps:

- **No directional authority.** Either end of a thread may send any kind, so a
  child can `steer`, `delegate` or `promote` upward.
- **No typed commands.** Content is free text.
- **No closed reply palette.** Only fragments exist: an `ack` record,
  `needs_attention`, `peer.reply.agrees`, and ADR-179's refusal.

The command chain exists only in prompt text. The orchestrator is not a live
model today: Crown is the deterministic loop (`arbor-opencode/src/loop.ts`).

On 2026-10-07 the operator decided:

- **Operator decision 2.** A live model orchestrator is in v1, not deferred.
  The host loop and the operator also issue commands.
- **Operator decision 3.** Authority belongs to the direct parent at
  orchestrator tier, or to the operator. Specialists never issue commands, and
  critics are outside the chain.
- **Operator decision 6.** A critic is never a C2 target.
- **Operator decision 7.** Each command kind has a typed envelope plus one
  bounded free-text field. Replies come from a closed palette: ack, decline
  with an ADR-179 remedy, blocked, clarify, progress, done, failed.

Two repository invariants bind every choice below:

- **Provenance is a type.** A `done` reply is `!claimed` and never
  `!verified`. Only the critic/verifier path verifies.
- **No agent both proposes and approves.**

## Decision

1. **Communication tiers refine ADR-005 without widening it**
   (`COMMS_ROLE_TIER`).
   - `crown` and `cambium` are orchestrator tier.
   - `taproot` is planner tier. It has orchestrator capability, but it plans
     and interviews and never commands running work.
   - `heartwood`, `seed`, `rhizome`, `mycelium` and `stoma` are specialist
     tier.
   - `lenticel`, `burl` and `xylem` are critic tier.
2. **Cambium is the live model orchestrator in v1**
   (`LIVE_MODEL_ORCHESTRATOR_AGENT`). Its session stays live while its children
   run. It consumes their replies through its inbox and issues commands to its
   direct children. Crown remains the deterministic host loop and is
   represented by the `host_loop` principal, not by a model session.
3. **Authority (`authorizeC2Issue`, `canIssueC2`).** Identities are resolved by
   the host from the tree. An identity that does not resolve (missing node, or
   a different occupying agent) is refused rather than trusted. A command is
   authorized only in these cases:
   - **The operator** may command any non-critic node.
   - **An orchestrator-tier agent** may command a node only as its **direct
     parent**. No grandparent, sibling, child or self.
   - **The host loop** holds the parent's command edge for every node whose
     direct parent is not orchestrator tier. Where a live orchestrator is the
     direct parent, that orchestrator holds the edge and the host loop is
     displaced. Every non-critic node therefore has exactly one non-operator
     commander.
   - **Specialists and planners** never issue. **Critics** neither issue nor
     receive, not even from the operator. The operator stops a critic through
     `harness.session.interrupt`, outside C2.

   Authority is the same for all five command kinds. Every refusal is an
   ADR-179 v2 remedy under the `capability` authority (operator /
   `grant_capability`). The remediation text states that C2 authority is never
   granted over C2.
4. **Commands (`validateC2Command`).** There are five kinds, each with a closed
   schema:
   - `task.assign`: objective ≤ 4096 bytes, 1–16 acceptance criteria of ≤ 512
     bytes each, an output contract, and an optional deadline.
   - `task.amend`: instruction ≤ 2048 bytes, and optionally the command it
     supersedes.
   - `task.halt`: graceful or immediate, a closed reason code, and a note ≤ 512
     bytes.
   - `status.request`: no further fields.
   - `clarification.answer`: MCP elicitation's accept / decline / cancel.
     Content accompanies `accept` only, as a flat object of at most 8 primitive
     fields.

   No command grants authority, approves, promotes or verifies.
5. **Replies (`validateC2Reply`).** The palette is closed: `ack`, `decline`,
   `blocked`, `clarify`, `progress`, `done`, `failed`. Any other kind or field
   is refused.
   - `decline` carries an authorized ADR-179 v2 `refused` remedy.
   - `blocked` names what it needs: input, authority, resource or dependency.
   - `clarify` asks a typed question in MCP elicitation's flat schema subset.
     `answerSatisfiesClarify` checks the answer against that schema.
   - `done` carries provenance that must be exactly `{ tag: "claimed",
     claimant }`, and the envelope binds the claimant to the sending node.
   - A2A task-state names are attached as vocabulary only.
6. **Reply authority (`authorizeC2Reply`).** Only the command's target replies,
   only to the command it names, and only while that command is open.
   `decline`, `done` and `failed` close the command.
7. **Interaction with checks-and-balances.**
   - A `done` reply makes the node at most `claimed`. The critic verdict path
     is still the only way to a verified node.
   - The orchestrator that assigned the work is never the critic of it, so
     self-approval stays impossible across the C2 boundary.
   - Critics are unreachable by C2, so a commander cannot steer a verdict.
   - On the legacy thread channel, a later stage refuses upward `delegate`,
     `steer` and `promote` with the same typed remedy (PROPOSAL.md A5).

All of items 1–6 are pure functions in `@arbor/core` with no I/O. These parts
are later stages, and their obligation is recorded below as open:

- the catalog kinds `c2.command`, `c2.reply` and `c2.history`
- the native tools `c2.issue` (orchestrator tier only) and `c2.reply`
- the host-loop consumer of replies
- the Cambium live session (PROPOSAL.md S3 and S6)

## Consequences

**Easier.**
- A parent can redirect, halt or question a running child, and the child's
  answer is a typed state rather than prose.
- Decline, blocked and clarify become observable misalignment states, which
  are the MAST FC2 modes this targets.
- The authority question is one exhaustively tested pure function rather than
  prompt text.

**Harder, deliberately.**
- A specialist cannot command a sibling. It can only post in a room it shares
  or ask through its own parent.
- An orchestrator cannot reach past its direct children. The host loop cannot
  override a live orchestrator's children; only the operator can.
- Critics cannot be redirected mid-review.

**Risk the live orchestrator adds (operator decision 2).**
- Concurrent child sessions under a live parent bring budget accounting,
  deadlock between a parent awaiting a reply and a child awaiting a
  clarification, and asynchronous dispatch in place of today's synchronous
  `subagent.execute`.
- These are stage S6's tests (concurrency, budget, self-approval, deadlock).
  This record does not claim them.

**Until stage S3 lands,** these contracts have no production caller. The
reachability waivers for them cite this record.

## Alternatives / Roads not taken

- **Host loop and operator only, with a live orchestrator after 1.0**
  (PROPOSAL.md Q2a, the recommended option). Not taken: the operator chose a
  live model orchestrator in v1. The authority function gives the host loop
  and a live orchestrator disjoint edges, so both can exist without competing.
- **Any ancestor, or any orchestrator-tier node in the campaign, may command**
  (Q3b and Q3c). Rejected. Either option gives a node several commanders whose
  orders can conflict, and authority stops being local to the edge.
- **Heartwood may command rhizome or mycelium**, mirroring the delegation
  permissions in `permissions.ts`. Rejected by operator decision 3: specialists
  never issue commands. Read-only subagent calls (`subagent.execute`) stay
  available and are not C2.
- **Let the operator send `task.halt` to a critic** (PROPOSAL.md A3).
  Rejected. Operator decision 6 makes critics never a C2 target, and the
  operator already has `harness.session.interrupt`.
- **Strictly typed fields only, or free-form text** (Q7b and Q7c). Rejected.
  Strict typing cannot express a semantic objective. Free text puts authority
  in prose, where no check can reach it.
- **A new remedy pair in ADR-179 for C2 refusals.** Not taken here. The
  existing `capability` / operator / `grant_capability` pair is the closest
  authorized one. Adding a pair would amend ADR-179 and is left for the stage
  that wires refusals into a UI.

## Obligations

### O1 — Exactly a direct orchestrator-tier parent, the host loop where it holds the edge, or the operator may command

The test is an exhaustive matrix over all 11×11 role pairs and six tree
relations. It also checks the host-loop edge for every parent/target pair,
and that every non-critic node in random trees has exactly one non-operator
commander.

<!-- proof: symbol=canIssueC2 file=packages/arbor-core/src/comms/authority.ts roundtrip=packages/arbor-core/tests/comms/authority.test.ts -->

### O2 — A critic is never a C2 target, and every refusal is an authorized ADR-179 remedy

<!-- proof: symbol=authorizeC2Issue file=packages/arbor-core/src/comms/authority.ts roundtrip=packages/arbor-core/tests/comms/authority.test.ts -->

### O3 — Communication tiers refine the ADR-005 capability tiers, and Cambium is the live orchestrator

<!-- proof: symbol=COMMS_ROLE_TIER file=packages/arbor-core/src/comms/roles.ts roundtrip=packages/arbor-core/tests/comms/authority.test.ts -->

### O4 — Each command kind has a closed schema with bounded free text

Unknown kinds, unknown fields and missing required fields are refused.
Free-text bounds are enforced in UTF-8 bytes.

<!-- proof: symbol=validateC2Command file=packages/arbor-core/src/comms/c2.ts roundtrip=packages/arbor-core/tests/comms/c2.test.ts -->

### O5 — The reply palette is closed, and a done reply is never verified

Exactly seven reply kinds validate, and no other kind does. `done` accepts
only `claimed` provenance. `decline` accepts only an authorized ADR-179 v2
refused remedy.

<!-- proof: symbol=validateC2Reply file=packages/arbor-core/src/comms/c2.ts roundtrip=packages/arbor-core/tests/comms/c2.test.ts -->

### O6 — An answer satisfies its clarify only by id, action and declared field types

<!-- proof: symbol=answerSatisfiesClarify file=packages/arbor-core/src/comms/c2.ts roundtrip=packages/arbor-core/tests/comms/c2.test.ts -->

### O7 — Only the target replies, only while the command is open

<!-- proof: symbol=authorizeC2Reply file=packages/arbor-core/src/comms/authority.ts roundtrip=packages/arbor-core/tests/comms/authority.test.ts -->

### O8 — C2 reaches a live session, and Cambium runs as a live orchestrator (stages S3 and S6)

These parts are not implemented yet and are recorded here as open:

- the catalog kinds and native tools (`c2.issue`, `c2.reply`)
- append-time authority enforcement in the ledger
- the host-loop reply consumer
- the Cambium live session

<!-- unverifiable: the command-and-control catalog kinds, the native C2 issue and reply tools, loop reply consumer and the live Cambium orchestrator session are stage S3/S6 work that does not exist yet to roundtrip against -->
