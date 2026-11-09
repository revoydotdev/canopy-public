# ADR-126: The Console Tree Pane Shows A Search, Not A Dump

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 3ae3a963f086de7d6e050aaf555a51b62d59eb54
**Content ID:** sha256:6865d96f932a474139e36a6e0eea583fafaac3141db3e3657865e2cdb30d3a6e

## Context

Two independent gaps share one shape: a Console affordance whose label
promises more than its wiring delivers.

**The tree pane.** Verified by rendering `consoleScreen` against a fixture
where the campaign's task is `"Give revoy2 an opencode-like console"`: the
transcript's first line reads `"Planning: Give revoy2 an opencode-like
console"`, the header reads the same string as the campaign name, and the
tree pane's root row — one pane over — reads `"Plan: Give revoy2 an
opencode-like console"`. `treeRows` (`console.ts:136-149`) calls `tree.ts`'s
`projectTree` verbatim and renders every row it returns, root included, with
no awareness that the root label is, in the common case, the same task
string already shown twice elsewhere on the same screen. At 80 columns the
same root label renders as `"▶ Plan: Give revoy2 an opencode"` — cut with
zero truncation indicator, mid-word, at the pane's own edge — because
`renderTree` (`widgets.ts`) pipes every label through `clipDisplay`
(`widgets.ts`), and `clipDisplay` is a byte-exact hard cut with no ellipsis
mode at all (confirmed: its full implementation is a single accumulate-until-
budget-exceeded loop, no truncation-marker branch). `console.ts`'s own
comment at `:218` already states the intent: "the tree pane here is a
read-only search surface, not a branch/prune target" — but `surface.commands`
is `[]` (`:340`), so there is no keybinding of any kind for this pane: no
scroll, no filter, no expand/collapse. A pane the module's own comment calls
"search" currently performs no search operation; it renders a fixed,
truncated, partially-duplicate dump of whatever `projectTree` returns,
identically every frame.

**The input strip.** Verified by reading `tui.ts`'s keystroke handler
(`:2049-2070`), whose own comment states the design in full: "Focused,
Enter blurs AND clears (there is no backend `console.command` capability to
submit to — this is a local scratch buffer, not a hidden command line)."
Concretely, `ch === "\n"` while focused (`:2064`) sets
`consoleInputBuffer = fromText("")` and blurs — the typed text is discarded,
not sent anywhere. This is documented, intentional behavior, not an
oversight — but the rendered affordance does not say so: `renderInputStrip`
(`console.ts:281-293`) draws a bordered box with a `❯` prompt glyph
(`:287`), the same shape a real command line uses, with a hint that reads
`"Enter clear"` only once already focused (`:289`) — an operator has to
focus the box and read the fine-print hint to discover that Enter discards
rather than sends. Separately, this repository already has a real,
wired "type text, submit it as work" capability: `taskcomposer.submit`
(`tui.ts:679`, dispatched via `TASK_COMPOSER_NEW_ACTION_ID` at `:1601` and
`:2196`) is the exact shape — free text in, a task-composer draft out — the
Console screen's own docblock (`:1-2`) frames this surface as wanting:
"opencode-like" implies a prompt box that does something, matching the
operator's own framing of the geometry this screen models (right pane,
bottom input, status header) on a harness whose bottom input box submits.

## Decision

**1. The tree pane shows the active lineage, not a flat dump.** `treeRows`
gains a filter step, applied before the existing `MAX_TREE_ROWS` cap: when
the projected tree's root label is identical to (or a prefix/whole-string
match of) the campaign name already rendered in the header
(`headerRow`'s `campaign` field, `console.ts:106`), the root row is
suppressed from the Console pane specifically — it is genuinely redundant
information on this one screen, not on the dedicated Tree screen, where the
root carries no such neighbor. What remains is prioritized toward the
expanding/claimed lineage `tree.ts`'s own row `state` already carries (the
same `state === "expanding" || state === "claimed"` test `treeRows` already
computes into `active`, `:146`): ancestors and descendants of the active
node sort first when the row count would otherwise exceed the pane's real
height (companion layout ADR), so a deep tree's *relevant* path is what
survives truncation by row count, not whatever happened to be
depth-first-earliest in `projectTree`'s output. This is the concrete
difference between a "dump" and a "search" — it is a real display-time
filter with a return value, not a keybinding-driven interactive search;
Decision 3 addresses interactivity.

**2. Truncated labels say so.** `console.ts`'s own call into `renderTree`
clips the label to the pane's real available width, minus three columns,
and appends an ellipsis (`…`) when the label's display width exceeds that
budget — a `console.ts`-local wrapper around the existing
`clipDisplay`/`displayWidth` primitives in `widgets.ts`, not a change to
`clipDisplay` itself (which other screens depend on for its current
byte-exact, no-marker behavior and stay unaffected). A label that fits
untruncated is unchanged.

**3. The input strip is out of scope here.** A sibling decision
(`console-input-strip-is-not-a-command-line`) owns that question and
deliberately poses it as an operator choice — wire the strip to the real
submission path, or make it honestly inert — rather than settling it as a
side effect of a tree-rendering decision. This ADR changes nothing about the
input strip, and the two are independent: either resolution there leaves both
decisions above intact.

## Consequences

The tree pane stops repeating the campaign's task string a third time on
one screen and stops clipping a label mid-word with no indication anything
was cut; what remains fits the word "search" the module's own comment
already uses for it — a prioritized, legible slice of the tree, not a fixed
enumeration.

The cost, stated plainly: root suppression is a heuristic. A campaign whose
root label genuinely differs from the header's campaign string keeps its root
row, and a campaign where the two coincidentally match loses a row an operator
might have wanted. The suppression is Console-only for exactly this reason —
the dedicated Tree screen, where the root has no redundant neighbour, is
untouched.

Prioritising the active lineage under truncation means a row that was visible
at one moment can be displaced by another as the active node moves. That is
the intended behaviour for a live search view and the wrong behaviour for an
audit artifact; Console is the former, and the Tree screen remains the latter.

## Alternatives / Roads not taken

**Leave the pane as a flat dump.** Rejected: it prints the campaign's task
string a third time on a screen that already carries it in the header and the
transcript, and clips mid-word with no indication anything was cut. A reader
cannot tell a truncated label from a short one, which is the specific way this
pane currently misleads rather than merely underinforms.

**Shorten the header instead of suppressing the root.** Rejected: the header's
campaign name is the screen's orientation line and the thing an operator scans
first. Degrading the label that works to save the one that duplicates it trades
the wrong way round.

**Make the tree interactively scrollable and searchable rather than
prioritised.** Deferred, not rejected — and it is the better answer eventually.
It is out of reach today because a hand-composed in-pane region carries no
scroll offset and no sub-region hit-testing (ADR-125 accepts exactly those
costs). Prioritised truncation is what can be done inside that constraint;
when ADR-125's Rule-of-Three trigger fires and a real multi-region model
exists, this decision should be revisited rather than preserved.

**Change `clipDisplay` itself to append an ellipsis.** Rejected: other screens
depend on its current byte-exact, marker-free behaviour, so a global change
would alter panes this decision never examined. The ellipsis is a Console-local
wrapper around the existing primitive instead.

**Suppress the root on the dedicated Tree screen too.** Rejected: there the
root has no redundant neighbour — no header repeating it — so suppression would
delete information rather than de-duplicate it. The suppression is deliberately
Console-only, which is also why it is a display filter rather than a change to
`projectTree`.

## Obligations

### O1 — The Console tree pane never renders a root row whose label is redundant with the header's own campaign-name string

<!-- proof: symbol=consoleScreen file=packages/arbor-tui/src/screens/console.ts roundtrip=packages/arbor-tui/tests/screens-console.test.ts -->

### O2 — A tree label truncated by the Console pane's width always carries a visible truncation marker; an untruncated label is rendered unchanged

<!-- proof: symbol=consoleScreen file=packages/arbor-tui/src/screens/console.ts roundtrip=packages/arbor-tui/tests/screens-console.test.ts -->
