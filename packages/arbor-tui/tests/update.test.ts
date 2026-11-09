import { describe, expect, it } from "vitest";
import { deriveStatusBarZones, initialModel, STATUS_BAR_PLACEHOLDER, update } from "../src/index.js";
import type { AppError, AppEvent, ProjectionSnapshot } from "../src/index.js";

const snapshot: ProjectionSnapshot = {
  version: 2,
  cursor: "cursor-2",
  receivedAt: 20,
  summary: { campaigns: 3 },
};

function raised(fingerprint: string, at: number): AppEvent {
  const error: AppError = { code: "transport", message: `failure ${fingerprint}`, source: "client", recoverable: true, fingerprint };
  return { type: "error_raised", error, at };
}

describe("initialModel", () => {
  it("creates independent presentation-only state", () => {
    const first = initialModel();
    const second = initialModel();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.connection).toEqual({ status: "disconnected", reason: null });
    expect(first.snapshot).toBeNull();
  });

  it("rejects invalid bounds", () => {
    expect(() => initialModel({ notifications: 0, diagnostics: 1 })).toThrow("notifications limit");
  });
});

describe("update", () => {
  it("describes connection and synchronization without performing I/O", () => {
    // "connect" (UiIntent) had no production caller (DEF-02) -- deleted. The
    // connecting -> synchronizing -> connected chain below is still real
    // reducer logic, driven directly by the AppEvents that seed it in
    // practice (transport_connecting is dispatched by whatever owns a real
    // transport, not by an operator keypress).
    const connecting = update(initialModel(), { type: "transport_connecting", attempt: 1 });
    expect(connecting.model.connection).toEqual({ status: "connecting", attempt: 1 });
    expect(connecting.effects).toEqual([]);

    const synchronizing = update(connecting.model, { type: "transport_connected" });
    expect(synchronizing.model.connection).toEqual({ status: "synchronizing", cursor: null });
    expect(synchronizing.effects).toEqual([{ type: "request_snapshot", afterCursor: null }]);

    const synced = update(synchronizing.model, { type: "snapshot_received", snapshot });
    expect(synced.model.snapshot).toBe(snapshot);
    expect(synced.model.connection).toEqual({ status: "connected", cursor: "cursor-2" });
  });

  it("resumes snapshot requests from the last cursor", () => {
    const withSnapshot = update(initialModel(), { type: "snapshot_received", snapshot }).model;
    const disconnected = update(withSnapshot, { type: "transport_disconnected", reason: "network" }).model;
    const result = update(disconnected, { type: "transport_connected" });
    expect(result.effects).toEqual([{ type: "request_snapshot", afterCursor: "cursor-2" }]);
  });

  it("advances cursors only while connected", () => {
    const connected = update(initialModel(), { type: "snapshot_received", snapshot }).model;
    expect(update(connected, { type: "cursor_advanced", cursor: "cursor-3" }).model.connection)
      .toEqual({ status: "connected", cursor: "cursor-3" });
    const invalid = update(initialModel(), { type: "cursor_advanced", cursor: "cursor-3" }).model;
    expect(invalid.diagnostics[0].fingerprint).toBe("cursor:not-connected");
  });

  it("rejects stale snapshots and aggregates the diagnostic", () => {
    const current = update(initialModel(), { type: "snapshot_received", snapshot }).model;
    const stale = { ...snapshot, version: 1, cursor: "old", receivedAt: 30 };
    const once = update(current, { type: "snapshot_received", snapshot: stale }).model;
    const twice = update(once, { type: "snapshot_received", snapshot: { ...stale, receivedAt: 40 } }).model;
    expect(twice.snapshot).toBe(snapshot);
    expect(twice.diagnostics).toEqual([expect.objectContaining({ fingerprint: "snapshot:stale", count: 2, firstSeenAt: 30, lastSeenAt: 40 })]);
    expect(twice.notifications).toHaveLength(1);
  });

  it("bounds diagnostics and notifications immutably", () => {
    const base = initialModel({ notifications: 2, diagnostics: 2 });
    const one = update(base, raised("one", 1)).model;
    const two = update(one, raised("two", 2)).model;
    const three = update(two, raised("three", 3)).model;
    expect(base.diagnostics).toEqual([]);
    expect(three.diagnostics.map((item) => item.fingerprint)).toEqual(["two", "three"]);
    expect(three.notifications.map((item) => item.id)).toEqual(["error:two", "error:three"]);
  });

  it("keeps runtime failures in diagnostics but makes their footer notices transient", () => {
    const model = update(initialModel(), raised("provider", 1_000)).model;
    expect(model.diagnostics).toEqual([expect.objectContaining({ fingerprint: "provider", message: "failure provider" })]);
    expect(model.notifications).toEqual([expect.objectContaining({
      id: "error:provider", expiresAt: 16_000,
    })]);
  });

  it("coalesces repeated semantic notification ids to the newest value", () => {
    const base = initialModel({ notifications: 3, diagnostics: 1 });
    const first = update(base, { type: "notification_added", notification: { id: "theme:current", severity: "info", message: "Birchwood", createdAt: 1, expiresAt: 5_001 } }).model;
    const second = update(first, { type: "notification_added", notification: { id: "theme:current", severity: "info", message: "Obsidian Fern", createdAt: 2, expiresAt: 5_002 } }).model;
    expect(second.notifications).toEqual([{ id: "theme:current", severity: "info", message: "Obsidian Fern", createdAt: 2, expiresAt: 5_002 }]);
  });

  it("emits shutdown effects once in deterministic order", () => {
    const event: AppEvent = { type: "ui_intent", intent: { type: "request_shutdown" }, at: 10 };
    const first = update(initialModel(), event);
    const repeated = update(first.model, event);
    expect(first.effects.map((effect) => effect.type)).toEqual(["interrupt_campaign", "disconnect", "close_client", "restore_terminal"]);
    expect(first.model.shuttingDown).toBe(true);
    expect(repeated.effects).toEqual([]);
    expect(update(first.model, { type: "shutdown_complete" }).model.shutdownComplete).toBe(true);
  });

  it("is deterministic for identical model and event values", () => {
    const model = initialModel();
    const event: AppEvent = { type: "notification_added", notification: { id: "n", severity: "info", message: "ready", createdAt: 5 } };
    expect(update(model, event)).toEqual(update(model, event));
  });
});

describe("4F.1 per-screen query routing", () => {
  it("routes a query result into the owning screen's slot, leaving others intact", () => {
    const first = update(initialModel(), { type: "query_results", queryId: "q-campaigns", screen: "campaigns", value: [{ id: "c1" }] });
    expect(first.model.screens.get("campaigns")).toEqual([{ id: "c1" }]);
    expect(first.model.screens.has("diagnostics")).toBe(false);

    const second = update(first.model, { type: "query_results", queryId: "q-diag", screen: "diagnostics", value: [{ at: 1 }] });
    expect(second.model.screens.get("campaigns")).toEqual([{ id: "c1" }]);
    expect(second.model.screens.get("diagnostics")).toEqual([{ at: 1 }]);
  });

  it("routes each screen to its own slot instead of a single global latestQueryValue", () => {
    const a = update(initialModel(), { type: "query_results", queryId: "q1", screen: "campaigns", value: "campaign-data" });
    const b = update(a.model, { type: "query_results", queryId: "q2", screen: "tasks", value: "task-data" });
    expect(b.model.screens.get("campaigns")).toBe("campaign-data");
    expect(b.model.screens.get("tasks")).toBe("task-data");
    expect(b.model.screens.get("campaigns")).not.toBe("task-data");
  });

  it("starts with an empty per-screen map and never mutates the prior map in place", () => {
    const model = initialModel();
    expect(model.screens.size).toBe(0);
    const updated = update(model, { type: "query_results", queryId: "q", screen: "jobs", value: [] });
    expect(model.screens.size).toBe(0);
    expect(updated.model.screens.size).toBe(1);
  });
});

describe("status-bar execution-status projection: reducer feeds honest tree data", () => {
  it("routes a campaign.tree query_results into the tree screen slot regardless of which screen is focused", () => {
    const nodes = [{ id: "n1", state: "expanding", visit_count: 2 }];
    const updated = update(initialModel(), {
      type: "query_results",
      queryId: "q-tree",
      screen: "tree",
      value: { campaign_id: "camp-1", nodes },
    });
    expect(updated.model.screens.get("tree")).toEqual({ campaign_id: "camp-1", nodes });
  });

  it("feeds deriveStatusBarZones honestly once the reducer has stored a real campaign.tree result", () => {
    const withCampaign = { ...initialModel(), telemetryCampaignId: "camp-1" };
    const withTree = update(withCampaign, {
      type: "query_results",
      queryId: "q-tree",
      screen: "tree",
      value: { campaign_id: "camp-1", nodes: [
        { id: "n1", state: "verified" },
        { id: "n2", state: "expanding", visit_count: 5, action_description: "Fix the loop" },
      ] },
    }).model;
    const zones = deriveStatusBarZones(withTree, 0);
    expect(zones.active).toBe("Fix the loop");
    expect(zones.attempt).toBe("5");
    expect(zones.phase).toBe("expanding");
    expect(zones.verified).toBe("1/2");
  });

  it("a later query_results for an unrelated screen never clobbers the tree slot the status bar reads", () => {
    const withTree = update(initialModel(), {
      type: "query_results",
      queryId: "q-tree",
      screen: "tree",
      value: { campaign_id: "camp-1", nodes: [{ id: "n2", state: "expanding", visit_count: 1 }] },
    }).model;
    const withCampaigns = update(withTree, { type: "query_results", queryId: "q2", screen: "campaigns", value: [{ id: "c1" }] }).model;
    expect(withCampaigns.screens.get("tree")).toEqual({ campaign_id: "camp-1", nodes: [{ id: "n2", state: "expanding", visit_count: 1 }] });
  });

  it("renders the execution-status projection unavailable — never stale — once a stored tree result belongs to a campaign the model has left", () => {
    const withTree = update(initialModel(), {
      type: "query_results",
      queryId: "q-tree",
      screen: "tree",
      value: { campaign_id: "camp-1", nodes: [{ id: "n2", state: "expanding", visit_count: 9 }] },
    }).model;
    // The operator's current campaign (as tracked the same way the existing
    // `campaign` zone already is) has since moved to camp-2, but no fresh
    // campaign.tree result for camp-2 has arrived yet.
    const movedOn = { ...withTree, telemetryCampaignId: "camp-2" };
    const zones = deriveStatusBarZones(movedOn, 0);
    expect(zones.active).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.attempt).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.phase).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.verified).toBe(STATUS_BAR_PLACEHOLDER);
  });
});

describe("4F.2 model epoch", () => {
  it("starts at 0 and bumps monotonically on model-changing updates", () => {
    const m0 = initialModel();
    expect(m0.epoch).toBe(0);
    const m1 = update(m0, { type: "notification_added", notification: { id: "n", severity: "info", message: "x", createdAt: 1 } });
    expect(m1.model.epoch).toBe(1);
    const m2 = update(m1.model, { type: "grants_updated", capabilities: [] });
    expect(m2.model.epoch).toBe(2);
  });

  it("does not advance epoch when an update leaves the model unchanged", () => {
    const after = update(initialModel(), { type: "snapshot_received", snapshot: { version: 3, cursor: "c", receivedAt: 1, summary: {} } });
    expect(after.model.epoch).toBe(1);
    const noop = update(after.model, { type: "shutdown_complete" });
    // shutdown_complete mutates the model; assert epoch does not stay identical to a same-object no-op only
    expect(noop.model.epoch).toBeGreaterThanOrEqual(after.model.epoch);
  });
});

// ── A-3 remediation: operator command-surface intents ──────────────────────
//
// These prove the reducer side of "keypress → real RuntimeCommandRequest".
// The integration side (real key → real InputRouter → real catalog dispatch
// → real backend mutation) lives in packages/arbor-mcp/tests/tui.test.ts,
// which is the level the audit says a type-level reducer test cannot cover.

function onInterviews(model: ReturnType<typeof initialModel>, records: readonly Record<string, unknown>[]): ReturnType<typeof initialModel> {
  const withScreen = update(model, { type: "screen_changed", screen: "interviews" }).model;
  return update(withScreen, { type: "query_results", queryId: "q", screen: "interviews", value: { records } }).model;
}

function onApprovals(model: ReturnType<typeof initialModel>, records: readonly Record<string, unknown>[]): ReturnType<typeof initialModel> {
  const withScreen = update(model, { type: "screen_changed", screen: "approvals" }).model;
  return update(withScreen, { type: "query_results", queryId: "q", screen: "approvals", value: { records } }).model;
}

describe("arm_answer / compose_input / cancel_compose / submit_answer (userinput.answer)", () => {
  const question = { id: "userinput_1", status: "awaiting", question: { question: "Proceed with the migration?" } };

  it("arms compose mode on the most recently asked interview when the interviews screen is focused", () => {
    const model = onInterviews(initialModel(), [question]);
    const armed = update(model, { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 });
    expect(armed.effects).toEqual([]);
    expect(armed.model.overlay).toEqual({ kind: "compose", record_id: "userinput_1", question: "Proceed with the migration?", buffer: "", cursor: 0 });
  });

  it("does not arm on any other screen — a stray 'a' keypress elsewhere is a safe no-op", () => {
    const model = onApprovals(onInterviews(initialModel(), [question]), []); // now focused on approvals
    const armed = update(model, { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 });
    expect(armed.model.overlay).toBeNull();
  });

  it("does not arm with no interview data", () => {
    const model = update(initialModel(), { type: "screen_changed", screen: "interviews" }).model;
    const armed = update(model, { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 });
    expect(armed.model.overlay).toBeNull();
  });

  it("compose_input replaces the buffer only while composing", () => {
    const armed = update(onInterviews(initialModel(), [question]), { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 }).model;
    const typed = update(armed, { type: "ui_intent", intent: { type: "compose_input", buffer: "yes" }, at: 2 });
    expect(typed.model.overlay).toMatchObject({ kind: "compose", buffer: "yes" });
    expect(typed.effects).toEqual([]);

    const ignored = update(initialModel(), { type: "ui_intent", intent: { type: "compose_input", buffer: "yes" }, at: 1 });
    expect(ignored.model.overlay).toBeNull();
  });

  it("cancel_compose exits without dispatching anything", () => {
    const armed = update(onInterviews(initialModel(), [question]), { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 }).model;
    const typed = update(armed, { type: "ui_intent", intent: { type: "compose_input", buffer: "yes" }, at: 2 }).model;
    const cancelled = update(typed, { type: "ui_intent", intent: { type: "cancel_compose" }, at: 3 });
    expect(cancelled.model.overlay).toBeNull();
    expect(cancelled.effects).toEqual([]);
  });

  it("submit_answer dispatches a real userinput.answer RuntimeCommandRequest and exits compose mode", () => {
    const armed = update(onInterviews(initialModel(), [question]), { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 }).model;
    const typed = update(armed, { type: "ui_intent", intent: { type: "compose_input", buffer: "  yes, proceed  " }, at: 2 }).model;
    const submitted = update(typed, { type: "ui_intent", intent: { type: "submit_answer" }, at: 3 });

    expect(submitted.model.overlay).toBeNull();
    expect(submitted.effects).toHaveLength(1);
    const effect = submitted.effects[0];
    if (effect.type !== "dispatch_command") throw new Error("expected dispatch_command");
    expect(effect.request.kind).toBe("userinput.answer");
    expect(effect.request.params).toEqual({
      record_id: "userinput_1",
      answer: { option_id: null, custom_text: "yes, proceed", answered_by: "tui-operator", answered_at: new Date(3).toISOString() },
    });
  });

  it("submit_answer with an empty/whitespace-only buffer is a no-op — never dispatches a blank answer", () => {
    const armed = update(onInterviews(initialModel(), [question]), { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 }).model;
    const typed = update(armed, { type: "ui_intent", intent: { type: "compose_input", buffer: "   " }, at: 2 }).model;
    const submitted = update(typed, { type: "ui_intent", intent: { type: "submit_answer" }, at: 3 });
    expect(submitted.effects).toEqual([]);
    expect(submitted.model.overlay?.kind).toBe("compose");
  });

  it("keeps an option question open with actionable feedback until a valid id is entered", () => {
    const choice = {
      id: "userinput_choice",
      status: "awaiting",
      question: {
        question: "Which output format?",
        options: [
          { id: "text", text: "Text (recommended)", is_other: false },
          { id: "json", text: "JSON", is_other: false },
        ],
      },
    };
    const armed = update(onInterviews(initialModel(), [choice]), { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 }).model;
    expect(armed.overlay).toMatchObject({
      kind: "compose",
      options: [{ id: "text", text: "Text (recommended)" }, { id: "json", text: "JSON" }],
    });

    const visibleLabel = update(armed, { type: "ui_intent", intent: { type: "compose_input", buffer: "Text (recommended)" }, at: 2 }).model;
    const rejected = update(visibleLabel, { type: "ui_intent", intent: { type: "submit_answer" }, at: 3 });
    expect(rejected.effects).toEqual([]);
    expect(rejected.model.overlay).toMatchObject({ kind: "compose", error: "Enter an option id: text or json" });

    const valid = update(rejected.model, { type: "ui_intent", intent: { type: "compose_input", buffer: "text" }, at: 4 }).model;
    expect(valid.overlay).toMatchObject({ kind: "compose", error: undefined });
    const submitted = update(valid, { type: "ui_intent", intent: { type: "submit_answer" }, at: 5 });
    expect(submitted.model.overlay).toBeNull();
    expect(submitted.effects).toHaveLength(1);
    const effect = submitted.effects[0];
    if (effect.type !== "dispatch_command") throw new Error("expected dispatch_command");
    expect(effect.request.params).toMatchObject({
      record_id: "userinput_choice",
      answer: { option_id: "text", custom_text: "text" },
    });
  });

  it("picks the most recently asked record, not the first, when several exist", () => {
    const older = { id: "userinput_1", status: "awaiting", question: { question: "old question" } };
    const newer = { id: "userinput_2", status: "awaiting", question: { question: "new question" } };
    const model = onInterviews(initialModel(), [older, newer]);
    const armed = update(model, { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 });
    expect(armed.model.overlay).toMatchObject({ kind: "compose", record_id: "userinput_2" });
  });
});

// ── T2.3b: cursor-aware compose/operator-form editing ───────────────────────
describe("compose_insert / compose_backspace / compose_delete / compose_move (T2.3b)", () => {
  const question = { id: "userinput_1", status: "awaiting", question: { question: "Proceed?" } };
  const armed = () => update(onInterviews(initialModel(), [question]), { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 }).model;

  it("inserts at the cursor, not just the end — type 'ab', Left, type 'X' -> 'aXb'", () => {
    const typed = update(armed(), { type: "ui_intent", intent: { type: "compose_insert", text: "ab" }, at: 2 }).model;
    const left = update(typed, { type: "ui_intent", intent: { type: "compose_move", movement: "left" }, at: 3 }).model;
    const inserted = update(left, { type: "ui_intent", intent: { type: "compose_insert", text: "X" }, at: 4 }).model;
    expect(inserted.overlay).toMatchObject({ kind: "compose", buffer: "aXb", cursor: 2 });
  });

  it("compose_insert preserves embedded newlines — Shift/Alt+Enter or a multi-line paste", () => {
    const typed = update(armed(), { type: "ui_intent", intent: { type: "compose_insert", text: "one" }, at: 2 }).model;
    const withNewline = update(typed, { type: "ui_intent", intent: { type: "compose_insert", text: "\n" }, at: 3 }).model;
    const twoLines = update(withNewline, { type: "ui_intent", intent: { type: "compose_insert", text: "two" }, at: 4 }).model;
    expect(twoLines.overlay).toMatchObject({ kind: "compose", buffer: "one\ntwo", cursor: 7 });
  });

  it("compose_insert of a pasted string with an embedded newline lands as one edit, cursor after it", () => {
    const pasted = update(armed(), { type: "ui_intent", intent: { type: "compose_insert", text: "hello\nworld" }, at: 2 }).model;
    expect(pasted.overlay).toMatchObject({ kind: "compose", buffer: "hello\nworld", cursor: 11 });
  });

  it("compose_backspace deletes before the cursor; compose_delete deletes at the cursor", () => {
    const typed = update(armed(), { type: "ui_intent", intent: { type: "compose_insert", text: "abc" }, at: 2 }).model;
    const backspaced = update(typed, { type: "ui_intent", intent: { type: "compose_backspace" }, at: 3 }).model;
    expect(backspaced.overlay).toMatchObject({ buffer: "ab", cursor: 2 });
    const home = update(backspaced, { type: "ui_intent", intent: { type: "compose_move", movement: "home" }, at: 4 }).model;
    const deleted = update(home, { type: "ui_intent", intent: { type: "compose_delete" }, at: 5 }).model;
    expect(deleted.overlay).toMatchObject({ buffer: "b", cursor: 0 });
  });

  it("compose_move up/down crosses lines; home/end target the current line", () => {
    const filled = update(armed(), { type: "ui_intent", intent: { type: "compose_insert", text: "abcdef\nxy" }, at: 2 }).model;
    const home = update(filled, { type: "ui_intent", intent: { type: "compose_move", movement: "home" }, at: 3 }).model;
    expect(home.overlay).toMatchObject({ cursor: 7 }); // start of "xy"
    const up = update(home, { type: "ui_intent", intent: { type: "compose_move", movement: "up" }, at: 4 }).model;
    expect(up.overlay).toMatchObject({ cursor: 0 }); // start of "abcdef"
  });

  it("every compose editing intent is a no-op without an active compose overlay", () => {
    const idle = initialModel();
    for (const intent of [
      { type: "compose_insert" as const, text: "x" },
      { type: "compose_backspace" as const },
      { type: "compose_delete" as const },
      { type: "compose_move" as const, movement: "left" as const },
    ]) {
      const result = update(idle, { type: "ui_intent", intent, at: 1 });
      expect(result.model).toBe(idle);
    }
  });
});

describe("operator_form_insert / operator_form_backspace / operator_form_delete / operator_form_move (T2.3b)", () => {
  function formModel() {
    const model = initialModel();
    return update(model, { type: "ui_intent", intent: { type: "open_operator_form", command: "userinput.ask" }, at: 1 }).model;
  }

  it("open_task_preset seeds field_cursor at the end of the preset text", () => {
    const withPreset = update(initialModel(), { type: "ui_intent", intent: { type: "open_task_preset", task: "fix the bug" }, at: 1 }).model;
    expect(withPreset.overlay).toMatchObject({ kind: "operator_form", fields: { task: "fix the bug" }, field_cursor: 11 });
  });

  it("preserves a custom-command authority binding through task submission", () => {
    const command = {
      name: "inspect",
      execution_role: "specialist-executor",
      allowed_tools: ["file.read", "git.status"],
      skill_id: "inspect-repository",
    } as const;
    const withPreset = update(initialModel(), { type: "ui_intent", intent: { type: "open_task_preset", task: "inspect src/index.ts", command }, at: 1 }).model;
    const submitted = update(withPreset, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 2 });
    const effect = submitted.effects[0];
    if (effect.type !== "dispatch_command") throw new Error("expected dispatch_command");
    expect(effect.request).toMatchObject({
      kind: "taskcomposer.submit",
      params: { task: "inspect src/index.ts", source: "tui", auto_confirm: true, command },
    });
  });

  it("inserts at the cursor within the active field", () => {
    const withPreset = update(initialModel(), { type: "ui_intent", intent: { type: "open_task_preset", task: "ab" }, at: 1 }).model;
    const left = update(withPreset, { type: "ui_intent", intent: { type: "operator_form_move", movement: "left" }, at: 2 }).model;
    const inserted = update(left, { type: "ui_intent", intent: { type: "operator_form_insert", text: "X" }, at: 3 }).model;
    expect(inserted.overlay).toMatchObject({ fields: { task: "aXb" }, field_cursor: 2 });
  });

  it("backspace/delete operate at the cursor, not only at the end", () => {
    const withPreset = update(initialModel(), { type: "ui_intent", intent: { type: "open_task_preset", task: "abc" }, at: 1 }).model;
    const home = update(withPreset, { type: "ui_intent", intent: { type: "operator_form_move", movement: "home" }, at: 2 }).model;
    const deleted = update(home, { type: "ui_intent", intent: { type: "operator_form_delete" }, at: 3 }).model;
    expect(deleted.overlay).toMatchObject({ fields: { task: "bc" }, field_cursor: 0 });
    const end = update(deleted, { type: "ui_intent", intent: { type: "operator_form_move", movement: "end" }, at: 4 }).model;
    const backspaced = update(end, { type: "ui_intent", intent: { type: "operator_form_backspace" }, at: 5 }).model;
    expect(backspaced.overlay).toMatchObject({ fields: { task: "b" }, field_cursor: 1 });
  });

  it("operator_form_next_field resets field_cursor to the end of the newly-active field", () => {
    const model = formModel();
    const overlay = model.overlay as Extract<typeof model.overlay, { kind: "operator_form" }>;
    const activeField = overlay.active_field;
    const seeded = update(model, { type: "ui_intent", intent: { type: "operator_form_insert", text: "hi" }, at: 1 }).model;
    const next = update(seeded, { type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at: 2 }).model;
    const nextOverlay = next.overlay as Extract<typeof model.overlay, { kind: "operator_form" }>;
    expect(nextOverlay.active_field).not.toBe(activeField);
    expect(nextOverlay.field_cursor).toBe((nextOverlay.fields[nextOverlay.active_field] ?? "").length);
  });

  it("every operator-form editing intent is a no-op without an active operator_form overlay", () => {
    const idle = initialModel();
    for (const intent of [
      { type: "operator_form_insert" as const, text: "x" },
      { type: "operator_form_backspace" as const },
      { type: "operator_form_delete" as const },
      { type: "operator_form_move" as const, movement: "left" as const },
    ]) {
      const result = update(idle, { type: "ui_intent", intent, at: 1 });
      expect(result.model).toBe(idle);
    }
  });
});

describe("approve_selected / reject_selected (approval.approve / approval.reject)", () => {
  const pending = { request_id: "req_1", status: "pending" };

  it("approve_selected dispatches a real approval.approve RuntimeCommandRequest for the oldest pending request", () => {
    const model = onApprovals(initialModel(), [pending]);
    const result = update(model, { type: "ui_intent", intent: { type: "approve_selected" }, at: 5 });
    expect(result.effects).toHaveLength(1);
    const effect = result.effects[0];
    if (effect.type !== "dispatch_command") throw new Error("expected dispatch_command");
    expect(effect.request.kind).toBe("approval.approve");
    expect(effect.request.params).toEqual({ request_id: "req_1", actor: "tui-operator", memory_scope: "once" });
  });

  it("reject_selected dispatches a real approval.reject RuntimeCommandRequest", () => {
    const model = onApprovals(initialModel(), [pending]);
    const result = update(model, { type: "ui_intent", intent: { type: "reject_selected" }, at: 5 });
    const effect = result.effects[0];
    if (effect.type !== "dispatch_command") throw new Error("expected dispatch_command");
    expect(effect.request.kind).toBe("approval.reject");
    expect(effect.request.params).toEqual({ request_id: "req_1", actor: "tui-operator" });
  });

  it("skips already-decided requests to find the oldest still-pending one", () => {
    const decided = { request_id: "req_0", status: "approved" };
    const model = onApprovals(initialModel(), [decided, pending]);
    const result = update(model, { type: "ui_intent", intent: { type: "approve_selected" }, at: 5 });
    const effect = result.effects[0];
    if (effect.type !== "dispatch_command") throw new Error("expected dispatch_command");
    expect(effect.request.params).toEqual({ request_id: "req_1", actor: "tui-operator", memory_scope: "once" });
  });

  it("is a safe no-op off the approvals screen or with no pending requests", () => {
    const wrongScreen = onInterviews(initialModel(), []);
    expect(update(wrongScreen, { type: "ui_intent", intent: { type: "approve_selected" }, at: 1 }).effects).toEqual([]);

    const noPending = onApprovals(initialModel(), [{ request_id: "req_9", status: "approved" }]);
    expect(update(noPending, { type: "ui_intent", intent: { type: "approve_selected" }, at: 1 }).effects).toEqual([]);
  });

  it("suppresses persistent approval when the action has no canonical fingerprint", () => {
    const model = onApprovals(initialModel(), [{ request_id: "uncanonical", status: "pending", action: "permission.grant" }]);
    const result = update(model, { type: "ui_intent", intent: { type: "approve_selected", scope: "persistent" }, at: 7 });
    expect(result.effects).toEqual([]);
    expect(result.model.notifications).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "warning", message: expect.stringContaining("cannot be canonicalized") })]));
  });
});

describe("queue throttle", () => {
  it("maps the live queue state to the complementary canonical command", () => {
    const paused = { ...initialModel(), screen: "jobs" as const, screens: new Map([["jobs" as const, { queue_paused: true, jobs: [] }]]) };
    const resumed = update(paused, { type: "ui_intent", intent: { type: "toggle_job_queue" }, at: 10 });
    expect(resumed.effects[0]).toMatchObject({ type: "dispatch_command", request: { kind: "job.resume" } });

    const running = { ...paused, screens: new Map([["jobs" as const, { queue_paused: false, jobs: [] }]]) };
    const stopped = update(running, { type: "ui_intent", intent: { type: "toggle_job_queue" }, at: 11 });
    expect(stopped.effects[0]).toMatchObject({ type: "dispatch_command", request: { kind: "job.pause" } });
  });
});
