/// <reference types="bun-types" />
// bun:test only (ADR-036/ADR-037) — @opentui/core's native render library does
// not bind under Node, and fails identically inside vitest even when vitest
// itself is launched via `bun x` (Node workers).
// Run with: bun test packages/arbor-tui/tests/opentui-bakeoff.test.ts
//
// The acceptance test for the renderer/painter gap (feat/bun-runtime-migration,
// lane 2): drives ONE real, populated scene — a tree screen with real node
// rows, a live status bar (real telemetry + campaign id), and a populated
// notification band — through both real `RendererPort` implementations
// against the identical `SceneFrame`, and asserts each carries the fidelity
// the bake-off cited in the lane brief found missing from `OpenTuiRenderer`:
// borders, padding, column/row alignment, and a live status bar. Uncolored
// on purpose (`color: false`) — `TextRenderable.content` does not ANSI-parse
// a plain string (this file and opentui-renderer.ts's own docstrings), so a
// colored scene is not the fair, apples-to-apples comparison this test wants.
//
// This is also the permanent regression guard: before this pass,
// `OpenTuiRenderer`'s structured path never read `scene.rows` at all (no
// status bar), and nothing in `renderer.ts` ever painted a notification band
// for either renderer to consume.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import {
  clearRegisteredScreens, createNavigation, displayWidth, initialModel, registerScreen, renderStatusBar, StdoutRenderer, treeScreen,
  type AppModel, type Notification, type RenderProjection, type TelemetrySnapshot, type UsageCostRow,
} from "../src/index.js";
import { paintScene, renderScene } from "../src/renderer.js";
import { OpenTuiRenderer } from "../src/opentui-renderer.js";
import type { SceneFrame } from "../src/frame.js";

const WIDTH = 90;
const HEIGHT = 26;

// A real, full-length composer UUID: WIDTH (90) is below the status bar's
// 96-column wide-row breakpoint (status-bar.ts), so this also exercises the
// compact row's stable, bounded campaign-identity slice under real
// end-to-end paint/capture, not just the unit-level renderStatusBar tests.
const CAMPAIGN_ID = "8f14e45f-ceea-467e-bd3a-9b73f3ea7f0e";

const treePayload = {
  campaign_id: CAMPAIGN_ID,
  nodes: [
    { id: "root", label: "Plan: Refactor Shell", depth: 0, state: "claimed", has_children: true },
    { id: "n1", label: "Expand: Terminal I/O", depth: 1, state: "expanding", has_children: true },
    { id: "n2", label: "Leaf: Unicode Clipping", depth: 2, state: "verified", has_children: false },
    { id: "n3", label: "Branch: Pruned", depth: 1, state: "pruned", has_children: false },
  ],
};

const notifications: readonly Notification[] = [
  { id: "n-branch", severity: "info", message: "campaign camp-01 branched node root", createdAt: Date.parse("2026-01-01T00:00:00.000Z") },
  { id: "n-prune", severity: "warning", message: "operator pruned node n3", createdAt: Date.parse("2026-01-01T00:00:05.000Z") },
  { id: "n-fail", severity: "error", message: "provider call failed for node n2", createdAt: Date.parse("2026-01-01T00:00:10.000Z") },
];

const usageCost: UsageCostRow = {
  name: "arbor.provider.usage_cost",
  campaign_id: CAMPAIGN_ID,
  node_id: "root",
  tags: { provider: "anthropic", model_family: "claude-sonnet", phase: "expand", agent: "seed", pricing: "priced", currency: "USD", minor_unit_exponent: "2" },
  calls: 3,
  input_tokens: 900,
  output_tokens: 300,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_minor_units: 425,
  price_source_ids: [],
  evidence: [],
};

const telemetrySnapshot: TelemetrySnapshot = {
  campaign_id: CAMPAIGN_ID,
  source_record_count: 42,
  counters: [],
  phase_histograms: [],
  usage_cost: [usageCost],
  context_economy: [],
  tool_economy: [],
};

function populatedProjection(): RenderProjection {
  const app: AppModel = {
    ...initialModel(),
    screen: "tree",
    grantedCapabilities: new Set(["tree.read", "tree.write"]),
    screens: new Map([["tree", treePayload]]),
    notifications,
    telemetrySnapshot,
    telemetryCampaignId: CAMPAIGN_ID,
  };
  return {
    app,
    output: "unused — the tree screen owns the primary pane's content",
    navigation: createNavigation(
      { id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "tree", title: "Tree" }] },
      { columns: WIDTH, rows: HEIGHT },
    ),
  };
}

let setup: TestRendererSetup;
let renderer: TestRenderer;

beforeEach(async () => {
  // Other Bun-native files in the required lane may render first and install
  // the default screen set into this process-wide registry. Own a clean
  // registry boundary instead of relying on file execution order.
  clearRegisteredScreens();
  registerScreen(treeScreen);
  setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  renderer = setup.renderer;
});

afterEach(() => {
  renderer.destroy();
  clearRegisteredScreens();
});

describe("bake-off: StdoutRenderer vs OpenTuiRenderer on one identical, populated SceneFrame", () => {
  test("overlaid panes erase underlying text, including blank rows, in current scene order", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();
    const main = { id: "main", x: 0, y: 0, columns: WIDTH, rows: HEIGHT, title: "", bordered: false, content: Array.from({ length: HEIGHT }, () => "X".repeat(WIDTH)) };
    const rail = { id: "rail", x: 50, y: 0, columns: WIDTH - 50, rows: HEIGHT, title: "", bordered: false, content: ["DOCS", "", "READ ME"] };
    const draw = async (panes: SceneFrame["panes"]): Promise<string[]> => {
      const scene: SceneFrame = { columns: WIDTH, rows: Array.from({ length: HEIGHT }, () => ""), panes, status_row: null };
      adapter.render({ text: "", scene });
      await setup.renderOnce();
      return setup.captureCharFrame().split("\n");
    };
    const overlaid = await draw([main, rail]);
    expect(overlaid[0]!.slice(0, 50)).toBe("X".repeat(50));
    expect(overlaid[0]!.slice(50).trim()).toBe("DOCS");
    expect(overlaid[1]!.slice(50).trim()).toBe("");
    expect(overlaid[2]!.slice(50).trim()).toBe("READ ME");
    expect(overlaid[10]!.slice(50).trim()).toBe("");
    const reordered = await draw([rail, main]);
    expect(reordered[0]).toBe("X".repeat(WIDTH));
    const restored = await draw([main, rail]);
    expect(restored[0]!.slice(50).trim()).toBe("DOCS");
    expect(restored[1]!.slice(50).trim()).toBe("");
  });

  test("StdoutRenderer paints borders, aligned tree rows, the notification band, and a live status bar", () => {
    const scene = renderScene(populatedProjection(), { color: false });
    const text = paintScene(scene, { color: false });

    const writes: string[] = [];
    const stdout = new StdoutRenderer({ write: (value: string) => { writes.push(value); } }, { clear_screen: false });
    stdout.enter();
    stdout.render({ text, scene });
    const captured = writes.join("");

    // Borders (the tree pane is a real bordered box). Only the top corners
    // are asserted: a single-pane workspace's pane always spans the full
    // terminal height (layoutWorkspace has no notion of a status row —
    // renderScene's own comment on this), so its bottom border row and the
    // reserved status/band rows always coincide and the bottom border is
    // always the thing that gets overwritten — true before this pass (the
    // status row alone did it) and still true now (the band widens the
    // overwritten zone). Not a regression this test should assert against.
    expect(captured).toContain("┌");
    expect(captured).toContain("┐");
    expect(captured).toContain("┌─ Tree ");
    expect(captured).toContain("│SEARCH · 1/4 verified · 1 expanding · 1 claimed");
    // Real tree content, not a placeholder.
    expect(captured).toContain("Refactor Shell");
    expect(captured).toContain("Terminal I/O");
    expect(captured).not.toContain("No data");
    // The live status bar: WIDTH (90) is below the 96-column wide-row
    // breakpoint, so this is the compact row — a stable slice of the real
    // campaign id (never the full UUID, which alone would crowd out
    // phase/attempt/verified) plus the bare execution-status tokens. Scoped
    // to the status-bar row itself: the tree pane's own title legitimately
    // shows the full campaign id elsewhere in `captured`.
    const statusRow = captured.trimEnd().split("\n").at(-1) ?? "";
    expect(statusRow).toContain(CAMPAIGN_ID.slice(0, 8));
    expect(statusRow).not.toContain(CAMPAIGN_ID);
    expect(statusRow).toContain("n1");
    expect(statusRow).toContain("expanding");
    expect(statusRow).toContain("✓1/4");
    // The notification band: all three real messages, not just the ring's existence.
    expect(captured).toContain("campaign camp-01 branched node root");
    expect(captured).toContain("operator pruned node n3");
    expect(captured).toContain("provider call failed for node n2");

    // eslint-disable-next-line no-console
    console.log(`[bake-off] StdoutRenderer: ${Buffer.byteLength(captured, "utf8")} bytes`);
  });

  test("OpenTuiRenderer, given the identical SceneFrame, now reaches the same fidelity", async () => {
    const scene = renderScene(populatedProjection(), { color: false });
    const text = paintScene(scene, { color: false });

    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();
    adapter.render({ text, scene });
    await setup.renderOnce();
    const captured = setup.captureCharFrame();

    expect(captured).toContain("┌");
    expect(captured).toContain("┐");
    expect(captured).toContain("└");
    expect(captured).toContain("┘");
    expect(captured).toContain("Refactor Shell");
    expect(captured).toContain("Terminal I/O");
    expect(captured).not.toContain("No data");
    const openTuiStatusRow = captured.trimEnd().split("\n").at(-1) ?? "";
    expect(openTuiStatusRow).toContain(CAMPAIGN_ID.slice(0, 8));
    expect(openTuiStatusRow).not.toContain(CAMPAIGN_ID);
    expect(openTuiStatusRow).toContain("n1");
    expect(openTuiStatusRow).toContain("expanding");
    expect(openTuiStatusRow).toContain("✓1/4");
    expect(captured).toContain("campaign camp-01 branched node root");
    expect(captured).toContain("operator pruned node n3");
    expect(captured).toContain("provider call failed for node n2");

    // eslint-disable-next-line no-console
    console.log(`[bake-off] OpenTuiRenderer: ${Buffer.byteLength(captured, "utf8")} bytes`);
  });

  test("the notification band is real, hit-testable geometry — a distinct, unbordered FramePane sized to its actual content", () => {
    const scene = renderScene(populatedProjection(), { color: false });
    const band = scene.panes.find((pane) => pane.id === "notifications");
    expect(band).toBeDefined();
    expect(band?.bordered).toBe(false);
    expect(band?.rows).toBe(notifications.length);
    expect(band?.content).toEqual([
      "[info] campaign camp-01 branched node root",
      "[warning] operator pruned node n3",
      "[error] provider call failed for node n2",
    ]);
  });

  test("the status bar stays exactly 80 columns wide and shows the compact operator-critical set with a real long campaign id", () => {
    const { app } = populatedProjection();
    const row = renderStatusBar(app, { columns: 80, frame_count: 0, color: false });
    expect(displayWidth(row)).toBe(80);
    expect(row).toContain(CAMPAIGN_ID.slice(0, 8));
    expect(row).not.toContain(CAMPAIGN_ID);
    expect(row).toContain("n1");
    expect(row).toContain("expanding");
    expect(row).toContain("✓1/4");
  });
});
