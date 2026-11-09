import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assessAnalyzerApplicability, computeDiffChangedFiles, computeSiblingSiteNote } from "@arbor/campaign-support";

const BUG_LINE = '  if (value === "PLANTED_BUG_MARKER_TEXT") { return true; }';
const FIXED_LINE = '  if (value === "CORRECTED_MARKER_TEXT") { return true; }';

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "sibling-scan-"));
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  writeFileSync(join(repo, "a.js"), `function checkA(value) {\n${BUG_LINE}\n  return false;\n}\n`);
  writeFileSync(join(repo, "b.js"), `function checkB(value) {\n${BUG_LINE}\n  return false;\n}\n`);
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });
  return repo;
}

describe("computeSiblingSiteNote", () => {
  it("reports the remaining sibling location when only one of two identical sites was fixed", () => {
    const repo = initRepo();
    try {
      const content = require("node:fs").readFileSync(join(repo, "a.js"), "utf-8") as string;
      writeFileSync(join(repo, "a.js"), content.replace(BUG_LINE, FIXED_LINE));
      const note = computeSiblingSiteNote(repo);
      expect(note).toContain("Sibling-site scan");
      expect(note).toContain("1 occurrence(s)");
      expect(note).toContain("b.js:2");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns an empty string when both identical sites were fixed", () => {
    const repo = initRepo();
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      for (const file of ["a.js", "b.js"]) {
        const content = fs.readFileSync(join(repo, file), "utf-8") as string;
        fs.writeFileSync(join(repo, file), content.replace(BUG_LINE, FIXED_LINE));
      }
      expect(computeSiblingSiteNote(repo)).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns an empty string when there is no diff at all", () => {
    const repo = initRepo();
    try {
      expect(computeSiblingSiteNote(repo)).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("degrades silently on a non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "sibling-scan-nongit-"));
    try {
      writeFileSync(join(dir, "a.js"), "not a git repo\n");
      expect(computeSiblingSiteNote(dir)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades silently on a nonexistent path (spawn error)", () => {
    expect(computeSiblingSiteNote("/nonexistent/path/does/not/exist")).toBe("");
  });

  it("degrades silently when the wall budget is exhausted before the scan can run", () => {
    const repo = initRepo();
    try {
      const content = require("node:fs").readFileSync(join(repo, "a.js"), "utf-8") as string;
      writeFileSync(join(repo, "a.js"), content.replace(BUG_LINE, FIXED_LINE));
      // A real sibling site exists, but a zero-ms budget must still produce no note.
      expect(computeSiblingSiteNote(repo, { wallBudgetMs: 0 })).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/**
 * Y-3 (BLINDSPOT-MANIFEST class 5, "silent no-op on foreign substrates"):
 * `computeSiblingSiteNote` itself is a plain `git grep -F` text match and
 * genuinely works over any language -- but the downstream JS-shaped
 * mutation-probe/generated-oracle amplifier `loop.ts` feeds with its
 * output are not. Proves `applicable: false` with a reason on a REAL
 * Python worktree carrying the identical two-site-bug shape
 * `sibling-scan.test.ts`'s own JS fixture uses, and `applicable: true` on
 * the JS/TS one -- the exact fixture pairing the manifest calls for.
 */
function initPythonRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "sibling-scan-py-"));
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  const bugLine = '    if value == "PLANTED_BUG_MARKER_TEXT":\n        return True';
  writeFileSync(join(repo, "a.py"), `def check_a(value):\n${bugLine}\n    return False\n`);
  writeFileSync(join(repo, "b.py"), `def check_b(value):\n${bugLine}\n    return False\n`);
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });
  return repo;
}

describe("computeDiffChangedFiles / assessAnalyzerApplicability — Y-3 analyzer applicability signal", () => {
  it("reports applicable: true for a real JS/TS worktree whose diff changed a JS file, and finds the planted sibling via computeSiblingSiteNote", () => {
    const repo = initRepo();
    try {
      const content = require("node:fs").readFileSync(join(repo, "a.js"), "utf-8") as string;
      writeFileSync(join(repo, "a.js"), content.replace(BUG_LINE, FIXED_LINE));
      expect(computeDiffChangedFiles(repo)).toEqual(["a.js"]);
      expect(assessAnalyzerApplicability(computeDiffChangedFiles(repo))).toEqual({ applicable: true });
      // The applicability signal and the note it gates agree: this substrate
      // IS applicable, and the scan DOES find the planted sibling site.
      expect(computeSiblingSiteNote(repo)).toContain("b.js:2");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports applicable: false with a reason for a real PYTHON worktree carrying an identical two-site bug -- the JS-shaped operators structurally cannot apply, which is NOT the same as 'clean'", () => {
    const repo = initPythonRepo();
    try {
      const fixedLine = '    if value == "CORRECTED_MARKER_TEXT":\n        return True';
      const content = require("node:fs").readFileSync(join(repo, "a.py"), "utf-8") as string;
      writeFileSync(join(repo, "a.py"), content.replace(
        '    if value == "PLANTED_BUG_MARKER_TEXT":\n        return True',
        fixedLine,
      ));
      const changedFiles = computeDiffChangedFiles(repo);
      expect(changedFiles).toEqual(["a.py"]);
      const applicability = assessAnalyzerApplicability(changedFiles);
      expect(applicability.applicable).toBe(false);
      expect(applicability.reason).toContain(".py");
      expect(applicability.reason).toMatch(/JS\/TS/);
      // Sanity: the SAME two-site-bug shape as the JS fixture is present
      // here (the sibling scan itself is language-agnostic and still finds
      // it) -- applicability is a SEPARATE signal from "did the text scan
      // find anything," exactly the distinction Y-3 exists to add.
      expect(computeSiblingSiteNote(repo)).toContain("b.py:2");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("applicable: false, distinct reason, when the diff has no changed files at all", () => {
    expect(assessAnalyzerApplicability([])).toEqual({ applicable: false, reason: "no changed files in this node's diff to assess" });
  });

  it("computeDiffChangedFiles degrades silently (empty array) on a non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "sibling-scan-nongit-changed-"));
    try {
      writeFileSync(join(dir, "a.py"), "not a git repo\n");
      expect(computeDiffChangedFiles(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
