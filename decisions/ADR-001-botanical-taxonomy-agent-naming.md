# ADR-001: Botanical Taxonomy Agent Naming

**Status:** Accepted
**Date:** 2026-07-31

## Context

The project synthesizes two architectures: the Arbor paper's tree-search-as-cognition (arXiv 2606.12563v1) and revoy-spec's governance model. The agent pantheon must avoid naming conflicts with any existing system, particularly oh-my-openagent (omo), which uses Greek mythology names under the SUL-1.0 proprietary license.

The 11 agents map to three functional roles from the Arbor paper (orchestrator, specialist, critic) plus revoy-spec's governance tiers (planner, gap-analyzer, auditor). Each name must be: (a) etymologically independent from omo's pantheon, (b) thematically coherent, (c) not a trademarked term.

## Decision

Use a **botanical taxonomy** — every agent is named after a tree anatomy structure. The "arbor" (Latin: tree) theme provides natural metaphors for the hierarchy: the crown drives, the heartwood does deep work, the taproot plans, seeds execute.

| Agent | Tree structure | Role |
|-------|---------------|------|
| Crown | Tree crown | Orchestrator / tree driver |
| Heartwood | Dense inner wood | Deep autonomous worker |
| Taproot | Central root | Strategic planner |
| Cambium | Growth layer | Execution conductor |
| Burl | Tree knot | Reasoning consultant |
| Mycelium | Fungal network | External research |
| Rhizome | Spreading root | Codebase search |
| Stoma | Leaf pore | Vision / multimodal |
| Xylem | Water-transport tissue | Gap analyzer |
| Lenticel | Bark pore | Critic |
| Seed | Embryonic plant | Isolated task executor |

## Consequences

**Positive:** Zero etymological overlap with omo's Greek mythology (Sisyphus, Hephaestus, Prometheus, Atlas, Oracle, etc.). Zero trademark risk — all are generic anatomy terms. The tree metaphor reinforces the project's identity (tree search over an action tree).

**Negative:** Less familiar than mythological names. A new contributor needs to learn the mapping.

**Neutral:** The botanical theme is internally consistent but carries no technical meaning — the names are labels, not specifications.

## Alternatives Considered

1. **Generic functional names** (Orchestrator, Worker, Critic, Planner). Rejected: too generic to distinguish from every other multi-agent system, and "Critic" / "Orchestrator" are overloaded terms in the ML literature.

2. **Reuse omo's Greek mythology names.** Rejected: SUL-1.0 license contamination. Even if the names themselves aren't copyrightable, using them creates an association that weakens the clean-room posture.

3. **Arbor paper's role names** (Orchestrator, Specialist, Critic). Rejected: too generic and used as field terminology, not product names.

4. **Custom coined names** (e.g., "Vanguard", "Sentinel"). Rejected: invented names feel artificial and lack the thematic coherence of a real taxonomy.

## Obligations

### O1 — The agent pantheon is a closed set of exactly 11 botanically-named agents

<!-- proof: symbol=ArborAgentName file=packages/arbor-core/src/agent-taxonomy.ts roundtrip=packages/arbor-opencode/tests/agent-bindings.test.ts -->

### O2 — No agent name overlaps with an existing mythological or trademarked pantheon (etymological independence)

<!-- unverifiable: a naming/license claim about the real world (no overlap with omo's Greek-mythology pantheon, not a trademarked term) — no exported symbol in packages/*/src can adjudicate real-world naming or trademark independence. -->

This is a naming/license claim about the real world, not a runtime behavior — nothing in `packages/*/src` can machine-verify "no overlap with omo's Greek pantheon" or "not a trademarked term." No proof attached.

### O3 — No agent both proposes and approves an action (checks-and-balances is structurally enforced, not a convention)

<!-- proof: symbol=permissionsFor file=packages/arbor-opencode/src/permissions.ts roundtrip=packages/arbor-opencode/tests/agent-bindings.test.ts -->

### O4 — Seed (the isolated task executor) cannot delegate to or spawn other agents

<!-- proof: symbol=permissionsFor file=packages/arbor-opencode/src/permissions.ts roundtrip=packages/arbor-opencode/tests/agent-bindings.test.ts -->
