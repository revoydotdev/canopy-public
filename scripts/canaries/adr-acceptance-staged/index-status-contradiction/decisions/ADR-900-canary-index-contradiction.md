# ADR-900: the canary fixture for gate:adr-acceptance-staged

**Status:** Proposed

## Context

This file exists only as a canary fixture
(`scripts/canaries/adr-acceptance-staged/index-status-contradiction/`). The
`decisions/README.md` beside it claims this record is `Accepted`; the record's
own Status line says `Proposed`.

That contradiction is the one defect `bun run adr:accept` fixes by
construction — it writes the record status and the index row together in a single
status-only commit — and the one shape the gate's own remedy names. Everything
else `checkAdrAcceptance` finds (a missing row, a wrong file link) is not fixed
by that command, which is why the gate attaches a remedy to this shape only.

## Decision

`gate:adr-acceptance-staged` must exit non-zero reporting
`ADR-900: index says "Accepted", the file says "Proposed"`.

Note what this fixture deliberately does NOT do: it stages a status change.
`--staged` mode reads the INDEX (`git show :decisions/README.md`,
`git ls-files --cached`), and the canary runner's `git init` commits the whole
fixture, leaving the index clean. The contradiction is therefore carried by the
COMMITTED content of the two files, which is the part of `--staged` mode that
survives a clean index — the snapshot check — rather than the `git diff --cached`
leg. A fixture that relied on staged content could never fail, because nothing
in this mechanism can stage anything.

## Consequences

The gate exits 1 with the index-contradiction message. The seam is one CLI block
in `adr-acceptance-gate.mjs`: `checkAdrAcceptance({ repo })` was already
parameterised, so only `main()` needed changing. `git_repo: true` is required —
every read in this gate is a git read, and without a repository the diff
commands return empty rather than failing, so the gate would pass vacuously.

## Obligations

None. Deliberately empty.

## Alternatives

Exercising the `acceptance_bundles_content` rule instead was rejected: that leg
reads `git diff --cached` and needs a genuinely staged change, which no fixture
declared through this mechanism can produce.
