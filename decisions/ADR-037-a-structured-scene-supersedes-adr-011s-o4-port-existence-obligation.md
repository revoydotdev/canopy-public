# ADR-037: A Structured Scene Supersedes ADR-011's O4 Port-Existence Obligation

**Status:** Accepted
**Date:** 2026-08-07

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR governance
by ADR-024's ratification note), and POL-05 flags any record arriving already
accepted as never having traversed the lifecycle.

**Scope.** This record supersedes only ADR-011's obligation **O4**
(`decisions/ADR-011-tui-cockpit-architecture.md:71-76`). ADR-011's Decision,
Consequences, Alternatives, and obligations O1, O2, O3, O5 are untouched.
ADR-036's Decision, Consequences, and its own O1-O4 are also untouched — this
record extends ADR-036 rather than revisiting it: ADR-036 proved a second
`RendererPort` implementation exists and is proven against a real native
renderer; ADR-036's own "Alternatives considered #4" explicitly deferred
widening the port itself as "a materially bigger change... out of this
record's scope," naming it the prerequisite for closing `audit/
tui-remediation-presentation.md`'s IQ-01 (mouse). This record is that
deferred pass.

## Context

### O4 was satisfiable by an interface that could not do anything

ADR-011's obligation O4 reads, in full:

> Rendering is an adapter behind a pure renderer contract. The renderer can be
> replaced or driven headlessly without touching the model/update core,
> supporting deterministic testing and reconnect/resume.
>
> `<!-- proof: symbol=RendererPort file=packages/arbor-tui/src/renderer.ts
> roundtrip=packages/arbor-tui/tests/renderer-shell.test.ts -->`

**VERIFIED, by direct inspection of this repository before this record's
changes:** `RendererPort` was

```ts
export interface RendererPort {
  enter(): void | Promise<void>;
  render(frame: string): void | Promise<void>;
  restore(): void | Promise<void>;
}
```

(`packages/arbor-tui/src/renderer.ts:17-21`, pre-widening). `render(frame:
string)` received a single already-flattened blob:
`renderer.ts#renderScene` (`:36-57`, pre-widening) computed real pane
rectangles via `layoutWorkspace` (`navigation.ts#layoutWorkspace`), then
`drawPane`/`put` (`:150-183`) baked glyphs directly into a shared `string[][]`
canvas and joined it to one string before a renderer ever saw it. ADR-036
already found and named this precisely
(`decisions/ADR-036-...md:112-134`): a second, real, structurally different
`RendererPort` implementation (`OpenTuiRenderer`, backed by `@opentui/core`'s
native Zig renderer) was built and proven against `@opentui/core/testing`'s
real test harness — and it could do nothing with the pane structure
`@opentui/core`'s own primitives (`ScrollBoxRenderable`, per-`Renderable`
`onMouseDown`) are built around, because that structure never crossed
`render(frame: string)`'s boundary. ADR-036's own words: *"A framework swap
behind this exact port cannot close IQ-01 (mouse)... Realizing OpenTUI's
structural advantages would require widening `RendererPort` to pass a
structured scene... instead of a pre-joined string."*

O4's proof comment is real: `RendererPort` is genuinely an interface, a
second implementation genuinely exists, and `renderer-shell.test.ts` genuinely
exercises it. Every field in the proof resolves. **And none of that was ever
going to detect the interface being too narrow to be worth having**, because
`packages/arbor-governance/src/obligation/parse.ts`'s proof grammar (`symbol=`/`file=`/`roundtrip=`) can only
attest that a named thing exists and a named test collects — it has no way to
express "and this interface actually carries what a consumer needs." This is
the second time in this codebase's ADR history that an obligation attesting a
seam's *existence* was satisfied while a load-bearing property of the seam's
*sufficiency* went unchecked (the first, per ADR-036's own Context section,
was O4 attesting the port abstraction while ADR-011's named renderer *choice*
silently drifted to an unauthorized fourth implementation). The mechanism
recurring twice is the actual finding this record responds to.

### What "sufficient" means here, made concrete before being formalized

The plan of record (`docs/tui-wave2-plan.md`) names two concrete capabilities
a renderer needs pane structure for: hit-testing a click to a pane and a row,
and driving a native scroll region. This record widens the port to carry both
kinds of information (§ Decision, item 1) and **proves the first one for
real** against `@opentui/core`'s own native input pipeline — not this
package's own arithmetic standing in for it (§ Decision, item 3, and see
"Alternatives considered" for why hit-testing and not scrolling was the one
demonstrated this pass).

### The widened contract

`packages/arbor-tui/src/frame.ts` (new):

```ts
export interface FramePane extends PaneRect {
  readonly title: string;
  readonly content: readonly string[];
}

export interface SceneFrame {
  readonly columns: number;
  readonly rows: readonly string[];
  readonly panes: readonly FramePane[];
  readonly status_row: number | null;
}

export interface PaneHit {
  readonly pane_id: string;
  readonly row_in_pane: number;
  readonly column_in_pane: number;
}

export function hitTestFrame(
  scene: SceneFrame,
  point: { readonly column: number; readonly row: number },
): PaneHit | null;
```

`packages/arbor-tui/src/renderer.ts`:

```ts
export interface RenderedFrame {
  readonly text: string;
  readonly scene: SceneFrame;
}
export type RenderInput = RenderedFrame | string;

export interface RendererPort {
  enter(): void | Promise<void>;
  render(frame: RenderInput): void | Promise<void>;
  restore(): void | Promise<void>;
}
```

`renderScene` (`renderer.ts:68-102`) now returns a `SceneFrame`, not a bare
`Frame`: the same `columns`/`rows` composition it has always produced
(byte-identical — `packages/arbor-tui/tests/frame.test.ts`'s "is still exactly the composition
`renderTerminalFrame` flattens" case asserts this directly), plus `panes`: the
pane rectangles `layoutWorkspace` already computed and this function
previously discarded once `drawPane` finished painting them into the shared
canvas, each carrying its own already-composed interior `content` rows.
`TuiShell.draw()` (`shell.ts`) builds the `SceneFrame` once per draw and hands
both the flattened text (via the new `paintScene` helper, extracted from what
was `renderTerminalFrame`'s inline `TerminalPainter` call) and the scene
itself to `render()` — the scene is computed once per frame, not twice, and
is no longer thrown away before the port boundary.

**The bare-`string` arm of `RenderInput` remains an interoperability arm, not
a second interactive renderer path.** The cockpit's help overlay now lives in
`AppModel` and is composed through `renderScene` with the live configured
catalog, so it no longer bypasses `TuiShell`. The arm remains required for
embedders and `packages/arbor-tui/tests/renderer-shell.test.ts`, which calls
`StdoutRenderer.render("frame1")` and similar literal strings directly
(`renderer-shell.test.ts:208-243`). A `RendererPort` implementation MUST
accept both forms honestly — `StdoutRenderer` flattens either to the same
text and diffs it exactly as before; `OpenTuiRenderer` treats a bare string as
the same full-viewport fallback ADR-036 always used, since a raw string
carries no pane structure to hit-test against by construction, not by an
arbitrary choice this record makes.

## Decision

1. **`RendererPort.render` accepts `RenderedFrame | string`, not a bare
   string.** `RenderedFrame` carries both the pre-flattened text (identical to
   what `renderTerminalFrame` has always produced) and the `SceneFrame`
   structure — additive, not a replacement of the string form, because
   `StdoutRenderer` and external/embedding callers still need the string form
   to keep working unchanged.

2. **`StdoutRenderer` flattens internally; its diffing behavior is
   unchanged.** `render(input)` normalizes to `typeof input === "string" ?
   input : input.text` and runs the exact same row-diff logic
   (`renderer.ts:277-299`) it ran before this record. Verified two ways:
   (a) `packages/arbor-tui/tests/renderer-shell.test.ts`'s three `StdoutRenderer` tests — wave
   1's own file, unmodified by this record — pass unchanged, still calling
   `.render("frame1")`, `.render("aaa\nbbb")` etc. with literal strings
   directly against the widened signature; (b) `packages/arbor-tui/tests/frame.test.ts`'s new
   "StdoutRenderer diffs a structured RenderedFrame's `.text` exactly as it
   always diffed a bare string" case exercises the identical diff logic
   through the new `RenderedFrame` arm and asserts the same positioned-escape
   output shape (`[2;1H`, changed-row-only) the string-only tests
   already assert.

3. **`OpenTuiRenderer` consumes the structure for real, proving per-pane
   native hit-testing — not scrolling — as this pass's demonstrated
   capability.** Given a `RenderedFrame`, it builds one `BoxRenderable` +
   interior `TextRenderable` per pane in `scene.panes`, positioned/sized from
   that pane's real rectangle (`opentui-renderer.ts#syncPanes`), and attaches
   a real `onMouseDown` handler to **both** the box and its content sibling
   (they are added as root siblings, not nested, so a click landing on the
   interior — which native z-ordering resolves to the content renderable, not
   the box beneath it — must be handled on both to be caught at all; this was
   found and fixed empirically during this record's own verification, not
   assumed). `@opentui/core`'s native hit-grid — `addToHitGrid`/`checkHit`,
   populated during each renderable's own real render pass, the same
   mechanism a real terminal mouse click resolves against — decides which
   renderable a point belongs to; this module's own arithmetic only
   translates the resolved renderable's known rectangle into a local
   row/column. `packages/arbor-tui/tests/opentui-hit-test.test.ts` (new, `bun:test` only) proves
   this against `@opentui/core/testing`'s real `createTestRenderer` and real
   `createMockMouse` (which emits a genuine SGR mouse ANSI sequence into the
   renderer's real `stdin`, exercising the actual terminal-input parsing
   path, not a shortcut around it): a click at a computed point inside the
   "right" pane resolves to `{pane_id: "right", row_in_pane, column_in_pane}`
   matching `hitTestFrame`'s independently-computed answer for the same
   point; a click on the reserved status row resolves to no pane at all
   (matching `hitTestFrame`'s `null`); and reverting to the legacy bare-string
   path tears the pane hit regions down rather than leaving stale ones behind
   a now-unrelated full-viewport blob. All 4 tests pass, 12 `expect()` calls,
   `bun test packages/arbor-tui/tests/opentui-hit-test.test.ts`.

4. **A native scroll region is designed for, not implemented, this pass.**
   `SceneFrame`'s per-pane `content` is already the height-clipped interior a
   screen module rendered (bounded to `pane.rows - 2` by `resolveActiveScreen`
   today) — there is no overflow content past the viewport for a
   `ScrollBoxRenderable` to prove a real scroll advantage against yet. That
   requires the per-screen scroll offsets `AppModel.scrollOffsets`
   (`types.ts`, Lane F's wave2/tui-input-model retrofit, landed concurrently
   with this record) to actually widen what a screen module renders beyond
   one page — a change to `update.ts`/screen modules this record's file
   ownership does not include and the plan of record assigns elsewhere. This
   record's `FramePane` rect is what a future pass would hand a
   `ScrollBoxRenderable`; wiring one is out of scope here, named rather than
   silently dropped (see "Alternatives considered").

5. **Interactive selection crosses the renderer boundary only as a typed
   row identity.** `ScreenProjection.row_ids` is aligned with its rendered
   rows. The cockpit first verifies an OpenTUI pane hit against the same
   `SceneFrame` via `hitTestFrame`, then resolves the displayed absolute row
   through `row_ids` and dispatches `select_row_identity`. It never dispatches
   a raw array index for a click: a refresh between paint and input therefore
   cannot retarget an operator action to a different durable record. Missing
   or `null` identities are intentionally non-selectable.

## Consequences

**Positive.** The gap ADR-036 named — "the port is replaceable" (old O4, was
true) but "the port carries enough to matter" (never checked) — is closed for
one concrete, load-bearing capability, proven against a real native input
pipeline rather than claimed. A future pass building `ScrollBoxRenderable`
support inherits `SceneFrame`'s pane rects for free; it does not need to widen
the port again.

**Positive, concretely, an empirical finding.** Verifying this record's own
`OpenTuiRenderer` change surfaced a real bug that a purely typed design review
would not have caught: attaching `onMouseDown` only to a pane's `BoxRenderable`
silently fails for any click inside the pane's *interior*, because the
interior `TextRenderable` (a root sibling, added after the box, so it wins
`@opentui/core`'s native z-order for its own cells) intercepts the event
first and mouse events do not bubble between root siblings — only up a parent
chain. This was found only by running the real synthetic-click test against
the real renderer and observing zero dispatched hits despite every static
signal (registration, `hitTest()`, `shouldStartSelection()`) looking correct
in isolation. The fix (register the identical handler on both the box and its
content sibling, §Decision item 3) is now exercised by
`packages/arbor-tui/tests/opentui-hit-test.test.ts` on every run — this is exactly the class of
defect a symbol-existence proof comment cannot detect and a real dispatched
event can.

**Negative, and honestly disclosed rather than absorbed: the coverage floor
this record measured against is not met by `arbor-tui`'s own test suite
alone.** `npm run test:tui:coverage` (`vitest run packages/arbor-tui/tests
--coverage`, run before this record's obligations were finalized) reports the
package glob `packages/arbor-tui/src/**/*.ts` at **91.15% statements/lines,
94.61% functions** against this repository's own floors of **95%/95%/96%**
(branches, 84.11% on the same run, clears its 75% floor). `opentui-renderer.ts`
itself shows 3.1% statement coverage under this measurement
(`112-299` uncovered) — structurally unavoidable under `vitest`, which
executes tests in Node workers and cannot run `@opentui/core`'s native
render library at all (ADR-036's own finding, unchanged). This record adds
materially more such code than ADR-036's original ~140-line adapter did
(`syncPanes`/`clearPanes`, the per-pane hit-test wiring) — proven for real,
but only by `bun test`, which this repository's `gate:coverage`
(`vitest run --coverage`) cannot see, mirroring exactly the test-collection
split `vitest.config.ts`'s own `exclude: [...,
"packages/arbor-tui/tests/opentui-*.test.ts"]` already accepts for
`opentui-renderer.test.ts`.

**What this record could not verify, stated plainly rather than guessed:**
whether the REPOSITORY-WIDE `gate:coverage` run (which this record's brief
explicitly disallowed running — "Do NOT run the full test suite; targeted
runs only") shows a materially different combined number, e.g. because
`arbor-mcp`'s own test suite exercises more of `arbor-tui/src`'s
non-`opentui-renderer.ts` surface than `arbor-tui`'s own tests alone do. The
number measured and cited above is real and reproducible
(`npm run test:tui:coverage`), but it is a lower bound on the true
repository-wide figure, not necessarily the number `gate:coverage` itself
would report. This is the honest ceiling of what this record's own
verification pass can claim — resolving it needs a run this record's scope
does not authorize.

**No path to close this gap exists inside this record's file ownership.**
`vitest.config.ts`'s `coverage.include`/`exclude` is not owned by any lane
`docs/tui-wave2-plan.md` names (Lane E/F/G) — it was Lane B's territory in
`docs/bun-migration-plan.md` (wave 1), which has already landed. The
mechanical fix this record recommends but does not perform: exclude
`packages/arbor-tui/src/opentui-renderer.ts` from the coverage `include` glob
(mirroring the existing test-collection `exclude` for the same file), the
same way a `bun:test`-only file's *tests* are already excluded from
`vitest`'s collection. Per this repository's own convention ("an honest floor
beats an aspirational one, and a floor is never lowered to make room for a
regression" — `docs/bun-migration-plan.md`), this is reported to the
repository owner, not silently absorbed by weakening the floor or deleting
the new code's real behavior.

**Negative.** `RenderInput`'s bare-`string` arm means a `RendererPort`
implementation that ignores it (e.g. a hypothetical future backend assuming
every input is structured) would throw or misbehave against
`tui.ts`'s help-overlay bypass. This is disclosed in `renderer.ts`'s own
`RenderInput` doc comment rather than left to be discovered; a future
implementation must handle both arms honestly, as `StdoutRenderer` and
`OpenTuiRenderer` both do here.

**Negative.** `OpenTuiRenderer`'s per-pane composition is visual-fidelity-
independent of its predecessor: a structured `RenderedFrame` render no longer
displays the flattened text at all (the fallback `TextRenderable`'s content is
cleared to `""` while panes are active), replaced by native per-pane boxes
with borders/titles/content. This is a real behavior change from ADR-036's
adapter (which always showed the flattened blob) — not a regression against
any committed obligation, but a real difference a future reader comparing
screenshots against ADR-036's adapter would notice and should not mistake for
a bug.

**The premise of that parenthetical has since changed (2026-08-18).** It read:
"ADR-036's O3 already establishes `OpenTuiRenderer` is not reachable from the
production entry point in this pass; nothing today depends on its exact visual
output." O3 is no longer true — the renderer is reachable, as a runtime-gated
opt-in (`ARBOR_TUI_RENDERER=opentui`), so an operator who opts in *does* now
depend on this composition's exact visual output. The default remains
`StdoutRenderer`, so no existing operator is affected. Whether the per-pane
composition is still the right thing to ship on that opt-in path has not been
re-examined against a live terminal since the wiring landed, and is worth its
own look rather than being assumed settled by this record.

## Alternatives considered

1. **Widen the port but keep `OpenTuiRenderer` displaying the flattened text
   as before, adding hit-testing as a side channel only.** Rejected: this
   would prove the port CAN carry structure without proving a renderer can DO
   anything with it — exactly ADR-011's old O4 mistake in a new shape (an
   obligation that is true and vacuous). The demonstrated capability has to
   be load-bearing in what the renderer actually composes, not bolted on
   beside an unchanged visual path.

2. **Demonstrate a native scroll region instead of hit-testing.** Considered
   first, since `docs/tui-wave2-plan.md` names both. Rejected for this pass:
   every screen module today pre-clips its rendered rows to `pane.rows - 2`
   (`resolveActiveScreen`, `renderer.ts`) before a `SceneFrame` is ever built,
   so there is no genuine overflow content past one page for a
   `ScrollBoxRenderable` to prove a real advantage against — feeding it
   already-clipped content would only prove the widget *renders*, not that it
   *scrolls* anything real. Making a screen module emit unclamped content
   keyed to `AppModel.scrollOffsets` is Lane F's `update.ts`/screen-module
   territory (per `docs/tui-wave2-plan.md`'s lane table), landed concurrently
   with this record but not consumed by it — wiring that through to a real
   `ScrollBoxRenderable` is named as follow-up work, not claimed here.
   Hit-testing needed no such upstream dependency: `layoutWorkspace`'s pane
   rectangles already existed and were sufficient on their own.

3. **Register `onMouseDown` only on each pane's `BoxRenderable`, relying on
   event bubbling to cover interior clicks.** Rejected — and this is not a
   hypothetical: it was the first implementation tried, and it silently
   failed every interior click, found only by running the real synthetic-
   click test (see "Consequences," positive-empirical). `@opentui/core`'s
   `Renderable.processMouseEvent` bubbles to `this.parent`, not to a
   z-order-adjacent sibling; the box and its content `TextRenderable` are
   both direct children of `renderer.root`, not parent/child of each other.
   The fix — the same handler closure registered on both renderables — is
   what ships.

4. **Nest each pane's content `TextRenderable` as a child of its
   `BoxRenderable`** (so bubbling alone would route interior clicks to the
   box) instead of adding both as root siblings. Rejected for this pass:
   `@opentui/core`'s `position: "absolute"` semantics for a *nested* child are
   relative to its positioned ancestor, not necessarily the terminal-absolute
   coordinate space this module already computes pane rectangles in
   (`layoutWorkspace`'s `x`/`y` are terminal-absolute) — re-deriving relative
   offsets correctly for every pane shape was a larger, differently-scoped
   change than registering one shared handler twice. The chosen fix is
   smaller, equally correct (proven by the same test), and does not require
   trusting an unverified assumption about nested absolute-position layout
   semantics in a `0.x` library.

5. **Fully replace the flattened-text visual composition with native
   per-pane widgets carrying real borders/colors/wide-glyph handling
   end-to-end**, closing IQ-01 completely rather than proving one seam of it.
   Rejected as out of proportion for this pass: this record's job (per the
   plan of record) is to prove the *port* is sufficient, not to ship a
   production-ready OpenTUI visual renderer — `OpenTuiRenderer` remains
   unreachable from `packages/arbor-mcp/src/tui.ts`'s production entry point
   regardless (ADR-036's O3), so a fuller visual implementation would be work
   with no live consumer yet. The per-pane `BoxRenderable`/`TextRenderable`
   composition built here is real and non-placeholder, but intentionally
   scoped to what proves hit-testing, not to a complete parity rewrite.

## Obligations

### O1 — `SceneFrame` carries every pane's real rectangle and interior content, not a flattened string

<!-- proof: symbol=SceneFrame file=packages/arbor-tui/src/frame.ts roundtrip=packages/arbor-tui/tests/frame.test.ts -->

### O2 — `hitTestFrame` maps an absolute terminal point to its pane and pane-local row/column, or honestly to no pane

No pane is guessed for a point outside every pane's rectangle (the status bar
row, a gutter, or off-frame entirely) — an unmatched point returns `null`,
never a nearest-pane approximation.

<!-- proof: symbol=hitTestFrame file=packages/arbor-tui/src/frame.ts roundtrip=packages/arbor-tui/tests/frame.test.ts -->

### O3 — `StdoutRenderer` accepts the widened `RenderInput` with no behavior change from its pre-widening string-only form

<!-- proof: symbol=StdoutRenderer file=packages/arbor-tui/src/renderer.ts roundtrip=packages/arbor-tui/tests/renderer-shell.test.ts -->

### O4 — Port SUFFICIENCY, not merely port existence: a real, structurally different renderer can resolve a real input event to the correct pane using only `SceneFrame`

Supersedes ADR-011's O4. ADR-011's O4 attested that a renderer implementation
exists behind `RendererPort` and can be exercised headlessly — true then,
still true, and insufficient to prevent the exact narrowness this record
fixes. This obligation instead requires the thing ADR-011's O4 could never
express in its proof grammar: that a *second, structurally different*
`RendererPort` implementation, given only what `SceneFrame` provides, can
register a native per-pane hit region and correctly resolve a **real
synthetic input event delivered through that renderer's own native input
pipeline** — not this package's own coordinate arithmetic standing in for
it — to the same pane and local row/column `hitTestFrame`'s independent, pure
computation produces for the identical point. Stated honestly against this
governance system's own documented ceiling (`packages/arbor-governance/src/obligation/proof.ts`'s module
header): a resolving `roundtrip=` proves the cited test exists and is
collected, not that it passed on any particular run — the actual pass/fail
evidence for this obligation is `bun test
packages/arbor-tui/tests/opentui-hit-test.test.ts`'s own output (6 pass, 0
fail, 18 `expect()` calls, re-verified 2026-08-26; was 4 pass/12 expect() calls
when written), which a
reader must still check, the same ceiling every obligation in this package
inherits.

<!-- proof: symbol=OpenTuiRenderer file=packages/arbor-tui/src/opentui-renderer.ts roundtrip=packages/arbor-tui/tests/opentui-hit-test.test.ts -->

### O5 — The `bun test`-only hit-test proof file is excluded from `vitest`'s collection by name, not silently mis-collected

<!-- unverifiable: an exclusion glob correctly matching a filename is not a source symbol proof= can name; verified instead by vitest.config.ts's exclude list and a real vitest run, cited in the body below -->

`packages/arbor-tui/tests/opentui-hit-test.test.ts` imports `bun:test` and
matches `vitest.config.ts`'s existing `exclude:
["...","packages/arbor-tui/tests/opentui-*.test.ts"]` glob (already landed
for `opentui-renderer.test.ts`, ADR-036's own companion file, before this
record). Verified by running `npx vitest run
packages/arbor-tui/tests/opentui-hit-test.test.ts` directly and observing
`No test files found` against the printed `exclude` list, rather than a
collection crash or a phantom pass — the file is deliberately routed away,
not accidentally invisible.

*No proof comment: this obligation is about an exclusion glob correctly
matching a filename, not a source symbol — `symbol=` has nothing to name, the
same shape ADR-036's own O4 describes for its own harness-collision
obligation.*
