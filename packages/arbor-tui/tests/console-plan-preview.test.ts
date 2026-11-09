import { describe, expect, it } from "vitest";
import { consolePlanPreviewLines, selectConsolePlanPreview } from "../src/console-plan-preview.js";
import { consoleScreen } from "../src/screens/console.js";
import { displayWidth } from "../src/widgets.js";

const draft = { id: "draft-1", revision: 1, status: "awaiting_clarification", campaign_id: null, updated_at: "2026-09-05T10:00:00Z",
  proposal: { summary: "Build the observatory site", actions: [{ description: "Initialize the Astro scaffold" }],
    acceptance_checks: ["Run build and tests"], assumptions: ["A scaffold exists"],
    questions: [{ id: "deps", question: "What is installed?", answer: null }] } };

describe("canonical Console plan preview", () => {
  it("shows work, checks and explicitly unverified assumptions instead of raw JSON", () => {
    const preview = selectConsolePlanPreview({ items: [draft] })!;
    const lines = consolePlanPreviewLines(preview, 48);
    expect(lines.join("\n")).toContain("WORK UNITS (1)");
    expect(lines.join("\n")).toContain("ACCEPTANCE CHECKS (1)");
    expect(lines.join("\n")).toContain("ASSUMPTIONS - not verified");
    expect(lines.every((line) => displayWidth(line) <= 48)).toBe(true);
  });
  it("labels an old proposal as unapproved while incorporating answers", () => {
    const preview = selectConsolePlanPreview({ items: [{ ...draft, status: "planning" }] })!;
    expect(consolePlanPreviewLines(preview, 80)[0]).toBe("REVISING PLAN - not approved");
  });
  it("does not promote streamed JSON or admitted work into a pre-campaign proposal", () => {
    for (const candidate of [{ ...draft, proposal: '{"summary":"untrusted"}' }, { ...draft, status: "admitted" },
      { ...draft, campaign_id: "campaign-1" }]) expect(selectConsolePlanPreview({ items: [candidate] })).toBeNull();
  });
  it.each([false, true])("wires the preview into the real Console projection, fresh planning=%s", (planning) => {
    const projection = consoleScreen.project({ captured_at: "2026-09-05T10:00:00Z", sidebar_visibility: "hidden",
      fresh_launch_planning: planning, drafts: { items: [{ ...draft, status: planning ? "planning" : draft.status }] } }, { width: 100, height: 32 });
    expect(projection.rows.some((row) => row.region === "plan-preview")).toBe(true);
  });
});
