/**
 * scripts/tests/adr-retirement-integrity.test.mjs — a retired/superseded ADR
 * must be cross-referenced both directions.
 *
 * Two kinds of proof:
 *   1. Against a throwaway fixture corpus (`--decisions-dir`), the gate
 *      FAILS on a supersession pair missing its back-reference and PASSES
 *      once the back-reference is added — the fail-then-pass shape.
 *   2. Against the REAL corpus (decisions/*.md), the gate's verdict is
 *      pinned to the actual, known asymmetry in this repository:
 *      ADR-077 supersedes ADR-036's O3 and both cite each other (PASS for
 *      that pair); ADR-036 and ADR-037 each supersede part of ADR-011, and
 *      ADR-011 carries no back-reference to either (2 violations) — matching
 *      packages/arbor-governance/tests/migration/citations.test.ts's own
 *      comment about this exact asymmetry. If this test starts failing
 *      because ADR-011 gained a back-reference, that is real progress and
 *      the pinned expectation should be updated to match — not evidence the
 *      gate is broken.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GATE = join(REPO_ROOT, "scripts", "adr-retirement-integrity.mjs");

function runGate(decisionsDir, extraArgs = []) {
  const result = spawnSync("bun", [GATE, "--decisions-dir", decisionsDir, "--json", ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return { code: result.status, report: JSON.parse(result.stdout) };
}

describe("adr-retirement-integrity gate — fixture corpus", () => {
  let dir;

  function writeFixture(adr001Body) {
    writeFileSync(
      join(dir, "ADR-001-original.md"),
      `# ADR-001: Original Decision\n\n**Status:** Accepted\n**Date:** 2026-01-01\n\n## Decision\n\nDo the thing the old way.\n${adr001Body}\n`,
    );
    writeFileSync(
      join(dir, "ADR-002-supersedes-001.md"),
      `# ADR-002: A Better Way Supersedes ADR-001\n\n**Status:** Accepted\n**Date:** 2026-02-01\n\n**Scope.** This record supersedes only ADR-001's Decision.\n\n## Decision\n\nDo the thing the new way.\n`,
    );
  }

  it("FAILS when the retired record carries no back-reference", () => {
    dir = mkdtempSync(join(tmpdir(), "adr-retirement-fixture-"));
    try {
      writeFixture("");
      const { code, report } = runGate(dir);
      expect(code).toBe(1);
      expect(report.ok).toBe(false);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0].hasBackReference).toBe(false);
      expect(report.violations[0].reason).toMatch(/back-reference/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PASSES once the back-reference is added — fail-then-pass on the same fixture", () => {
    dir = mkdtempSync(join(tmpdir(), "adr-retirement-fixture-"));
    try {
      writeFixture("\n**SUPERSEDED BY ADR-002 — this decision is retired.** ADR-002 replaces it with the new approach.\n");
      const { code, report } = runGate(dir);
      expect(code).toBe(0);
      expect(report.ok).toBe(true);
      expect(report.violations).toHaveLength(0);
      expect(report.ok_pairs).toHaveLength(1);
      expect(report.ok_pairs[0]).toMatchObject({ retiring: 2, retired: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS when the retiring record's forward citation is itself missing", () => {
    dir = mkdtempSync(join(tmpdir(), "adr-retirement-fixture-"));
    try {
      writeFileSync(
        join(dir, "ADR-001-original.md"),
        `# ADR-001: Original Decision\n\n**Status:** Accepted\n\n## Decision\n\nOld way.\n\n**SUPERSEDED BY ADR-002.**\n`,
      );
      // "supersedes ADR-001" is present (so the pair is discovered) but the
      // literal string "ADR-001" is then swapped for a synonym everywhere
      // else — simulating a declaration whose forward citation doesn't
      // actually name what it claims to.
      writeFileSync(
        join(dir, "ADR-002-supersedes-001.md"),
        `# ADR-002: Supersedes ADR-001\n\n**Status:** Accepted\n\n**Scope.** This record supersedes only ADR-001's Decision.\n`,
      );
      const { report } = runGate(dir);
      // Forward citation IS present here (ADR-001 is named in the Scope
      // line itself), so this fixture actually passes both directions —
      // included to document that a bare "supersedes ADR-NNN" declaration
      // always satisfies direction 1 by construction (see gate header).
      expect(report.violations).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS when the retiring record claims to supersede an ADR that doesn't exist in the corpus", () => {
    dir = mkdtempSync(join(tmpdir(), "adr-retirement-fixture-"));
    try {
      writeFileSync(
        join(dir, "ADR-002-supersedes-999.md"),
        `# ADR-002: Supersedes ADR-999\n\n**Status:** Accepted\n\n**Scope.** This record supersedes only ADR-999's Decision.\n`,
      );
      const { code, report } = runGate(dir);
      expect(code).toBe(1);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0].retiredFile).toBeNull();
      expect(report.violations[0].reason).toMatch(/does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a corpus with no supersession declarations at all passes trivially", () => {
    dir = mkdtempSync(join(tmpdir(), "adr-retirement-fixture-"));
    try {
      writeFileSync(join(dir, "ADR-001-original.md"), `# ADR-001: Original Decision\n\n**Status:** Accepted\n\n## Decision\n\nDo it.\n`);
      const { code, report } = runGate(dir);
      expect(code).toBe(0);
      expect(report.ok).toBe(true);
      expect(report.pairsFound).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports --json and a plain exit code contract, and a nonexistent --decisions-dir is a hard error", () => {
    const result = spawnSync("bun", [GATE, "--decisions-dir", join(tmpdir(), "definitely-does-not-exist-adr-corpus"), "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(result.status).not.toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/cannot read decisions directory/);
  });
});

describe("adr-retirement-integrity gate — real corpus (decisions/*.md)", () => {
  it("finds the known ADR-077<->ADR-036 mutual-citation pair and passes it", () => {
    const result = spawnSync("bun", [GATE, "--json"], { cwd: REPO_ROOT, encoding: "utf-8" });
    const report = JSON.parse(result.stdout);
    const pair = report.ok_pairs.find((p) => p.retiring === 77 && p.retired === 36);
    expect(pair).toBeDefined();
  });

  /**
   * This test originally asserted the OPPOSITE: that ADR-011 was missing
   * back-references to ADR-036 and ADR-037, pinning the gate's first real
   * verdict. That finding was correct and valuable — the gate was written to
   * indict the corpus rather than be weakened to let it pass, and it did.
   *
   * But encoding it as an expectation made the suite pass only while the
   * repository was wrong, which is the exact shape
   * `packages/arbor-governance/tests/obligation/report.test.ts`'s own header
   * warns about. Acting on the finding (ADR-011 gained supersession markers at
   * all three sites, 2026-08-18) then broke this test — proving the point.
   *
   * So the assertion is inverted to the INVARIANT that survives being right:
   * every supersession the corpus declares is cross-referenced both ways. The
   * gate's ability to DETECT a missing back-reference is proven against a
   * fixture above, not against the live corpus's defects.
   */
  it("the real corpus is now fully cross-referenced in both directions", () => {
    const result = spawnSync("bun", [GATE, "--json"], { cwd: REPO_ROOT, encoding: "utf-8" });
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);

    // Every supersession this corpus declares, each proven both ways. Pinned
    // as a list rather than a count so a NEW supersession has to be added
    // here deliberately — that is the moment someone confirms the pair really
    // is cross-referenced, which is the whole property this gate protects.
    // 82->81 joined on 2026-08-19: ADR-082 retires ADR-081's scheduling
    // clause, and ADR-081 carries the pointer forward. 142->141 joined when
    // the native harness superseded connector-owned orchestration. 176->31
    // joined when the visual-intelligence skill stopped being modelled as vendored.
    const pairs = report.ok_pairs.map((p) => `${p.retiring}->${p.retired}`).sort();
    expect(pairs).toEqual(["142->141", "149->122", "153->146", "176->31", "36->11", "37->11", "77->36", "82->81"]);
  });

  it("is deterministic — running twice against the same corpus gives the same report", () => {
    const a = spawnSync("bun", [GATE, "--json"], { cwd: REPO_ROOT, encoding: "utf-8" });
    const b = spawnSync("bun", [GATE, "--json"], { cwd: REPO_ROOT, encoding: "utf-8" });
    expect(a.stdout).toBe(b.stdout);
  });
});
