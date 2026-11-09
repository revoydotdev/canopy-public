import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDuplicateSymbolIdentities, POL_DUPLICATE_SYMBOL_ID } from "../../src/artifact/duplicates.js";

// vitest is invoked from the repo root (`npx vitest run ...`), so process.cwd()
// is the real repo root — matching scan.test.ts's own convention, since
// `checkDuplicateSymbolIdentities` calls `scan()` under the hood.
const REPO_ROOT = process.cwd();
const AT = "2026-08-06T00:00:00.000Z";

describe("checkDuplicateSymbolIdentities — the real repo", () => {
  it("returns [] against the real repository (no known same-package duplicate export today)", () => {
    // ADR-011 forces the one known live collision (PHASE_DURATION_BUCKETS_MS,
    // see scan.test.ts) to be CROSS-package, which is not what POL-06
    // flags — same symbol_id (package::export) requires the SAME package.
    // This test pins today's honest, real measurement rather than asserting
    // a property that happens to hold; if the repo ever grows a genuine
    // same-package duplicate export, this test is expected to need updating
    // to reflect the real finding, not to be loosened to tolerate drift.
    const findings = checkDuplicateSymbolIdentities(REPO_ROOT, { at: AT });
    expect(findings).toEqual([]);
  });

  it("is deterministic across two calls", () => {
    const first = checkDuplicateSymbolIdentities(REPO_ROOT, { at: AT });
    const second = checkDuplicateSymbolIdentities(REPO_ROOT, { at: AT });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("checkDuplicateSymbolIdentities — a fixture repo with a genuine same-package duplicate", () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("flags one finding per colliding file when two files in ONE package export the same name", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "arbor-governance-duplicates-"));
    const srcDir = join(tmpRoot, "packages", "widget", "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a.ts"), "export function helper(): number { return 1; }\n");
    writeFileSync(join(srcDir, "b.ts"), "export function helper(): number { return 2; }\n");

    const findings = checkDuplicateSymbolIdentities(tmpRoot, { at: AT });
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.rule_id === POL_DUPLICATE_SYMBOL_ID)).toBe(true);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
    expect(findings.every((f) => f.waiver_eligible === true)).toBe(true);
    expect(findings.every((f) => f.is_legacy_debt === false)).toBe(true);

    const subjectPaths = findings.map((f) => (f.subject as { path: string }).path).sort();
    expect(subjectPaths).toEqual(["packages/widget/src/a.ts", "packages/widget/src/b.ts"]);
    expect(findings[0].detail).toContain("helper");
    expect(findings[0].detail).toContain("widget");
  });

  it("does NOT flag the same name declared in two DIFFERENT packages (that is symbol_id-distinct, not a collision)", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "arbor-governance-duplicates-"));
    const srcA = join(tmpRoot, "packages", "alpha", "src");
    const srcB = join(tmpRoot, "packages", "beta", "src");
    mkdirSync(srcA, { recursive: true });
    mkdirSync(srcB, { recursive: true });
    writeFileSync(join(srcA, "a.ts"), "export function helper(): number { return 1; }\n");
    writeFileSync(join(srcB, "b.ts"), "export function helper(): number { return 1; }\n");

    const findings = checkDuplicateSymbolIdentities(tmpRoot, { at: AT });
    expect(findings).toEqual([]);
  });

  it("returns [] for a repository with no packages/ directory at all, rather than throwing", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "arbor-governance-duplicates-empty-"));
    const findings = checkDuplicateSymbolIdentities(tmpRoot, { at: AT });
    expect(findings).toEqual([]);
  });
});
