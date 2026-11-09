import { describe, expect, it } from "vitest";
import { hitTestFrame, type SceneFrame } from "../src/frame.js";

const scene: SceneFrame = {
  columns: 160, rows: [], status_row: 31,
  panes: [{
    id: "main", x: 0, y: 0, columns: 160, rows: 31,
    title: "Tree", content: [],
    interaction_regions: [{ id: "workspace-inspector", x: 117, y: 1, columns: 42, rows: 29 }],
  }],
};

describe("workspace inspector input ownership", () => {
  it("routes the reproduced rail click to the inspector, not Tree", () => {
    expect(hitTestFrame(scene, { column: 139, row: 3 })).toEqual({
      pane_id: "workspace-inspector", column_in_pane: 22, row_in_pane: 2,
    });
  });
  it("retains primary content and border ownership", () => {
    expect(hitTestFrame(scene, { column: 116, row: 3 })?.pane_id).toBe("main");
    expect(hitTestFrame(scene, { column: 159, row: 3 })?.pane_id).toBe("main");
  });
  it("does not consume status-row or out-of-frame input", () => {
    expect(hitTestFrame(scene, { column: 139, row: 31 })).toBeNull();
    expect(hitTestFrame(scene, { column: 160, row: 3 })).toBeNull();
  });
});
