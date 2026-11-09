# ADR-910: the canary for gate:adr-sections

**Status:** Accepted

## Context

This record exists only as a canary fixture for `gate:adr-sections`
(`scripts/canaries/adr-sections/stub-obligation/`). It is a synthetic ADR whose
sections are deliberately incomplete, so that the gate under test has something
it is supposed to reject. It is not a real decision and authorizes nothing.

## Decision

`gate:adr-sections` must fail on this record. Two of its declared invariants are
violated here on purpose:

- `## Obligations` carries a prompt-only body and no `### O<n> — ...` item.
- `## Alternatives` carries a heading whose only content is its own HTML-comment
  prompt, so the section is present but empty.

## Consequences

`gate:adr-sections` exits non-zero with `incomplete/stub section` in its output.
That output is the canary's declared `expected_failure_reason`; if the reason
stops appearing, the canary reports `misfired` rather than `proven` so a moved
failure mode cannot read as a still-working gate.

## Obligations

None. This fixture declares no obligation on purpose: a record whose obligations
resolve would be flagged as `status_suspect` by `gate:adr-status`, which is a
different canary and a different question.

## Alternatives

The alternative was mutating the live `decisions/` corpus. Rejected: a canary
that dirties the repository it measures cannot be re-run, because the second run
would measure the first run's damage.
