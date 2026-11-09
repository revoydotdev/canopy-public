/**
 * scripts/tests/adr-citations.test.mjs — ADR-130's citation gate.
 *
 * Two kinds of proof, matching `adr-retirement-integrity.test.mjs`'s shape:
 *   1. Against throwaway fixture corpora (`--decisions-dir`), unit-level
 *      coverage of the extraction/resolution primitives plus the CLI's
 *      fail-then-pass shape.
 *   2. Against the REAL corpus (decisions/*.md), the gate PASSES at its
 *      pinned floor and catches the one true positive ADR-130 itself names:
 *      ADR-036's `@opentui/core@0.5.1` citation against the actual `0.5.3`
 *      in packages/arbor-tui/package.json. If ADR-036 or the dependency
 *      changes, that specific assertion should be revisited — not evidence
 *      the gate is broken.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractCitations,
  isRetired,
  resetBasenameIndexCache,
  resolveFileCitation,
  resolveSymbolAtFileCitation,
  resolveVersionCitation,
  runCitationsAudit,
  stripFencedCodeBlocks,
  UNRESOLVABLE_CITATIONS_FLOOR,
} from "../adr-citations.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GATE = join(REPO_ROOT, "scripts", "adr-citations.mjs");

// buildBasenameIndex caches per-process, not per-repoRoot — reset it before
// every in-process test (the gate-CLI tests below spawn a fresh subprocess
// each time and are unaffected) so one test's fixture repo can never leak a
// stale basename index into another test using a different root.
beforeEach(() => {
  resetBasenameIndexCache();
});

function runGate(decisionsDir, repoDir, extraArgs = []) {
  const result = spawnSync("bun", [GATE, "--decisions-dir", decisionsDir, "--repo", repoDir, "--json", ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return { code: result.status, report: JSON.parse(result.stdout) };
}

/** Builds a throwaway repo fixture: a `decisions/` dir plus optional real
 * files/manifests under a separate repo root, so file-existence and
 * dependency-version resolution can be exercised against controlled state
 * instead of this repository's live tree. */
function makeFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "adr-citations-fixture-"));
  const decisionsDir = join(root, "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  return { root, decisionsDir };
}

function adr(number, body, status = "Accepted") {
  return `# ADR-${number}: Fixture

**Status:** ${status}
**Date:** 2026-08-26

${body}
`;
}

describe("stripFencedCodeBlocks", () => {
  it("blanks a fenced code block while preserving line offsets", () => {
    const text = "before\n```ts\nconst x = \`fake/path.ts\`;\n```\nafter \`real/path.ts\`";
    const stripped = stripFencedCodeBlocks(text);
    expect(stripped).not.toContain("fake/path.ts");
    expect(stripped).toContain("real/path.ts");
    // line count preserved
    expect(stripped.split("\n").length).toBe(text.split("\n").length);
  });
});

describe("extractCitations", () => {
  it("extracts a bare file citation with a line number", () => {
    const citations = extractCitations("See \`packages/arbor-core/src/index.ts:42\` for details.");
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ kind: "file", file: "packages/arbor-core/src/index.ts", lineCited: 42 });
  });

  it("extracts a dependency-version citation", () => {
    const citations = extractCitations("Pinned to \`@opentui/core@0.5.1\` at authoring time.");
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ kind: "dependency-version", pkg: "@opentui/core", version: "0.5.1" });
  });

  it("extracts a symbol-at-file citation and does not also report it as a bare file citation", () => {
    const citations = extractCitations("The function \`resolveThing\` in \`packages/arbor-core/src/thing.ts\` does X.");
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ kind: "symbol-at-file", symbol: "resolveThing", file: "packages/arbor-core/src/thing.ts" });
  });

  it("does not flag ordinary prose that merely contains a dot", () => {
    const citations = extractCitations("This repository e.g. carries a lot of Inc. and Co. abbreviations, plus v1.2 markers.");
    expect(citations).toHaveLength(0);
  });

  it("does not flag a filename-shaped word outside backticks", () => {
    const citations = extractCitations("Reading index.ts without backticks should not be treated as a citation.");
    expect(citations).toHaveLength(0);
  });

  it("does not flag an unknown extension inside backticks", () => {
    const citations = extractCitations("The vendor ships a \`weird.xyz123\` blob we do not track.");
    expect(citations).toHaveLength(0);
  });

  it("does not flag the `path/to/...` placeholder idiom", () => {
    const citations = extractCitations("A citation looks like \`path/to/file.ts\` or \`path/to/file.ts:N\`.");
    expect(citations).toHaveLength(0);
  });

  it("does not flag an ALL_CAPS environment-variable-style path segment", () => {
    const citations = extractCitations("Resolved relative to \`REPO_ROOT/package.json\` at runtime.");
    expect(citations).toHaveLength(0);
  });

  it("does not flag a literal elision path segment", () => {
    const citations = extractCitations("State lives under \`.../lock/state.json\` once acquired.");
    expect(citations).toHaveLength(0);
  });

  it("ignores citations inside fenced code blocks", () => {
    const citations = extractCitations("Example:\n```ts\nimport x from \`packages/does-not/exist.ts\`;\n```\n");
    expect(citations).toHaveLength(0);
  });
});

describe("resolveFileCitation", () => {
  const { root } = makeFixtureRepo();
  mkdirSync(join(root, "packages", "widget", "src"), { recursive: true });
  writeFileSync(join(root, "packages", "widget", "src", "index.ts"), "line1\nline2\nline3\n");

  it("resolves a real path-qualified file with no line number", () => {
    resetBasenameIndexCache();
    const result = resolveFileCitation("packages/widget/src/index.ts", null, root);
    expect(result.ok).toBe(true);
  });

  it("resolves a real path-qualified file whose cited line is within range", () => {
    resetBasenameIndexCache();
    const result = resolveFileCitation("packages/widget/src/index.ts", 2, root);
    expect(result.ok).toBe(true);
  });

  it("fails when the cited line exceeds the file's actual length", () => {
    resetBasenameIndexCache();
    const result = resolveFileCitation("packages/widget/src/index.ts", 99, root);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/only 4 line/);
  });

  it("fails when the path does not exist at all", () => {
    resetBasenameIndexCache();
    const result = resolveFileCitation("packages/widget/src/missing.ts", null, root);
    expect(result.ok).toBe(false);
  });

  it("resolves a bare filename by searching the whole repository", () => {
    resetBasenameIndexCache();
    const result = resolveFileCitation("index.ts", null, root);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(join("packages", "widget", "src", "index.ts"));
  });

  it("resolves the `<pkg>/...` shorthand missing its `packages/` prefix, when the first segment names a real packages/* dir", () => {
    resetBasenameIndexCache();
    const result = resolveFileCitation("widget/src/index.ts", null, root);
    // "widget" IS a real packages/* dir name in this fixture, so the
    // shorthand (matching this corpus's dominant citation convention —
    // exercised for real against "arbor-core/..." in the CLI-level test
    // below) resolves under packages/ even though the literal, unprefixed
    // path does not exist.
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe("packages/widget/src/index.ts");
  });
});

describe("resolveSymbolAtFileCitation — reuses resolveProofComment, not a second resolver", () => {
  const { root } = makeFixtureRepo();
  mkdirSync(join(root, "packages", "widget", "src"), { recursive: true });
  writeFileSync(join(root, "packages", "widget", "src", "index.ts"), "export function realThing() {}\n");

  it("resolves a symbol that is actually exported at the cited file", () => {
    resetBasenameIndexCache();
    const result = resolveSymbolAtFileCitation("realThing", "index.ts", null, root);
    expect(result.ok).toBe(true);
  });

  it("fails a symbol that does not exist at the cited file", () => {
    resetBasenameIndexCache();
    const result = resolveSymbolAtFileCitation("fakeThing", "index.ts", null, root);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not declared or exported/);
  });
});

describe("resolveVersionCitation", () => {
  const { root } = makeFixtureRepo();
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@some/pkg": "1.2.3" } }));

  it("resolves a version citation that matches the manifest exactly", () => {
    const result = resolveVersionCitation("@some/pkg", "1.2.3", root);
    expect(result.ok).toBe(true);
  });

  it("fails a version citation that does not match the manifest (the ADR-036 shape)", () => {
    const result = resolveVersionCitation("@some/pkg", "1.2.2", root);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cited as 1\.2\.2 but the manifest says 1\.2\.3/);
  });

  it("skips (does not fail) a package absent from every manifest", () => {
    const result = resolveVersionCitation("@nowhere/pkg", "9.9.9", root);
    expect(result.ok).toBe(true);
    expect(result.skip).toBe(true);
  });
});

describe("isRetired", () => {
  it("exempts Retired/Superseded/Rejected status lines, matching gate:adr-sections's convention", () => {
    expect(isRetired("**Status:** Retired\n")).toBe(true);
    expect(isRetired("**Status:** Superseded by ADR-999\n")).toBe(true);
    expect(isRetired("**Status:** Rejected\n")).toBe(true);
    expect(isRetired("**Status:** Accepted\n")).toBe(false);
    expect(isRetired("**Status:** Proposed\n")).toBe(false);
  });
});

describe("gate CLI — fixture corpus, counting mechanism", () => {
  // UNRESOLVABLE_CITATIONS_FLOOR is a fixed constant tuned to the real
  // corpus (116), so a tiny fixture corpus's raw count never exceeds it and
  // `ok`/exit-code stay green regardless — the same shape
  // `adr-sections.test.mjs`'s own ALTERNATIVES_FLOOR test documents. These
  // tests assert the COUNTING mechanism itself: a broken citation is
  // counted, a fixed one is not.
  it("counts a broken file citation and reports its reason", () => {
    const { root, decisionsDir } = makeFixtureRepo();
    writeFileSync(
      join(decisionsDir, "ADR-001-fixture.md"),
      adr(1, "## Context\n\nSee \`packages/does-not/exist.ts\`.\n"),
    );

    const first = runGate(decisionsDir, root);
    expect(first.code).toBe(0);
    expect(first.report.ok).toBe(true);
    expect(first.report.unresolvableCount).toBe(1);
    expect(first.report.violations).toHaveLength(1);
    expect(first.report.violations[0].problems[0].reason).toMatch(/does not exist/);
  });

  it("passes when every citation resolves", () => {
    const { root, decisionsDir } = makeFixtureRepo();
    mkdirSync(join(root, "packages", "widget", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "widget", "src", "index.ts"), "export const x = 1;\n");
    writeFileSync(
      join(decisionsDir, "ADR-001-fixture.md"),
      adr(1, "## Context\n\nSee \`packages/widget/src/index.ts\`.\n"),
    );

    const result = runGate(decisionsDir, root);
    expect(result.code).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.unresolvableCount).toBe(0);
  });

  it("the ratchet FAILS once unresolvable citations rise above the fixed floor", () => {
    const { root, decisionsDir } = makeFixtureRepo();
    // UNRESOLVABLE_CITATIONS_FLOOR is 116 — synthesize more broken citations
    // than that in one fixture record to actually exercise the blocking
    // branch (`adr-sections.test.mjs`'s own floor test never does this,
    // because it would require re-authoring 50 real ADRs; a single
    // synthetic fixture is cheap here and this is the one behavior this
    // gate exists to prove).
    const lines = ["## Context", ""];
    for (let i = 0; i < UNRESOLVABLE_CITATIONS_FLOOR + 5; i++) {
      lines.push(`See \`packages/does-not/exist-${i}.ts\`.`);
    }
    writeFileSync(join(decisionsDir, "ADR-001-fixture.md"), adr(1, lines.join("\n") + "\n"));

    const result = runGate(decisionsDir, root);
    expect(result.report.unresolvableCount).toBe(UNRESOLVABLE_CITATIONS_FLOOR + 5);
    expect(result.report.overFloor).toBe(true);
    expect(result.report.ok).toBe(false);
    expect(result.code).toBe(1);
  });

  it("exempts a Retired record's broken citations entirely", () => {
    const { root, decisionsDir } = makeFixtureRepo();
    writeFileSync(
      join(decisionsDir, "ADR-001-fixture.md"),
      adr(1, "## Context\n\nSee \`packages/does-not/exist.ts\`.\n", "Retired"),
    );

    const result = runGate(decisionsDir, root);
    expect(result.code).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.unresolvableCount).toBe(0);
  });

  it("does not flag ordinary English across a full ADR body", () => {
    const { root, decisionsDir } = makeFixtureRepo();
    writeFileSync(
      join(decisionsDir, "ADR-001-fixture.md"),
      adr(
        1,
        "## Context\n\nThis decision affects e.g. how operators read status. It costs " +
          "roughly $1.5M and takes approx. 3.2 weeks. Dr. Smith and Mr. Jones reviewed it.\n",
      ),
    );

    const result = runGate(decisionsDir, root);
    expect(result.code).toBe(0);
    expect(result.report.citationsChecked).toBe(0);
  });
});

describe("gate CLI — real corpus", () => {
  it("passes at the pinned floor", () => {
    const report = runCitationsAudit(join(REPO_ROOT, "decisions"), REPO_ROOT);
    expect(report.ok).toBe(true);
    expect(report.unresolvableCount).toBeLessThanOrEqual(UNRESOLVABLE_CITATIONS_FLOOR);
  });

  it("catches a dependency-version citation that disagrees with the manifest", () => {
    // Originally this asserted against LIVE ADR-036, which cited
    // @opentui/core@0.5.1 against an actual 0.5.3. That made the test a
    // canary pinned to real corpus content -- it could only stay green while
    // the drift it was watching for stayed UNFIXED, so paying the drift down
    // (the gate's entire purpose) broke it. A regression canary must not
    // depend on the repository staying broken. Rebuilt against a synthetic
    // fixture, so it now proves the detector works regardless of whether any
    // live record happens to be drifted.
    const { root, decisionsDir } = makeFixtureRepo();
    try {
      mkdirSync(join(root, "packages/fixture-pkg"), { recursive: true });
      writeFileSync(join(root, "packages/fixture-pkg/package.json"),
        JSON.stringify({ name: "fixture-pkg", dependencies: { "@opentui/core": "0.5.3" } }, null, 2));
      writeFileSync(join(decisionsDir, "ADR-900-fixture.md"),
        adr("900", "The renderer pins `@opentui/core@0.5.1` exactly."));

      const report = runCitationsAudit(decisionsDir, root);
      const record = report.violations.find((v) => v.file.startsWith("ADR-900-"));
      expect(record).toBeDefined();
      const versionProblem = record.problems.find((p) => p.kind === "dependency-version" && p.citation.includes("@opentui/core"));
      expect(versionProblem).toBeDefined();
      expect(versionProblem.reason).toMatch(/cited as 0\.5\.1 but the manifest says 0\.5\.3/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the corpus's dominant `arbor-<pkg>/...` shorthand (missing the `packages/` prefix) rather than flagging it as broken", () => {
    resetBasenameIndexCache();
    const result = resolveFileCitation("arbor-core/src/capability.ts", null, REPO_ROOT);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe("packages/arbor-core/src/capability.ts");
  });
});
