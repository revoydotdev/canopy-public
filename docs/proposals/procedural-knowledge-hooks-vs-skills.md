# Procedural knowledge: what must be a hook, what must be a skill

**Status:** Proposal, not an ADR. Nothing here is authorized by being written down.

**Date:** 2026-08-18. Motivated by a session that produced direct evidence in both
directions: a rule that instruction could not enforce, and a rule that enforcement
could not teach.

## The question

This repository already enforces a great deal mechanically — six Claude hooks, two
git hooks, a twenty-gate battery. It also carries a lot of procedural knowledge that
is enforced by nothing: the order evidence stores must be refreshed in, what a file
move breaks, which gates fire only at pre-push.

The question is not "should procedure be written down." It is **which mechanism each
piece of procedure belongs in**, and the answer is not uniform.

## The axis is not importance

The tempting split is "important rules become hooks, advisory ones become skills."
That is wrong, and this session falsified it in both directions.

**Instruction failed where the rule was trivially decidable.** Five subagents ran
forbidden `git` write commands — `stash`, `pop` — across five separate briefs that
prohibited them explicitly, two of them in the same paragraph as the alternative.
The rule was simple, stated, and repeated. It still failed five times out of roughly
twenty dispatches. No amount of better prose fixes a 25% violation rate on a rule a
regex can decide.

**Enforcement could not teach where the cost landed before the check.** The
evidence-refresh ordering (graph before stores, ADR-075's constraint 3) was violated
two or three times by the orchestrator. Each time `gate:store-freshness` caught it —
*correctly, and too late*. By the time a Stop hook fires, the wrong-order work is
already done and the cost is two extra refresh cycles. A hook can report that
ordering was wrong; it cannot cause it to be right.

Worse: the correct mechanism **already existed**. `evidence.refresh` is a native tool
in `arbor-mcp` that encodes the ordering. Nothing put it in front of the agent at the
moment of need, so the agent ran five commands by hand and got them out of order.
That is a routing failure, not a knowledge failure, and no hook addresses it.

## The real axis: when the cost lands, and whether judgment is required

Three questions, asked in order:

**1. Is the rule mechanically decidable from observable state?**
If no — it needs judgment — it can only ever be a skill. `gate:vi-findings` is the
canonical case: it requires a recorded human verdict precisely because a model
triaging its own findings would fabricate the decision the gate exists to prove.

**2. Does the cost land before or after the action?**
- *After* — a wrong end state that can be checked. Hook or gate territory.
- *Before* — the cost is wasted or destroyed work, and detection is consolation.
  Ordering, sequencing, and blast radius all live here. Only ex-ante steering helps.

**3. Is the violation recoverable?**
- Cheap to fix → **gate**: detect and report.
- Expensive or irreversible → **hook**: block the action.

## The four tiers

### Tier 0 — `PreToolUse` hooks: non-negotiable, ex ante, block the action

*Criteria:* mechanically decidable from the pending call **and** violation is
expensive or irreversible.

Existing: `claim-guard.sh` (refuses an ADR write lacking a proof comment),
`vi-readonly-guard.sh`.

**Proposed addition — `git-write-guard`.** Refuse `git stash|reset|checkout --|rebase|
commit|add` from a subagent context. Evidence: five violations across five briefs.
The orchestrator retains write access; agents get read-only git and are pointed at
`git show <rev>:<path>`.

This is the tier's whole justification: the rule is regex-decidable, the failure rate
under instruction is measured, and one of the five violations was a `stash` round-trip
during a cross-package refactor — the case where losing a diff is unrecoverable.

### Tier 1 — `Stop` / `pre-push` hooks: non-negotiable, ex post, block the *claim*

*Criteria:* mechanically decidable after the fact, and the thing to prevent is
**reporting work as complete when it is not**.

Existing and working: `gate-stop.sh`, the pre-push battery. This tier caught five
distinct consequences of a single file move, each from a different gate.

No new hooks proposed. One fix: two gates (`docs-truth`, `typecheck-tests`) fire only
at pre-push and not in the Stop battery, which bit the orchestrator twice. That is a
*visibility* gap, and visibility is Tier 2's job.

### Tier 2 — Skills: negotiable, ex ante, steer sequence and blast radius

*Criteria:* requires judgment, **or** the value is in ordering/scope where a hook can
only catch the aftermath.

This is the empty tier today. All ten existing skills are audit skills — "how do I
inspect X" — and none answers "I am about to do X; what order, and what else does it
touch?"

Proposed: **one** skill, `revoy2-procedure`, whose body is a dispatch table keyed by
*situation*, not topic. Each row names the invariant, the mechanism, and the blast
radius:

| Situation | Invariant | Mechanism |
|---|---|---|
| changed source, about to commit | graph before stores (ADR-075 c3) | route to `evidence.refresh`, do not hand-run |
| moving or renaming a file | five path-keyed stores break | ADR proof citations · anti-stub TRIAGE · determinism seams · ROADMAP/docs prose · `tsconfig.tests.json` |
| authoring a decision | authoring ≠ allocation ≠ acceptance | scaffold → allocate → substantive commit → separate status-only accept (ADR-059, ADR-072) |
| adding a test touching `REPO_ROOT` | broad-state reads race the checkout | ADR-078's A/B/C classification |
| dispatching a subagent | constraint block + ownership split | including `git show` as the sanctioned alternative |
| about to push | some gates fire only here | derived from `gate-all.mjs`'s tier roster |

### Tier 3 — Gates: detect and report, do not block

Existing, mature, twenty of them. Unchanged.

## Why not make everything a hook

The user's instinct that the split involves system stability is right, and it is worth
stating precisely rather than as a feeling.

**A hook is load-bearing infrastructure with no escape hatch.** A wrong gate produces a
red check somebody investigates. A wrong `PreToolUse` hook wedges every session in the
repository, including the session that would fix it. `claim-guard` already demonstrates
the benign version of this — it blocked a legitimate ADR edit until a proof comment was
added, which was correct but is exactly the shape that becomes intolerable if the
predicate is slightly wrong.

**Hooks also cost on every matching call.** A `PreToolUse` matcher on all `Bash` calls
runs for every command in every session. The `git-write-guard` above is worth it because
its predicate is a cheap string match; a hook that had to parse a diff would not be.

So the bar for Tier 0 is deliberately high: **measured failure under instruction, plus
unrecoverable consequence, plus a cheap predicate.** `git-write-guard` clears all three.
Nothing else currently proposed does.

## The failure mode this proposal must avoid

A dispatch table that is hand-maintained prose is another unwitnessed claim — the exact
defect this repository treats as worse than nothing, and one it has been bitten by
repeatedly (a gap register that described fixed work as open for twelve commits; ADRs
naming contract points closed eight minutes after authoring).

Two requirements follow:

1. **Derive what can be derived.** The gate-tier row must come from `gate-all.mjs`'s
   roster, the way ADR-074 already made that roster self-enumerating. A hand-copied
   list of which gates run when will drift within a week.
2. **Test the orderings.** Each documented sequence needs a test proving it matches
   what the mechanism actually does. A skill that confidently states the wrong order is
   worse than no skill, because it steers with authority.

## What this does not decide

- Whether `revoy2-procedure` is one skill or several. One is proposed because the
  triggers are verbs at a moment and a single dispatch point is easier to route to,
  but a phase split is defensible.
- Whether Tier 0's `git-write-guard` should distinguish orchestrator from subagent by
  environment, transcript inspection, or an explicit opt-in. That is an implementation
  question with real subtleties.
- Anything about enforcement of Tier 2. By construction it is advisory; if a rule in
  it turns out to need teeth, that is evidence it belonged in Tier 0 or 1 instead.
