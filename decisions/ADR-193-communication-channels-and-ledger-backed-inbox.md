# ADR-193: Communication Channels and the Ledger-Backed Inbox

**Status:** Accepted
**Date:** 2026-10-07
**Authoring Revision:** 852de3b8fa5fe408326b673b03a5954e547dd34d
**Content ID:** sha256:72e3ad8052d0656415a2f28c5c74a52f2c834cdc2febe9a5db12e8f7e534c23a

> **Amends ADR-083.** ADR-083 made agent communication one mechanism, the
> append-only NodeCommunication ledger, scoped to each parent/child edge. This
> record keeps that single mechanism. It adds a `channel` dimension, a closed
> envelope, and a delivery lane into running sessions. It also corrects
> ADR-083's statement that a child "cannot reach a sibling's thread": the
> companion record "Ratify the Sibling Peer Channel" covers that change.

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances).

The assessment in `docs/research/agent-comms/` (INVENTORY.md, GAP-MATRIX.md,
PROPOSAL.md, as of 934c4bc7) found the following:

- **The write side is real.** Children can send and ack on their parent edge.
  Siblings can query and reply over auto-provisioned peer grants.
- **The read side is missing.** Nothing delivers a ledger message into a
  running model:
  - `trigger_turn` has no reader.
  - A child cannot read its own thread.
  - `bus.thread.clarify` is never advertised.
  - Operator steering is the only mid-task down-channel. It holds its 32
    messages in memory and loses them on restart.
- **Groups do not exist.** There are no rooms, mentions or membership, and
  nothing redacts thread or peer content on write.

On 2026-10-07 the operator answered the proposal's seven questions. Four of
the answers bind this record:

1. **Substrate (operator decision 1).** Extend the existing communication
   ledger with a channel field (thread / commons / c2) and schema-validated
   payloads. A2A task states and MCP elicitation shapes are vocabulary only.
2. **Delivery (operator decision 4).** C2 commands and @mentions are injected
   at the next turn boundary. They are labelled by source and never framed as
   the operator. Commons is pull-only.
3. **Peer channel (operator decision 5).** Ratify it by ADR now, with
   redaction on write, and fold it into commons rooms later.
4. **Critics (operator decision 6).** Critics read specialist-tier rooms, post
   only in critic-tier rooms, and are never a C2 target.

The C2 command and reply contracts are decided in the companion record
"Governed Command-and-Control Between Orchestrator and Subordinate Agents".

## Decision

1. **Three channels, one ledger.** Every message is a `CommsEnvelope`
   (`packages/arbor-core/src/comms/envelope.ts`) on exactly one channel:
   - `thread`: the ADR-083 parent/child edge.
   - `commons`: permissive multi-party rooms.
   - `c2`: typed commands and closed replies.

   The envelope is a projection of a NodeCommunication record, plus `channel`
   and a schema-validated payload. There is no second store, no A2A wire and no
   mailbox. When the ledger record gains the field, a record without `channel`
   reads as `thread`, so legacy records replay unchanged.
2. **The envelope is closed.** Unknown fields are refused at every level, and
   so are an unknown channel and a payload that does not belong to its channel.
   - It carries the sender (operator, host loop, or an agent with its node), the
     direct recipients, the @mentions (commons only), the provenance, a
     redaction-required marker, and the payload.
   - Free text is bounded in UTF-8 bytes: 8 KiB for thread and commons text,
     and the per-field C2 bounds.
3. **A message is at most a claim.** `verified` and `critic_approved`
   provenance never travel on a channel. Only the critic/verifier path
   establishes them.
   - An agent's message is `claimed` by the node that sent it.
   - The host loop's message is `generated`.
   - The operator's message is `claimed`.
4. **Redaction happens on write, and the marker cannot understate it.**
   `redaction_required` must equal `payloadCarriesFreeText(payload)`. The host
   runs `redactNativeText` over every envelope that carries free text before
   the append. A sender cannot opt a free-text payload out.
5. **Delivery policy (`deliveryModeFor`).**
   - C2 commands and C2 replies are injected into the addressee's live session
     at its next turn boundary.
   - A commons @mention is injected into the mentioned member.
   - Every other commons post is pull-only for the room's members.
   - Thread messages are pull-only.
   - A sender never receives its own message, and a non-member never receives a
     room post.
6. **Labelling (`injectionLabel`).** An injected message is framed with its
   channel, kind, source and provenance. Only an operator-sent envelope is
   labelled as the operator. An agent's message names its agent and node. The
   injection path must not reuse the operator steering frame
   (`operatorSteeringText`, the `human_input` source).
7. **Rooms (`rooms.ts`).** A room has a tier, `specialist` or `critic`.
   - Rooms are opened, and their membership set, by the operator, the host
     loop, or an orchestrator-tier agent.
   - Critics are the only members of critic-tier rooms and are never members of
     specialist-tier rooms.
   - Critics read every specialist-tier room as observers.
   - Specialists and planners can never read a critic-tier room.
   - Orchestrators read every room, and post only where they are members.
   - Every @mention must name a member.
8. **The ledger-backed inbox (stage S2).** Operator steering's in-memory inbox
   is generalized into a per-session inbox backed by the ledger. It is drained
   at the same turn boundary (`native-worker.ts`). Its cursor is durable, so a
   restart replays undelivered messages without duplicating them. The inbox is
   budgeted on the ADR-181 byte-budget pattern.

All contracts in items 1–7 are pure functions in `@arbor/core` with no I/O.
The ledger extension, the inbox and the room store are later stages
(PROPOSAL.md §5, S2–S5). Their obligations are recorded below as open, not
claimed.

## Consequences

**Easier.**
- A running session can be told something mid-task through the ledger, which
  today only operator steering can do.
- The same envelope carries a parent's question, a room post and a typed
  command.
- Operators read all three channels through the existing projections.

**Harder, deliberately.**
- Every message is schema-checked at append. A model cannot add a field to
  smuggle authority or provenance.
- Chatty rooms cannot flood a context window, because commons is pull-only
  unless someone is @mentioned.
- Critic isolation now extends to rooms.

**Open.**
- Each append costs O(ledger) (`manager.ts:3243-3248`), and rooms multiply
  appends. Measure this before claiming it scales.
- This record claims typed observability of misalignment states (decline,
  blocked, clarify). It does not claim improved reliability: MAST FC2 is not
  solved by plumbing.

**Until stage S2 lands,** these contracts have no production caller. The
reachability waivers for them cite this record.

## Alternatives / Roads not taken

- **Adopt A2A as the internal transport** (operator option 1b). Rejected. It
  would be a second mechanism against ADR-083, and it would reopen the
  remote-transport surface of the Rejected ADR-040/041. Its bilateral
  client/server roles cannot express the botanical hierarchy. Its task-state
  names are kept as vocabulary (`C2_REPLY_A2A_STATE`).
- **A new dedicated bus or mailbox** (option 1c). Rejected. It would be a
  second store that needs its own durability, replay and provenance, which the
  ledger already provides.
- **Inject everything** (option 5b). Rejected. It makes context cost
  unbounded, and it buries obligatory C2 traffic among chatter.
- **Pull everything through tools** (option 5c). Rejected. A command the model
  never reads is not a command.
- **Exclude critics from rooms, or let them participate fully** (options 6b and
  6c). Rejected. Exclusion hides the specialists' working discussion from the
  role that judges it. Full participation lets a critic steer the work it will
  judge.

## Obligations

### O1 — Every message is a closed envelope on exactly one of three channels

`validateCommsEnvelope` refuses unknown fields at the envelope, sender and
payload levels. It also refuses an unknown channel, a payload foreign to its
channel, and addressing that breaks the channel's shape.

<!-- proof: symbol=validateCommsEnvelope file=packages/arbor-core/src/comms/envelope.ts roundtrip=packages/arbor-core/tests/comms/envelope.test.ts -->

### O2 — No channel carries verification; an agent's message is claimed by its own node

Every channel and payload refuses `verified` and `critic_approved`
provenance. An agent's `claimed` provenance must name the sending node.

<!-- proof: symbol=validateCommsEnvelope file=packages/arbor-core/src/comms/envelope.ts roundtrip=packages/arbor-core/tests/comms/envelope.test.ts -->

### O3 — The redaction marker cannot understate a free-text payload

`payloadCarriesFreeText` decides the marker, and an envelope whose marker
disagrees with it is refused.

<!-- proof: symbol=payloadCarriesFreeText file=packages/arbor-core/src/comms/envelope.ts roundtrip=packages/arbor-core/tests/comms/envelope.test.ts -->

### O4 — C2 and @mentions inject; everything else is pull-only

`deliveryModeFor` injects C2 traffic to its addressee and a commons post to
the members it mentions. It returns pull for the rest of the room and for
thread messages, and none for the sender and for non-members.

<!-- proof: symbol=deliveryModeFor file=packages/arbor-core/src/comms/delivery.ts roundtrip=packages/arbor-core/tests/comms/rooms-delivery.test.ts -->

### O5 — An injected message is never framed as the operator unless the operator sent it

<!-- proof: symbol=injectionLabel file=packages/arbor-core/src/comms/delivery.ts roundtrip=packages/arbor-core/tests/comms/rooms-delivery.test.ts -->

### O6 — Critics read specialist rooms and post only in critic rooms; specialists never read critic rooms

<!-- proof: symbol=canReadRoom file=packages/arbor-core/src/comms/rooms.ts roundtrip=packages/arbor-core/tests/comms/rooms-delivery.test.ts -->

### O7 — The ledger record carries the channel, and the inbox survives a restart (stage S2)

The NodeCommunication `channel` field, append-time payload validation, the
durable inbox cursor and the turn-boundary drain are not implemented yet.
They are recorded here as open, not claimed.

<!-- unverifiable: the NodeCommunication channel field (arbor-audit/src/audit.ts) and the ledger-backed session inbox (arbor-mcp communication-inbox, arbor-harness native-worker drain) are stage S2 work that does not exist yet to roundtrip against -->
