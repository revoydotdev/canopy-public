# Audit finding 001 — the canary fixture for gate:audit-disposition

## Context

This file exists only as a canary fixture
(`scripts/canaries/audit-disposition/undispositioned-audit/`). It is a durable
audit document under `audit/` that nobody has answered for.

That is the exact shape the gate names in its own header: "Five audits ran that
day and their recommendations existed only in a chat transcript — they would
have evaporated at session end while `gate:decision-queue` reported PASS."

## Decision

`gate:audit-disposition` must exit non-zero and report this path under
UNDISPOSITIONED.

The fixture is one file, and the seam is one line. `audit-disposition.mjs`
already takes its corpus root as a parameter everywhere below
`analyzeAuditDisposition({ repo })` — the CLI `main()` was the only thing that
could not be pointed anywhere. The canary therefore needed exactly one addition:
`REPO_ROOT` now honours a `--repo` flag, defaulting to the previous constant, so
absent the flag nothing changes. No `link_repo_paths` are needed, because the
gate's other input, `docs/proposals/operator-decisions-*.md`, is simply absent
from the fixture and contributes nothing.

## Consequences

This document names the remedy in its own body? No. That is the point: it
declares no `audit-disposition: none-required` marker, and no
`<!-- arises-from: -->` in any decisions file points at it, so the gate reports
it undispositioned.

## Obligations

None. Deliberately empty; one fixture, one proven gate.

## Alternatives

Declaring this document none-required is the other real answer, and it makes the
gate pass, which a canary cannot assert. Declaring it here would also mean the
fixture's own prose had to avoid the literal marker, which is exactly what an
earlier draft of this file got wrong: it quoted the marker inside its
Alternatives paragraph, the gate's regex matched the quotation, and the canary
silently stopped failing.
