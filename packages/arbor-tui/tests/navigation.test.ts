import { describe, expect, it } from "vitest";
import { createNavigation, layoutWorkspace, resizeTerminal } from "../src/navigation.js";

const workspace = { id: "campaign", route: "/campaigns", split: "horizontal" as const, ratio: 0.5, panes: [{ id: "tree", title: "Tree" }, { id: "inspector", title: "Inspector" }] };

describe("TUI navigation/workspace model", () => {
  it("uses deterministic split geometry and compact fallback after resize", () => {
    const model = createNavigation(workspace, { columns: 120, rows: 40 });
    expect(layoutWorkspace(model)).toEqual({ mode: "split", panes: [{ id: "tree", x: 0, y: 0, columns: 60, rows: 40 }, { id: "inspector", x: 60, y: 0, columns: 60, rows: 40 }] });
    expect(layoutWorkspace(resizeTerminal(model, { columns: 60, rows: 20 }))).toEqual({ mode: "compact", panes: [{ id: "tree", x: 0, y: 0, columns: 60, rows: 20 }] });
  });
  it("resizeTerminal is a pure re-derivation: same terminal in, same model out (idempotent)", () => {
    const model = createNavigation(workspace, { columns: 120, rows: 40 });
    const resized = resizeTerminal(model, { columns: 100, rows: 30 });
    expect(resized.terminal).toEqual({ columns: 100, rows: 30 });
    expect(resizeTerminal(resized, { columns: 100, rows: 30 })).toEqual(resized);
  });
  it("keeps split panes inside resized geometry when their preferred minimums cannot fit", () => {
    const constrained = { ...workspace, panes: [{ id: "tree", title: "Tree", min_columns: 120, min_rows: 30 }, { id: "inspector", title: "Inspector", min_columns: 120, min_rows: 30 }] };
    const horizontal = layoutWorkspace(createNavigation(constrained, { columns: 100, rows: 30 }));
    expect(horizontal.panes).toEqual([
      { id: "tree", x: 0, y: 0, columns: 50, rows: 30 },
      { id: "inspector", x: 50, y: 0, columns: 50, rows: 30 },
    ]);
    const vertical = layoutWorkspace(createNavigation({ ...constrained, split: "vertical" }, { columns: 100, rows: 24 }));
    expect(vertical.panes).toEqual([
      { id: "tree", x: 0, y: 0, columns: 100, rows: 12 },
      { id: "inspector", x: 0, y: 12, columns: 100, rows: 12 },
    ]);
  });
  it("rejects invalid workspace and terminal definitions at the pure boundary", () => {
    expect(() => createNavigation({ ...workspace, ratio: 1 }, { columns: 120, rows: 40 })).toThrow("ratio");
    expect(() => createNavigation(workspace, { columns: 0, rows: 40 })).toThrow("terminal");
    expect(() => resizeTerminal(createNavigation(workspace, { columns: 120, rows: 40 }), { columns: 0, rows: 40 })).toThrow("terminal");
  });
});
