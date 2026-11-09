import { describe, expect, it } from "vitest";
import { initialModel, update, type AppModel, type ScreenId, type UiIntent } from "../src/index.js";
import type { ScreenSelection } from "../src/operator-selection.js";

function operatorModel(screen: ScreenId, selection?: ScreenSelection, value?: unknown): AppModel {
  const model = initialModel();
  return {
    ...model,
    screen,
    selection: selection === undefined ? model.selection : new Map([[screen, selection]]),
    screens: value === undefined ? model.screens : new Map([[screen, value]]),
  };
}

function intent(model: AppModel, value: UiIntent, at = 100) {
  return update(model, { type: "ui_intent", intent: value, at });
}

function effectKind(model: AppModel, value: UiIntent): string | undefined {
  const effect = intent(model, value).effects[0];
  return effect?.type === "dispatch_command" || effect?.type === "run_query" ? effect.request.kind : effect?.type;
}

describe("update command boundaries", () => {
  it("double-confirms destructive row cancellation and blocks terminal harness interruption", () => {
    for (const [screen, id, command] of [
      ["jobs", "job-1", "job.cancel"],
      ["operations", "operation-1", "operation.cancel"],
      ["harness-sessions", "session-1", "harness.session.interrupt"],
      ["live-session", "session-2", "harness.session.interrupt"],
    ] as const) {
      const model = operatorModel(screen, { id, ...(screen.includes("session") ? { context: { interruptible: "yes" } } : {}) });
      const armed = intent(model, { type: "cancel_selected_row" }, 100);
      expect(armed.effects[0]?.type).toBe("schedule_repeat_confirmation_clear");
      const fired = intent(armed.model, { type: "cancel_selected_row" }, 101);
      expect(fired.effects[0]).toMatchObject({ type: "dispatch_command", request: { kind: command } });
      expect(intent(fired.model, { type: "cancel_selected_row" }, 102).effects).toEqual([]);
    }

    const terminal = intent(operatorModel("harness-sessions", { id: "done", context: { interruptible: "no" } }), { type: "cancel_selected_row" });
    expect(terminal.effects).toEqual([]);
    expect(terminal.model.notifications[0]?.message).toContain("terminal");
    expect(intent(operatorModel("tasks", { id: "task-1" }), { type: "cancel_selected_row" }).effects).toEqual([]);
    expect(intent(operatorModel("jobs"), { type: "cancel_selected_row" }).effects).toEqual([]);
  });

  it("dispatches only supported retry identities and preserves recovery CAS context", () => {
    expect(effectKind(operatorModel("jobs", { id: "job-1" }), { type: "retry_selected_row" })).toBe("job.retry");
    expect(effectKind(operatorModel("tasks", { id: "task-1" }), { type: "retry_selected_row" })).toBe("task.retry");
    const recovery = operatorModel("recovery", { id: "node-1", context: { campaign_id: "campaign-1", prior_operation_id: "operation-1", expected_version: "v1" } });
    const retried = intent(recovery, { type: "retry_selected_row" });
    expect(effectKind(recovery, { type: "retry_selected_row" })).toBe("recovery.retry");
    expect(retried.effects[0]).toMatchObject({ request: { metadata: { expected_version: "v1" } } });
    expect(intent(operatorModel("recovery", { id: "node-1" }), { type: "retry_selected_row" }).effects).toEqual([]);
    expect(intent(operatorModel("output", { id: "evidence-1" }), { type: "retry_selected_row" }).effects).toEqual([]);
    expect(intent(operatorModel("jobs"), { type: "retry_selected_row" }).effects).toEqual([]);
  });

  it("routes row details through each canonical query and rejects incomplete communication scope", () => {
    const cases: readonly [ScreenId, ScreenSelection, string][] = [
      ["operations", { id: "operation-1" }, "operation.get"],
      ["output", { id: "evidence-1" }, "output.descriptor"],
      ["communications", { id: "message-1", context: { campaign_id: "campaign-1", node_id: "node-1" } }, "communication.history"],
      ["harness-sessions", { id: "session-1" }, "harness.session.inspect"],
      ["harness-evaluations", { id: "run-1" }, "harness.evaluation.detail"],
      ["trust", { id: "session-1" }, "trust.session.status"],
      ["task-composer", { id: "draft-1" }, "taskcomposer.get"],
      ["project-registry", { id: "project-1" }, "project.registry.list"],
    ];
    for (const [screen, selection, command] of cases) {
      expect(effectKind(operatorModel(screen, selection), { type: "view_selected_row_detail" })).toBe(command);
    }
    expect(intent(operatorModel("communications", { id: "message-1" }), { type: "view_selected_row_detail" }).effects).toEqual([]);
    expect(intent(operatorModel("jobs", { id: "job-1" }), { type: "view_selected_row_detail" }).effects).toEqual([]);
    expect(intent(operatorModel("operations"), { type: "view_selected_row_detail" }).effects).toEqual([]);
  });

  it("keeps harness event and attach queries screen-scoped and selection-scoped", () => {
    for (const screen of ["harness-sessions", "live-session"] as const) {
      const model = operatorModel(screen, { id: "session-1" });
      expect(effectKind(model, { type: "view_selected_harness_session_events" })).toBe("harness.session.events");
      expect(effectKind(model, { type: "attach_selected_harness_session" })).toBe("harness.session.attach");
    }
    expect(intent(operatorModel("jobs", { id: "job-1" }), { type: "attach_selected_harness_session" }).effects).toEqual([]);
    expect(intent(operatorModel("harness-sessions"), { type: "view_selected_harness_session_events" }).effects).toEqual([]);
  });

  it("arms recovery abandonment and tree pruning before dispatch", () => {
    const recovery = operatorModel("recovery", { id: "node-1", context: { campaign_id: "campaign-1", prior_operation_id: "operation-1", expected_version: "v1" } });
    const abandoned = intent(recovery, { type: "abandon_recovery_selected" });
    expect(abandoned.model.overlay).toMatchObject({ kind: "confirm", pendingAction: { kind: "recovery.abandon", expected_version: "v1" } });
    expect(effectKind(abandoned.model, { type: "confirm_pending_action" })).toBe("recovery.abandon");

    const tree = operatorModel("tree", { id: "node-1", context: { campaign_id: "campaign-1" } });
    expect(effectKind(tree, { type: "branch_selected_node" })).toBe("tree.branch");
    const pruning = intent(tree, { type: "request_prune_selected_node" });
    expect(pruning.model.overlay).toMatchObject({ kind: "confirm", pendingAction: { kind: "tree.prune" } });
    expect(intent(pruning.model, { type: "cancel_pending_action" }).model.overlay).toBeNull();

    expect(intent(operatorModel("jobs", { id: "job-1" }), { type: "branch_selected_node" }).effects).toEqual([]);
    expect(intent(operatorModel("tree", { id: "node-1" }), { type: "request_prune_selected_node" }).effects).toEqual([]);
    expect(intent(operatorModel("jobs"), { type: "confirm_pending_action" }).effects).toEqual([]);
  });

  it("bounds generic scrolling, endpoint selection, and help ownership", () => {
    const jobs = operatorModel("jobs", undefined, { jobs: [{ id: "job-1" }, { id: "job-2" }] });
    const end = intent(jobs, { type: "scroll_end" });
    expect(end.model.selection.get("jobs")?.id).toBe("job-2");
    expect(intent(end.model, { type: "scroll_home" }).model.selection.get("jobs")?.id).toBe("job-1");
    expect(intent(jobs, { type: "page_down", amount: 5 }).model.scrollOffsets.get("jobs")).toBe(5);
    expect(intent({ ...jobs, scrollOffsets: new Map([["jobs", 5]]) }, { type: "page_up", amount: 3 }).model.scrollOffsets.get("jobs")).toBe(2);
    expect(intent(jobs, { type: "scroll_by", lines: 2 }).model.scrollOffsets.get("jobs")).toBe(2);
    for (const invalid of [
      { type: "page_up", amount: 0 },
      { type: "page_down", amount: Number.NaN },
      { type: "scroll_by", lines: 0 },
    ] as const) expect(intent(jobs, invalid).model).toBe(jobs);

    const shown = intent(jobs, { type: "toggle_help" }).model;
    expect(shown.overlay).toMatchObject({ kind: "help", expanded: false });
    const filtered = intent(shown, { type: "help_query_input", buffer: "retry" }).model;
    const selected = intent(filtered, { type: "help_select_index", index: 2 }).model;
    expect(intent(selected, { type: "help_toggle_expanded" }).model.overlay).toMatchObject({ kind: "help", expanded: true, selected_index: 0 });
    expect(intent(shown, { type: "help_select_index", index: -1 }).model).toBe(shown);
    expect(intent(shown, { type: "toggle_help" }).model.overlay).toBeNull();
  });
});
