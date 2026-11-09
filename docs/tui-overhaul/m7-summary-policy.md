# M7 summary policy and evidence

Background updates fold by stable identity in `backgroundStatusesFromModel`
from the live Console projection and are rendered in the status row by
`backgroundStatusLine`; they are ordered by urgency:
failure, approval, blocked, active, waiting, success, idle. Repeated updates
replace the prior row rather than appending a token or subprocess line. The
visible band is bounded; an explicit `+N more` disclosure prevents truncation
from becoming a false quiet state.

Turn-boundary summaries are deterministic and normally 3–8 lines:

1. outcome;
2. important changes;
3. verification;
4. evidence references;
5. approval needs and blockers, when present.

Approval, failure, and blocker lines are never dropped for terseness. Model
summaries are not on the render path and are not needed for deterministic
fallback behavior. `summarizeTurnBoundary` and
`aggregateBackgroundStatus` are covered by
`packages/arbor-tui/tests/interaction-polish.test.ts`.

Before M7, repeated background rows accumulated and turn output had no shared
bounded policy. After M7, the same status identity occupies one row, urgent
states remain visible, and reading anchors survive refreshed identifiers.
