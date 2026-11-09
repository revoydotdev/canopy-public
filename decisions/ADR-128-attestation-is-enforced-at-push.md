# ADR-128: Commits Are Local And Cheap; Attestation Is Enforced At Push

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 3ae3a963f086de7d6e050aaf555a51b62d59eb54
**Content ID:** sha256:23434c4924dee701a976b29be30e3bbbb45ea7d05590cf22fda14503caf1e0ca

## Context

This repository commits at agentic cadence, not human cadence: 2092 commits
since 2026-07-31, roughly eighty per day. On 2026-08-26 alone it took 110
commits, and **30 of those — better than one in four — were
`chore(evidence)` bookkeeping**, carrying no product change at all. The
evidence lease those runs contend for is shared across 47 worktrees.

Each substantive commit invalidates four derived stores (`claim-ledger`,
`completion-depth`, `vi-observed`, `determinism-baseline`) plus the
`.visual-intelligence` graph. Regenerating them costs one to two minutes,
holds the shared lease for the duration, and — because the graph rebuild
itself invalidates the stores that hash it as input — takes two rebind passes
and three commits to actually converge.

Attaching that to each commit would mean roughly eighty rebinds a day against
one lease held by 47 worktrees. Even the debounced form is wrong: the work is
not per-commit work. What the stores describe is a *state of the tree*, and
intermediate commits inside a session are not states anyone consumes. They are
steps in an argument, and only the conclusion is published.

Today's session is the honest illustration. Four separate rebind cycles ran,
producing thirty evidence commits, and the only one whose output anybody would
ever read is the last. One cycle was SIGTERM'd by a ten-minute command timeout
mid-transaction and left a dead lease that blocked three unrelated gates until
it was explicitly recovered — a failure mode that exists only because the
ritual ran often enough to be caught mid-flight.

The companion ADR establishes that derived governance side effects are
system-enforced rather than agent-performed, and that `pre-push` is the
inviolable boundary. It deliberately does not say *when* regeneration runs.
This ADR answers that, and the two must be adopted together: the principle
without this policy defaults to per-commit, which is the failure above.

## Decision

**1. Attestation and derivation are separated; they have been conflated.**
*Derivation* is the expensive part — LSP extraction, graph rebuild, three
determinism runs, one to two minutes, holding a lease shared by 47 worktrees.
*Attestation* is merely recording which tree state a commit corresponds to: a
hash, milliseconds, no lease, no analysis. Every commit is attested. Derivation
is deferred to the push.

**2. Most commits provably need no derivation at all.** Each commit records the
hash of the derivation INPUT SET. A commit touching only docs, tests, comments,
or the ADR corpus leaves that hash unchanged, which means the existing
derivation remains exactly valid — not presumed valid, proven so by input
identity. Only an input-changing commit is ever marked pending. On the measured
day this ADR cites, a large share of the 110 commits changed no derivation
input at all.

**3. Commits inside a session are otherwise source-only.** An agent commits as
often as the work warrants. No commit triggers a rebind, debounced or
otherwise. Commit messages, ADR trailers, and the pre-commit gates are
unchanged.

**4. The push is the boundary. There is nothing to declare.** Attestation is
not triggered by an actor announcing that a session ended — an announcement is
a step that can be forgotten, and a governance guarantee must not depend on
one. The trigger is the attempt to publish. Local commits accumulate freely and
unattested; the moment the work leaves the machine, the full ledger and
attestation state must agree with `HEAD`.

**5. `pre-push` REFUSES; it never repairs.** A push whose derived stores or
attestation documents disagree with `HEAD` is rejected outright. It does not
regenerate them on the actor's behalf, for two reasons. The first is the one
the companion ADR gives: a gate that repairs its own subject cannot also be
trusted to report on it. The second is mechanical and decisive — git resolves
the refs to be pushed *before* invoking `pre-push`, so a commit the hook
created would not be included in the push it is running for. The hook would
publish commit N while the attestation for N sat locally as N+1, permanently
one behind. Generation inside `pre-push` is not merely unwise here; it does not
work.

**6. Satisfying the refusal is ONE command, not a ritual.** The repository
provides a single entry point that runs the whole convergent cycle — both
rebind passes and the graph rebuild — and lands one attestation commit. The
refusal names that command. The loop is: push, refused, run it, push again,
accepted. The enforcement is unavoidable; the remediation is one step. This is
the whole of the actor's remaining obligation, and it is not a sequence they
can perform partially or misremember.

**7. One lease per batch.** The batch takes the evidence lease once and holds
it for one convergent cycle, rather than 47 worktrees contending for it
per-commit. A batch that finds the lease held waits; recovery of a dead lease
remains the existing `evidence:status` / `evidence:recover` path, and this ADR
adds no second recovery authority.

## Consequences

The obvious win is arithmetic: today's 30 evidence commits become one, and
roughly eighty daily rebinds become a handful. History stops being a quarter
bookkeeping. The lease stops being a contended resource across 47 worktrees.

**Deferred is not lost, and that distinction carries this ADR.** Derived
evidence is a reproducible function of the committed tree — `gate:vi-reproducible`
(`vi-refresh --check`) exists precisely to prove the committed graph regenerates
from committed inputs. So an input-changing commit that has not yet been derived
is not *unattested*; it is *not yet materialized*, and anyone holding that commit
can materialize it exactly. The repository therefore also provides an on-demand
range materialization (`attest --range A..B`) so an auditor or a bisect can
produce per-commit evidence later, computed from the commit itself.

**This makes the audit story stronger than the status quo, not weaker.** Today a
bisect lands mid-session on a commit whose stores are stale with no signal that
they are stale. Under this decision every commit carries its attestation status
and names the derivation covering it, and the evidence is reconstructible on
demand.

**The honest residue is measurement, not derivation.** Three of the four stores
(`claim-ledger`, `completion-depth`, `vi-observed`) are static derivations of the
tree and are exactly reconstructible. `determinism-baseline` is not: it runs the
cited seams three times and measures them, so it is environment-bound and a past
machine's timing cannot be perfectly recovered later. Deferring it is still
right, but for a different reason, which this ADR states rather than smuggles:
the claim worth making is that the code you PUBLISHED is deterministic, not that
every intermediate commit was measured on whatever machine happened to build it.

**Precondition, unverified at authoring time.** All of the above depends on
`gate:vi-reproducible` actually holding. It could not be verified green while
this ADR was written — the working tree carried uncommitted work, so the gate
reported ordinary staleness (`vi-freshness`: 1 commit behind), which is its
case (a) and not a pipeline defect. **This ADR should not be accepted until
`gate:vi-reproducible` is confirmed green on a clean tree.** If the graph does
not in fact reproduce from committed inputs, the reconstruction guarantee above
is void and this decision reduces to the weaker range-attestation argument.

A session that ends abnormally — crash, disconnect, an agent that simply stops
— leaves commits unattested, and that is now harmless. Nothing was published,
so nothing is wrong; the next actor to attempt a push is told exactly what to
run. Because the trigger is the push rather than an announcement, there is no
step anyone can forget: forgetting is indistinguishable from not having pushed
yet.

Pushes get slower and occasionally require two attempts. The first push of a
session will usually be refused, and the actor pays one convergent cycle before
retrying. That is the intended shape — the cost lands at the moment of
publication, on the person publishing, rather than eighty times a day on
everyone.

A long session accumulates a larger range behind one attestation, so a failure
in that cycle implicates more commits at once and takes longer to re-run. An
actor may push mid-session purely to bound that blast radius; nothing here
discourages it, and each such push is a real attestation rather than a
ceremonial checkpoint.

## Alternatives / Roads not taken

**Rebind per commit.** Rejected on the numbers above: eighty runs a day against
one lease shared by 47 worktrees, to regenerate descriptions of tree states no
consumer reads.

**Debounced per-commit rebind (the companion ADR's original draft).** Rejected,
and this ADR supersedes that draft's trigger. Debouncing reduces the count but
keeps the wrong model — it still treats attestation as a property of a commit
rather than of a published state, and it still fires during a session, which is
exactly when the tree is legitimately inconsistent.

**Require the actor to declare a session boundary explicitly** (this ADR's own
first draft). Rejected on the operator's objection, which was correct: a
declaration is a step, and a governance guarantee that depends on an actor
remembering to announce something is the same defect as the manual ritual it
replaces, merely relocated. The push already *is* the boundary — it is the
moment local, cheap, rewritable work becomes shared and permanent — so naming a
second boundary added ceremony and a new way to forget.

**Attest on branch merge or on PR open instead.** Rejected as the primary
trigger: this repository integrates on `master` directly and much work never
opens a PR, so it would leave the common path untriggered. Nothing prevents a
merge from also being a declared boundary.

**Let `pre-push` regenerate the stores rather than refuse.** Rejected for the
same reason the companion ADR rejects it: a gate that repairs its own subject
cannot report on it, and it would manufacture unreviewed commits at push time.

**Keep it manual but shorten the ritual.** Rejected. The ritual's length is a
symptom; the defect is that a governance guarantee depends on an agent
remembering an unenforced sequence. Shortening it makes the omission cheaper,
not detectable.

## Obligations

### O1 — Every commit is attested cheaply; no commit triggers derivation

Committing to a governed path must record the derivation input-set hash and must
NOT start a rebind, debounced or otherwise. A commit that changes no derivation
input must be marked as covered by the existing derivation, by input identity
rather than by assumption.

<!-- unverifiable: no implementation exists yet; this ADR is Proposed and awaiting an operator decision, so there is no symbol to bind a proof to -->

### O2 — One command converges the whole range and lands one attestation commit

The single entry point must leave the derived stores and the graph agreeing
with `HEAD` after one invocation, including the graph-invalidates-stores second
pass that today requires a manual third commit.

<!-- unverifiable: no implementation exists yet; the two-pass convergence is observed behavior of evidence:rebind plus vi:refresh, not a claim this ADR can bind a proof to before it is built -->

### O3 — A push with unattested commits is refused, and refuses rather than repairs

A push whose stores or attestation disagree with `HEAD` must fail and name the
remediation command. It must not regenerate anything itself — git resolves the
pushed refs before the hook runs, so a commit made there would not be part of
the push it was made for.

<!-- unverifiable: no implementation exists yet; this restates the companion ADR's inviolable pre-push boundary and introduces no new mechanism of its own -->

### O4 — A pending commit's evidence is reconstructible on demand

`attest --range A..B` must materialize per-commit evidence for a historical
range, so "not yet derived" is recoverable rather than lost. This obligation is
void if `gate:vi-reproducible` does not hold.

<!-- unverifiable: no implementation exists yet, and the reproducibility precondition it rests on could not be confirmed green at authoring time because the working tree was dirty -->

### O5 — One attestation cycle takes the evidence lease once

The cycle must not acquire and release the shared lease per commit in its
range, and must wait rather than steal when another holder is live.

<!-- unverifiable: no implementation exists yet; lease contention across 47 worktrees is the measured motivation, not a property this ADR can prove before it is built -->
