# TUI wave 2 — widen the port, earn the renderer

**Branch:** `feat/bun-runtime-migration` (wave 1) → wave 2 continues on it.
**Written:** 2026-08-07. **Predecessor:** `docs/bun-migration-plan.md`.

## Why wave 2 exists

Wave 1 moved revoy2 to Bun and proved an OpenTUI renderer works behind the
existing `RendererPort`. It also proved that proving it was not enough:

```ts
export interface RendererPort {
  enter(): void | Promise<void>;
  render(frame: string): void | Promise<void>;   // <- a flattened string
  restore(): void | Promise<void>;
}
```

`TerminalPainter` discards every pane and cell boundary before `render()` is
called, so an OpenTUI adapter can only receive one opaque `TextRenderable`.
**Mouse hit-testing, native scroll regions, and retained-tree diffing cannot
cross a `string` boundary.** Those are the entire reason OpenTUI was adopted.

ADR-011's obligation **O4** — "the renderer can be replaced or driven
headlessly without touching the core" — is *true*, mechanically resolvable, and
green. It attests the port exists. Nobody ever checked the port was wide enough
to be worth having. That is the second time in this codebase an obligation has
been satisfied while the thing everyone assumed it guaranteed was false (the
first: O4 attested the port abstraction while ADR-011's *renderer choice*
silently drifted to a from-scratch implementation that was neither Ink nor
OpenTUI). Wave 2 fixes the substance and the obligation together.

## Governing constraint

**Do not break the headless core.** ADR-011's Elm-style model/update/effect
architecture is the reason this TUI is testable at all. Widening the port must
not leak rendering concerns into `update.ts` or the screen modules, and must
not require adopting a reactive UI framework. If a proposed design does either,
it is the wrong design — say so rather than building it.

## Lanes (strictly file-disjoint)

| Lane | Concern | Owns | Must not touch |
|---|---|---|---|
| **E — output & port** | Widen `RendererPort` to carry structured frame data; make the OpenTUI renderer consume it; ADR-037 | `packages/arbor-tui/src/renderer.ts`, `frame.ts` (new), `shell.ts`, `opentui-renderer.ts`, `widgets.ts`, `decisions/ADR-037-*.md`, new tests for these | `update.ts`, `types.ts`, `navigation.ts`, `overlays.ts`, `default-catalog.ts`, `keyboard.ts`, anything outside `arbor-tui` |
| **F — input & model** | Per-screen scroll offsets, the `Overlay` union, mouse/scroll event ingestion at the input layer | `packages/arbor-tui/src/update.ts`, `types.ts`, `navigation.ts`, `overlays.ts`, `default-catalog.ts`, `keyboard.ts`, `input*.ts`, new tests for these | `renderer.ts`, `frame.ts`, `shell.ts`, `opentui-renderer.ts`, anything outside `arbor-tui` |
| **G — boundaries & reachability** | Break the `@arbor/mcp` ↔ `@arbor/opencode` cycle; restore tsconfig project references; make the OpenTUI renderer reachable; correct `AGENTS.md` | `packages/arbor-opencode/**`, `packages/arbor-mcp/src/tui.ts`, `packages/arbor-tui/src/index.ts`, `packages/*/tsconfig.json`, `AGENTS.md` | all of `arbor-tui/src` except `index.ts` |

## Known facts (verified in wave 1 — confirm, do not assume)

- `@opentui/core@0.5.1` is pinned in `packages/arbor-tui/package.json`. It
  renders under Bun 1.3.14 and **fails on Node** (`OpenTUI native FFI is not
  available for this runtime yet`). It also fails inside vitest even when
  vitest is launched via `bun x`, because vitest runs tests in Node workers.
  **All OpenTUI tests must be `bun:test` and run with `bun test <path>`.**
- `@opentui/core` is `0.x` — per SemVer the public API is unstable and may
  change at any time. It is pinned exactly. Do not widen the range.
- Useful `@opentui/core` exports: `ScrollBoxRenderable`, `SelectRenderable`,
  `InputRenderable`, `TextTableRenderable`, `DiffRenderable`, `CodeRenderable`,
  `BoxRenderable`, `TextRenderable`, `StyledText`, `measureText`.
  `@opentui/core/testing`: `createTestRenderer`, `ManualClock`, `createMockKeys`,
  `createMockMouse`, `TestRecorder`, `KeyCodes`, `MouseButtons`.
- Current render path: `renderScene()` builds a `string[][]` canvas via
  `layoutWorkspace()` pane rects, short-circuits through
  `composeOverlay → confirmationOverlay → resolveActiveScreen → fallback`, and
  overwrites `canvas[rows-1]` with a status bar the layout never reserved.
  `TuiShell` runs a 16ms change clock and a 120ms animation clock;
  `StdoutRenderer` diffs joined row strings and repaints changed rows.
- `@arbor/opencode` → `@arbor/mcp` is **type-only in both call sites**
  (`canonical-adapter.ts:13`, `loop.ts:28`), so it erases at runtime. It is a
  real cycle in the source graph that `tsc --build` does not reject only
  because `packages/arbor-opencode/tsconfig.json` declares **no** project
  references at all. `AGENTS.md` documents `@arbor/opencode` as depending on
  core/prompts — the manifest and the imports both disagree with it.
- Missing dependency declarations were fixed at wave-1 integration
  (`arbor-mcp` += `@arbor/opencode`; `arbor-opencode` += `@arbor/core`,
  `@arbor/audit`). `tsc --build` exits 0.

## Definition of done

1. `RendererPort` carries enough structure for a renderer to hit-test a click
   and drive a native scroll region. Demonstrated, not asserted.
2. The existing `StdoutRenderer` still works through the widened port with no
   regression — it may flatten internally.
3. The OpenTUI renderer consumes structured frames and demonstrably does at
   least one thing the string port made impossible.
4. `bun run build` (`tsc --build`) green; the full suite green under whatever
   runner wave 1's test lane settled on; all gates that passed in wave 1 still
   pass.
5. ADR-037 records the port widening, supersedes ADR-011's O4 obligation with
   one that actually constrains port *sufficiency*, and carries
   machine-checkable obligations.
6. The `@arbor/mcp` ↔ `@arbor/opencode` cycle is gone or explicitly accepted in
   an ADR with reasoning. `AGENTS.md`'s package-boundary table matches reality.
7. Nothing is dead: whatever is built is reachable from the live `arbor tui`
   path, per the repository's own "dead code is incomplete code" rule.

## Non-negotiable

No placeholder implementations, no stubbed rendering, no TODO standing in for
required behavior. No test deleted, skipped, or weakened to make a run green.
A blocked item is reported with reasoning — never quietly dropped.

Exact counts of tests, files, ADRs, or catalog kinds written into any document
become live claims the SUR-05 gate checks on every run. Omit them, or mark
point-in-time measurements with the historical marker (`sur-05` + `:historical`,
see `packages/arbor-governance/src/counts/check.ts`).
