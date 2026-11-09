/// <reference types="bun-types" />
// bun:test only (ADR-036/ADR-037) — @opentui/core's native render library does
// not bind under Node, and fails identically inside vitest even when vitest
// itself is launched via `bun x` (Node workers).
// Run with: bun test packages/arbor-tui/tests/opentui-hit-test.test.ts
//
// This is the ADR-037 capability proof: a real mouse click, delivered through
// @opentui/core's own native input pipeline (`createMockMouse`'s emitted ANSI
// mouse sequence -> real stdin parsing -> the real per-Renderable hit-grid
// every @opentui/core Renderable populates on its own render() pass, per
// `node_modules/@opentui/core/chunk-bun-8fkgaxc6.js`'s `addToHitGrid` call —
// not this test's own arithmetic), resolves to the correct PANE and the
// correct pane-local row/column. Wave 1's port
// (`RendererPort.render(frame: string)`) could not offer this at all: a
// single opaque `TextRenderable` has no per-pane boundary for a click to
// resolve against. ADR-037's widened port (`SceneFrame`'s `panes`) is what
// makes `OpenTuiRenderer` able to register one real hit region per pane.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createNavigation, initialModel, renderScene, type PaneScroll, type RenderProjection } from "../src/index.js";
// paintScene/hitTestFrame/PaneHit are not (yet) re-exported through the
// package's public barrel (`src/index.ts`, out of this record's file
// ownership — see ADR-037's "What is needed from siblings") — imported
// directly from the modules that declare them.
import { paintScene } from "../src/renderer.js";
import { hitTestFrame, type PaneHit } from "../src/frame.js";
import { OpenTuiRenderer } from "../src/opentui-renderer.js";
import { textOnlyFrame } from "./support/render-harness.js";

// 100x24: at/above navigation.ts's MIN_COLUMNS(80)/MIN_ROWS(24) split floor,
// so layoutWorkspace actually splits into two real panes.
const WIDTH = 100;
const HEIGHT = 24;

function twoPaneProjection(): RenderProjection {
  return {
    app: initialModel(),
    output: "generic",
    navigation: createNavigation(
      { id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "left", title: "Left" }, { id: "right", title: "Right" }] },
      { columns: WIDTH, rows: HEIGHT },
    ),
  };
}

let setup: TestRendererSetup;
let renderer: TestRenderer;
let hits: PaneHit[];

beforeEach(async () => {
  setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  renderer = setup.renderer;
  hits = [];
});

afterEach(() => {
  renderer.destroy();
});

describe("OpenTuiRenderer + a real SceneFrame — native per-pane mouse hit-testing (ADR-037)", () => {
  test("a real synthetic mouse click inside the right pane resolves to that pane and the correct local row/column", async () => {
    const adapter = new OpenTuiRenderer({ renderer, onPaneHit: (hit) => hits.push(hit) });
    await adapter.enter();

    const projection = twoPaneProjection();
    const scene = renderScene(projection);
    adapter.render({ text: paintScene(scene, {}), scene });
    // One real render pass: every @opentui/core Renderable's own render()
    // populates the native hit-grid this click resolves against
    // (`addToHitGrid`) — the click below is meaningless without it.
    await setup.renderOnce();

    const [, right] = scene.panes;
    expect(right).toBeDefined();
    const clickColumn = right.x + 5;
    const clickRow = right.y + 2;

    await setup.mockMouse.click(clickColumn, clickRow);

    // Independent cross-check: the pure hitTestFrame (frame.ts) function,
    // given the same scene and point, must agree with what the REAL
    // @opentui/core event pipeline actually delivered — two independently
    // implemented translations of the same click landing on the same answer.
    const expected = hitTestFrame(scene, { column: clickColumn, row: clickRow });
    // Narrowed, not asserted away: `toEqual([expected])` against a
    // `PaneHit | null` would compare the native pipeline's answer to a
    // possible `null` and still pass if BOTH were empty — the two
    // implementations agreeing that nothing was hit is not the agreement
    // this test claims to prove.
    if (expected === null) throw new Error("hitTestFrame found no pane for a click placed inside one");
    expect(hits).toEqual([expected]);
    expect(hits[0]?.pane_id).toBe("right");
  });

  test("a real synthetic mouse click inside the left pane resolves to that pane, not the right one", async () => {
    const adapter = new OpenTuiRenderer({ renderer, onPaneHit: (hit) => hits.push(hit) });
    await adapter.enter();

    const projection = twoPaneProjection();
    const scene = renderScene(projection);
    adapter.render({ text: paintScene(scene, {}), scene });
    await setup.renderOnce();

    const [left] = scene.panes;
    await setup.mockMouse.click(left.x + 1, left.y + 1);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.pane_id).toBe("left");
    const expected = hitTestFrame(scene, { column: left.x + 1, row: left.y + 1 });
    if (expected === null) throw new Error("hitTestFrame found no pane for a click placed inside one");
    expect(hits[0]).toEqual(expected);
  });

  test("a click on the reserved status row hits no pane's native BoxRenderable — the real event pipeline agrees with hitTestFrame's null", async () => {
    const adapter = new OpenTuiRenderer({ renderer, onPaneHit: (hit) => hits.push(hit) });
    await adapter.enter();

    const projection = twoPaneProjection();
    const scene = renderScene(projection);
    adapter.render({ text: paintScene(scene, {}), scene });
    await setup.renderOnce();

    expect(scene.status_row).not.toBeNull();
    await setup.mockMouse.click(0, scene.status_row!);

    expect(hits).toHaveLength(0);
    expect(hitTestFrame(scene, { column: 0, row: scene.status_row! })).toBeNull();
  });

  test("switching to an explicit no-pane fallback frame tears down pane hit regions — a later click hits nothing", async () => {
    const adapter = new OpenTuiRenderer({ renderer, onPaneHit: (hit) => hits.push(hit) });
    await adapter.enter();

    const projection = twoPaneProjection();
    const scene = renderScene(projection);
    adapter.render({ text: paintScene(scene, {}), scene });
    await setup.renderOnce();

    const [, right] = scene.panes;
    // A structured frame is genuinely hit-testable before the fallback...
    await setup.mockMouse.click(right.x + 1, right.y + 1);
    expect(hits).toHaveLength(1);

    // ...and the explicit no-pane fallback tears the pane boxes down rather
    // than leaving stale, now-misleading hit regions behind it.
    adapter.render(textOnlyFrame("full-viewport fallback"));
    await setup.renderOnce();
    hits.length = 0;
    await setup.mockMouse.click(right.x + 1, right.y + 1);
    expect(hits).toHaveLength(0);
  });
});

// OT-5: onMouseScroll wired on the same per-pane BoxRenderable/TextRenderable
// pair onMouseDown already uses, resolved through the real native mouse
// pipeline (not this test's own arithmetic).
describe("OpenTuiRenderer + a real SceneFrame — native per-pane mouse-wheel scroll (OT-5)", () => {
  let scrolls: PaneScroll[];

  beforeEach(() => { scrolls = []; });

  test("a real synthetic wheel scroll inside a pane resolves to that pane with a direction/delta", async () => {
    const adapter = new OpenTuiRenderer({ renderer, onPaneScroll: (scroll) => scrolls.push(scroll) });
    await adapter.enter();

    const projection = twoPaneProjection();
    const scene = renderScene(projection);
    adapter.render({ text: paintScene(scene, {}), scene });
    await setup.renderOnce();

    const [, right] = scene.panes;
    await setup.mockMouse.scroll(right.x + 1, right.y + 1, "down");

    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]?.pane_id).toBe("right");
    expect(scrolls[0]?.direction).toBe("down");
    expect(scrolls[0]?.delta).toBeGreaterThan(0);
  });

  test("scroll direction distinguishes up from down", async () => {
    const adapter = new OpenTuiRenderer({ renderer, onPaneScroll: (scroll) => scrolls.push(scroll) });
    await adapter.enter();

    const projection = twoPaneProjection();
    const scene = renderScene(projection);
    adapter.render({ text: paintScene(scene, {}), scene });
    await setup.renderOnce();

    const [left] = scene.panes;
    await setup.mockMouse.scroll(left.x + 1, left.y + 1, "up");

    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]?.pane_id).toBe("left");
    expect(scrolls[0]?.direction).toBe("up");
  });
});
