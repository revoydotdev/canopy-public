/**
 * `harness-evaluations`'s selection gates `harness.promote` / `harness.quarantine`
 * on `context.state`/`context.outcome`/`context.regression_detected` (update.ts's
 * `open_operator_form`). Those fields are captured into `model.selection` at
 * selection time. Every OTHER screen with row-scoped, state-gated commands
 * (jobs/operations/tasks/recovery/communications/overlays/task-composer/...)
 * is listed in `STICKY_SELECTION_SCREENS` so a fresh `query_results` refreshes
 * the selection's context to the live projection (`stickyScreenSelection`,
 * proven in select-row.test.ts's "steps and refreshes row selections without
 * retaining stale ids"). If `harness-evaluations` is dropped from that set,
 * a selected run's gating context freezes at whatever it was when selected,
 * even after a real refresh reports the run has moved past "measured".
 */
import { describe, expect, it } from "vitest";
import { update } from "../src/update.js";
import { initialModel } from "../src/model.js";

const RUN_MEASURED = {
  id: "run-1", revision_id: "rev-1", state: "measured", evaluator_id: "eval-1", requested_at: "now",
  evidence_ids: ["e1"], evaluation: { outcome: "improved", regression_detected: false },
};

function onHarnessEvaluations() {
  const focused = update(initialModel(), { type: "screen_changed", screen: "harness-evaluations" }).model;
  return update(focused, { type: "query_results", queryId: "q1", screen: "harness-evaluations", value: [RUN_MEASURED] }).model;
}

describe("harness-evaluations selection survives a fresh query_results", () => {
  it("refreshes the selected run's gating context (state) on a fresh fetch, the same way jobs/tasks/etc. do", () => {
    const selected = update(onHarnessEvaluations(), {
      type: "ui_intent",
      intent: { type: "select_row", screen: "harness-evaluations", row: 0 },
      at: 1,
    }).model;
    expect(selected.selection.get("harness-evaluations")).toMatchObject({ id: "run-1", context: { state: "measured" } });

    // The run has since moved past "measured" (e.g. promoted). A fresh fetch
    // reports this.
    const refreshed = update(selected, {
      type: "query_results",
      queryId: "q2",
      screen: "harness-evaluations",
      value: [{ ...RUN_MEASURED, state: "promoted" }],
    }).model;

    expect(refreshed.selection.get("harness-evaluations")).toMatchObject({ id: "run-1", context: { state: "promoted" } });
  });

  it("consequently refuses to open harness.promote once a refresh reports the run is no longer measured", () => {
    const selected = update(onHarnessEvaluations(), {
      type: "ui_intent",
      intent: { type: "select_row", screen: "harness-evaluations", row: 0 },
      at: 1,
    }).model;

    const refreshed = update(selected, {
      type: "query_results",
      queryId: "q2",
      screen: "harness-evaluations",
      value: [{ ...RUN_MEASURED, state: "promoted" }],
    }).model;

    const attempt = update(refreshed, {
      type: "ui_intent",
      intent: { type: "open_operator_form", command: "harness.promote" },
      at: 2,
    });
    expect(attempt.model.overlay).toBeNull();
  });
});
