# Roadmap 09 — Cost & streaming observability (per-node cost attribution + live HUD)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 3498984f (2026-09-22)
Authority: Retained implementation brief for cost and streaming observability; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — cache-aware cost attribution and ledger-derived HUD observed at 2348ddbb; live-campaign HUD acceptance not established
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22).** The [1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md) governs release order and priority; this file is a retained implementation brief, not an active queue. Its handoff is [here](handoffs/09-cost-and-streaming-observability.md).
>
> **Status checked at `2348ddbb` (2026-09-22): partially evidenced.** Tracked code and tests cover cache-aware attribution and the ledger-derived HUD/status-line projection. This review did not establish the brief's live-campaign HUD acceptance criterion; see the [handoff](handoffs/09-cost-and-streaming-observability.md) for the historical verification claim.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1-§2 and §8 first.

**Gap closed (parity matrix):** category **34 (streaming + cost/token display, 🟡)**. revoy2 already
tracks token/dollar cost *exactly* (the "money/tokens exact" commandment) and streams via devtools,
but there is **no live cost/context HUD** and **no per-node cost attribution** — the data is
computed but not surfaced for at-a-glance operation or used to prune expensive branches.

**Honest scoping note (`frontier-gap-literature-2026.md` Gap 34).** Cost *systems* research is well
evidenced; cost *display as UX* is arXiv-sparse and lives in vendor product docs (Langfuse,
Helicone, usage APIs). So this roadmap takes its accounting rigor from one ingested paper
(ClawTrace) and its HUD shape from competitive RE (OpenCode `statusLine`).

---

## 0. What "done" means (acceptance)

1. **Cache-aware, four-rate cost accounting.** Every cost figure bills `input`, `output`,
   `cache_read`, and `cache_write` tokens **separately** at their real rates — never counting cache
   reads at the fresh-input rate (ClawTrace measured that overstates true cost **1.6–2.0×** and
   distorts every cost ranking). Verify revoy2's existing accounting already separates these; if it
   folds cache reads into input, that is a latent correctness bug this roadmap fixes first.
2. **Per-node cost attribution** is a first-class trace field (not derived post-hoc): each node
   carries its cost-attributed record — total cost, `top_cost_spans`, and a
   `redundant_tool_calls` signal — so an operator (and the search) can see *where* budget went.
3. **A live HUD** surfaces, per session/campaign: running dollar cost, context-window usage
   (used/total + %), and the current phase — updated at each assistant message (not necessarily
   mid-token). It is a **pluggable renderer over data revoy2 already computes**, not a bespoke
   subsystem (OpenCode `statusLine` pattern — §7).
4. **The cost signal feeds tree-search pruning.** Per-node cost attribution lets the loop
   distinguish "a node that produced verified progress" from "a node that was merely expensive and
   changed nothing" — the same distinction ClawTrace uses for skill pruning — and factor it into
   expansion/pruning decisions (composes with roadmap 08's difficulty gating and roadmap 04's
   node-expansion policy).
5. **Cost is presented as directional, never over-claimed** (arXiv:2605.11733): list-price $/token
   is a directional signal, not authoritative billing — the HUD labels it as an estimate, matching
   how Claude Code's `/usage` explicitly disclaims list-rate figures.
6. Wired + tested: the HUD renders live during a real campaign; per-node cost records are emitted;
   cache-aware billing is verified against a known-rate fixture; a redundant-tool-call cluster is
   detected; full suite green.

Non-goals (v1): a mid-token streaming TPS counter (per-message granularity is enough, and matches
OpenCode/Claude Code); billing-grade cost (list-rate estimate, clearly labeled).

---

## 1. The invariant that dominates this design
**The HUD is a projection, never authority** (ADR-017/021: telemetry is a ledger-derived
projection). The cost/context HUD re-derives from the durable ledger's exact accounting; it never
becomes a second source of truth. And it **never over-claims precision** — a list-rate estimate is
labeled as such. Cost attribution that drives pruning is evidence-logged, and a high-cost node is
never *hidden* by cost alone (UCT + verification remain the authority on what the search keeps).

## 2. Where it plugs in
- The existing exact token/cost accounting (the "money/tokens exact" surface — find it via
  `token-economy.ts` / usage reporting) is the **data source**; this roadmap surfaces and attributes
  it, and fixes it if cache rates are conflated.
- `packages/arbor-opencode/src/loop.ts` — per-node cost record emitted at node finalization
  (alongside the roadmap-04 result record).
- `packages/arbor-tui/*` + `arbor-mcp/src/cli.ts devtools` — the HUD renderer; and a `statusLine`-
  style hook (roadmap 06 event bus) fed live session-state JSON so the HUD is pluggable.
- `packages/arbor-audit/*` — cost records are ledger-derived projections, not new authority.

## 3. Suggested structure
```
packages/arbor-mcp/src/cost/
  cost-record.ts     # per-node cache-aware 4-rate record; top_cost_spans; redundant-call detector
  hud-projection.ts  # ledger-derived live projection: $ cost, context used/total, phase
  statusline.ts      # pluggable renderer seam (shell command fed session-state JSON), roadmap 06 hook
```

## 4. Gotchas
- **Verify cache-rate separation first** — if the current accounting bills cache reads at the input
  rate, every existing cost figure is inflated 1.6–2.0×; fix before building the HUD on top of it.
- **The HUD must not become authority** — re-derive from the ledger each render; a HUD that holds
  its own running total will drift (stale-marker wedge, `handoff.md` §2).
- **Redundant-call detection is a heuristic** — flag, do not auto-block; a real retry may look
  redundant. Surface it; let the operator/search decide.
- **Zero new runtime deps**; the HUD is terminal rendering over existing data.

## 5. Tests
- Cache-aware billing: a fixture with known input/output/cache_read/cache_write rates produces the
  correct total; folding cache into input is caught.
- Per-node cost record emitted at finalization; `top_cost_spans` ranks by true (cache-aware) cost.
- Redundant-tool-call cluster (≥2 near-identical calls) is flagged.
- HUD projection re-derives from the ledger (no independent running total) and renders live in an
  integration test.
- Full suite green.

## 6. Feature-branch workflow
Same as roadmap 01 §10. Branch `feature/cost-observability`. An ADR is warranted only if per-node
cost begins to *drive* pruning (it changes search semantics); the HUD + attribution alone are a
projection over existing data and cite ADR-017.

---

## 7. Prior art & grounded design (arXiv 2025–2026 + competitive RE)

Source: `frontier-gap-literature-2026.md` Gap 34. ClawTrace was **read in full**; the pool-routing
and cost-metric-critique papers are abstract-verified.

### 7.1 Cache-aware per-step cost attribution — ClawTrace (arXiv:2604.23853, read in full)
ClawTrace instruments **8 lifecycle event hooks** and compiles each session into a compact
**TraceCard** (1.2–1.8 KB YAML), deterministically from the span tree. The transferable design:
- **Bill four token rates separately** — `input`, `output`, `cache_read`, `cache_write`. Providers
  price cache reads at 30–50% of the fresh-input rate; counting them at the fresh rate **overstates
  true cost 1.6–2.0×** on a typical run and *distorts the per-step cost ranking* everything
  downstream depends on. This is the single most important correctness detail for revoy2's cost
  surface — verify it holds today.
- **TraceCard schema** (adapt to a per-node record): `total_cost_usd` (cache-aware),
  `total_tokens` (4-way), `top_cost_spans` (top-N by cost, each with kind/role_hint/tokens),
  `redundant_tool_calls` (clusters of ≥2 calls with normalized Levenshtein ≥0.8 — flagged),
  `sub_agents` (per-child cost + **`output_used_in_final`** via Jaccard: how much of a delegated
  sub-agent's output actually reached the final answer — a direct "was this delegation worth its
  cost?" signal, relevant to revoy2's subagent executor).
- **The load-bearing distinction:** per-step cost lets you tell "the step that fixed a bug" from
  "the step that was merely expensive and never mattered." revoy2's tree-search can use exactly this
  to prune expensive-but-unproductive branches — the same signal, applied to nodes instead of skill
  rules.

### 7.2 Budget *before* spend, and don't trust list price — pool routing & the cost-metric critique (abstract-verified)
- **Token-Budget-Aware Pool Routing (arXiv:2604.09613):** estimate a request's token budget *before*
  serving it (a self-calibrating per-category bytes-per-token EMA, tokenizer-free) — 17–39% savings.
  Pairs with roadmap 08: set a per-node token budget from the difficulty estimate before expanding.
- **Energy-to-Token critique (arXiv:2605.11733):** list-price $/token is **not** reliable evidence
  of marginal cost. Consequence for the HUD: present cost as a labeled directional estimate, never
  as authoritative billing — the same disclaimer Claude Code's `/usage` carries.

### 7.3 Competitive RE — the HUD is a pluggable renderer, not a widget
The RE brief's sharpest steal: **OpenCode's `statusLine`** — an external shell command fed live
session-state JSON on stdin, rendered into the status bar (Claude-Code-style). This is the cheapest,
most composable HUD mechanism: expose revoy2's already-computed cost/context data through a
`statusLine`-shaped hook (roadmap 06 event bus) and let the renderer be pluggable, rather than
building a bespoke UI component. Claude Code's `/usage` (per-model input/output/cache-read/
cache-write breakdown, list-rate, explicitly non-authoritative) is the reference for *what* to show;
OpenCode's footer (`"1.2K (12%)"` context + running session cost, updated per message) is the
reference for *how much* — per-message granularity, not mid-token.

### 7.4 Named production budget risks

The 63-incident catalog in [arXiv:2606.04056](https://arxiv.org/abs/2606.04056) adds two explicit
risks. A future delegated child-budget slice must be single-consumption—never duplicated across
fanout or reused after delegation. Also, reasoning-model billing may include hidden tokens outside
the client's `max_output_tokens`; preflight limits are not billing evidence. ADR-051 owns the
guarantee map and ADR-015 owns the model-aware accounting caveat.
