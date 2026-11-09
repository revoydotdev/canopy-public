import { describe, expect, it } from "vitest";
import {
  ANSI,
  clearRegisteredScreens,
  devtoolsScreen,
  displayWidth,
  installScreens,
  availableScreens,
  type DevToolsStreamLine,
} from "../src/index.js";

function line(overrides: Partial<DevToolsStreamLine> = {}): DevToolsStreamLine {
  return {
    seq: 1,
    ts: "2026-08-03T13:37:42.000Z",
    event_kind: "tree.node_changed",
    campaign_id: "demo-1",
    node_id: "n1",
    synthetic: false,
    ...overrides,
  };
}

function stream(lines: readonly DevToolsStreamLine[], campaign_id: string | null = "demo-1") {
  return { campaign_id, lines };
}

describe("devtools screen — projection", () => {
  it("projects a DevToolsStreamShape into bounded rows (newest at the bottom)", () => {
    const input = stream([
      line({ seq: 1, event_kind: "loop.specialist_dispatched", node_id: "n1" }),
      line({ seq: 2, event_kind: "loop.node_verified", node_id: "n2", node_state: "verified" }),
      line({ seq: 3, event_kind: "loop.node_failed", node_id: "n3", node_state: "failed" }),
    ]);
    const projection = devtoolsScreen.project(input, { width: 100, height: 40 });
    expect(projection.screen).toBe("devtools");
    expect(projection.rows).toHaveLength(3);
    expect(projection.rows[0].event_kind).toBe("loop.specialist_dispatched");
    expect(projection.rows[2].event_kind).toBe("loop.node_failed");
    expect(projection.rows[2].node_state).toBe("failed");
    expect(projection.caption).toContain("3");
  });

  it("keeps the activity strip bounded (never unbounded growth)", () => {
    const huge = Array.from({ length: 10_000 }, (_, i) =>
      line({ seq: i, event_kind: "tree.node_changed", node_id: `n-${i}`, node_state: "expanding" }),
    );
    const projection = devtoolsScreen.project(stream(huge), { width: 100, height: 40 });
    // Capped at the screen's MAX_LINES (100), not 10_000.
    expect(projection.rows.length).toBeLessThanOrEqual(100);
    // Newest lines are retained (the tail of the stream).
    expect(projection.rows.at(-1)?.seq).toBe(9_999);
  });

  it("returns an empty projection for null / unknown / empty shapes", () => {
    const empty = devtoolsScreen.project(null, { width: 80, height: 40 });
    expect(empty.rows).toHaveLength(0);
    const unknown = devtoolsScreen.project({ hello: 1 }, { width: 80, height: 40 });
    expect(unknown.rows).toHaveLength(0);
    const notStream = devtoolsScreen.project([line()], { width: 80, height: 40 });
    expect(notStream.rows).toHaveLength(0);
    const emptyLines = devtoolsScreen.project(stream([]), { width: 80, height: 40 });
    expect(emptyLines.rows).toHaveLength(0);
  });
});

describe("devtools screen — render", () => {
  it("renders a header + placeholder when the stream is empty", () => {
    const projection = devtoolsScreen.project(stream([]), { width: 80, height: 10 });
    const lines = devtoolsScreen.render({ projection, width: 80, height: 10 });
    expect(lines[0]).toContain("streaming");
    expect(lines[1]).toContain("no devtools activity yet");
  });

  it("renders seq + ts + event + campaign + node + state per line", () => {
    const projection = devtoolsScreen.project(
      stream([line({ seq: 7, event_kind: "loop.node_verified", node_id: "n-7", node_state: "verified" })]),
      { width: 120, height: 10 },
    );
    const lines = devtoolsScreen.render({ projection, width: 120, height: 10 });
    const body = lines.slice(1).join("\n");
    expect(body).toContain("7");
    expect(body).toContain("loop.node_verified");
    expect(body).toContain("demo-1");
    expect(body).toContain("n-7");
    expect(body).toContain("verified");
  });

  it("keeps column alignment when a field contains CJK/emoji (padField must use displayWidth, never .length)", () => {
    const projection = devtoolsScreen.project(
      stream([
        line({ seq: 1, event_kind: "loop.node_verified", node_id: "n-ascii", node_state: "verified" }),
        line({ seq: 2, event_kind: "tree.node_changed", node_id: "漢字ノード", node_state: "pending" }),
      ]),
      { width: 120, height: 10 },
    );
    const lines = devtoolsScreen.render({ projection, width: 120, height: 10, color: false });
    const body = lines.slice(1);
    expect(body).toHaveLength(2);
    // Both lines pad seq/ts/event/campaign/node/state to the same fixed field
    // widths, so their total display width must be identical regardless of
    // the CJK node id — a `.length`-based pad would under-pad the wide-glyph
    // row and misalign the "State" column that follows it.
    const widths = body.map((l) => displayWidth(l));
    expect(new Set(widths).size).toBe(1);
  });

  it("colorizes verified lines green when color is enabled", () => {
    const projection = devtoolsScreen.project(
      stream([line({ seq: 1, event_kind: "loop.node_verified", node_id: "n1", node_state: "verified" })]),
      { width: 120, height: 10 },
    );
    const plain = devtoolsScreen.render({ projection, width: 120, height: 10 });
    expect(plain.join("\n")).not.toContain("\u001b[");
    const colored = devtoolsScreen.render({ projection, width: 120, height: 10, color: true });
    expect(colored.join("\n")).toContain(ANSI.green);
    expect(colored.join("\n")).toContain(ANSI.reset);
  });

  it("highlights a flashing node row with inverse video", () => {
    const projection = devtoolsScreen.project(
      stream([line({ seq: 1, event_kind: "loop.node_verified", node_id: "n1", node_state: "verified" })]),
      { width: 120, height: 10 },
    );
    const transitions = new Map([["n1", { state: "verified", frames_remaining: 5 }]]);
    const lines = devtoolsScreen.render({ projection, width: 120, height: 10, color: true, transitions });
    expect(lines.slice(1).join("\n")).toContain(ANSI.inverse);
  });

  it("pulses the header dot across frame counts", () => {
    const projection = devtoolsScreen.project(
      stream([line({ seq: 1, event_kind: "loop.halt", node_id: null })]),
      { width: 120, height: 10 },
    );
    const even = devtoolsScreen.render({ projection, width: 120, height: 10, frame_count: 0 });
    const odd = devtoolsScreen.render({ projection, width: 120, height: 10, frame_count: 1 });
    expect(even[0]).toContain("●");
    expect(odd[0]).toContain("○");
  });

  it("bounds rendered output to the viewport height", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      line({ seq: i, event_kind: "tree.node_changed", node_id: `n-${i}`, node_state: "expanding" }),
    );
    const projection = devtoolsScreen.project(stream(many), { width: 100, height: 20 });
    const lines = devtoolsScreen.render({ projection, width: 100, height: 20 });
    // header + up to height-1 body lines
    expect(lines.length).toBeLessThanOrEqual(20);
    for (const rendered of lines) {
      expect([...rendered].length).toBeLessThanOrEqual(100);
    }
  });
});

describe("devtools screen — synthetic marker (real vs backfilled events must be visually distinct)", () => {
  it("marks a synthetic (backfilled) line with `~`, a real one with a blank cell", () => {
    const projection = devtoolsScreen.project(
      stream([
        line({ seq: 1, event_kind: "tree.node_changed", node_id: "n1", node_state: "pending", synthetic: false }),
        line({ seq: 2, event_kind: "tree.node_changed", node_id: "n2", node_state: "pending", synthetic: true }),
      ]),
      { width: 120, height: 10 },
    );
    const lines = devtoolsScreen.render({ projection, width: 120, height: 10 });
    const [realLine, syntheticLine] = lines.slice(1);
    expect(realLine).not.toContain("~");
    expect(syntheticLine).toContain("~");
  });

  it("marks a synthetic rich row (inference trace) the same way", () => {
    const projection = devtoolsScreen.project(
      stream([
        line({
          event_kind: "loop.inference_trace",
          node_id: "n9",
          synthetic: true,
          loop_event: { type: "inference_trace", phase: "specialist", model: "m", ok: true, response_preview: "hello" },
        }),
      ]),
      { width: 100, height: 30 },
    );
    const lines = devtoolsScreen.render({ projection, width: 100, height: 30 });
    expect(lines.slice(1).join("\n")).toContain("~◆");
  });

  it("carries row_ids keyed by the ring line's own seq", () => {
    const projection = devtoolsScreen.project(
      stream([line({ seq: 42, event_kind: "tree.node_changed", node_id: "n1" })]),
      { width: 100, height: 10 },
    );
    expect(projection.row_ids).toEqual([{ id: "42" }]);
  });
});

describe("devtools screen — registration", () => {
  it("is registered and gated on devtools.read", () => {
    clearRegisteredScreens();
    installScreens();
    try {
      const granted = availableScreens(new Set(["devtools.read"]));
      expect(granted.map((s) => s.id)).toContain("devtools");
      const without = availableScreens(new Set([]));
      expect(without.map((s) => s.id)).not.toContain("devtools");
    } finally {
      clearRegisteredScreens();
    }
  });
});

describe("devtools screen — rich content panes (4F.11/4F.12/4F.13)", () => {
  it("4F.11 renders an inference trace's response text, not just the event-kind row", () => {
    const projection = devtoolsScreen.project(stream([
      line({
        event_kind: "loop.inference_trace",
        node_id: "n9",
        loop_event: { type: "inference_trace", phase: "specialist", model: "m", ok: true, response_preview: "I propose renaming the clamp to a brace." },
      }),
    ]), { width: 100, height: 30 });
    const lines = devtoolsScreen.render({ projection, width: 100, height: 30 });
    const body = lines.join("\n");
    expect(body).toContain("◆");
    expect(body).toContain("I propose renaming the clamp to a brace.");
    expect(body).toContain("specialist");
  });

  it("4F.11 wraps long inference text to the viewport width", () => {
    const projection = devtoolsScreen.project(stream([
      line({ event_kind: "loop.inference_trace", node_id: "n9", loop_event: { type: "inference_trace", phase: "specialist", model: "m", ok: true, response_preview: "x".repeat(200) } }),
    ]), { width: 40, height: 20 });
    const lines = devtoolsScreen.render({ projection, width: 40, height: 20 });
    for (const rendered of lines) expect([...rendered].length).toBeLessThanOrEqual(40);
  });

  it("4F.12 renders a diff hunk with +/- lines colorized", () => {
    const projection = devtoolsScreen.project(stream([
      line({
        event_kind: "loop.diff",
        node_id: "n9",
        loop_event: { type: "diff", path: "scoring.ts", additions: 2, deletions: 1, diff: "diff --git a/scoring.ts b/scoring.ts\n@@ -1,3 +1,4 @@\n-const c = 1.41;\n+const c = 1.414;\n+logger.trace(\"ok\");" },
      }),
    ]), { width: 100, height: 30 });
    const lines = devtoolsScreen.render({ projection, width: 100, height: 30, color: true });
    const body = lines.join("\n");
    expect(body).toContain("▽ diff");
    expect(body).toContain(ANSI.green);
    expect(body).toContain("+const c = 1.414;");
    expect(body).toContain(ANSI.red);
    expect(body).toContain("-const c = 1.41;");
  });

  it("4F.13 renders a tool call with name, args, and result", () => {
    const projection = devtoolsScreen.project(stream([
      line({
        event_kind: "loop.tool_call",
        node_id: "n9",
        loop_event: { type: "tool_call", tool: "edit", args: "scoring.ts", ok: true, stdout: "wrote 3 lines" },
      }),
    ]), { width: 100, height: 30 });
    const lines = devtoolsScreen.render({ projection, width: 100, height: 30 });
    const body = lines.join("\n");
    expect(body).toContain("⚙ edit");
    expect(body).toContain("scoring.ts");
    expect(body).toContain("wrote 3 lines");
  });

  it("degrades unknown loop_event payloads to the metadata line (never blank)", () => {
    const projection = devtoolsScreen.project(stream([
      line({ event_kind: "loop.some_custom", node_id: "n9", loop_event: { type: "thing" } }),
    ]), { width: 100, height: 30 });
    const lines = devtoolsScreen.render({ projection, width: 100, height: 30 });
    const body = lines.join("\n");
    expect(body).toContain("loop.some_custom");
    expect(body.trim().length).toBeGreaterThan(0);
  });
});
