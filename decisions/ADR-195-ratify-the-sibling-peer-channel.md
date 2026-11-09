# ADR-195: Ratify the Sibling Peer Channel

**Status:** Accepted
**Date:** 2026-10-07
**Authoring Revision:** 852de3b8fa5fe408326b673b03a5954e547dd34d
**Content ID:** sha256:4cb0234da1e8f2ccfce94f8269abf997d81bef7a0ead192f03d727b5aed48a67

> **Makes the scope-widening decision ADR-083 required.** ADR-083 said a
> child "cannot reach a sibling's thread" and that broadening that scope "is a
> decision someone has to make explicitly". The sibling peer channel broadened
> it without a record. This record makes that decision.

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances).

`NativePeerChannelService` (`packages/arbor-mcp/src/native-peer-channel.ts`)
is real and on the production path:

- `provisionFromParentAuthority` grants each dispatched specialist query and
  reply with up to 16 siblings.
- Each grant is at specialist tier, with a 4096-byte disclosure ceiling and a
  24-hour expiry.
- The native tools `peer.query`, `peer.reply` and `peer.history` are advertised
  to the specialist-executor role.
- Messages land on the ADR-083 ledger as `native-peer:<grant>` conversations.
- Disagreement escalates `needs_attention` to the parent, and wait cycles are
  refused.

No ADR authorizes any of this. ADR-088 only lists the tools for system
approval.

INVENTORY.md §4 also records two defects:

- Peer content is written to the ledger unredacted.
- Grants are never pruned. Once more than 256 are persisted, the next boot
  fails (inferred, not run).

On 2026-10-07 the operator decided (operator decision 5) to ratify the sibling
peer channel by ADR now, with redaction on write, and to fold it into commons
rooms later as two-member rooms.

## Decision

1. **The sibling peer channel is ratified as it is shaped today.** The parent
   grants it, through host-owned provisioning from the parent's authority; a
   child can never mint a grant. It is pairwise between direct siblings of the
   same parent. Grants are capped at specialist tier and are bounded in
   disclosure bytes and lifetime. It is pull-only: the recipient reads it
   through `peer.history`. It travels on the ADR-083 ledger, which keeps one
   mechanism. It grants no spawn, delegate or grant tool.
2. **Redaction on write.** Peer content passes the host's redaction
   (`redactNativeText`) before it is appended, as operator steering already
   does. In the channel envelope, a peer message is a free-text payload, so its
   redaction marker is required (`payloadCarriesFreeText`). The append-path
   change is stage S0 item 4. Until it lands, this record is ratified with that
   obligation open, and the obligation is the reason to land it.
3. **Expired grants are pruned before they are persisted** (stage S0 item 5),
   so the 256-grant restore ceiling cannot fail a boot.
4. **Future fold into rooms.** When commons rooms land (stage S4), a peer grant
   becomes a two-member specialist-tier room, governed by the room predicates
   in the companion record "Communication Channels and the Ledger-Backed
   Inbox". Both siblings are specialist tier and so are eligible members
   (`canBeRoomMember`). The `peer.*` tools then become a projection over
   `room.*`. The fold must not widen the grant: it stays two members, sibling
   only, and parent-provisioned.
5. **Peers never command each other.** A peer message is never C2. Specialists
   never issue commands (companion record "Governed Command-and-Control Between
   Orchestrator and Subordinate Agents").

## Consequences

**Easier.**
- The channel now has a governing record. ADR-083's statement that a child
  "cannot reach a sibling's thread" is corrected in writing rather than
  contradicted by code.
- Siblings keep a working lateral channel while rooms are built.

**Harder, deliberately.**
- Peer content is redacted before it is durable.
- The fold into rooms is constrained in advance: it cannot quietly become an
  any-to-any channel.

**Open.**
- Redaction on write and grant pruning are not implemented yet (S0 items 4 and
  5).
- The `peer.*` catalog kinds remain unwired: `options.peer_caller` is set by no
  production root. This record does not compose them.

## Alternatives / Roads not taken

- **Disable auto-grants until rooms land** (PROPOSAL.md Q4b). Rejected by the
  operator. It removes a working, tested, durable lateral channel to wait for a
  later stage.
- **Leave it as it is** (Q4c). Rejected. It leaves ungoverned drift from
  ADR-083 and unredacted durable content.
- **Fold into rooms now, without a separate record.** Not taken. Rooms depend
  on the stage S2 inbox, and the ratification gap exists today.

## Obligations

### O1 — The peer channel is parent-granted, sibling-only and bounded, and replays after restart

The adversarial test covers durable query and reply, escalation of
disagreement and of wait cycles, tier visibility, and replay after restart. It
also checks that the channel fails closed on foreign endpoints, disclosure
overflow, missing capability and arbitrary delegation fields.

<!-- proof: symbol=NativePeerChannelService file=packages/arbor-mcp/src/native-peer-channel.ts roundtrip=packages/arbor-mcp/tests/native-peer-channel-adversarial.test.ts -->

### O2 — The peer tools expose no authority escalation

The advertised peer tools are exactly `peer.query`, `peer.reply` and
`peer.history`, with no grant, spawn or delegate tool. Production provisioning
fixes the sibling edge from the parent's authority.

<!-- proof: symbol=createNativePeerToolPorts file=packages/arbor-mcp/src/native-peer-tools.ts roundtrip=packages/arbor-mcp/tests/native-peer-tools.test.ts -->

### O3 — A peer grant is expressible as a two-member specialist-tier room

Sibling specialists are eligible members of a specialist-tier room. Critics
are not, and no specialist can read a critic-tier room.

<!-- proof: symbol=canBeRoomMember file=packages/arbor-core/src/comms/rooms.ts roundtrip=packages/arbor-core/tests/comms/rooms-delivery.test.ts -->

### O4 — Peer content is redacted before append, and expired grants are pruned (stage S0)

<!-- unverifiable: redactNativeText on the peer append path and expired-grant pruning in native-peer-channel.ts are stage S0 items 4 and 5, not implemented yet to roundtrip against -->
