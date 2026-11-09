# ADR-122: Console Layout Allocates Vertical Space To Content, Not Fixed Dead Ratios

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 3ae3a963f086de7d6e050aaf555a51b62d59eb54
**Content ID:** sha256:5f4b242deb4e86d57a83d89e02bc6edc046f62dc021e0d244e030084b5bd757a

**Partial supersession:** Decision 2 is superseded by ADR-149. Decisions 1 and
3–5 remain in force.

## Context

Verified by rendering `consoleScreen` against a realistic fixture (one
campaign, three activity entries, a two-node tree, one governance finding) at
120×40: of 38 body rows between the header and the input strip, only 5 carry
content — rows 6 through 33 are blank. The same fixture at 80×24 shows the
identical shape at smaller scale.

This is not a starvation bug — it is `render()`
(`packages/arbor-tui/src/screens/console.ts:295-331`) reserving its **full**
fixed geometry every frame, regardless of how much real content exists.
`bodyHeight` is `height - headerHeight - inputHeight` (`:298-299`); the wide
layout then splits it with fixed ratios — `treeHeight = 0.6 * bodyHeight`,
`governanceHeight = bodyHeight - treeHeight` (`:319-320`) — and the render
loop (`:324-329`) iterates `index < bodyHeight` unconditionally, calling
`pad(transcript[index] ?? "", leftWidth)` for every row whether or not
`transcript[index]` exists. `pad` (`:231-233`) fills the remainder with
literal space characters. A campaign with three activity entries and two
governance findings gets exactly the same reserved geometry as one with
three hundred — the difference is how much of that geometry is blank.

The narrow-terminal path (`:304-314`) has the identical shape: `third =
Math.floor(bodyHeight / 3)` is a fixed division of the available rows into
three panes' worth of *budget*, not into however many rows each pane's real
content needs.

`navigation.ts`'s `freezeWorkspace` (verified: hard-throws above two panes,
`:66`) and `renderer.ts`'s `renderScene` (verified: only `layout.panes[0]`
carries content, `:128`) both constrain this at the *pane* level — how many
independently-positioned windows a workspace may have, and which one the
renderer fills. Neither constrains what a single screen module draws *inside*
its own content box. `console.ts` composes header/transcript/tree/governance/
input entirely inside that one box (its own docblock, `:4-12`), so this ADR's
scope is that composition only.

## Decision

**1. A pane's allotted rows are a maximum, not a fixed allocation.** For each
of the two right-side panes (tree, governance) and the left transcript pane,
`render()` first computes each pane's real line count via its existing
`renderTranscript`/`renderTreeSearch`/`renderGovernance` calls, then donates
any pane's unused rows to a sibling that has more content than its nominal
share, before falling back to blank fill. The 0.62/0.6 ratios in
`LEFT_RATIO`/the tree-height split remain the *starting* split — they govern
exactly as they do today whenever both sides have enough content to fill
their share — but stop being enforced as a floor when a pane's content is
shorter than its share.

**2. An idle body collapses instead of padding.** When the combined real
content of every body pane is shorter than `bodyHeight`, the body renders at
its natural height and the input strip moves up to sit directly beneath it —
not at the bottom of a fixed-height box with dozens of blank rows between
content and the prompt. This is the direct fix for the empirical case above:
a freshly opened campaign with three activity lines and two tree rows no
longer produces 28 blank rows before the input box.

**3. A genuinely empty pane donates all of its rows, not a share of them.**
This generalizes case 2 to the single-pane case: a campaign with an idle
governance feed (zero findings) and an active transcript should not render a
governance sub-pane with its `"No governance activity."` placeholder eating a
fixed 40% of the right column while the tree pane's real content is starved
for space one column over. `renderGovernance`'s existing empty-state line
(`:277`) still renders — informational sparseness stays visible, per
Decision 2 of the companion status-bar ADR's sparse-vs-broken distinction —
but it renders as one line, not as a fixed-height reserved block.

**4. Narrow-terminal `third` becomes the same donate-unused-rows rule
applied to three panes instead of two**, not a separately maintained
constant — one mechanism, both layouts.

**5. Unaffected by construction:** `navigation.ts`'s two-pane cap,
`renderScene`'s single-content-pane rule, and the modal overlay's reservation
for prepared interview sessions are untouched — this ADR only reshapes rows
*inside* `console.ts`'s own content box, the same box it already fully owns
today.

## Consequences

An idle or lightly-active campaign's Console view stops reading as "mostly
broken terminal" and starts reading as "this is what there currently is." A
busy campaign (many transcript rows, a deep tree) is unaffected in the
degenerate case — when every pane's content already exceeds its share,
row-donation has nothing to donate and today's ratio split governs exactly as
it does now, so this is a strict widening of the current behavior, not a
replacement of it.

The cost: `render()` gains a real content-length computation before it lays
out rows, rather than laying out first and letting `pad` paper over the gap
— a small amount of additional, still-pure computation per frame, well within
this package's existing "rebuild the whole `SceneFrame` from scratch every
tick" posture (ADR-104). The layout is no longer expressible as two constant
ratios alone; a reader of `render()` now has to trace one more donation step
to know how many rows a given pane gets on a given frame. This is accepted:
the alternative is the dead space itself, and the donation rule is a pure
function of already-computed row counts, not new state.

## Alternatives / Roads not taken

**Keep the fixed ratios, add a "press X to see more" hint in the blank
space.** Rejected: it decorates the emptiness rather than removing it, and
does nothing for the "content clusters in the top eighth" first impression
that motivated this ADR.

**Auto-hide a pane's header/border entirely when it has zero rows, as a
special case, rather than the general row-donation rule.** Rejected as the
primary mechanism, though it falls out of Decision 3 as the zero-content
limit of the same rule — a bespoke "hide when empty" special case would still
leave an idle-but-nonzero pane (one activity line, one tree row) padded with
blank rows, which is the more common case in the empirical render above, not
the zero case.

**Grow line density instead (wrap long labels onto multiple rows, add
sub-detail lines) to fill the space with more information rather than
resizing panes.** Rejected as the primary fix: it manufactures rows to match
a fixed geometry instead of fitting geometry to real content, which is the
inversion of what "auto-magic, not an event log" asks for. Nothing here
precludes wrapping where content genuinely needs it (the companion transcript
ADR already budgets caption width); it is just not how idle space gets
filled.

## Obligations

### O1 — A pane's rendered row count never exceeds its real content plus the rows donated to it, and never renders blank rows purely to fill a fixed ratio when a sibling pane has unmet content

<!-- proof: symbol=consoleScreen file=packages/arbor-tui/src/screens/console.ts roundtrip=packages/arbor-tui/tests/screens-console.test.ts -->

### O2 — The two-pane cap (`freezeWorkspace`) and the single-content-pane rule (`renderScene`'s `layout.panes[0]`) are unmodified by this decision

This ADR's donation mechanism is entirely internal to `console.ts`'s existing
content box; it introduces no new pane, workspace, or `renderScene` call.

<!-- unverifiable: no implementation exists yet; this restates an existing, already-verified constraint rather than introducing a new one this ADR could bind a proof to -->

### O3 — Layout remains a pure function of `(projection, width, height)` — the same inputs always produce the same donated-row layout, with no added nondeterminism

<!-- proof: symbol=consoleScreen file=packages/arbor-tui/src/screens/console.ts roundtrip=packages/arbor-tui/tests/screens-console.test.ts -->
