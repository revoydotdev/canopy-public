# ADR-023: revoy2 Does Not Add a Rollback Target — Worktree Isolation Plus the Ledger Already Bound Blast Radius

**Status:** Accepted
**Date:** 2026-08-04 (proposed); accepted 2026-08-04 (wave 4), no conditions.
The two premises this decision rests on are proven by existing coverage, not
merely asserted — see "Test implications" below for citations.

## Context

revoy2 has no checkpoint, rewind, or undo mechanism (G-13, ROADMAP.md
Verified gap register). "Checkpoint" already means something specific and
narrower in this codebase: `CampaignManager.checkpointGate` journals that a
governed transition happened, for crash-time reconciliation on restart. It
is never a rollback target — there is no shadow tree, no restore path, and
no way for an operator or the runtime to say "return to the state three
nodes ago" and have tree/KB/audit state actually move backward.

The field study is unambiguous that this is a real capability gap: Zoo Code
ships shadow-git checkpoints (an automatic per-turn snapshot an operator can
restore to), and opencode ships a previewable selective restore (pick
specific file changes to revert). revoy2 has neither.

The question this ADR must answer is not "is the gap real" — it is: **does
revoy2's architecture actually need a rollback target, given what already
bounds the blast radius of a bad change?** Two structural facts matter:

1. **Isolation (ADR-001).** Every Seed/specialist runs in its own git
   worktree (`arbor-campaign-support/src/worktree.ts`). A bad change lives in a
   disposable worktree/branch until it passes the four-gate lifecycle
   (admission → isolation → evidence → audit, ADR-006) and is explicitly
   merged. There is no "oops, I need to undo the one working tree" scenario
   the way there is for a single-worktree coding agent — which is exactly
   the failure mode shadow-git snapshotting exists to protect against in
   the tools the field study compares against. Zoo Code and opencode both
   operate directly on the user's one working tree; revoy2 structurally does
   not.
2. **The ledger (ADR-007, ADR-014, ADR-016, ADR-017, ADR-018).** Every
   governed state transition is hash-chained, append-only, and
   provenance-typed. An operator already has full forensic reconstruction of
   what happened and why — every gate checkpoint, every recovery attempt,
   every KB fact, every interruption — without any rollback mechanism at
   all. What the ledger deliberately does *not* provide is a way to rewrite
   that history backward, because doing so is precisely what an append-only,
   hash-chained ledger exists to make impossible.

## Decision

**No.** revoy2 does not add a rollback/undo target — no shadow-git snapshot
store, no selective restore, no ledger-native "revert to cursor N."

Reasoning, in order of weight:

1. **The failure mode doesn't exist in this shape.** Isolation already
   contains a bad change to a disposable worktree until an explicit merge
   step. Shadow-git and selective restore solve "I broke my one working
   tree"; revoy2 Seeds never have one working tree to break.
2. **A rollback target would compete with the ledger's own model of time.**
   Every prior "is this a projection or authority" decision (ADR-011, 014,
   016, 017, 018, 021) rejected a second, parallel notion of state for
   exactly this reason: it drifts from the ledger and eventually someone
   trusts the wrong one. A mechanism that mutates tree/KB/audit state
   *backward* is that shape by definition — it cannot be a "projection" of
   the ledger, because the ledger has no backward-motion primitive to
   project from.
3. **Nobody has designed it, and it is exactly the kind of capability
   Phase 6.2's own correction warns against inventing on the spot:** "no
   gate conceives a capability nobody has designed." A real rollback target
   touching tree state, KB entries, memory facts, gate records, and
   communications simultaneously is a large, correctness- and
   security-sensitive surface (a fifth trust boundary at minimum, and an
   *anti*-gate at worst — one that undoes already-verified, already-audited
   state). Building it without a dedicated design pass would be worse than
   not having it.
4. **The genuine sub-need is already served elsewhere, forward-only.**
   Recovering from an interrupted or failed node is not blocked on
   rollback: ADR-012 (fresh retry authority) and ADR-016 (interruption is a
   recoverable ledger outcome) already let a node be abandoned or retried.
   That is "undo" in the only shape that composes safely with an
   append-only ledger — a new, forward attempt, not a rewrite of the old
   one. Emergency abort of a runaway campaign is likewise already served by
   the audit gate's halt path (ADR-006).

What remains genuinely uncovered, named here and explicitly **deferred, not
decided**: after a campaign's change is merged onto a durable branch,
reverting it is git's job on the real repository, exactly as it would be for
a human's commit — revoy2 does not reimplement `git revert`. A future,
much smaller improvement would be a durable, ledger-referenced pointer from
"this campaign's merge commit" back to the exact worktree commit and audit
cursor that produced it, so an operator doing a manual revert can correlate
it to the campaign/node/evidence that produced the bad change. That is a
traceability improvement, not a rollback mechanism, and should get its own
ADR only if the gap proves real in practice — not built speculatively here.

## Consequences

### External adapter evidence (2026-08-12)

Claw-SWE-Bench ([arXiv:2606.12344](https://arxiv.org/abs/2606.12344)) reports a sharp adapter
comparison: model-emitted patch text achieved 19.1% Pass@1 with 69.1% apply failure, while runner-
observed repository edits achieved 73.4% with under 1.5% apply failure. This supports the premise
here: repository state in an isolated worktree is authority; a model's final message is not.

**Positive:**

- No new trust boundary and no competing model of time; the ledger remains
  the single source of "what happened."
- Avoids building and indefinitely maintaining a large, security-sensitive
  feature (shadow-git snapshotting or selective restore across a
  tree+KB+ledger system) that revoy2's own isolation architecture does not
  need in the shape the compared tools need it.

**Negative:**

- If an operator merges a campaign's change and later decides it was wrong,
  there is no product-level "undo this campaign's contribution" button —
  they fall back to `git revert` on the real repository with no revoy2-side
  assistance beyond what the ledger can already tell them forensically. This
  is an accepted, named limitation, not an oversight.

**Neutral:**

- The field-study gap remains real and is now resolved as an accepted
  non-goal rather than an unwitnessed absence — the distinction Phase 6
  exists to enforce.

## Test implications

None directly — this ADR does not introduce a mechanism. It does obligate
existing coverage to keep proving the two facts the decision rests on:

- Isolation: a Seed's changes are never observable outside its worktree
  until an explicit, gated merge (existing ADR-001/ADR-006 coverage —
  concretely, `arbor-opencode/tests/worktree.test.ts` proves worktrees are
  created/leased/removed as the actual isolation mechanism, and
  `arbor-gate/tests/gate-order.invariant.test.ts` proves `isolation` is a
  mandatory gate in the fixed admission → isolation → evidence → audit
  order — a node cannot reach evidence/audit without passing it).
- Ledger append-only-ness: no code path can rewrite or remove a prior
  ledger record (existing hash-chain integrity tests, e.g.
  `arbor-audit/tests/hash-chain-integrity.test.ts`).

If either property regresses, this ADR's premise no longer holds and it
should be revisited.

## Alternatives considered

1. **Shadow-git checkpoints (Zoo Code-style automatic snapshot-and-restore).**
   Rejected: solves a failure mode (clobbering your one working tree) that
   worktree isolation already prevents structurally; would duplicate git's
   own history inside a second, revoy2-owned snapshot store for no
   corresponding new safety.
2. **Previewable selective restore (opencode-style).** Rejected for the same
   isolation reason, plus it does not compose with the ledger's append-only
   guarantee: reverting some of a node's file changes without reverting its
   recorded gate/evidence trail would desync the two, producing a tree whose
   audit history describes work that no longer exists on disk.
3. **A ledger-native "revert node" governed transition that spawns a new
   node undoing a prior one's diff.** Not rejected outright — closer to
   "retry with fresh authority" (ADR-012) applied to reversal, and a
   legitimate candidate for a future ADR if a concrete need emerges. Nothing
   today motivates the design work, and speculative design here would
   violate the "no gate conceives a capability nobody has designed"
   discipline this ADR itself invokes.

## Obligations

This decision is a non-goal: it commits to NOT building a rollback
mechanism. Its obligations are therefore about the two structural premises
the "no" rests on, not about a rollback feature — a rollback target does
not exist here by design, and no obligation below asserts one.

### O1 — Isolation is a mandatory, ordered gate: a node cannot reach evidence/audit without first passing `isolation`, and the four-gate lifecycle order is fixed and closed

<!-- proof: symbol=checkIsolation file=packages/arbor-gate/src/gate.ts roundtrip=packages/arbor-gate/tests/gate-order.invariant.test.ts -->

### O2 — A Seed's changes are never observable outside its own git worktree until an explicit, gated merge — worktree isolation is the actual mechanism, not merely stated policy

<!-- proof: symbol=WorktreeManager file=packages/arbor-campaign-support/src/worktree.ts roundtrip=packages/arbor-opencode/tests/worktree.test.ts -->
<!-- proof: symbol=preserveWork file=packages/arbor-campaign-support/src/preservation.ts roundtrip=packages/arbor-opencode/tests/worktree-preservation.test.ts -->
<!-- proof: symbol=checkIntegration file=packages/arbor-campaign-support/src/integration-check.ts roundtrip=packages/arbor-opencode/tests/integration-check.test.ts -->

### O3 — The audit ledger is append-only and tamper-evident: no code path can rewrite, reorder, duplicate, or truncate a prior ledger record without detection on replay

<!-- proof: symbol=EvidenceLedger file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/hash-chain-integrity.test.ts -->
