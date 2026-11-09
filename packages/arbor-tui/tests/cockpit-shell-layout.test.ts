import { afterEach, describe, expect, it } from "vitest";
import { createNavigation, initialModel, renderScene, type RenderProjection } from "../src/index.js";
import { hitTestFrame } from "../src/frame.js";
import { installScreens } from "../src/screens/install.js";
import { clearRegisteredScreens, type ScreenId } from "../src/screens/screen.js";
import { stripAnsi } from "../src/player-piano.js";

afterEach(() => clearRegisteredScreens());

function scene(columns = 152, visibility = "auto", rows = 40, options: { color?: boolean } = {}) {
  installScreens();
  const tree = {
    campaign_id: "layout",
    nodes: [
      { id: "root", parent_id: null, state: "claimed", action_description: "Plan" },
      { id: "child", parent_id: "root", state: "verified", action_description: "Ship" },
    ],
  };
  const projection: RenderProjection = {
    app: { ...initialModel(), screen: "tree", screens: new Map<ScreenId, unknown>([
      ["tree", tree], ["console", { captured_at: "2026-09-05", tree, sidebar_visibility: visibility }],
    ]), telemetryCampaignId: "layout" }, output: "",
    navigation: createNavigation({ id: "cockpit", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "main", title: "revoy2" }] }, { columns, rows }),
  };
  return renderScene(projection, options);
}

// Changed by M2.1's layout.ts wiring (computeShellLayout is now the sole
// geometry authority for renderCockpitScene, ui-spec §2): the old fixed
// "1-row status + 4-row hero + full-height rail" geometry is replaced by a
// framed top band (header, clamp(floor(rows/3),8,12) rows) with left/graph/
// right zones, and the docked rail now spans only from below that band to
// the bottom row, not the full terminal height. `status_row` is no longer a
// distinct painted row (its data now lives in the header's left/right
// zones), so it is always `null` from this scene.
describe("edge-anchored product shell", () => {
  it("frames a header band above the docked rail, sized by computeShellLayout", () => {
    // 152x40 -> docked (cols>=120, rows>=24). header = clamp(floor(40/3),8,12) = 12 rows.
    // rail width = min(clamp(floor(152*0.28),32,44), 152-72) = 42, so main = 110 cols.
    const frame = scene();
    expect(frame.layout_class).toBe("docked");
    expect(frame.status_row).toBeNull();
    expect(frame.status_columns).toBe(110);
    expect(frame.panes.find((pane) => pane.id === "workspace-inspector")).toMatchObject({ x: 110, y: 12, columns: 42, rows: 28 });
    // Zone rects are inset by one column on each side so the header frame's
    // own left/right border columns (x=0 and x=151) are never overwritten by
    // zone text (layout.ts's `buildFullHeader`, M2 band-side-borders fix).
    expect(frame.panes.find((pane) => pane.id === "uct-graph")).toMatchObject({ x: 32, y: 1, columns: 88, rows: 10 });
    expect(frame.panes.find((pane) => pane.id === "header-left")).toMatchObject({ x: 1, y: 1, columns: 30, rows: 10 });
    expect(frame.panes.find((pane) => pane.id === "header-right")).toMatchObject({ x: 121, y: 1, columns: 30, rows: 10 });
    expect(frame.panes.find((pane) => pane.id === "main")).toMatchObject({ x: 0, y: 12, columns: 110, rows: 28 });
    // The header's own top/bottom border rows are real, hit-testable geometry
    // now (a framed band, ui-spec §2.2), unlike the old bare status row.
    expect(hitTestFrame(frame, { column: 1, row: 0 })?.pane_id).toBe("header");
    // Column 111 at row 1 now falls inside the header's graph zone, not the
    // rail (the rail starts at y=12, below the header).
    expect(hitTestFrame(frame, { column: 111, row: 1 })?.pane_id).toBe("uct-graph");
    expect(hitTestFrame(frame, { column: 130, row: 1 })?.pane_id).toBe("header-right");
    expect(hitTestFrame(frame, { column: 111, row: 20 })?.pane_id).toBe("workspace-inspector");
  });

  it("gives narrow overlay input to the rail rather than the header or body under it", () => {
    // 100x40 -> drawer (80<=cols<120, rows>=24): no docked rail; an explicit
    // "shown" sidebar_visibility opens the overlay rail over the transcript.
    const frame = scene(100, "shown");
    expect(frame.layout_class).toBe("drawer");
    expect(frame.panes.find((pane) => pane.id === "main")?.columns).toBe(100);
    expect(hitTestFrame(frame, { column: 80, row: 15 })?.pane_id).toBe("workspace-inspector");
    expect(hitTestFrame(frame, { column: 80, row: 20 })?.pane_id).toBe("workspace-inspector");
  });

  // Defect (tui-overhaul m2 reel, real OpenTUI default-renderer capture):
  // `renderCockpitScene` pushed the "header" backdrop pane with
  // `content: []`. A structure-aware renderer (OpenTuiRenderer) paints one
  // opaque box per `FramePane` and never reads `SceneFrame.rows`, so the
  // border/tee/divider glyphs that DO exist in the flat `rows` text were
  // simply absent from what OpenTUI painted: row 0 blank, no left/right or
  // divider border, only the UCT header's own inner box visible.
  it("gives the header backdrop pane real border/divider content, not an empty box", () => {
    const frame = scene();
    const header = frame.panes.find((pane) => pane.id === "header")!;
    const graph = frame.panes.find((pane) => pane.id === "uct-graph")!;
    const right = frame.panes.find((pane) => pane.id === "header-right")!;
    expect(header.content.length).toBe(header.rows);
    // Top row: full-width horizontal border with corners.
    expect(header.content[0]!.startsWith("┌")).toBe(true);
    expect(header.content[0]!.endsWith("┐")).toBe(true);
    // Bottom row: same, with bottom corners.
    expect(header.content.at(-1)!.startsWith("└")).toBe(true);
    expect(header.content.at(-1)!.endsWith("┘")).toBe(true);
    // An interior row carries the outer left/right border plus both zone
    // dividers, at the SAME local columns the zone panes sit next to.
    const interior = header.content[1]!;
    expect(interior[0]).toBe("│");
    expect(interior[header.columns - 1]).toBe("│");
    expect(interior[graph.x - header.x - 1]).toBe("│");
    expect(interior[right.x - header.x - 1]).toBe("│");
  });

  // Defect (tui-overhaul m2 reel, `--renderer stdout` colored capture): the
  // divider loop spliced a zone divider into `canvas[y]` by raw string
  // INDEX (`line[x] = frame.v`). Under `color: true`, the UCT graph line
  // embeds `[...m` SGR sequences for node-state colors, which the raw
  // index counts as visible columns — shifting the divider off its real
  // cell (a real 120x36 colored capture put a stray `│` inside the graph,
  // row 3).
  it("keeps header dividers at the same visible column whether or not color is on", () => {
    const plain = scene(120, "auto", 36, { color: false });
    clearRegisteredScreens();
    const colored = scene(120, "auto", 36, { color: true });
    const plainGraph = plain.panes.find((pane) => pane.id === "uct-graph")!;
    const coloredGraph = colored.panes.find((pane) => pane.id === "uct-graph")!;
    expect({ x: coloredGraph.x, y: coloredGraph.y, columns: coloredGraph.columns, rows: coloredGraph.rows })
      .toEqual({ x: plainGraph.x, y: plainGraph.y, columns: plainGraph.columns, rows: plainGraph.rows });
    // The colored capture must carry SGR at all (otherwise this test would
    // not exercise the ANSI-aware splice path it exists to prove).
    expect(colored.rows.some((row) => row.includes("["))).toBe(true);
    for (let y = 0; y < plain.rows.length; y += 1) {
      expect(stripAnsi(colored.rows[y]!)).toBe(plain.rows[y]);
    }
  });
});
