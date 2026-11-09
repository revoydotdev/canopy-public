import { describe, expect, it } from "vitest";
import { ANSI, devtoolsScreen, type DevToolsStreamLine } from "../src/index.js";

const context = { width: 72, height: 12 };

function event(overrides: Partial<DevToolsStreamLine>): DevToolsStreamLine {
  return {
    seq: 1,
    ts: "now",
    event_kind: "custom.event",
    campaign_id: null,
    node_id: null,
    synthetic: false,
    ...overrides,
  };
}

function project(lines: readonly DevToolsStreamLine[]) {
  return devtoolsScreen.project({ campaign_id: null, lines }, context);
}

describe("devtools responsive and degraded event rendering", () => {
  it("renders an ANSI-safe idle header and a metadata row with absent optional fields", () => {
    const idle = devtoolsScreen.project({ campaign_id: null, lines: [] }, context);
    const idleText = devtoolsScreen.render({ projection: idle, ...context, frame_count: 1, color: true }).join("\n");
    expect(idleText).toContain(ANSI.dim);
    expect(idleText).toContain("○");
    expect(idleText).toContain("streaming");

    const projection = project([event({ seq: 0, ts: "", event_kind: "", node_state: undefined })]);
    const text = devtoolsScreen.render({ projection, ...context, color: true }).join("\n");
    expect(text).toContain("0");
    expect(text).not.toContain("campaign:");
    expect(text).not.toContain("last:");
  });

  it("does not flash expired transitions and keeps unknown event classes uncolored", () => {
    const projection = project([event({ node_id: "node-1" })]);
    const text = devtoolsScreen.render({
      projection, ...context, color: true,
      transitions: new Map([["node-1", { state: "verified", frames_remaining: 0 }]]),
    }).join("\n");
    expect(text).not.toContain(ANSI.inverse);
    expect(text).toContain("custom.event");
  });

  it("renders failed inference traces from full responses including blank lines and height limits", () => {
    const projection = project([event({
      event_kind: "loop.inference_trace", synthetic: true,
      loop_event: { phase: null, model: null, ok: false, response_full: "first\n\nsecond" },
    })]);
    const colored = devtoolsScreen.render({ projection, ...context, height: 5, color: true });
    expect(colored.join("\n")).toContain("fail");
    expect(colored.join("\n")).toContain(ANSI.cyan);
    expect(colored).toContain("");

    const headerOnly = devtoolsScreen.render({ projection, ...context, height: 1, color: false });
    expect(headerOnly).toHaveLength(1);
  });

  it("renders plain diff defaults and all hunk line classes without assuming color support", () => {
    const projection = project([event({
      event_kind: "loop.diff",
      loop_event: { diff: "+added\n-removed\n@@ context\n unchanged" },
    })]);
    const plain = devtoolsScreen.render({ projection, ...context, color: false }).join("\n");
    expect(plain).toContain("0+/0-");
    expect(plain).toContain("+added");
    expect(plain).toContain("-removed");
    expect(plain).toContain("@@ context");
    expect(plain).not.toContain("\u001b[");
  });

  it("shows failed tool calls without fabricating args or stdout and supports colored headers", () => {
    const projection = project([event({
      event_kind: "loop.tool_call",
      loop_event: { tool: null, ok: false },
    })]);
    const plain = devtoolsScreen.render({ projection, ...context, color: false }).join("\n");
    expect(plain).toContain("failed");
    expect(plain).not.toContain(" ·  · ");
    const colored = devtoolsScreen.render({ projection, ...context, color: true }).join("\n");
    expect(colored).toContain(ANSI.yellow);
  });

  it("falls back to metadata for null rich payloads and clamps both scroll directions", () => {
    const projection = project([
      event({ seq: 1, event_kind: "loop.tool_call", loop_event: null }),
      event({ seq: 2, event_kind: "custom.tail" }),
    ]);
    const negative = devtoolsScreen.render({ projection, ...context, scroll_offset: -10 }).join("\n");
    expect(negative).toContain("loop.tool_call");
    const beyond = devtoolsScreen.render({ projection, ...context, scroll_offset: 99 });
    expect(beyond).toHaveLength(1);
  });
});
