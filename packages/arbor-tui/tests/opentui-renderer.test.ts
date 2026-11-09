/// <reference types="bun-types" />
// bun:test only (ADR-036, docs/bun-migration-plan.md) — @opentui/core's native
// render library does not bind under Node, and fails identically inside
// vitest even when vitest itself is launched via `bun x` (Node workers).
// Run with: bun test packages/arbor-tui/tests/opentui-renderer.test.ts
//
// This drives the REAL OpenTuiRenderer (`../src/opentui-renderer.ts`) against
// the REAL `@arbor/tui` model/renderer pipeline (`initialModel`,
// `createNavigation`, `renderTerminalFrame`) and asserts on `@opentui/core`'s
// own captured terminal buffer (`createTestRenderer().captureCharFrame()`) —
// literal rendered text that can only appear if the native render path
// actually ran, not a mock standing in for it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createNavigation, getNamedTheme, initialModel, renderScene, type RenderedFrame, type RenderProjection, type SceneFrame } from "../src/index.js";
import { OpenTuiRenderer, type TerminalNotificationObservation } from "../src/opentui-renderer.js";
import { installScreens } from "../src/screens/install.js";
import { renderStructuredFrame, renderTerminalFrame, textOnlyFrame } from "./support/render-harness.js";

const ESC = String.fromCharCode(27);
const CSI = ESC + "[";
const RESET = CSI + "0m";

const WIDTH = 48;
const HEIGHT = 12;

function projection(output: string): RenderProjection {
  return {
    app: initialModel(),
    output,
    navigation: createNavigation(
      { id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "output", title: "Cockpit" }] },
      { columns: WIDTH, rows: HEIGHT },
    ),
  };
}

/** Every distinct [r,g,b] background this row's captured spans actually carry — the real per-cell colors `@opentui/core`'s own native render pass produced, not a re-derivation of what we asked it to draw. */
function statusRowBackgrounds(spans: ReturnType<TestRendererSetup["captureSpans"]>, rowIndex: number): Array<readonly [number, number, number]> {
  const line = spans.lines[rowIndex];
  if (line === undefined) return [];
  return line.spans.map((span) => {
    const [r, g, b] = span.bg.toInts();
    return [r, g, b] as const;
  });
}

let setup: TestRendererSetup;
let renderer: TestRenderer;

beforeEach(async () => {
  setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  renderer = setup.renderer;
});

afterEach(() => {
  renderer.destroy();
});

describe("OpenTuiRenderer against a real @opentui/core native renderer", () => {
  test("paints empty viewport cells opaque black rather than terminal-default transparency", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();
    adapter.render(textOnlyFrame("Solid background"));
    await setup.renderOnce();
    const spans = setup.captureSpans();
    expect(setup.captureCharFrame()).toContain("Solid background");
    expect(statusRowBackgrounds(spans, HEIGHT - 1)).toContainEqual([0, 0, 0]);
    for (const span of spans.lines[HEIGHT - 1]!.spans) expect(span.bg.toInts()[3]).toBe(255);
  });
  test("shows the focused workspace pane in its real native box title", async () => {
    const local = await createTestRenderer({ width: 80, height: 24 });
    try {
      const adapter = new OpenTuiRenderer({ renderer: local.renderer });
      await adapter.enter();
      const value = projection("focused pane");
      const navigation = createNavigation({
        id: "split", route: "/split", split: "horizontal", ratio: 0.5,
        panes: [{ id: "output", title: "Output" }, { id: "details", title: "Details" }],
      }, { columns: 80, rows: 24 });
      const scene = renderScene({ ...value, navigation });
      adapter.render({ text: scene.rows.join("\n"), scene });
      await local.renderOnce();
      expect(local.captureCharFrame()).toContain("▸ Output");
    } finally {
      local.renderer.destroy();
    }
  });
  test("Console's typed transcript-first/composer scene preserves the bottom composer at 80x24 and 120x40", async () => {
    installScreens();
    for (const dimensions of [{ width: 80, height: 24 }, { width: 120, height: 40 }]) {
      const local = await createTestRenderer({ ...dimensions });
      try {
        const app = {
          ...initialModel(),
          screen: "console" as const,
          grantedCapabilities: new Set(["campaign.read"]),
          screens: new Map([["console", {
            captured_at: "2026-08-29T00:00:00.000Z",
            console_input: { text: "first\nsecond", cursor: 12, focused: true, action: "queue", interrupt_available: true },
          }]]),
        };
        const consoleProjection: RenderProjection = {
          app: app as unknown as RenderProjection["app"], output: "generic",
          navigation: createNavigation(
            { id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "console", title: "Console" }] },
            { columns: dimensions.width, rows: dimensions.height },
          ),
        };
        const scene = renderScene(consoleProjection);
        const frame: RenderedFrame = { text: renderTerminalFrame(consoleProjection), scene };
        const pane = scene.panes[0]!;
        expect(pane.composer).toMatchObject({ kind: "console", action: "queue", focused: true });
        expect(pane.chronology).toEqual({ placement: "top", sticky_bottom: false });

        const adapter = new OpenTuiRenderer({ renderer: local.renderer });
        await adapter.enter();
        adapter.render(frame);
        await local.renderOnce();
        const captured = local.captureCharFrame();
        const tail = captured.split("\n").slice(-5).join("\n");
        expect(frame.text).toContain("❯");
        expect(captured).toContain("first");
        expect(captured).toContain("second▏");
        expect(tail).toContain("Enter queue");
        adapter.restore();
      } finally {
        local.renderer.destroy();
      }
    }
  });

  test("enter() adds a full-viewport TextRenderable to the real renderer's root", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    expect(renderer.root.getChildren().length).toBe(0);
    await adapter.enter();
    expect(renderer.root.getChildren().length).toBe(1);
    const [child] = renderer.root.getChildren();
    expect(child?.id).toBe("arbor-tui-frame");
  });

  test("render() paints real revoy2 frame content into the real terminal buffer", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();

    const frame = renderStructuredFrame(projection("λ signal from the cockpit"));
    adapter.render(frame);
    await setup.renderOnce();

    const captured = setup.captureCharFrame();
    // These strings only appear in the captured native buffer if the structured
    // frame genuinely flowed OpenTuiRenderer -> TextRenderable -> the real
    // Zig render pass -> the buffer @opentui/core's own testing harness reads
    // back out.
    // The native pane owns its border/title, so its title abuts the rule
    // (`┌─Cockpit`) instead of replaying the flattened terminal spacing.
    expect(captured).toContain("┌─Cockpit");
    expect(captured).toContain("λ signal from the cockpit");
  });

  test("render() replaces content wholesale on the next frame, not accumulates", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();

    adapter.render(renderStructuredFrame(projection("first frame marker")));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("first frame marker");

    adapter.render(renderStructuredFrame(projection("second frame marker")));
    await setup.renderOnce();
    const captured = setup.captureCharFrame();
    expect(captured).toContain("second frame marker");
    expect(captured).not.toContain("first frame marker");
  });

  test("reports a native commit only when OpenTUI emits its frame event", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();
    const observations: string[] = [];
    let settled = false;
    const committed = adapter.renderObserved(renderStructuredFrame(projection("commit marker")), {
      committed: () => observations.push("committed"),
      abandoned: (reason) => observations.push(`abandoned:${reason}`),
    }).then(() => { settled = true; });
    expect(observations).toEqual([]);
    expect(settled).toBe(false);

    await setup.renderOnce();
    await committed;
    expect(observations).toEqual(["committed"]);
    expect(settled).toBe(true);
  });

  test("abandons an uncommitted native frame when terminal ownership is restored", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();
    const observations: string[] = [];
    const abandoned = adapter.renderObserved(renderStructuredFrame(projection("pending marker")), {
      committed: () => observations.push("committed"),
      abandoned: (reason) => observations.push(reason),
    });

    adapter.restore();
    await abandoned;
    expect(observations).toEqual(["native renderer restored before the requested frame committed"]);
  });

  test("restore() removes the frame renderable from the real root without destroying an injected renderer", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();
    expect(renderer.root.getChildren().length).toBe(1);

    adapter.restore();
    expect(renderer.root.getChildren().length).toBe(0);
    expect(renderer.isDestroyed).toBe(false);
  });

  test("render() before enter() throws rather than silently no-op-ing", () => {
    const adapter = new OpenTuiRenderer({ renderer });
    expect(() => adapter.render(textOnlyFrame("unreachable"))).toThrow(/enter/);
  });

  test("notifies only for a blurred terminal and records a dropped delivery", async () => {
    const attempts: TerminalNotificationObservation[] = [];
    const emittedMessages: string[] = [];
    renderer.triggerNotification = ((message: string) => { emittedMessages.push(message); return false; }) as typeof renderer.triggerNotification;
    const adapter = new OpenTuiRenderer({ renderer, themeModeTimeoutMs: 1, onNotificationAttempt: (value) => attempts.push(value) });
    await adapter.enter();
    const warning = { id: "warning-1", severity: "warning" as const, message: "attention required", createdAt: 1 };

    adapter.publishNotifications([warning]);
    expect(emittedMessages).toEqual([]);
    renderer.emit("blur");
    adapter.publishNotifications([warning, { ...warning, id: "warning-2" }]);

    expect(emittedMessages).toEqual(["attention required"]);
    expect(attempts).toEqual([{ notification_id: "warning-2", focus: "blurred", emitted: false }]);
    renderer.emit("focus");
    adapter.publishNotifications([warning, { ...warning, id: "warning-3" }]);
    expect(emittedMessages).toHaveLength(1);
  });

  test("keeps notification mechanism and condition as independent axes", async () => {
    const emitted: string[] = [];
    renderer.triggerNotification = ((message: string) => { emitted.push(message); return true; }) as typeof renderer.triggerNotification;
    const always = new OpenTuiRenderer({ renderer, notificationCondition: "always", notificationMechanism: "terminal" });
    await always.enter();
    always.publishNotifications([{ id: "always", severity: "warning", message: "always attempt", createdAt: 1 }]);
    expect(emitted).toEqual(["always attempt"]);
    always.restore();

    const disabled = new OpenTuiRenderer({ renderer, notificationCondition: "always", notificationMechanism: "off" });
    await disabled.enter();
    disabled.publishNotifications([{ id: "disabled", severity: "error", message: "must stay local", createdAt: 2 }]);
    expect(emitted).toEqual(["always attempt"]);
  });

  test("named theme switch repaint: a second structured frame paints the new theme's real native background cells, with no literal SGR bytes and no stale color bleed-through", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();

    const moss = getNamedTheme("moss-agate")!;
    const sandstone = getNamedTheme("sandstone-thicket")!;
    expect(moss.colors.background).not.toEqual(sandstone.colors.background);
    const statusRowIndex = HEIGHT - 1;

    adapter.render(renderStructuredFrame(projection("cockpit signal"), { color: true, theme: moss }));
    await setup.renderOnce();
    const mossCaptured = setup.captureCharFrame();
    expect(mossCaptured).toContain("cockpit signal");
    // The flattened text still carries SGR styling; the native renderer must
    // consume it rather than paint its raw control-sequence digits.
    expect(mossCaptured).not.toContain(moss.colors.background.join(";"));
    const mossStatusBg = statusRowBackgrounds(setup.captureSpans(), statusRowIndex);
    expect(mossStatusBg).toContainEqual(moss.colors.background);

    adapter.render(renderStructuredFrame(projection("cockpit signal"), { color: true, theme: sandstone }));
    await setup.renderOnce();
    const sandstoneCaptured = setup.captureCharFrame();
    expect(sandstoneCaptured).toContain("cockpit signal");
    expect(sandstoneCaptured).not.toContain(sandstone.colors.background.join(";"));
    const sandstoneStatusBg = statusRowBackgrounds(setup.captureSpans(), statusRowIndex);
    expect(sandstoneStatusBg).toContainEqual(sandstone.colors.background);
    // No stale bleed-through: the previous theme's background cells are gone.
    expect(sandstoneStatusBg).not.toContainEqual(moss.colors.background);
  });

  test("structured-frame pane content (SceneFrame.panes[].content) paints real fg/bg/bold cells from embedded SGR, not literal escape bytes", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();

    const scene: SceneFrame = {
      columns: WIDTH,
      rows: Array.from({ length: HEIGHT }, () => " ".repeat(WIDTH)),
      status_row: null,
      panes: [
        {
          id: "output",
          x: 0,
          y: 0,
          columns: WIDTH,
          rows: HEIGHT,
          title: "Cockpit",
          content: [
            `${CSI}1m${CSI}38;2;220;40;40m` + "danger line" + RESET,
            "plain line",
          ],
        },
      ],
    };
    const frame: RenderedFrame = { text: "", scene };
    adapter.render(frame);
    await setup.renderOnce();

    const captured = setup.captureCharFrame();
    expect(captured).toContain("danger line");
    expect(captured).toContain("plain line");
    expect(captured).not.toContain("38;2;220;40;40");

    const spans = setup.captureSpans();
    const dangerSpans = spans.lines
      .flatMap((line) => line.spans)
      .filter((span) => span.text.includes("danger line") || (span.fg.toInts()[0] === 220 && span.fg.toInts()[1] === 40 && span.fg.toInts()[2] === 40));
    expect(dangerSpans.length).toBeGreaterThan(0);
    for (const span of dangerSpans) {
      expect(span.fg.toInts().slice(0, 3)).toEqual([220, 40, 40]);
    }
  });

  test("structured-frame status bar (SceneFrame.rows[status_row]) paints the real per-theme background cell, replacing the previous theme's on the next draw", async () => {
    const adapter = new OpenTuiRenderer({ renderer });
    await adapter.enter();

    const moss = getNamedTheme("moss-agate")!;
    const sandstone = getNamedTheme("sandstone-thicket")!;
    const statusRowIndex = HEIGHT - 1;

    const mossScene = renderScene(projection("cockpit signal"), { color: true, theme: moss });
    adapter.render({ text: renderTerminalFrame(projection("cockpit signal"), { color: true, theme: moss }), scene: mossScene });
    await setup.renderOnce();
    expect(statusRowBackgrounds(setup.captureSpans(), statusRowIndex)).toContainEqual(moss.colors.background);

    const sandstoneScene = renderScene(projection("cockpit signal"), { color: true, theme: sandstone });
    adapter.render({ text: renderTerminalFrame(projection("cockpit signal"), { color: true, theme: sandstone }), scene: sandstoneScene });
    await setup.renderOnce();
    const sandstoneStatusBg = statusRowBackgrounds(setup.captureSpans(), statusRowIndex);
    expect(sandstoneStatusBg).toContainEqual(sandstone.colors.background);
    expect(sandstoneStatusBg).not.toContainEqual(moss.colors.background);

    const captured = setup.captureCharFrame();
    expect(captured).not.toContain(sandstone.colors.background.join(";"));
  });

  test("reports capabilities and an explicit dark fallback when theme discovery times out", async () => {
    const observations: unknown[] = [];
    const adapter = new OpenTuiRenderer({ renderer, themeModeTimeoutMs: 1, onTerminalProfile: (value) => observations.push(value) });
    await adapter.enter();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ theme_mode: "dark" });
  });
});
