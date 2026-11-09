import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../../src/artifact/scan.js";

/**
 * scan-source-roots.test.ts — Roadmap 23 B2's acceptance test for
 * artifact/scan.ts. `scan()` previously joined the literal `"packages"`
 * onto `repoRoot` (and `packageNameFromPath` matched only a hardcoded
 * `^packages\/` prefix), so a fixture project whose sources live under
 * `src/` scanned to an empty identity list — indistinguishable from a real
 * project with zero exported symbols.
 */

let tmpRoot: string | null = null;

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

function buildFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-governance-scan-source-roots-"));
  const srcDir = join(root, "src", "widget", "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "index.ts"), "export function widgetFn() { return 1; }\n");
  return root;
}

describe("scan — source_roots portability (Roadmap 23 B2)", () => {
  it("with sourceRoots omitted, a src/-shaped fixture scans to an empty identity list — the defect this change closes", () => {
    tmpRoot = buildFixtureRepo();
    expect(scan(tmpRoot)).toEqual([]);
  });

  it("with sourceRoots: ['src'], the fixture's file and symbol identities are found", () => {
    tmpRoot = buildFixtureRepo();
    const identities = scan(tmpRoot, { sourceRoots: ["src"] });
    const file = identities.find((i) => i.kind === "file" && i.path === "src/widget/src/index.ts");
    expect(file).toBeDefined();
    const symbol = identities.find(
      (i) => i.kind === "symbol" && i.path === "src/widget/src/index.ts" && i.symbol_id === "widget::widgetFn",
    );
    expect(symbol).toBeDefined();
  });
});
