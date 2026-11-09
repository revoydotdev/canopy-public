# ADR-001: the canary fixture for gate:adr-trace

**Status:** Accepted

## Context

`scripts/canaries/adr-trace/unclaimed-governed-commit/` is a synthetic git
repository, not an ADR corpus. It exists so `gate:adr-trace` has a history it
must reject: a governed path changed on a branch with a commit message that
names no ADR.

## Decision

The branch commit adds a file under `packages/core/` and says only
`feat: add b`. `gate:adr-trace` must exit non-zero reporting that commit as an
unclaimed governed-path change.

## Consequences

`gate:adr-trace` fails with `touch governed paths and claim no ADR` in its output.
That string is the canary's declared `expected_failure_reason`.

The fixture declares `git_repo: true`, so the runner initialises a repository and
commits the fixture before running the gate. Without that, `adr-trace.mjs` has no
merge-base to measure against and passes vacuously — a canary that measures
nothing and reports green.

## Obligations

None.

## Alternatives

Exercising `adr-trace` against the live repository's own unclaimed history was
rejected: that history is not a fixed input, so the canary would change verdict
as unrelated work landed, and a canary whose result moves for reasons outside the
gate is indistinguishable from a broken one.
