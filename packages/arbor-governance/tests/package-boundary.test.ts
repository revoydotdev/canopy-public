import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const PACKAGE_DIR = join(REPO_ROOT, "packages", "arbor-governance");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

describe("@arbor/governance package boundary (ADR-027 O4)", () => {
  it("declares @arbor/kb only for its red-team tests and never imports it from src", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.["@arbor/kb"]).toBeUndefined();
    expect(manifest.devDependencies?.["@arbor/kb"]).toBeDefined();

    const imports = sourceFiles(join(PACKAGE_DIR, "src"))
      .filter((path) => /from\s+["']@arbor\/kb["']|import\s*\(\s*["']@arbor\/kb["']\s*\)/.test(readFileSync(path, "utf8")));
    expect(imports).toEqual([]);
  });
});
