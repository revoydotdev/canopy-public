# ADR-121: Console Transcript Narrates Campaign State, It Does Not Echo Events

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 3ae3a963f086de7d6e050aaf555a51b62d59eb54
**Content ID:** sha256:fa1af6d96ed1281ee7bb51f08eda7632948bd54f4f8d5f33a850b96f7c906e77

## Context

Verified by rendering `consoleScreen` against a realistic fixture (three
`activity` entries, one campaign, one governance finding) at 120×40:

```
revoy2 · Give revoy2 an opencode-like console · expanding · nodes 4/9   ...
… Planning: Give revoy2 an opencode-like console
… expanding · specialist: Refactor terminal shell · 4/9 verified
? Approval needed: review requested
```

Three backend `activity` entries produce three transcript lines, each a
verbatim restatement of the entry's own `label` field prefixed by a bare
tone glyph. `transcriptRows` (`packages/arbor-tui/src/screens/console.ts:117-132`)
maps the `activity` array 1:1 into rows; `renderTranscript`
(`console.ts:255-260`) maps rows 1:1 into lines via
`` `${toneGlyph(entry.tone)} ${entry.label}` ``. There is no grouping by
`source`, no folding of a still-in-progress state into an existing line, and
`toneGlyph` (`console.ts:235-243`) returns a bare ASCII/Unicode character
with **no color** — `console.ts` imports nothing from `theme.ts`, unlike
`status-bar.ts`, which already builds its row from
`footerTheme(deriveTheme(...))` (`status-bar.ts:49,454`) and a `PaletteRole`
palette (`theme.ts:24`). Every transcript line today carries identical visual
weight regardless of whether its tone is `needs-operator` (an operator must
act) or `working` (routine progress); the only signal is a single
non-colored punctuation character at the start of the line.

This is a live line-count risk, not just a display nit: ADR-117 (accepted,
same day) just made scope/approval refusals recoverable by pushing them into
`history` as `tool_result` entries rather than ending the session — the exact
kind of event class this repository's own activity feed will carry more of
over time, not less. A transcript that earns one row per backend event will
grow faster than the campaign that produces it, without regard for repeat.

`console.ts`'s own docblock (`:1-2`) frames the screen as "a single,
opencode-like unified operator surface." Studied structurally (see ledger
below): `sst/opencode`'s TUI (MIT license) renders each tool invocation as
one `InlineToolRow` carrying a `pending`/`completed`/`failed` state, with
friendly display names substituted for internal tool identifiers — one row
*per call*, updated in place as its state resolves, not one row per
lifecycle sub-event. That is a different aggregation unit than
`console.ts`'s current one-row-per-activity-entry, and the general shape
(collapse by identity, not by arrival) is the fix this ADR proposes for
revoy2's own `activity` feed and its own `source`/tone vocabulary — expressed
independently, not reproduced from opencode's code, which was not read
(only described secondhand, see ledger).

## Decision

**1. Fold same-subject repeats instead of appending a new row per event.**
`transcriptRows` groups consecutive `activity` entries that share the same
`source` and represent an update to the same still-open subject (the
`campaign` source repeating `tone: "working"` about the same node before it
resolves) into one row. A repeat updates that row's own trailing state token
and a `(×N)` counter rather than emitting a sibling line. A row is only
retired — and a new one started — on a genuine lifecycle boundary: a `tone`
change (`working` → `ready`/`needs-operator`/`error`) or a different
`source`. This is a pure function of the same `activity` array already
fetched; no new query, no new backend shape.

**2. Tone gets weight, not just a glyph.** `console.ts` gains the same
`footerTheme`/`PaletteRole` dependency `status-bar.ts` already has. A
`needs-operator` row renders in the palette's `warning` role foreground; an
`error` row in `danger`; routine `working`/`ready`/`neutral` rows stay in the
theme's plain `text` role. This is additive coloring only when
`options.color` is true (matching every existing color-gated render path in
this package, e.g. `renderStatusBar`'s `color` option, `renderer.ts:155`);
the plain-text row returned when color is off or unavailable is unchanged
in content, only unchanged in styling.

**3. Glyph-first, label-second stays the ordering, but the glyph vocabulary
grows one member.** A folded row's glyph reflects its *current* state
(`toneGlyph` unchanged), and the `(×N)` counter — when present — sits
immediately after the glyph, before the label, so the eye reads "kind →
repeat count → what" left to right, matching this screen's existing
glyph-then-label convention (`renderTranscript`, `renderTree`'s
branch-glyph-then-label shape in `widgets.ts`).

## Consequences

A working campaign that pings the same in-progress state repeatedly
collapses to one row per genuinely distinct thing that happened, not one row
per backend tick — directly shrinking the "eight mechanical lines" the
empirical render above demonstrates, and freeing vertical rows for the
companion layout ADR to actually use. A `needs-operator` line becomes visibly
distinct from routine progress without consuming any additional row.

The audit trail is unaffected: this is a display-layer fold over the
`activity` projection `console.ts` already builds, not a change to what
`tui.ts`'s `refreshProductSurface` fetches, what `CampaignManager` records, or
what the governance ledger stores. Every folded event is still present in the
backend's own history; only the transcript's row-per-event default changes.

The cost, stated plainly: an operator scanning only the transcript pane loses
per-tick granularity for a repeating same-subject state — they see "expanding
(×4)" where they previously saw four separate timestamped lines. This is the
intended tradeoff (narration over event-log completeness) and is only safe
because nothing else in this repository treats the transcript pane as the
system of record; the dedicated `audit`/`governance` screens and the
underlying ledger remain the completeness surface.

## Alternatives / Roads not taken

**Keep one row per event, rely on color alone to de-emphasize repeats.**
Rejected: color changes legibility, not row count, and does nothing for the
dead-space problem the companion layout ADR addresses; a campaign that
repeats a state ten times still produces ten rows.

**Render the transcript as opencode's full chat-turn view (markdown text,
reasoning blocks, rich tool cards).** Rejected/deferred. ADR-104 already
verified, as of this repository's own audit, that no markdown parser exists
anywhere in `arbor-tui` and that streaming increments never reach the TUI
layer today; adopting a chat-bubble renderer is a materially larger surface
than a row-folding rule and is out of this ADR's scope.

**Summarize the feed with an LLM call.** Rejected: `arbor-tui`'s rendering is
documented and tested as a pure function of `(AppModel, frame_count)`
(`status-bar.ts:12-17`'s "player-piano" determinism contract,
`frame-pacing.test.ts`); an LLM summarizer is nondeterministic input the
existing determinism tests would have to special-case or lose coverage of.

**Collapse by time window (e.g., merge any two entries within N seconds)
instead of by subject identity.** Rejected: a time window conflates two
genuinely different subjects that happen to arrive close together (a
governance finding and a campaign tick), which is exactly the "mechanical
echo, not narrative" complaint this ADR exists to fix, just moved to a
different axis.

## Studied vs. derived (clean-room ledger)

- **Studied, primary source, in-repo:** `packages/arbor-tui/src/screens/console.ts`,
  `packages/arbor-tui/src/status-bar.ts`, `packages/arbor-tui/src/theme.ts`,
  `packages/arbor-tui/src/widgets.ts`, `decisions/ADR-104-terminal-render-is-incremental.md`,
  `decisions/ADR-117-refusals-reach-the-corrigible-actor.md`. Revoy2 code and
  ADRs; no license concern, this repository's own content.
- **Studied, secondary source, external:** `sst/opencode` TUI structure, via
  DeepWiki's summary of the `sst/opencode` repository (not the raw source
  itself — not fetched or read in this session) and the project's `LICENSE`
  file (fetched directly: MIT). The DeepWiki summary states tool calls render
  as `InlineToolRow` components carrying a pending/completed/failed state and
  friendly display names; it explicitly does **not** document whether
  repeated calls are collapsed, how progress is animated, or how visual
  hierarchy (color/indent/weight) is encoded — those specifics were not
  found and are not claimed here.
- **Derived independently, not reproduced from any source:** the
  same-subject/same-tone folding rule, the `(×N)` counter placement, the
  glyph→counter→label ordering, and the palette-role mapping
  (`working`→plain, `needs-operator`→warning, `error`→danger) are this ADR's
  own design, built against `console.ts`'s and `theme.ts`'s actual existing
  types and role names — not opencode's, which were never read.
- **Excluded:** opencode's actual TUI source code was not fetched or read in
  this session (no `WebFetch` against its source tree, no clone). Any claim
  about its literal implementation beyond the DeepWiki summary above is
  explicitly out of scope and not made.

## Obligations

### O1 — Same-subject, same-tone repeats fold into one row instead of one row per `activity` entry

`transcriptRows`/`renderTranscript` must produce fewer rows than
`activity.length` when consecutive entries share `source` and an unresolved
`tone`, and must never drop the underlying `activity` data from any other
screen or query — only the console transcript's own row projection changes.

<!-- proof: symbol=consoleScreen file=packages/arbor-tui/src/screens/console.ts roundtrip=packages/arbor-tui/tests/screens-console.test.ts -->

### O2 — A `needs-operator`/`error` transcript row is visually distinct from a routine row when color is enabled, and byte-identical in plain text when it is not

The colored variant must reuse `theme.ts`'s existing `PaletteRole`s (no new
hardcoded SGR sequence in `console.ts`), gated by the same `options.color`
convention every other colored render path in this package already uses.

<!-- proof: symbol=consoleScreen file=packages/arbor-tui/src/screens/console.ts roundtrip=packages/arbor-tui/tests/screens-console.test.ts -->

### O3 — Folding is a pure, deterministic function of the fetched `activity` array

The same `(activity, campaigns, governance, ...)` composite must always
project to the same folded row set — no `Date.now()`/random input — matching
the player-piano determinism contract `status-bar.ts` already documents and
`frame-pacing.test.ts` already exercises for this package.

<!-- proof: symbol=consoleScreen file=packages/arbor-tui/src/screens/console.ts roundtrip=packages/arbor-tui/tests/screens-console.test.ts -->
