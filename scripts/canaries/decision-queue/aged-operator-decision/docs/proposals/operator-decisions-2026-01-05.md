# Operator decisions — canary fixture

## D1 — a decision written down and never revisited

This is the canary fixture for `gate:decision-queue`
(`scripts/canaries/decision-queue/aged-operator-decision/`). It is an
`operator-decision` item whose file name carries a date far enough in the past
that the item is past the seven-day grace clock and lands in `over_age`, which
counts toward `blocking`.

The shape is the one the module's own header calls the class the queue existed to
catch: "a decision that is owed can never sit unasked" — an undated-by-deadline
prose commitment accruing silently, with nobody scheduled to ask.

## D2 — a second one, so the fixture is not a single-item edge case

Present so that the canary proves the queue read the store rather than tripping
on one hard-coded row. It fails for the same reason and by the same predicate.

## Obligations

None. Deliberately empty; one fixture, one proven gate.
