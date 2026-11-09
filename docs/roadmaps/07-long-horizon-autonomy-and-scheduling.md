# Roadmap 07 — Long-horizon autonomy & scheduling

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: c373ea2b (2026-09-22)
Authority: Retained implementation brief for long-horizon autonomy and scheduling; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — durable host-driven trigger and supervised run observed at 2348ddbb; resident daemon, distributed scheduling and remote delivery are target
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Historical implementation brief — sequencing superseded.** The canonical 1.0.0 sequence is [docs/roadmap-1.0.0-and-documentation-governance.md](../roadmap-1.0.0-and-documentation-governance.md); this document's priority and ordering are subordinate to it. The design and evidence history below is retained. Any present-tense gap or future-work statements below describe the brief's authoring-time baseline, not a current status claim.
>
> **Implementation status at `2348ddbb6363f85ae3ddd3aeffec4b07156e5cd8`: partially implemented; durable trigger and supervised-run path are present.** `packages/arbor-mcp/src/scheduler/`, `packages/arbor-mcp/tests/scheduler/`, `job-scheduler.test.ts`, ADR-047, and handoff `07-long-horizon-autonomy-and-scheduling.md`; commit `2aabae3a`. Host-driven tick/trigger is implemented; resident daemon, distributed scheduling, and remote delivery remain unavailable/proposed.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1-§2 and §8 first.

**Gap closed (parity matrix):** category **25 (loop / cron / scheduled / long-horizon autonomy,
❌)**. Today a campaign is bounded only by `max_iterations`/`max_seconds`; there is no way to
schedule a recurring or deferred run, to survive across a long process lifetime with pauses/
resumes, or to reuse prior planning work instead of re-searching from scratch.

**Honest scoping note (read `frontier-gap-literature-2026.md` Gap 25).** This is the **sparsest gap
on arXiv** — there is essentially no research on an agent deciding *when* to wake and run itself.
So this roadmap leans on **engineering precedent** (cron / systemd timers / Temporal.io /
durable-execution semantics) and on the *one* directly-applicable runtime-architecture result
(2605.20173, read in full), with the memory/reuse literature supplying the efficiency layer.

---

## 0. What "done" means (acceptance)

1. A **durable scheduler** can register a campaign to run: (a) once at a future time, (b) on a
   recurring cron-like cadence, or (c) on an external trigger (a file/webhook/queue signal). The
   schedule is durable — it survives a process restart and is a ledger-witnessed fact, not
   in-memory state.
2. A scheduled run is an **Autonomous-class runtime** (2605.20173 §2.1): triggered, runs unattended,
   and a **durable queue holds state between runs** — never an in-memory timer that dies with the
   process.
3. **Durable session/campaign identity** is the primitive: a long-horizon campaign can pause, be
   evicted, and resume under fresh admission by id (composes with roadmap 03's governed
   continuation — a resumed scheduled run reconciles effects, never blindly replays).
4. **Plan reuse before re-planning**: before launching a fresh tree-search, the scheduler checks
   whether a *similar* task (by intent-classified template) has a cached verified plan; if so it
   reuses the plan structure with fresh parameters and skips planning. (AgentReuse — see §7.)
5. **Bounded reasoning depth per run**: a long-horizon run checkpoints and bounds reasoning depth
   rather than assuming unlimited context solves the task (LongCoT — see §7); it reuses roadmap 04's
   node-finalization + checkpoint machinery.
6. **`human_required` is a first-class durable state, not a missing event** (2605.20173 P5): a
   scheduled run that needs input suspends to a durable row a human reviews later, and resumes — it
   does not silently fail or block a worker forever.
7. Everything is wired: a real recurring campaign fires on cadence, produces an adoptable result,
   and its schedule + runs are auditable. Tests cover fire-on-cadence, restart-survival, missed-run
   catch-up policy, plan-reuse hit/miss, and `human_required` suspend/resume.

Non-goals (v1): a distributed multi-node scheduler (single-writer per persistence dir — ADR-029;
remote is roadmap 10); RL-learned scheduling; predicting *what* to run (the operator/trigger
supplies the task).

---

## 1. The invariant that dominates this design

**Durability over liveness.** A schedule, a paused campaign, and a `human_required` suspension are
all *durable ledger facts*, never in-memory state that a crash erases. The worst outcome is a
"scheduled" run that silently stops existing when the process restarts — the same false-confidence
class the LR-NH series exists to prevent. Every scheduler decision (fire, skip, catch-up, suspend,
resume) is an audited transition; a resumed run reconciles effects through roadmap 03's classifier.

## 2. Where it plugs in
- `packages/arbor-opencode/src/loop.ts` — the campaign is the unit a schedule launches; the loop's
  budget/halt model is the per-run bound. A scheduled run enters through the same `campaign.run`
  supervised-job path (ADR-026), not a side channel.
- `packages/arbor-mcp/src/recovery/*` (roadmap 03) — pause/resume/continuation is already governed;
  the scheduler is a *producer* of resume events, reusing that machinery rather than duplicating it.
- `packages/arbor-mcp/src/manager.ts` + the KB (`arbor-kb`) — the plan-reuse cache is a KB-backed,
  intent-keyed store of verified structured plans; the scheduler registry is a durable store under
  the single-writer persistence dir (ADR-029).
- `packages/arbor-audit/*` — schedule registration and every run are ledger facts.

## 3. Suggested structure
```
packages/arbor-mcp/src/scheduler/
  contracts.ts        # closed trigger enum (once|cron|external), schedule record, run record
  schedule-store.ts   # durable registry (single-writer dir); survives restart; catch-up policy
  scheduler.ts        # evaluates due schedules, launches campaign.run, records runs
  plan-reuse.ts       # intent-template cache: E(q^-) + params; similarity>=gamma -> reuse structure
  trigger-external.ts # file/webhook/queue trigger adapter (guarded; loopback-first, see roadmap 10)
```

## 4. Gotchas
- **A missed run needs an explicit catch-up policy** (fire-once-on-return vs skip vs backfill-all) —
  choose and record it; a silent skip is a correctness bug for a scheduled audit/report task.
- **Do not build an in-process `setInterval` scheduler** — it dies with the process and violates §1.
  The store is the source of truth; the evaluator is stateless and re-derives due runs on start.
- **Plan reuse must re-verify.** A reused plan is `claimed`, not `verified`, until this run's
  verifier passes — never inherit the cached run's verified provenance (that would be a stale-marker
  wedge; `handoff.md` §2).
- **Zero new runtime deps**; cron parsing is a small bounded parser, not a dependency.

## 5. Tests
- Fires on cadence; survives a simulated restart (schedule reloaded from the durable store).
- Missed-run catch-up policy behaves as declared.
- Plan-reuse: a similar task hits the cache and skips planning; a dissimilar one misses and plans;
  a reused plan is re-verified (not inheriting stale `verified`).
- `human_required` suspends to a durable row and resumes; a resumed run reconciles effects (roadmap
  03) rather than replaying.
- Full suite green.

## 6. Feature-branch workflow
Same as roadmap 01 §10. Branch `feature/long-horizon-scheduling`. **Write an ADR** — a scheduler
changes campaign lifecycle semantics (unattended runs, durable suspension); relate it to ADR-026
(supervised job), ADR-029 (single writer), and roadmap 03 (continuation).

---

## 7. Prior art & grounded design (arXiv 2025–2026 + competitive RE)

Source: `frontier-gap-literature-2026.md` Gap 25. The design-driver paper (2605.20173) and the
efficiency paper (2512.21309) were **read in full**; the depth-bounding and memory results are
abstract-verified.

### 7.1 The runtime classes name exactly what to build — Runtime Patterns (arXiv:2605.20173, read in full)
The paper's three runtime classes are the design frame:
- **Autonomous** — "the unit of work is a task; something triggers the agent (a webhook, a scheduled
  run, a queued message); duration is minutes; the agent runs unattended; **a queue holds state
  between runs**." This is *precisely* the cron/scheduled gap, and the paper's prescription — a
  durable queue, not an in-memory timer — is acceptance criterion §0.2.
- **Long-Horizon** — "the unit of work is a process; duration hours-to-days; the process pauses,
  resumes, and **tolerates restarts**; the world changes mid-flight." This is the paused-campaign
  case; the prescription is durable session identity (§0.3), which composes with roadmap 03.
- Adopt **pattern P5 (Shared State Machine)**: a durable versioned row is the source of truth;
  **`human_required` is a state, not a missing event**; **timers attach to the row and carry the
  version they were scheduled at** (so a stale timer firing against an advanced row is detected, not
  acted on). This is the concrete design for §0.6 and for the scheduler's own durability.
- **P6 (Human in the Loop)** gives the control planes a scheduled run needs: kill-switch (revoke
  cancellation token ~1s), escalation (`suspend(reason)` → durable row), approval (synchronous wait
  under SLA, fall back to conservative deny on SLA lapse), throttling (per-minute/per-day
  blast-radius caps). A recurring unattended campaign needs throttling caps especially.

### 7.2 Reuse plans before re-searching — AgentReuse (arXiv:2512.21309, read in full)
~30% of real requests are similar/identical; re-planning them wastes the most expensive step.
AgentReuse's mechanism (its Algorithm 1) is directly portable to the scheduler:
- **Separate the templated request from its parameters.** Intent-classify the task, extract
  parameters to form a template `q⁻` (e.g. "book a ticket from … to …"), and key the cache on the
  *template* embedding **within the intent category** (category-scoped search cuts lookup cost).
- On a new task: if the best cached template similarity ≥ γ (paper default 0.75), **reuse the cached
  structured plan, substituting fresh parameters**, and skip planning; else plan and store
  `⟨E(q⁻), plan, category⟩`. Measured: 93% reuse rate, −60.61% latency, <10 ms lookup, ~100 MB.
- For revoy2: a *verified* campaign result is already a structured plan (actions with declared
  inputs/outputs). Cache it keyed by intent-template in the KB; on a scheduled/recurring run of a
  similar task, reuse the plan structure and go straight to execution + verification — but the
  reused run is `claimed` until *this* run's verifier passes (§4 gotcha).

### 7.3 Bound reasoning depth; structure memory — LongCoT & Oracle Memory (abstract-verified)
- **LongCoT (arXiv:2604.14140):** frontier models score **<10%** on long-horizon chain-of-thought
  even when each local step is tractable — long-horizon *reasoning* collapses well before context or
  memory limits are hit. Design consequence: a long-horizon run gains more from **bounding and
  checkpointing reasoning depth** (which revoy2's node/tree model already does) than from unlimited
  context. Do not let a scheduled run balloon its reasoning depth unbounded.
- **Oracle Agent Memory (arXiv:2607.13157):** a **structured memory lifecycle**
  (ingest→consolidate→retrieve→revise/expire) reaches 93.8% LongMemEval with **10.7× fewer tokens**
  than flat history. revoy2's SQLite KB is the substrate; a long-horizon campaign should consolidate
  and expire memory across runs, not accumulate a flat trajectory log.

### 7.4 Competitive RE — the primitive is durable identity, not a scheduler UI
The RE brief's finding: **none of the four harnesses ships a mature first-party *local* scheduler**
— the pattern is "cloud-hosted automations" (Codex cloud automations, Claude Code `/routines`), not
CLI-native cron. The transferable steal is therefore **not** a scheduler UI but the durability
primitive underneath: Claude Code's `--resume <session-id>` (durable session identity) + Zoo Code's
Boomerang **parent/child recovery** (explicit child-task isolation + summary-only return). revoy2's
worktree isolation + roadmap-03 continuation already provide the stronger version of both; this
roadmap adds only the durable *trigger* layer on top, which is genuinely novel among local-first
harnesses (a differentiator, not a catch-up).
