/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, TestRecorder, type TestRendererSetup } from "@opentui/core/testing";
import { InputRouter, createNavigation, initialModel, renderScene, type NormalizedKeyEvent, type RenderProjection } from "../src/index.js";
import { paintScene } from "../src/renderer.js";
import { OpenTuiRenderer } from "../src/opentui-renderer.js";

let setup: TestRendererSetup;

beforeEach(async () => { setup = await createTestRenderer({ width: 52, height: 10 }); });
afterEach(() => setup.renderer.destroy());

describe("OpenTUI native keyboard and recorder integration", () => {
  test("dispatches a rebound key through native parsing and the real catalog router", () => {
    const router = new InputRouter({ actions: [{
      id: "operator.rebound",
      title: "Rebound action",
      description: "test override",
      bindings: [{ keys: ["ctrl+x"], scope: "global", description: "override" }],
    }] }, () => 1);
    const routed: string[] = [];
    setup.renderer.keyInput.on("keypress", (key) => {
      const event: NormalizedKeyEvent = {
        key: key.name,
        modifiers: [key.ctrl ? "ctrl" : null, key.meta ? "alt" : null, key.shift ? "shift" : null].filter((value): value is "ctrl" | "alt" | "shift" => value !== null),
      };
      const result = router.handle(event, ["global"]);
      if (result.kind === "action") routed.push(result.action_id);
    });

    setup.mockInput.pressKey("x", { ctrl: true });
    expect(routed).toEqual(["operator.rebound"]);
  });

  test("records the layout-fragile notification band as a native frame", async () => {
    const adapter = new OpenTuiRenderer({ renderer: setup.renderer });
    await adapter.enter();
    const recorder = new TestRecorder(setup.renderer, { now: () => 42 });
    const model = {
      ...initialModel(),
      notifications: [{ id: "n1", severity: "warning" as const, message: "Budget low — compact now", createdAt: 1 }],
    };
    const projection: RenderProjection = {
      app: model,
      output: "campaign output",
      navigation: createNavigation({ id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "main", title: "Campaign" }] }, { columns: 52, rows: 10 }),
    };
    const scene = renderScene(projection);
    recorder.rec();
    adapter.render({ scene, text: paintScene(scene) });
    await setup.renderOnce();
    recorder.stop();

    expect(recorder.recordedFrames).toHaveLength(1);
    // Changed by M2.1's layout.ts wiring: 52x10 is now classified `minimal`
    // (ui-spec §2.1: cols<60 or rows<16), which reserves row 0 for the size
    // warning rather than a dedicated status/narrative row — that
    // information now lives inside the transcript/main pane's own content
    // instead. `status_row` is always `null` from the cockpit scene now (its
    // data moved into the header's zones, which minimal has none of). The
    // notification band is still real, hit-testable geometry; find it by
    // content rather than by a fixed "last 3 lines" offset, since the
    // composer's own anchored height now sits below it.
    expect(scene.layout_class).toBe("minimal");
    expect(scene.status_row).toBeNull();
    const lines = recorder.recordedFrames[0]!.frame.split("\n");
    expect(lines[0]).toContain("below 60x16");
    expect(lines.some((line) => line.includes("[warning] Budget low — compact now"))).toBe(true);
  });

  test("records the compact status bar exactly 80 columns wide with a real long campaign id", async () => {
    const longCampaignId = "8f14e45f-ceea-467e-bd3a-9b73f3ea7f0e";
    const setup80 = await createTestRenderer({ width: 80, height: 10 });
    try {
      const adapter = new OpenTuiRenderer({ renderer: setup80.renderer });
      await adapter.enter();
      const recorder = new TestRecorder(setup80.renderer, { now: () => 42 });
      const model = {
        ...initialModel(),
        telemetryCampaignId: longCampaignId,
        notifications: [{ id: "n1", severity: "warning" as const, message: "Budget low — compact now", createdAt: 1 }],
      };
      const projection: RenderProjection = {
        app: model,
        output: "campaign output",
        navigation: createNavigation({ id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "main", title: "Campaign" }] }, { columns: 80, rows: 10 }),
      };
      const scene = renderScene(projection);
      recorder.rec();
      adapter.render({ scene, text: paintScene(scene) });
      await setup80.renderOnce();
      recorder.stop();

      expect(recorder.recordedFrames).toHaveLength(1);
      // Changed by M2.1's layout.ts wiring: 80x10 is `minimal` (rows<16), so
      // row 0 is the size-warning row, not a dedicated status/narrative row
      // (see the sibling test above for the full rationale). It stays
      // exactly `columns` wide either way, and it still never leaks raw
      // campaign telemetry — the warning names only the terminal size.
      expect(scene.layout_class).toBe("minimal");
      expect(scene.status_row).toBeNull();
      const firstRow = recorder.recordedFrames[0]!.frame.split("\n")[0] ?? "";
      expect(firstRow).toHaveLength(80);
      expect(firstRow).toContain("below 60x16");
      expect(firstRow).not.toContain(longCampaignId);
    } finally {
      setup80.renderer.destroy();
    }
  });
});
