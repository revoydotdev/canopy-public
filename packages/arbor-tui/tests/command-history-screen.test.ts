import { describe, expect, it } from "vitest";
import {
  ANSI,
  clearRegisteredScreens,
  commandHistoryScreen,
  installScreens,
  availableScreens,
  type DevToolsStreamLine,
} from "../src/index.js";

function line(overrides: Partial<DevToolsStreamLine> = {}): DevToolsStreamLine {
  return {
    seq: 1,
    ts: "2026-08-27T13:37:42.000Z",
    event_kind: "loop.tool_call",
    campaign_id: "demo-1",
    node_id: "n1",
    synthetic: false,
    ...overrides,
  };
}

function stream(lines: readonly DevToolsStreamLine[], campaign_id: string | null = "demo-1") {
  return { campaign_id, lines };
}

describe("command history screen — projection", () => {
  it("filters the devtools stream down to loop.tool_call rows only", () => {
    const input = stream([
      line({ seq: 1, event_kind: "loop.specialist_dispatched" }),
      line({ seq: 2, event_kind: "loop.tool_call", loop_event: { type: "tool_call", tool: "bash", args: "wc -l f.txt", ok: true, stdout: "1 f.txt\n" } }),
      line({ seq: 3, event_kind: "loop.node_verified", node_state: "verified" }),
    ]);
    const projection = commandHistoryScreen.project(input, { width: 100, height: 40 });
    expect(projection.screen).toBe("command-history");
    expect(projection.rows).toHaveLength(1);
    expect(projection.rows[0].seq).toBe(2);
  });

  it("keeps history bounded (never unbounded growth)", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      line({ seq: i, loop_event: { type: "tool_call", tool: "bash", args: `cmd ${i}`, ok: true, stdout: "" } }),
    );
    const projection = commandHistoryScreen.project(stream(many), { width: 100, height: 40 });
    expect(projection.rows.length).toBeLessThanOrEqual(200);
    expect(projection.rows.at(-1)?.seq).toBe(499);
  });

  it("returns an empty projection for null / unrecognised shapes", () => {
    const empty = commandHistoryScreen.project(null, { width: 80, height: 40 });
    expect(empty.rows).toHaveLength(0);
    expect(empty.caption).toContain("No command history");
    const unknown = commandHistoryScreen.project({ hello: 1 }, { width: 80, height: 40 });
    expect(unknown.rows).toHaveLength(0);
    expect(unknown.caption).toContain("unrecognised");
  });

  it("returns a real 'nothing yet' caption, distinct from unrecognised, when the stream is simply empty of commands", () => {
    const empty = commandHistoryScreen.project(stream([]), { width: 80, height: 40 });
    expect(empty.rows).toHaveLength(0);
  });
});

describe("command history screen — render", () => {
  it("renders a real full command, its output, and exit code (the operator's actual ask)", () => {
    const projection = commandHistoryScreen.project(stream([
      line({
        seq: 2,
        loop_event: { type: "tool_call", tool: "bash", args: "wc -l f.txt", ok: true, exit: 0, duration_ms: 5, stdout: "1 f.txt\n", command: JSON.stringify({ command: "wc -l f.txt" }) },
      }),
    ]), { width: 100, height: 30 });
    const lines = commandHistoryScreen.render({ projection, width: 100, height: 30 });
    const body = lines.join("\n");
    expect(body).toContain("bash");
    expect(body).toContain("ok");
    expect(body).toContain("exit 0");
    expect(body).toContain("$ ");
    expect(body).toContain("1 f.txt");
  });

  it("renders a failing command distinctly, with its output still visible", () => {
    const projection = commandHistoryScreen.project(stream([
      line({ seq: 2, loop_event: { type: "tool_call", tool: "bash", args: "false", ok: false, exit: 1, stdout: "" } }),
    ]), { width: 100, height: 30 });
    const lines = commandHistoryScreen.render({ projection, width: 100, height: 30, color: true });
    const body = lines.join("\n");
    expect(body).toContain("failed");
    expect(body).toContain("exit 1");
    // A failed command is an operation-scoped failure: prominent warning,
    // while danger remains reserved for terminal/session loss.
    expect(body).toContain(ANSI.yellow);
  });

  it("uses the shared operator grammar for parentage, source truth, and distinct stdout/stderr", () => {
    const projection = commandHistoryScreen.project(stream([
      line({
        seq: 7,
        node_id: "node-7",
        loop_event: {
          type: "tool_call", tool: "bash", command: "bun run build", ok: false, exit: 2,
          parent_id: "tool-parent", stdout: "typecheck started", stderr: "TS9999: deliberate fixture failure",
        },
      }),
    ]), { width: 100, height: 30 });
    const body = commandHistoryScreen.render({ projection, width: 100, height: 30 }).join("\n");
    expect(body).toContain("↳ tool-parent");
    expect(body).toContain("supplemental/devtools");
    expect(body).toContain("[stdout]");
    expect(body).toContain("typecheck started");
    expect(body).toContain("[stderr]");
    expect(body).toContain("TS9999");
  });

  it("degrades gracefully on a legacy dispatch-level tool_call with no exit/command fields", () => {
    const projection = commandHistoryScreen.project(stream([
      line({ seq: 2, loop_event: { type: "tool_call", tool: "opencode.panel_review", args: "lenticel · openrouter/x", ok: true, stdout: "approved" } }),
    ]), { width: 100, height: 30 });
    const lines = commandHistoryScreen.render({ projection, width: 100, height: 30 });
    const body = lines.join("\n");
    expect(body).toContain("opencode.panel_review");
    expect(body).not.toMatch(/exit \d/); // no exit field on this legacy shape
  });

  it("never throws on a malformed loop_event payload", () => {
    const projection = commandHistoryScreen.project(stream([
      line({ seq: 2, loop_event: "not an object" }),
      line({ seq: 3, loop_event: undefined }),
    ]), { width: 100, height: 30 });
    expect(() => commandHistoryScreen.render({ projection, width: 100, height: 30 })).not.toThrow();
  });

  it("shows a real empty-state message when there is no data yet", () => {
    const projection = commandHistoryScreen.project(stream([]), { width: 80, height: 10 });
    const lines = commandHistoryScreen.render({ projection, width: 80, height: 10 });
    expect(lines.join("\n")).toContain("no commands recorded yet");
  });

  it("wraps output to the viewport width — never a line wider than the pane", () => {
    const projection = commandHistoryScreen.project(stream([
      line({ seq: 2, loop_event: { type: "tool_call", tool: "bash", args: "cmd", ok: true, stdout: "x".repeat(200) } }),
    ]), { width: 40, height: 20 });
    const lines = commandHistoryScreen.render({ projection, width: 40, height: 20 });
    for (const rendered of lines) expect([...rendered].length).toBeLessThanOrEqual(40);
  });

  it("supports scroll_offset windowing across many commands", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      line({ seq: i, loop_event: { type: "tool_call", tool: "bash", args: `cmd ${i}`, ok: true, stdout: "" } }),
    );
    const projection = commandHistoryScreen.project(stream(many), { width: 100, height: 10 });
    const fromStart = commandHistoryScreen.render({ projection, width: 100, height: 10, scroll_offset: 0 }).join("\n");
    const scrolled = commandHistoryScreen.render({ projection, width: 100, height: 10, scroll_offset: 40 }).join("\n");
    expect(fromStart).not.toBe(scrolled);
    expect(scrolled).toContain("cmd 40");
  });
});

describe("command history screen — registration", () => {
  it("is registered and gated on devtools.read, same as the raw devtools stream", () => {
    installScreens();
    try {
      const granted = availableScreens(new Set(["devtools.read"]));
      expect(granted.map((s) => s.id)).toContain("command-history");
      const without = availableScreens(new Set([]));
      expect(without.map((s) => s.id)).not.toContain("command-history");
    } finally {
      clearRegisteredScreens();
    }
  });
});
