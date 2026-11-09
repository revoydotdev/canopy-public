import { describe, expect, it } from "vitest";
import { initialModel } from "../src/model.js";
import { update } from "../src/update.js";

const interviews = {
  campaign_id: "campaign-live",
  records: [
    { id: "question-1", question: { question: "First live question" } },
    { id: "question-2", question: { question: "Second live question" } },
  ],
  answered_record_ids: [],
};

describe("interview keyboard controls", () => {
  it("answers the keyboard-selected pending interview, not an unrelated newer row", () => {
    let model = update(initialModel(), { type: "screen_changed", screen: "interviews" }).model;
    model = update(model, { type: "query_results", queryId: "interviews", screen: "interviews", value: interviews }).model;
    expect(model.selection.get("interviews")?.id).toBe("question-2");
    model = update(model, { type: "ui_intent", intent: { type: "select_row_relative", direction: -1 }, at: 2 }).model;
    const armed = update(model, { type: "ui_intent", intent: { type: "arm_answer" }, at: 3 }).model;
    expect(armed.overlay).toMatchObject({ kind: "compose", record_id: "question-1", question: "First live question" });
  });
});
