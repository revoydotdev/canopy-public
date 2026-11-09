# ADR-124: The Console Input Strip Must Submit Or Stop Looking Like It Can

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 3ae3a963f086de7d6e050aaf555a51b62d59eb54
**Content ID:** sha256:8fb2dcf9167715321181c8bbfd565b32af7972e9e89953c0b8cb97b701905618

## Context

`packages/arbor-tui/src/screens/console.ts` renders an inline input strip at the bottom of the
Console screen: a bordered box, a `❯` prompt, a live text cursor (`▏`), and a
hint that reads `Enter to focus…` when blurred and `Esc blur · Enter clear`
when focused (`renderInputStrip`, `console.ts:281-292`). Every visual signal
this box gives an operator says "this is a command line": it has focus
state, a blinking-style cursor glyph, backspace/cursor-movement editing
(`tui.ts:2062-2067` wires `insertText`/`backspace`/`moveCursor` from the real
`text-buffer.ts` module), and a border style that visibly changes between
dashed (`╌`, unfocused) and solid (`─`, focused) — the same affordance
language a real prompt uses elsewhere in this codebase (Cockpit's former `❯ Type to
start a governed task…` prompt in `product.ts`).

It is not a command line. `tui.ts:2049-2060`'s own comment states this
plainly: "there is no backend `console.command` capability to submit to —
this is a local scratch buffer, not a hidden command line." Reading the
actual keystroke handler confirms it (`tui.ts:2061-2070`): focused, Enter
does exactly one thing — `consoleInputFocused = false; consoleInputBuffer =
fromText("")` — blur and silently discard whatever was typed. No query, no
command, no dispatch of any kind reaches the runtime port. An operator who
types a task description into what looks like the same kind of prompt
Cockpit already has, and presses Enter the same way Cockpit's real compose
flow expects (`cockpit_open_compose` → `dispatchTaskComposer({ type:
"open_operator_form", command: "taskcomposer.submit" })`, `tui.ts:2192-2196`),
gets nothing: no confirmation, no error, no created draft — the text is just
gone. That is a worse failure mode than a visibly disabled or absent input:
a disabled control tells the operator not to try; this one invites the
attempt and then eats the result without saying so.

This is a genuine product-shape decision, not a bug in the strip's own
logic — the strip does exactly what its code says. The open question is
architectural: does the Console screen (described in its own header comment,
`console.ts:1-2`, as "a single, opencode-like unified operator surface")
mean to become a real second way to submit governed work, alongside
Cockpit's existing compose form — or is it deliberately read-only,
monitoring-only, and the input strip should never have looked typeable in
the first place? Both are legitimate answers; leaving it silently
half-built, looking functional while doing nothing, is not.

## Decision

**The Console input strip must reach a real decision one way or the other
before this screen ships to any operator who is not already told it is
inert: either it is wired to the same governed task-submission path Cockpit
already uses, or it stops presenting focus/cursor/edit affordances that
imply it can be submitted.**

This ADR does not itself pick which of the two outcomes is correct — that
depends on product intent for Console (a genuine second compose surface vs.
a deliberately read-only monitoring view) that is outside what this audit
can determine from the code alone. It commits to resolving the ambiguity
before the screen is operator-facing, and names both acceptable resolutions
concretely enough that either is a real fix, not a rename:

1. **Wire it.** Route a non-empty buffer's Enter through the same
   `dispatchTaskComposer({ type: "open_operator_form", command:
   "taskcomposer.submit" })` mechanism Cockpit's compose flow already uses
   (`tui.ts:2192-2196`), pre-filled with the typed text, so Console becomes a
   genuine second entry point into the one real submission path — not a
   parallel, competing mechanism.
2. **Make it honestly inert.** Drop the focus/cursor/border-state affordances
   entirely and replace the strip with a visibly non-interactive status line
   (e.g. "Console is read-only — press 2 to compose a task"), matching how
   every other read-only screen in this codebase already signals its own
   read-only nature rather than offering dead controls.

Whichever is chosen, the operator-visible behavior after pressing Enter with
typed text must match what the strip's own affordances promised before that
keystroke — that is the property this ADR actually requires, independent of
which resolution is picked.

## Consequences

Either resolution removes the current trap: an operator can no longer type a
task description into Console, press the same key that works one screen over
in Cockpit, and lose the text with no feedback. Choosing (1) gives Console a
real second path to the one governed submission mechanism, growing its
reach without adding a competing authority (nothing about `taskcomposer
.submit`'s own admission/approval rules changes — only where the operator
can initiate them from). Choosing (2) keeps Console's current scope
(monitoring, not composing) but makes that scope legible instead of implied
by an unlabeled dead end.

Until this is resolved, Console should be treated as not yet operator-ready
by the standard this repo's own `console.ts` header comment sets for
itself — a real unified surface, not one with a control that lies about what
it does.

## Alternatives / Roads not taken

**Leave it as a "local scratch buffer" permanently, unlabeled.** Rejected:
this is the status quo this ADR exists to change. A control that looks
identical to a working prompt one screen over, with no visible difference in
its focus/cursor/border behavior, cannot be distinguished from a genuine bug
by anyone who has not read `tui.ts`'s source comment — which no operator
does. CLAUDE.md §4.2: "a safeguard that is documented but not wired is worse
than none; it creates false confidence." The inverse holds too: an
affordance that is wired for editing but not for submission creates the same
false confidence in the opposite direction.

**Repurpose the strip as a search/filter box over the transcript instead of
a submission line.** Considered as a third resolution but not adopted here:
it is a legitimate product idea, but it does not resolve the actual defect
(a control whose visible affordances promise one behavior and deliver
another) unless the prompt/hint text and border-focus language are also
rewritten to match — at which point it collapses into option (2)'s general
shape ("make the strip's affordances match what it actually does"), so it is
folded into that option rather than treated as independent.

## Obligations

### O1 — Whichever resolution is chosen, a non-empty buffer's Enter keystroke never silently discards typed text with no operator-visible outcome

<!-- proof: symbol=runTui file=packages/arbor-mcp/src/tui.ts roundtrip=packages/arbor-mcp/tests/tui.test.ts -->

Resolution 1 (wire it) was chosen: a non-empty buffer's Enter now routes
through `dispatchTaskComposer({ type: "open_task_preset", task: typed })`
(`tui.ts`, Console input strip handler) -- the same governed
`taskcomposer.submit` path Cockpit's own compose flow uses -- then blurs and
clears. Coverage (real keystroke path, not the reducer alone): "Console
input strip: Enter on a non-empty buffer opens the real governed
task-composer form pre-filled with the typed text" proves the operator-
visible outcome (the form opens, pre-filled); "Console input strip: Enter
on an empty buffer only blurs (no form opens); Escape blurs without
clearing typed text" proves the two non-negotiable exceptions (empty-
buffer Enter, Escape) are unchanged.

### O2 — `consoleScreen`'s render output (including the input strip's focus/border/hint states) stays exercised by real, non-recreated coverage as this decision lands, whichever resolution is chosen

<!-- proof: symbol=consoleScreen file=packages/arbor-tui/src/screens/console.ts roundtrip=packages/arbor-tui/tests/screens-console.test.ts -->

`screens-console.test.ts` already drives `consoleScreen.render` against real
focused/unfocused/populated/empty projections; whichever resolution is
implemented must keep exercising the strip through this same real module
rather than asserting against a hand-recreated string, matching CLAUDE.md
§4.5.
