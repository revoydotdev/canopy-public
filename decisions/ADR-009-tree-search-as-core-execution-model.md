# ADR-009: Tree Search as the Core Execution Model

**Status:** Accepted
**Date:** 2026-07-31

## Context

Multi-agent harnesses typically use linear pipelines (plan → execute → review). The Arbor paper (arXiv 2606.12563v1) demonstrates that tree search — branching on alternative approaches, scoring each branch via UCT, and backtracking on failure — produces +40-193% throughput over linear baselines.

## Decision

Make **tree search** the core execution model. The unit of work is a node in a search tree, not a step in a pipeline. The loop is: select (UCT) → expand (Specialist) → critic gate → score → branch/backtrack → halt check.

This is implemented in `packages/arbor-core/src/tree.ts` and `packages/arbor-core/src/scoring.ts`.

## Consequences

**Positive:** The system can recover from bad branches — instead of retrying the same failed approach (linear pipeline behavior), it tries a different branch. The UCT exploration bonus ensures underexplored approaches get tried. This is the single feature that separates this project from every linear-pipeline harness surveyed (omo, athena-loops, Bernstein, CodeJury).

**Negative:** Tree search is more complex than a linear pipeline. The tree data structure, scoring function, and backtracking logic add implementation surface. Each iteration is more expensive because of the selection overhead.

**Neutral:** The tree starts with a single root node (the plan). Branching happens when Crown creates child nodes under a verified parent. Backtracking walks the tree to the parent on failure.

## Alternatives Considered

1. **Linear pipeline with retry.** Rejected: retrying the same approach after failure doesn't explore alternatives. The Arbor paper's results show this underperforms tree search by 40-193%.

2. **Tournament (parallel approaches, pick best).** Rejected: tournaments don't reuse learning from failed approaches. Tree search's KB injection carries failure modes forward to subsequent branches.

3. **DAG (directed acyclic graph).** Considered for Phase 3+: a DAG allows merging branches (reusing partial results from different approaches). Trees are simpler and sufficient for Phase 0-2.

## Source

Derived from the Arbor paper (arXiv 2606.12563v1) §4. The MCTS algorithm basis is Browne et al. 2012 (public domain). The UCT formula is Kocsis & Szepesvári 2006 (public domain).

## Obligations

### O1 — The unit of work is a tree node (`TreeNode`), not a step in a linear pipeline

<!-- proof: symbol=TreeNode file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-core/tests/tree.test.ts -->

### O2 — Node selection is UCT-scored over pending, ancestor-valid nodes, not a FIFO queue or linear retry of the last action

<!-- proof: symbol=selectNode file=packages/arbor-core/src/tree.ts roundtrip=packages/arbor-core/tests/tree.test.ts -->

### O3 — A failed node backtracks: its parent becomes available for a new branch, rather than the loop retrying the same failed action

<!-- proof: symbol=failNode file=packages/arbor-core/src/tree.ts roundtrip=packages/arbor-core/tests/tree.test.ts -->

### O4 — Campaign halt is a three-condition check (budget exhausted, below-threshold, converged), evaluated independently of any single node's outcome

<!-- proof: symbol=haltCheck file=packages/arbor-core/src/scoring.ts roundtrip=packages/arbor-core/tests/scoring.test.ts -->
