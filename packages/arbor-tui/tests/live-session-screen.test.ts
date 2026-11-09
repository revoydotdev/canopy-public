/**
 * ADR-107 obligation O4: the live-session screen reads
 * `LiveNativeSessionRegistry.list()`/`attach()` projections and dispatches
 * `harness.session.steer`/`harness.session.interrupt` only through the
 * RuntimePort dispatch discipline `update.ts` already uses for every other
 * screen — never a direct registry/manager/connector import.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { liveSessionScreen } from "../src/screens/live-session.js";
import { initialModel } from "../src/model.js";
import { update } from "../src/update.js";
import type { AppModel } from "../src/types.js";

const context = { width: 100, height: 12, scroll_offset: 0 };
const attachedEvents = (projection: ReturnType<typeof liveSessionScreen.project>) => projection.rows.map((row) => row.event as Record<string, unknown>);

describe("live-session screen", () => {
  it("never imports the registry, campaign manager, or a connector directly", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/screens/live-session.ts", import.meta.url)), "utf8");
    const importLines = source.split("\n").filter((line) => line.trim().startsWith("import"));
    expect(importLines.some((line) => /live-native-session-registry|manager\.js|connector/i.test(line))).toBe(false);
  });

  it("projects only live (attachable, non-terminal) sessions from a list result, dropping terminal ones", () => {
    const projection = liveSessionScreen.project({
      sessions: [
        { session_id: "live-1", connector_id: "revoy-native", state: "running", latest_sequence: 3, pending_steering: 1, attachable: true, terminal: null },
        { session_id: "gone-1", connector_id: "revoy-native", state: "interrupted", latest_sequence: 9, pending_steering: 0, attachable: false, terminal: { cause: "interrupted" } },
      ],
    }, context);
    expect(projection.variant).toBe("sessions");
    expect(projection.rows).toHaveLength(1);
    expect(projection.rows[0]).toMatchObject({ id: "live-1", state: "running", pending: "1" });
    expect(liveSessionScreen.render({ projection, ...context }).join("\n")).toContain("revoy-native");
  });

  it("renders an attached session through the canonical grammar, not raw event JSON", () => {
    const projection = liveSessionScreen.project({
      session: { session_id: "live-1", terminal: null },
      live: true,
      pending_steering: 0,
      next_after_sequence: 2,
      events: [
        { sequence: 1, kind: "model_text", occurred_at: "t1", payload: { text: "add a health check" } },
        { sequence: 2, kind: "tool_intent", occurred_at: "t2", payload: { tool: "shell", input_summary: "rg health" } },
      ],
    }, context);
    expect(projection.variant).toBe("attach");
    expect(projection.caption).toContain("live-1");
    expect(attachedEvents(projection)).toMatchObject([
      { source: "canonical_session", source_id: "live-1", kind: "agent_narrative", lifecycle: "observed", summary: "add a health check" },
      { source: "canonical_session", source_id: "live-1", kind: "tool", lifecycle: "active", summary: "tool: shell" },
    ]);
    expect(projection.row_ids).toEqual([
      { id: "live-1", context: { attached_event_id: "canonical:live-1:1" } },
      { id: "live-1", context: { attached_event_id: "canonical:live-1:2" } },
    ]);
    const rendered = liveSessionScreen.render({ projection, ...context }).join("\n");
    expect(rendered).toContain("canonical/canonical_session");
    expect(rendered).not.toContain('"text"');
  });

  it("wraps attached-session status and controls so narrow terminals retain the full next action", () => {
    const projection = liveSessionScreen.project({
      session: { session_id: "session-12345678-1234-1234-1234-123456789abc", terminal: null },
      live: true,
      pending_steering: 2,
      next_after_sequence: 0,
      events: [],
    }, context);
    const rendered = liveSessionScreen.render({ projection, width: 60, height: 12 }).join("\n");
    // At 60 columns the status is word-wrapped, so a phrase may straddle a line
    // boundary — wrapping is exactly what this test asserts happens. Collapse
    // whitespace to assert the full next action is retained regardless of where
    // the break lands; the width bound below is checked on the raw lines.
    const unwrapped = rendered.replace(/\s+/gu, " ");
    expect(unwrapped).toContain("2 steering message(s) pending");
    expect(unwrapped).toContain("steer and interrupt remain governed");
    expect(rendered.split("\n").every((line) => [...line].length <= 60)).toBe(true);
  });

  it("makes scrollback and the explicit return-to-live affordance visible", () => {
    const projection = liveSessionScreen.project({
      session: { session_id: "live-1", terminal: null },
      live: true,
      events: [{ sequence: 1, kind: "model_text", payload: { text: "one" } }],
    }, context);
    const rendered = liveSessionScreen.render({
      projection,
      ...context,
      live_edge: { mode: "scrollback", anchor_id: "canonical:live-1:1", unseen_meaningful_events: 3 },
    }).join("\n");
    expect(rendered).toContain("HISTORY · 3 new · End return to live");
  });

  it("reports a typed unavailable projection when no live session source exists", () => {
    const projection = liveSessionScreen.project({ availability: "unavailable", reason: "no durable or live harness session source is available" }, context);
    expect(projection.variant).toBe("unavailable");
    expect(projection.caption).toContain("unavailable");
    expect(liveSessionScreen.render({ projection, ...context }).join("\n")).toContain("reopen Live Session to refresh");
  });
});

describe("live-session screen — RuntimePort dispatch discipline (update.ts)", () => {
  function attachedModel(): AppModel {
    return {
      ...initialModel(), screen: "live-session",
      selection: new Map([["live-session", { id: "session-1", context: { interruptible: "yes" } }]]),
      screens: new Map([["live-session", { session: { session_id: "session-1", terminal: null }, live: true, pending_steering: 0, next_after_sequence: 0, events: [] }]]),
    };
  }

  it("attach_selected_harness_session issues harness.session.attach scoped to the live-session screen's selection", () => {
    const result = update(attachedModel(), { type: "ui_intent", intent: { type: "attach_selected_harness_session" }, at: 10 });
    expect(result.effects).toEqual([{ type: "run_query", request: { kind: "harness.session.attach", query_id: "tui:attach:live-session:10", params: { session_id: "session-1", limit: 200 } } }]);
  });

  it("composes and dispatches harness.session.steer as a real RuntimeCommandRequest, only once the attach projection confirms the session is live", () => {
    const opened = update(attachedModel(), { type: "ui_intent", intent: { type: "open_operator_form", command: "harness.session.steer" }, at: 11 }).model;
    expect(opened.overlay?.kind).toBe("operator_form");
    const onMessageField = update(opened, { type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at: 12 }).model;
    const typed = update(onMessageField, { type: "ui_intent", intent: { type: "operator_form_input", value: "run the tests again" }, at: 12 }).model;
    const submitted = update(typed, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 13 });
    expect(submitted.effects).toEqual([{
      type: "dispatch_command",
      request: { kind: "harness.session.steer", metadata: { operation_id: "tui:harness.session.steer:13", idempotency_key: "tui:harness.session.steer:13" }, params: { session_id: "session-1", message: "run the tests again", provenance: { tag: "claimed", claimant: "tui-operator" } } },
    }]);
  });

  it("refuses to open the steer composer once the selected row is no longer confirmed live", () => {
    const notLive: AppModel = {
      ...initialModel(), screen: "live-session",
      selection: new Map([["live-session", { id: "session-1" }]]),
      screens: new Map([["live-session", { sessions: [] }]]), // list variant, not an attach projection
    };
    const opened = update(notLive, { type: "ui_intent", intent: { type: "open_operator_form", command: "harness.session.steer" }, at: 20 });
    expect(opened.model.overlay).toBeNull();
  });

  it("cancel_selected_row arms, then confirm_pending_action dispatches, harness.session.interrupt for a selected live-session row", () => {
    const armed = update(attachedModel(), { type: "ui_intent", intent: { type: "cancel_selected_row" }, at: 30 });
    expect(armed.effects.some((effect) => effect.type === "dispatch_command")).toBe(false); // first press only arms confirmation
    const confirmed = update(armed.model, { type: "ui_intent", intent: { type: "cancel_selected_row" }, at: 31 });
    expect(confirmed.effects).toEqual([{
      type: "dispatch_command",
      request: { kind: "harness.session.interrupt", metadata: { operation_id: "tui:harness.session.interrupt:31", idempotency_key: "tui:harness.session.interrupt:31" }, params: { session_id: "session-1", reason: "operator-requested interruption from TUI" } },
    }]);
  });
});

describe("live-session projection branches", () => {
  const listValue = (sessions: readonly Record<string, unknown>[]) => ({ sessions });

  it("filters out sessions that are not attachable or already terminal", () => {
    const p = liveSessionScreen.project(listValue([
      { session_id: "live-1", attachable: true, terminal: null, connector_id: "native", state: "running", pending_steering: 2, latest_sequence: 7 },
      { session_id: "done-1", attachable: true, terminal: { cause: "completed" } },
      { session_id: "detached-1", attachable: false, terminal: null },
    ]), context);
    expect(p.rows.map((r) => r.id)).toEqual(["live-1"]);
    expect(p.caption).toContain("Live sessions (1)");
  });

  it("captions the empty case with the command that creates one", () => {
    const p = liveSessionScreen.project(listValue([{ session_id: "x", attachable: false }]), context);
    expect(p.rows).toEqual([]);
    expect(p.caption).toContain("arbor session start");
  });

  it("substitutes a placeholder for every absent or wrong-typed field rather than throwing", () => {
    const p = liveSessionScreen.project(listValue([{ session_id: "bare", attachable: true }]), context);
    expect(p.rows[0]).toMatchObject({ id: "bare", connector: "?", state: "?", pending: "0", sequence: "?" });
  });

  it("refuses to make an unidentifiable row selectable", () => {
    const p = liveSessionScreen.project(listValue([{ attachable: true, terminal: null }]), context);
    expect(p.row_ids).toEqual([null]);
  });

  it("covers S06 parentage and source-labelled nested agent/tool/result rows", () => {
    const attach = {
      session: { session_id: "s1", terminal: null }, live: true, pending_steering: 0, next_after_sequence: 4,
      events: [
        { sequence: 1, kind: "model_text", payload: { text: "inspect authentication" }, occurred_at: "t1" },
        { sequence: 2, kind: "tool_intent", payload: { tool: "shell", input_summary: "rg route", parent_id: "task-1" }, occurred_at: "t2" },
        { sequence: 3, kind: "tool_result", payload: { tool: "shell", result_summary: "found route", parent_id: "task-1" }, occurred_at: "t3" },
      ],
    };
    const projected = liveSessionScreen.project(attach, context);
    expect(attachedEvents(projected).map((event) => [event.kind, event.parent_id, event.source_id])).toEqual([
      ["agent_narrative", null, "s1"],
      ["tool", "task-1", "s1"],
      ["tool_result", "task-1", "s1"],
    ]);
    expect(liveSessionScreen.render({ projection: projected, ...context }).join("\n")).toContain("↳ task-1");
  });

  it("reports a terminal session as terminal even when the attach says live", () => {
    const p = liveSessionScreen.project({
      session: { session_id: "s2", terminal: { cause: "interrupted" } }, live: true,
      pending_steering: 3, next_after_sequence: 0, events: [],
    }, context);
    expect(p.caption).toContain("terminal (interrupted)");
    expect(p.caption).toContain("3 steering message(s) pending");
    expect(p.caption).toContain("no active control is implied");
  });

  it("covers S07 by retaining every live session in the supervised list", () => {
    const p = liveSessionScreen.project(listValue([
      { session_id: "s-a", attachable: true, terminal: null, connector_id: "native", state: "running" },
      { session_id: "s-b", attachable: true, terminal: null, connector_id: "native", state: "running" },
    ]), context);
    expect(p.rows.map((row) => row.id)).toEqual(["s-a", "s-b"]);
  });

  it("covers S09/S12 with attention, bounded diagnostics, and truthful terminal interruption", () => {
    const long = "x".repeat(2_000);
    const p = liveSessionScreen.project({
      session: { session_id: "s-fail", terminal: { cause: "interrupted" } }, live: true, pending_steering: 0, next_after_sequence: 4,
      events: [
        { sequence: 1, kind: "tool_result", payload: { tool: "shell", result_summary: long } },
        { sequence: 2, kind: "diagnostic", payload: { code: "command_failed", message: long } },
        { sequence: 3, kind: "interrupt_requested", payload: { reason: "operator asked" } },
        { sequence: 4, kind: "terminal", payload: { state: "interrupted", message: "stopped" } },
      ],
    }, context);
    expect(p.caption).toContain("terminal (interrupted)");
    expect(p.caption).toContain("attention item(s)");
    expect(p.caption).not.toContain("live ·");
    expect(attachedEvents(p).find((event) => event.lifecycle === "interrupted")?.summary).toBe("session interrupted");
    expect(String(attachedEvents(p).find((event) => event.kind === "diagnostic")?.detail).length).toBeLessThanOrEqual(1_000);
  });

  it("renders malformed canonical attach events as bounded diagnostics without a JSON fallback", () => {
    const p = liveSessionScreen.project({
      session: { session_id: "s-bad" }, live: true, pending_steering: 0, next_after_sequence: 0,
      events: [null, { sequence: 2, payload: {} }],
    }, context);
    expect(p.variant).toBe("attach");
    expect(attachedEvents(p).every((event) => event.kind === "diagnostic" && event.source_id === "s-bad")).toBe(true);
    const rendered = liveSessionScreen.render({ projection: p, width: 60, height: 10 }).join("\n");
    expect(attachedEvents(p).map((event) => event.summary)).toContain("session event kind is missing");
    expect(rendered).toContain("diagnostic");
    expect(rendered).not.toContain("{");
  });

  it("renders the caption alone when there are no rows, and a table when there are", () => {
    const empty = liveSessionScreen.project(listValue([]), context);
    expect(liveSessionScreen.render({ projection: empty, ...context })).toHaveLength(1);
    const one = liveSessionScreen.project(listValue([{ session_id: "r1", attachable: true, terminal: null }]), context);
    expect(liveSessionScreen.render({ projection: one, ...context }).length).toBeGreaterThan(1);
  });
});
