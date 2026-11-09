# ADR-155: A Trailer Is Not A Citation Unless It Resolves

**Status:** Accepted
**Date:** 2026-09-02
**Authoring Revision:** 2e5d183a6d1617befa2182fc1fef77f8f08cff2d
**Content ID:** sha256:3a51c3159ada9c2281c1d6bffab8437062b346846c5a65e52e79817aedcd620b

## Context

ADR traceability is enforced in two layers, and the layering is right. The `commit-msg`
guard (`scripts/adr-trailer-check.mjs`) refuses a governed-path commit with no `ADR:`
trailer at the moment the message is written, when fixing it is free. `gate:adr-trace`
owns history. The guard imports `governedPathPrefixes` from the gate rather than
restating it, so the two cannot drift about which paths are governed.

Neither layer checked whether the cited decision exists.

`unclaimedCommits` cleared a commit on `parseAdrReferences(message).length > 0`, and the
guard's trailer regex accepts any one-to-three digit number. Verified against the real
parser:

```
"ADR: 999"      -> parsed: [999]     => gate treats as CLAIMED: true
"ADR: 042, 999" -> parsed: [42,999]  => gate treats as CLAIMED: true
```

So the apparatus proved a trailer had been typed. It never proved the change was governed
by a real decision, which is the thing it exists to prove.

This is not hypothetical, and it is not rare. **Thirteen commits in the last four hundred
carry `ADR: 148`. ADR-148 has no file under `decisions/`, no entry in
`decisions/registry.json`, and no row in `decisions/README.md`.** Every layer passed all
thirteen. They are real work, on governed paths, claiming a decision that does not exist,
and the mechanism built to catch exactly that reported them clean.

The failure matters most in the case the harness is built for. An agent under pressure to
clear a red `gate:adr-trace` can satisfy every layer with any three digits, and nothing
downstream disagrees. That is the "gate that runs but does not check what it claims"
shape, sitting on the most load-bearing claim in the governance model.

## Decision

**A citation must resolve. A number that answers to nothing is not a claim of governance.**

1. `knownAdrNumbers(repo)` is the single authority on which numbers are real: every
   allocated record, plus the registry's `reserved` set. Reserved numbers are deliberate
   citations of *another* repository's decisions, documented in `reserved_reason`, so they
   are genuine references with no local file and must resolve.

2. Both layers consult it, and the guard imports it from the gate — the same arrangement
   `governedPathPrefixes` already uses, for the same reason. One authority, so the guard
   and the gate cannot come to disagree about which numbers exist.

3. `gate:adr-trace` reports a new, separate failure class, `miscited_commits`: a
   governed-path commit that cites an ADR where **every** cited number resolves to
   nothing. It is kept distinct from `unclaimed_commits` because the remedy differs — one
   needs a trailer, the other needs a real record — and a shared bucket would blur them.

4. A commit citing one real record and one dangling number is **not** refused. It is
   governed; the real citation is what the gate exists to establish. The dangling number
   is still surfaced in the guard's message so it can be corrected, but it is not grounds
   for refusal. Refusing it would punish a typo in a commit whose governance is intact.

5. **A missing boundary never manufactures a failure.** `knownAdrNumbers` returns `null`
   when there is no readable registry, and `miscitedCommits` then reports nothing rather
   than reporting every citation as bogus. This is the posture the gate already takes when
   there is no `master` ref. `gate:adr-registry` is what proves the registry exists; this
   gate does not duplicate it.

## Consequences

Easier: `gate:adr-trace` now checks the thing its name claims. An agent cannot clear it by
inventing a number, and the guard says so before the commit exists rather than after a
rebind has bound the graph to it.

Harder, and deliberately so: allocating a record is now a prerequisite for committing
governed work under a new decision, not something that can be deferred behind a plausible
number. That is the intended cost. The guard's message carries the two commands that
close it.

Not changed, and worth stating plainly: this proves a cited record **exists**. It does not
prove the record **governs the change**. A commit touching the TUI can still cite an
unrelated real ADR and pass. That is a strictly harder question — it needs a notion of
which paths a decision covers, which no record declares today — and this ADR does not
close it and must not claim to.

Left open for the operator, not fixed here: the thirteen commits citing ADR-148 are
history, outside the merge-base range this gate scans, so nothing goes red. But they are
thirteen pieces of real work whose governing decision is unknown. What ADR-148 was meant
to be is an operator question, not one an agent should answer by picking a plausible
number — which is the very failure this record closes.

## Alternatives / Roads not taken

**Refuse any commit citing a dangling number, even alongside a real one.** Rejected as
disproportionate: the change is governed, and refusing on a typo trains people to drop the
extra citation rather than fix it.

**Validate against `decisions/*.md` filenames instead of the registry.** Rejected: it
would reject the five `reserved` cross-namespace numbers, which are correct citations with
no local file, and it would duplicate the registry's authority in a second place that
could drift from it.

**Have the guard fail open on a missing registry silently.** Rejected in favour of the
explicit `null` return, so the "cannot judge" case is a named value a reader can find
rather than an empty set indistinguishable from "everything resolved".

**Also check that the cited record governs the touched paths.** Deferred, not rejected. No
decision record declares the paths it covers, so this would require inventing that
declaration and backfilling 149 records. Claiming it here without the mechanism would be
the same unwitnessed claim this ADR closes.

## Obligations

### O1 — Only allocated or reserved numbers count as citations

`knownAdrNumbers` is the one authority both layers read, and it returns `null` rather than
an empty set when there is no registry, so a missing boundary cannot be mistaken for a
universe in which nothing resolves.

<!-- proof: symbol=knownAdrNumbers file=scripts/adr-trace.mjs roundtrip=scripts/tests/adr-trace.test.mjs -->

### O2 — A commit governed by nothing is reported, and one governed by something is not

`miscitedCommits` reports a governed commit whose every citation dangles, and reports
nothing for a commit that also cites a real record, that touches no governed path, that
cites no ADR at all, or that runs in a repository with no registry.

<!-- proof: symbol=miscitedCommits file=scripts/adr-trace.mjs roundtrip=scripts/tests/adr-trace.test.mjs -->

### O3 — The write-time guard refuses a trailer that resolves to nothing

`unresolvedAdrReferences` names the dangling numbers, and the guard refuses a governed
commit whose trailer contains only those — before the commit exists, which is the whole
point of the layer.

<!-- proof: symbol=unresolvedAdrReferences file=scripts/adr-trailer-check.mjs roundtrip=scripts/tests/adr-trailer-check.test.mjs -->
