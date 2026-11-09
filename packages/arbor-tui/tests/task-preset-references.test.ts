import { describe, expect, it } from "vitest";
import { initialModel, update } from "../src/index.js";

describe("document preset reference transport", () => {
  it("captures references separately from task instructions and forwards them only on submit", () => {
    const references = [{ display_name: "README.md.preview.txt", content_base64: "cmVmZXJlbmNl" }];
    const opened = update(initialModel(), { type: "ui_intent", intent: { type: "open_task_preset", task: "Explain README.md", reference_attachments: references }, at: 1 });
    expect(opened.effects).toEqual([]);
    references[0]!.content_base64 = "changed";
    expect(opened.model.overlay).toMatchObject({ fields: { task: "Explain README.md" }, reference_attachments: [{ content_base64: "cmVmZXJlbmNl" }] });
    const submitted = update(opened.model, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 2 });
    const effect = submitted.effects[0]!;
    if (effect.type !== "dispatch_command") throw new Error("Expected canonical command dispatch");
    expect(effect.request).toMatchObject({ kind: "taskcomposer.submit", params: { task: "Explain README.md", auto_confirm: false, attachment_uploads: [{ display_name: "README.md.preview.txt", content_base64: "cmVmZXJlbmNl" }] } });
    expect(effect.request.params).not.toHaveProperty("command");
  });

  it("does not upload a reference when the form is cancelled", () => {
    const opened = update(initialModel(), { type: "ui_intent", intent: { type: "open_task_preset", task: "Explain README.md", reference_attachments: [{ display_name: "README.md.preview.txt", content_base64: "cmVm" }] }, at: 1 });
    const cancelled = update(opened.model, { type: "ui_intent", intent: { type: "cancel_operator_form" }, at: 2 });
    expect(cancelled.model.overlay).toBeNull();
    expect(cancelled.effects).toEqual([]);
  });
});
