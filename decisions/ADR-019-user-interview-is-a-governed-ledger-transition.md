# ADR-019: User Interview Is a Governed Ledger Transition

**Status:** Accepted
**Date:** 2026-08-02

## Context

revoy2 already distinguishes *critic* approval (`critic_approved`,
`verdict { approved }`) and provides a TUI confirmation overlay. But it has no
first-class **user-interview** mechanism for the *human*, and no durable "is an
interview in-flight?" state. Asking the user is the one place an agent
voluntarily gives up its autonomy, so the architecture must decide *when it is
safe to stop* (mode), *who may stop* (lead), *how it asks* (capability-
consistent), and *how the loop waits* (blocking vs guarded-async). The frontier
survey (frontier `Appendix D`) shows four distinct ask-mechanisms; none is both
durable and lead-scoped. Conflating a user interview with critic approval —
or with a generic error — would corrupt both authority and the checks-and-
balances model (ADR-005, Commandment IV).

## Decision

Interrupting for a user answer is a **ledger-witnessed `RequestUserInput`
transition**, not a side-effect callback.

- **Typed interrupt (Codex shape):** a `RequestUserInput` record —
  `id`, `question` text, a bounded `options[]` with an `is_other` escape — is
  emitted as a ledger record **before** the loop may stall (Commandment II:
  evidence before state).
- **Blocking is derived from mode (Codex):** a plan/admission interview blocks
  `selectNode`; an operator steer during expansion is async. One ledger-typed
  flag decides whether the loop waits on the human, never scattered blocking
  logic.
- **Lead-only question authority (Codex root-thread gate + OMO sibling rule):**
  only the root/lead node may interrupt the user. A delegated sibling appends a
  `needsInput` record that the lead consumes; it never asks the human directly —
  the user-facing mirror of ADR-005 capability tiers.
- **Steer, don't derail (Zoo `follow_up mode?`):** a structured
  `follow_up[{text, mode?}]` lets a chosen answer *steer / promote / backtrack*
  a node as a governed typed transition (same rule as `promote` in the
  conversational bus, Phase 4D.1), never a silent mutation.
- **Capability-consistent formulation, as a projection:** the question is derived
  from the node's `NodeCard` + capability tier + current uncertainty, so it can
  only offer options the current governance allows (never "implement now" in a
  gated mode). The question is a bounded, capability-consistent projection, not
  free prose.
- **Approve-from-ledger, not a cache (opencode corrected):** operator decisions
  persist as ledger records (`approved(pattern, scope)`), and "is this already
  approved?" is **re-derived from the ledger** at `selectNode` — never a mutable
  `$approved` cache that can drift or wedge (Commandment III; survived restart).
- **Pending-interview guard (OMO shape, corrected):** no auto-nudge / auto-next
  while a question awaits the user, and the guard is **reconciled from durable
  facts** — not a transient flag — so a crash cannot leave a phantom "waiting"
  state.

## Consequences

- Asking is replayable and auditable: an interview is a `RequestUserInput`
  record recoverable by replay (ADR-012).
- Only the lead can interview; delegation cannot bypass the human gate (ADR-005
  intact).
- Approvals re-derive from the ledger, so an operator decision survives restart
  and cannot be a separate authority.
- Autopilot never tramples an in-flight question: `selectNode`/continuation
  reconciles "awaiting user" from durable state.

## Roads not taken

- Treating the user interview as a generic error/`Err` — rejected: it is a
  voluntary, recoverable, typed outcome, never a failure (Commandment VI).
- Asking from any node — rejected: breaks checks-and-balances and lets a
  delegated sibling interrupt the human.
- A mutable `$approved` cache as authority — rejected: the confirmed
  marker/cap-wedge class (Commandment III).

The roadmap (Phase 4D.8) and clean-room guardrails govern rebinding; map this
onto an `arbor-audit` record kind + `arbor-gate` lead-scope check before
spreading code. Where the TUI already has a confirmation overlay, that overlay
becomes a view over this ledger record, not a separate authority.

## Obligations

### O1 — Asking the user is a ledger-witnessed record emitted before the loop may stall

It is never a side-effect callback.

<!-- proof: symbol=RequestUserInputRecord file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/user-input.test.ts -->

### O2 — Only the lead/root authority may interrupt the user directly

A delegated sibling's question is typed `delegated_needs_input` rather than
a direct ask of the human.

<!-- proof: symbol=UserInputAuthority file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/user-input.test.ts -->

### O3 — A chosen answer's follow-up is one of a closed set of governed transition kinds

An answer can steer, promote, or backtrack a node — never a silent mutation.

<!-- proof: symbol=UserInputFollowUpKind file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/user-input.test.ts -->

### O4 — The human's answer is appended as its own ledger record, never mutating the persisted question

Append-only hash-chain integrity is preserved across answering.

<!-- proof: symbol=UserInputAnswerRecord file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/user-input.test.ts -->

### O5 — Whether an interview is awaiting an answer is reconciled from durable record streams, not a mutable flag

A crash cannot leave a phantom "waiting" state.

<!-- proof: symbol=EvidenceLedger file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/user-input.test.ts -->
