# ADR-002: UCT Scoring Function with Regression-Aware Priors

**Status:** Accepted
**Date:** 2026-07-31

## Context

The tree-search loop needs a scoring function to decide which action to expand next. The function must balance exploitation (high-gain actions) with exploration (underexplored categories). It must also be conservative when prior iterations caused regressions.

## Decision

Use the Arbor paper's published formula (arXiv 2606.12563v1 §4):

```
h(a) = [g(a)/c(a)] · (1 − r_acc) · (1 − r_crash) · m_gap + C · √(ln N / (1 + n_cat))
```

Where `g(a)` is estimated gain, `c(a)` is estimated cost, `r_acc`/`r_crash` are regression rates from prior iterations, `m_gap` is the performance gap to the best known result, and the second term is the UCB1 exploration bonus (Kocsis & Szepesvári 2006).

Implemented in `packages/arbor-core/src/scoring.ts`.

## Consequences

**Positive:** Published algorithm (clean-room safe — concepts are not copyrightable). Empirically validated: +40-193% throughput over vendor baselines in the Arbor paper. The regression penalties make the system self-correcting — if a category keeps causing accuracy drops, its score drops.

**Negative:** The formula is hand-engineered, not learned. SVR (arXiv 2607.28457) shows learned self-verification via GRPO outperforms hand-engineered halting. This is a Phase 3+ upgrade target.

**Neutral:** The exploration constant C is tunable. Default is √2 (standard UCB1). May need per-domain tuning.

### 2026-08-12 evaluation amendment

Cost and difficulty are not interchangeable routing signals. *Not All Errors Are Equal*
([arXiv:2606.04402](https://arxiv.org/abs/2606.04402)) reports consequence and difficulty as
orthogonal and finds difficulty-aware routing worse than random under its cost-weighted objective;
the transferable comparator is `consequence × marginal success gain`. BAVT
([arXiv:2603.12634](https://arxiv.org/abs/2603.12634)) also reports that tree structure without
value guidance underperforms a flat parallel baseline. These findings do not change production UCT,
but make value-signal quality a precondition, not a refinement.

Tree-GRPO ([arXiv:2509.21240](https://arxiv.org/abs/2509.21240)) motivates complete agent steps as
node granularity and sibling-subtree outcome differences as zero-extra-evaluation process signal.
`arbor-eval` now replays that signal; it remains outside production selection. Budget-annealed and
clipped residual-value comparators likewise remain eval-only until evidence supports a switch.

## Alternatives Considered

1. **Thompson Sampling.** Rejected: requires a prior distribution over action quality, which we don't have for code actions. UCT is simpler and proven for game-tree search.

2. **Greedy selection (always pick highest gain/cost).** Rejected: no exploration. The system would get stuck re-selecting the same action category.

3. **Learned scoring via RL.** Rejected for Phase 0: requires training data we don't have yet. Track SVR for Phase 3+.

## Obligations

### O1 — `scoreAction` implements the published UCT formula: h(a) = [g(a)/c(a)] · (1 − r_acc) · (1 − r_crash) · m_gap + C · √(ln N / (1 + n_cat))

<!-- proof: symbol=scoreAction file=packages/arbor-core/src/scoring.ts roundtrip=packages/arbor-core/tests/scoring.test.ts -->

### O2 — Accuracy and crash regression rates only ever reduce a candidate's score, never increase it (self-correcting, not self-reinforcing)

<!-- proof: symbol=scoreAction file=packages/arbor-core/src/scoring.ts roundtrip=packages/arbor-core/tests/scoring.test.ts -->

### O3 — The exploration constant C is a configurable value, not a hard-coded literal, defaulting to √2 (standard UCB1)

<!-- proof: symbol=DEFAULT_SCORE_CONFIG file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-core/tests/tree.test.ts -->
