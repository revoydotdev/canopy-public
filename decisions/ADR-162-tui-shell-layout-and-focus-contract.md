# ADR-162: One geometry authority and an explicit focus model for the TUI shell

**Status:** Accepted
**Date:** 2026-09-18
**Authoring Revision:** 0bdefa5b061d7d82c5d2ef2ec31958bc022823fc
**Content ID:** sha256:91484a60bdfdecb818db796b945f58c12986e1f959aabe4c1a324893c6104701

## Context

The TUI-overhaul brief (M2, `docs/tui-overhaul/ui-spec.md`) asks for four things:
- a persistent top band with a left status zone, a central UCT graph rectangle and a right status zone, sized `clamp(floor(rows/3), 8, 12)` including framing;
- a right rail that docks at ≥120×24, becomes an explicit drawer at 80–119 columns, compresses below 80×24, and falls back to a minimal layout with a size warning below 60×16;
- a bottom-anchored composer;
- an explicit, keyboard-first focus model (F6/Shift+F6, a context menu on Shift+F10 backed by the one action registry).

The M0 baseline (`docs/tui-overhaul/baseline.md`) measured the gap in the real binary:
- **D-01:** the UCT band was hard-capped at 2 interior rows (`heroHeight = Math.min(4, …)`).
- **D-02:** the rail docked only at `> 120` columns, so a 120-column terminal got no rail.
- **D-04:** status was one full-width line.
- **D-05:** there was no warning below 60×16.

Geometry lived inline in `renderCockpitScene`, and the flat painter, the OpenTUI painter and hit-testing each consumed its side effects. Nothing could state or test the layout rules as rules.

## Decision

1. **`computeShellLayout` (`packages/arbor-tui/src/layout.ts`) is the only geometry authority for the product shell.** It is a pure function of `{columns, rows, rail, header, composer_lines}` and returns integer rects:
   - the header and its three zones;
   - the transcript and composer;
   - the docked rail or the explicit-open overlay rail;
   - the minimal-mode warning row;
   - a `layout_class` (`docked | drawer | compressed | minimal`).

   The rules are:
   - zone widths depend only on `columns`, never on status text;
   - the zones fold into one row when the graph would be narrower than 24 columns;
   - the docked rail is `min(clamp(floor(cols·0.28), 32, 44), cols − 72)`;
   - the overlay rail never covers the composer.

   `renderCockpitScene` (`renderer.ts`) renders from these rects, emits one `FramePane` per region, and records `layout_class` on the `SceneFrame` (`frame.ts`).
2. **The top band is a framed region.** It has box borders and zone dividers, with an ASCII fallback when `unicode === false`. The left zone shows repository and run identity. The right zone shows attention/blockers first, then active work, then connection health, plus a focus breadcrumb. Each is truncated with an ellipsis inside its own zone. The graph rectangle renders `projectUctHeader` at its exact interior size, and says `UCT: no live campaign` or `UCT: awaiting tree` instead of drawing an empty graph.
3. **Focus is explicit model state.** `AppModel.focus = {zone, rail_tab}` with zones `composer | transcript | rail | graph`. The reducer intents are `focus_zone_cycle`, `focus_zone_set` and `focus_rail_tab`. The F6/Shift+F6 and Shift+F10 catalog actions (`default-catalog.ts`) are decoded from real CSI sequences (`input-terminal.ts`). Shift+F10 opens the existing contextual palette, so a context-menu item is always an existing catalog action, never a second code path.
4. **Pane z-order is array order, and hit-testing is topmost-wins.** OpenTUI paints one opaque box per pane in array order. The header backdrop is emitted before its zones, the composer is carried as metadata on the main pane rather than as a same-rect sibling, and `hitTestFrame` iterates in reverse.
5. **Semantic tokens and text-editing fidelity.** `SEMANTIC_GLYPHS` (`theme.ts`) gives every semantic role (active, governance, success, waiting, failure, muted, selection, focus) a Unicode and an ASCII glyph, so state is never carried by colour alone. `text-buffer.ts` moves and deletes by grapheme cluster (`Intl.Segmenter`).

## Consequences

- Layout rules are testable as rules. Property tests over 1..220 × 1..70 assert that every rect is in bounds, that nothing overlaps except the drawer over the transcript, that the composer is visible whenever `rows ≥ 3`, and that output is deterministic. Cell snapshots pin the six reference viewports.
- Fixing D-02 changed the main-pane width at the common 120-column size (a 120-column terminal now docks the rail). This was a real behaviour change for dependent surfaces:
  - the command palette switches to its compact disclosure;
  - `result-review`'s split-diff threshold moved from 90 to 72 columns (the §2.3 minimum main width), so an explicit split toggle is no longer silently ignored;
  - several end-to-end tests that pinned the old rows and columns now derive coordinates from `computeShellLayout`.
- The taller band leaves less room for the transcript at the same height. Some tall documents (the Config table, DevTools operator facts) now need a PageDown to reach facets that used to be above the fold. No facet was removed.
- Residual, handled in the next M2 slice:
  - the Git/Governance/Inspect rail tabs (the rail still carries the project/adrs/docs/devtools tabs);
  - making `focus.zone` govern key routing (today it is state plus breadcrumb);
  - `/` pane search (it collides with an existing global binding);
  - the band's left and right outer border columns, which zone text currently overwrites.
- Unchanged: the ADR-011 model/update/effect split, the `SceneFrame` port (ADR-037), and the legacy non-console `renderScene` path.

## Alternatives / Roads not taken

- **Adopt a layout engine (flexbox/Yoga through OpenTUI).** Rejected. The stdout painter and hit-testing need the same rects without an OpenTUI runtime. A 200-line pure function is property-testable, and it keeps the ADR-011 rule that rendering concerns do not leak into the reducer.
- **Keep inline geometry and only change the constants.** Rejected. It would fix D-01 and D-02 but leave three consumers deriving geometry independently. The OpenTUI z-order defect found during this work (a decorative pane blacking out the zones drawn before it) is exactly what disagreement between consumers produces.
- **A separate context-menu action set.** Rejected. The brief requires menus, palette and keys to resolve through one action registry. A parallel menu model would be a second privileged path.

## Obligations

### O1 — Shell geometry is a single pure authority that holds its invariants at every size

`computeShellLayout` output is in bounds, non-overlapping (except the drawer over the transcript), keeps the composer visible whenever `rows ≥ 3`, and is deterministic. The roundtrip test checks this over 1..220 × 1..70 and asserts the exact rects at 160×48, 120×36, 100×30, 80×24, 60×18 and 50×14.

<!-- proof: symbol=computeShellLayout file=packages/arbor-tui/src/layout.ts roundtrip=packages/arbor-tui/tests/layout.test.ts -->

### O2 — The rendered shell matches the geometry at the reference viewports

`renderScene` output at each reference viewport, including minimal-mode recovery, is pinned by cell snapshots generated from fixture-only data.

<!-- proof: symbol=renderScene file=packages/arbor-tui/src/renderer.ts roundtrip=packages/arbor-tui/tests/shell-layout-snapshots.test.ts -->

### O3 — Focus traversal is explicit reducer state reached through catalog actions

F6/Shift+F6 cycle `focus.zone` through the real `update()` reducer and catalog bindings. An open overlay keeps ownership of input.

<!-- proof: symbol=FOCUS_ZONE_NEXT_ACTION_ID file=packages/arbor-tui/src/default-catalog.ts roundtrip=packages/arbor-tui/tests/focus-model.test.ts -->

### O4 — Every semantic state has a non-colour carrier

Each semantic role maps to both a Unicode and an ASCII glyph, so focus, selection and severity stay distinguishable in monochrome and ASCII modes.

<!-- proof: symbol=SEMANTIC_GLYPHS file=packages/arbor-tui/src/theme.ts roundtrip=packages/arbor-tui/tests/theme-semantic-glyphs.test.ts -->
