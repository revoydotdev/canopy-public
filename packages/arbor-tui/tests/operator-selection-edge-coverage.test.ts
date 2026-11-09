import { describe, expect, it } from "vitest";
import type { ScreenId } from "../src/index.js";
import {
  selectScreenEndpoint,
  selectScreenRow,
  stepScreenSelection,
  stickyScreenSelection,
  type ScreenSelection,
} from "../src/operator-selection.js";

interface SelectionFixture {
  readonly screen: ScreenId;
  readonly raw: unknown;
  readonly first: ScreenSelection;
  readonly last: ScreenSelection;
}

const fixtures: readonly SelectionFixture[] = [
  {
    screen: "recovery",
    raw: { campaign_id: "campaign-1", nodes: [
      { node_id: "node-1", prior_operation_id: "operation-1", expected_version: "v1" },
      { node_id: "node-2", prior_operation_id: "operation-2", expected_version: "v2" },
    ] },
    first: { id: "node-1", context: { campaign_id: "campaign-1", prior_operation_id: "operation-1", expected_version: "v1" } },
    last: { id: "node-2", context: { campaign_id: "campaign-1", prior_operation_id: "operation-2", expected_version: "v2" } },
  },
  {
    screen: "communications",
    raw: { campaign_id: "campaign-1", node_id: "node-1", communications: [{ id: "message-1" }, { id: "message-2" }] },
    first: { id: "message-1", context: { campaign_id: "campaign-1", node_id: "node-1" } },
    last: { id: "message-2", context: { campaign_id: "campaign-1", node_id: "node-1" } },
  },
  {
    screen: "threads",
    raw: { parent_node_id: "parent", child_node_id: "child", version: "thread-v1", messages: [
      { id: "thread-1", author_node_id: "parent", ack_required: true },
      { id: "thread-2", author_node_id: "child", ack_required: false },
    ] },
    first: { id: "thread-1", context: { parent_node_id: "parent", child_node_id: "child", expected_thread_version: "thread-v1", author_node_id: "parent", ack_required: "true" } },
    last: { id: "thread-2", context: { parent_node_id: "parent", child_node_id: "child", expected_thread_version: "thread-v1", author_node_id: "child", ack_required: "false" } },
  },
  {
    screen: "harness-sessions",
    raw: { sessions: [{ session_id: "session-live", terminal: null }, { session_id: "session-done", terminal: { cause: "completed" } }] },
    first: { id: "session-live", context: { interruptible: "yes" } },
    last: { id: "session-done", context: { interruptible: "no" } },
  },
  {
    screen: "overlays",
    raw: {
      campaign_id: "campaign-1",
      active_folds: [{ id: "fold-1", component: "fold" }],
      active_harness_revisions: [{ id: "revision-1", component: "subagent_descriptor", status: "active", evaluation: { outcome: "not_yet_measured" } }],
    },
    first: { id: "fold-1", context: { campaign_id: "campaign-1", overlay_type: "fold", component: "fold" } },
    last: { id: "revision-1", context: { campaign_id: "campaign-1", overlay_type: "harness", component: "subagent_descriptor", status: "active", evaluation_outcome: "not_yet_measured" } },
  },
  {
    screen: "harness-evaluations",
    raw: [
      { id: "evaluation-1", revision_id: "revision-1", state: "measured", evaluation: { outcome: "improved", regression_detected: false }, evidence_ids: ["e1"] },
      { id: "evaluation-2", revision_id: "revision-2", state: "measured", evaluation: { outcome: "regressed", regression_detected: true }, evidence_ids: ["e2"] },
    ],
    first: { id: "evaluation-1", context: { revision_id: "revision-1", state: "measured", outcome: "improved", regression_detected: "false", evidence_ids_json: "[\"e1\"]" } },
    last: { id: "evaluation-2", context: { revision_id: "revision-2", state: "measured", outcome: "regressed", regression_detected: "true", evidence_ids_json: "[\"e2\"]" } },
  },
  {
    screen: "task-composer",
    raw: { items: [
      { id: "draft-1", revision: 1, campaign_id: "campaign-1", evidence_ids: ["e1", "", 3], proposal: { questions: [{ id: "question-1", answer: null }] } },
      { id: "draft-2", revision: 2, proposal: { questions: [{ id: "question-2", answer: "done" }] } },
    ] },
    first: { id: "draft-1", context: { expected_revision: "1", question_id: "question-1", campaign_id: "campaign-1", evidence_ids_json: "[\"e1\"]" } },
    last: { id: "draft-2", context: { expected_revision: "2", evidence_ids_json: "[]" } },
  },
];

describe("operator selection identity and refresh boundaries", () => {
  it.each(fixtures)("preserves the full $screen row identity through absolute and endpoint selection", ({ screen, raw, first, last }) => {
    expect(selectScreenRow(screen, raw, 0)).toEqual(first);
    expect(selectScreenRow(screen, raw, 1)).toEqual(last);
    expect(selectScreenEndpoint(screen, raw, "first")).toEqual(first);
    expect(selectScreenEndpoint(screen, raw, "last")).toEqual(last);
    expect(selectScreenRow(screen, raw, -1)).toBeNull();
    expect(selectScreenRow(screen, raw, 2)).toBeNull();
  });

  it.each(fixtures)("seeds, wraps, recovers, and sticks $screen selection without losing context", ({ screen, raw, first, last }) => {
    expect(stepScreenSelection(screen, null, raw, 1)).toEqual(first);
    expect(stepScreenSelection(screen, null, raw, -1)).toEqual(last);
    expect(stepScreenSelection(screen, first, raw, -1)).toEqual(last);
    expect(stepScreenSelection(screen, last, raw, 1)).toEqual(first);
    expect(stepScreenSelection(screen, { id: "missing" }, raw, 1)).toEqual(first);
    expect(stickyScreenSelection(screen, last, raw)).toEqual(last);
    expect(stickyScreenSelection(screen, { id: "missing" }, raw)).toEqual(first);
  });

  it("filters nonselectable live-session rows while retaining terminal interruptibility in the inventory", () => {
    const raw = { sessions: [
      { session_id: "live", attachable: true, terminal: null },
      { session_id: "detached", attachable: false, terminal: null },
      { session_id: "done", attachable: true, terminal: { cause: "completed" } },
      { session_id: 7, attachable: true, terminal: null },
    ] };
    expect(selectScreenRow("live-session", raw, 0)).toEqual({ id: "live", context: { interruptible: "yes" } });
    expect(selectScreenRow("live-session", raw, 1)).toBeNull();
    expect(selectScreenRow("harness-sessions", raw, 2)).toEqual({ id: "done", context: { interruptible: "no" } });
  });

  it("distinguishes malformed, empty, and refreshed-away complex projections", () => {
    const current = { id: "keep", context: { expected_version: "v1" } };
    for (const screen of fixtures.map((fixture) => fixture.screen)) {
      expect(selectScreenRow(screen, null, 0)).toBeNull();
      expect(selectScreenEndpoint(screen, null, "first")).toBeNull();
      expect(stepScreenSelection(screen, current, null, 1)).toBe(current);
      expect(stickyScreenSelection(screen, current, null)).toBe(current);
    }

    expect(stickyScreenSelection("recovery", current, { campaign_id: "campaign-1", nodes: [] })).toBeNull();
    expect(stickyScreenSelection("communications", current, { campaign_id: "campaign-1", node_id: "node-1", communications: [] })).toBeNull();
    expect(stickyScreenSelection("threads", current, { parent_node_id: "p", child_node_id: "c", version: "v1", messages: [] })).toBeNull();
    expect(stickyScreenSelection("harness-sessions", current, { sessions: [] })).toBeNull();
    expect(stickyScreenSelection("overlays", current, { campaign_id: "campaign-1", active_folds: [], active_harness_revisions: [] })).toBeNull();
    expect(stickyScreenSelection("harness-evaluations", current, [])).toBeNull();
    expect(stickyScreenSelection("task-composer", current, { items: [] })).toBeNull();
  });

  it("covers simple-list fallback identities and the interviews newest-pending rule", () => {
    expect(selectScreenEndpoint("jobs", { jobs: [{ id: "j1" }, { id: "j2" }] }, "last")).toEqual({ id: "j2" });
    // Event ids belong to Diagnostics/Recovery; Operations selects only the
    // canonical operation identity and skips the removed event-row shape.
    expect(selectScreenEndpoint("operations", [{ id: "event-1" }, { operation_id: "operation-2" }], "first")).toBeNull();
    expect(selectScreenEndpoint("tasks", [{ id: "task-1" }, { id: "task-2" }], "last")).toEqual({ id: "task-2" });
    expect(selectScreenRow("output", [{ id: "direct" }, { record: { id: "nested" } }], 1)).toEqual({ id: "nested" });
    expect(selectScreenRow("project-registry", { entries: [{ project_id: "project-1" }, {}] }, 0)).toEqual({ id: "project-1" });
    expect(selectScreenRow("campaigns", { items: [{ id: "campaign-1" }, {}] }, 0)).toEqual({ id: "campaign-1" });
    expect(stickyScreenSelection("interviews", null, {
      records: [{ id: "answered" }, { id: "pending-1" }, { id: "pending-2" }],
      answered_record_ids: ["answered"],
    })).toEqual({ id: "pending-2" });
  });
});
