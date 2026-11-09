# ADR-127: Governance Side Effects Are System-Enforced, Not Agent-Performed

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 3ae3a963f086de7d6e050aaf555a51b62d59eb54
**Content ID:** sha256:40468437e32a1445a3f84387db5cfca6b58a7e9ed5f5005187600bb5545d1aff

## Context

Every substantive commit in this repository invalidates four derived evidence
stores (`claim-ledger`, `completion-depth`, `vi-observed`,
`determinism-baseline`) and the `.visual-intelligence` graph. Bringing them
back into agreement with the commit is a fixed, mechanical ritual: commit the
source, run `evidence:rebind`, commit the four stores, run `vi:refresh`,
commit the graph, run `evidence:rebind` again, commit again.

Nothing performs that ritual. The evidence-staleness nudge detects the
staleness and prints the steps, and then declines to act: "This does not
auto-run: `evidence:rebind` takes 1-2 minutes and holds the evidence lease, so
it is a deliberate step, not something a hook should fire unattended." There is
no `post-commit` hook in the repository at all — only `pre-commit` and
`pre-push`. That nudge began as scripts/hooks/evidence-staleness-nudge.mjs
(reached through its `.sh` PostToolUse wrapper) and is now the native
`inject.evidence-staleness` handler in
`packages/arbor-mcp/src/hooks/evidence-staleness-tropism.ts`, behind the
`evidence-staleness` descriptor; the text this Decision quotes is rendered by
its `buildStalenessNudge`, verbatim, so the refusal below is unchanged. What
changed is the trigger's seam, not its judgement: the host PostToolUse call is
not a moment revoy2 owns, so the native seam is the turn boundary and the
nudge lands on the next prompt.

So the guarantee that committed evidence matches committed source rests on an
agent remembering a seven-step sequence, every time, and reporting honestly
that it ran. That is precisely the shape this repository's own operating rules
reject: a safeguard that is documented but not wired creates false confidence.
It is also the shape our own product thesis rejects, since the thing being
sold is that provenance is tracked by the system rather than by the diligence
of whoever touched the code.

Measured cost on 2026-08-26: the ritual was performed four times across three
tranches. One run was SIGTERM'd by a ten-minute command timeout mid-transaction
and left a dead evidence lease that blocked three gates
(`adr-acceptance-staged`, `adr-decision-followthrough`, `obligations`) until it
was explicitly recovered. None of that failure mode is visible to an agent that
simply forgets to rebind at all — that agent's commit is silently unbacked.

The stated objection to automation is real but narrower than it appears. Cost
and lease contention are arguments against firing the rebind *synchronously on
every commit*; they are not arguments against automation. The same day, a
single background rebind holding the lease was enough to red three gates, which
is evidence about contention, not about whether a human should be in the loop.

The evidence rebind is the instance that surfaced, not the category. The same
"performed by an agent that could have skipped it" shape covers `adr:accept`
follow-through, proof-comment validation, and the interview ledger.

## Decision

**1. A governance side effect that can be derived is derived by the system, not
performed by the actor.** Regenerating the derived stores stops being a
sequence an agent is trusted to remember and becomes something the repository
does on its own behalf. The agent never issues `evidence:rebind` by hand and
never hand-commits the stores.

**2. `pre-push` is the inviolable boundary, and the only one that matters.**
Evidence that disagrees with source is refused at the push, because the push is
where it stops being local and becomes someone else's problem. This is a
refusal, not a repair: `pre-push` never regenerates what it is checking, since
a gate that fixes its own subject cannot also be trusted to report on it. If
the regeneration failed, was killed, or never ran, the push refuses.

**3. WHEN the regeneration runs is deliberately not specified here.** The
naive trigger — one rebind per commit — is wrong at this repository's commit
cadence and is rejected by the companion ADR on commit batching, which owns
that question. This ADR fixes only the principle (derived, not performed) and
the boundary (refused at push). The two must be read together: this one
without a batching policy would produce a rebind per commit, which is the
failure mode the companion ADR exists to prevent.

**4. Automation is an ergonomic improvement over a guarantee that already
exists, never a new guarantee that depends on the automation succeeding.** If
this decision's mechanism silently stops working, the worst outcome is that
pushes start refusing — not that unbacked evidence ships.

**5. The agent's remaining obligation is to not defeat it.** Committing the
derived stores by hand, or pushing with `--no-verify`, remain possible — this
is a local hook on a private repo, and ADR-025 already records that server-side
enforcement is unavailable here. What changes is that the correct path is the
default path and requires no discipline, rather than being a ritual whose
omission is invisible.

## Consequences

An agent can no longer produce a commit whose evidence stores were never
regenerated simply by forgetting, and cannot truthfully report a tranche as
complete while the stores are stale, because the push that would share it
refuses. The four-commit ritual collapses to one commit.

This decision is inert on its own. Adopted without the companion batching
policy, the only obvious trigger is per-commit, which at this repository's
cadence would run derived-evidence work continuously and hold a lease shared
across sibling worktrees — strictly worse than the manual ritual it replaces.
Accepting this ADR while rejecting the batching one would be the bad outcome.

The `evidence-staleness` nudge's advisory text becomes wrong the moment
this lands, since it instructs a human to do what the system now does. It must
be rewritten in the same change or it becomes a documented-but-false
instruction — the exact defect class this ADR exists to close.

Debugging moves: a rebind that fails now fails in a detached process rather
than in front of the actor who caused it. The failure must surface somewhere an
operator will actually look, or an automated step becomes a silent one. That is
the main risk this decision takes on.

## Alternatives / Roads not taken

**Leave it manual and rely on the nudge.** Rejected: this is the status quo,
and it demonstrably failed today — not by an agent ignoring the nudge, but by
the ritual being long enough that a timeout could sever it mid-transaction and
leave a lease that blocked unrelated gates.

**Run the rebind synchronously in `pre-commit`.** Rejected: it puts one to two
minutes of derived-evidence work in front of every commit, which will be
routed around, and routing around a governance step is worse than performing it
late.

**Make `pre-push` regenerate the stores itself rather than merely checking
them.** Rejected: a gate that repairs what it is checking cannot also be
trusted to report on it, and it would produce commits at push time that no one
reviewed.

**Automate the whole category at once (`adr:accept` follow-through, proof
validation, the interview ledger).** Deferred, not rejected. The evidence
rebind is mechanical and fully derivable, which is what makes it safe to
automate. Interview acceptance is deliberately not derivable — it requires a
recorded human verdict, and `gate:vi-findings` already exists precisely because
a model triaging its own findings would fabricate the decision the gate is
meant to prove. The principle in this ADR's title applies to derivable side
effects; it must not be read as license to automate a judgement.

## Obligations

### O1 — A commit touching governed paths leaves the derived stores regenerated without any agent action

The `post-commit` hook must schedule the rebind for a commit touching
`packages/` or `decisions/`, and must not for a commit touching neither.

<!-- unverifiable: no implementation exists yet; this ADR is Proposed and awaiting an operator decision, so there is no symbol to bind a proof to -->

### O2 — Automation never becomes the guarantee; `pre-push` still refuses stale evidence

A push whose derived stores disagree with the committed source must still be
refused when the background rebind failed, was killed, or never ran.

<!-- unverifiable: no implementation exists yet; the existing pre-push refusal is unchanged by this ADR and is not a new claim it introduces -->

### O3 — Concurrent commits coalesce instead of stacking rebinds

A burst of commits, including across sibling worktrees sharing one evidence
lease, must produce a bounded number of rebind runs rather than one per commit.

<!-- unverifiable: no implementation exists yet; this is the specific regression the Consequences section names as the thing to watch -->
