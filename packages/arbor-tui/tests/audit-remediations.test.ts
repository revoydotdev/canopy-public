import { afterEach, describe, expect, it } from "vitest";
import { TerminalInputDecoder } from "../src/input-terminal.js";
import { initialModel } from "../src/model.js";
import { createNavigation } from "../src/navigation.js";
import { renderScene } from "../src/renderer.js";
import { clearRegisteredScreens, registerScreen, type ScreenModule } from "../src/screens/screen.js";
import { operationsScreen } from "../src/screens/operations.js";
import { configScreen } from "../src/screens/config.js";
import { renderStreamViewport, sanitizeUntrustedTerminalText } from "../src/widgets.js";

const ESC = String.fromCharCode(27);

afterEach(() => clearRegisteredScreens());

describe("audit remediations", () => {
  it("removes terminal controls from disclosed stream data", () => {
    const hostile = `before${ESC}]52;c;clipboard${String.fromCharCode(7)}after\r`;
    expect(sanitizeUntrustedTerminalText(hostile)).not.toContain(ESC);
    expect(renderStreamViewport(hostile, { width: 120, height: 2 }).join("\n")).not.toContain(ESC);
  });

  it("keeps a split CSI key until its remaining bytes arrive", () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.decode(`prefix${ESC}[`).text).toBe("prefix");
    expect(decoder.decode("5~").keys).toEqual([{ key: "pageup" }]);
    expect(decoder.decode(ESC).text).toBe("");
    expect(decoder.flush().text).toBe(ESC);
  });

  it("forwards each screen's model-owned scroll offset to rendering", () => {
    let observed: number | undefined;
    const screen: ScreenModule = {
      id: "jobs",
      title: "Scroll probe",
      required_capabilities: ["probe.read"],
      surface: { commands: [], queries: [] },
      project: () => ({ screen: "jobs", rows: [], columns: [], variant: "probe" }),
      render: (input) => {
        observed = input.scroll_offset;
        return ["probe"];
      },
    };
    registerScreen(screen);
    const app = {
      ...initialModel(),
      screen: "jobs" as const,
      grantedCapabilities: new Set(["probe.read"]),
      scrollOffsets: new Map([["jobs" as const, 7]]),
    };
    const navigation = createNavigation({ id: "main", route: "/", panes: [{ id: "content", title: "Content" }], split: "horizontal", ratio: 0.5 }, { columns: 100, rows: 30 });
    renderScene({ app, navigation, output: "" });
    expect(observed).toBe(7);
  });

  it("rejects a workspace whose third pane would otherwise be dropped", () => {
    expect(() => createNavigation({ id: "main", route: "/", panes: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }], split: "horizontal", ratio: 0.5 }, { columns: 120, rows: 30 })).toThrow("at most two panes");
  });

  it("keeps event rows out of the operation-registry surface", () => {
    const rejected = operationsScreen.project([{ code: "transport", summary: "disconnected" }], { width: 80, height: 10 });
    expect(rejected.variant).toBe("empty");
    expect(rejected.caption).toContain("unrecognised");
    expect(operationsScreen.project([{ operation_id: "op-1", state: "running", capability: "operation.read" }], { width: 80, height: 10 }).variant).toBe("operations");
  });

  it("fails closed when a redacted config leaf still carries a value", () => {
    const projection = configScreen.project({ leaves: [{ path: "native.api_key", source: "file", value: "secret", redacted: true }] }, { width: 80, height: 10 });
    expect(projection.rows[0]?.value).toBe("[redacted]");
  });
});
