# Roadmap 06 — Governed hook & lifecycle bus (parity gap 6)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: c373ea2b (2026-09-22)
Authority: Retained implementation brief for hook and lifecycle bus; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — reduction-only hook and lifecycle bus observed at 2348ddbb; arbitrary executable hooks are deliberately unsupported
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Historical implementation brief — sequencing superseded.** The canonical 1.0.0 sequence is [docs/roadmap-1.0.0-and-documentation-governance.md](../roadmap-1.0.0-and-documentation-governance.md); this document's priority and ordering are subordinate to it. The design and evidence history below is retained. Any present-tense gap or future-work statements below describe the brief's authoring-time baseline, not a current status claim.
>
> **Implementation status at `2348ddbb6363f85ae3ddd3aeffec4b07156e5cd8`: implemented for the reduction-only hook and lifecycle bus.** `packages/arbor-mcp/src/hooks/`, `packages/arbor-mcp/tests/hooks/`, `harness-session-journal.ts`, ADR-049, and handoff `06-governed-hook-and-lifecycle-bus.md`; commit `3fb9b1fa`. Arbitrary executable hooks remain deliberately unsupported; do not treat that as a missing deliverable.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1–§2 and §8 first
(invariants, read-list, repo gotchas: `tsc --build` only, zero deps, bun installs,
catalog-drift-in-three-places, structural redaction, stderr-is-not-protocol). This roadmap has a
**prior-art phase** before design — the seams it generalizes already exist; do not build a parallel
one.

**Why this exists (honest framing):** the harness parity matrix (`docs/harness-parity-matrix.md`,
category 6) grades revoy2 **❌** on "Hooks & lifecycle injection" — every frontier harness
(Claude Code hooks, Codex pre/post-compact, OpenCode `tool.execute.before/after` + `permission.ask`)
lets operators observe and gate the tool/session lifecycle, and revoy2's native harness has **no
operator-facing pre/post-tool or session event bus**. The matrix's executive read names this the
**cheapest high-leverage win** because it also unlocks user-defined commands (gap 7) and a plugin
surface (gap 8). It is roadmapped rather than closed inline because it crosses the **tool trust
boundary** (ADR-024) and therefore needs an ADR and a reduction-property safety case, exactly like
the skills system (roadmap 02).

## 0. The one thing that makes this revoy2 and not a generic hook system

A hook in a mainstream harness can do anything the process can. In revoy2 a hook is a **governed
overlay** (ADR-038 sense): a disposable projection that may **observe** evidence or **deny** an
action, and can **never grant, escalate, or fabricate** one. The whole safety case is a single
reduction property, stated in §4. If you find yourself letting a hook *add* a tool, *widen* a
write scope, *approve* its own node, or *inject* un-provenanced context, you have left the
revoy2 model — stop and re-read §4.

## 1. Read this first (the seams you generalize — do NOT build parallel ones)

Prior art already carries most of the weight. Read each before designing:

- **`NativeToolPort.preflight(request)`** — `packages/arbor-harness/src/native-worker.ts:181` and its
  call site (~:604). The worker *already* runs a per-port pre-execution admission and **already fails
  closed** on a thrown or invalid result (`tool_preflight_failed`, `invalid_tool_preflight`). This is
  the pre-tool **veto** injection point. A governed hook chain runs here; it does not replace the
  existing admission, it composes *before* it.
- **`NativeApprovalPort.decide(request)`** — `packages/arbor-mcp/src/native-system-policy-approval.ts`.
  The existing high-risk approval seam is a veto that can only deny. A veto-hook is the same shape,
  generalized to any tool, and must reuse this pattern (deny-only, evidence-bearing resolution).
- **`on_audit(record)` + `resolve_intent`** — `packages/arbor-mcp/src/native-tools/contracts.ts:96,104`.
  The post-execution audit callback is the **observe** seam for post-tool hooks. Observe hooks
  subscribe here and to `emitPhase(...)`/ledger transitions (`packages/arbor-opencode/src/loop.ts`)
  for lifecycle events (node/session start/end, verified/failed). Observe hooks are pure sinks — they
  receive already-redacted records and return nothing.
- **ADR-038** (governed context folding & **campaign-local harness overlays**) — the hook set is an
  overlay: bounded, evidence-referenced, disposable, never authority. Mirror its lifecycle.
- **ADR-024/028** (tool-execution enforcement is the host trust boundary; capability enforcement at
  revoy2-owned mutating surfaces) — a veto-hook lives *inside* that boundary and may only tighten it.
- **Roadmap 02 skills + `packages/arbor-mcp/src/skills/catalog.ts`** — copy its shape wholesale: an
  immutable descriptor catalog, a load-time reduction check, a composition-time intersection, one
  property test. A hook descriptor is governed exactly like a skill descriptor.

**Not to be confused with:** ADR-030/032 and `.hook-liveness/` — those are **dev/CI git hooks**
(pre-commit, the claim-ledger refresh) with liveness attestation. Different layer entirely. Your
roadmap's ADR must state this distinction in one sentence so no future reader conflates the runtime
hook bus with the repo's commit-hook attestation. (Reuse the *idea* of persisted invocation history
for hook liveness if useful, but the two stores stay separate.)

## 2. Scope — three hook kinds, one bus

| Kind | Fires at | May do | May never do |
|---|---|---|---|
| `observe` | post-tool `on_audit`, `emitPhase`, ledger transitions | read redacted evidence, emit its own audit line | block, mutate, add context |
| `veto` | pre-tool, composed before `preflight`/`decide` | **deny** a tool call with a logged reason | allow a denied call, widen scope, add a tool |
| `lifecycle` | session/node start+end, plan confirm, interruption | observe; a `veto`-typed lifecycle hook may deny *session start* only | mutate the plan, grant authority |

Deliberately **out of scope** (name them in the ADR as non-goals, do not build): a hook that
**mutates** a tool request or its result (that is a provenance minefield — a mutated request needs
fresh provenance and a fresh approval; defer to a follow-on ADR if ever wanted), and any hook that
runs arbitrary un-sandboxed shell (that waits on roadmap 05's OS sandbox — until then a hook is a
revoy2-owned in-process handler selected from a bounded registry, **not** an operator shell script).

## 3. Design

1. **`HookCatalog`** (mirror `skills/catalog.ts`): immutable, bounded descriptors
   `{hook_id, version, kind, event, handler_ref, why}`. `handler_ref` names a **registered in-process
   handler** (not code-from-disk) — the bounded set of revoy2-owned handlers a deployment enables.
   Filename-identity, descriptor-hash immutability, and a max-descriptor bound, all like skills.
2. **`HookBus`** composed in `cli.ts` alongside `skill_catalog` and `mcp_connector`. It exposes:
   - a **veto chain** injected into the tool path so the effective decision is
     `base_admission AND ⋀(hook.decide)` — intersection only.
   - an **observe fan-out** subscribed to the existing audit/phase/ledger streams.
3. **Evidence:** every hook firing writes a bounded, redacted invocation record to the audit ledger
   (`hook_fired {hook_id, event, decision, evidence_ref}`). A veto that denies is a first-class
   `refused` outcome with the hook as attributed authority. No hook output reaches the model as
   ambient context (Commandment: raw output is evidence, not context).
4. **Bounds & fail-closed:** each hook runs under a timeout and an output-byte cap; a hook that throws,
   times out, or returns an invalid decision **denies** the action (veto) or is **dropped with a
   logged error** (observe) — never silently passes. Reuse the worker's existing preflight fail-closed.
5. **Liveness:** a declared hook that never fires is a governance smell; surface it through the same
   attestation idea as ADR-032 (persisted invocation history), but in the runtime ledger, not
   `.hook-liveness/`.

## 4. The safety case (one property test — this is the whole roadmap)

Prove, as skills does, that a hook can only **reduce**:

- **Reduction at load:** a `veto` hook descriptor whose declared event/scope exceeds what its kind
  permits is rejected at catalog load (`hook_escalation`).
- **Reduction at composition:** for any tool call, `effective_allow ⟹ base_allow` — a hook can flip an
  allow to a deny, never a deny to an allow. Assert with a hook that returns `allow` for a call the
  base policy denied: the call still refuses.
- **Fail-closed:** a hook that throws/times out yields `refused` (veto) — assert it, and assert the
  refusal names the hook and is on the ledger.
- **No authority fabrication:** an `observe` hook that attempts to emit a `verified` provenance or add
  a tool has no path to do so (it returns void; the type makes it unrepresentable). Assert the observe
  handler signature cannot influence the decision.

If those four hold, the bus is safe by construction. Everything else is wiring.

## 5. Wiring (done = wired, not merely built)

- `cli.ts` composition: construct `HookBus.fromDirectory(...)`, add to the lifecycle array, and inject
  its veto chain where `specialist_tools`/approval are composed (near `toolPortsForSession`, cli.ts
  ~:720–:735) and its observe fan-out onto the existing audit/phase sinks.
- `native-tool-host.ts` / `native-worker.ts`: compose the veto chain *before* the existing
  `preflight`; do not fork the fail-closed logic — reuse it.
- Verify with a real campaign (native provider or the fake-port e2e) that a denying hook actually
  refuses a tool live, and an observe hook actually receives records — a hook that is registered but
  never reached is the ADR-032 failure mode this bus must not reproduce.

## 6. What this unlocks (name only — do NOT build here)

- **Gap 7 — user-defined slash/commands:** a command is a named, governed action = a `lifecycle` hook
  plus a palette entry. Once the bus exists, this is a thin follow-on roadmap.
- **Gap 8 — plugin surface:** a plugin is a bundle of {skills, hooks, MCP servers} with one manifest
  and one reduction check. Also a follow-on. Do not scope either into roadmap 06.

## 7. Tests

- The four §4 property assertions (the safety case).
- Catalog: immutability by `(hook_id, version)`, filename identity, descriptor/count bounds, redaction
  of `why`/reasons — copy `skills/catalog.test.ts` structure.
- Error injection: a throwing veto hook → tool `refused`, ledgered, attributed; a throwing observe hook
  → dropped + logged, tool proceeds.
- e2e: a denying hook refuses a real tool call in the loop; an observe hook tallies real audit records.

## 8. Deliverables

- An ADR (next number) — **Governed hook & lifecycle bus is a reduction-only overlay over the tool
  trust boundary.** State the ADR-032 dev-hook distinction, the three non-goals from §2, and the
  reduction property as the ratified invariant. Index it in `decisions/README.md`.
- The implementation, wired and green (`npm run build`; `npx vitest run`; zero new deps; bun installs).
- A handoff note under `docs/roadmaps/handoffs/` per the roadmaps README.

**Risk:** Medium. New operator-facing surface across the trust boundary, but every seam it needs
already exists and fails closed; the safety case is one reduction property already proven once (skills).
The risk is scope-creep into mutation/shell hooks — hold the §2 line.

---

## 9. Prior art & grounded design (arXiv 2025–2026 + competitive RE)

Source: `../research/frontier-gap-literature-2026.md` (Gap 6-cluster). The two papers below were
**read in full**; they validate the reduction-only, deny-not-mutate design above.

- **The veto point is a "stochastic-deterministic boundary" (SDB)** — *Runtime Architecture Patterns*
  (arXiv:2605.20173, read in full). The paper names the seam where an LLM proposal becomes a system
  action as a **four-part contract: proposer, verifier, commit, reject**, and argues it is the
  load-bearing primitive of production agent runtimes. This roadmap's veto chain **is** the verifier;
  the specialist is the proposer; `preflight`/`decide` is commit-or-reject. Two directly-applicable
  results: (1) the paper's catalogued **P4 (Supervisor + Gate)** pattern — deterministic gate refuses
  out-of-policy effects before they reach the world, audit log records, supervisor restarts — is
  exactly the bus's shape, and validates keeping veto decisions *deterministic* rather than
  model-in-the-loop. (2) Its anchor bug (openai-agents-js #1104: a rejected tool call reported as
  `status:"completed"` caused hallucinated success; fix = `status:"incomplete"`) is the same
  finalization failure revoy2 already fixed at the critic boundary — so §3's "a denying veto is a
  first-class `refused` outcome" must return a **typed denial the model can act on**, never a
  silent/false-success signal. It also independently confirms §2's decision to make **mutation a
  non-goal**: the paper's "verifier" checks and rejects, it does not rewrite the proposal.
- **The veto policy should be a symbolic allow/forbid rule with monotonic confinement** — *Progent*
  (arXiv:2504.11703, read in full; **shared with roadmap 05 §7.1**). Progent enforces a symbolic
  policy over the tool name + typed arguments, checked per call (forbid-before-allow, default-deny
  with an agent-feedback message), where the authorized scope can **narrow automatically but only
  expand with approval** (monotonic confinement, a subset check — no SMT dependency needed for
  revoy2's simple scopes). Build this policy engine **once** as a shared module and let both the
  sandbox (roadmap 05) and this hook bus consume it — a veto hook is a generic policy layered above
  the task policy with priority (a managed/system veto cannot be overridden by a user hook, matching
  §2's `handler_ref` managed-vs-user trust). Evidence it works: AgentDojo attack-success 39.9%→1.0%
  with only 6% of updates needing approval.
- **Why deny-only (allowlist), never a denylist** — the execution-security systematization
  (arXiv:2607.05743, abstract-verified) measures **69–98% real-world denylist failure** under
  adversarial retest. The veto chain must *tighten an allowlist*, never pattern-match a blocklist —
  which §0/§4's reduction model already guarantees, but state it in the ADR.
- **Competitive RE (clean-room):** the RE brief's sharpest steal is **Codex's `source`-tagged
  managed-vs-user hook trust** (system/MDM/cloud/`requirements.toml` hooks non-disableable by the
  user) — the governance model §3's `handler_ref` should adopt — combined with **Claude Code's typed
  event set + JSON control channel** (`decision`, `reason`, `hookSpecificOutput.permissionDecision`,
  exit-code-2 = blocking) as the richest event/decision contract to mirror. **OpenCode's
  `tool.execute.before/after` + `permission.ask`** is the confirmation that the `pre_tool` veto +
  `post_tool` observe split is the industry-convergent shape.
- **Follow-ons:** commands (gap 7) and plugins (gap 8) are roadmap **11**, which builds directly on
  this bus and carries the trust-tier governance (arXiv:2602.12430) for the packaged-plugin case.
