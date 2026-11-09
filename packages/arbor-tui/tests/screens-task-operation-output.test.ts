import { describe, it, expect, afterEach } from "vitest";
import { tasksScreen } from "../src/screens/tasks.js";
import { operationsScreen } from "../src/screens/operations.js";
import { outputScreen } from "../src/screens/output.js";
import { registerScreen, clearRegisteredScreens, getScreen, availableScreens } from "../src/screens/screen.js";
import { displayWidth } from "../src/widgets.js";

afterEach(() => clearRegisteredScreens());

function render(screen: typeof tasksScreen, result: unknown, width = 80, height = 20): readonly string[] {
  const projection = screen.project(result, { width, height });
  return screen.render({ projection, width, height });
}

describe("tasks screen", () => {
  it("is registered and exposes expected capability/surface", () => {
    registerScreen(tasksScreen);
    const mod = getScreen("tasks");
    expect(mod.title).toBe("Tasks");
    expect(mod.required_capabilities).toEqual(["task.read"]);
    expect(mod.surface.commands).toContain("task.retry");
    expect(mod.surface.queries).toContain("task.list");
  });

  it("projects a task list into typed rows using the real SupervisorTask field name (.state, not .status)", () => {
    const projection = tasksScreen.project([{ id: "t1", kind: "recovery.retry", state: "started", progress: 0.42, owner_scope_id: "c1" }], { width: 80, height: 10 });
    expect(projection.rows[0]).toMatchObject({ id: "t1", kind: "recovery.retry", state: "▶ started", progress: "42%", owner: "c1" });
    expect(projection.columns.some((c) => c.key === "progress")).toBe(true);
    expect(projection.columns.some((c) => c.key === "state")).toBe(true);
    expect(projection.columns.some((c) => c.key === "status")).toBe(false);
    expect(projection.caption).toContain("1");
  });

  it("EC-053: an interrupted task (durable started, no live worker) is labelled so, not as running", () => {
    const projection = tasksScreen.project([{ id: "t1", kind: "worker", state: "started", interrupted: true, progress: 0.4, owner_scope_id: "c1" }], { width: 80, height: 10 });
    expect(projection.rows[0]).toMatchObject({ id: "t1", state: "‖ interrupted (was started)" });
  });

  // G-31 regression: the real task.list result is a cursor page
  // (`{items, next_cursor, total, limit}`), never a raw array — this is the
  // exact shape runtime-catalog.ts's "task.list" case returns.
  it("G-31: projects the real task.list cursor-page shape ({items, next_cursor, total, limit})", () => {
    const page = {
      items: [
        { id: "t1", operation_id: "op1", kind: "recovery.retry", owner_scope_id: "c1", parent_id: null, state: "retrying", started_at: null, deadline_at: null, progress: 10, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 1, cleanup: null },
      ],
      next_cursor: null,
      total: 1,
      limit: 50,
    };
    const projection = tasksScreen.project(page, { width: 80, height: 10 });
    expect(projection.rows[0]).toMatchObject({ id: "t1", kind: "recovery.retry", state: "↻ retrying", owner: "c1" });
    expect(projection.caption).toContain("1");
  });

  // Every closed SupervisorTaskState value maps to a distinct, non-"?" icon.
  it("recognizes every real SupervisorTaskState value", () => {
    const states = ["accepted", "started", "retrying", "cancel_requested", "cancelled", "failed", "completed", "timed_out"];
    const rows = states.map((state, i) => ({ id: `t${i}`, kind: "k", state, owner_scope_id: "c" }));
    const projection = tasksScreen.project(rows, { width: 100, height: 20 });
    for (const [i, state] of states.entries()) {
      // T6 (cosmetic sweep): the visible label is humanized ("cancel
      // requested", not "cancel_requested") while the icon selection still
      // switches on the untouched raw enum value.
      expect(projection.rows[i].state).toContain(state.replaceAll("_", " "));
      expect(projection.rows[i].state).not.toMatch(/^\? /);
    }
  });

  it("renders deterministically and bound-by-height", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, kind: "task", state: "accepted", progress: 0 }));
    const out = render(tasksScreen, rows, 100, 10);
    expect(out.length).toBeLessThanOrEqual(11);
    const out2 = render(tasksScreen, rows, 100, 10);
    expect(out).toEqual(out2);
  });

  it("carries row_ids keyed by task id — the value task.retry needs", () => {
    const projection = tasksScreen.project([{ id: "t1", kind: "recovery.retry", state: "started", owner_scope_id: "c1", progress: 0.4 }], { width: 80, height: 10 });
    expect(projection.row_ids).toEqual([{ id: "t1" }]);
    expect(projection.rows[0]?.progress).toBe("40%");
  });

  it("rejects the speculative task-tree shape that no runtime query produces", () => {
    const tree = { nodes: [{ id: "a", label: "Root", depth: 0, status: "running", has_children: true }, { id: "b", label: "Child", depth: 1, status: "completed", has_children: false }] };
    const projection = tasksScreen.project(tree, { width: 80, height: 10 });
    expect(projection.variant).toBe("empty");
    expect(projection.caption).toContain("unrecognised");
    expect(projection.columns.some((c) => c.key === "depth")).toBe(false);
  });

  it("degrades gracefully on null/unknown/empty", () => {
    expect(() => render(tasksScreen, null)).not.toThrow();
    expect(() => render(tasksScreen, { weird: true })).not.toThrow();
    expect(() => render(tasksScreen, [])).not.toThrow();
    expect(render(tasksScreen, null)[0]).toContain("No supervised tasks");
  });

  it("is absent when task.read capability is not granted", () => {
    registerScreen(tasksScreen);
    expect(availableScreens(new Set([])).some((s) => s.id === "tasks")).toBe(false);
    expect(availableScreens(new Set(["task.read"])).some((s) => s.id === "tasks")).toBe(true);
  });
});

describe("operations screen", () => {
  it("exposes only its own cancel control with declared capabilities", () => {
    registerScreen(operationsScreen);
    const mod = getScreen("operations");
    expect(mod.required_capabilities).toEqual(["operation.read", "operation.cancel"]);
    expect(mod.surface.commands).toEqual(["operation.cancel"]);
    expect(mod.surface.queries).toEqual(["operation.list", "operation.get"]);
  });

  // G-32 closure: operation.list backs this screen now (runtime-catalog.ts +
  // OperationRegistry.list). Projects the REAL OperationRecord shape — it has
  // no `kind` field, and runtime-catalog.ts's handler adds none, so the
  // screen carries no Kind column at all (removed, not fabricated);
  // `recoverable` is genuinely derived from the real nested
  // `error.recoverable` (RuntimeError's own field), not a flat mock.
  it("projects the real OperationRecord shape from operation.list (no fabricated kind, no Kind column)", () => {
    const records = [
      { operation_id: "op-1", idempotency_key: "k1", fingerprint: "f1", correlation_id: "c1", actor_id: "a1", capability: "tree.write", state: "completed", task_id: null, result_summary: "ok", error: null, accepted_at: "2026-08-01T00:00:00.000Z", completed_at: "2026-08-01T00:00:01.000Z" },
      { operation_id: "op-2", idempotency_key: "k2", fingerprint: "f2", correlation_id: "c2", actor_id: "a2", capability: "campaign.write", state: "failed", task_id: null, result_summary: "boom", error: { code: "conflict", severity: "error", recoverable: false, source: "runtime_catalog_router", summary: "boom" }, accepted_at: "2026-08-01T00:00:00.000Z", completed_at: "2026-08-01T00:00:02.000Z" },
    ];
    const projection = operationsScreen.project(records, { width: 80, height: 10 });
    expect(projection.rows[0]).toMatchObject({ id: "op-1", state: "completed", capability: "tree.write", recoverable: "—" });
    expect(projection.rows[1]).toMatchObject({ id: "op-2", state: "failed", capability: "campaign.write", recoverable: "no" });
    expect(projection.columns.some((c) => c.key === "kind")).toBe(false);
  });

  // The healthy steady state (no active operations) is a real, common empty
  // array, not an unavailable or diagnostic state.
  it("captions a genuinely empty operation.list as 'no operations', never 'no errors'", () => {
    const lines = render(operationsScreen, []);
    const joined = lines.join("\n");
    expect(joined).toContain("operations");
    expect(joined).not.toContain("errors");
  });

  it("projects operation rows", () => {
    const projection = operationsScreen.project([{ operation_id: "op1", state: "running", capability: "campaign.write", recoverable: true }], { width: 80, height: 10 });
    expect(projection.rows[0]).toMatchObject({ id: "op1", state: "running" });
    expect(projection.caption).toContain("1");
  });

  it("rejects event/error rows owned by Diagnostics and Recovery", () => {
    const projection = operationsScreen.project([{ code: "conflict", summary: "stale version", operation_id: "op9", recoverable: true }], { width: 80, height: 10 });
    expect(projection.variant).toBe("empty");
    expect(projection.caption).toContain("unrecognised");
    expect(projection.rows).toEqual([]);
  });

  it("renders deterministically and clips by width", () => {
    const out = render(operationsScreen, [{ operation_id: "op-signal-very-long-name", kind: "x", state: "running" }], 30, 5);
    for (const line of out) expect(displayWidth(line)).toBeLessThanOrEqual(31);
    const out2 = render(operationsScreen, [{ operation_id: "op-signal-very-long-name", kind: "x", state: "running" }], 30, 5);
    expect(out).toEqual(out2);
  });

  it("degrades gracefully on null/unknown", () => {
    expect(() => render(operationsScreen, null)).not.toThrow();
    expect(() => render(operationsScreen, { bad: 1 })).not.toThrow();
    expect(render(operationsScreen, null)[0]).toContain("No active operations");
  });

  it("does not claim recovery controls owned by the dedicated recovery screen", () => {
    // surface commands must be within the catalog-supported set only
    for (const command of operationsScreen.surface.commands) {
      expect(["operation.cancel"]).toContain(command);
    }
    registerScreen(operationsScreen);
    expect(availableScreens(new Set(["operation.read"])).some((s) => s.id === "operations")).toBe(false);
    expect(availableScreens(new Set(["operation.read", "operation.cancel"])).some((s) => s.id === "operations")).toBe(true);
  });

  it("carries row_ids keyed by operation_id on canonical operation rows", () => {
    const list = operationsScreen.project([{ operation_id: "op1", state: "running", capability: "campaign.write" }], { width: 80, height: 10 });
    expect(list.row_ids).toEqual([{ id: "op1" }]);
  });

  // `operation.get`'s real return value is one raw OperationRecord, never an
  // array — previously declared in this screen's surface.queries with no
  // variant able to render it (would silently fall through to "no data").
  it("renders operation.get's real single-record shape via a dedicated detail variant", () => {
    const record = {
      operation_id: "op-42",
      state: "completed",
      capability: "tree.write",
      task_id: "t-9",
      result_summary: "branched 3 nodes",
      error: null,
    };
    const projection = operationsScreen.project(record, { width: 100, height: 10 });
    expect(projection.variant).toBe("detail");
    expect(projection.rows).toHaveLength(1);
    expect(projection.rows[0]).toMatchObject({ id: "op-42", state: "completed", capability: "tree.write", task: "t-9", result: "branched 3 nodes" });
    expect(projection.row_ids).toEqual([{ id: "op-42" }]);
    expect(projection.caption).toContain("op-42");
    const lines = render(operationsScreen, record);
    expect(lines.join("\n")).toContain("op-42");
  });

  it("declares canonical list/detail queries and leaves event.resume to Diagnostics", () => {
    expect(operationsScreen.surface.queries).toEqual(["operation.list", "operation.get"]);
  });
});

describe("output screen", () => {
  it("exposes output.capture control with declared capabilities", () => {
    registerScreen(outputScreen);
    const mod = getScreen("output");
    expect(mod.required_capabilities).toEqual(["output.read", "output.capture"]);
    expect(mod.surface.commands).toContain("output.capture");
    expect(mod.surface.queries).toContain("output.descriptor");
  });

  it("never renders raw oversized output — bounded preview + evidence pointer only", () => {
    const huge = "x".repeat(50_000);
    const out = render(outputScreen, { evidence_id: "ev-123", content: huge }, 80, 10);
    const joined = out.join("\n");
    expect(joined.includes("x".repeat(2001))).toBe(false);
    expect(joined).toContain("ev-123");
    expect(joined).toContain("preview");
  });

  it("projects capture rows", () => {
    const projection = outputScreen.project([{ operation_id: "op1", kind: "tool.call", status: "streaming", bytes: 1024, evidence_id: "ev-1" }], { width: 80, height: 10 });
    expect(projection.rows[0]).toMatchObject({ operation: "op1", kind: "tool.call", status: "streaming", bytes: "1024" });
    expect(projection.rows[0]).toMatchObject({ source: "canonical/output-evidence" });
    expect(projection.caption).toContain("1");
  });

  it("renders deterministically and bound-by-height", () => {
    const out = render(outputScreen, [{ operation_id: "o", kind: "k", bytes: 1, evidence_id: "e" }], 80, 8);
    const out2 = render(outputScreen, [{ operation_id: "o", kind: "k", bytes: 1, evidence_id: "e" }], 80, 8);
    expect(out).toEqual(out2);
  });

  it("degrades gracefully on null/unknown/empty", () => {
    expect(() => render(outputScreen, null)).not.toThrow();
    expect(() => render(outputScreen, { odd: true })).not.toThrow();
    expect(() => render(outputScreen, [])).not.toThrow();
  });

  // Same bug class already found and fixed in operations.ts's
  // isOperationListShape: `isCaptureListShape` previously required
  // `result.length > 0`, so a genuinely empty capture list (a real, healthy
  // "nothing captured yet" result) fell through to emptyProjection's
  // "No data" — indistinguishable from a query that never ran, or a broken
  // store. An empty array must caption "no outputs", never "No data".
  it("captions a genuinely empty capture list as 'no outputs', never 'No data'", () => {
    const lines = render(outputScreen, []);
    const joined = lines.join("\n");
    expect(joined).toContain("outputs");
    expect(joined).not.toContain("No data");
  });

  it("is absent without its capabilities", () => {
    registerScreen(outputScreen);
    expect(availableScreens(new Set(["output.read"])).some((s) => s.id === "output")).toBe(false);
    expect(availableScreens(new Set(["output.read", "output.capture"])).some((s) => s.id === "output")).toBe(true);
  });

  it("carries row_ids keyed by evidence_id on captures, and on the descriptor's own row", () => {
    const captures = outputScreen.project([{ operation_id: "op1", kind: "tool.call", status: "streaming", bytes: 1024, evidence_id: "ev-1" }], { width: 80, height: 10 });
    expect(captures.row_ids).toEqual([{ id: "ev-1" }]);
    const descriptor = outputScreen.project({ evidence_id: "ev-2", content: "hi" }, { width: 80, height: 10 });
    expect(descriptor.row_ids).toEqual([{ id: "ev-2" }]);
  });

  it("row_ids resolves a corrupt capture entry's own id, and is null when even that is absent", () => {
    const withId = outputScreen.project([{ status: "corrupt", id: "bad-1", error: "checksum mismatch" }], { width: 80, height: 10 });
    expect(withId.row_ids).toEqual([{ id: "bad-1" }]);
    const withoutId = outputScreen.project([{ status: "corrupt", error: "checksum mismatch" }], { width: 80, height: 10 });
    expect(withoutId.row_ids).toEqual([null]);
  });

  // ADR-104 Decision 3 / O4: a running capture gets a separate, explicitly
  // time-bounded in-progress preview branch on the same descriptor shape —
  // never a widening of the completed-output MAX_PREVIEW_CHARS ceiling.
  describe("in-progress live preview (ADR-104)", () => {
    it("stays bounded at MAX_PREVIEW_CHARS for an unfinished stream far past the cap", () => {
      const huge = "x".repeat(50_000);
      const projection = outputScreen.project({ evidence_id: "ev-live", preview: { content: huge, in_progress: true } }, { width: 80, height: 10 });
      expect(projection.rows[0]).toMatchObject({ evidence_id: "ev-live", in_progress: "yes", truncated: "yes" });
      expect(String(projection.rows[0]!.content).length).toBeLessThanOrEqual(2_000);
    });

    it("renders the TAIL of an unfinished stream, not the head — the most recent output is what a live operator needs", () => {
      const content = `${"a".repeat(3_000)}TAIL-MARKER`;
      const projection = outputScreen.project({ evidence_id: "ev-live", preview: { content, in_progress: true } }, { width: 80, height: 10 });
      expect(String(projection.rows[0]!.content)).toContain("TAIL-MARKER");
      expect(String(projection.rows[0]!.content)).not.toContain("a".repeat(2_000));
    });

    it("keeps the completed-capture branch on its existing HEAD slice, unaffected by the new in-progress branch", () => {
      const content = `HEAD-MARKER${"a".repeat(3_000)}`;
      const projection = outputScreen.project({ evidence_id: "ev-done", preview: { content } }, { width: 80, height: 10 });
      expect(String(projection.rows[0]!.content)).toContain("HEAD-MARKER");
      expect(projection.rows[0]).toMatchObject({ in_progress: "no" });
    });

    it("labels the caption 'live' only while in progress", () => {
      const live = outputScreen.project({ evidence_id: "ev-live", preview: { content: "partial", in_progress: true } }, { width: 80, height: 10 });
      expect(live.caption).toContain("(live)");
      const done = outputScreen.project({ evidence_id: "ev-done", preview: { content: "final" } }, { width: 80, height: 10 });
      expect(done.caption).not.toContain("(live)");
    });
  });
});
