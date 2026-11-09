import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverConsoleDocuments, readConsoleDocument } from "../src/console-documents.js";

describe("Console document navigation", () => {
  it("discovers real root/docs references, bounds previews, and refuses external symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "console-docs-"));
    const external = mkdtempSync(join(tmpdir(), "console-docs-external-"));
    try {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "README.md"), "Project guide");
      writeFileSync(join(root, "docs", "large.md"), "x".repeat(70_000));
      writeFileSync(join(external, "private.md"), "Private reference");
      symlinkSync(join(external, "private.md"), join(root, "escape.md"));
      expect(discoverConsoleDocuments(root).map((entry) => entry.path).sort()).toEqual(["README.md", "docs/large.md"]);
      expect(readConsoleDocument(root, "README.md")).toBe("Project guide");
      expect(readConsoleDocument(root, "docs/large.md")).toContain("[Preview limited to 64 KiB]");
      expect(() => readConsoleDocument(root, "escape.md")).toThrow("outside the checkout");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); }
  });
});
