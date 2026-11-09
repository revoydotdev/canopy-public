# ADR-053: Integration Conductor Is a Supervised Verified Landing Process

**Status:** Accepted
**Date:** 2026-08-12

## Context

The roadmap 04–11 integration postmortem records a successful but manual sequence: construct a conflict graph, order dependent branches, rebase each branch against the advancing trunk, verify it in an isolated worktree, then fast-forward. Repeating that process by hand does not scale and leaves stale-trunk, same-line conflict, generated-store, and verification-order mistakes to operator memory.

Bors-ng and Graphite demonstrate verified queued integration and reuse of prior validation, but their unit is an independently reviewable pull request. revoy2 integrates governed roadmap branches that can carry decision records, regenerated evidence stores, and explicit branch dependencies. Pijul's patch model was considered and rejected: replacing Git would be disproportionate, its GPL licensing is incompatible with adoption here, and its ecosystem does not solve revoy2's governance-specific landing obligations.

## Decision

revoy2 provides a supervised integration conductor with separately invocable planning, landing, decision-renumbering, and store-regeneration phases. Planning combines a `depends_on` DAG with pairwise changed-file overlap and emits an inspectable order. Landing always re-reads the trunk ref, rebases in a scratch worktree, and runs the build and full Vitest isolation gates before advancing trunk.

The conductor may mechanically union import/export members, additive exhaustive arms, and may discard branch copies of generated stores so they can be regenerated once from integrated truth. It must never guess at an ordinary same-line conflict. Such a conflict remains in the scratch worktree and requires an explicit, later operator resolution. Trunk advancement is a compare-and-fast-forward operation: if trunk moves after the rebase begins, the attempted landing is refused.

The command invocation is the operator's landing approval. The conductor never discovers branches, pushes refs, deletes branches, or resolves semantic conflicts on its own.

Decision numbering and the trunk contract remain explicit integration points for roadmaps 13 and 16. Until those land, the conductor requires `--trunk` and refuses to invent an ADR allocation mechanism.

## Consequences

The formerly manual integration loop becomes repeatable and inspectable while retaining the operator as acceptance authority. Independent branch success remains insufficient: every branch is checked again after rebasing onto the current integrated state. Generated evidence is produced after composition rather than selected from a conflicting branch copy.

The conservative default can require manual intervention for a conflict that a human later judges mechanical. This is intentional: a false refusal costs review time; a false merge can silently remove a security property.

## Obligations

### O1 — Red verification never advances trunk

<!-- proof: symbol=landBranch file=scripts/lib/conductor/land.mjs roundtrip=scripts/tests/integration-conductor.test.mjs -->

If any isolation command exits non-zero, the trunk ref remains byte-for-byte unchanged.

### O2 — Same-line semantic conflicts are never auto-resolved

<!-- proof: symbol=resolveDiff3Text file=scripts/lib/conductor/conflicts.mjs roundtrip=scripts/tests/integration-conductor.test.mjs -->

Only closed, set-union syntax shapes are mechanically composed. Every other diff3 region is retained and reported as a semantic conflict.

### O3 — Every landing reads advancing trunk at execution time

<!-- proof: symbol=landBranch file=scripts/lib/conductor/land.mjs roundtrip=scripts/tests/integration-conductor.test.mjs -->

The landing driver resolves trunk immediately before each rebase and refuses its final compare-and-fast-forward if the ref moved meanwhile.

### O4 — Branch dependencies constrain plan order

<!-- proof: symbol=planBranches file=scripts/lib/conductor/graph.mjs roundtrip=scripts/tests/integration-conductor.test.mjs -->

Topological dependency order is authoritative; changed-file conflict weight only breaks ties among ready branches.
