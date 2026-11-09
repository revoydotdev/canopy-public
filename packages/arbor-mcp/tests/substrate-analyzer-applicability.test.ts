/**
 * Y-3 (BLINDSPOT-MANIFEST class 5, "silent no-op on foreign substrates"):
 * every advisory generator in this workstream's ownership (the mutation
 * probe's string-level operators, the generated-oracle amplifier's Node/JS
 * test runner) degrades to "no finding" by design on a substrate it cannot
 * analyze -- indistinguishable, from the outside, from "analyzed, found
 * nothing." This suite proves the new `assessMutationProbeApplicability`/
 * `assessAmplifierApplicability` signals (additive, alongside the existing
 * finding-array returns -- `probeMutations`/`amplifySiblingSites`'
 * signatures are UNCHANGED, so `cli.ts`'s existing wiring is unaffected)
 * tell the two apart, with real fixture worktrees on both sides: a JS/TS
 * worktree (applicable, and the sibling scan/mutation candidates it would
 * feed downstream actually find the planted two-site bug) and a real
 * PYTHON fixture worktree carrying the IDENTICAL two-site bug shape, where
 * the JS-shaped operators report `applicable: false` with a reason rather
 * than a silent empty list.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  assessMutationProbeApplicability,
  selectCandidateSites,
  type MutationSite,
} from "../src/mutation-probe.js";
import {
  assessAmplifierApplicability,
  type FlaggedSiblingSite,
} from "../src/test-amplifier.js";

describe("assessMutationProbeApplicability — pure, additive, no filesystem or command-port calls", () => {
  it("applicable: true when at least one candidate site is JS/TS-shaped", () => {
    const sites: MutationSite[] = [{ file: "src/a.ts", line: 3 }, { file: "src/b.py", line: 9 }];
    expect(assessMutationProbeApplicability(sites)).toEqual({ applicable: true });
  });

  it("applicable: false with a reason naming the observed extensions when every site is non-JS/TS", () => {
    const sites: MutationSite[] = [{ file: "src/a.py", line: 3 }, { file: "src/b.rb", line: 9 }];
    const result = assessMutationProbeApplicability(sites);
    expect(result.applicable).toBe(false);
    expect(result.reason).toContain(".py");
    expect(result.reason).toContain(".rb");
    expect(result.reason).toMatch(/JS\/TS/);
  });

  it("applicable: false, distinct reason, for an empty site list", () => {
    expect(assessMutationProbeApplicability([])).toEqual({ applicable: false, reason: "no candidate sites (empty diff∪sibling union) to assess" });
  });

  it("recognizes every JS/TS-family extension this module's operators target", () => {
    for (const ext of [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]) {
      expect(assessMutationProbeApplicability([{ file: `x${ext}`, line: 1 }])).toEqual({ applicable: true });
    }
  });

  it("a file with no extension at all is treated as non-applicable, not a crash", () => {
    const result = assessMutationProbeApplicability([{ file: "Makefile", line: 1 }]);
    expect(result.applicable).toBe(false);
    expect(result.reason).toContain("(no extension)");
  });

  it("composes with selectCandidateSites -- applicability over the SAME diff∪sibling union the probe itself dispatches from", () => {
    const diff: MutationSite[] = [{ file: "a.py", line: 1 }];
    const sibling: MutationSite[] = [{ file: "b.py", line: 2 }];
    const union = selectCandidateSites(diff, sibling);
    expect(assessMutationProbeApplicability(union).applicable).toBe(false);
  });
});

describe("assessAmplifierApplicability — pure, additive, no model or command-port calls", () => {
  it("applicable: true for a JS/TS flagged site", () => {
    const sites: FlaggedSiblingSite[] = [{ pattern: "if (x > MAX)", file: "lib/sibling.ts", line: 10 }];
    expect(assessAmplifierApplicability(sites)).toEqual({ applicable: true });
  });

  it("applicable: false with a reason for an all-Python flagged-site list", () => {
    const sites: FlaggedSiblingSite[] = [{ pattern: "if value == MAX:", file: "lib/sibling.py", line: 10 }];
    const result = assessAmplifierApplicability(sites);
    expect(result.applicable).toBe(false);
    expect(result.reason).toContain(".py");
    expect(result.reason).toMatch(/Node\/JS/);
  });

  it("applicable: false, distinct reason, for an empty flagged-site list", () => {
    expect(assessAmplifierApplicability([])).toEqual({ applicable: false, reason: "no flagged sibling sites to assess" });
  });
});

// --------------------------------------------------------------------
// Real fixture worktrees: JS/TS (applicable) vs Python (not applicable),
// both carrying the identical two-site bug shape.
// --------------------------------------------------------------------

const directories: string[] = [];
function git(cwd: string, ...args: string[]): void {
  spawnSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}
function freshRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  directories.push(repo);
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  return repo;
}
function cleanupFixtures(): void {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Parses `git diff --unified=0` old-side (`-`) lines into MutationSite-shaped candidates, mirroring mutation-probe.ts's own diff∪sibling union construction closely enough to exercise applicability realistically without importing arbor-opencode's sibling-scan.ts (dependency direction forbids it -- see sibling-scan.ts's own doc comment). */
function candidateSitesFromDiff(repo: string): MutationSite[] {
  const result = spawnSync("git", ["-C", repo, "diff", "--unified=0"], { encoding: "utf-8" });
  const sites: MutationSite[] = [];
  let currentFile: string | null = null;
  let oldLine = 0;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("--- a/")) { currentFile = line.slice(6); continue; }
    const hunk = /^@@ -(\d+)/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); continue; }
    if (line.startsWith("-") && !line.startsWith("---") && currentFile !== null) {
      sites.push({ file: currentFile, line: oldLine });
      oldLine += 1;
    }
  }
  return sites;
}

describe("real fixture worktrees: JS/TS applicable + finds the planted sibling, Python not applicable", () => {
  it("JS/TS worktree: applicable: true, and the same diff's candidate sites include the still-buggy sibling file", () => {
    const repo = freshRepo("arbor-applicability-js-");
    try {
      const BUG = '  if (value === "PLANTED_BUG_MARKER_TEXT") { return true; }';
      const FIXED = '  if (value === "CORRECTED_MARKER_TEXT") { return true; }';
      writeFileSync(join(repo, "a.js"), `function checkA(value) {\n${BUG}\n  return false;\n}\n`);
      writeFileSync(join(repo, "b.js"), `function checkB(value) {\n${BUG}\n  return false;\n}\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "init");

      // Fix only a.js -- b.js keeps the identical planted bug (the exact
      // "fixed 1 of 2 identical sites" shape this workstream's manifest
      // motivates class 5 with).
      const content = readFileSync(join(repo, "a.js"), "utf-8");
      writeFileSync(join(repo, "a.js"), content.replace(BUG, FIXED));

      const sites = candidateSitesFromDiff(repo);
      expect(sites).toEqual([{ file: "a.js", line: 2 }]);
      expect(assessMutationProbeApplicability(sites)).toEqual({ applicable: true });

      // The planted sibling bug is genuinely still there and findable via a
      // real `git grep` over the tracked tree, on this JS/TS substrate.
      const grep = spawnSync("git", ["-C", repo, "grep", "-F", "-n", BUG.trim()], { encoding: "utf-8" });
      expect(grep.stdout).toContain("b.js");
    } finally {
      cleanupFixtures();
    }
  });

  it("PYTHON worktree carrying the IDENTICAL two-site bug: applicable: false with a reason, never a silent empty list", () => {
    const repo = freshRepo("arbor-applicability-py-");
    try {
      const BUG = '    if value == "PLANTED_BUG_MARKER_TEXT":\n        return True';
      const FIXED = '    if value == "CORRECTED_MARKER_TEXT":\n        return True';
      writeFileSync(join(repo, "a.py"), `def check_a(value):\n${BUG}\n    return False\n`);
      writeFileSync(join(repo, "b.py"), `def check_b(value):\n${BUG}\n    return False\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "init");

      const content = readFileSync(join(repo, "a.py"), "utf-8");
      writeFileSync(join(repo, "a.py"), content.replace(BUG, FIXED));

      const sites = candidateSitesFromDiff(repo);
      expect(sites.length).toBeGreaterThan(0);
      expect(sites.every((site) => site.file === "a.py")).toBe(true);

      const applicability = assessMutationProbeApplicability(sites);
      expect(applicability).toEqual({
        applicable: false,
        reason: expect.stringContaining(".py"),
      });
      expect(applicability.reason).toMatch(/JS\/TS/);

      // The identical bug shape is genuinely present at b.py too -- proving
      // this is "cannot apply here," not "there was nothing to find."
      const grep = spawnSync("git", ["-C", repo, "grep", "-F", "-n", '"PLANTED_BUG_MARKER_TEXT"'], { encoding: "utf-8" });
      expect(grep.stdout).toContain("b.py");

      // The amplifier's applicability signal agrees, over the same shape of
      // sites (pattern/file/line rather than file/line).
      const flaggedSites: FlaggedSiblingSite[] = sites.map((site) => ({ pattern: BUG, file: site.file, line: site.line }));
      expect(assessAmplifierApplicability(flaggedSites).applicable).toBe(false);
    } finally {
      cleanupFixtures();
    }
  });
});
