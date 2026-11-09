import { describe, expect, it } from "vitest";
import { consoleScreen } from "../src/screens/console.js";
import { displayWidth } from "../src/widgets.js";

const failed = {
  captured_at: "2026-09-04T22:00:00.000Z",
  campaigns: { items: [{ id: "campaign", halted: true, active_node_state: "failed", verified_nodes: 0, total_nodes: 2 }] },
  tree: { campaign_id: "campaign", halted: true, halt_reason: "no_nodes", nodes: [
    { id: "root", parent_id: null, state: "claimed", action_description: "Add a greeting" },
    { id: "worker", parent_id: "root", state: "failed", critic_verdict: null,
      specialist_output: "FAILED: internal_error: model port failed: OpenAICompatibleAdapterError (http): OpenAI-compatible provider returned HTTP 402" },
  ] },
  repository_tree: { root: "/tmp/readability-project", entries: [] },
  console_input: { text: "", cursor: 0, focused: false },
};

function render(value: unknown, width = 100, height = 30, offset?: number): string[] {
  const projection = consoleScreen.project(value, { width, height });
  return [...consoleScreen.render({ projection, width, height, color: false, scroll_offset: offset })];
}

describe("Console task readability", () => {
  it.each([60, 80, 120])("surfaces an executor failure without a critic verdict at %i columns", (width) => {
    const lines = render(failed, width);
    const text = lines.join("\n");
    expect(text).toContain("HTTP 402");
    expect(text).toContain("Next:");
    expect(text).not.toContain("see the BLOCKED reason above");
    expect(text).not.toContain("PROJECT REPO");
    expect(lines.every((line) => displayWidth(line) <= width)).toBe(true);
    expect(lines).toHaveLength(30);
  });

  it("keeps context available when explicitly opened", () => {
    expect(render({ ...failed, sidebar_visibility: "shown" }, 140, 44).join("\n")).toContain("PROJECT REPO");
  });

  it("keeps a permanent full-height rail above the breakpoint, including beside the composer", () => {
    const lines = render(failed, 140, 44);
    expect(lines[0]).toContain("┌");
    expect(lines[43]).toContain("└");
    expect(lines.join("\n")).toContain("PROJECT REPO");
    expect(lines.every((line) => displayWidth(line) <= 140)).toBe(true);
  });

  it("reads and scrolls a document inside the rail without replacing the conversation", () => {
    const lines = render({ ...failed, sidebar_tab: "docs", sidebar_focused: true,
      sidebar_documents: [{ path: "README.md", title: "README.md" }], selected_document: "README.md",
      adr_document: { id: "README.md", title: "Project guide", source_path: "README.md", content: Array.from({ length: 80 }, (_, index) => `Document line ${index}`).join("\n") },
      sidebar_scroll_offset: 30,
    }, 140, 44);
    expect(lines.join("\n")).toContain("[DOCS]");
    expect(lines.join("\n")).toContain("Document line 30");
    expect(lines.join("\n")).toContain("HTTP 402");
    expect(lines).toHaveLength(44);
  });

  it("keeps durable source identity in history without repeating it in the conversation", () => {
    const session = {
      ...failed,
      session_attach: {
        session: { session_id: "session-readable", campaign_id: "campaign", node_id: "worker" },
        events: [{ sequence: 1, kind: "model_text", payload: { text: "Inspecting the greeting function", phase: "commentary" } }],
      },
    };
    const conversation = render(session).join("\n");
    expect(conversation).toContain("Inspecting the greeting function");
    expect(conversation).not.toContain("canonical/canonical_session:");
    expect(render(session, 100, 30, 0).join("\n")).toContain("canonical/canonical_session:session-readable");
  });
});
