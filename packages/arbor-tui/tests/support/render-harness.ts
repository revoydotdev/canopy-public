/**
 * Test-only rendering helpers.
 *
 * WHY THESE LIVE HERE AND NOT IN `src/`. Both symbols below were defined in
 * `src/renderer.ts` and re-exported from the package's public surface
 * (`src/index.ts`), which advertised them as product capability. Neither is:
 * `.visual-intelligence` flagged them as `unreachable-production` and
 * `test-only-reachable` (findings `vi:d527fa1dcc8f6d01`, `vi:31e70181918a7bef`),
 * and a check of every consumer confirmed it — outside their own definitions
 * their only mentions in `src/` are two doc comments, and no package other than
 * `@arbor/tui` imports them at all.
 *
 * The finding was about SURFACE, not existence. Deleting them would have
 * destroyed live infrastructure for nine suites to satisfy a misread; leaving
 * them exported kept the public API lying about what the package offers.
 * Moving them here resolves both: the helpers keep working, and the package
 * stops claiming them.
 *
 * They are deliberately thin. `renderTerminalFrame` is a two-line convenience
 * over the real `paintScene(renderScene(...))` composition that `TuiShell`
 * drives in production, and `MemoryRenderer` is a double at the `RendererPort`
 * boundary — a genuine seam, which is the only place a double belongs. Neither
 * reimplements behaviour, so neither can drift from the real path.
 */

import { paintScene, renderScene, type FrameOptions, type RenderInput, type RenderProjection, type RenderedFrame, type RendererPort } from "../../src/renderer.js";
import type { SceneFrame } from "../../src/frame.js";

/**
 * Pure, terminal-size-bounded rendering of an existing projection: compose the
 * scene and flatten it exactly as the production draw path does.
 *
 * Production composes the scene ONCE per draw and hands both the text and the
 * scene to `render()` (ADR-037), rather than calling this and re-running
 * `renderScene`. Tests that only need the flattened text use this instead of
 * repeating the two-call composition in nine files.
 */
export function renderTerminalFrame(projection: RenderProjection, options: FrameOptions = {}): string {
  return paintScene(renderScene(projection, options), options);
}

/**
 * The structured form of `renderTerminalFrame` for exercising RendererPort.
 * It preserves the single scene composition production performs per draw.
 */
export function renderStructuredFrame(projection: RenderProjection, options: FrameOptions = {}): RenderedFrame {
  const scene = renderScene(projection, options);
  return Object.freeze({ text: paintScene(scene, options), scene });
}

/**
 * Recording `RendererPort` double. `frames` stays a `string[]` of flattened
 * text — unchanged shape and value semantics from before ADR-037
 * (`renderer-shell.test.ts`/`frame-pacing.test.ts` assert `.toBe` equality
 * between entries, which relies on JS string value equality; two draws of
 * unchanged content must still produce the identical string, not merely an
 * equal-but-distinct wrapper object). `scenes` is the ADR-037 addition,
 * parallel-indexed because every renderer input is structured.
 */
export class MemoryRenderer implements RendererPort {
  readonly frames: string[] = [];
  readonly scenes: SceneFrame[] = [];
  enterCount = 0;
  restoreCount = 0;
  enter(): void { this.enterCount += 1; }
  render(frame: RenderInput): void {
    this.frames.push(frame.text);
    this.scenes.push(frame.scene);
  }
  restore(): void { this.restoreCount += 1; }
}

/**
 * Explicit structured fallback for direct renderer tests with no pane
 * geometry. `columns` defaults to the longest line's length, matching every
 * existing single-frame caller; a caller that renders two frames through the
 * same `StdoutRenderer` to exercise diffing at a *stable* terminal width
 * (content changes, the screen does not resize) must pass `columns`
 * explicitly and hold it constant across both calls — `StdoutRenderer` now
 * treats an observed `scene.columns` change between frames as a real resize
 * (a physical terminal reflows/clears out-of-band on resize, independent of
 * any diff cache) and forces a full repaint, so leaving `columns` derived
 * from content would misreport an ordinary content-length change as one.
 */
export function textOnlyFrame(text: string, columns?: number): RenderedFrame {
  return Object.freeze({
    text,
    scene: Object.freeze({
      columns: columns ?? Math.max(1, ...text.split("\n").map((line) => line.length)),
      rows: Object.freeze(text.split("\n")),
      panes: Object.freeze([]),
      status_row: null,
    }),
  });
}
