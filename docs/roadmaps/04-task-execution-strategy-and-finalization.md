# Roadmap 04 — Task execution strategy & node-finalization reliability

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: c373ea2b (2026-09-22)
Authority: Retained implementation brief for task execution strategy and finalization; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — task finalization and verified-stop behavior observed at 2348ddbb; multiple-action task semantics remain limited
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Historical implementation brief — sequencing superseded.** The canonical 1.0.0 sequence is [docs/roadmap-1.0.0-and-documentation-governance.md](../roadmap-1.0.0-and-documentation-governance.md); this document's priority and ordering are subordinate to it. The design and evidence history below is retained. Any present-tense gap or future-work statements below describe the brief's authoring-time baseline, not a current status claim.
>
> **Implementation status at `2348ddbb6363f85ae3ddd3aeffec4b07156e5cd8`: implemented for the documented task-finalization and verified-stop behavior.** `packages/arbor-opencode/src/loop.ts`, `packages/arbor-mcp/tests/task-finalization.test.ts`, `packages/arbor-opencode/tests/loop.test.ts`, ADR-046, and handoff `04-task-execution-strategy.md`; commit `066039da`. Multiple-action task semantics remain explicitly limited.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1-§2 and §8
first (invariants, read-list, repo gotchas). This roadmap has an **investigation phase** before
any design — do not skip it; the fix depends on what you find.

**Why this exists (honest framing):** the autonomous blocker-closing loop drove the native
harness to where a single generalist task ("write one doc file") runs end-to-end: it plans,
confirms, executes with tools, the specialist produces its file, and the specialist session
**verifies** (`declared-outputs-check`, exit 0 — confirmed live). But across repeated live runs
the campaign **never finalized a verified node** and `arbor task confirm --wait` **never returned
a populated `campaign_result`**. This roadmap owns closing that gap. It is named here rather than
pretend-closed because it is two intertwined, non-trivial problems, at least one of which needs
real instrumentation to root-cause.

---

## 0. The two problems

### Problem A — a verified specialist + a completed critic do not finalize the node
Observed, repeatedly, in a real campaign (deepseek-v4-pro via OpenRouter):
- The specialist session reaches terminal `verified` (the declared-outputs machine check passes).
- The critic (review) session reaches terminal `completed` (after roadmap-era fixes: the
  in-session structured-output retry stopped it failing `structured_output_invalid`).
- **Yet the audit ledger shows only admission/isolation gate checkpoints — no `node_verification`
  gate and no result trace — and the node stays `expanding`.** So `manager.recordResult(...)`
  (loop.ts, after the critic) is never reaching a durable finalization for the node.

This is the load-bearing unknown. It is **not** a per-session hang (both sessions completed in
~minutes with few turns) and **not** the critic panel size (for a non-high-stakes doc task only
`lenticel` mandates, so it is 1 specialist + 1 critic, not 4). Something between "critic returned
a verdict" and "recordResult persisted a node transition" is being lost — a swallowed error, a
never-resolving `await`, a lost fire-and-forget rejection, or the process being killed in that
window. **You must root-cause this with instrumentation before designing a fix.**

### Problem B — `--wait` blocks on an unbounded tree-search that never surfaces an early result
`arbor task confirm --wait` (see `runCampaignJob` in `runtime.ts` and the campaign runner in
`cli.ts`) awaits the *entire* campaign run to halt. But a campaign is an MCTS tree-search
(`max_iterations: 80`, `convergence_iterations: 2`): it keeps selecting/expanding nodes long
after a perfectly good verified result exists. So `--wait` cannot practically bound it, and there
is no way to get "the first verified, adoptable result" without waiting for the whole search (or
timing out with a null result, which is what happens). For a **generalist "just do this task"**
use case this is the wrong execution shape: a single-action task should execute directly and
stop when it has a verified result — not run an 80-iteration search.

---

## 0.5 Static pre-investigation findings (integrator, 2026-08-12)

Read-only trace of the finalization path, recorded to narrow the live investigation — **not** a
substitute for it. These are what the *code* says; Problem A is a live divergence *from* this
happy path, so instrument as §1 directs and treat the below as the baseline you are proving got
violated.

- **The node-finalization transition exists and is correct in isolation.**
  `recordResult` → `tree.ts:recordCriticResult` sets `node.state = "verified"` when the
  provenance is `verified` (tree.ts:129-130), `"claimed"` otherwise (:132-134). So the durable
  transition the audit ledger was missing in live runs is *reachable and unconditional* on the
  happy path. Problem A is therefore a **divergence from this path** — a swallowed error, an
  `await` that never resolves, a lost fire-and-forget rejection, or a process kill in the
  critic→record window — exactly the four the roadmap already names. Instrumentation still
  required; static analysis cannot see which one.

- **Problem B is real only for multi-node plans; the single-action case already terminates
  cleanly.** Production wires `branch_actions: () => null` (cli.ts:408) — a verified node spawns
  **no** alternative children in production (the branching that motivated "unbounded search" is a
  *demo/test* config artifact). `selectNode` only returns `pending` leaves and "returns null if
  no expandable nodes exist (all verified/failed/pruned)" (tree.ts:8-9, 42, 49). So a plan whose
  only pending node is the root action finalizes in ~1 working iteration + 1 null-select
  termination — **not** an 80-iteration search. The unbounded-search shape manifests when the
  plan's `actions[]` seed *several* pending nodes. **Implication for the Problem B fix:** do not
  add a new termination mechanism for the single-action case (it exists); scope the fix to
  `--wait` returning the *first verified adoptable result* for a multi-node search, and to routing
  a genuinely single-action generalist task down the direct path rather than seeding a tree.

- **The verified artifact is captured but not auto-returned.** On a verified node the loop's
  `finally` calls `result_capture.capture(...)` (loop.ts:1303-1307) to snapshot the worktree diff
  before the lease is released, but adoption into the main tree is a *separate manual* `adopt`
  command. Even once Problem A is fixed, a `campaign.run` that verifies does not by itself land or
  return the artifact. If the generalist "just do this task" UX wants one call to produce an
  adoptable/returned result, that wiring (auto-`bestVerifiedResult` surfaced in `campaign_result`)
  is the third piece — smaller than A and B, but part of "finalize + return".

---

## 1. Phase 1 — investigate Problem A (do this first, read-only + instrumented)

Work in an **isolated worktree off a clean commit** (there may be concurrent uncommitted work in
the main tree — check `git status` and do not build against a dirty tree). Reproduce with a real
provider (config an `arbor.jsonc` with a native OpenRouter model + `ARBOR_NATIVE_API_KEY`; see how
prior live runs were driven, and the doctor command to confirm readiness).

Instrument (temporarily; revert before committing) the loop's critic→record path in
`packages/arbor-opencode/src/loop.ts` around the `manager.recordResult(...)` call (~line 1199)
and the panel path (~line 1102, `config.panel.review(...)`):
- Log immediately before/after `await config.panel.review(...)`, before/after each
  `run_reviewer` call, and before/after `recordResult`. Log any caught error and any branch taken
  (`critic.needs_input`, `critic.error`, the `Promise.all` in `PanelOfCritics.review`).
- Confirm the campaign-run promise's fate: `runCampaignJob` (runtime.ts) does
  `void this.campaignRunner.run(...).then(...)` — a rejection here is easy to lose. Add a
  temporary `.catch` log to see whether `runCampaign` rejected.
- Check whether the process was simply killed by the outer `--wait` timeout mid-iteration (the
  campaign is fire-and-forget under the supervised job; if the CLI process dies, the in-flight
  iteration dies with it). If so, Problem A is really "one node cycle is slower than the operator's
  wait window, and there is no partial-progress surfacing" — which folds into Problem B.

**Deliverable of Phase 1:** a written root-cause in the handoff note. Either "recordResult is not
reached because X (a real bug — fix it)" or "recordResult IS reached but the process is killed
first because the wait window is shorter than one node cycle (→ Problem B is the real fix)". Do
not design further until you can state which.

---

## 2. Phase 2 — Problem B: scale execution strategy to the task

Design goal: a **single-action, low-ambiguity task finalizes a verified result quickly and
`--wait` returns it**, without abandoning the tree-search for genuinely open-ended campaigns.

Two complementary levers (implement per what Phase 1 found; the second is almost certainly needed):

1. **Early-return on a verified adoptable result.** Make the supervised run (or `--wait`
   specifically) resolve as soon as the tree has a `verified` node that satisfies the plan's
   acceptance — not only when the whole search halts. This is a new, explicit stopping condition,
   not a silent change to MCTS: for a task the operator submitted as "do X", "X is done and
   verified" is a legitimate terminal. Surface it through the existing campaign snapshot / best-node
   machinery (`manager.getCampaignSnapshot`, the `best_node_state` the campaign_result already
   reports). Keep the full-search behavior available for genuinely exploratory campaigns (config or
   the plan's `decomposition_depth`/convergence intent should decide which).
2. **A direct (non-search) execution path for a single-action plan.** When the admitted plan is one
   root action with `decomposition_depth: 0`/no children, run one specialist → verify → (critic) →
   finalize, and stop — no selection/expansion loop. This is the frontier-generalist "just do it"
   shape. Compose it through the *same* governed pieces (specialist executor, declared-outputs
   verifier, critic, `recordResult`, adopt capture) — do **not** fork a second execution authority
   (commandment X / the "no second runner" rule; see `handoff.md` and the reference-harness spec).

**Invariants that constrain the design:**
- No second campaign runner / no bypass of admission, isolation, evidence, audit gates.
- A verified early-return is still a real `verified` node with command-evidenced provenance — never
  a shortcut that marks something verified without the machine check.
- `--wait`'s default (non-blocking submit) must stay unchanged; only the `--wait` awaiter learns the
  new early-return signal.

---

## 3. Seams & files

- `packages/arbor-opencode/src/loop.ts` — the campaign loop; `recordResult` call site; the halt-check
  and per-iteration structure; where an early-return stopping condition would live.
- `packages/arbor-opencode/src/critics.ts` — `PanelOfCritics.review` (`Promise.all` over
  `activeReviewers`); already mandate-scaled, so usually 1 critic for a simple task.
- `packages/arbor-mcp/src/runtime.ts` — `runCampaignJob` (the fire-and-forget `campaignRunner.run`),
  `awaitCampaignRun` (what `--wait` awaits). The early-return signal is surfaced here.
- `packages/arbor-mcp/src/cli.ts` — `createProductionCampaignRunner`, `createProductionCampaignLoopConfig`
  (`max_iterations`, `convergence_iterations`), and the `task confirm --wait` handler.
- `packages/arbor-mcp/src/manager.ts` — `recordResult` (node finalization; the `verified` transition at
  ~line 474), `getCampaignSnapshot` (best node / `best_node_state`).
- The adopt path (`result-adoption.ts` + the loop's `result_capture`) already captures a node's
  worktree diff before lease release — a finalized verified node is what makes `arbor adopt --apply`
  land the result. Confirm the capture fires for the early-returned verified node.

## 4. Gotchas
- `--wait` truncation looks like "no result" but may be "not finished" — always distinguish a killed
  process from a genuinely stuck campaign (Phase 1). Check for orphaned processes and the tree mtime.
- Fire-and-forget rejections (`void promise.then(...)`) silently swallow errors — the prime suspect
  for Problem A. Never leave a campaign-run rejection unlogged.
- Do not "fix" Problem A by shortening the search blindly; a verified node must still be genuinely
  verified. And do not make MCTS mandatory-off — exploratory campaigns still want it.
- `npm run build` is the type gate; zero new deps; bun for installs; structural redaction. (roadmap 01 §8.)

## 5. Tests
- A deterministic (fake-provider) campaign with a single-action plan finalizes a `verified` node and
  `--wait` returns a populated `campaign_result` with `best_node_state: "verified"`.
- The early-return stopping condition triggers on the first verified acceptable node and not before.
- The captured adopt result for that node is `verified` (so `arbor adopt --apply` works without
  `--node`).
- Regression: an exploratory/multi-action campaign still runs its search; no second runner exists;
  every gate still fires.
- Full suite green.

## 6. Feature-branch workflow
Same as roadmap 01 §10. Branch `feature/task-execution-strategy`. The handoff note MUST lead with the
Phase-1 root cause (Problem A) — that finding is the most valuable output and determines whether
Problem B's early-return is a nice-to-have or the whole fix. Because this changes a campaign's
terminal/stopping semantics, **write/reconcile an ADR** before spreading the change across packages.
