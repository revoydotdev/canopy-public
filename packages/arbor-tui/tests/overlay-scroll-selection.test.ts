/**
 * Wave2/tui-input-model: the `Overlay` union retrofit, generalized per-screen
 * `selection`, and per-screen `scrollOffsets`.
 *
 * Imports straight from the source modules (not `../src/index.js`) so this
 * file exercises real, independent logic regardless of the barrel's current
 * state — `index.ts` is a sibling lane's file and, at the time this suite
 * was written, does not yet re-export the generalized `ScreenSelection`
 * type in place of the removed `TreeSelection`/`Modal`.
 */
import { describe, expect, it } from "vitest";
import { initialModel } from "../src/model.js";
import { update } from "../src/update.js";
import type { AppEvent, AppModel } from "../src/types.js";

function dispatch(model: AppModel, event: AppEvent): AppModel {
  return update(model, event).model;
}

describe("Overlay union (compose)", () => {
  const withInterview: AppModel = {
    ...initialModel(),
    screen: "interviews",
    screens: new Map([["interviews", { records: [{ id: "userinput_1", question: { question: "Proceed?" } }] }]]),
  };

  it("arm_answer opens a compose overlay from the latest unanswered interview", () => {
    const armed = dispatch(withInterview, { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 });
    expect(armed.overlay).toEqual({ kind: "compose", record_id: "userinput_1", question: "Proceed?", buffer: "", cursor: 0 });
  });

  it("arm_answer is a no-op when an overlay is already active", () => {
    const armed = dispatch(withInterview, { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 });
    const rearmed = dispatch(armed, { type: "ui_intent", intent: { type: "arm_answer" }, at: 2 });
    expect(rearmed.overlay).toBe(armed.overlay);
  });

  it("compose_input only edits the buffer while a compose overlay is active", () => {
    const armed = dispatch(withInterview, { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 });
    const typed = dispatch(armed, { type: "ui_intent", intent: { type: "compose_input", buffer: "yes" }, at: 2 });
    expect(typed.overlay).toEqual({ kind: "compose", record_id: "userinput_1", question: "Proceed?", buffer: "yes", cursor: 3 });

    const ignored = dispatch(initialModel(), { type: "ui_intent", intent: { type: "compose_input", buffer: "yes" }, at: 1 });
    expect(ignored.overlay).toBeNull();
  });

  it("submit_answer dispatches userinput.answer and clears the overlay", () => {
    const armed = dispatch(withInterview, { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 });
    const typed = dispatch(armed, { type: "ui_intent", intent: { type: "compose_input", buffer: "  yes, proceed  " }, at: 2 });
    const result = update(typed, { type: "ui_intent", intent: { type: "submit_answer" }, at: 3 });
    expect(result.model.overlay).toBeNull();
    expect(result.effects).toEqual([{
      type: "dispatch_command",
      request: {
        kind: "userinput.answer",
        metadata: { operation_id: "tui:userinput.answer:3", idempotency_key: "tui:userinput.answer:3" },
        params: {
          record_id: "userinput_1",
          answer: { option_id: null, custom_text: "yes, proceed", answered_by: "tui-operator", answered_at: new Date(3).toISOString() },
        },
      },
    }]);
  });

  it("cancel_compose clears a compose overlay but no-ops on a confirm overlay", () => {
    const armed = dispatch(withInterview, { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 });
    const cancelled = dispatch(armed, { type: "ui_intent", intent: { type: "cancel_compose" }, at: 2 });
    expect(cancelled.overlay).toBeNull();
  });
});

describe("Trust forms", () => {
  it("opens enrollment and emits the canonical trust-session command", () => {
    const opened = update(initialModel(), { type: "ui_intent", intent: { type: "open_operator_form", command: "trust.enroll" }, at: 1 });
    expect(opened.model.overlay).toMatchObject({ kind: "operator_form", command: "trust.enroll", error: null });
    if (opened.model.overlay?.kind !== "operator_form") throw new Error("trust form did not open");
    const ready: AppModel = { ...opened.model, overlay: { ...opened.model.overlay, fields: { registration_json: '{"session_id":"remote-1"}' } } };
    expect(update(ready, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 2 }).effects).toMatchObject([{ type: "dispatch_command", request: { kind: "trust.session.enroll", params: { registration: { session_id: "remote-1" } } } }]);
  });

  it("opens a selected-session rotation and emits the canonical trust-session command", () => {
    const model: AppModel = { ...initialModel(), screen: "trust" as const, selection: new Map([["trust", { id: "remote-1" }]]) };
    const opened = update(model, { type: "ui_intent", intent: { type: "open_operator_form", command: "trust.rotate" }, at: 1 });
    expect(opened.model.overlay).toMatchObject({ kind: "operator_form", command: "trust.rotate", fields: { session_id: "remote-1" }, error: null });
    if (opened.model.overlay?.kind !== "operator_form") throw new Error("trust form did not open");
    const ready: AppModel = { ...opened.model, overlay: { ...opened.model.overlay, fields: { session_id: "remote-1", key_id: "key-2", public_key_pem: "public-key", certificate_id: "cert-2" } } };
    expect(update(ready, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 2 }).effects).toMatchObject([{ type: "dispatch_command", request: { kind: "trust.session.rotate", params: { session_id: "remote-1", key_id: "key-2", certificate_id: "cert-2" } } }]);
  });
});

describe("Overlay union (confirm) — generalized selection feeds it", () => {
  const tree = { campaign_id: "c1", nodes: [{ id: "n1" }, { id: "n2" }] };
  const withTree: AppModel = { ...initialModel(), screen: "tree", screens: new Map([["tree", tree]]) };

  function selectedTree(model: AppModel): AppModel {
    // query_results is how production populates selection.get("tree") — see
    // update.ts's queryResults/stickyTreeSelection.
    return dispatch(model, { type: "query_results", queryId: "q1", screen: "tree", value: tree });
  }

  it("query_results seeds a sticky per-screen selection entry for tree", () => {
    const seeded = selectedTree(withTree);
    expect(seeded.selection.get("tree")).toEqual({ id: "n1", context: { campaign_id: "c1" } });
  });

  it("select_tree_node steps the generalized selection, wrapping at the ends", () => {
    const seeded = selectedTree(withTree);
    const next = dispatch(seeded, { type: "ui_intent", intent: { type: "select_tree_node", direction: 1 }, at: 1 });
    expect(next.selection.get("tree")).toEqual({ id: "n2", context: { campaign_id: "c1" } });
    const wrapped = dispatch(next, { type: "ui_intent", intent: { type: "select_tree_node", direction: 1 }, at: 2 });
    expect(wrapped.selection.get("tree")).toEqual({ id: "n1", context: { campaign_id: "c1" } });
  });

  it("request_prune_selected_node arms a command-agnostic confirm overlay from the selection", () => {
    const seeded = selectedTree(withTree);
    const armed = dispatch(seeded, { type: "ui_intent", intent: { type: "request_prune_selected_node" }, at: 1 });
    expect(armed.overlay).toEqual({
      kind: "confirm",
      title: "Prune node",
      detail: "Prune n1? This permanently removes the node and its subtree — this cannot be undone.",
      pendingAction: { kind: "tree.prune", params: { campaign_id: "c1", node_id: "n1" } },
    });
  });

  it("confirm_pending_action dispatches the armed command and clears the overlay", () => {
    const seeded = selectedTree(withTree);
    const armed = dispatch(seeded, { type: "ui_intent", intent: { type: "request_prune_selected_node" }, at: 1 });
    const result = update(armed, { type: "ui_intent", intent: { type: "confirm_pending_action" }, at: 2 });
    expect(result.model.overlay).toBeNull();
    expect(result.effects).toEqual([{
      type: "dispatch_command",
      request: { kind: "tree.prune", metadata: { operation_id: "tui:tree.prune:2", idempotency_key: "tui:tree.prune:2" }, params: { campaign_id: "c1", node_id: "n1" } },
    }]);
  });

  it("cancel_pending_action clears a confirm overlay but no-ops on a compose overlay", () => {
    const seeded = selectedTree(withTree);
    const armed = dispatch(seeded, { type: "ui_intent", intent: { type: "request_prune_selected_node" }, at: 1 });
    const cancelled = dispatch(armed, { type: "ui_intent", intent: { type: "cancel_pending_action" }, at: 2 });
    expect(cancelled.overlay).toBeNull();

    const compose = dispatch({ ...initialModel(), screen: "interviews", screens: new Map([["interviews", { records: [{ id: "u1", question: {} }] }]]) }, { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 });
    const ignored = dispatch(compose, { type: "ui_intent", intent: { type: "cancel_pending_action" }, at: 2 });
    expect(ignored.overlay).toBe(compose.overlay);
  });

  it("branch_selected_node reads campaign_id out of the selection's context", () => {
    const seeded = selectedTree(withTree);
    const result = update(seeded, { type: "ui_intent", intent: { type: "branch_selected_node" }, at: 1 });
    expect(result.effects).toHaveLength(1);
    const effect = result.effects[0] as { type: string; request: { kind: string; params: Record<string, unknown> } };
    expect(effect.request.kind).toBe("tree.branch");
    expect(effect.request.params.campaign_id).toBe("c1");
    expect(effect.request.params.node_id).toBe("n1");
  });
});

describe("Overlay union (help) — filter query", () => {
  it("toggle_help opens then closes the help overlay", () => {
    const opened = dispatch(initialModel(), { type: "ui_intent", intent: { type: "toggle_help" }, at: 1 });
    expect(opened.overlay).toEqual({ kind: "help", query: "", selected_index: 0, expanded: false });
    const closed = dispatch(opened, { type: "ui_intent", intent: { type: "toggle_help" }, at: 2 });
    expect(closed.overlay).toBeNull();
  });

  it("toggle_help no-ops while a different overlay (compose/confirm) is active", () => {
    const compose = dispatch({ ...initialModel(), screen: "interviews", screens: new Map([["interviews", { records: [{ id: "u1", question: {} }] }]]) }, { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 });
    const attempted = dispatch(compose, { type: "ui_intent", intent: { type: "toggle_help" }, at: 2 });
    expect(attempted.overlay).toBe(compose.overlay);
  });

  it("help_query_input edits the live filter only while help is open", () => {
    const opened = dispatch(initialModel(), { type: "ui_intent", intent: { type: "toggle_help" }, at: 1 });
    const moved = dispatch(opened, { type: "ui_intent", intent: { type: "help_select_index", index: 4 }, at: 2 });
    expect(moved.overlay).toEqual({ kind: "help", query: "", selected_index: 4, expanded: false });
    const filtered = dispatch(moved, { type: "ui_intent", intent: { type: "help_query_input", buffer: "tree" }, at: 3 });
    expect(filtered.overlay).toEqual({ kind: "help", query: "tree", selected_index: 0, expanded: false });

    const ignored = dispatch(initialModel(), { type: "ui_intent", intent: { type: "help_query_input", buffer: "tree" }, at: 1 });
    expect(ignored.overlay).toBeNull();
  });

  it("rejects an invalid help cursor and ignores cursor changes outside help", () => {
    const opened = dispatch(initialModel(), { type: "ui_intent", intent: { type: "toggle_help" }, at: 1 });
    expect(dispatch(opened, { type: "ui_intent", intent: { type: "help_select_index", index: -1 }, at: 2 }).overlay).toEqual(opened.overlay);
    expect(dispatch(initialModel(), { type: "ui_intent", intent: { type: "help_select_index", index: 1 }, at: 2 }).overlay).toBeNull();
  });

  it("toggles explicit full-catalog expansion and resets the visible cursor", () => {
    const opened = dispatch(initialModel(), { type: "ui_intent", intent: { type: "toggle_help" }, at: 1 });
    const moved = dispatch(opened, { type: "ui_intent", intent: { type: "help_select_index", index: 4 }, at: 2 });
    const expanded = dispatch(moved, { type: "ui_intent", intent: { type: "help_toggle_expanded" }, at: 3 });
    expect(expanded.overlay).toEqual({ kind: "help", query: "", selected_index: 0, expanded: true });
    const contextual = dispatch(expanded, { type: "ui_intent", intent: { type: "help_toggle_expanded" }, at: 4 });
    expect(contextual.overlay).toEqual({ kind: "help", query: "", selected_index: 0, expanded: false });
  });
});

describe("Per-screen scroll offsets", () => {
  it("page_down/page_up move the focused screen's offset by the dispatched amount, clamped at zero", () => {
    const base = { ...initialModel(), screen: "jobs" as const };
    const down = dispatch(base, { type: "ui_intent", intent: { type: "page_down", amount: 10 }, at: 1 });
    expect(down.scrollOffsets.get("jobs")).toBe(10);
    const up = dispatch(down, { type: "ui_intent", intent: { type: "page_up", amount: 4 }, at: 2 });
    expect(up.scrollOffsets.get("jobs")).toBe(6);
    const clamped = dispatch(up, { type: "ui_intent", intent: { type: "page_up", amount: 999 }, at: 3 });
    expect(clamped.scrollOffsets.get("jobs")).toBeUndefined(); // zero offset is not stored (see withScrollOffset)
  });

  it("scroll offsets are independent per screen", () => {
    const jobs = dispatch({ ...initialModel(), screen: "jobs" as const }, { type: "ui_intent", intent: { type: "page_down", amount: 5 }, at: 1 });
    const tasks = dispatch({ ...jobs, screen: "tasks" as const }, { type: "ui_intent", intent: { type: "page_down", amount: 3 }, at: 2 });
    expect(tasks.scrollOffsets.get("jobs")).toBe(5);
    expect(tasks.scrollOffsets.get("tasks")).toBe(3);
  });

  it("scroll_home resets to zero; scroll_end sets the unresolved sentinel", () => {
    const base = { ...initialModel(), screen: "jobs" as const };
    const down = dispatch(base, { type: "ui_intent", intent: { type: "page_down", amount: 10 }, at: 1 });
    const home = dispatch(down, { type: "ui_intent", intent: { type: "scroll_home" }, at: 2 });
    expect(home.scrollOffsets.has("jobs")).toBe(false);
    const end = dispatch(down, { type: "ui_intent", intent: { type: "scroll_end" }, at: 3 });
    expect(end.scrollOffsets.get("jobs")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("Home and End also select deterministic table endpoints", () => {
    const jobs = { jobs: [{ id: "job-a" }, { id: "job-b" }, { id: "job-c" }], queue_paused: false };
    const queried = dispatch({ ...initialModel(), screen: "jobs" as const }, { type: "query_results", queryId: "jobs", screen: "jobs", value: jobs });
    const end = dispatch(queried, { type: "ui_intent", intent: { type: "scroll_end" }, at: 1 });
    expect(end.selection.get("jobs")?.id).toBe("job-c");
    const home = dispatch(end, { type: "ui_intent", intent: { type: "scroll_home" }, at: 2 });
    expect(home.selection.get("jobs")?.id).toBe("job-a");
  });

  it("scroll_by moves by wheel-tick-sized deltas in either direction, clamped at zero", () => {
    const base = { ...initialModel(), screen: "jobs" as const };
    const down = dispatch(base, { type: "ui_intent", intent: { type: "scroll_by", lines: 3 }, at: 1 });
    expect(down.scrollOffsets.get("jobs")).toBe(3);
    const up = dispatch(down, { type: "ui_intent", intent: { type: "scroll_by", lines: -10 }, at: 2 });
    expect(up.scrollOffsets.has("jobs")).toBe(false);
  });

  it("every scroll intent no-ops while an overlay is active", () => {
    const opened = dispatch({ ...initialModel(), screen: "jobs" as const }, { type: "ui_intent", intent: { type: "toggle_help" }, at: 1 });
    const attempted = dispatch(opened, { type: "ui_intent", intent: { type: "page_down", amount: 10 }, at: 2 });
    expect(attempted.scrollOffsets.has("jobs")).toBe(false);
  });

  it("page_up/page_down/scroll_by reject non-positive-integer amounts as no-ops", () => {
    const base = { ...initialModel(), screen: "jobs" as const };
    expect(dispatch(base, { type: "ui_intent", intent: { type: "page_down", amount: 0 }, at: 1 }).scrollOffsets.has("jobs")).toBe(false);
    expect(dispatch(base, { type: "ui_intent", intent: { type: "page_down", amount: -1 }, at: 1 }).scrollOffsets.has("jobs")).toBe(false);
    expect(dispatch(base, { type: "ui_intent", intent: { type: "scroll_by", lines: 0 }, at: 1 }).scrollOffsets.has("jobs")).toBe(false);
  });
});
