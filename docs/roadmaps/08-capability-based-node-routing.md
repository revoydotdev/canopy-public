# Roadmap 08 — Capability-based node routing (wire NodeCard into selection + difficulty gating)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: c373ea2b (2026-09-22)
Authority: Retained implementation brief for capability-based node routing; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — deterministic difficulty routing observed at 2348ddbb; learned/remote routing and model-invokable role switching are not implemented
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Historical implementation brief — sequencing superseded.** The canonical 1.0.0 sequence is [docs/roadmap-1.0.0-and-documentation-governance.md](../roadmap-1.0.0-and-documentation-governance.md); this document's priority and ordering are subordinate to it. The design and evidence history below is retained. Any present-tense gap or future-work statements below describe the brief's authoring-time baseline, not a current status claim.
>
> **Implementation status at `2348ddbb6363f85ae3ddd3aeffec4b07156e5cd8`: partially implemented; deterministic difficulty routing is present.** `packages/arbor-mcp/src/routing/`, `packages/arbor-mcp/tests/routing/difficulty-routing.test.ts`, `packages/arbor-opencode/src/loop.ts`, `packages/arbor-core/src/agent-taxonomy.ts`, ADR-050, and handoff `08-capability-based-node-routing.md`; commit `f20255d6`. Learned/remote routing and model-invokable role switching are not implemented.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1-§2 and §8 first.

**Gap closed (parity matrix):** category **13 (foreground switching / capability routing, 🟡)**.
revoy2 already *has* `NodeCard` (a capability-addressable module with derive/sign/verify/
`cardsForCapability`/`select`) and `selectNodeWithCard`, but the **production loop still uses the
baseline UCT `selectNode` path** — capability routing is built and unwired (visual-intelligence has
flagged `selectNodeWithCard`'s capability branch as satisfied only by demo/tests). This is
**mostly a wiring roadmap**, plus one genuinely new capability (difficulty-gated expansion/model
selection).

---

## 0. What "done" means (acceptance)

1. `NodeCard`-based capability routing is **wired into the production selection path**: a campaign
   built by `createProductionCampaignRunner` populates `task_skills`/card capabilities and
   `selectNodeWithCard` is the live selector — closing the exact Hollow instance the
   visual-intelligence skill documents.
2. A **calibrated difficulty estimate** `d ∈ (0,1)` is produced per node/task and **gates expansion
   depth and model selection** (DAAO — §7): easy nodes get shallow expansion + a cheap model; hard
   nodes get deeper expansion + a more capable model. `L = max(1, ⌈d · L_max⌉)`-style depth
   adaptation, integrated with roadmap 04's node-expansion policy.
3. Routing decisions are **cost-aware**: model selection conditions on price/latency/observed
   performance descriptors, with an explicit cost term (Router-R1 — §7); UCT remains the authority
   on *which* node, the card/difficulty refine *how* (model, depth). (`selectNodeWithCard` already
   documents "on mismatch, UCT wins" — preserve that.)
4. The difficulty estimate is **self-adjusting from ledger evidence**: observed node
   success/failure updates the estimate (DAAO's success-signal feedback), witnessed by the ledger.
5. **Model-invokable role switching** (optional, gated): a specialist may *request* a capability/
   role change mid-node via a governed tool, subject to the same reduce-only authority rule as
   skills (Zoo Code's `switch_mode`, hardened — §7). The request is a proposal the gate authorizes,
   never a self-granted escalation.
6. Wired + tested: the production runner routes through cards; a hard node selects a deeper/stronger
   configuration than an easy one; UCT still wins on mismatch; difficulty self-adjusts; full suite
   green.

Non-goals (v1): a trained RL router (bootstrap from simple descriptors + a lightweight difficulty
head; design the seam for a learned policy later); routing across *remote* workers (roadmap 10).

---

## 1. The invariant that dominates this design

**UCT remains the authority; routing refines, never overrides.** The card/difficulty layer decides
*how* a node is expanded (model, depth, breadth), not *whether* the search visits it — that stays
UCT. The worst outcome is a routing heuristic that silently starves the search of a
correct-but-low-card branch. Every routing decision is evidence-logged and reversible; a routing
signal never retires or hides a node. And **routing infrastructure only pays off with a capable
consumer** (MMA2A's negative result, §7) — this roadmap wires routing into revoy2's *existing*
capable tree-search, which is exactly the consumer that makes it worthwhile.

## 2. Where it plugs in
- `packages/arbor-core/src/node-card.ts` — the existing capability module (derive/sign/verify/
  select). It is production-quality and unwired; this roadmap connects it, it does not rebuild it.
- `packages/arbor-opencode/src/loop.ts` — `manager.selectNode` vs `selectNodeWithCard` (the live
  selector switch); the node-expansion policy is where difficulty gates depth.
- `packages/arbor-mcp/src/cli.ts` — `createProductionCampaignRunner` currently builds config from
  `DEFAULT_LOOP_CONFIG` and never sets `task_skills`, so card routing is reachable but dormant.
  Populate the card set here — this is the single most important wiring change.
- `packages/arbor-opencode/src/categories.ts` + `arbor-config` native-provider — per-role/per-model
  routing already exists; difficulty selects among the configured models.
- `packages/arbor-audit/*` — difficulty estimates and routing decisions are ledger evidence; the
  self-adjust loop reads observed outcomes back from the ledger.

## 3. Suggested structure
```
packages/arbor-mcp/src/routing/
  difficulty.ts      # calibrated d in (0,1) from task/node features; self-adjust from ledger
  routing-policy.ts  # d -> (expansion depth, breadth, model tier); cost-aware model choice
  switch-capability.ts # optional governed model-invokable role/capability request (reduce-only)
```
Plus the wiring in `cli.ts`/`loop.ts` (small, high-leverage).

## 4. Gotchas
- **The wiring is the deliverable, not more modules.** `NodeCard` exists; the failure has been that
  production never populates cards. Prove with an integration test through
  `createProductionCampaignRunner` that the card path is live under `arbor run --executor real`.
- **Difficulty must be calibrated, not a raw score** (DAAO calibrates `p̂_succ = 1 − d` against
  observed outcomes) — an uncalibrated "difficulty" that doesn't predict success is worse than none.
- **A model-invokable switch is an authority request** — route it through the same gate/reduction as
  skills; never let the model widen its own tool/capability set.
- **Zero new runtime deps**; a lightweight difficulty head is a small bounded function, not an ML dep.

## 5. Tests
- Production runner routes through `selectNodeWithCard` (integration, not demo) — the Hollow
  instance is closed.
- A hard task selects deeper expansion + a stronger model than an easy task; UCT still wins on a
  documented mismatch case.
- Difficulty self-adjusts: after recorded failures on a task class, its estimate rises.
- A model-invokable capability request that would expand authority is rejected (reduction property).
- Full suite green.

## 6. Feature-branch workflow
Same as roadmap 01 §10. Branch `feature/capability-routing`. An ADR is warranted only for the
difficulty-gated expansion (it changes node-expansion semantics); the NodeCard wiring itself is a
bugfix-shaped change closing a documented Hollow instance and can cite the visual-intelligence
finding directly.

---

## 7. Prior art & grounded design (arXiv 2025–2026 + competitive RE)

Source: `frontier-gap-literature-2026.md` Gap 13. DAAO was **read in full**; Router-R1 and MMA2A are
abstract-verified.

### 7.1 Difficulty-gated orchestration — DAAO (arXiv:2509.11079, read in full)
DAAO is the concrete design for difficulty-gated expansion:
- A **query difficulty estimator** (a VAE encoding the task to a latent `z`, decoding a **calibrated
  scalar `d ∈ (0,1)`** via an MLP) is trained with a difficulty-guided objective — BCE aligning the
  decoded success probability `p̂_succ = 1 − d` with the **observed outcome** (solved/not) plus a KL
  regularizer. revoy2 can bootstrap a far simpler calibrated head (task features → `d`), calibrated
  against its own ledger outcomes — no VAE required, no ML dependency.
- **Depth adaptation:** `L = max(1, ⌈d · L_max⌉)` — easy queries yield shallow graphs, hard ones
  trigger deeper chains (Figure 2: `d=0.2`→1 layer, `d=0.5`→3 layers, `d=0.7`→4 layers + ensemble).
  Map `L` onto revoy2's tree-search expansion budget per node — this is the missing *adaptive* half
  of roadmap 04's node-expansion policy.
- **Cost-aware model routing:** per-operator, route to a model by contextual compatibility
  (query+difficulty+operator), preferring cheaper models when sufficient. Measured: +3.5–15.2%
  accuracy at **10.4% of the baseline training cost / 41% inference cost**. The **success signal
  updates the difficulty estimate** (self-adjusting) — a loop revoy2's ledger already supports.

### 7.2 Route as a cost-aware decision, generalize via descriptors — Router-R1 (arXiv:2506.09033, abstract-verified)
Router-R1 models routing as a **multi-round decision with an explicit cost reward**, conditioning
only on **simple descriptors (price, latency, example performance)** — which lets it generalize to
*unseen* models. For revoy2's growing model roster this is the cheap bootstrap: route on descriptors
revoy2 already tracks (its "money/tokens exact" accounting gives real price/latency), with an
explicit cost term in the routing objective, rather than a bespoke per-model classifier.

### 7.3 The negative result that sizes the effort — MMA2A (arXiv:2604.12213, abstract-verified)
MMA2A routes by **capability declaration (Agent Card)** and gains +20pp — **but its ablation shows
routing-alone gains are zero unless the downstream consumer can exploit the routed capability.**
This is the governing caution: **do not over-build routing ahead of a capable consumer.** revoy2's
justification for investing here is precisely that it *already has* the capable consumer (UCT
tree-search + verifier + NodeCard) — the work is wiring routing into it, not inventing routing for a
consumer that can't use it.

### 7.4 Competitive RE — model-invokable switching is the sharpest steal
The RE brief's top finding for this gap: **Zoo Code's `switch_mode` is a first-class
*model-invokable* tool** — the agent itself requests a capability/role change mid-task, rather than
the orchestrator pre-declaring it. This is exactly the interaction revoy2's NodeCard system is
missing at the UX level. Adopt it **governed**: the request is a proposal that roadmap 06's veto
gate authorizes, bound by the reduce-only rule. Claude Code's subagent frontmatter (`model`,
`tools`, `permissionMode`, `isolation`) is the declarative counterpart for *pre-declared* routing;
revoy2's role profiles already cover that half.
