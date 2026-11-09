/// <reference types="bun-types" />
// bun:test only (ADR-036) — @opentui/core's native render library does not
// bind under Node, and fails identically inside vitest even when vitest
// itself is launched via `bun x` (Node workers).
// Run with: bun test packages/arbor-tui/tests/opentui-narrow-width.test.ts
//
// OT-4 (narrow-width degrade): the layout is still hand-computed pixel math
// (navigation.ts's layoutWorkspace), not Yoga flexbox -- adopting Yoga for
// the shared frame scaffolding was assessed and not completed this pass (see
// this record's commit message for the documented boundary). What IS in
// scope regardless of that boundary: proving the EXISTING layout degrades
// sanely at real terminal sizes an operator actually hits, through the REAL
// native OpenTuiRenderer, not just navigation.test.ts's pure geometry
// assertions -- a real render pass exercises BoxRenderable/TextRenderable
// construction with those exact dimensions, which pure geometry math cannot.
import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createNavigation, initialModel, renderScene, type RenderProjection } from "../src/index.js";
import { paintScene } from "../src/renderer.js";
import { OpenTuiRenderer } from "../src/opentui-renderer.js";

function twoPaneProjection(columns: number, rows: number): RenderProjection {
  return {
    app: initialModel(),
    output: "generic",
    navigation: createNavigation(
      { id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "left", title: "Left" }, { id: "right", title: "Right" }] },
      { columns, rows },
    ),
  };
}

/** No two panes in the scene occupy the same cell -- the narrow-width "no overlap" contract this record needs to prove for the real renderer, not just layoutWorkspace's own pure geometry. */
function panesOverlap(panes: readonly { x: number; y: number; columns: number; rows: number }[]): boolean {
  for (let i = 0; i < panes.length; i += 1) {
    for (let j = i + 1; j < panes.length; j += 1) {
      const a = panes[i]!;
      const b = panes[j]!;
      const xOverlap = a.x < b.x + b.columns && b.x < a.x + a.columns;
      const yOverlap = a.y < b.y + b.rows && b.y < a.y + a.rows;
      if (xOverlap && yOverlap) return true;
    }
  }
  return false;
}

let setup: TestRendererSetup | null = null;
let renderer: TestRenderer | null = null;

afterEach(() => {
  renderer?.destroy();
  setup = null;
  renderer = null;
});

describe("OpenTuiRenderer at real narrow terminal sizes (OT-4 — no crash, no pane overlap)", () => {
  test("80x24 (navigation.ts's MIN_COLUMNS/MIN_ROWS split floor): renders without throwing, panes stay non-overlapping", async () => {
    setup = await createTestRenderer({ width: 80, height: 24 });
    renderer = setup.renderer;
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();

    const projection = twoPaneProjection(80, 24);
    const scene = renderScene(projection);
    expect(() => adapter.render({ text: paintScene(scene, {}), scene })).not.toThrow();
    await setup.renderOnce();

    expect(panesOverlap(scene.panes)).toBe(false);
    for (const pane of scene.panes) {
      expect(pane.x).toBeGreaterThanOrEqual(0);
      expect(pane.y).toBeGreaterThanOrEqual(0);
      expect(pane.x + pane.columns).toBeLessThanOrEqual(80);
    }
    expect(setup.captureCharFrame().length).toBeGreaterThan(0);
  });

  test("120x40 (the compact interactive acceptance size): renders a native two-pane frame without overflow or overlap", async () => {
    setup = await createTestRenderer({ width: 120, height: 40 });
    renderer = setup.renderer;
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();

    const projection = twoPaneProjection(120, 40);
    const scene = renderScene(projection);
    expect(() => adapter.render({ text: paintScene(scene, {}), scene })).not.toThrow();
    await setup.renderOnce();

    expect(panesOverlap(scene.panes)).toBe(false);
    for (const pane of scene.panes) {
      expect(pane.x).toBeGreaterThanOrEqual(0);
      expect(pane.y).toBeGreaterThanOrEqual(0);
      expect(pane.x + pane.columns).toBeLessThanOrEqual(120);
      expect(pane.y + pane.rows).toBeLessThanOrEqual(40);
    }
    expect(setup.captureCharFrame().length).toBeGreaterThan(0);
  });

  test("60x20 (below the split floor -- collapses to single-pane compact mode): renders without throwing or overlap", async () => {
    setup = await createTestRenderer({ width: 60, height: 20 });
    renderer = setup.renderer;
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();

    const projection = twoPaneProjection(60, 20);
    const scene = renderScene(projection);
    expect(() => adapter.render({ text: paintScene(scene, {}), scene })).not.toThrow();
    await setup.renderOnce();

    expect(panesOverlap(scene.panes)).toBe(false);
    expect(setup.captureCharFrame().length).toBeGreaterThan(0);
  });

  test("a resize from 80x24 down to 40x10 mid-session renders the next frame without throwing", async () => {
    setup = await createTestRenderer({ width: 80, height: 24 });
    renderer = setup.renderer;
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();

    const wideScene = renderScene(twoPaneProjection(80, 24));
    adapter.render({ text: paintScene(wideScene, {}), scene: wideScene });
    await setup.renderOnce();

    const narrowScene = renderScene(twoPaneProjection(40, 10));
    expect(() => adapter.render({ text: paintScene(narrowScene, {}), scene: narrowScene })).not.toThrow();
    await setup.renderOnce();

    expect(panesOverlap(narrowScene.panes)).toBe(false);
  });
});
