# Frontier-harness architecture roadmaps

Artifact kind: reference
Status: active
Revision: 1
As-of commit: 73fb8068 (2026-09-22)
Authority: Navigation index for the implementation briefs in this directory; decides no priority or status.
Evidence scope: inferred — index of briefs and handoffs as listed; per-brief status lives in each brief header
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: a brief or handoff is added, closed, or renamed

> **Sequencing superseded (2026-09-22):** this index and the briefs it lists preserve design and implementation history. Their priority order is subordinate to the [Canopy/revoy2 documentation governance and 1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md). Individual briefs remain useful for their local technical scope; verify each status against current code and evidence before treating it as current capability.

Each file here is a **self-contained implementation brief** for one large architectural piece
of the native harness, written so a capable coding agent can implement it alone on a feature
branch, for the integrator (the primary agent) to review and merge.

These are the *large* pieces — the ones too big to close inside the autonomous
blocker-closing loop. Small, closable blockers (specialist convergence, verification,
planner retry, and the currently-open critic-finalization gap) are handled directly in that
loop and are **not** roadmapped here.

## How to use one

1. Start with the [canonical 1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md).
   This index and its briefs are technical history and local design input; they do not set release
   sequencing. Read a selected brief fully, then read the files it lists in its §1.
2. Use the integration base configured for the current checkout; do not assume `master`. Follow
   the repository's current `AGENTS.md` and trunk preflight instructions. Install dependencies in
   each worktree with `bun install` before running package commands, so workspace aliases resolve
   to that worktree's source.
3. Use Bun for verification: `bun run build` is the whole-repository build/type gate;
   `bun run tests:typecheck` covers tests; `bun run test:all` runs the required test lanes.
   When changing tests, include test typechecking. Do not use `npx` to invoke Vitest. Follow the
   current evidence workflow; do not union-merge evidence stores unless their governing contract
   explicitly permits it. **Zero new dependencies** remains the default for these briefs.
4. Write the handoff note the roadmap asks for under `docs/roadmaps/handoffs/`.
5. Hand the branch to the integrator.

If a roadmap requires a new ADR, author it as `ADR-PENDING-<slug>.md` with a
content id; do not choose a number. The integration conductor allocates the
human-facing number from `decisions/registry.json` when the branch lands.
The implementing agent must introduce that ADR as `Proposed`; changing it to
`Accepted` is a later, status-only integrator/operator commit and is never
bundled with authorship or substantive content changes.
An ADR that declares an invariant in its safety case must also add or update a
row in `docs/merge-critical-properties.jsonc`, naming the implementation globs
and the property test that must be rerun after composition.

Every roadmap assumes and requires the twelve invariants in `handoff.md` §2. Roadmap 01 §2 and
§8 spell out the ones you will touch most and the repo-specific gotchas (`tsc --build` only,
zero deps, catalog-drift-in-three-places, structural redaction, stderr-is-not-protocol). The
later roadmaps reference back to those rather than repeating them.

## The roadmaps

| # | Piece | What it adds | Risk |
|---|---|---|---|
| [01](01-mcp-client.md) | **MCP client** | The specialist can call tools from external MCP servers, through the governed native tool path. Biggest ecosystem gain. | Medium — new transport, but a well-scoped adapter over an existing tool seam. |
| [02](02-skills-system.md) | **Governed skills** | Reusable operator-authored capability bundles (instruction + reduced tool set + contract) that specialize a role, only ever *reducing* authority. | Low-medium — the whole safety case is one reduction-property test. |
| [03](03-governed-crash-continuation.md) | **Governed crash continuation (LR-NH-01)** | A long campaign survives interruption and continues under fresh admission, never replaying an indeterminate effect. | **High** — recovery authority; requires an ADR and crash-injection tests. |
| [04](04-task-execution-strategy-and-finalization.md) | **Task execution strategy & node finalization** | Root-cause why a verified specialist + completed critic don't finalize the node, and let a single-action generalist task finalize + return a verified result without an unbounded tree-search. | Medium-high — has an investigation phase; changes campaign terminal semantics (ADR). |
| [05](05-os-backed-sandbox.md) | **OS-backed sandbox (LR-NH-04)** | Real OS-enforced filesystem/process/network confinement so shell/verification/MCP tools run safely instead of being refused for honesty; graded capability reporting, never over-claimed. | **High** — security-critical; possible native-addon question; requires an ADR and adversarial tests. |
| [06](06-governed-hook-and-lifecycle-bus.md) | **Governed hook & lifecycle bus (gap 6)** | Operator-facing pre/post-tool and session-lifecycle hooks as a reduction-only overlay (observe or deny, never grant). The parity matrix's cheapest high-leverage win; the substrate roadmap 11 (commands + plugins) builds on. | Medium — crosses the tool trust boundary, but reuses existing fail-closed seams; safety case is one reduction property (as skills). |
| [07](07-long-horizon-autonomy-and-scheduling.md) | **Long-horizon autonomy & scheduling** | Durable scheduler (once/cron/trigger), plan reuse before re-planning, `human_required` as a durable state; composes with crash-continuation. | Medium — durability-critical; arXiv-sparse, leans on engineering precedent (ADR). |
| [08](08-capability-based-node-routing.md) | **Capability-based node routing** | Wire the existing `NodeCard` into production selection + difficulty-gated expansion depth and cost-aware model choice. UCT stays authority. | Low-medium — mostly wiring a built-but-dormant module; closes a documented Hollow instance. |
| [09](09-cost-and-streaming-observability.md) | **Cost & streaming observability** | Cache-aware per-node cost attribution + a live pluggable cost/context HUD over data revoy2 already computes; feeds branch pruning. | Low — projection over existing exact accounting; verify cache-rate separation first. |
| [10](10-authenticated-remote-worker-transport.md) | **Authenticated remote worker transport (LR-NH-03)** | A real authenticated listener with ephemeral single-operation scoped tokens, `consent_required` state, and local reconcile-not-trust of remote results. | **High** — security-critical trust boundary; implements ADR-040/041 (ADR + hard review). |
| [11](11-user-commands-and-plugin-registry.md) | **User commands & governed plugin registry** | Operator-authored slash/commands (gap 7) and a trust-tiered plugin registry (gap 8), built on roadmap 06's hook bus — reduce-only, provenance-graded trust tiers. | Medium — new authority surface; safety case is the reduction property + tier governance (ADR). |
| [12](12-integration-conductor.md) | **Integration conductor** | Automates the concurrent-integration postmortem's manual rebase→verify→fast-forward loop: conflict-graph + `depends_on` DAG, safe merge order, per-branch isolation gate, decision-id renumbering, store regeneration. | Medium-high — no new trust boundary, but the highest blast radius if ordering/conflict-detection is wrong; refuse-and-ask is the default. |
| [13](13-decision-id-allocation-and-reserved-namespace-registry.md) | **Decision-id allocation & reserved-namespace registry** | Separates decision identity (assigned at authoring) from decision number (assigned once, at landing, from a registry that permanently reserves cross-namespace-cited numbers like 045/086). | Low-medium — repo-hygiene tooling; the reserved-set grep-verification is the real safety case. |
| [14](14-conflict-free-evidence-stores-and-rebase-stable-provenance.md) | **Conflict-free evidence stores & rebase-stable provenance** | Content-hash provenance (not ancestor-SHA) for `.claim-ledger/`/`.determinism-baseline/`/`.completion-depth/`/`.visual-intelligence/observed/`; union-merge for additive stores, never-commit-on-branch for measurement snapshots. | Medium — evidence-store correctness is load-bearing for downstream governance gates. |
| [15](15-derived-governance-counts-and-id-independent-fixtures.md) | **Derived governance counts & id-independent fixtures** | Renders the ADR count `checkCounts` already derives into the three hand-written doc locations at commit time instead of requiring hand-edits; rewrites fixtures that pin live ADR numbers (045/086) to a synthetic out-of-range id. | Low — doc-generation and test-hygiene only, no trust boundary. |
| [16](16-trunk-contract-and-branch-dependency-provenance.md) | **Trunk contract & branch-dependency provenance** | A committed `.arbor/integration.jsonc` declares the real integration base; preflight refuses a fork from a non-trunk base; a required `depends_on` field records branch stacking instead of leaving it for a rebase to discover. | Low — preflight/provenance tooling, no runtime behavior. |
| [17](17-semantic-merge-safety-properties.md) | **Semantic-merge safety properties** | A registry of ADR-declared safety-case properties (e.g. sandbox confinement) mapped to watched file globs and their property test; a merge/rebase touching a watched file must re-run that specific test, legibly attributed to its ADR. | **Medium-high** — closes the sandbox-`read` silent-auto-merge incident; a coverage gap here reproduces the exact danger it exists to close. |
| [18](18-pre-merge-acceptance-authority-gate.md) | **Pre-merge acceptance/authority gate** | A pre-commit gate refusing an ADR whose `Status: Accepted` is bundled into the same commit as its authorship/content — enforces ADR-044's "implementation authority is not acceptance authority" mechanically, reusing the claim-ledger's existing contradiction detector. | Low — pre-commit hook enforcing an already-stated rule; no new trust boundary. |
| [19](19-frontier-protocol-and-harness-alignment.md) | **Frontier protocol & harness alignment (2026-08)** | Amends roadmap 01: MCP's canonical spec moved to `2026-07-28`, which **removes the `initialize` handshake** roadmap 01 tells an agent to build. Plus intent-scoped catalog exposure, ACE/SRLM citation + a context-collapse regression test, an ADR-052 tier-boundary check, and a SWE-bench overestimation note for `arbor-eval`. | Medium — W1 is P0 but adapter-scoped; the rest is documentation, one test, and one derived search index. |
| [20](20-inter-agent-communication-alignment.md) | **Inter-agent communication alignment (2026-08)** | Narrows the governance claim in `frontier-intra-agent-comms.md` to a six-dimension scorecard (revoy2 closes 2 of 6, exceeds on audit/replay, and is Constraint+Proof class); records four **don't-build** decisions with reasons (Zed ACP, AWCP, Git-as-substrate, ERC-8004); adds MAST as the bus failure taxonomy and the delegation-chain constraints to ADR-039/040/041. | Low — **every item is documentation or citation**. Its §0 records the bound: MAST shows protocol standardization does *not* fix inter-agent misalignment, so no build item is warranted here. |
| [21](21-harness-substrate-and-verification-economics.md) | **Harness substrate & verification economics (2026-08)** | A general harness-design sweep (24 papers). Gate outcomes stop being flattened to prose at persist time, so "checked and false" and "could not check" become distinguishable; a closed `check` classification beside provenance's write-only `cmd`; a claim–evidence containment check with a named *Phantom Grounding* test; approval binds to a canonical action fingerprint; `arbor-eval` gains a run manifest, `R4R`/`WDG`, and a false-acceptance rate. | Medium — the first two items are additive and cheap, but they gate a measurement (§W3) whose result may invalidate the roadmap's own priorities, which is the point. Only the conditional W1b needs an ADR. |
| [22](22-operator-ergonomics.md) | **Operator ergonomics (2026-08)** | Wires the parts of revoy2's *already-pinned* `@opentui/core@0.5.1` it does not use — `triggerNotification`, `FOCUS` events, `capabilities`, `waitForThemeMode`, `mock-keys`/`test-recorder` — closing the operator-presence gap outright; adds a `doctor` with **ledger/store reconciliation by named mismatch class**, double-press interrupt, tiered approval memory (the UI half of 21 §W5), and a thresholded budget warning that names its own remedy. | Low-medium — W1/W2 are wiring an existing dependency; W7 is deliberately novel (no frontier reference has it) and W8 carries a scoping constraint. No new trust boundary. |
| [23](23-multi-project-enrollment.md) | **Multi-project enrollment and management** | Extends project profile/conformance and enrollment work toward a governed registry and management across multiple repositories; the brief itself distinguishes existing overlay operations from the absent multi-project registry. | High — cross-repository authority and evidence freshness require explicit governance and fresh acceptance evidence. |

**Gap → roadmap map** (from `harness-parity-matrix.md`; each ❌/🟡 revoy2 gap is covered):
hooks (6) → **06**; user commands (7) + plugins (8) → **11**; OS sandbox (20) → **05**;
loop/cron (25) → **07**; capability routing (13) → **08**; cost/streaming HUD (34) → **09**;
remote ingress (35) → **10**. Roadmaps 05, 07–11 carry a "Prior art & grounded design" section
citing `../research/frontier-gap-literature-2026.md` (arXiv 2025–2026, key papers read in full)
and the competitive-RE brief; roadmap 06 gets that grounding in its §9.

**Roadmap 19 is the standing correction lane for protocol/literature drift.** It carries its own
per-item **evidence-grade table** (§7) rather than a shared prior-art appendix, because its items
differ sharply in evidence quality — some are verified directly against a live specification,
others rest on a single study, and one cited paper is explicitly rejected there so a future reader
does not re-derive it. Its §7 also records *empty* findings, including that revoy2's UCT-over-
campaigns design has no published comparator. Read §7 before treating any item in 19 as settled.

**Roadmap 20 continues that lane for inter-agent communication** and follows the same discipline:
an evidence-grade table (§7), recorded empty findings, and — new in 20 — an explicit **§8 recording
a recommendation that was rejected on verification**, so the next reader does not re-open a
question that came back clean. Both 19 and 20 were produced by dispatched frontier research agents
whose every cited paper was then read in full and whose every specification claim was re-verified
against the primary source before anything was written down; in each case that pass rejected at
least one item the research had proposed. Treat that two-stage shape as the expected process for
future briefs in this lane, not as an unusual precaution.

**Roadmap 21 is the first in the lane to carry build items**, because a general harness-design
sweep (24 papers) found four places where independently-motivated literatures converge on a
structural claim revoy2 does not satisfy. It keeps the lane's discipline (§8 evidence grades, §9 a
rejected recommendation, §10 empty findings) and adds two things worth copying: its **§0 records a
bound that cuts against revoy2's own design rhetoric** — the best available measurement of a
production verification loop puts its isolated contribution at +1.5 pp of an +11 pp uplift, with a
catch rate of ~0.20 — and its §12 deliberately **orders a measurement ahead of every build item**,
because if that measurement comes back badly the roadmap's own priorities are wrong. Its §10
narrows roadmap 19 §7 a third time.

**Concurrent-integration postmortem → roadmap map** (from
`../postmortems/multi-worktree-branch-integration.md` §4/§6; each R-* recommendation is covered):
R-A (trunk contract) → **16**; R-B (decision-id allocation) → **13**; R-C (conflict-free stores) →
**14**; R-D (derived governance counts) → **15**; R-E (integration conductor) → **12**; R-F
(semantic-merge safety) → **17**; R-G (pre-merge acceptance gate) → **18**. R-H (LSP/tooling
discipline) is deliberately not roadmapped — the postmortem treats it as an operator/agent protocol
note, not a build item. Roadmaps 12–18 each carry a "Prior art" read-list pointer to
`../research/concurrent-integration-frontier-brief.md`, cited per-section rather than in one shared
appendix, since each roadmap draws on a different subset of the six research questions.

## Not yet roadmapped (future briefs, lower priority for generalist quality)

These are named in `ROADMAP.md`'s LR-NH-* section with durable dispositions; write a brief in
this same style when one is scheduled:

- **LR-NH-05 — Pluggable encryption at rest / deployment key management.** Only when deployment
  becomes hosted.
- **LR-NH-06 — Layered live-provider evaluation & evidence-driven routing.** Longitudinal live
  evidence before using model/harness routing as a quality claim.

Read `ROADMAP.md`'s "Long-range native-harness security, continuity, and deployment roadmap"
for each item's full disposition and the recommended sequencing before starting one.
