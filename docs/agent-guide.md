# revoy2 Agent Guide

**Status:** describes the shipped implementation as of 2026-08-02.

This guide documents the 11 botanical agents and the 5 routing categories that
revoy2 ships. The taxonomy is clean-room and revoy2-owned (ADR-001); no
omo-branded names are used.

---

## 1. The 11 botanical agents

All 11 are defined in `packages/arbor-prompts/src/index.ts` (prompts) and
`packages/arbor-opencode/src/agents.ts` (configs). Each is an
`OpencodeAgentConfig` with a mode (primary or subagent), model, permission, and
steps.

| Agent | Mode | Role | Cannot do |
|---|---|---|---|
| **Crown** | primary | Tree driver; selects nodes via UCT, delegates expansion, scores, decides branch/backtrack/halt | Write code; approve |
| **Cambium** | primary | Task conductor; decomposes plans, delegates to specialists, accumulates wisdom | Self-approve; write code directly |
| **Taproot** | primary | Strategic planner; interviews the human, writes plans to `.arbor/plans/` | Write outside `.arbor/` |
| **Heartwood** | subagent | Deep autonomous worker; complex architectural work, deep debugging, cross-domain synthesis | Spawn Seeds |
| **Seed** | subagent | Isolated worktree executor; self-validates before submitting | Delegate; self-approve |
| **Lenticel** | subagent | Critic; approval-biased, runs the Five-Point Critic Mandate | Self-clear |
| **Burl** | subagent | Reasoning consultant (read-only); architecture decisions, hard debugging | Write code |
| **Xylem** | subagent | Gap analyzer; catches what Taproot missed | Write code |
| **Rhizome** | subagent | Codebase search | Modify files |
| **Mycelium** | subagent | External research | Guess; must cite primary sources |
| **Stoma** | subagent | Vision / multimodal; screenshots, UI layouts, diagrams |: |

### Checks and balances

- No agent both proposes and approves an action.
- Specialists (Seed, Heartwood) cannot read `critic_only` KB entries.
- Self-approval is forbidden.
- Crown selects/records but never approves; Lenticel's verdict binds.

---

## 2. The 5 routing categories

Defined in `packages/arbor-opencode/src/categories.ts`. Each category bundles a
`subagent_type` (which botanical agent handles it), a description, and an
advisory `model_hint`. `routeCategory(intent)` is a keyword-based router that
returns `seed-quick` by default.

| Category | Dispatches to | When to use |
|---|---|---|
| `crown-structural` | `burl` (or `crown`) | Architecture decisions, multi-system tradeoffs, design choices |
| `heartwood-deep` | `heartwood` | Goal-oriented autonomous multi-step implementation |
| `seed-quick` | `seed` | Single-file, well-scoped, isolated worktree changes |
| `leaf-visual` | `stoma` | Visual QA, screenshot analysis, UI/UX, diagrams |
| `sap-write` | `taproot` (or `cambium`) | Documentation, plans, reports, prose |

---

## 3. Skills

`packages/arbor-opencode/src/skills/` ships four original skills:

- **`/arbor`**: run a tree-search campaign (Crown orchestrates the loop).
- **`/plan`**: interview the human and produce a reviewed plan (Taproot +
  Xylem + Lenticel/Burl dual review).
- **`/plan-xylem`**: Xylem gap analysis on a draft plan.
- **`/review-loop`**: dual-critic review (Lenticel Five-Point Mandate + Burl
  architectural analysis).

---

## 4. The campaign loop

```text
select → expand (isolation gate) → dispatch specialist (KB-injected)
      → critic review (KB-injected; optional panel)
      → record result → branch | backtrack → halt check
```

- KB injection feeds prior failures into the next specialist's prompt.
- Halt on budget exhaustion, score threshold, or convergence (two iterations
  without new KB entries).
- Interrupted work resumes only through ADR-012 fresh retry authority or becomes
  terminal through its governed abandonment path.

---

## 5. Provenance expectations

Every KB entry carries a provenance type: `!verified` (command/evidence-backed,
the only type that can verify a node), `!claimed` (agent assertion),
`!critic_approved` (critic decision), or `!generated` (deterministic derived
knowledge with `generator` and `input_hash`). Agents must never launder claimed
or critic-approved content into verified content.
