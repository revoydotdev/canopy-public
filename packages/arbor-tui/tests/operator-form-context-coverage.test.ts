import { describe, expect, it } from "vitest";
import { initialModel, update, type AppModel, type OperatorFormKind, type ScreenId } from "../src/index.js";
import type { ScreenSelection } from "../src/operator-selection.js";

function withState(
  screen: ScreenId,
  selection: readonly [ScreenId, ScreenSelection][],
  screens: readonly [ScreenId, unknown][] = [],
): AppModel {
  return { ...initialModel(), screen, selection: new Map(selection), screens: new Map(screens) };
}

function open(model: AppModel, command: OperatorFormKind): AppModel {
  return update(model, { type: "ui_intent", intent: { type: "open_operator_form", command }, at: 10 }).model;
}

function fields(model: AppModel): Readonly<Record<string, string>> {
  expect(model.overlay?.kind).toBe("operator_form");
  if (model.overlay?.kind !== "operator_form") throw new Error("operator form did not open");
  expect(model.overlay.title.length).toBeGreaterThan(0);
  expect(model.overlay.active_field).toBe(Object.keys(model.overlay.fields)[0]);
  return model.overlay.fields;
}

describe("context-bound operator form catalog", () => {
  it("opens every context-free form with a nonempty field schema and stable title", () => {
    const commands: readonly OperatorFormKind[] = [
      "campaign.halt", "job.submit", "approval.request", "userinput.ask", "communication.record",
      "output.capture", "output.raw", "bus.record", "peer.grant", "compaction.record", "a2a.send",
      "a2a.receive", "context.artifact.capture", "fold.propose", "fold.approve", "playbook.propose",
      "playbook.approve", "harness.propose", "harness.approve", "harness.rollback", "harness.evaluate",
      "migration.apply", "migration.rollback", "integration.install", "integration.enable",
      "integration.disable", "integration.update", "session.identity.mutate", "notification.read",
      "followup.create", "taskcomposer.submit", "trust.enroll", "trust.rotate", "trust.revoke",
    ];
    for (const command of commands) {
      expect(Object.keys(fields(open(initialModel(), command))).length).toBeGreaterThan(0);
    }
  });

  it("prefills tree, output, overlay, and trust identities without fabricating absent context", () => {
    const model = withState("overlays", [
      ["tree", { id: "node-1", context: { campaign_id: "campaign-1" } }],
      ["output", { id: "evidence-1" }],
      ["overlays", { id: "revision-1", context: { campaign_id: "campaign-1", overlay_type: "fold" } }],
      ["trust", { id: "remote-1" }],
    ]);
    expect(fields(open(model, "job.submit"))).toMatchObject({ owner_scope_id: "campaign-1" });
    expect(fields(open(model, "userinput.ask"))).toMatchObject({ campaign_id: "campaign-1", node_id: "node-1" });
    expect(fields(open(model, "output.raw"))).toMatchObject({ evidence_id: "evidence-1" });
    expect(fields(open(model, "fold.approve"))).toMatchObject({ fold_id: "revision-1" });
    expect(fields(open(model, "harness.approve"))).toMatchObject({ revision_id: "revision-1" });
    expect(fields(open(model, "harness.rollback"))).toMatchObject({ revision_id: "revision-1" });
    expect(fields(open(model, "harness.evaluate"))).toMatchObject({ revision_id: "revision-1" });
    expect(fields(open(model, "trust.rotate"))).toMatchObject({ session_id: "remote-1" });
    expect(fields(open(model, "trust.revoke"))).toMatchObject({ session_id: "remote-1" });
  });

  it("admits fold rollback and subagent execution only from typed overlay rows", () => {
    const fold = withState("overlays", [["overlays", { id: "fold-1", context: { campaign_id: "campaign-1", overlay_type: "fold" } }]]);
    expect(fields(open(fold, "fold.rollback"))).toEqual({ overlay_id: "fold-1", overlay_type: "fold" });

    const harness = withState("overlays", [
      ["overlays", { id: "revision-1", context: { campaign_id: "campaign-1", overlay_type: "harness", component: "subagent_descriptor" } }],
      ["tree", { id: "node-1", context: { campaign_id: "campaign-1" } }],
    ]);
    expect(fields(open(harness, "subagent.execute"))).toEqual({ campaign_id: "campaign-1", parent_node_id: "node-1", revision_id: "revision-1" });

    expect(open(initialModel(), "fold.rollback").overlay).toBeNull();
    expect(open(withState("overlays", [["overlays", { id: "revision-1", context: { overlay_type: "fold" } }]]), "subagent.execute").overlay).toBeNull();
  });

  it("binds evaluation actions to measured projection facts", () => {
    const candidate = withState("harness-evaluations", [["harness-evaluations", {
      id: "run-1",
      context: { revision_id: "revision-1", state: "measured", outcome: "improved", regression_detected: "false", evidence_ids_json: "[\"evidence-1\"]" },
    }]]);
    expect(fields(open(candidate, "harness.promote"))).toEqual({ revision_id: "revision-1" });
    expect(fields(open(candidate, "harness.quarantine"))).toEqual({ revision_id: "revision-1", reason: "", evidence_ids_json: "[\"evidence-1\"]" });

    const revision = withState("overlays", [["overlays", {
      id: "revision-1",
      context: { overlay_type: "harness", status: "active", evaluation_outcome: "not_yet_measured" },
    }]]);
    expect(fields(open(revision, "harness.evaluation.start"))).toEqual({ revision_id: "revision-1" });

    expect(open(withState("harness-evaluations", [["harness-evaluations", { id: "run-1", context: { revision_id: "revision-1", state: "pending", outcome: "improved", regression_detected: "false" } }]]), "harness.promote").overlay).toBeNull();
    expect(open(withState("overlays", [["overlays", { id: "revision-1", context: { overlay_type: "harness", status: "inactive", evaluation_outcome: "not_yet_measured" } }]]), "harness.evaluation.start").overlay).toBeNull();
  });

  it("binds steering and continuations to the selected authoritative session projection", () => {
    const live = withState(
      "harness-sessions",
      [["harness-sessions", { id: "session-1" }]],
      [["harness-sessions", { live: true, session: { session_id: "session-1", terminal: null } }]],
    );
    expect(fields(open(live, "harness.session.steer"))).toEqual({ session_id: "session-1", message: "" });

    for (const command of ["harness.session.resume", "harness.session.fork", "harness.session.respawn"] as const) {
      const operation = command.slice("harness.session.".length);
      const model = withState(
        "harness-sessions",
        [["harness-sessions", { id: "session-1" }]],
        [["harness-sessions", { session_id: "session-1", continuations: { [operation]: { available: true } } }]],
      );
      expect(fields(open(model, command))).toEqual({ session_id: "session-1", disposition: "", confirmation: "" });
    }

    expect(open(withState("harness-sessions", [["harness-sessions", { id: "session-1" }]], [["harness-sessions", { live: false, session: { session_id: "session-1", terminal: null } }]]), "harness.session.steer").overlay).toBeNull();
    expect(open(withState("harness-sessions", [["harness-sessions", { id: "session-1" }]], [["harness-sessions", { session_id: "session-1", resume_availability: false }]]), "harness.session.resume").overlay).toBeNull();
  });

  it("binds result-review forms to the exact selected file and patch revision", () => {
    const selected: ScreenSelection = { id: "src/main.ts", context: {
      campaign_id: "campaign-1", node_id: "node-1", expected_patch_sha256: `sha256:${"a".repeat(64)}`, expected_revision: "7",
    } };
    const model = withState("result-review", [["result-review", selected]]);
    expect(fields(open(model, "result.review.comment"))).toMatchObject({ campaign_id: "campaign-1", node_id: "node-1", file_path: "src/main.ts", expected_revision: "7", line: "1", side: "new" });
    expect(fields(open(model, "result.review.request_revision"))).toMatchObject({ campaign_id: "campaign-1", node_id: "node-1", expected_revision: "7" });
    expect(fields(open(model, "result.review.editor_handoff"))).toMatchObject({ file_path: "src/main.ts", editor: "vscode" });
    expect(open(initialModel(), "result.review.comment").overlay).toBeNull();
  });

  it("binds task follow-up, answer, and rejection to one selected draft revision", () => {
    const selection: ScreenSelection = { id: "draft-1", context: {
      expected_revision: "3", campaign_id: "campaign-1", question_id: "question-1", evidence_ids_json: "[\"evidence-1\"]",
    } };
    const projection = { items: [{ id: "draft-1", proposal: { questions: [{ id: "question-1", question: "Which target?" }] } }] };
    const model = withState("task-composer", [["task-composer", selection]], [["task-composer", projection]]);
    expect(fields(open(model, "taskcomposer.followup"))).toEqual({ task: "", evidence_ids_json: "[\"evidence-1\"]" });
    const answer = open(model, "taskcomposer.answer");
    expect(fields(answer)).toEqual({ answer: "" });
    expect(answer.overlay).toMatchObject({ detail: "Which target?" });
    expect(fields(open(model, "taskcomposer.reject"))).toEqual({ reason: "" });

    expect(open(initialModel(), "taskcomposer.followup").overlay).toBeNull();
    expect(open(withState("task-composer", [["task-composer", { id: "draft-1", context: { expected_revision: "3" } }]]), "taskcomposer.answer").overlay).toBeNull();
  });
});
