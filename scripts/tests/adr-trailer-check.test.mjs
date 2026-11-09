/**
 * scripts/tests/adr-trailer-check.test.mjs — the commit-msg ADR-trailer guard.
 *
 * The guard exists to make gate:adr-trace's rule enforceable at commit time
 * rather than after a rebind. That only holds if it actually refuses, so the
 * shape asserted here is fail-then-pass: a governed change with no trailer is
 * refused, the same change with a trailer is accepted, and an ungoverned change
 * is never touched.
 *
 * The trailer matcher is asserted separately from the path logic because the two
 * failure modes are different: a matcher that accepts prose mentioning an ADR
 * would pass commits gate:adr-trace then refuses, and a path list that drifts
 * from adr-trace's own would do the same. The guard imports that list rather
 * than restating it, so this file pins the matcher and the composition.
 */
import { describe, it, expect } from "vitest";
import { governedStagedPaths, hasAdrTrailer, unresolvedAdrReferences } from "../adr-trailer-check.mjs";
import { governedPathPrefixes } from "../adr-trace.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("hasAdrTrailer", () => {
  it("accepts a real trailer, single and multiple", () => {
    expect(hasAdrTrailer("subject\n\nbody\n\nADR: 149")).toBe(true);
    expect(hasAdrTrailer("subject\n\nADR: 037, 149")).toBe(true);
    expect(hasAdrTrailer("subject\n\nADR: 85, 146\n")).toBe(true);
  });

  it("rejects prose that merely mentions an ADR", () => {
    // A body discussing ADR-149 is not a claim that ADR-149 governs the change;
    // accepting it here would pass commits gate:adr-trace goes on to refuse.
    expect(hasAdrTrailer("subject\n\nThis implements ADR-149's decision 7.")).toBe(false);
    expect(hasAdrTrailer("subject\n\nSee ADR: the record explains why.")).toBe(false);
    expect(hasAdrTrailer("ADR-149\n")).toBe(false);
  });

  it("rejects a message with no trailer at all", () => {
    expect(hasAdrTrailer("fix: something\n\nA body with no trailer.\n")).toBe(false);
    expect(hasAdrTrailer("")).toBe(false);
  });
});

describe("governed path selection", () => {
  const prefixes = governedPathPrefixes(REPO_ROOT);

  it("uses adr-trace's own derived prefixes, including scripts/ and decisions/", () => {
    // Two copies of this list is how the guard and the gate come to disagree.
    expect(prefixes).toContain("scripts");
    expect(prefixes).toContain("decisions");
    expect(prefixes.some((p) => p.startsWith("packages"))).toBe(true);
  });

  it("selects governed paths and ignores the rest", () => {
    const staged = [
      "packages/arbor-tui/src/renderer.ts",
      "decisions/interviews.jsonl",
      "scripts/hooks/commit-msg",
      "README.md",
      "docs/postmortems/note.md",
      "artifacts/tui-reel-2026-08-29/ASSESSMENT.md",
    ];
    const governed = governedStagedPaths(staged, prefixes);
    expect(governed).toContain("packages/arbor-tui/src/renderer.ts");
    expect(governed).toContain("decisions/interviews.jsonl");
    expect(governed).toContain("scripts/hooks/commit-msg");
    expect(governed).not.toContain("README.md");
    expect(governed).not.toContain("docs/postmortems/note.md");
    expect(governed).not.toContain("artifacts/tui-reel-2026-08-29/ASSESSMENT.md");
  });

  it("does not treat a path that merely starts with a prefix's letters as governed", () => {
    // "scriptsy/" is not "scripts/"; a naive startsWith would claim it.
    expect(governedStagedPaths(["scriptsy/thing.mjs", "packagesomething/x.ts"], prefixes)).toEqual([]);
  });

  it("refuses exactly when a governed path is staged without a trailer", () => {
    const decide = (paths, message) =>
      !hasAdrTrailer(message) && governedStagedPaths(paths, prefixes).length > 0;

    expect(decide(["packages/arbor-tui/src/renderer.ts"], "fix: no trailer")).toBe(true);
    expect(decide(["packages/arbor-tui/src/renderer.ts"], "fix: with\n\nADR: 149")).toBe(false);
    expect(decide(["README.md"], "docs: no trailer")).toBe(false);
    expect(decide([], "chore: nothing staged")).toBe(false);
  });
});

describe("unresolvedAdrReferences — a trailer is not a citation unless it resolves", () => {
  // The matcher above only proves a trailer was TYPED. `ADR: 999` satisfies it,
  // and satisfied gate:adr-trace too. 13 commits in this repository carry
  // `ADR: 148`, which has no file, no allocation and no index row.
  const known = new Set([37, 86, 149, 154]);

  it("names the numbers that answer to nothing", () => {
    expect(unresolvedAdrReferences("subject\n\nADR: 999", known)).toEqual([999]);
    expect(unresolvedAdrReferences("subject\n\nADR: 148", known)).toEqual([148]);
  });

  it("is empty when every cited number resolves", () => {
    expect(unresolvedAdrReferences("subject\n\nADR: 154", known)).toEqual([]);
    expect(unresolvedAdrReferences("subject\n\nADR: 037, 149", known)).toEqual([]);
  });

  it("counts a reserved cross-namespace number as resolving", () => {
    // The registry's `reserved` set cites another repository's decisions on
    // purpose; those are real references with no local file.
    expect(unresolvedAdrReferences("subject\n\nADR: 086", known)).toEqual([]);
  });

  it("still names a bogus number alongside a real one, for the message", () => {
    // The guard does not REFUSE this case -- the change is governed by 154 --
    // but the caller can still surface the dangling number.
    expect(unresolvedAdrReferences("subject\n\nADR: 154, 999", known)).toEqual([999]);
  });
});
