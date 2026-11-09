import { describe, expect, it, afterEach } from "vitest";
import { SsePainter, TerminalPainter, encodeFrameAsJson, paintTargetFromRenderFn, createNavigation, initialModel, renderScene, type Frame, type RenderProjection } from "../src/index.js";
import { installScreens } from "../src/screens/install.js";
import { clearRegisteredScreens } from "../src/screens/screen.js";
import { renderTerminalFrame } from "./support/render-harness.js";

const ANSI_RESET = `${String.fromCharCode(27)}[0m`;

function projection(columns = 40, rows = 8, output = "hello"): RenderProjection {
  return {
    app: initialModel(), output,
    navigation: createNavigation({
      id: "main", route: "/", split: "horizontal", ratio: 0.5,
      panes: [{ id: "output", title: "Output" }],
    }, { columns, rows }),
  };
}

afterEach(() => clearRegisteredScreens());

describe("renderScene", () => {
  it("is the same composition renderTerminalFrame flattens (rows joined == string frame)", () => {
    const p = projection(40, 8, "λ output");
    const scene = renderScene(p);
    expect(scene.columns).toBe(40);
    expect(scene.rows.join("\n")).toBe(renderTerminalFrame(p));
  });

  it("matches renderTerminalFrame across a screen-backed projection too", () => {
    installScreens();
    const app = { ...initialModel(), screen: "campaigns" as const, grantedCapabilities: new Set(["campaign.read", "tree.read"]) };
    const screens = new Map(app.screens);
    screens.set("campaigns", [{ id: "camp-01", plan_path: "plans/Refactor TUI Shell", halted: false, root_node_state: "expanding", total_nodes: 42, verified_nodes: 10 }]);
    const p: RenderProjection = {
      app: { ...app, screens },
      output: "generic",
      navigation: createNavigation({ id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "screen", title: "Screen" }] }, { columns: 100, rows: 20 }),
    };
    expect(renderScene(p).rows.join("\n")).toBe(renderTerminalFrame(p));
  });
});

describe("TerminalPainter", () => {
  it("paints byte-identical output to renderTerminalFrame (no color)", () => {
    const p = projection(40, 8, "λ output");
    const scene = renderScene(p);
    let painted = "";
    new TerminalPainter().paint(scene, { write: (v) => { painted = v; } });
    expect(painted).toBe(renderTerminalFrame(p));
  });

  it("paints byte-identical output to renderTerminalFrame (color, SGR-wrapped)", () => {
    const p = projection(40, 8, "λ output");
    const scene = renderScene(p, { color: true });
    let painted = "";
    new TerminalPainter({ color: true }).paint(scene, { write: (v) => { painted = v; } });
    expect(painted).toBe(renderTerminalFrame(p, { color: true }));
    expect(painted.startsWith(ANSI_RESET)).toBe(true);
    expect(painted.endsWith(ANSI_RESET)).toBe(true);
  });

  it("adapts a RendererPort-shaped render() function via paintTargetFromRenderFn", () => {
    const received: string[] = [];
    const target = paintTargetFromRenderFn((frame) => { received.push(frame); });
    const scene: Frame = { columns: 3, rows: ["abc", "def"] };
    new TerminalPainter().paint(scene, target);
    expect(received).toEqual(["abc\ndef"]);
  });
});

describe("SsePainter", () => {
  it("frames the same canonical JSON payload as an SSE 'frame' event", () => {
    const scene: Frame = { columns: 5, rows: ["hello", "world"] };
    let out = "";
    new SsePainter().paint(scene, { write: (v) => { out = v; } });
    expect(out).toBe(`event: frame\ndata: ${encodeFrameAsJson(scene)}\n\n`);
    expect(out.startsWith("event: frame\ndata: ")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(true);
    const dataLine = out.split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(dataLine!.slice("data: ".length))).toEqual({ columns: 5, rows: ["hello", "world"] });
  });
});
