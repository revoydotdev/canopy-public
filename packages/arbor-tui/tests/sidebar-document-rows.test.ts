import { describe, expect, it } from "vitest";
import { projectResponsiveSidebar, renderResponsiveSidebar, sidebarDocumentRows } from "../src/responsive-sidebar.js";

describe("rendered document row identities", () => {
  it("maps exact paths through scroll and selection, excluding overflow/borders", () => {
    const documents = Array.from({length: 20}, (_, i) => ({path: `docs/document-${i}.md`, title: `Document ${i}`}));
    for (const selected of [0, 8, 19]) {
      const projection = projectResponsiveSidebar({width: 160, visibility: "shown", tab: "docs", documents, selected_document: documents[selected]!.path});
      const lines = renderResponsiveSidebar(projection, {height: 14});
      const targets = sidebarDocumentRows(projection, 14);
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expect(lines[target.row]).toContain(target.path);
        expect(lines[target.row]).not.toContain("PgDn scroll");
      }
      expect(targets.some((target) => target.path === documents[selected]!.path)).toBe(true);
    }
  });
  it("does not duplicate an identical document title and source path", () => {
    const projection = projectResponsiveSidebar({width: 160, visibility: "shown", tab: "docs", document: {title: "plan.md", source_path: "plan.md", content: "Document body"}});
    expect(renderResponsiveSidebar(projection, {height: 14}).filter((line) => line.includes("plan.md"))).toHaveLength(1);
    expect(sidebarDocumentRows(projection, 14)).toEqual([]);
  });
});
