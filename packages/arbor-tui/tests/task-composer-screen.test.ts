import { describe, expect, it } from "vitest";
import { taskComposerScreen } from "../src/screens/task-composer.js";
import { initialModel } from "../src/model.js";
import { update } from "../src/update.js";
import type { AppModel } from "../src/types.js";
import type { ScreenId } from "../src/screens/screen.js";
import type { ScreenSelection } from "../src/operator-selection.js";

const proposed = {
  id: "draft-1",
  revision: 3,
  status: "proposed",
  task: "Document the session lifecycle",
  source: "tui",
  parent_campaign_id: "campaign-parent",
  evidence_ids: ["artifact-1"],
  proposal: {
    summary: "Add accurate session documentation",
    assumptions: ["docs are the only target"],
    questions: [{ id: "question-1", question: "Which audience?", answer: null }],
    root_action: { description: "Write docs", estimated_gain: 1, estimated_cost: 1, category: "docs", delegate_to: "seed" },
    actions: [{ description: "Write docs", estimated_gain: 1, estimated_cost: 1, category: "docs", delegate_to: "seed" }],
    acceptance_checks: ["docs lint passes"],
    risk_notes: ["No implementation changes"],
  },
  planner: { kind: "native", session_id: "session-1", model_identity: "fixture/model", error: null },
  campaign_id: "campaign-1",
  job_id: null,
  rejection_reason: null,
  created_at: "2026-08-09T00:00:00.000Z",
  updated_at: "2026-08-09T00:01:00.000Z",
};

function selectedDraft(): AppModel {
  const base = initialModel();
  return {
    ...base,
    screen: "task-composer",
    selection: new Map<ScreenId, ScreenSelection>([["task-composer", {
      id: "draft-1",
      context: { expected_revision: "3", question_id: "question-1", campaign_id: "campaign-1", evidence_ids_json: '["artifact-1"]' },
    }]]),
  };
}

function open(model: AppModel, command: "taskcomposer.submit" | "taskcomposer.followup" | "taskcomposer.answer" | "taskcomposer.reject"): AppModel {
  return update(model, { type: "ui_intent", intent: { type: "open_operator_form", command }, at: 1 }).model;
}

function enter(model: AppModel, field: string, value: string): AppModel {
  const overlay = model.overlay;
  if (overlay?.kind !== "operator_form") throw new Error("expected task composer form");
  let current = model;
  while (current.overlay?.kind === "operator_form" && current.overlay.active_field !== field) {
    current = update(current, { type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at: 2 }).model;
  }
  return update(current, { type: "ui_intent", intent: { type: "operator_form_input", value }, at: 2 }).model;
}

describe("task composer screen", () => {
  it("renders an 80-column attention queue while preserving the full projected draft contract", () => {
    const projection = taskComposerScreen.project({ items: [proposed], total: 1 }, { width: 160, height: 20 });
    expect(projection.rows[0]).toMatchObject({ id: "draft-1", revision: "3", status: "proposed", attention: "Needs answer", question: "Which audience?", lineage: "campaign-parent", evidence: "1 selected" });
    expect(String(projection.rows[0]?.proposal)).toContain("Add accurate session");
    expect(String(projection.rows[0]?.plan)).toContain("Add accurate session");
    expect(projection.rows[0]?.scope).toContain("Write docs");
    expect(projection.rows[0]?.risk).toContain("No implementation changes");
    expect(projection.columns.map((column) => column.key)).toEqual(["task", "attention", "plan", "updated"]);
    expect(projection.row_ids).toEqual([{ id: "draft-1", context: { expected_revision: "3", question_id: "question-1", campaign_id: "campaign-1", evidence_ids_json: '["artifact-1"]' } }]);
    expect(taskComposerScreen.surface.commands).toEqual(["taskcomposer.submit", "taskcomposer.answer", "taskcomposer.confirm", "taskcomposer.cancel", "taskcomposer.retry", "taskcomposer.reject"]);
    const rendered = taskComposerScreen.render({ projection, width: 80, height: 24 });
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain("Attention");
    expect(rendered[2]).toContain("Needs answer");
    expect(rendered.every((line) => line.length <= 80)).toBe(true);
  });

  it("projects single-draft detail, filters malformed drafts, and owns its empty rendering", () => {
    const detail = taskComposerScreen.project({ draft: { ...proposed, proposal: null, planner: { kind: "failed", error: "offline" }, campaign_id: null, evidence_ids: [], guidance: { kind: "recovery", headline: "Planning is not connected", detail: "Project unchanged.", recommendation: "Run arbor doctor, then retry.", retryable: true } } }, { width: 120, height: 24 });
    expect(detail.variant).toBe("get");
    expect(detail.rows[0]).toMatchObject({ proposal: "failed: offline", scope: "awaiting plan", risk: "—", run: "not admitted" });
    const renderedDetail = taskComposerScreen.render({ projection: detail, width: 80, height: 24 }).join("\n");
    expect(renderedDetail).toContain("Plan");
    expect(renderedDetail).toContain("failed: offline");
    expect(renderedDetail).toContain("Planning is not connected");
    expect(renderedDetail).toContain("Run arbor doctor, then retry");
    expect(renderedDetail).not.toContain("Ctrl+A answer clarification");

    const malformed = taskComposerScreen.project({ items: [null, { id: "", revision: 0, status: "", task: 3 }] }, { width: 80, height: 5 });
    expect(malformed.rows).toEqual([]);
    expect(taskComposerScreen.render({ projection: malformed, width: 80, height: 5 })).toHaveLength(2);
    expect(taskComposerScreen.project({ draft: null }, { width: 80, height: 5 }).rows).toEqual([]);
    expect(taskComposerScreen.project(undefined, { width: 80, height: 5 }).variant).toBe("empty");
  });

  it("shows the clarification answer shortcut only when the inspected draft has a real pending question", () => {
    const withQuestion = taskComposerScreen.project({ draft: proposed }, { width: 120, height: 24 });
    expect(taskComposerScreen.render({ projection: withQuestion, width: 120, height: 24 }).join("\n")).toContain("Ctrl+A answer clarification");

    const withoutQuestion = taskComposerScreen.project({ draft: { ...proposed, proposal: null } }, { width: 120, height: 24 });
    expect(taskComposerScreen.render({ projection: withoutQuestion, width: 120, height: 24 }).join("\n")).not.toContain("Ctrl+A answer clarification");
  });

  it("renders durable completed interview history after the planner removes its question", () => {
    const answered = taskComposerScreen.project({ draft: {
      ...proposed,
      proposal: { ...proposed.proposal, questions: [] },
      answered_questions: [{ id: "question-1", question: "Which audience?", answer: "Nontechnical founders", answered_by: "operator", answered_at: "2026-08-09T00:00:30.000Z" }],
    } }, { width: 120, height: 32 });
    const rendered = taskComposerScreen.render({ projection: answered, width: 120, height: 32 }).join("\n");
    expect(rendered).toContain("Interview history");
    expect(rendered).toContain("Which audience? → Nontechnical founders");
  });

  it("submits a new draft only through the canonical taskcomposer command with TUI source and idempotency", () => {
    const form = enter(open(initialModel(), "taskcomposer.submit"), "task", "Document the public API");
    const result = update(form, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 10 });
    expect(result.effects).toEqual([{ type: "dispatch_command", request: {
      kind: "taskcomposer.submit",
      metadata: { operation_id: "tui:taskcomposer.submit:10", idempotency_key: "tui:taskcomposer.submit:10" },
      params: { task: "Document the public API", source: "tui", idempotency_key: "tui:taskcomposer.submit:10", evidence_ids: [], auto_confirm: true },
    } }]);
  });

  it("emits explicit attachment paths for MCP-side resolution", () => {
    const form = enter(enter(open(initialModel(), "taskcomposer.submit"), "task", "Inspect these references"), "attachment_paths", "/tmp/one.png\n/tmp/requirements.md");
    const result = update(form, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 10 });
    expect(result.effects).toEqual([{ type: "submit_taskcomposer_attachments", attachment_paths: ["/tmp/one.png", "/tmp/requirements.md"], request: {
      kind: "taskcomposer.submit",
      metadata: { operation_id: "tui:taskcomposer.submit:10", idempotency_key: "tui:taskcomposer.submit:10" },
      params: { task: "Inspect these references", source: "tui", idempotency_key: "tui:taskcomposer.submit:10", evidence_ids: [], auto_confirm: true },
    } }]);
  });

  it("rejects more than four attachment paths before emitting an effect", () => {
    const form = enter(enter(open(initialModel(), "taskcomposer.submit"), "task", "Inspect files"), "attachment_paths", "a.png\nb.png\nc.png\nd.png\ne.png");
    const result = update(form, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 10 });
    expect(result.effects).toEqual([]);
    expect(result.model.overlay).toMatchObject({ error: "attachment_paths must contain at most four newline-separated paths" });
  });

  it("uses projection-derived CAS/question identity for clarification and never lets typed fields replace it", () => {
    const form = enter(open(selectedDraft(), "taskcomposer.answer"), "answer", "Developer-facing");
    const result = update(form, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 11 });
    expect(result.effects[0]).toMatchObject({ type: "dispatch_command", request: {
      kind: "taskcomposer.answer",
      params: { draft_id: "draft-1", expected_revision: 3, question_id: "question-1", answer: "Developer-facing" },
    } });
  });

  it("shows the selected live clarification in the answer form without adding it to command fields", () => {
    const model: AppModel = { ...selectedDraft(), screens: new Map([["task-composer", { items: [proposed] }]]) };
    const form = open(model, "taskcomposer.answer");
    expect(form.overlay).toMatchObject({ kind: "operator_form", detail: "Which audience?", fields: { answer: "" } });
    expect(form.overlay).not.toHaveProperty("fields.question");
  });

  it("confirms only the selected proposal with its current revision and required idempotency key", () => {
    const result = update(selectedDraft(), { type: "ui_intent", intent: { type: "confirm_task_composer" }, at: 12 });
    expect(result.effects).toEqual([{ type: "dispatch_command", request: {
      kind: "taskcomposer.confirm",
      metadata: { operation_id: "tui:taskcomposer.confirm:12", idempotency_key: "tui:taskcomposer.confirm:12", expected_version: "3" },
      params: { draft_id: "draft-1", expected_revision: 3, idempotency_key: "tui:taskcomposer.confirm:12" },
    } }]);
  });

  it("retries the selected failed draft in place with revision CAS", () => {
    const result = update(selectedDraft(), { type: "ui_intent", intent: { type: "retry_task_composer" }, at: 13 });
    expect(result.effects).toEqual([{ type: "dispatch_command", request: {
      kind: "taskcomposer.retry",
      metadata: { operation_id: "tui:taskcomposer.retry:13", idempotency_key: "tui:taskcomposer.retry:13", expected_version: "3" },
      params: { draft_id: "draft-1", expected_revision: 3, idempotency_key: "tui:taskcomposer.retry:13" },
    } }]);
  });

  it("opens detail through the bounded canonical get query", () => {
    const result = update(selectedDraft(), { type: "ui_intent", intent: { type: "view_selected_row_detail" }, at: 12 });
    expect(result.effects).toEqual([{ type: "run_query", request: { kind: "taskcomposer.get", query_id: "tui:detail:task-composer:12", params: { draft_id: "draft-1" } } }]);
  });

  it("creates follow-ups as new linked drafts with bounded selected evidence, not transcript state", () => {
    const form = enter(open(selectedDraft(), "taskcomposer.followup"), "task", "Now add an FAQ");
    const result = update(form, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 13 });
    expect(result.effects[0]).toMatchObject({ type: "dispatch_command", request: {
      kind: "taskcomposer.submit",
      params: { task: "Now add an FAQ", source: "tui", parent_campaign_id: "campaign-1", evidence_ids: ["artifact-1"], auto_confirm: true },
    } });
    expect(JSON.stringify(result.effects)).not.toContain('"taskcomposer.followup"');
    expect(JSON.stringify(result.effects)).not.toContain("session-1");
    expect(JSON.stringify(result.effects)).not.toContain("fixture/model");
  });

  it("refuses a follow-up without an admitted campaign or an answer without a projected question", () => {
    const withoutCampaign: AppModel = { ...selectedDraft(), selection: new Map<ScreenId, ScreenSelection>([["task-composer", { id: "draft-1", context: { expected_revision: "3" } }]]) };
    expect(open(withoutCampaign, "taskcomposer.followup").overlay).toBeNull();
    expect(open(withoutCampaign, "taskcomposer.answer").overlay).toBeNull();
  });
});
