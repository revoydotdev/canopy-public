# ADR-149: The Console Is a Bottom-Anchored Governed Conversation

**Status:** Accepted
**Date:** 2026-08-29
**Authoring Revision:** ad4ac7840039e15c2c32deb7a1e03dec912d7fcc
**Content ID:** sha256:394a237ba37ba78fca79a0b8a5ae49ce6a489b05c1fb0e1bef080db12a65a851

> Annotation 2026-10-06 (no change to the decision): the "43 screens" figure in this record is prose; the registry (the module-private screen-navigation table that `buildDefaultCatalog` in `packages/arbor-tui/src/default-catalog.ts` turns into navigation actions) lists 40 registered screens. See `docs/research/ux-refactor/PLAN.md` §3.

## Context

Canopy is functionally broad but its primary interaction still reads like an
operations dashboard wrapped around a prompt rather than a frontier coding
conversation.  The accepted 64-second theme reel makes the gap concrete: on
an idle campaign the input strip sits halfway down a tall pane, the unfiltered
palette becomes a wall of similarly weighted commands, and long tree/gate
records consume full-width rows while the lower pane remains unused.  The
governed greenfield pilot proves task intake, interview persistence, exact
scope authorization, result review, and adoption separately; it does not make
those transitions feel like one continuous session.

The input placement is not an incidental rendering bug.  ADR-122 Decision 2
explicitly says an idle body collapses and the input moves directly beneath
it.  That removed a different blank-space failure but chose the opposite of
the stable spatial contract used by conversational terminal harnesses: the
composer remains at the viewport bottom and the newest work stays adjacent to
it.  The operator has now named the floating input as a defect, so changing it
requires a superseding decision rather than silently contradicting ADR-122.

Two independent 2026-08-29 research lanes inspected public Codex source and
documentation, Claude Code documentation, public OpenCode source and
documentation, the locally pinned `@opentui/core` 0.5.3 API, and Canopy's live
render path.  They found a consistent interaction model: one persistent
bottom composer; a chronological stream whose tool, plan, permission, diff,
and retry records are concise until expanded; blocking questions dock at the
point of interruption; session/agent detail is contextual; and palettes rank
actions for the current state before exposing the full command inventory.
Canopy already has the harder authority beneath those shapes, but distributes
it across 43 peer screens.

OpenTUI is not the blocker.  The pinned public API already supports bottom
absolute positioning, Yoga layout, text areas, scroll boxes, focus/mouse
events, syntax-highlighted code, Markdown, terminal capability updates,
links, clipboard composition, renderer statistics, and native test recording.
Canopy currently sends pre-clipped strings through a structured pane shell,
so those capabilities cannot be adopted safely by guessing semantics from
rendered text.  In particular, dropping in a native textarea without an
explicit input-ownership boundary would create two editors: OpenTUI's buffer
and Canopy's canonical reducer buffer.

## Decision

Revoy2 will make Console the stable conversational shell around governed work
and treat specialist screens as contextual inspectors.  This record
supersedes only ADR-122 Decision 2's input-placement rule; its content-aware
row donation and all other obligations remain in force.

1. **The composer is pinned to the bottom of the usable primary pane.**  The
   header remains top anchored.  Sparse-body whitespace belongs between the
   header and the most recent chronology, never below the composer.  The
   newest timeline entries remain directly above the composer, and the
   notification/status bands retain their existing reserved rows.  The rule
   applies at wide, narrow, resized, ANSI, and OpenTUI-native render paths.

2. **The composer is a persistent governed input, not a one-line imitation.**
   It supports cursor editing, multiline input/paste, visible focus, a bounded
   growing height, external-editor handoff, and explicit submit/queue/interrupt
   affordances.  Submission and steering continue through existing
   `taskcomposer.*` and `harness.session.*` authority.  Canopy's reducer is the
   canonical buffer; a native editor may be introduced only through typed
   scene metadata, an explicit focused-editor input route, and reducer
   synchronization that proves one edit and one submission per input event.

3. **Chronology is the primary representation.**  Plan construction, named
   ADR authoring, agent dispatch, tools, tests, diffs, gate holds, interviews,
   approvals, critic review, evidence, adoption, retry, and recovery project
   into one ordered semantic timeline from their canonical events.  Routine
   events render as compact cards with kind, subject, state, elapsed/summary,
   and a truthful detail target.  Raw output, ledger prose, and complete diffs
   are progressively disclosed through a selected card or contextual
   inspector rather than repeated inline.

4. **Operator attention interrupts in context.**  The precedence is pending
   interview/approval/clearance, retryable failure, active work, then settled
   success.  A blocking card names the requested consequence, scope, source
   authority, safe default, and exact action keys.  Answering or approving
   updates the same timeline item from the durable record; it does not create
   a parallel local state.  Historical failures lose footer dominance after
   the active frontier advances but remain inspectable.

5. **Discovery is contextual before exhaustive.**  The palette ranks actions
   applicable to the current screen, selection, lifecycle phase, and pending
   attention.  It initially shows a bounded contextual set and collapsed
   categories, with search and explicit expansion providing the complete
   catalog.  The selected command carries a visible cursor, description,
   shortcut, authority/effect summary, and disabled reason.  Footer hints show
   the current focus and pending chord rather than a global key dump.

6. **The structured scene carries semantics needed by native widgets.**  Pane
   content alignment, scroll behavior, active overlay/editor metadata, focus,
   and detail targets are typed fields, never inferred from strings in
   `OpenTuiRenderer`.  Initial native adoption prioritizes bottom alignment,
   retained sticky-bottom chronology scrolling, focus/click treatment,
   capability/theme updates, and deterministic renderer diagnostics.  Native
   textarea, Markdown, code, links, and clipboard are adopted only where their
   public API preserves reducer authority, trust boundaries, monochrome
   output, and the stdout fallback.

7. **Adaptive hierarchy replaces peer-screen sprawl.**  Console owns the
   default dream-to-result path.  Tree, plan, agents/flight control,
   governance/evidence, diff review, recovery, output, and configuration stay
   fully reachable but open as contextual lenses for the selected timeline
   item.  Wide mode may dock a bounded rail; compact mode hides or overlays it
   and explicitly labels the layout.  Selected rows use marker plus semantic
   emphasis, never color alone.

8. **Polish is accepted through the real product path.**  Automated proofs
   cover bottom anchoring, multiline editing, input ownership, semantic event
   ordering, contextual palette behavior, selection/focus, 80x24 and 120x40
   layouts, renderer parity, and native recording.  Final acceptance is a tmux
   recording in which a layperson enters one text description for a complex
   website and can follow plan, questions, agents, tools/tests, review, and
   completion without leaving the conversational shell except through a
   deliberate contextual inspector.

## Consequences

The default experience becomes familiar without discarding Revoy's unique
governance: a user can type a dream where they expect, keep their eyes on one
chronology, and encounter decisions exactly where work pauses.  Revoy-specific
tree search, provenance, critic, clearance, and evidence remain inspectable
but no longer compete equally for first-run attention.  Sparse screens gain a
stable spatial rhythm, long sessions gain bounded density, and narrow
terminals preserve the same task path.

The structured scene and input bridge become more complex.  Retained native
scroll/edit widgets require explicit ownership and synchronization tests, and
the stdout renderer must remain a truthful fallback rather than a second-class
snapshot.  Contextual ranking also requires a declared scoring vocabulary so
an action cannot disappear merely because a heuristic changed.  Timeline
compression must never erase an authority transition or imply that claimed
work is verified.

This record does not authorize copying another harness's source, wording,
visual identity, or undisclosed behavior.  Public implementations and docs
were studied for interaction categories; Canopy's expressions, contracts,
fixtures, and render logic remain independently authored.  It also does not
upgrade the OpenTUI dependency merely for novelty: public APIs already present
in the pinned version are preferred unless a separately verified capability
requires a version change.

## Alternatives / Roads not taken

**Keep ADR-122's floating composer and decorate the empty lower pane.**
Rejected.  The stable input location is itself a usability contract; filling
the gap with telemetry leaves the operator searching vertically whenever
content volume changes.

**Make every one of the 43 screens independently frontier-polished.**
Rejected.  It preserves the navigation and comprehension problem.  Deep
screens remain complete inspectors, while the primary journey is compressed
into Console and opens them with context.

**Replace the entire renderer with native OpenTUI widgets in one pass.**
Rejected.  The current reducer, stdout fallback, deterministic scene tests,
and authority routing are valuable.  A wholesale swap would create ambiguous
input ownership and make visual parity harder to prove.  Typed scene semantics
allow incremental native advantages without string parsing or a second model.

**Raise visual excitement through constant animation, gradients, and color.**
Rejected.  Motion is reserved for in-flight work and one-shot transitions;
blocking state uses words, glyphs, position, and focus before color.  Routine
evidence and history remain calm.

**Show raw tool, gate, critic, and diff output in the main transcript.**
Rejected.  Audit completeness and conversational legibility are compatible
when compact cards retain exact durable detail targets.  Repetition is not
provenance.

## Recorded acceptance evidence

The accepted r6 pilot is bound by
`artifacts/tui-pilot/adr149-r6-evidence.json`.  Its 799-second source is a real
tmux recording of a provider-backed Lumen Assembly build, including the
persisted Aurora Teal interview, exact four-file plan, governed specialist,
independent critic and machine verification, unified and split diff review,
adoption, browser acceptance, one-file corrective campaign, and final
adoption.  The repository also retains the disclosed 240-second sizzle, the
raw recording's 0–100% frame review at ten-percent intervals, a separate
80×24 recording, all 43 registered-screen comparisons, the complete
greenfield lifecycle comparison, and the validated Revoy control-loop map.
The manifest records paths, source ranges, campaign and node identities,
target commits, media and screenshot hashes, and the target acceptance rerun.

## Obligations

### O1 — Composer placement and editing remain stable across renderers and terminal sizes

The composer occupies the bottom of the primary pane at wide, 120x40, 80x24,
and resized layouts; multiline input, paste, cursor, submit, and fallback
rendering preserve one canonical buffer.

<!-- proof: symbol=consoleScreen file=packages/arbor-tui/src/screens/console.ts roundtrip=packages/arbor-tui/tests/screens-console.test.ts -->

### O2 — The main timeline covers every material governed lifecycle class without raw-log density

Canonical session, durable user-input, governed task-intake, and narrated
supplemental lifecycle facts each have a compact semantic projection that
retains source identity, exact event kind, lifecycle, bounded detail, and
canonical-versus-supplemental truth. Structural DevTools bookkeeping is not
promoted into a fabricated lifecycle event.

<!-- proof: symbol=buildOperatorViewModel file=packages/arbor-tui/src/operator-view-model.ts roundtrip=packages/arbor-tui/tests/operator-view-model.test.ts -->

### O3 — Contextual discovery is bounded, complete, and truthful

Palette ranking produces a bounded current-action set, collapsed categories
still expose every registered command, selection/disabled state is visible in
color and monochrome, and pending key chords are surfaced.

<!-- proof: symbol=paletteView file=packages/arbor-tui/src/overlays.ts roundtrip=packages/arbor-tui/tests/widgets-overlays.test.ts -->

### O4 — Native OpenTUI capabilities never create a second authority or a renderer-only behavior

Typed scene metadata drives alignment, scrolling, focus, and editor behavior;
the native and stdout paths agree on content and action identity, and every
input event causes at most one reducer edit and one governed submission.

<!-- proof: symbol=renderScene file=packages/arbor-tui/src/renderer.ts roundtrip=packages/arbor-tui/tests/frame.test.ts -->
<!-- proof: symbol=OpenTuiRenderer file=packages/arbor-tui/src/opentui-renderer.ts roundtrip=packages/arbor-tui/tests/opentui-renderer.test.ts -->

### O5 — Attention, progressive disclosure, and contextual inspectors preserve governance truth

Blocking items outrank routine activity, document rows retain exact source
provenance, stale failures demote without disappearing, and no claimed or
critic-approved state is rendered as verified.

<!-- proof: symbol=selectOperatorAttention file=packages/arbor-tui/src/operator-view-model.ts roundtrip=packages/arbor-tui/tests/operator-view-model.test.ts -->

### O6 — The accepted recording proves the complete layperson journey in the real TUI

An independently reviewed tmux recording starts from one text description,
builds a complex website through the governed lifecycle, exercises every
visible Console control plus required contextual inspectors, ends with green
project verification, and is reviewed at 10-percent frame intervals.

<!-- unverifiable: the completed runtime acceptance is an externally recorded tmux/browser artifact bound by artifacts/tui-pilot/adr149-r6-evidence.json, not an exported source symbol that the proof-triple grammar can resolve; its media hashes, frame review, target commits, durable campaign records, and acceptance rerun are recorded there. -->
