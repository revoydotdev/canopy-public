import { describe, expect, it } from "vitest";
import {
  createFrontierLiveEdgeState,
  reduceFrontierLiveEdge,
} from "../src/frontier-live-edge.js";
import { initialModel } from "../src/model.js";
import { update } from "../src/update.js";

const attach = (count: number) => ({
  session: { session_id: "s1" },
  events: Array.from({ length: count }, (_, index) => ({
    sequence: index + 1,
    kind: "model_text",
    payload: { text: `event ${index + 1}` },
  })),
});

const consoleSurface = (recordIds: readonly string[]) => ({
  captured_at: "2026-08-30T00:00:00Z",
  operator_interviews: {
    records: recordIds.map((id) => ({ id, question: { question: `Resolve ${id}` } })),
  },
  drafts: { items: [{ id: "draft-1", task: "Plan the release", status: "planning" }] },
});

describe("frontier live-edge state", () => {
  it("starts following the live edge with no inspection anchor or unread count", () => {
    expect(createFrontierLiveEdgeState()).toEqual({
      mode: "following",
      anchor_id: null,
      unseen_meaningful_events: 0,
    });
  });

  it("keeps following on arrival without manufacturing an unread count", () => {
    const state = createFrontierLiveEdgeState();
    expect(reduceFrontierLiveEdge(state, { type: "arrival", meaningful: true, terminal: false })).toBe(state);
  });

  it("enters scrollback at the supplied stable event identity", () => {
    const state = reduceFrontierLiveEdge(createFrontierLiveEdgeState(), { type: "inspect", anchor_id: "session-1:event-17" });
    expect(state).toEqual({
      mode: "scrollback",
      anchor_id: "session-1:event-17",
      unseen_meaningful_events: 0,
    });
  });

  it("holds the inspecting anchor while meaningful arrivals accumulate", () => {
    const inspecting = reduceFrontierLiveEdge(createFrontierLiveEdgeState(), { type: "inspect", anchor_id: "event-17" });
    const afterTwo = reduceFrontierLiveEdge(
      reduceFrontierLiveEdge(inspecting, { type: "arrival", meaningful: true, terminal: false }),
      { type: "arrival", meaningful: true, terminal: false },
    );
    expect(afterTwo).toEqual({ mode: "scrollback", anchor_id: "event-17", unseen_meaningful_events: 2 });
  });

  it("does not count routine arrivals while in scrollback", () => {
    const inspecting = reduceFrontierLiveEdge(createFrontierLiveEdgeState(), { type: "inspect", anchor_id: "event-17" });
    expect(reduceFrontierLiveEdge(inspecting, { type: "arrival", meaningful: false, terminal: false })).toBe(inspecting);
  });

  it("treats a terminal arrival as meaningful without a hidden jump", () => {
    const inspecting = reduceFrontierLiveEdge(createFrontierLiveEdgeState(), { type: "inspect", anchor_id: "event-17" });
    expect(reduceFrontierLiveEdge(inspecting, { type: "arrival", meaningful: false, terminal: true })).toEqual({
      mode: "scrollback",
      anchor_id: "event-17",
      unseen_meaningful_events: 1,
    });
  });

  it("returns to live only through an explicit transition and clears its badge", () => {
    const inspecting = reduceFrontierLiveEdge(createFrontierLiveEdgeState(), { type: "inspect", anchor_id: "event-17" });
    const unread = reduceFrontierLiveEdge(inspecting, { type: "arrival", meaningful: true, terminal: false });
    expect(reduceFrontierLiveEdge(unread, { type: "return_to_live" })).toEqual(createFrontierLiveEdgeState());
  });

  it("saturates unread count instead of retaining unbounded event arrivals", () => {
    const inspecting = reduceFrontierLiveEdge(createFrontierLiveEdgeState(), { type: "inspect", anchor_id: "event-17" }, { max_unseen_meaningful_events: 2 });
    const saturated = [1, 2, 3].reduce(
      (state) => reduceFrontierLiveEdge(state, { type: "arrival", meaningful: true, terminal: false }, { max_unseen_meaningful_events: 2 }),
      inspecting,
    );
    expect(saturated).toEqual({ mode: "scrollback", anchor_id: "event-17", unseen_meaningful_events: 2 });
  });

  it("rejects empty or oversize anchors instead of changing their identity", () => {
    const state = createFrontierLiveEdgeState();
    expect(reduceFrontierLiveEdge(state, { type: "inspect", anchor_id: "" })).toBe(state);
    expect(reduceFrontierLiveEdge(state, { type: "inspect", anchor_id: "abcdef" }, { max_anchor_id_length: 5 })).toBe(state);
  });

  it("preserves scrollback mode, stable anchor, and unread count across resize", () => {
    const inspecting = reduceFrontierLiveEdge(createFrontierLiveEdgeState(), { type: "inspect", anchor_id: "event-17" });
    const unread = reduceFrontierLiveEdge(inspecting, { type: "arrival", meaningful: true, terminal: false });
    expect(reduceFrontierLiveEdge(unread, { type: "resize", columns: 60, rows: 20 })).toBe(unread);
  });

  it("normalizes impossible externally restored state back to a bounded following state", () => {
    const malformed = { mode: "scrollback" as const, anchor_id: null, unseen_meaningful_events: Number.MAX_SAFE_INTEGER };
    expect(reduceFrontierLiveEdge(malformed, { type: "resize", columns: 120, rows: 40 })).toEqual(createFrontierLiveEdgeState());
  });
});

describe("frontier live-edge app integration", () => {
  it("enters stable-ID scrollback and holds that event when canonical arrivals append", () => {
    const loaded = update(initialModel(), { type: "query_results", queryId: "q1", screen: "live-session", value: attach(8) }).model;
    const focused = { ...loaded, screen: "live-session" as const };
    const inspecting = update(focused, { type: "ui_intent", intent: { type: "page_up", amount: 3 }, at: 1 }).model;
    expect(inspecting.frontierLiveEdges.get("live-session")).toEqual({
      mode: "scrollback",
      anchor_id: "canonical:s1:6",
      unseen_meaningful_events: 0,
    });
    expect(inspecting.scrollOffsets.get("live-session")).toBe(5);

    const arrived = update(inspecting, { type: "query_results", queryId: "q2", screen: "live-session", value: attach(10) }).model;
    expect(arrived.frontierLiveEdges.get("live-session")).toEqual({
      mode: "scrollback",
      anchor_id: "canonical:s1:6",
      unseen_meaningful_events: 2,
    });
    expect(arrived.scrollOffsets.get("live-session")).toBe(5);
  });

  it("returns to following only on an explicit End transition", () => {
    const loaded = update(initialModel(), { type: "query_results", queryId: "q1", screen: "live-session", value: attach(8) }).model;
    const inspecting = update({ ...loaded, screen: "live-session" }, { type: "ui_intent", intent: { type: "page_up", amount: 2 }, at: 1 }).model;
    const returned = update(inspecting, { type: "ui_intent", intent: { type: "scroll_end" }, at: 2 }).model;
    expect(returned.frontierLiveEdges.has("live-session")).toBe(false);
    expect(returned.scrollOffsets.has("live-session")).toBe(false);
  });

  it("uses the visible Console durable document for scroll anchors and unseen arrivals", () => {
    const loaded = update(initialModel(), { type: "query_results", queryId: "q1", screen: "console", value: consoleSurface(["input-1"]) }).model;
    const inspecting = update({ ...loaded, screen: "console" }, { type: "ui_intent", intent: { type: "page_up", amount: 3 }, at: 1 }).model;
    expect(inspecting.frontierLiveEdges.get("console")).toEqual({
      mode: "scrollback", anchor_id: "userinput:input-1:question:0", unseen_meaningful_events: 0,
    });

    const arrived = update(inspecting, { type: "query_results", queryId: "q2", screen: "console", value: consoleSurface(["input-1", "input-2"]) }).model;
    expect(arrived.frontierLiveEdges.get("console")).toEqual({
      mode: "scrollback", anchor_id: "userinput:input-1:question:0", unseen_meaningful_events: 1,
    });
  });
});
