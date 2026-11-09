import { describe, expect, it } from "vitest";
import { initialModel, update } from "../src/index.js";

function twoFileWorkspace() {
  return {
    campaign_id: "campaign", node_id: "node", patch_sha256: "a".repeat(64), review_revision: 1, view_mode: "unified",
    counts: { files: 2, additions: 3, deletions: 2 },
    files: [
      { path: "a.ts", status: "modified", additions: 2, deletions: 1 },
      { path: "b.ts", status: "modified", additions: 1, deletions: 1 },
    ],
    unified: [
      { kind: "header", file_path: "a.ts", old_line: null, new_line: null, text: "@@ -1,1 +1,1 @@" },
      { kind: "deletion", file_path: "a.ts", old_line: 1, new_line: null, text: "old one" },
      { kind: "addition", file_path: "a.ts", old_line: null, new_line: 1, text: "new one" },
      { kind: "header", file_path: "a.ts", old_line: null, new_line: null, text: "@@ -5,1 +5,1 @@" },
      { kind: "addition", file_path: "a.ts", old_line: null, new_line: 5, text: "second hunk" },
      { kind: "header", file_path: "b.ts", old_line: null, new_line: null, text: "@@ -1,1 +1,1 @@" },
      { kind: "deletion", file_path: "b.ts", old_line: 1, new_line: null, text: "old b" },
      { kind: "addition", file_path: "b.ts", old_line: null, new_line: 1, text: "new b" },
    ],
    relationships: { provenance: { capture: "verified" } },
    conflict_preview: { status: "clean" },
  };
}

function onResultReview(workspace: unknown) {
  const base = initialModel();
  const screens = new Map(base.screens).set("result-review", workspace);
  return { ...base, screen: "result-review" as const, screens };
}

describe("result-review hunk/file navigation reducer", () => {
  it("moves the hunk cursor within the current file and clamps at the bounds (no wrap)", () => {
    const model = onResultReview(twoFileWorkspace());
    const afterNext = update(model, { type: "ui_intent", intent: { type: "result_review_move_hunk", direction: 1 }, at: 1 }).model;
    expect((afterNext.screens.get("result-review") as { review_hunk_index: number }).review_hunk_index).toBe(1);
    const afterNextAgain = update(afterNext, { type: "ui_intent", intent: { type: "result_review_move_hunk", direction: 1 }, at: 2 }).model;
    // file "a.ts" only has 2 hunks (index 0,1) — clamps at 1, does not wrap to 0.
    expect((afterNextAgain.screens.get("result-review") as { review_hunk_index: number }).review_hunk_index).toBe(1);
    const afterPrev = update(afterNextAgain, { type: "ui_intent", intent: { type: "result_review_move_hunk", direction: -1 }, at: 3 }).model;
    expect((afterPrev.screens.get("result-review") as { review_hunk_index: number }).review_hunk_index).toBe(0);
  });

  it("moves the file cursor and resets the hunk cursor to 0", () => {
    const model = onResultReview(twoFileWorkspace());
    const advanced = update(model, { type: "ui_intent", intent: { type: "result_review_move_hunk", direction: 1 }, at: 1 }).model;
    expect((advanced.screens.get("result-review") as { review_hunk_index: number }).review_hunk_index).toBe(1);
    const nextFile = update(advanced, { type: "ui_intent", intent: { type: "result_review_move_file", direction: 1 }, at: 2 }).model;
    expect(nextFile.screens.get("result-review")).toMatchObject({ review_file_index: 1, review_hunk_index: 0 });
    const clamped = update(nextFile, { type: "ui_intent", intent: { type: "result_review_move_file", direction: 1 }, at: 3 }).model;
    expect(clamped.screens.get("result-review")).toMatchObject({ review_file_index: 1 });
    const prevFile = update(clamped, { type: "ui_intent", intent: { type: "result_review_move_file", direction: -1 }, at: 4 }).model;
    expect(prevFile.screens.get("result-review")).toMatchObject({ review_file_index: 0, review_hunk_index: 0 });
  });

  it("is a no-op off the result-review screen or with no workspace loaded", () => {
    const base = initialModel();
    const offScreen = update(base, { type: "ui_intent", intent: { type: "result_review_move_hunk", direction: 1 }, at: 1 });
    expect(offScreen.model).toBe(base);
    const onScreenNoData = { ...base, screen: "result-review" as const };
    const noData = update(onScreenNoData, { type: "ui_intent", intent: { type: "result_review_move_file", direction: 1 }, at: 1 });
    expect(noData.model).toBe(onScreenNoData);
  });
});
