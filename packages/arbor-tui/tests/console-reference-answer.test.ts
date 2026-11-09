import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredScreens, registerScreen } from "../src/screens/screen.js";
import { consoleScreen } from "../src/screens/console.js";
import { createNavigation, initialModel, update } from "../src/index.js";
import { renderScene } from "../src/renderer.js";
import { renderConsoleReferenceAnswer, selectConsoleReferenceAnswer } from "../src/console-reference-answer.js";
import { displayWidth } from "../src/widgets.js";

const reference = {
  id: "draft-reference", mode: "answer", status: "answered", task: "Explain README.md", updated_at: "2026-09-05T14:00:00Z",
  attachments: [{ display_name: "README.md.preview.txt" }],
  reference_answer: { text: "The document describes a disposable project.\nIts statements are not independently verified.", provenance: { tag: "claimed", claimant: "native-reference-answer" } },
  planner: { model_identity: "haiku-test", session_id: "reference-session", usage: { counter_source: "provider_counter", input_tokens: 17, output_tokens: 29 } },
};

describe("reference question operator surface", () => {
  beforeEach(() => { registerScreen(consoleScreen); });
  afterEach(() => { clearRegisteredScreens(); });
  it("forwards answer mode and labels the form as a question, not a change", () => {
    const opened = update(initialModel(), { type: "ui_intent", intent: { type: "open_task_preset", mode: "answer", task: "Explain README.md", reference_attachments: [{ display_name: "README.md.preview.txt", content_base64: "cmVm" }] }, at: 1 });
    expect(opened.model.overlay).toMatchObject({ task_mode: "answer", title: "Ask about this reference" });
    const scene = renderScene({ app: { ...opened.model, screen: "console", screens: new Map([["console", { captured_at: "2026-09-05T14:00:00Z" }]]) }, output: "", navigation: navigation(100) }, { color: false });
    const form = scene.panes.map(pane => pane.content.join("\n")).join("\n");
    expect(form).toContain("Enter ask");
    expect(form).toContain("question: Explain README.md");
    expect(form).not.toContain("Enter start task");
    const submitted = update(opened.model, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 2 });
    expect(submitted.effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: "dispatch_command", request: expect.objectContaining({ params: expect.objectContaining({ mode: "answer", auto_confirm: false, attachment_uploads: [{ display_name: "README.md.preview.txt", content_base64: "cmVm" }] }) }) })]));
  });

  it("keeps explicit governed changes in execute mode", () => {
    const opened = update(initialModel(), { type: "ui_intent", intent: { type: "open_task_preset", mode: "execute", task: "Review and accept ADR-160 if governance permits it" }, at: 1 });
    expect(opened.model.overlay).toMatchObject({ task_mode: "execute", title: "What should Revoy change?" });
    const submitted = update(opened.model, { type: "ui_intent", intent: { type: "submit_operator_form" }, at: 2 });
    expect(submitted.effects[0]).toMatchObject({ type: "dispatch_command", request: { params: { mode: "execute" } } });
  });

  it("renders the answer, provenance, source, and provider usage without plan sections", () => {
    const selected = selectConsoleReferenceAnswer({ items: [reference] })!;
    const rendered = renderConsoleReferenceAnswer(selected, 90, 30).join("\n");
    expect(rendered).toContain("claimed, not verified");
    expect(rendered).toContain("disposable project");
    expect(rendered).toContain("README.md.preview.txt");
    expect(rendered).toContain("17 input / 29 output tokens");
    expect(rendered).not.toMatch(/WORK UNITS|ACCEPTANCE CHECKS|PROPOSED PLAN/);
  });

  it.each([80, 100, 171])("projects answers through the real Console scene at %i columns", width => {
    const scene = renderScene({ app: { ...initialModel(), grantedCapabilities: new Set(["campaign.read"]), screen: "console", screens: new Map([["console", { captured_at: "2026-09-05T14:00:00Z", drafts: { items: [reference] }, sidebar_tab: "docs", sidebar_visibility: "shown" }]]) }, output: "", navigation: navigation(width) }, { color: false });
    const main = scene.panes.find(pane => pane.id === "main")!;
    expect(main.content.join("\n")).toContain("REFERENCE ANSWER");
    expect(main.content.join("\n")).not.toContain("PROPOSED PLAN");
    expect(main.content.every(line => displayWidth(line) <= main.columns)).toBe(true);
  });

  it("does not let an old answer hide a newer execution request", () => {
    expect(selectConsoleReferenceAnswer({ items: [reference, { id: "draft-next", mode: "execute", status: "planning", updated_at: "2026-09-05T14:00:01Z" }] })).toBeNull();
  });

  it("does not display an answer with manufactured verified provenance", () => {
    const selected = selectConsoleReferenceAnswer({ items: [{ ...reference, reference_answer: { text: "Unsafe claim", provenance: { tag: "verified" } } }] })!;
    expect(selected).toMatchObject({ status: "failed", answer: null });
    expect(renderConsoleReferenceAnswer(selected, 80, 30).join("\n")).not.toContain("Unsafe claim");
  });

  it.each(["planning", "failed", "cancelled"])("has truthful non-plan narration for %s", status => {
    const selected = selectConsoleReferenceAnswer({ items: [{ ...reference, status, reference_answer: null, planner: { error: "Provider unavailable" } }] })!;
    const output = renderConsoleReferenceAnswer(selected, 50, 30).join("\n");
    expect(output).not.toContain("PROPOSED PLAN");
    expect(selected.status).toBe(status);
    if (status === "failed") expect(output).toContain("Provider unavailable");
  });
});

function navigation(columns: number) {
  return createNavigation({ id: "workspace", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "main", title: "revoy2" }] }, { columns, rows: 30 });
}
