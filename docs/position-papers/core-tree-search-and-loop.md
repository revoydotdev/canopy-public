# Core tree-search and campaign loop

This paper explains the mechanism that makes revoy2 distinct from single-pass agent loops.

## What it does

`@arbor/core` controls the campaign tree:

- chooses nodes with an upper-confidence scoring formula,
- tracks state transitions (`pending`, `verified`, `failed`, `pruned`, `interrupted`),
- runs deterministic selection/creation/verification/rollback paths,
- emits events for the runtime and projections.

The loop itself is composed in `@arbor/opencode` (`src/loop.ts`) and `@arbor/mcp`
runtime adapters. The loop has explicit phases:

1. **select** a node,
2. **expand** it under isolation controls,
3. ask a **specialist** to execute a candidate action,
4. ask a **critic** to independently validate,
5. accept, backtrack, or halt.

## Why this matters

Without this loop:
- a failed attempt is terminal,
- there is no principled place to inject prior failures,
- and no recoverable branch planning is possible.

With this loop:
- each failure becomes knowledge,
- retries can change context and strategy,
- and the system can stop on convergence or resource boundary instead of exhausting
  blindly.

## Research grounding

revoy2’s loop model follows the documented tree-search harness position in
`docs/first-principles-audit-report.md` and ADR-002 (UCT scoring). It is cross-checked
against:

- `docs/research/agent-uct-primary-source-delta-2026-08-10.md`
- `docs/research/agent-uct-comparison-2026-08-10.md`

These notes make the important point: MCTS-style scoring only helps if the loop actually
wires live regression and outcome signals. The repo work in this 7-day period has been
exactly on that boundary (ADR-062..ADR-075 and gate battery updates).

## Why the specific primitives were chosen

- **Pending-first scoring** avoids over-committing to already-closed branches.
- **Convergence counters and halt criteria** provide a hard budget safety stop that is
  inspectable instead of silent.
- **Backtrack policy over fail nodes** keeps work bounded and preserves future context.

## Risks and current caveats

- Regression-aware scoring signals exist in design and governance and must remain
  fed by reliable history metrics.
- Category filtering in failure injection is now scoped in latest loop code; if a
  change broadens that scope, specialist prompting quality degrades.
- As with any search engine, quality depends on admissible branching policy and reward
  calibration; these are in gates/eval, not only in `scoring.ts`.

## Relevant implementation map

- Tree controller: `packages/arbor-core/src/tree.ts`
- Score function: `packages/arbor-core/src/scoring.ts`
- Persisted runtime contracts: `packages/arbor-core/src/persist.ts`, `packages/arbor-core/src/types.ts`
- Loop orchestration and ports: `packages/arbor-opencode/src/loop.ts`,
  `packages/arbor-mcp/src/loop-adapters.ts`
- Loop integration and supervisor: `packages/arbor-mcp/src/manager.ts`, `packages/arbor-mcp/src/runtime.ts`

## Freshness signal

In the last week, tree-search-related work appears in:

- gate battery refactor and hardening (`packages/arbor-mcp`, `packages/arbor-gate`),
- arbiter and routing cadence updates (`packages/arbor-opencode`, `packages/arbor-core`),
- new evidence stores/replays to keep search behavior reproducible (`.completion-depth`,
  `.visual-intelligence`, `.determinism-baseline`).

For the full inventory and rationale, see
[seven-day-recent-updates](./seven-day-recent-updates.md).
