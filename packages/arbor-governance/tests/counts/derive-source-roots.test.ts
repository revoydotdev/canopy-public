import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveRepositoryCounts } from "../../src/counts/derive.js";

/**
 * derive-source-roots.test.ts — Roadmap 23 B2's acceptance test for
 * counts/derive.ts: "a fixture project whose sources live in `src/` rather
 * than `packages/` must have its symbols/counts picked up. Today they would
 * be silently missed, producing counts that look like a real measurement of
 * an empty project."
 *
 * Before this change, `countSrcFiles`/`countPackages`/`countTestFiles` all
 * joined the literal `"packages"` onto `repoRoot`, and `countCatalogKinds`
 * joined the literal `"packages/arbor-mcp/src/runtime-catalog.ts"`. A
 * fixture using `src/` instead of `packages/` — or a `scripts/tests`-shaped
 * directory under a different name — would produce a real, honest-looking
 * `0`/`unmeasured` set that is INDISTINGUISHABLE from a correctly-measured
 * empty project. That is the false-zero defect this test exists to catch.
 */

let tmpRoot: string | null = null;

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

function buildFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-governance-derive-source-roots-"));

  // Sources live under src/, not packages/.
  const srcDir = join(root, "src", "widget", "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "index.ts"), "export function widget() { return 1; }\n");
  writeFileSync(join(srcDir, "helper.d.ts"), "export declare function ignored(): void;\n");

  const testsDir = join(root, "src", "widget", "tests");
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(join(testsDir, "widget.test.ts"), "// a test\n");

  // Non-package-scoped tests, under a differently-named directory.
  const scriptTestsDir = join(root, "tooling", "tests");
  mkdirSync(scriptTestsDir, { recursive: true });
  writeFileSync(join(scriptTestsDir, "tool.test.mjs"), "// a script-level test\n");

  // A runtime catalog at a fixture-specific path, not arbor-mcp's.
  const catalogDir = join(root, "src", "runtime", "src");
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(
    join(catalogDir, "catalog.ts"),
    [
      "export const RUNTIME_CATALOG = [",
      '  { kind: "fixture.one", direction: "query", supported: true },',
      '  { kind: "fixture.two", direction: "command", supported: true },',
      '  { kind: "fixture.three", direction: "query", supported: true },',
      "];",
      "",
    ].join("\n"),
  );

  return root;
}

describe("deriveRepositoryCounts — source_roots portability (Roadmap 23 B2)", () => {
  it("with sourceRoots omitted, a src/-shaped fixture reports a FALSE ZERO, not unmeasured — the defect this change closes", () => {
    tmpRoot = buildFixtureRepo();
    const counts = deriveRepositoryCounts(tmpRoot);
    // This is the pre-existing "packages" default: a src/-shaped project
    // measures as though it had no packages, no src files, and no tests —
    // real zeros indistinguishable from a genuinely empty project.
    expect(counts.packages).toBe(0);
    expect(counts.src_files).toBe(0);
    // packages === 0 AND no literal "packages" dir exists -> honestly unmeasured.
    expect(counts.unmeasured).toContain("packages");
  });

  it("with sourceRoots: ['src'], the fixture's package, src files, and tests are picked up as real, non-zero counts", () => {
    tmpRoot = buildFixtureRepo();
    const counts = deriveRepositoryCounts(tmpRoot, {
      sourceRoots: ["src"],
      scriptsTestsDir: "tooling/tests",
      catalogPath: "src/runtime/src/catalog.ts",
    });

    expect(counts.packages).toBe(2); // widget, runtime
    expect(counts.src_files).toBe(2); // widget/src/index.ts, runtime/src/catalog.ts (helper.d.ts excluded)
    expect(counts.test_files).toBe(2); // widget/tests/widget.test.ts + tooling/tests/tool.test.mjs
    expect(counts.catalog_kinds).toBe(3);
    // adr_total/allowlist_entries are honestly unmeasured — this fixture has
    // no decisions/ or allowlist at all, which is unrelated to source_roots.
    expect([...counts.unmeasured].sort()).toEqual(["adr_total", "allowlist_entries"]);
  });

  it("catalogPath honors a fixture-specific runtime catalog rather than always reading revoy2's arbor-mcp catalog", () => {
    tmpRoot = buildFixtureRepo();
    const withOption = deriveRepositoryCounts(tmpRoot, { catalogPath: "src/runtime/src/catalog.ts" });
    expect(withOption.catalog_kinds).toBe(3);
    expect(withOption.unmeasured).not.toContain("catalog_kinds");

    const withoutOption = deriveRepositoryCounts(tmpRoot);
    expect(withoutOption.catalog_kinds).toBe(0);
    expect(withoutOption.unmeasured).toContain("catalog_kinds");
  });
});
