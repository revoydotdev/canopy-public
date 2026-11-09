/**
 * `select_row` — pointer-driven selection at the model layer (wave 2).
 *
 * The intent takes an ABSOLUTE index into the screen's record list, not a
 * viewport row, so these tests are meaningful without a renderer: whatever
 * translates a click into an index (a future hit-test path) is a separate
 * concern, and deliberately so — an index-based intent means the same thing
 * whether or not the list is scrolled.
 */
import { describe, expect, it } from "vitest";
import { update } from "../src/update.js";
import { initialModel } from "../src/model.js";
import {
  latestInterview,
  oldestPendingApproval,
  selectScreenRow,
  selectTreeRow,
  selectedPendingApproval,
  stepScreenSelection,
  stickyScreenSelection,
} from "../src/operator-selection.js";

const TREE = {
  campaign_id: "c1",
  nodes: [
    { id: "root", state: "verified" },
    { id: "n1", state: "pending" },
    { id: "n2", state: "pending" },
  ],
};

function onTree(): ReturnType<typeof initialModel> {
  const focused = update(initialModel(), { type: "screen_changed", screen: "tree" }).model;
  return update(focused, { type: "query_results", queryId: "q", screen: "tree", value: TREE }).model;
}

describe("selectTreeRow — index to selection", () => {
  it("resolves an in-range index to that node, carrying the campaign context", () => {
    expect(selectTreeRow(TREE, 0)).toEqual({ id: "root", context: { campaign_id: "c1" } });
    expect(selectTreeRow(TREE, 2)).toEqual({ id: "n2", context: { campaign_id: "c1" } });
  });

  it("returns null for an out-of-range index rather than clamping to the nearest node", () => {
    // A click on a blank row below the last node hit nothing. Reporting that
    // as "selected the last node" would be a false positive — the same reason
    // hitTestFrame returns null outside every pane.
    expect(selectTreeRow(TREE, 3)).toBeNull();
    expect(selectTreeRow(TREE, -1)).toBeNull();
  });

  it("returns null for data that is not a tree payload at all", () => {
    expect(selectTreeRow(undefined, 0)).toBeNull();
    expect(selectTreeRow({ nodes: "not-an-array" }, 0)).toBeNull();
  });
});

describe("select_row intent", () => {
  it("accepts a native click's already-projected row identity without re-reading a mutable raw result", () => {
    const model = { ...initialModel(), screen: "jobs" as const };
    const next = update(model, { type: "ui_intent", intent: { type: "select_row_identity", screen: "jobs", selection: { id: "job-1", context: { queue: "default" } } }, at: 1 });
    expect(next.model.selection.get("jobs")).toEqual({ id: "job-1", context: { queue: "default" } });
  });

  it("does not accept a stale native identity when focus or an overlay changed", () => {
    const focusedElsewhere = { ...initialModel(), screen: "jobs" as const, overlay: { kind: "help" as const, query: "", selected_index: 0, expanded: false } };
    const next = update(focusedElsewhere, { type: "ui_intent", intent: { type: "select_row_identity", screen: "jobs", selection: { id: "job-1" } }, at: 1 });
    expect(next.model.selection.get("jobs")).toBeUndefined();
  });
  it("selects the node at the given index on the tree screen", () => {
    const next = update(onTree(), { type: "ui_intent", intent: { type: "select_row", screen: "tree", row: 2 }, at: 1 });
    expect(next.model.selection.get("tree")).toEqual({ id: "n2", context: { campaign_id: "c1" } });
    expect(next.effects).toEqual([]);
  });

  it("is a no-op for a screen that maintains no selection, rather than inventing one", () => {
    const model = onTree();
    const next = update(model, { type: "ui_intent", intent: { type: "select_row", screen: "jobs", row: 0 }, at: 1 });
    expect(next.model.selection.get("jobs")).toBeUndefined();
    expect(next.model).toBe(model);
  });

  it("leaves the existing selection untouched when the index is out of range", () => {
    const selected = update(onTree(), { type: "ui_intent", intent: { type: "select_row", screen: "tree", row: 1 }, at: 1 }).model;
    expect(selected.selection.get("tree")).toEqual({ id: "n1", context: { campaign_id: "c1" } });

    const missed = update(selected, { type: "ui_intent", intent: { type: "select_row", screen: "tree", row: 99 }, at: 2 });
    expect(missed.model.selection.get("tree")).toEqual({ id: "n1", context: { campaign_id: "c1" } });
  });
});

describe("operator selection projections", () => {
  it("uses answered ids and pending state rather than guessing an interview or approval target", () => {
    expect(latestInterview({ records: [
      { id: "asked", question: { question: "Old?" } },
      { id: "latest", question: { question: "New?" } },
    ], answered_record_ids: ["latest"] })).toEqual({ record_id: "asked", question: "Old?" });
    expect(latestInterview({ records: [{ id: "asked", question: {} }], answered_record_ids: ["asked"] })).toBeNull();
    expect(latestInterview({ records: [{ id: "fallback", question: { question: "Shown" } }] })).toEqual({ record_id: "fallback", question: "Shown" });
    const approvals = { records: [
      { request_id: "done", status: "approved" }, { request_id: "pending", status: "pending" }, { request_id: "also", status: "pending" },
    ] };
    expect(oldestPendingApproval(approvals)).toEqual({ request_id: "pending", action: "unknown", action_fingerprint: null });
    expect(selectedPendingApproval(approvals, "also")).toEqual({ request_id: "also", action: "unknown", action_fingerprint: null });
    expect(selectedPendingApproval(approvals, "done")).toBeNull();
    expect(selectedPendingApproval(undefined, "also")).toBeNull();
  });

  it("selects real ids from every supported list shape, preserving compound recovery and communication context", () => {
    expect(selectScreenRow("jobs", { jobs: [{ id: "j1" }, { id: 9 }] }, 0)).toEqual({ id: "j1" });
    expect(selectScreenRow("operations", [{ operation_id: "op1", state: "running", capability: "campaign.write" }], 0)).toEqual({ id: "op1" });
    expect(selectScreenRow("tasks", { items: [{ id: "t1" }] }, 0)).toEqual({ id: "t1" });
    expect(selectScreenRow("tasks", [{ id: "t2" }], 0)).toEqual({ id: "t2" });
    expect(selectScreenRow("output", [{ record: { id: "out1" } }], 0)).toEqual({ id: "out1" });
    expect(selectScreenRow("approvals", { records: [{ request_id: "a1" }] }, 0)).toEqual({ id: "a1" });
    expect(selectScreenRow("recovery", { campaign_id: "c1", nodes: [{ node_id: "n1", prior_operation_id: "op1", expected_version: "v1" }] }, 0)).toEqual({ id: "n1", context: { campaign_id: "c1", prior_operation_id: "op1", expected_version: "v1" } });
    expect(selectScreenRow("communications", { campaign_id: "c1", node_id: "n1", communications: [{ id: "msg1" }] }, 0)).toEqual({ id: "msg1", context: { campaign_id: "c1", node_id: "n1" } });
    expect(selectScreenRow("jobs", { jobs: [] }, 0)).toBeNull();
    expect(selectScreenRow("diagnostics", [], 0)).toBeNull();
  });

  it("steps and refreshes row selections without retaining stale ids", () => {
    const jobs = { jobs: [{ id: "j1" }, { id: "j2" }] };
    expect(stepScreenSelection("jobs", { id: "j2" }, jobs, 1)).toEqual({ id: "j1" });
    expect(stepScreenSelection("jobs", { id: "missing" }, jobs, -1)).toEqual({ id: "j1" });
    // A first keypress seeds the selection (first row on Down/j, last on
    // Up/k) instead of staying unselected forever (audit 2026-08-23).
    expect(stepScreenSelection("jobs", null, jobs, 1)).toEqual({ id: "j1" });
    expect(stepScreenSelection("jobs", null, jobs, -1)).toEqual({ id: "j2" });
    expect(stickyScreenSelection("jobs", { id: "j2" }, jobs)).toEqual({ id: "j2" });
    expect(stickyScreenSelection("jobs", { id: "missing" }, jobs)).toEqual({ id: "j1" });
    expect(stickyScreenSelection("jobs", { id: "j1" }, { jobs: [] })).toBeNull();
    const recovery = { campaign_id: "c1", nodes: [
      { node_id: "n1", prior_operation_id: "op1", expected_version: "v1" },
      { node_id: "n2", prior_operation_id: "op2", expected_version: "v2" },
    ] };
    const first = selectScreenRow("recovery", recovery, 0)!;
    expect(stepScreenSelection("recovery", first, recovery, 1)?.id).toBe("n2");
    expect(stickyScreenSelection("recovery", first, recovery)).toEqual(first);
    const communications = { campaign_id: "c1", node_id: "n1", communications: [{ id: "m1" }, { id: "m2" }] };
    const message = selectScreenRow("communications", communications, 1)!;
    expect(stepScreenSelection("communications", message, communications, 1)?.id).toBe("m1");
    expect(stickyScreenSelection("communications", { id: "gone" }, communications)?.id).toBe("m1");
  });
});
