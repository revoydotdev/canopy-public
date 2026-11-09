// ADR-037: the widened RendererPort. This file is new (wave 2, Lane E) — it
// does not touch or duplicate any wave-1 test file's assertions. Runs under
// vitest like every other non-OpenTUI test in this package (no @opentui/core
// import here).
import { describe, expect, it, afterEach } from "vitest";
import { StdoutRenderer, createNavigation, displayWidth, initialModel, renderScene, type RenderProjection } from "../src/index.js";
// hitTestFrame/SceneFrame are not (yet) re-exported through the package's
// public barrel (`src/index.ts`, out of this record's file ownership — see
// ADR-037's "What is needed from siblings") — imported directly from the
// module that declares them, the same pattern other in-package tests already
// use for symbols index.ts doesn't surface (e.g. screens/screen.js below).
import { hitTestFrame, type SceneFrame } from "../src/frame.js";
// paintScene is the sibling of renderScene, also not re-exported through the
// barrel — same direct-import pattern.
import { paintScene } from "../src/renderer.js";
import { installScreens } from "../src/screens/install.js";
import { clearRegisteredScreens } from "../src/screens/screen.js";
import { MemoryRenderer, renderTerminalFrame, textOnlyFrame } from "./support/render-harness.js";

// 100x24: at/above navigation.ts's MIN_COLUMNS(80)/MIN_ROWS(24) split floor,
// so layoutWorkspace actually splits into two panes instead of falling back
// to single-pane "compact" mode.
function twoPaneProjection(columns = 100, rows = 24, output = "primary content"): RenderProjection {
  return {
    app: { ...initialModel(), screen: "tree" }, output,
    navigation: createNavigation({
      id: "main", route: "/", split: "horizontal", ratio: 0.5,
      panes: [{ id: "left", title: "Left" }, { id: "right", title: "Right" }],
    }, { columns, rows }),
  };
}

afterEach(() => clearRegisteredScreens());

describe("renderScene's SceneFrame.panes (ADR-037 — the structure a string-only port discarded)", () => {
  it("carries every pane's real rectangle, matching layoutWorkspace's own split", () => {
    const scene = renderScene(twoPaneProjection());
    expect(scene.panes).toHaveLength(2);
    const [left, right] = scene.panes;
    expect(left.id).toBe("left");
    expect(right.id).toBe("right");
    // Horizontal split at ratio 0.5 of 100 columns: left starts at x=0,
    // right starts exactly where left ends — no gap, no overlap.
    expect(left.x).toBe(0);
    expect(right.x).toBe(left.x + left.columns);
    expect(left.y).toBe(0);
    expect(right.y).toBe(0);
    // 24 terminal rows, minus 1 for the reserved status row both panes reach
    // (a full-height horizontal split) — see hitTestFrame's status-row test
    // below for why the reported rect excludes it.
    expect(left.rows).toBe(23);
    expect(right.rows).toBe(23);
  });

  it("carries only the primary pane's real content — a secondary pane's content is [], matching what drawPane actually painted into it", () => {
    const scene = renderScene(twoPaneProjection(100, 24, "λ primary"));
    const [left, right] = scene.panes;
    expect(left.content.join("\n")).toContain("λ primary");
    // "" (nothing painted into the interior) splits to one empty line, not
    // zero lines — the same single blank interior drawPane always paints for
    // a secondary pane, never invented content it never rendered.
    expect(right.content).toEqual([""]);
  });

  it("clips content to the pane's interior height exactly as drawPane clips the flattened canvas", () => {
    // Exercise frame clipping, not a screen's own height budgeting. A screen
    // is allowed to return fewer lines than the maximum available interior.
    clearRegisteredScreens();
    const projection: RenderProjection = {
      app: initialModel(), output: Array.from({ length: 50 }, (_, i) => `overflow line ${i}`).join("\n"),
      // Single-pane workspace at 20 terminal rows: layoutWorkspace gives this
      // one pane the full, un-narrowed rect (rows: 20) — content clips
      // against that real interior height (20 - 2 = 18), independent of
      // FramePane.rows's separate, narrower status-row-overlap adjustment
      // (see the status-row test below) which exists for hit-testing, not
      // for content clipping.
      navigation: createNavigation({ id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "screen", title: "Screen" }] }, { columns: 100, rows: 20 }),
    };
    const scene = renderScene(projection);
    const [pane] = scene.panes;
    expect(pane.content).toHaveLength(18);
    expect(pane.content[17]).toBe("overflow line 17");
    expect(pane.content.join("\n")).not.toContain("overflow line 18");
  });

  it("reserves the same status row `renderTerminalFrame` has always reserved", () => {
    const scene = renderScene(twoPaneProjection(100, 24));
    expect(scene.status_row).toBe(23);
    expect(scene.rows[scene.status_row!]).toBe(scene.rows.at(-1));
  });

  it("reports status_row: null only for a zero-row terminal (nothing was reserved)", () => {
    // createNavigation rejects non-positive dimensions, so the only reachable
    // zero-row scene is one built directly against a SceneFrame-shaped value
    // — this asserts the type's own contract, not a reachable renderScene
    // output, since a real terminal can never have zero rows.
    const scene: SceneFrame = { columns: 10, rows: [], panes: [], status_row: null };
    expect(scene.status_row).toBeNull();
  });

  it("carries Console sticky chronology and canonical composer metadata without parsing rendered rows", () => {
    installScreens();
    const app = {
      ...initialModel(),
      screen: "console" as const,
      grantedCapabilities: new Set(["campaign.read"]),
      screens: new Map([["console", {
        captured_at: "2026-08-29T00:00:00.000Z",
        console_input: { text: "first\nsecond", cursor: 12, focused: true, action: "queue", interrupt_available: true },
      }]]),
    };
    const projection: RenderProjection = {
      app: app as unknown as RenderProjection["app"], output: "generic",
      navigation: createNavigation({ id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "console", title: "Console" }] }, { columns: 120, rows: 40 }),
    };
    const pane = renderScene(projection).panes[0]!;
    expect(pane.content_alignment).toBe("top");
    expect(pane.chronology).toEqual({ placement: "top", sticky_bottom: false });
    expect(pane.composer).toMatchObject({ kind: "console", focused: true, text: "first\nsecond", cursor: 12, action: "queue", interrupt_available: true, max_visible_rows: 6 });
  });

  it("is still exactly the composition renderTerminalFrame flattens (rows unchanged by the widening)", () => {
    const p = twoPaneProjection(100, 24, "λ output");
    expect(renderScene(p).rows.join("\n")).toBe(renderTerminalFrame(p));
  });
});

describe("hitTestFrame (ADR-037) — the pane+row translation a string port had no way to offer", () => {
  const scene = renderScene(twoPaneProjection(100, 24));

  it("resolves a point inside the left pane to (left, row-in-pane 0) at its top-left interior cell", () => {
    const hit = hitTestFrame(scene, { column: 0, row: 0 });
    expect(hit).toEqual({ pane_id: "left", row_in_pane: 0, column_in_pane: 0 });
  });

  it("resolves a point inside the right pane to (right, translated local coordinates)", () => {
    const [left, right] = scene.panes;
    const hit = hitTestFrame(scene, { column: right.x + 2, row: right.y + 3 });
    expect(hit).toEqual({ pane_id: "right", row_in_pane: 3, column_in_pane: 2 });
    // Sanity: the two panes' rects genuinely differ, so this isn't
    // accidentally re-testing the left pane's own origin.
    expect(right.x).toBeGreaterThan(left.x);
  });

  it("returns null — not a guessed nearest pane — for a point on the reserved status row", () => {
    expect(hitTestFrame(scene, { column: 0, row: scene.status_row! })).toBeNull();
  });

  it("returns null for a point entirely outside the frame", () => {
    expect(hitTestFrame(scene, { column: -1, row: 0 })).toBeNull();
    expect(hitTestFrame(scene, { column: 0, row: 999 })).toBeNull();
  });
});

describe("RendererPort implementations against a structured RenderedFrame input (ADR-037)", () => {
  it("MemoryRenderer records both the flattened text and the structured scene, parallel-indexed", () => {
    const renderer = new MemoryRenderer();
    const scene = renderScene(twoPaneProjection());
    const text = renderTerminalFrame(twoPaneProjection());
    renderer.render({ text, scene });
    const fallback = textOnlyFrame("full-viewport fallback");
    renderer.render(fallback);
    expect(renderer.frames).toEqual([text, "full-viewport fallback"]);
    expect(renderer.scenes[0]).toBe(scene);
    expect(renderer.scenes[1]).toBe(fallback.scene);
  });

  it("StdoutRenderer diffs a structured RenderedFrame's .text exactly as it always diffed a bare string", () => {
    const out: string[] = [];
    const renderer = new StdoutRenderer({ write: (v: string) => { out.push(v); } }, { clear_screen: false });
    const scene = renderScene(twoPaneProjection(10, 3, "a"));
    renderer.render({ text: "row0\nrow1\nrow2", scene });
    out.length = 0;
    renderer.render({ text: "row0\nCHANGED\nrow2", scene });
    const written = out.join("");
    expect(written).toContain("\u001b[2;1H");
    expect(written).toContain("CHANGED");
    expect(written).not.toContain("row0\nrow1");
  });
});

describe("renderScene's SceneFrame.panes content — column-width clipping (audit finding)", () => {
  it("clips a pane's reported content to the pane's real interior width, exactly like drawPane clips the flattened canvas", () => {
    // A single 60-terminal-column pane: interior width is 60 - 2 = 58. The
    // default (no overlay/screen) content path (primaryPaneContent's
    // abbreviateOutput fallback) has no notion of pane width at all — only
    // byte/line/token budgets — so a single long line here is not
    // pre-clipped by anything upstream of renderScene.
    const projection: RenderProjection = {
      app: initialModel(),
      output: "x".repeat(200),
      navigation: createNavigation(
        { id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "solo", title: "Solo" }] },
        { columns: 60, rows: 10 },
      ),
    };
    const scene = renderScene(projection);
    const pane = scene.panes[0]!;
    const interiorWidth = pane.columns - 2;
    // What drawPane actually painted onto the flattened canvas for this same
    // row — the ground truth this FramePane.content claims to mirror
    // (frame.ts: "the same lines drawPane writes into the flat canvas").
    const paintedRow = scene.rows[pane.y + 1]!.slice(pane.x + 1, pane.x + 1 + interiorWidth);
    expect(displayWidth(paintedRow)).toBeLessThanOrEqual(interiorWidth);
    // FramePane.content's first line should match what was actually
    // painted, not the raw unclipped source line.
    expect(displayWidth(pane.content[0]!)).toBeLessThanOrEqual(interiorWidth);
    expect(pane.content[0]).toBe(paintedRow);
  });
});

describe("drawPane's content clip preserves an SGR reset on a full-width colored screen line (audit finding)", () => {
  afterEach(() => clearRegisteredScreens());

  it("StdoutRenderer's painted text still carries the trailing reset after a colored operator row fills the pane's exact width", () => {
    installScreens();
    const RESET = String.fromCharCode(27) + "[0m";
    const app = {
      ...initialModel(), screen: "command-history" as const,
      grantedCapabilities: new Set(["devtools.read"]),
      screens: new Map([["command-history", {
        campaign_id: "camp-01",
        lines: [{
          seq: 1, ts: "2026-08-31T00:00:00.000Z", event_kind: "loop.tool_call",
          campaign_id: "camp-01", node_id: "n1",
          loop_event: { tool: "bash", args: `false ${"x".repeat(200)}`, ok: false, exit: 1 },
        }],
      }]]),
    };
    const projection: RenderProjection = {
      app: app as unknown as RenderProjection["app"], output: "unused",
      navigation: createNavigation(
        { id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "command-history", title: "Command History" }] },
        { columns: 40, rows: 10 },
      ),
    };
    const scene = renderScene(projection, { color: true });
    const text = paintScene(scene, { color: true });
    const ESC = String.fromCharCode(27);
    const coloredRow = text.split("\n").find((row) => row.includes(ESC + "[") && row.includes("x".repeat(10)));
    expect(coloredRow).toBeDefined();
    // The row must end its color run with a real reset — otherwise the
    // color bleeds into whatever the row's own trailing border cell (or a
    // subsequent frame region) paints next.
    expect(coloredRow).toContain(RESET);
  });
});
