# ADR-920: the canary for gate:adr-status

**Status:** Proposed

## Context

This record exists only as a canary fixture for `gate:adr-status`. Its declared
status is `Proposed` while it carries obligations whose proofs fully resolve —
a real, collected test exists for work the record still calls undecided. That is
precisely the `status_suspect` condition ADR-074's audit was built to surface.

The proof triple below points at real files in this repository, so the canary
declares `link_repo_paths` to make `scripts/` visible inside the scratch fixture
root. Without that link the proof would not resolve, the record would classify as
`status_consistent`, and the canary would be asserting something the gate never
actually checked.

## Decision

`gate:adr-status` must report this record as `status_suspect` and exit non-zero.
It currently does the first and not the second: `scripts/adr-status-audit.mjs`
ends in `process.exit(0)` on all three of its paths, including its own failure
path. That is finding R2-01 in
`docs/proposals/arboretum-coordination-plane.md` §7.1, and this canary is how the
repository finds out about it rather than by reading the source.

## Consequences

`bun run guard:canaries` reports `gate:adr-status` as `unproven` and exits
non-zero. That is the intended result, not a defect in the runner: the gate
passed a fixture it must reject. Fixing the gate's exit codes is a separate
change; until then, a green from this gate is not evidence of anything.

## Obligations

### O1 — the status-suspect classification is real, not asserted

<!-- proof: symbol=extractCitations file=scripts/adr-citations.mjs roundtrip=scripts/tests/adr-citations.test.mjs -->

## Alternatives

Declaring this fixture `Accepted` and asserting the gate passes it was rejected:
a canary that expects success cannot distinguish a gate that inspected its input
from one that ignored it, which is the whole distinction this milestone exists to
create.
