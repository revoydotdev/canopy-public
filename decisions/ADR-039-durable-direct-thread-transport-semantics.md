# ADR-039: Durable Direct-thread Transport Semantics

**Status:** Rejected
**Date:** 2026-08-08

Authored as Proposed: implementation does not confer acceptance authority.

## Context

The parent-child conversation ledger already preserves sender identity,
tree-scoped thread identity, CAS, idempotency, capability filtering, and
restart replay. A direct thread still needs an explicit, inspectable way to
distinguish a request from a response or alert, bind a reply to its original
context, and establish whether an acknowledgement is outstanding. A
clean-room review of revoy-spec transport ideas is useful here, but importing
its protocol or claiming its wire compatibility would obscure revoy2's own
ledger and tree-identity authorities.

The MAST failure taxonomy (Cemri et al., NeurIPS 2025 Datasets &
Benchmarks, [arXiv:2503.13657](https://arxiv.org/abs/2503.13657)) supplies the
empirical failure vocabulary this transport must make legible. In particular,
its explicit intent, durable history, acknowledgement, deadline, and
needs-attention fields surface evidence relevant to FM-1.4 Loss of Conversation
History, FM-2.1 Conversation Reset, FM-2.2 Fail to Ask for Clarification,
FM-2.4 Information Withholding, and FM-3.1 Premature Termination. This is a
classification basis, not a reliability claim: MAST finds that standardized
message formats do not resolve inter-agent misalignment. A conversation-health
detector remains out of scope until revoy2 has a representative production
trace corpus against which to validate one.

## Decision

1. A `NodeCommunication` may persist one closed intent: `request`,
   `response`, `notify`, or `needs_attention`. The existing exact tree-node
   author/recipient identities remain authoritative; intent is not an A2A
   user/agent role.
2. A direct-thread reply may name `reply_to_communication_id`, but the manager
   requires that record to be in the same direct thread, addressed to the
   replying endpoint, and carry the same correlation id. Cross-thread and
   correlation-changing replies fail closed.
3. `ack_required` and `deadline_at` are immutable ledger fields. The
   `bus.thread.ack` command appends a recipient-authored acknowledgement; it
   never mutates a prior message. History derives `pending`, `acknowledged`,
   or `timed_out` from replay at its query time. Thus restart changes neither
   acknowledgement nor deadline evidence.
4. A needs-attention projection is a list of durable record ids, never a
   mutable inbox count.
5. Existing generic evidence/runtime event facilities are not advertised as
   direct-thread push delivery. A subscribable push adapter remains future
   work until it has a distinct canonical event and executable transport test.

## Consequences

The transport is richer without introducing a mailbox, worker-local delivery
state, or a second persistence authority. It remains internal semantic
alignment only: no A2A wire-conformance claim follows from these fields.

## Obligations

### O1 — Independent review verifies durable direct-thread transport semantics

Before acceptance, independent review must check direct endpoint and
correlation validation, acknowledgement authorisation, deterministic bounded
replay/timeout derivation, restart restoration, capability redaction, and the
absence of a misleading push-delivery claim.

<!-- unverifiable: ADR-039 remains Proposed pending independent review; its implementation tests are review evidence, not accepted proof. -->
