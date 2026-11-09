import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIntentGraph } from "../../src/vi/intent.js";

/**
 * intent-source-roots.test.ts — Roadmap 23 B2's acceptance test for
 * vi/intent.ts's `deriveCitations`, which previously joined the literal
 * `"packages"` onto `repoRoot` regardless of the profile's `source_roots`.
 * A fixture whose sources live under `src/` had every ADR-NNN citation
 * inside it silently missed: `walkAllFiles` would try to read a nonexistent
 * `packages/` directory, catch the ENOENT, and return an empty file list —
 * an intent graph indistinguishable from a real project with zero
 * citations, exactly the false-measurement failure Roadmap 23 §5 names.
 */

function adr(num: string, title: string, status: string): string {
  return [
    `# ADR-${num}: ${title}`,
    `**Status:** ${status}`,
    `**Date:** 2026-01-01`,
    ``,
    `## Context`,
    ``,
    `Some context.`,
    ``,
    `## Decision`,
    ``,
    `We decided it.`,
    ``,
    `## Consequences`,
    ``,
    `Some consequences.`,
    ``,
  ].join("\n");
}

let tmpRoot: string | null = null;

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

function buildFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-governance-intent-source-roots-"));
  const decisionsDir = join(root, "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(join(decisionsDir, "ADR-001-governed.md"), adr("001", "Governed decision", "Accepted"));

  // Sources live under src/, not packages/.
  const srcDir = join(root, "src", "widget", "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "citing.ts"), "// governed by ADR-001\nexport const x = 1;\n");

  return root;
}

describe("buildIntentGraph — source_roots portability (Roadmap 23 B2)", () => {
  it("with sourceRoots omitted, a src/-shaped fixture's citation is silently missed — the defect this change closes", () => {
    tmpRoot = buildFixtureRepo();
    const result = buildIntentGraph(tmpRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations).toEqual([]);
    // ADR-001 is Accepted and (as far as this default-rooted scan can see)
    // governs nothing -> reported as an orphan, a false negative caused
    // entirely by looking in the wrong directory.
    expect(result.value.orphanRecordIds).toEqual(["ADR-001"]);
  });

  it("with sourceRoots: ['src'], the fixture's citation under src/widget/src is found and ADR-001 is governed, not orphaned", () => {
    tmpRoot = buildFixtureRepo();
    const result = buildIntentGraph(tmpRoot, { sourceRoots: ["src"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations).toEqual([
      { recordId: "ADR-001", citingPath: "src/widget/src/citing.ts", line: 1, isTest: false },
    ]);
    expect(result.value.orphanRecordIds).toEqual([]);
  });
});
