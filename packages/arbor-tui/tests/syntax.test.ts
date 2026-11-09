import { describe, expect, it } from "vitest";
import { ANSI } from "../src/player-piano.js";
import { highlightSyntax, syntaxLanguageForPath } from "../src/syntax.js";
import { fromReviewLines, renderDiffFile } from "../src/diff-view.js";

describe("syntax highlighting", () => {
  it("selects a small deterministic lexer from a file path", () => {
    expect(syntaxLanguageForPath("src/app.ts")).toBe("typescript");
    expect(syntaxLanguageForPath("config.json")).toBe("json");
    expect(syntaxLanguageForPath("scripts/check.sh")).toBe("shell");
    expect(syntaxLanguageForPath("README.md")).toBe("plain");
  });

  it("marks keywords, strings, numbers, and comments without parsing the source", () => {
    const line = highlightSyntax('const answer = "42"; // note', "typescript");
    expect(line).toContain(`${ANSI.cyan}const${ANSI.reset}`);
    expect(line).toContain(`${ANSI.green}"42"${ANSI.reset}`);
    expect(line).toContain(`${ANSI.dim}// note${ANSI.reset}`);
  });

  it("uses syntax color for unchanged source context in color diff mode while retaining diff colors for additions", () => {
    const file = fromReviewLines(
      [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
      [
        { file_path: "src/a.ts", old_line: null, new_line: null, kind: "header", text: "@@ -1,2 +1,3 @@" },
        { file_path: "src/a.ts", old_line: 1, new_line: 1, kind: "context", text: "const answer = 42;" },
        { file_path: "src/a.ts", old_line: null, new_line: 2, kind: "addition", text: "const added = true;" },
      ],
    ).files[0]!;
    const rendered = renderDiffFile(file, { width: 100, height: 10, mode: "unified", color: true });
    expect(rendered[1]).toContain(`${ANSI.cyan}const${ANSI.reset}`);
    expect(rendered[2]).toContain(ANSI.green);
  });
});
