import { describe, expect, it } from "vitest";
import { harnessSessionsScreen } from "../src/screens/harness-sessions.js";

const context = { width: 96, height: 14, scroll_offset: 0 };

function fieldValue(rows: readonly Readonly<Record<string, unknown>>[], field: string): string {
  return String(rows.find((row) => row.field === field)?.value);
}

describe("harness session degraded and continuation contracts", () => {
  it("rejects near-miss payloads instead of guessing a session projection", () => {
    for (const value of [
      [],
      { sessions: null },
      { sessions: [], next_cursor: 4 },
      { session_id: 4, state: "running", latest_sequence: 1 },
      { session_id: "s", state: 4, latest_sequence: 1 },
      { session_id: "s", state: "running" },
      { session_id: "s", events: null },
      { session: { session_id: "s" }, events: [], live: "yes", pending_steering: 0, next_after_sequence: 1 },
      { availability: "unavailable", reason: 4 },
    ]) {
      expect(harnessSessionsScreen.project(value, context).variant).toBe("empty");
    }
  });

  it("makes missing list identity, terminal, recovery, and paging facts explicit", () => {
    const projection = harnessSessionsScreen.project({
      sessions: [{
        model_identity: [], recovery: {}, terminal: { provenance: {} }, diagnostics: "unknown",
      }],
      next_cursor: "page-2",
    }, context);

    expect(projection.variant).toBe("sessions");
    expect(projection.caption).toContain("next page");
    expect(projection.rows[0]).toEqual({
      id: "?", connector: "?", execution: "?", profile: "?", model: "unreported",
      revision: "unreported", state: "?", recovery: "—", sequence: "?", terminal: "—",
      provenance: "—", diagnostics: "0",
    });
    expect(projection.row_ids).toEqual([null]);

    const terminal = harnessSessionsScreen.project({ sessions: [{ session_id: "done", terminal: { cause: "failed" } }], next_cursor: null }, context);
    expect(terminal.caption).toContain("end of stable list");
    expect(terminal.row_ids).toEqual([{ id: "done", context: { interruptible: "no" } }]);
  });

  it("reports every continuation authority shape and does not invent absent audit evidence", () => {
    const projection = harnessSessionsScreen.project({
      session_id: "session-edge", state: "paused", latest_sequence: 0,
      connector_id: null, execution_kind: null, profile_id: null,
      model_identity: { provider_id: "openrouter", model_id: "flash", revision: " ", configured_revision: " " },
      recovery: { kind: "recovery_required" }, terminal: null,
      tool_audits: [{ outcome: "allowed", effect: "read", action_scope: "unknown" }, null],
      artifacts: [{ artifact_id: "evidence" }, null],
      continuations: {
        resume: true,
        fork: { available: true },
        respawn: { reason: "checkpoint incompatible" },
      },
    }, context);

    expect(fieldValue(projection.rows, "Provider/model")).toBe("openrouter/flash");
    expect(fieldValue(projection.rows, "Model revision")).toBe("unobserved / unpinned");
    expect(fieldValue(projection.rows, "Recovery")).toContain("checkpoint incomplete");
    expect(fieldValue(projection.rows, "Terminal")).toBe("—");
    expect(fieldValue(projection.rows, "Tool audit records")).toBe("1");
    expect(fieldValue(projection.rows, "Latest action scope")).toBe("—");
    expect(fieldValue(projection.rows, "Latest evidence artifact")).toBe("evidence (?)");
    expect(fieldValue(projection.rows, "Resume")).toBe("available");
    expect(fieldValue(projection.rows, "Fork")).toBe("available");
    expect(fieldValue(projection.rows, "Respawn")).toBe("unavailable: checkpoint incompatible");
  });

  it("supports legacy continuation and direct availability fields while defaulting honestly", () => {
    const legacy = harnessSessionsScreen.project({
      session_id: "legacy", state: "stopped", latest_sequence: 9,
      continuation: { resume: { availability: "available" } },
      fork_availability: { reason: "policy denied" },
      respawn_availability: false,
      tool_audits: [], artifacts: [], recovery: {}, terminal: {},
    }, context);

    expect(fieldValue(legacy.rows, "Resume")).toBe("available");
    expect(fieldValue(legacy.rows, "Fork")).toBe("unavailable: policy denied");
    expect(fieldValue(legacy.rows, "Respawn")).toBe("unavailable: not advertised");
    expect(fieldValue(legacy.rows, "Recovery")).toBe("not required");
    expect(fieldValue(legacy.rows, "Terminal")).toBe("?");
    expect(fieldValue(legacy.rows, "Latest tool outcome")).toBe("—");
    expect(fieldValue(legacy.rows, "Latest evidence artifact")).toBe("—");
  });

  it("renders redacted event defaults and every attach liveness state", () => {
    const events = harnessSessionsScreen.project({ session_id: "events", events: [{}] }, context);
    expect(events.rows[0]).toEqual({ sequence: "?", kind: "?", at: "?", payload: "{\"redacted\":true}" });

    const detached = harnessSessionsScreen.project({
      session: { session_id: "detached" }, events: [{}], live: false, pending_steering: 0, next_after_sequence: 0,
    }, context);
    expect(detached.caption).toContain("not live");

    const terminal = harnessSessionsScreen.project({
      session: { session_id: "terminal", terminal: {} }, events: [], live: false, pending_steering: 0, next_after_sequence: 2,
    }, context);
    expect(terminal.caption).toContain("terminal (recorded)");
    const rendered = harnessSessionsScreen.render({ projection: terminal, ...context });
    expect(rendered[0]).toContain("terminal (recorded)");
    expect(rendered[0]?.length).toBeLessThanOrEqual(context.width);
  });
});
