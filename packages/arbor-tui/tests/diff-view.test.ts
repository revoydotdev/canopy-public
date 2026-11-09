import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/widgets.js";
import { fromReviewLines, renderDiffFile, type DiffFile } from "../src/diff-view.js";

const REVIEW_FILES = [
  { path: "src/app.ts", status: "modified", additions: 2, deletions: 1 },
  { path: "new-name.txt", status: "renamed", additions: 0, deletions: 0 },
  { path: "logo.png", status: "binary", additions: 0, deletions: 0 },
] as const;

const REVIEW_LINES = [
  { file_path: "src/app.ts", old_line: null, new_line: null, kind: "header", text: "diff --git a/src/app.ts b/src/app.ts" },
  { file_path: "src/app.ts", old_line: null, new_line: null, kind: "header", text: "@@ -1,3 +1,4 @@" },
  { file_path: "src/app.ts", old_line: 1, new_line: 1, kind: "context", text: "line one" },
  { file_path: "src/app.ts", old_line: 2, new_line: null, kind: "deletion", text: "line two" },
  { file_path: "src/app.ts", old_line: null, new_line: 2, kind: "addition", text: "line two changed" },
  { file_path: "src/app.ts", old_line: null, new_line: 3, kind: "addition", text: "line three" },
  { file_path: "src/app.ts", old_line: 3, new_line: 4, kind: "context", text: "line four" },
  { file_path: "logo.png", old_line: null, new_line: null, kind: "binary", text: "Binary files differ" },
] as const;

describe("fromReviewLines", () => {
  it("builds the screen model from the result.review.workspace wire shape", () => {
    const parsed = fromReviewLines(REVIEW_FILES, REVIEW_LINES);
    expect(parsed.files.map((file) => file.path)).toEqual(["src/app.ts", "new-name.txt", "logo.png"]);

    const app = parsed.files[0]!;
    expect(app.status).toBe("modified");
    expect(app.additions).toBe(2);
    expect(app.deletions).toBe(1);
    expect(app.hunks).toHaveLength(1);
    const hunk = app.hunks[0]!;
    expect(hunk.old_start).toBe(1);
    expect(hunk.new_start).toBe(1);
    expect(hunk.lines).toEqual([
      { old_line: 1, new_line: 1, kind: "context", text: "line one" },
      { old_line: 2, new_line: null, kind: "deletion", text: "line two" },
      { old_line: null, new_line: 2, kind: "addition", text: "line two changed" },
      { old_line: null, new_line: 3, kind: "addition", text: "line three" },
      { old_line: 3, new_line: 4, kind: "context", text: "line four" },
    ]);
    expect(app.note).toBeNull();

    const renamed = parsed.files[1]!;
    expect(renamed.status).toBe("renamed");
    expect(renamed.hunks).toHaveLength(0);
    expect(renamed.note).toMatch(/Renamed/);

    const binary = parsed.files[2]!;
    expect(binary.status).toBe("binary");
    expect(binary.hunks).toHaveLength(0);
    expect(binary.note).toMatch(/Binary file changed/);
  });

  it("ignores file preamble and content without a hunk boundary", () => {
    const files = [
      { path: "a.ts", status: "modified", additions: 1, deletions: 1 },
      { path: "b.png", status: "binary", additions: 0, deletions: 0 },
    ];
    const lines = [
      { file_path: "a.ts", old_line: null, new_line: null, kind: "header", text: "@@ -1,2 +1,2 @@" },
      { file_path: "a.ts", old_line: 1, new_line: 1, kind: "context", text: "keep" },
      { file_path: "a.ts", old_line: 2, new_line: null, kind: "deletion", text: "old" },
      { file_path: "a.ts", old_line: null, new_line: 2, kind: "addition", text: "new" },
      { file_path: "b.png", old_line: null, new_line: null, kind: "binary", text: "Binary files differ" },
    ];
    const parsed = fromReviewLines(files, lines);
    expect(parsed.files).toHaveLength(2);
    const a = parsed.files[0]!;
    expect(a.hunks).toHaveLength(1);
    expect(a.hunks[0]!.lines.map((line) => line.kind)).toEqual(["context", "deletion", "addition"]);
    expect(a.hunks[0]!.old_start).toBe(1);
    expect(a.hunks[0]!.new_start).toBe(1);
    const b = parsed.files[1]!;
    expect(b.hunks).toHaveLength(0);
    expect(b.status).toBe("binary");
    expect(b.note).toMatch(/Binary file changed/);
  });
});

describe("renderDiffFile", () => {
  const app: DiffFile = fromReviewLines(REVIEW_FILES, REVIEW_LINES).files[0]!;

  it("unified mode renders a gutter with old/new line numbers and a hunk header", () => {
    const lines = renderDiffFile(app, { width: 100, height: 20, mode: "unified" });
    expect(lines[0]).toContain("@@ -1,3 +1,4 @@");
    expect(lines.some((line) => line.includes("2") && line.includes("line two changed"))).toBe(true);
    // header + 5 content lines
    expect(lines).toHaveLength(6);
  });

  it("highlights the current hunk in unified mode", () => {
    const plain = renderDiffFile(app, { width: 100, height: 20, mode: "unified", current_hunk: null });
    const highlighted = renderDiffFile(app, { width: 100, height: 20, mode: "unified", current_hunk: 0 });
    expect(highlighted[0]).not.toBe(plain[0]);
    expect(highlighted[0]).toContain("▶");
  });

  it("respects a scroll offset", () => {
    const full = renderDiffFile(app, { width: 100, height: 20, mode: "unified" });
    const scrolled = renderDiffFile(app, { width: 100, height: 20, mode: "unified", scroll_offset: 2 });
    expect(scrolled[0]).toBe(full[2]);
  });

  it("split mode renders side-by-side columns and clips a long line with an honest marker at width 80", () => {
    const longLine = "x".repeat(200);
    const wide = fromReviewLines(
      [{ path: "wide.txt", status: "modified", additions: 1, deletions: 1 }],
      [
        { file_path: "wide.txt", old_line: null, new_line: null, kind: "header", text: "@@ -1,1 +1,1 @@" },
        { file_path: "wide.txt", old_line: 1, new_line: null, kind: "deletion", text: longLine },
        { file_path: "wide.txt", old_line: null, new_line: 1, kind: "addition", text: `${longLine}y` },
      ],
    ).files[0]!;
    const lines = renderDiffFile(wide, { width: 80, height: 20, mode: "split" });
    expect(lines.every((line) => displayWidth(line.replace(/…/g, "x")) <= 82)).toBe(true);
    expect(lines.some((line) => line.includes("…"))).toBe(true);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  it("degrades a binary/rename entry to its typed one-line note instead of crashing", () => {
    const parsed = fromReviewLines(REVIEW_FILES, REVIEW_LINES);
    const renamed = parsed.files[1]!;
    const binary = parsed.files[2]!;
    expect(() => renderDiffFile(renamed, { width: 60, height: 10, mode: "unified" })).not.toThrow();
    expect(() => renderDiffFile(binary, { width: 60, height: 10, mode: "split" })).not.toThrow();
    expect(renderDiffFile(renamed, { width: 60, height: 10, mode: "unified" })).toEqual([expect.stringContaining("Renamed")]);
    expect(renderDiffFile(binary, { width: 60, height: 10, mode: "split" })).toEqual([expect.stringContaining("Binary file changed")]);
  });
});
