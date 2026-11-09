/**
 * Tests for scripts/package-boundary-gate.mjs.
 *
 * This gate had no test, which is why an enforcement hole survived in it: the
 * specifier collector only ever looked at `@arbor/` specifiers, so a relative
 * import reaching across into `scripts/` — the exact inversion
 * `packages/arbor-mcp/src/project-registry.ts:14-21` documents and avoids by
 * shelling out — could not fail the gate at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePackageBoundaries } from "../package-boundary-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let root;

/**
 * Builds a throwaway repository root holding one leaf package and the policy
 * file that governs it. `forbiddenSourceRoots: null` omits the key entirely,
 * which is what every pre-existing profile does — so it must not fall through
 * to the default, hence a sentinel rather than `undefined`.
 */
function fixture({ indexSource, sourceImports = [], forbiddenSourceRoots = ["scripts/"] }) {
  const write = (path, text) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  };
  write("packages/leaf/package.json", `${JSON.stringify({ name: "@fixture/leaf", version: "1.0.0", private: true }, null, 2)}\n`);
  write("packages/leaf/src/index.ts", indexSource);
  write("scripts/lib/thing.mjs", "export const thing = 1;\n");
  write("packages/leaf/src/local.ts", "export const local = 2;\n");
  const policy = {
    schema_version: 1,
    ...(forbiddenSourceRoots === null ? {} : { forbidden_source_roots: forbiddenSourceRoots }),
    packages: {
      "@fixture/leaf": { path: "packages/leaf", source_imports: sourceImports, test_imports: [] },
    },
  };
  write("scripts/package-boundary-policy.json", `${JSON.stringify(policy, null, 2)}\n`);
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "arbor-package-boundary-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("gate:package-boundaries — forbidden source roots", () => {
  it("reports a relative specifier that resolves into a forbidden source root", () => {
    fixture({ indexSource: 'import { thing } from "../../../scripts/lib/thing.mjs";\n\nexport const carried = thing;\n' });
    const report = evaluatePackageBoundaries({ root });
    expect(report.ok).toBe(false);
    expect(report.findings).toContain("packages/leaf/src/index.ts: ../../../scripts/lib/thing.mjs is not permitted by @fixture/leaf.forbidden_source_roots");
  });

  it("reports a forbidden-root hit in tests/ as well as src/", () => {
    fixture({ indexSource: "export const nothing = 0;\n" });
    mkdirSync(join(root, "packages/leaf/tests"), { recursive: true });
    writeFileSync(join(root, "packages/leaf/tests/index.test.ts"), 'import { thing } from "../../../scripts/lib/thing.mjs";\n\nexnexport const carried = thing;\n');
    expect(evaluatePackageBoundaries({ root }).findings).toEqual([
      "packages/leaf/tests/index.test.ts: ../../../scripts/lib/thing.mjs is not permitted by @fixture/leaf.forbidden_source_roots",
    ]);
  });

  it("leaves a relative import that stays inside the package alone", () => {
    fixture({ indexSource: 'import { local } from "./local.ts";\n\nexport const carried = local;\n' });
    expect(evaluatePackageBoundaries({ root })).toMatchObject({ ok: true, findings: [] });
  });

  it("honours a policy that declares no forbidden roots at all", () => {
    fixture({
      indexSource: 'import { thing } from "../../../scripts/lib/thing.mjs";\n\nexport const carried = thing;\n',
      forbiddenSourceRoots: null,
    });
    expect(evaluatePackageBoundaries({ root })).toMatchObject({ ok: true, findings: [] });
  });

  it("rejects a malformed forbidden_source_roots rather than silently disabling it", () => {
    fixture({ indexSource: "export const nothing = 0;\n", forbiddenSourceRoots: "scripts/" });
    expect(evaluatePackageBoundaries({ root })).toMatchObject({ ok: false, findings: ["forbidden_source_roots must be a duplicate-free array"] });
  });
});

describe("gate:package-boundaries — workspace import matrix (unchanged)", () => {
  it("still reports an unpermitted @arbor/* import with its original vocabulary", () => {
    fixture({ indexSource: 'import { thing } from "@arbor/core";\n\nexport const carried = thing;\n' });
    const report = evaluatePackageBoundaries({ root });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(["packages/leaf/src/index.ts: @arbor/core is not permitted by @fixture/leaf.source_imports"]);
  });

  it("still permits a declared @arbor/* import and counts it", () => {
    fixture({ indexSource: 'import { thing } from "@arbor/core";\n\nexport const carried = thing;\n', sourceImports: ["@arbor/core"] });
    expect(evaluatePackageBoundaries({ root })).toMatchObject({ ok: true, findings: [], imports: 1 });
  });

  it("does not count a forbidden-root hit as a workspace import", () => {
    fixture({ indexSource: 'import { thing } from "../../../scripts/lib/thing.mjs";\n\nexport const carried = thing;\n' });
    expect(evaluatePackageBoundaries({ root }).imports).toBe(0);
  });
});

describe("gate:package-boundaries — the real repository", () => {
  it("stays clean with no package importing across into scripts/", () => {
    expect(evaluatePackageBoundaries({ root: REPO_ROOT })).toMatchObject({ ok: true, findings: [] });
  });
});