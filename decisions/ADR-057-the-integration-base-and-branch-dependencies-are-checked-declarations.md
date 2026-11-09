# ADR-057: The integration base and branch dependencies are checked declarations

**Status:** Accepted
**Date:** 2026-08-12
**Authoring Revision:** 4df24b99ebef7fb1c3282389431080892910aa4a
**Content ID:** sha256:4c4383ecdc47d0b3756ebee193186ccef1fcea9dcc8e281a2d40b9ba82be8381

## Context

The integration postmortem §1.1 records eight branches forked from a `master`
that was 23 commits behind the real integration line. Section §1.5 records a
stacked branch replaying seven already-landed commits because no dependency was
declared. Both failures came from absent repository facts, not bad merge
judgment.

## Decision

`.arbor/integration.jsonc` is the committed, checked declaration of canonical
trunk and the declaration revision. `trunk-preflight` refuses a candidate that
does not contain live trunk, a stale declaration revision, and divergence
between `master` and a differently named trunk. Handoff notes must carry an
explicit `depends_on` field; the preflight compares branch commit ranges and
refuses exact stacked commits whose branch is undeclared. The conductor reads
the same trunk contract when no explicit override is supplied.

This does not create a rollback target or compete with ADR-023's isolation
reasoning. It is preflight provenance: it prevents ambiguous work from starting
and makes topology history inspectable.

## Obligations

### O1 — A non-trunk fork is refused with a specific rebase remediation

<!-- proof: symbol=checkTrunkPreflight file=scripts/trunk-preflight.mjs roundtrip=scripts/tests/trunk-preflight.test.mjs -->

### O2 — Undeclared stacked commits are refused

<!-- proof: symbol=checkTrunkPreflight file=scripts/trunk-preflight.mjs roundtrip=scripts/tests/trunk-preflight.test.mjs -->

### O3 — A declaration not ancestral to live trunk is refused

<!-- proof: symbol=readIntegrationContract file=scripts/trunk-preflight.mjs roundtrip=scripts/tests/trunk-preflight.test.mjs -->

## Consequences

Worktree creation has an explicit refusal point and branch stacking becomes a
reviewable claim. Exact-SHA overlap catches the postmortem incident; rebased
patch-equivalent overlap remains for a future patch-ID extension and is not
claimed here.
