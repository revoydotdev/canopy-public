import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globMatches, loadMergeCriticalRegistry, runMergeCriticalCheck, selectMergeCriticalProperties, verifyMergeCriticalRegistry } from "../lib/merge-critical.mjs";

const created = [];
afterEach(() => { while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true }); });

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "arbor-merge-critical-"));
  created.push(repo);
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, "decisions"), { recursive: true });
  mkdirSync(join(repo, "src", "nested"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "decisions", "ADR-001-first.md"), "# ADR-001\n");
  writeFileSync(join(repo, "decisions", "ADR-002-second.md"), "# ADR-002\n");
  writeFileSync(join(repo, "tests", "first.test.mjs"), "export {};\n");
  writeFileSync(join(repo, "tests", "second.test.mjs"), "export {};\n");
  writeFileSync(join(repo, "docs", "merge-critical-properties.jsonc"), JSON.stringify({ schema_version: 1, properties: [
    { property_id: "first", adr: "ADR-001", statement: "first remains true", watch_globs: ["src/**/*.ts"], test_id: "tests/first.test.mjs" },
    { property_id: "second", adr: "ADR-002", statement: "second remains true", watch_globs: ["other/*.ts"], test_id: "tests/second.test.mjs" },
  ] }));
  return repo;
}

describe("merge-critical property selection", () => {
  it("matches a declared glob conservatively at every directory depth", () => {
    expect(globMatches("src/**/*.ts", "src/top.ts")).toBe(true);
    expect(globMatches("src/**/*.ts", "src/nested/deep.ts")).toBe(true);
    expect(globMatches("src/**/*.ts", "src/top.js")).toBe(false);
  });

  it("triggers two independent properties and none for an unrelated diff", () => {
    const repo = fixture();
    const properties = loadMergeCriticalRegistry(repo).properties;
    expect(selectMergeCriticalProperties(properties, ["src/nested/a.ts", "other/b.ts"]).map((entry) => entry.property_id)).toEqual(["first", "second"]);
    expect(selectMergeCriticalProperties(properties, ["README.md"])).toEqual([]);
  });

  it("reruns every property when the registry changes", () => {
    const repo = fixture();
    const properties = loadMergeCriticalRegistry(repo).properties;
    expect(selectMergeCriticalProperties(properties, ["docs/merge-critical-properties.jsonc"])).toHaveLength(2);
  });
});

describe("merge-critical fail-closed execution", () => {
  it("fails integrity when a test id becomes unreachable", () => {
    const repo = fixture();
    const registry = loadMergeCriticalRegistry(repo);
    registry.properties[0].test_id = "tests/renamed.test.mjs";
    expect(verifyMergeCriticalRegistry(repo, registry)).toMatchObject({ ok: false, errors: [expect.stringContaining("unreachable")] });
  });

  it("attributes each triggered run and fails when any registered property fails", () => {
    const repo = fixture();
    const attributed = [];
    const result = runMergeCriticalCheck({
      repo,
      range: "unused",
      changedPaths: ["src/nested/a.ts", "other/b.ts"],
      log: (message) => attributed.push(message),
      runTest: (_cwd, testId) => ({ status: testId.includes("second") ? 1 : 0, stdout: "", stderr: "" }),
    });
    expect(result).toMatchObject({ ok: false, state: "property_failed", selected: ["first", "second"] });
    expect(attributed).toEqual([expect.stringContaining("ADR-001"), expect.stringContaining("ADR-002")]);
  });
});
