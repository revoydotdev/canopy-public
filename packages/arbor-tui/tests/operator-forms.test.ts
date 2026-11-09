import { describe, expect, it } from "vitest";
import { initialModel } from "../src/model.js";
import { update } from "../src/update.js";
import type { AppModel, OperatorFormKind } from "../src/types.js";
import type { ScreenSelection } from "../src/operator-selection.js";
import type { ScreenId } from "../src/screens/screen.js";

function fill(model: AppModel, values: Readonly<Record<string, string>>, at = 1): AppModel {
  let current = model;
  for (const [field, value] of Object.entries(values)) {
    const form = current.overlay;
    if (form?.kind !== "operator_form") throw new Error("expected operator form");
    const index = Object.keys(form.fields).indexOf(field);
    while (current.overlay?.kind === "operator_form" && current.overlay.active_field !== field) {
      current = update(current, { type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at }).model;
    }
    current = update(current, { type: "ui_intent", intent: { type: "operator_form_input", value }, at }).model;
    expect(index).toBeGreaterThanOrEqual(0);
  }
  return current;
}

function opened(command: OperatorFormKind): AppModel {
  return update(initialModel(), { type: "ui_intent", intent: { type: "open_operator_form", command }, at: 1 }).model;
}

function openedThread(): AppModel {
  const base = initialModel();
  const model: AppModel = {
    ...base,
    screen: "threads",
    selection: new Map<ScreenId, ScreenSelection>([["tree", { id: "child", context: { campaign_id: "campaign", parent_node_id: "root" } }]]),
    screens: new Map([["threads", { parent_node_id: "root", child_node_id: "child", version: "message-1", messages: [] }]]),
  };
  return update(model, { type: "ui_intent", intent: { type: "open_operator_form", command: "bus.thread.send" }, at: 1 }).model;
}

function openedThreadAck(): AppModel {
  const base = initialModel();
  const model: AppModel = {
    ...base,
    screen: "threads",
    selection: new Map<ScreenId, ScreenSelection>([
      ["tree", { id: "child", context: { campaign_id: "campaign", parent_node_id: "root" } }],
      ["threads", { id: "message-1", context: { parent_node_id: "root", child_node_id: "child", expected_thread_version: "message-1", author_node_id: "child", ack_required: "true" } }],
    ]),
    screens: new Map([["threads", { parent_node_id: "root", child_node_id: "child", version: "message-1", messages: [] }]]),
  };
  return update(model, { type: "ui_intent", intent: { type: "open_operator_form", command: "bus.thread.ack" }, at: 1 }).model;
}

describe("typed operator command forms", () => {
  it("blocks incomplete forms rather than inventing a command value", () => {
    const result = update(opened("job.submit"), { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 2 });
    expect(result.effects).toEqual([]);
    expect(result.model.overlay).toMatchObject({ kind: "operator_form", error: "Required: job_kind, owner_scope_id" });
  });

  it("requires a durable halt approval id and a destructive confirmation", () => {
    const form = fill(opened("campaign.halt"), {
      campaign_id: "campaign-1", approval_id: "halt-approval-1",
    });
    const armed = update(form, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 10 });
    expect(armed.effects).toEqual([]);
    expect(armed.model.overlay).toMatchObject({
      kind: "confirm", pendingAction: { kind: "campaign.halt", params: {
        campaign_id: "campaign-1", reason: "manual", approval_id: "halt-approval-1",
      } },
    });
    const confirmed = update(armed.model, { type: "ui_intent", intent: { type: "confirm_pending_action" }, at: 11 });
    expect(confirmed.effects[0]).toMatchObject({ type: "dispatch_command", request: { kind: "campaign.halt" } });
  });

  it("projects each supported command from entered fields through dispatch_command", () => {
    const cases: readonly [OperatorFormKind, Readonly<Record<string, string>>, string][] = [
      ["job.submit", { job_kind: "test-job", owner_scope_id: "scope-1" }, "job.submit"],
      ["approval.request", { action: "deploy", subject: "release", resource_id: "res-1", rationale: "review", expires_at: "2030-01-01T00:00:00.000Z" }, "approval.request"],
      ["userinput.ask", { campaign_id: "c1", node_id: "n1", question: "Proceed?", options_json: "[\"yes\",\"no\"]", authority: "operator", blocking: "true", requester_role: "crown" }, "userinput.ask"],
      ["communication.record", { campaign_id: "c1", node_id: "n1", author_node_id: "n1", recipient_node_id: "n2", kind: "status", capability_tier: "standard", content: "ready", provenance_json: "{\"tag\":\"!claimed\"}", trigger_turn: "false" }, "communication.record"],
      ["output.capture", { campaign_id: "c1", node_id: "n1", stream: "stdout", media_type: "text/plain", provenance_json: "{\"tag\":\"!generated\"}", content: "result" }, "output.capture"],
      ["context.artifact.capture", { campaign_id: "c1", media_type: "text/plain", producer: "tui-operator", visibility: "campaign", provenance_json: "{\"tag\":\"claimed\",\"claimant\":\"operator\"}", content: "reviewable context" }, "context.artifact.capture"],
      ["bus.record", { campaign_id: "c1", node_id: "n1", conversation_id: "conv-1", author_node_id: "n1", recipient_node_id: "n2", kind: "report", capability_tier: "orchestrator", content: "status", provenance_json: "{\"tag\":\"claimed\"}", trigger_turn: "false" }, "bus.record"],
      ["peer.grant", { grant_id: "grant-1", campaign_id: "c1", parent_node_id: "root", left_node_id: "left", right_node_id: "right", capabilities_json: "[\"query\",\"reply\"]", capability_tier: "specialist", max_disclosure_bytes: "1024", expires_at: "2030-01-01T00:00:00.000Z", provenance_json: "{\"tag\":\"claimed\",\"claimant\":\"operator\"}" }, "peer.grant"],
      ["compaction.record", { campaign_id: "c1", node_id: "n1", operation_id: "op-1", trigger: "manual", strategy: "structural_folding", status: "completed", pre_evidence_id: "ev-pre", partial_evidence_ids_json: "[]", reason: "operator requested" }, "compaction.record"],
      ["a2a.send", { campaign_id: "c1", node_id: "n1", author_node_id: "n1", recipient_node_id: "n2", kind: "report", capability_tier: "orchestrator", content: "status", provenance_json: "{\"tag\":\"claimed\"}", trigger_turn: "false" }, "a2a.send"],
      ["a2a.receive", { campaign_id: "c1", node_id: "n1", message_id: "msg-1", task_id: "task-1", author_node_ref: "peer-node", recipient_node_refs_json: "[\"n1\"]", parts_json: "[{\"kind\":\"text\",\"text\":\"hi\"}]" }, "a2a.receive"],
      ["fold.propose", { proposal_json: "{\"id\":\"fold-1\"}" }, "fold.propose"],
      ["fold.approve", { fold_id: "fold-1", fidelity_ratio: "0.99" }, "fold.approve"],
      ["playbook.propose", { delta_json: "{\"id\":\"delta-1\"}" }, "playbook.propose"],
      ["playbook.approve", { delta_id: "delta-1" }, "playbook.approve"],
      ["harness.propose", { revision_json: "{\"id\":\"revision-1\"}" }, "harness.propose"],
      ["harness.approve", { revision_id: "revision-1" }, "harness.approve"],
      ["harness.rollback", { revision_id: "revision-1" }, "harness.rollback"],
      ["harness.evaluate", { revision_id: "revision-1", evaluation_json: "{\"outcome\":\"pass\"}" }, "harness.evaluate"],
      ["trust.enroll", { registration_json: "{\"session_id\":\"remote-1\"}" }, "trust.session.enroll"],
      ["trust.rotate", { session_id: "remote-1", key_id: "key-2", public_key_pem: "-----BEGIN PUBLIC KEY-----\\nkey\\n-----END PUBLIC KEY-----", certificate_id: "certificate-2" }, "trust.session.rotate"],
      ["trust.revoke", { session_id: "remote-1" }, "trust.session.revoke"],
    ];
    for (const [command, values, kind] of cases) {
      const result = update(fill(opened(command), values), { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 20 });
      expect(result.effects).toHaveLength(1);
      expect(result.effects[0]).toMatchObject({ type: "dispatch_command", request: { kind } });
      expect(result.model.overlay).toBeNull();
    }
  });

  it("keeps structured fields typed: malformed JSON never reaches the runtime", () => {
    const invalid = fill(opened("userinput.ask"), {
      campaign_id: "c1", node_id: "n1", question: "Proceed?", options_json: "not-json", authority: "operator", blocking: "true", requester_role: "crown",
    });
    const result = update(invalid, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 3 });
    expect(result.effects).toEqual([]);
    expect(result.model.overlay).toMatchObject({ kind: "operator_form", error: "options_json must be a JSON array" });
  });

  it("rejects malformed governed-context JSON and out-of-range fidelity before dispatch", () => {
    const malformed = fill(opened("fold.propose"), { proposal_json: "[]" });
    expect(update(malformed, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 3 }).model.overlay).toMatchObject({ error: "proposal_json must be a JSON object" });
    const ratio = fill(opened("fold.approve"), { fold_id: "fold-1", fidelity_ratio: "1.1" });
    expect(update(ratio, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 3 }).model.overlay).toMatchObject({ error: "fidelity_ratio must be a number from 0 through 1" });
  });

  it("bounds peer grants and context provenance before canonical dispatch", () => {
    const peer = fill(opened("peer.grant"), { grant_id: "g", campaign_id: "c", parent_node_id: "p", left_node_id: "left", right_node_id: "right", capabilities_json: "[]", capability_tier: "specialist", max_disclosure_bytes: "1024", expires_at: "2030-01-01T00:00:00.000Z", provenance_json: "{}" });
    expect(update(peer, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 4 }).model.overlay).toMatchObject({ error: "capabilities_json must be a non-empty query/reply JSON array" });
    const context = fill(opened("context.artifact.capture"), { campaign_id: "c", media_type: "text/plain", producer: "operator", visibility: "invalid", provenance_json: "{}", content: "x" });
    expect(update(context, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 4 }).model.overlay).toMatchObject({ error: "visibility must be campaign or critic_only" });
  });

  it("preserves complete context and peer authority envelopes through RuntimePort dispatch", () => {
    const context = fill(opened("context.artifact.capture"), { campaign_id: "c", media_type: "text/plain", producer: "operator", visibility: "critic_only", provenance_json: '{"tag":"claimed","claimant":"operator"}', content: "bounded evidence" });
    expect(update(context, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 5 }).effects[0]).toMatchObject({ type: "dispatch_command", request: { kind: "context.artifact.capture", params: { artifact: { campaign_id: "c", visibility: "critic_only", provenance: { tag: "claimed", claimant: "operator" } }, content: "bounded evidence" } } });
    const peer = fill(opened("peer.grant"), { grant_id: "grant", campaign_id: "c", parent_node_id: "parent", left_node_id: "left", right_node_id: "right", capabilities_json: '["query","reply"]', capability_tier: "auditor", max_disclosure_bytes: "2048", expires_at: "2030-01-01T00:00:00.000Z", provenance_json: '{"tag":"claimed","claimant":"operator"}' });
    expect(update(peer, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 5 }).effects[0]).toMatchObject({ type: "dispatch_command", request: { kind: "peer.grant", params: { grant_id: "grant", campaign_id: "c", parent_node_id: "parent", left_node_id: "left", right_node_id: "right", capabilities: ["query", "reply"], capability_tier: "auditor", max_disclosure_bytes: 2048 } } });
  });

  it("opens a selected remote trust session through the canonical status query", () => {
    const model: AppModel = { ...initialModel(), screen: "trust", selection: new Map([["trust", { id: "remote-1" }]]) };
    expect(update(model, { type: "ui_intent", intent: { type: "view_selected_row_detail" }, at: 9 }).effects).toEqual([{ type: "run_query", request: { kind: "trust.session.status", query_id: "tui:detail:trust:9", params: { session_id: "remote-1" } } }]);
  });

  it("routes raw-output review through a selected evidence id and a durable approval id", () => {
    const result = update(fill(opened("output.raw"), { evidence_id: "out_deadbeef", approval_id: "raw-approval-1" }), {
      type: "ui_intent", intent: { type: "submit_operator_form" }, at: 4,
    });
    expect(result.effects).toEqual([{ type: "run_query", request: {
      kind: "output.raw", query_id: "tui:output.raw:4", params: { evidence_id: "out_deadbeef", approval_id: "raw-approval-1" },
    } }]);
  });

  it("sends a parent/child message only from the selected direct edge with the projection CAS cursor", () => {
    const result = update(fill(openedThread(), { content: "Please continue", evidence_refs_json: '["audit://evidence/12"]', acknowledges_communication_id: "message-1" }), {
      type: "ui_intent", intent: { type: "submit_operator_form" }, at: 42,
    });
    expect(result.effects).toEqual([{ type: "dispatch_command", request: {
      kind: "bus.thread.send", metadata: { operation_id: "tui:bus.thread.send:42", idempotency_key: "tui:bus.thread.send:42" },
      params: expect.objectContaining({ campaign_id: "campaign", parent_node_id: "root", child_node_id: "child", from_node_id: "child", expected_thread_version: "message-1", content: "Please continue", evidence_refs: ["audit://evidence/12"], acknowledges_communication_id: "message-1" }),
    } }]);
  });

  it("acknowledges only a selected ack-required message as its exact opposite endpoint", () => {
    const result = update(openedThreadAck(), { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 43 });
    expect(result.effects).toEqual([{ type: "dispatch_command", request: {
      kind: "bus.thread.ack", metadata: { operation_id: "tui:bus.thread.ack:43", idempotency_key: "tui:bus.thread.ack:43" },
      params: expect.objectContaining({ campaign_id: "campaign", parent_node_id: "root", child_node_id: "child", from_node_id: "root", expected_thread_version: "message-1", message_id: "message-1" }),
    } }]);
    expect(opened("bus.thread.ack").overlay).toBeNull();
  });

  it("does not open a thread composer without a selected direct edge and rejects malformed evidence refs", () => {
    expect(opened("bus.thread.send").overlay).toBeNull();
    const malformed = fill(openedThread(), { content: "Please continue", evidence_refs_json: "{}" });
    const result = update(malformed, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 4 });
    expect(result.effects).toEqual([]);
    expect(result.model.overlay).toMatchObject({ kind: "operator_form", error: "evidence_refs_json must be a JSON array of non-empty references" });
  });

  // T1/T2 (live-driven pilot findings 2026-08-14): the reported "cockpit
  // swallows a nav digit into the compose form" and "Escape needs two
  // presses, the draft retains stale text" defects both trace to the raw
  // stdin routing loop in packages/arbor-mcp/src/tui.ts (outside this
  // package's file scope — see that file's `onData` handler, specifically
  // the `harness.model.screen === "cockpit" && harness.model.overlay ===
  // null` branches around its whole-chunk fast path and per-character
  // fallthrough), NOT in this reducer. This pins down the part of the
  // boundary this package *does* own: `cancel_operator_form` must clear the
  // overlay (and therefore every field) in exactly one dispatch, and a fresh
  // `open_operator_form` for the same command must never see the prior
  // instance's typed text — so if the routing-loop fix lands upstream, no
  // reducer-side "stale draft" bug is waiting to surprise it.
  it("cancel_operator_form clears the overlay (and every field) in one dispatch, independent of any routing bug upstream", () => {
    const typed = fill(opened("taskcomposer.submit"), { task: "3" });
    expect(typed.overlay).toMatchObject({ kind: "operator_form", fields: { task: "3" } });
    const cancelled = update(typed, { type: "ui_intent", intent: { type: "cancel_operator_form" }, at: 2 }).model;
    expect(cancelled.overlay).toBeNull();
  });

  it("reopening the same command after a cancel starts with fresh, empty fields — never the prior instance's text", () => {
    const typed = fill(opened("taskcomposer.submit"), { task: "3" });
    const cancelled = update(typed, { type: "ui_intent", intent: { type: "cancel_operator_form" }, at: 2 }).model;
    const reopened = update(cancelled, { type: "ui_intent", intent: { type: "open_operator_form", command: "taskcomposer.submit" }, at: 3 }).model;
    expect(reopened.overlay).toMatchObject({ kind: "operator_form", fields: { task: "" } });
  });
});

describe("every operator form is named for the operator, not by its command id (EC-035)", () => {
  // 42 of 49 forms rendered their raw identifier as the heading — an operator
  // opening the job form read "job.submit", and the trust form said
  // "trust.enroll". Both exemplars label every surface (OpenCode's per-command
  // `title`, Claude Code's `displayName`/`userFacingName()`).
  const SAMPLE: readonly OperatorFormKind[] = [
    "job.submit", "approval.request", "userinput.ask", "trust.enroll", "trust.rotate",
    "trust.revoke", "compaction.record", "context.artifact.capture", "integration.install",
    "integration.disable", "migration.apply", "migration.rollback", "campaign.halt",
    "bus.record", "peer.grant", "followup.create", "notification.read",
    "session.identity.mutate", "output.capture", "output.raw", "a2a.send", "a2a.receive",
  ];

  it("never shows a raw command identifier as a form title", () => {
    for (const command of SAMPLE) {
      const overlay = opened(command).overlay;
      if (overlay?.kind !== "operator_form") continue; // context-gated forms refuse to open
      expect(overlay.title, `${command} title`).not.toBe(command);
      expect(overlay.title).not.toMatch(/^[a-z]+(\.[a-z_]+)+$/u);
      expect(overlay.title.length).toBeGreaterThan(3);
    }
  });

  it("names a few specific forms the way an operator would read them", () => {
    expect((opened("job.submit").overlay as { title: string }).title).toBe("Submit job");
    expect((opened("trust.enroll").overlay as { title: string }).title).toBe("Enroll remote trust");
    expect((opened("output.raw").overlay as { title: string }).title).toBe("Disclose raw output");
  });
});
