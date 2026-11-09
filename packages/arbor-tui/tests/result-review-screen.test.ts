import { describe, expect, it } from "vitest";
import { availableScreens, clearRegisteredScreens, initialModel, installScreens, resultReviewScreen, update } from "../src/index.js";

describe("result review screen", () => {
  it("projects the production workspace contract and is gated by read plus adoption authority", () => {
    const projection = resultReviewScreen.project({ campaign_id: "campaign", node_id: "node", patch_sha256: "a".repeat(64), review_revision: 3, counts: { files: 1, additions: 2, deletions: 1 }, files: [{ path: "src/app.ts", status: "modified", additions: 2, deletions: 1 }], unified: [{ kind: "header", file_path: "src/app.ts", old_line: null, new_line: null, text: "@@ -2,1 +2,2 @@" }, { kind: "deletion", file_path: "src/app.ts", old_line: 2, new_line: null, text: "const unsafe = true" }, { kind: "addition", file_path: "src/app.ts", old_line: null, new_line: 3, text: "const safe = true" }], relationships: { provenance: { capture: "verified" } }, conflict_preview: { status: "clean" } }, { width: 140, height: 20 });
    expect(projection.rows[0]).toMatchObject({ path: "src/app.ts", delta: "+2 -1", conflict: "clean", provenance: "verified" }); expect(resultReviewScreen.render({ projection, width: 140, height: 20 }).join("\n")).toContain("const safe = true");
    clearRegisteredScreens(); installScreens(); try { expect(availableScreens(new Set(["result.read", "result.adopt"])).map((screen) => screen.id)).toContain("result-review"); expect(availableScreens(new Set(["result.read"])).map((screen) => screen.id)).not.toContain("result-review"); } finally { clearRegisteredScreens(); }
  });

  it("opens CAS-bound comment, revision, and editor forms from the selected manifest row", () => {
    const base = initialModel();
    const model = { ...base, screen: "result-review" as const, selection: new Map(base.selection).set("result-review", { id: "src/app.ts", context: { campaign_id: "campaign", node_id: "node", expected_patch_sha256: "a".repeat(64), expected_revision: "3" } }) };
    for (const command of ["result.review.comment", "result.review.request_revision", "result.review.editor_handoff"] as const) {
      const opened = update(model, { type: "ui_intent", intent: { type: "open_operator_form", command }, at: 1 }).model;
      expect(opened.overlay).toMatchObject({ kind: "operator_form", command, fields: { campaign_id: "campaign", node_id: "node", expected_patch_sha256: "a".repeat(64), expected_revision: "3" } });
    }
  });

  it("toggles to a width-aware split diff and falls back to unified on narrow terminals", () => {
    const base = initialModel();
    const workspace = { campaign_id: "campaign", node_id: "node", patch_sha256: "a".repeat(64), review_revision: 1, view_mode: "unified", counts: { files: 1, additions: 1, deletions: 1 }, files: [{ path: "src/app.ts", status: "modified", additions: 1, deletions: 1 }], unified: [{ kind: "header", file_path: "src/app.ts", old_line: null, new_line: null, text: "@@ -3,1 +3,1 @@" }, { kind: "deletion", file_path: "src/app.ts", old_line: 3, new_line: null, text: "old value" }, { kind: "addition", file_path: "src/app.ts", old_line: null, new_line: 3, text: "new value" }], relationships: { provenance: { capture: "verified" } }, conflict_preview: { status: "clean" } };
    const screens = new Map(base.screens).set("result-review", workspace);
    const toggled = update({ ...base, screen: "result-review", screens }, { type: "ui_intent", intent: { type: "toggle_result_review_mode" }, at: 1 }).model;
    expect((toggled.screens.get("result-review") as { view_mode: string }).view_mode).toBe("side-by-side");
    const projection = resultReviewScreen.project(toggled.screens.get("result-review"), { width: 120, height: 20 });
    const wide = resultReviewScreen.render({ projection, width: 120, height: 20 }).join("\n");
    expect(wide).toContain("OLD"); expect(wide).toContain("old value"); expect(wide).toContain("new value"); expect(wide).toContain("│");
    expect(resultReviewScreen.render({ projection, width: 70, height: 20 }).join("\n")).not.toContain("OLD");
  });

  it("labels bounded diff detail and names the real full-context retrieval route", () => {
    const projection = resultReviewScreen.project({
      campaign_id: "campaign", node_id: "node", patch_sha256: "a".repeat(64), review_revision: 1,
      truncated: true,
      counts: { files: 1, additions: 1, deletions: 0 },
      files: [{ path: "src/large.ts", status: "modified", additions: 1, deletions: 0 }],
      unified: [{ kind: "addition", file_path: "src/large.ts", old_line: null, new_line: 1, text: "bounded line" }],
      relationships: { provenance: { capture: "verified" } },
      conflict_preview: { status: "clean" },
    }, { width: 120, height: 20 });

    const rendered = resultReviewScreen.render({ projection, width: 120, height: 20 }).join("\n");
    expect(rendered).toContain("Diff detail is bounded by the review query");
    expect(rendered).toContain("editor handoff");
    expect(resultReviewScreen.surface.commands).toContain("result.review.editor_handoff");
  });

  it("keeps empty, malformed, and zero-file workspaces honest", () => {
    const absent = resultReviewScreen.project(null, { width: 80, height: 10 });
    expect(absent).toMatchObject({ variant: "empty", rows: [] });
    expect(absent.caption).toContain("No diff review workspace loaded yet");

    const malformed = resultReviewScreen.project({ files: [], unified: [] }, { width: 80, height: 10 });
    expect(malformed).toMatchObject({ variant: "empty", rows: [] });
    expect(malformed.caption).toContain("unrecognised");

    const empty = resultReviewScreen.project({
      campaign_id: "campaign", node_id: "node", counts: {}, files: [], unified: [],
      relationships: {}, conflict_preview: {}, review_file_index: Number.NaN,
      review_hunk_index: Number.POSITIVE_INFINITY,
    }, { width: 80, height: 10 });
    expect(empty).toMatchObject({ review_file_index: 0, review_hunk_index: 0, review_files: [], rows: [] });
    expect(empty.caption).toContain("no changed files");
    expect(empty.caption).toContain("declared write scope: unavailable");
    expect(resultReviewScreen.render({ projection: empty, width: 80, height: 10 }).join("\n")).toContain("No changed files to review.");
  });

  it("bounds scope disclosure, filters invalid entries, and clamps review cursors", () => {
    const violations = Array.from({ length: 8 }, (_, index) => `outside/${index}.ts`);
    const projection = resultReviewScreen.project({
      campaign_id: "campaign", node_id: "node", review_revision: 4,
      review_file_index: 99, review_hunk_index: -8,
      counts: { files: 9, additions: 2, deletions: 1 },
      files: [
        { path: "src/app.ts", status: "modified", additions: 2, deletions: 1 },
        { path: 42, status: null },
        "ignored",
      ],
      unified: [
        { kind: "header", file_path: "src/app.ts", text: "@@ -1,1 +1,1 @@" },
        { kind: "addition", file_path: "src/app.ts", text: "new" },
        { kind: "addition", text: 42 },
      ],
      relationships: {
        provenance: null,
        capture: { scope_violations: [...violations, 42], declared_write_paths: ["src/**", 42] },
      },
      conflict_preview: { status: "clean" },
    }, { width: 120, height: 20 });

    expect(projection).toMatchObject({ review_file_index: 0, review_hunk_index: 0 });
    expect(projection.rows).toHaveLength(2);
    expect(projection.rows[1]).toMatchObject({ path: "42", state: "modified", delta: "+0 -0", provenance: "unknown" });
    expect(projection.caption).toContain("declared write scope: 1 path(s)");
    expect(projection.caption).toContain("outside/0.ts");
    expect(projection.caption).toContain("(+2 more)");
  });

  it("respects tiny render budgets and contains malformed projection failures", () => {
    const projection = resultReviewScreen.project({
      counts: {}, files: [{ path: "a.ts", status: "added", additions: 1, deletions: 0 }],
      unified: [{ kind: "addition", file_path: "a.ts", text: "line" }],
      relationships: {}, conflict_preview: {},
    }, { width: 40, height: 3 });
    expect(resultReviewScreen.render({ projection, width: 40, height: 1 })).toHaveLength(1);

    const broken = { ...projection, columns: undefined } as never;
    expect(resultReviewScreen.render({ projection: broken, width: 40, height: 8 })).toEqual(["Diff review render error"]);

    const defaulted = {
      variant: "workspace", screen: "result-review", rows: projection.rows, columns: projection.columns,
      review_files: (projection as unknown as { readonly review_files: readonly unknown[] }).review_files,
    } as never;
    expect(resultReviewScreen.render({ projection: defaulted, width: 80, height: 8, color: true }).join("\n")).toContain("Diff review");
  });
});
