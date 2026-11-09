# ADR-022: Checked-In Repo Instructions Are a Filesystem-Sourced Context Scope, Not a Ledger Fact

**Status:** Accepted
**Date:** 2026-08-04 (proposed); accepted 2026-08-04 (wave 4) — the operator
accepted with the ledger-exclusion roundtrip test tracked as a fast-follow,
not a precondition of acceptance. That test now exists:
`arbor-prompts/tests/repo-instructions-ledger-exclusion.test.ts`.

## Context

ROADMAP.md §4B.6 claims three memory scopes: global configuration, checked-in
repo instructions (`AGENTS.md`/CLAUDE.md), and per-node/subtree runtime
evidence. Only two exist. Short-term (per-campaign) and long-term
(cross-campaign) memory are real: `MemoryFact` records are ledger-witnessed
(ADR-014), provenance-typed, and injected live before every specialist and
critic dispatch. **The checked-in repo instructions scope does not exist** —
there is zero reference to `AGENTS.md` or CLAUDE.md anywhere under
`packages/*/src` (G-10, ROADMAP.md Verified gap register). Every parent
harness in the field study (Claude Code, opencode itself, and the others
`prior-art-research` catalogued) has this scope; revoy2 is the outlier in
lacking it.

The gap is not "nobody thought of it" — it is a genuine design question the
register cannot resolve on its own: **how does static, git-tracked,
free-text repo guidance enter a node's dispatch context without being copied
into the audit ledger?** The ledger (ADR-007, ADR-014) is revoy2's single
cross-campaign memory. It is hash-chained, append-only, and every record
carries a closed provenance union (`verified` / `claimed` / `critic_approved`
/ `!generated`) that describes *how a specific runtime action was
established during this campaign*. `AGENTS.md`/CLAUDE.md content is none of
those things — it is operator-authored configuration that already has its
own provenance (the repo's own git history) and does not describe anything
the runtime did. Treating it as a `MemoryFact` would misrepresent static
config as campaign-produced evidence, and would force the ledger to grow
without bound every time a maintainer edits a guidance file, since nothing
in the fact model expects an existing fact's source content to change out
from under it.

## Decision

Add a third context scope that is explicitly **not** ledger-witnessed:
a read-only, filesystem-sourced injection resolved at prompt-composition
time, alongside (not through) the existing short-term/long-term memory
injection point.

Concretely:

1. A pure function, `resolveRepoInstructions(worktree_path) -> { source_paths:
   string[]; content: string }`, walks from the node's worktree root (never
   above it — a Seed's worktree is the isolation boundary ADR-001 already
   draws, and instruction resolution must not cross it) for `AGENTS.md` and
   CLAUDE.md, in that precedence order, mirroring the resolution convention
   the field-study harnesses already use so a repo's existing files work
   unmodified.
2. The loop composes this alongside the existing memory-scope injection
   (ADR-014's site) into the specialist/critic prompt as a distinct, labeled
   section — never as a `MemoryFact`, never assigned a `record_id` or
   `content_hash` in the audit ledger, never passed through
   `EvidenceLedger.record*`.
3. Content is bounded by a fixed byte budget with deterministic truncation
   (the same discipline Phase 6.4's context-economy work already applies to
   memory injection), so a large `AGENTS.md` cannot silently blow the token
   budget for every dispatch.
4. Absence of either file is a no-op, not an error — most worktrees will not
   have one.

This scope is structurally closer to how `arbor-config` reads its config
file (filesystem-sourced, not ledger-witnessed, read fresh at the point of
use) than to how `MemoryFact` works. It does not touch `EvidenceLedger`,
does not add a new `AuditRecord` variant, and does not change the
ledger-witnessed-projection shape ADR-014 establishes for everything that
*is* campaign evidence.

## Consequences

**Positive:**

- Closes the field-study gap; every scope the register describes now exists.
- No ledger schema growth for a fact type that was never evidence in the
  first place — the ledger stays a pure record of what the campaign did, not
  what it was told.
- Repo instructions have one source of truth (the file), not a second,
  potentially stale copy embedded in ledger history.

**Negative:**

- Repo instructions are **not replayable evidence**. If `AGENTS.md` changes
  between two nodes in the same campaign, or between an original run and a
  later ledger replay, prompt content for structurally equivalent nodes can
  differ, and the ledger has no record of what instructions were in effect
  at dispatch time. This is a real limitation for forensic reconstruction —
  but it is not a new class of problem: `arbor-config`'s own config file has
  exactly the same property today and that has been an accepted, unremarked
  gap since ADR-008. This ADR extends an already-accepted risk rather than
  introducing a new one.

**Neutral:**

- The byte-budget/truncation mechanism reuses existing memory-injection
  discipline; this is a new *source*, not a new *mechanism class*.

## Test implications

- `resolveRepoInstructions` is deterministic for a fixed worktree state and
  respects the `AGENTS.md` → CLAUDE.md precedence order.
- Resolution never crosses above the worktree root.
- Resolved content appears in the composed prompt and never in any
  `EvidenceLedger` record — a roundtrip test asserting the ledger's JSONL
  output contains none of the injected text is the negative-space proof.
- Byte budget truncation is deterministic and reported, not silent.
- Missing files produce an empty scope, not an error.

## Alternatives considered

1. **Journal repo instructions as a `MemoryFact` with `!generated` or
   `claimed` provenance at campaign start.** Rejected: mischaracterizes
   static, git-tracked configuration as campaign-produced evidence, and
   duplicates file content into the ledger, growing it unboundedly as
   instructions are edited over a long-lived repo's lifetime.
2. **Blanket-inject at the manager level regardless of node or worktree.**
   Rejected explicitly by the existing gap-register text ("Never
   blanket-inject global runtime memory into every leaf") — different
   subtrees can legitimately have different nested `AGENTS.md` files, and a
   manager-level injection would erase that.
3. **Route `AGENTS.md`/CLAUDE.md through `arbor-config`'s schema as another
   config key.** Rejected: `arbor-config` exists to validate operator-authored
   *typed* JSON against a schema (Phase 6.5's "no config key without a
   reader" discipline). Repo instructions are free-text natural language with
   no schema to validate against; force-fitting them into the config surface
   would misrepresent their shape and complicate `arbor-config`'s actual job.

## Obligations

### O1 — `resolveRepoInstructions` walks from the worktree root for `AGENTS.md`/CLAUDE.md in that precedence order and never crosses above the worktree root

<!-- proof: symbol=resolveRepoInstructions file=packages/arbor-prompts/src/repo-instructions.ts roundtrip=packages/arbor-prompts/tests/repo-instructions.test.ts -->

### O2 — Absence of either file is a no-op: it produces an empty scope, never an error

<!-- proof: symbol=resolveRepoInstructions file=packages/arbor-prompts/src/repo-instructions.ts roundtrip=packages/arbor-prompts/tests/repo-instructions.test.ts -->

### O3 — Resolved content is bounded by a fixed byte budget with deterministic truncation, never silently blowing past it

<!-- proof: symbol=resolveRepoInstructions file=packages/arbor-prompts/src/repo-instructions.ts roundtrip=packages/arbor-prompts/tests/repo-instructions.test.ts -->

### O4 — Resolved repo-instruction content reaches the composed prompt but never `EvidenceLedger` — it carries no `record_id`/`content_hash` and never appears in ledger JSONL output

<!-- proof: symbol=resolveRepoInstructions file=packages/arbor-prompts/src/repo-instructions.ts roundtrip=packages/arbor-prompts/tests/repo-instructions-ledger-exclusion.test.ts -->
