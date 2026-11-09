# ADR-900: the canary fixture for gate:adr-registry

**Status:** Proposed

## Context

This file exists only as a canary fixture
(`scripts/canaries/adr-registry/orphan-allocation/`). It is a numbered record
that `decisions/registry.json` — in the same fixture — does not know about: the
registry's `allocations` array is empty, so no allocation matches ADR-900 and
its slug.

That is the exact defect `verifyRegistry` exists to catch. `adr-registry.mjs
allocate` is the only sanctioned way an ADR file acquires a number, and it writes
the registry entry, the index row, and the numbered file in one step. A numbered
file with no allocation is therefore a record that reached the corpus by some
route that bypassed the allocator — the shape behind the duplicate-ADR
collisions of 2026-08-15.

## Decision

`gate:adr-registry` must exit non-zero and report that
`ADR-900-canary-orphan-allocation.md has no matching allocation`.

This gate is addressable with no code change: `scripts/adr-registry.mjs` already
accepts `--repo`, so the canary runner's default `--repo {repo}` argument points
its whole corpus read at the scratch fixture. No `link_repo_paths` and no
`git_repo` are needed — `verifyRegistry` reads plain files and shells out to git
only on the allocate/accept paths, which a `verify` canary never reaches.

## Consequences

The gate exits 1 with `has no matching allocation` in its output, which is this
canary's declared `expected_failure_reason`.

## Obligations

None. Declared deliberately empty so this fixture cannot be mistaken for a
`gate:adr-sections` stub-obligation canary; each fixture proves exactly one
thing about exactly one gate.

## Alternatives

A fixture that duplicated an allocation NUMBER (two entries claiming 900) was
considered. Rejected: that shape is checked by a different predicate in the same
function and would prove less about the corpus/registry reconciliation this
record names.
