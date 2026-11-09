import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatePackageBoundaries } from "../package-boundary-gate.mjs";
import { evaluateReuseCompliance } from "../reuse-compliance-gate.mjs";

const temporaryRoots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adr147-compliance-"));
  temporaryRoots.push(root);
  return root;
}
function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}
afterEach(() => { while (temporaryRoots.length) rmSync(temporaryRoots.pop(), { recursive: true, force: true }); });

describe("ADR-147 package boundary gate", () => {
  it("accepts a declared core with no internal imports", () => {
    const root = fixture();
    write(root, "packages/arbor-core/package.json", JSON.stringify({ name: "@arbor/core" }));
    write(root, "packages/arbor-core/src/index.ts", "export const answer = 42;\n");
    write(root, "policy.json", JSON.stringify({ schema_version: 1, packages: { "@arbor/core": { path: "packages/arbor-core", source_imports: [], test_imports: [] } } }));
    expect(evaluatePackageBoundaries({ root, policyPath: join(root, "policy.json") })).toMatchObject({ ok: true, imports: 0 });
  });

  it("fails when core imports another workspace package", () => {
    const root = fixture();
    write(root, "packages/arbor-core/package.json", JSON.stringify({ name: "@arbor/core" }));
    write(root, "packages/arbor-core/src/index.ts", "import { fact } from '@arbor/kb'; export { fact };\n");
    write(root, "policy.json", JSON.stringify({ schema_version: 1, packages: { "@arbor/core": { path: "packages/arbor-core", source_imports: [], test_imports: [] } } }));
    const report = evaluatePackageBoundaries({ root, policyPath: join(root, "policy.json") });
    expect(report.ok).toBe(false);
    expect(report.findings.join("\n")).toContain("@arbor/kb is not permitted");
  });
});

describe("ADR-147 reuse compliance gate", () => {
  it("accepts a bounded declared direct dependency inventory", () => {
    const root = fixture();
    write(root, "LICENSE", "MIT License\nCopyright Example\n");
    write(root, "package.json", JSON.stringify({ name: "fixture", dependencies: { demo: "1.0.0" } }));
    write(root, "node_modules/demo/package.json", JSON.stringify({ name: "demo", license: "MIT" }));
    write(root, "policy.json", JSON.stringify({ schema_version: 1, ceiling: "inventory only", repository_license: { path: "LICENSE", spdx: "MIT", required_text: "Copyright Example" }, allowed_direct_dependency_licenses: ["MIT"], direct_dependencies: { demo: { license: "MIT" } }, vendored_sources: [] }));
    expect(evaluateReuseCompliance({ root, policyPath: join(root, "policy.json") })).toMatchObject({ ok: true, dependencies: 1, vendors: 0 });
  });

  it("fails closed for an unclassified direct dependency", () => {
    const root = fixture();
    write(root, "LICENSE", "MIT License\nCopyright Example\n");
    write(root, "package.json", JSON.stringify({ name: "fixture", dependencies: { demo: "1.0.0" } }));
    write(root, "node_modules/demo/package.json", JSON.stringify({ name: "demo", license: "MIT" }));
    write(root, "policy.json", JSON.stringify({ schema_version: 1, ceiling: "inventory only", repository_license: { path: "LICENSE", spdx: "MIT", required_text: "Copyright Example" }, allowed_direct_dependency_licenses: ["MIT"], direct_dependencies: {}, vendored_sources: [] }));
    const report = evaluateReuseCompliance({ root, policyPath: join(root, "policy.json") });
    expect(report.ok).toBe(false);
    expect(report.findings).toContain("direct dependency demo is absent from policy inventory");
  });
});
