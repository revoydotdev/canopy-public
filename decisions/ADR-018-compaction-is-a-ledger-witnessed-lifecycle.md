# ADR-018: Compaction Is a Ledger-Witnessed Lifecycle

**Status:** Accepted
**Date:** 2026-08-02

## Context

The token-economy substrate (ADR-015, roadmap 4B.3a) gives each expansion a
persisted token epoch and routes context overflow as a recoverable interruption.
But compaction itself — the act of reducing the conversation a node will re-read
— is the one place the loop both *spends a model call to clean up* and *mutates
the very history the model is about to see*, yet it is not a typed, durable,
typed-outcome record. ACE's grow-and-refine method names iterative brevity bias
and context collapse and motivates incremental deltas over monolithic rewriting
([arXiv 2510.04618](https://arxiv.org/abs/2510.04618)). The graduated pipeline in
*Dive into Claude Code* ([arXiv 2604.14228](https://arxiv.org/abs/2604.14228))
is an external comparator for revoy2's deliberate single ledger-witnessed layer.
Observable predecessors each solve only part of the problem: Codex has a typed
trigger/status + four strategies; opencode has an anchored-merge summary;
Zoo retains non-destructively via tagging; OMO has a windowed guard. None runs
all four as one auditable lifecycle, and three of the four (Codex in-memory
mailbox, OMO in-memory guard, opencode process-local registry) are not durable.

An un-typed compaction is a correctness hazard: a crash mid-compaction must not
leave a half-rebuilt history, a summary must never be mistaken for evidence, and
"interrupted" must never be conflated with "failed" (Commandment VI).

## Decision

Compaction is a **ledger-witnessed `CompactionLifecycle` record** in the audit
chain, not a helper mutation. The lifecycle carries:

- a **closed `trigger`** (`"auto" | "manual"` plus any revoy2-owned additions);
- a **closed `status`** of `"completed" | "interrupted" | "failed"` —
  **`interrupted` is distinct from `failed`** (a stopped compaction is not an
  error; Commandment VI), mirroring how interrupted expansion is a recoverable
  outcome (ADR-012/016);
- a `strategy` discriminator (revoy2-owned: local-model, token-budget-fresh-
  window, structural-folding — never the parent filenames/impls);
- **pre + post compaction evidence pointers** into the content-addressed store
  (Commandment II: durable evidence is written before any projection/tree state
  change; Commandment VII: raw evidence is never dropped on compaction);
- an **anchor** pointer to the prior sealed summary record.

**Anchored merge, not regenerate:** the new summary preserves still-true
established facts and folds in new ones (opencode's "anchor" semantics),
expressed in a revoy2-owned template that never mentions the compaction process.
The anchor is the last sealed summary record; each compaction refines, never
replaces, the accumulated summary.

**Non-destructive retention:** original evidence is kept and tagged (a Zoo
`condenseParent` analog = a ledger pointer + hash), and the *effective history*
is a rebuildable projection that filters tagged records. Nested compaction (a
summary of a summary) is a chain, never a double-tag; the audit record survives
a projection prune (ADR-014).

**Reconciled, windowed guard:** a compaction guard is time-bounded + epoch-gated
(the OMO *shape*), but "is a guard active?" is **recomputed from durable ledger
facts** at `selectNode`/`nodeActivation` — never a transient in-memory flag.
Commandment III (no marker authority): a crash can never leave a phantom armed
guard blocking the loop.

## Consequences

- Compaction is replayable: a restart re-derives the conversation and the
  summary from the `CompactionLifecycle` chain byte-identically (ADR-012).
- `interrupted ≠ failed`: a stopped compaction is a recoverable typed outcome,
  never logged as a false failure-mode KB fact.
- Memory/telemetry (ADR-014/017) treat compaction records as projections, so
  compaction reduces *context*, never *authority*.
- Tests must cover: crash after each durable boundary, restart byte-equivalent
  rebuild, double-compaction conflict, nested-summary chain (no double-tag),
  `interrupted` vs `failed`, and no false critic/event/tree transition on a
  failed or interrupted compaction (handoff §11).

## Roads not taken

- A purely in-memory compaction (no durable record) — rejected: crashes would
  wedge or double-run.
- A summary that overwrites the prior summary — rejected: loses the
  anchor/merge property and the audit trail.
- A guarding flag that is an authority (no reconcile) — rejected: the confirmed
  omo/opencode "cap never drops" wedge.

The roadmap (Phase 4D.7) and the clean-room guardrails govern rebinding; write an
implementation note mapping these stages onto `arbor-audit`/`arbor-mcp` record
kinds before spreading code.

## Obligations

### O1 — `CompactionLifecycle` records use a closed status vocabulary where `interrupted` is distinct from `failed`

<!-- proof: symbol=CompactionLifecycle file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/compaction-lifecycle.test.ts -->

### O2 — Pre/post compaction evidence pointers are validated non-empty before a lifecycle record can be appended

A record with fabricated (empty) evidence pointers is rejected rather than
silently accepted.

<!-- proof: symbol=validateCompactionLifecycle file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/compaction-lifecycle.test.ts -->

### O3 — The loop never records a fabricated `completed` lifecycle for auto-compaction

When no structural-compaction authority is composed, the loop emits a typed
`compaction_skipped` diagnostic instead of an empty-evidence ledger record.
When it is composed, it captures the complete preimage before folding,
captures the bounded postimage, then appends `completed`; cancellation after
the preimage is instead a distinct `interrupted` record retaining that real
partial evidence.

<!-- proof: symbol=composeLoopConfigPorts file=packages/arbor-mcp/src/loop-ports-helper.ts roundtrip=packages/arbor-mcp/tests/loop-ports-interrupt.test.ts -->

### O4 — Compaction performs real anchored-merge structural folding of the conversation a node will re-read, preserving still-true established facts while reducing context

The production composition reads the last completed lifecycle, resolves its
content-addressed postimage under the runtime's output-evidence authorization,
and inserts that actual rendered structural fold (not merely its pointer) into
the next token-dispatch context. The postimage names the exact durable
communication ids it covers, so replay adds only ids absent from that set;
it never relies on caller-supplied timestamps to decide whether a message was
folded. Earlier raw records remain intact in the audit ledger and
content-addressed preimage. Missing, corrupt, or unauthorized
postimages fail closed: the lifecycle remains inspectable but no substitute
summary is injected. A cancellation writes `interrupted`, never `failed` or
`completed`, with the already-captured preimage named as partial evidence.

<!-- proof: symbol=composeLoopConfigPorts file=packages/arbor-mcp/src/loop-ports-helper.ts roundtrip=packages/arbor-mcp/tests/loop-ports-interrupt.test.ts -->

### O5 — Cross-campaign memory is imported explicitly, with provenance and source identity preserved

Verified specialist-visible campaign facts do not leak globally merely because
they were learned. `CampaignManager.importMemoryFact` requires distinct named
requester and approver identities, verifies the source fact's provenance and
visibility, and appends a target-campaign fact whose `imported_from` carries
the source campaign/fact and both actors. The normal bounded memory projection
and `kbInject` then consume the imported target fact; critic-only or unverified
facts are refused rather than laundered through an import.

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager.test.ts -->
