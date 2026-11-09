import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readVitestIncludeGlobs,
  resolveRepoRoot,
  VITEST_CONFIG_CANDIDATES,
} from "../../src/obligation/proof.js";

// Regression tests for two portability bugs found by probing the resolver
// against non-vitest repository shapes.

const dirs: string[] = [];
function tempRepo(files: Record<string, string>, withDecisions = true): string {
  const root = mkdtempSync(join(tmpdir(), "gov-port-"));
  dirs.push(root);
  if (withDecisions) mkdirSync(join(root, "decisions"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const INCLUDE = "export default { test: { include: ['t/**/*.test.ts'] } };";

describe("readVitestIncludeGlobs — config discovery across real filenames", () => {
  // BUG 1: only `vitest.config.ts` was tried, so a genuine vitest repo whose
  // config used any other valid extension threw ENOENT.
  for (const name of ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs"]) {
    it(`reads include globs from ${name}`, () => {
      expect(readVitestIncludeGlobs(tempRepo({ [name]: INCLUDE }))).toEqual(["t/**/*.test.ts"]);
    });
  }

  it("falls back to vite.config.* when no vitest config exists, as vitest itself does", () => {
    expect(readVitestIncludeGlobs(tempRepo({ "vite.config.ts": INCLUDE }))).toEqual(["t/**/*.test.ts"]);
  });

  it("prefers vitest.config.ts over vite.config.ts when both exist", () => {
    const root = tempRepo({
      "vitest.config.ts": "export default { test: { include: ['from-vitest/**'] } };",
      "vite.config.ts": "export default { test: { include: ['from-vite/**'] } };",
    });
    expect(readVitestIncludeGlobs(root)).toEqual(["from-vitest/**"]);
  });

  it("throws — never returns [] — when no config exists at all", () => {
    // [] would mean "collects nothing", which would report every roundtrip in
    // the repository as a false proof. The caller turns this throw into
    // state:"unverifiable", which is the honest answer.
    const root = tempRepo({ "Cargo.toml": "[package]\n" });
    expect(() => readVitestIncludeGlobs(root)).toThrow(/no vitest\/vite config found/);
    expect(() => readVitestIncludeGlobs(root)).not.toThrow(/ENOENT/);
  });

  it("names what it tried, so the failure is diagnosable", () => {
    const root = tempRepo({ "jest.config.js": "module.exports={};" });
    expect(() => readVitestIncludeGlobs(root)).toThrow(/tried 12 candidates/);
    expect(VITEST_CONFIG_CANDIDATES).toHaveLength(12);
  });
});

describe("resolveRepoRoot — no longer coupled to a test runner", () => {
  // BUG 2: root resolution required vitest.config.ts, so it threw before any
  // glob logic ran in any repo not using vitest with a .ts config.
  it("resolves this repository from the module's own location", () => {
    const root = resolveRepoRoot();
    // ADR-073: this assertion previously hardcoded `expect(root).toMatch(/revoy2/)`
    // — a literal directory-name check that failed in every worktree not
    // named exactly "revoy2" (two independent build agents reported this
    // portability bug as "pre-existing, unrelated" before it was traced
    // here). Identity is derived from the repo's own package.json `name`
    // instead of the checkout path, so this passes regardless of what
    // directory the repo is cloned or worktree-checked-out into — this test
    // file itself lives under a worktree named "wt-cony", not "revoy2",
    // which is the regression proof.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    expect(pkg.name).toBe("revoy2");
  });

  it("resolves a repo that has NO test-runner config at all", () => {
    // The actual regression. Before the fix this threw, because vitest.config.ts
    // was a required marker. A Cargo repo with decisions/ is now resolvable.
    const root = tempRepo({ "Cargo.toml": "[package]\n", "package.json": "{}" });
    expect(resolveRepoRoot(root)).toBe(root);
  });

  it("resolves a jest repo", () => {
    const root = tempRepo({ "jest.config.js": "module.exports={};", "package.json": "{}" });
    expect(resolveRepoRoot(root)).toBe(root);
  });

  it("accepts .git as corroboration when package.json is absent", () => {
    const root = tempRepo({});
    mkdirSync(join(root, ".git"));
    expect(resolveRepoRoot(root)).toBe(root);
  });

  it("still refuses a directory with no decisions/ marker", () => {
    // Guards the other direction: the marker must actually mean something, so a
    // bare directory must NOT resolve as a governance repo root.
    const root = tempRepo({ "package.json": "{}" }, false);
    expect(() => resolveRepoRoot(root)).toThrow(/could not resolve repo root/);
  });
});
