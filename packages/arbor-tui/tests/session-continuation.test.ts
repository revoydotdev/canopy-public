import { describe, expect, it } from "vitest";
import { initialModel } from "../src/model.js";
import { update } from "../src/update.js";
import type { AppModel } from "../src/types.js";

describe("harness session continuation", () => {
  it("dispatches only an explicitly advertised resume after disposition and typed confirmation", () => {
    const model: AppModel = {
      ...initialModel(), screen: "harness-sessions",
      selection: new Map([["harness-sessions", { id: "session-1" }]]),
      screens: new Map([["harness-sessions", { session_id: "session-1", continuations: { resume: { available: true } } }]]),
    };
    const opened = update(model, { type: "ui_intent", intent: { type: "open_operator_form", command: "harness.session.resume" }, at: 1 }).model;
    const disposition = update(opened, { type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at: 2 }).model;
    const writtenDisposition = update(disposition, { type: "ui_intent", intent: { type: "operator_form_input", value: "Continue after reviewed checkpoint" }, at: 3 }).model;
    const confirmation = update(writtenDisposition, { type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at: 4 }).model;
    const typed = update(confirmation, { type: "ui_intent", intent: { type: "operator_form_input", value: "RESUME" }, at: 5 }).model;
    const submitted = update(typed, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 6 });
    expect(submitted.effects).toEqual([{
      type: "dispatch_command",
      request: { kind: "harness.session.resume", metadata: { operation_id: "tui:harness.session.resume:6", idempotency_key: "tui:harness.session.resume:6" }, params: { session_id: "session-1", reason: "Continue after reviewed checkpoint", dispositions: [] } },
    }]);
  });
});
