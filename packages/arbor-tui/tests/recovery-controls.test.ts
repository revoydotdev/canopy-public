import { describe, expect, it } from "vitest";
import { initialModel } from "../src/model.js";
import { update } from "../src/update.js";
import { recoveryScreen } from "../src/screens/recovery.js";

const PENDING = {
  campaign_id: "campaign-1",
  nodes: [{ node_id: "node-1", state: "interrupted", prior_operation_id: "interrupt-1", expected_version: "revision-4", reason: "worker exited after cancellation" }],
};

function recoveryModel() {
  const focused = update(initialModel(), { type: "screen_changed", screen: "recovery" }).model;
  return update(focused, { type: "query_results", queryId: "pending", screen: "recovery", value: PENDING }).model;
}

describe("recovery controls", () => {
  it("projects durable selection identity and renders a bounded screen", () => {
    const projection = recoveryScreen.project(PENDING, { width: 100, height: 20, granted_capabilities: new Set(["recovery.write", "recovery.abandon"]) });
    expect(projection.row_ids).toEqual([{ id: "node-1", context: { campaign_id: "campaign-1", prior_operation_id: "interrupt-1", expected_version: "revision-4" } }]);
    expect(projection.rows[0]).toMatchObject({
      source: "canonical/recovery.pending",
      detail: expect.stringContaining("worker exited after cancellation"),
      actions: "r retry (recovery.write) · z abandon (recovery.abandon; confirmation required)",
    });
    const rendered = recoveryScreen.render({ projection, width: 180, height: 10 }).join("\n");
    expect(rendered).toContain("worker exited after cancella");
    expect(rendered).toContain("canonical/recovery.pending");
    // Controls are labelled by the capability that authorizes them, not by the
    // canonical command kind: the action identity `recovery.retry` is asserted
    // at the dispatch boundary in the CAS test below, and the rendered control
    // names the `recovery.write` capability the operator must hold.
    expect(rendered).toContain("recovery.write");
    expect(rendered).toContain("recovery.abandon");
    expect(rendered).toContain("confirmation required");
  });

  it("shows recovery actions only when their separate capabilities are granted", () => {
    const readOnly = recoveryScreen.project(PENDING, { width: 100, height: 20, granted_capabilities: new Set(["recovery.read"]) });
    expect(readOnly.rows[0]?.actions).toBe("retry unavailable (requires recovery.write) · abandon unavailable (requires recovery.abandon)");

    const retryOnly = recoveryScreen.project(PENDING, { width: 100, height: 20, granted_capabilities: new Set(["recovery.read", "recovery.write"]) });
    expect(retryOnly.rows[0]?.actions).toBe("r retry (recovery.write) · abandon unavailable (requires recovery.abandon)");

    const abandonOnly = recoveryScreen.project(PENDING, { width: 100, height: 20, granted_capabilities: new Set(["recovery.read", "recovery.abandon"]) });
    expect(abandonOnly.rows[0]?.actions).toBe("retry unavailable (requires recovery.write) · z abandon (recovery.abandon; confirmation required)");
  });

  it("marks a node without a durable prior operation as unselectable crash evidence, and degrades a render fault safely", () => {
    const partial = { campaign_id: "campaign-1", nodes: [{ node_id: "node-2", state: "interrupted" }] };
    const projection = recoveryScreen.project(partial, { width: 100, height: 20 });
    expect(projection.rows[0]).toMatchObject({
      id: "node-2",
      detail: expect.stringContaining("prior operation unavailable"),
      actions: "inspect only — retry/abandon unavailable: durable prior operation or version is missing",
    });
    expect(projection.row_ids).toEqual([null]);
    expect(recoveryScreen.render({ projection, width: 180, height: 10 }).join("\n")).toContain("retry/abandon unavailable");
    // A negative scroll offset makes renderTable throw; recovery.ts must catch it rather than crash the cockpit.
    expect(recoveryScreen.render({ projection, width: 80, height: 10, scroll_offset: -1 })).toEqual(["(render error)"]);
  });

  it("retries exactly the selected durable target with its CAS version", () => {
    const result = update(recoveryModel(), { type: "ui_intent", intent: { type: "retry_selected_row" }, at: 5 });
    expect(result.effects).toEqual([{ type: "dispatch_command", request: {
      kind: "recovery.retry", metadata: { operation_id: "tui:recovery.retry:5", idempotency_key: "tui:recovery.retry:5", expected_version: "revision-4" },
      params: { campaign_id: "campaign-1", node_id: "node-1", prior_operation_id: "interrupt-1", reason: "operator-requested retry" },
    } }]);
  });

  it("requires confirmation before abandoning and retains the CAS version at dispatch", () => {
    const armed = update(recoveryModel(), { type: "ui_intent", intent: { type: "abandon_recovery_selected" }, at: 5 });
    expect(armed.model.overlay).toMatchObject({ kind: "confirm", pendingAction: { kind: "recovery.abandon", expected_version: "revision-4" } });
    const confirmed = update(armed.model, { type: "ui_intent", intent: { type: "confirm_pending_action" }, at: 6 });
    expect(confirmed.effects).toEqual([{ type: "dispatch_command", request: {
      kind: "recovery.abandon", metadata: { operation_id: "tui:recovery.abandon:6", idempotency_key: "tui:recovery.abandon:6", expected_version: "revision-4" },
      params: {
        campaign_id: "campaign-1", node_id: "node-1", prior_operation_id: "interrupt-1", reason: "operator-requested abandonment",
        authorization: { authority: "operator", authorized_by: "tui-operator", rationale: "operator-confirmed abandonment from TUI" },
      },
    } }]);
  });

  it("does not make a crashed node without a prior interruption operation actionable", () => {
    const model = update(update(initialModel(), { type: "screen_changed", screen: "recovery" }).model, {
      type: "query_results", queryId: "pending", screen: "recovery",
      value: { campaign_id: "campaign-1", nodes: [{ node_id: "crashed", state: "expanding", prior_operation_id: null, expected_version: "revision-4" }] },
    }).model;
    expect(model.selection.get("recovery")).toBeUndefined();
    expect(update(model, { type: "ui_intent", intent: { type: "retry_selected_row" }, at: 5 }).effects).toEqual([]);
  });

  it("retains an explicit empty recovery surface when no result is available", () => {
    expect(recoveryScreen.project(null, { width: 80, height: 10 })).toMatchObject({
      variant: "empty",
      caption: "Recovery data unavailable — no retry target is inferred",
      rows: [],
    });
  });
});
