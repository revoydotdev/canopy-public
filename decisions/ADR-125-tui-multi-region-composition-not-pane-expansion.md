# ADR-125: Multi-Region Screens Compose Inside The Pane Cap, Not Around It

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 3ae3a963f086de7d6e050aaf555a51b62d59eb54
**Content ID:** sha256:6537dd6b04e2d76f88f5ac8886a16f48b73cda351980a159e7df4d5d620865ad

## Context

`navigation.ts`'s `freezeWorkspace` hard-throws above two panes
(`workspace.panes.length > 2` → `"workspace supports at most two panes"`,
`navigation.ts:66`), and `renderer.ts`'s frame-composition loop only ever
projects real content into `layout.panes[0]` — `content = pane ===
layout.panes[0] ? primaryPaneContent(...) : ""` (`renderer.ts:128`). Pane[1]
exists structurally (it can claim screen real estate in a split) but its
interior is always the empty string; nothing in the renderer ever fills it.
Production confirms this is not an unused capability waiting for a caller:
`tui.ts`'s own workspace, `{ id: "main", route: "revoy2", panes: [{ id:
"main", title: "revoy2" }], ... }` (`tui.ts:700`), declares exactly one pane.
Every screen this codebase ships renders through that single pane.

`packages/arbor-tui/src/screens/console.ts` is the first screen that genuinely needs more than one
region — a header line, a two-column body (transcript left, tree-search +
governance aside right), and a bordered input strip, all live-updating
independently. It cannot ask `navigation.ts` for four panes; the type does
not allow it, and even a second pane would render empty. So it does the only
thing the current layer permits: it composes all four regions itself, by
hand, inside the one content string `layout.panes[0]` receives — its own
`NARROW_WIDTH_THRESHOLD` breakpoint (`console.ts:56`), its own `LEFT_RATIO`
split arithmetic (`console.ts:57`, `:316-317`), its own per-region row
budgeting (`console.ts:297-330`), and its own row-by-row string padding and
concatenation (`pad`/`clipDisplay`, `console.ts:231-233`, `:325-329`) to
zipper the left and right columns together character by character.

The status bar and notification band already used this same technique before
console existed — reserved row-bands written directly into the canvas,
bypassing the pane system (`renderer.ts:105-124`) — but both are single,
flat, one-line-at-a-time strips with no internal sub-layout of their own.
Console is qualitatively different: it is a real multi-pane workspace
(independently scrolling regions, an independently focusable input,
per-region empty states) built entirely *inside* what the layout layer
believes is one undifferentiated pane. Three costs of that fall out directly
from reading the code:

1. **No generic scroll offset.** Every other screen gets `AppModel
   .scrollOffsets` for free — `update.ts:781-808` mutates it per
   `model.screen`, and `renderer.ts:467` threads `scroll_offset:
   app.scrollOffsets.get(app.screen)` into the pane's render call
   automatically. Console's transcript region has no such hook; `console.ts
   :255-260`'s `renderTranscript` always shows the newest N lines
   (`entries.slice(Math.max(0, lines.length - height))`), with no way to
   scroll back into history the same keys work on every other list screen.
2. **No sub-region hit-testing.** `hitTestFrame` (imported by `tui.ts`)
   resolves a click to a `FramePane`, one per navigation pane — there is
   exactly one `FramePane` for console's four regions, so a click anywhere
   inside it (header, transcript, tree, governance, input) is
   indistinguishable to the input layer. The input strip is reached only by
   `harness.model.screen === "console"` plus raw keystroke sniffing in
   `tui.ts:2061-2070`, not by pane focus — a second such region (e.g. a
   future clickable tree row inside console) would need the same bespoke
   carve-out.
3. **No row-identity for sub-region rows.** `ScreenProjection.rows` carries
   `row_ids` elsewhere for selection/branch/prune targeting
   (`screens/screen.ts:152-157`); `console.ts:214-219` explicitly omits it
   for every region except tree, by comment, because the projection model has
   no way to say "this row belongs to sub-region B of pane 0."

The codebase already anticipated needing more visual real estate for
something: `Workspace.split`/`ratio` (`navigation.ts:16`) is a full
horizontal/vertical 50-50-or-other split model, sized and bounded
(`layoutWorkspace`, `navigation.ts:39-54`) — it is simply never given a
second pane with real content to split, which is a narrower gap than "no
multi-region model exists at all."

## Decision

**The two-pane cap and single-content-pane rule in `navigation.ts` /
`renderer.ts` stay as they are. Multi-region screens keep composing their
regions inside one pane's content, as `console.ts` already does — but that
technique is elevated from one screen's ad hoc solution to the documented,
sanctioned pattern for any screen needing more than one live-updating
region, and the layout layer is not expanded to a general N-region model at
this time.**

The evidence does not support building a general layout engine now: exactly
one shipped screen (`console.ts`) needs more than one region, production
still runs a one-pane workspace exclusively (`tui.ts:700`), and the two costs
that would most benefit from a real layout layer — scroll offset per
sub-region, hit-testing per sub-region — are narrow, addressable gaps, not
evidence that the whole model is wrong. A generalized N-region layout engine
sized for a sample of one screen is exactly the premature abstraction
`karpathy-guidelines`/AHA (CLAUDE.md §4.1) warns against: "duplication is
cheaper than the wrong abstraction," and a layout engine's shape is very hard
to guess correctly from a single example.

This decision does not close the gap permanently. It sets the bar for
revisiting it: **the moment a second screen needs independently
live-updating, independently scrollable sub-regions inside one pane, that is
the Rule of Three's third occurrence** (CLAUDE.md §4.1), and a real N-region
`WorkspaceLayout` — panes addressable individually for scroll offset,
hit-testing, and row identity — becomes the right call, not console's
hand-rolled arithmetic copied a second time.

## Consequences

Console ships without waiting on a layout-layer redesign, and its `pad`/
`clipDisplay` composition technique becomes the referenced pattern the next
similar screen should imitate rather than reinvent independently (avoiding
`N` slightly-different hand-rolled splitters).

The three costs identified in Context are accepted as this decision's
explicit cost, not silently absorbed: console's transcript cannot scroll
back, its four regions cannot be individually clicked, and its non-tree rows
carry no row identity. An operator reviewing a long campaign in console who
wants to reread an earlier transcript line has no way to do it from that
screen (they can still open the dedicated Tree/Communications screens, which
do have scroll). This is worth fixing at the point a second screen needs the
same regions, not as a special case for console alone.

The layout layer keeps its current, well-tested guarantees intact: the
two-pane cap, `layoutWorkspace`'s deterministic split/compact math, and the
`panes[0]`-only content rule are untouched by this decision — nothing in
`navigation.ts` or `renderer.ts` changes.

## Alternatives / Roads not taken

**Generalize `WorkspaceLayout` to N addressable regions now, and migrate
console onto it.** Rejected as premature: the shape of a real N-region model
(how sub-region scroll offsets key, how hit-testing subdivides a pane, how
row identity qualifies by region) is a genuine design problem best solved
against at least two real, different multi-region screens, not
extrapolated from console's specific header/two-column/input-strip shape.
Building it now risks fitting only the one screen that motivated it.

**Raise the two-pane cap in `freezeWorkspace` without a corresponding
render-layer change.** Rejected outright: `renderer.ts:128` would still only
paint `panes[0]`'s content, so a third or fourth pane would silently render
blank — worse than today's hard throw, because the failure would be a mute
visual gap instead of a caught construction error.

**Leave console's regions unscrollable/unaddressable permanently, treating
this as acceptable forever rather than a revisit trigger.** Rejected: the
gaps are real usability costs (see Consequences), and CLAUDE.md §4.2 requires
naming when a documented shortcut creates false confidence rather than
letting it stand undocumented. This ADR names the trigger for revisiting it
explicitly instead of leaving the omission implicit.

## Obligations

### O1 — `navigation.ts`'s two-pane cap and `layoutWorkspace`'s split/compact math are unchanged by this decision

<!-- proof: symbol=layoutWorkspace file=packages/arbor-tui/src/navigation.ts roundtrip=packages/arbor-tui/tests/navigation.test.ts -->

`layoutWorkspace` is the exported entry point both the cap
(`freezeWorkspace`, invoked from `createNavigation`/`normalize`) and the
split/compact sizing logic route through; `navigation.test.ts`'s existing
coverage continues to hold unmodified, since this decision edits no file
under `packages/arbor-tui/src/navigation.ts`.

### O2 — Console's four-region composition (header/transcript+tree+governance/input) continues to render entirely inside one pane's content, with no dependency on a second navigation pane

<!-- proof: symbol=consoleScreen file=packages/arbor-tui/src/screens/console.ts roundtrip=packages/arbor-tui/tests/screens-console.test.ts -->

`consoleScreen.render` is the sanctioned pattern this decision names;
`screens-console.test.ts` already drives it end to end (narrow and wide
widths, empty/populated projections) against the real module, not a
recreation of its logic.

### O3 — The revisit trigger (a second screen needing independently scrollable/clickable sub-regions) is a documented standing policy, not merely this ADR's prose

<!-- unverifiable: this obligation is a standing policy for FUTURE screen design (when to revisit the layout layer), not a property of code that exists today -- there is no second multi-region screen yet for a roundtrip test to exercise, and "the next screen author reads and follows this ADR" is a process guarantee, not a runtime one -->
