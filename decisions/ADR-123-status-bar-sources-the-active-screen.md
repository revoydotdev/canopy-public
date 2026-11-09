# ADR-123: The Status Bar Reads The Active Screen's Own Data, Not A Fixed Side Channel

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 3ae3a963f086de7d6e050aaf555a51b62d59eb54
**Content ID:** sha256:dc28b18aea36585bc424bee1549329779540669b511be69ef68622f0ca570811

## Context

Verified across `packages/arbor-tui/src/status-bar.ts` and
`packages/arbor-mcp/src/tui.ts`: `deriveExecutionStatus`
(`status-bar.ts:182-211`) is the sole source of the `active`/`attempt`/
`phase`/`verified`/`closed`/`last` zones, and it reads exactly one input —
`app.screens.get("tree")` (`:183`). If that lookup is not a
`TreeStatusShape` (`:94-96`), it returns `UNAVAILABLE_EXECUTION_STATUS`
(`:98-105`) — six em-dash placeholders — unconditionally.

`app.screens.get("tree")` is populated only by navigating to the dedicated
Tree screen; `tui.ts`'s `refreshProductSurfaces` (`:1468-1472`) — the
function that runs on every poll tick and drives `dashboard`/`cockpit`/
`projects`/`console` — never calls `refreshProductSurface("tree")` or
otherwise populates the top-level `"tree"` screen key. Meanwhile
`console.ts`'s own composite fetch, for the Console screen specifically,
*does* pull the same `campaign.tree` query and stores it — but nested, at
`app.screens.get("console").tree` (`tui.ts:1437`:
`` ...(screen === "console" ? { tree, console_input: {...} } : {}) `` ),
never at the top-level `"tree"` key `status-bar.ts` reads.

The consequence, confirmed by direct reading of both files rather than
inferred: an operator who opens the Console screen and never separately
visits the Tree screen in that session sees `active — attempt — phase —
verified — closed — last —` in the status bar for the campaign's entire
run, even while Console's own right pane is rendering that exact campaign's
real, live tree data three lines below it. This is not missing data; it is
the same data, fetched twice, filed under two different keys, with only one
of them wired to the status bar's reader. `STATUS_BAR_PLACEHOLDER`
(`:58`) — the em dash — was designed for a genuine absence ("no tree result
has been fetched yet," per `deriveExecutionStatus`'s own doc comment,
`:176-181`); here it fires for a false absence.

Separately, and independent of the above wiring gap: `buildRow` (`:351-374`)
and `buildCompactRow` (`:405-424`) already establish a real precedent for
*honest* sparseness — `attention` and `closed` are only emitted at all when
their value is neither the placeholder nor `"0"` (`:355`, `:360-363`,
`:408-409`, `:416`). A zone that is genuinely not applicable disappears from
the row rather than rendering a dash. `active`/`phase`/`attempt`/`verified`
have no such conditional — they always render, dash or not — which is the
inconsistency behind "seven unwired fields as em-dashes, reading as broken
rather than sparse": the row's own design already knows how to distinguish
"nothing to show" from "show nothing," and simply doesn't apply that
distinction uniformly.

## Decision

**1. `deriveExecutionStatus` reads whichever screen actually holds the
freshest `campaign.tree`-shaped result for the current campaign, not a
hardcoded `"tree"` key.** Concretely: check `app.screens.get("tree")` first
(unchanged, the dedicated Tree screen's own fetch), and when that is absent
or campaign-stale (existing check, `:185-187`, unchanged), fall back to
`app.screens.get(app.screen)?.tree` when the currently active screen's own
composite carries a `tree` field of the same shape (`console.ts` is the one
producer of this today; the check is structural — `isTreeStatusShape` on the
nested field — not a name check for `"console"` specifically, so it composes
with any future screen that fetches `campaign.tree` under its own key
without a further status-bar change). The existing campaign-id staleness
guard (`:185-187`) applies identically to the fallback source.

**2. Every execution-status zone adopts the same
emit-only-when-meaningful rule `attention`/`closed` already use.** When
`deriveExecutionStatus` returns `UNAVAILABLE_EXECUTION_STATUS` (genuinely no
tree result reachable by either path in Decision 1), `buildRow`/
`buildCompactRow` omit the `active`/`phase`/`attempt`/`verified` pairs from
the row entirely rather than rendering six dashes — collapsing to a shorter
row that reads as "no execution status available for this view" rather than
"seven fields, all broken." `campaign` and `activity` — the two zones that
are close to always available — keep rendering their placeholder when
genuinely absent, unchanged; this decision is scoped to the zones whose
absence is the common case for a screen that never fetches `campaign.tree`
at all (`dashboard`, `cockpit`, `projects` today), not every zone in the row.

**3. No change to what is fetched.** This ADR adds a read-side fallback and
a display-side omission rule; it does not add a new query, change
`refreshProductSurfaces`' polling set, or change `console.ts`'s own
composite shape. `campaign.tree` continues to be fetched exactly where it is
fetched today.

## Consequences

Viewing Console alone, in a single session, now shows real execution status
in the status bar — the same numbers the Console screen's own tree pane is
already displaying, without requiring a detour through the dedicated Tree
screen first just to "warm" a side-channel key the operator never sees
named anywhere in the UI. Dashboard/Cockpit/Projects, which never fetch
`campaign.tree`, now show a visibly shorter status row instead of six
dashes — sparse, not broken, matching the `attention`/`closed` precedent
already in the same file.

The cost: `deriveExecutionStatus` gains a second read path and a
screen-identity dependency (`app.screen`) it did not have before, so its
purity now depends on `app.screen` and `app.screens` together rather than
`app.screens` alone — both are already `AppModel` fields this module reads
elsewhere (`app.telemetryCampaignId`, `:241`), so this does not introduce a
new kind of input, only a second field of an existing kind. A screen whose
own `tree`-shaped fetch is for a *different* campaign than the operator is
currently viewing must not leak into the status bar; this is exactly what
the existing `raw.campaign_id !== app.telemetryCampaignId` staleness guard
already prevents, and Decision 1 requires the fallback path to run through
that identical guard rather than a relaxed one.

## Alternatives / Roads not taken

**Make `refreshProductSurfaces` also fetch and store `"tree"` at the
top level on every poll tick, regardless of which screen is active.**
Rejected: it re-issues a query the operator's current screen does not need
(Dashboard/Cockpit/Projects have no tree pane to justify it), adding
`~1/15` more real queries to every poll tick network-wide to fix what is, at
its root, a read-side lookup gap, not a fetch gap — `console.ts` already
proves the data is one query fetch away when it is actually wanted.

**Have `console.ts` additionally call `harness.dispatch` to also populate
the top-level `"tree"` key alongside its own `console.tree` field.**
Rejected: this duplicates one query result under two keys and creates a
second source of truth for staleness — a `"tree"` copy that could silently
diverge from `console.tree` if either write path changes independently.
Decision 1's read-side fallback keeps exactly one fetch, one key per screen,
and a documented, structural way for a reader to find the freshest one.

**Drop the em-dash placeholder concept entirely and always omit absent
zones, campaign/activity included.** Rejected: `campaign`/`activity` are
close to always available in practice (`telemetry?.campaign_id`,
`spinnerGlyph`), and an operator who has genuinely never had a campaign at
all benefits from an explicit "no campaign yet" signal rather than a status
bar that silently shrinks to almost nothing with no explanation of why.
Scoping the omission rule to the execution-status zones (Decision 2) keeps
that distinction rather than erasing it uniformly.

## Obligations

### O1 — `deriveExecutionStatus` finds a campaign-fresh `campaign.tree` result whenever ANY currently-fetched screen composite (the dedicated Tree screen's own key, or the active screen's nested `tree` field) carries one, not only when the top-level `"tree"` key happens to be populated

<!-- proof: symbol=deriveStatusBarZones file=packages/arbor-tui/src/status-bar.ts roundtrip=packages/arbor-tui/tests/status-bar.test.ts -->

`deriveExecutionStatus` is private; `deriveStatusBarZones` is its sole exported
caller and the symbol the roundtrip tests exercise directly. Coverage: "falls
back to the active screen's own nested tree field when the top-level
\"tree\" key was never fetched (ADR-123)" and "prefers the dedicated Tree
screen's own top-level projection over the active screen's nested fallback
when both are fresh".

### O2 — The campaign-id staleness guard applies identically to both the existing top-level source and the new fallback source — neither path can leak a different campaign's execution status into the current view

<!-- proof: symbol=deriveStatusBarZones file=packages/arbor-tui/src/status-bar.ts roundtrip=packages/arbor-tui/tests/status-bar.test.ts -->

Coverage: "does not leak a stale campaign's tree through the active screen's
nested fallback" (the existing top-level staleness test, "marks the
projection unavailable rather than stale when the fetched tree belongs to a
campaign the model has since left", is unchanged and still passing).

### O3 — When no fetched screen carries a campaign-fresh `campaign.tree` result, the execution-status zones are omitted from the rendered row rather than rendered as em-dashes, matching the existing `attention`/`closed` omission precedent in the same module

<!-- proof: symbol=renderStatusBar file=packages/arbor-tui/src/status-bar.ts roundtrip=packages/arbor-tui/tests/status-bar.test.ts -->

Coverage: "omits active/phase/attempt/verified from the wide row entirely
rather than rendering em-dashes, when no source is fetched", "still shows the
execution-status zones when a genuine 0/0 result is fetched (available, just
empty)", and "omits the execution-status tokens from the compact row without
leaving a dangling separator".
