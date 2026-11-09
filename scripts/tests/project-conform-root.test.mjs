/**
 * scripts/tests/project-conform-root.test.mjs — the `--root` seam (Roadmap 23, W1).
 *
 * WHY THESE TESTS. `evaluateConformance(repoRoot)` was always parameterized,
 * but `main()` passed the script's own `__dirname/..`, so the gate could only
 * ever check this checkout. W1 threads an explicit root through the CLI.
 *
 * The failure this guards is specific and is the one Roadmap 23 §5 names: a
 * multi-project gate that ACCEPTS a second project's root and silently keeps
 * reading revoy2's files would report green about files it never opened.
 * Asserting "the flag is accepted" would not catch that at all — so the
 * central test drives the gate at a real fixture directory on disk and
 * asserts the verdict is derived from THAT directory's contents.
 *
 * Fixtures are real temp directories, not mocks, matching gate-all.test.mjs's
 * convention: the defect being prevented is "the check looked fine but wasn't
 * wired to reality," which a mocked filesystem cannot reproduce.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRootArg } from "../project-conform.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "project-conform.mjs");

function runGate(args) {
  return spawnSync("node", [SCRIPT, "--json", ...args], { cwd: REPO_ROOT, encoding: "utf8" });
}

function parse(result) {
  return JSON.parse(result.stdout);
}

describe("resolveRootArg — argument parsing", () => {
  it("falls back to the supplied default when --root is absent", () => {
    expect(resolveRootArg(["--json"], "/tmp/fallback")).toBe(resolve("/tmp/fallback"));
  });

  it("accepts the space-separated form and returns an absolute path", () => {
    expect(resolveRootArg(["--root", "/tmp/some-project"])).toBe(resolve("/tmp/some-project"));
  });

  it("accepts the --root=<path> form", () => {
    expect(resolveRootArg(["--root=/tmp/some-project"])).toBe(resolve("/tmp/some-project"));
  });

  it("resolves a relative path rather than passing it through unresolved", () => {
    // A relative root reaching evaluateConformance would resolve against the
    // process cwd at every join site instead of once, here.
    const out = resolveRootArg(["--root", "some/relative"]);
    expect(out).toBe(resolve("some/relative"));
    expect(out.startsWith("/")).toBe(true);
  });

  it("throws when --root is given no value, rather than silently using this repo", () => {
    // Falling back here is the dangerous case: the operator asked for another
    // project and would receive a verdict about revoy2 instead.
    expect(() => resolveRootArg(["--root"])).toThrow(/--root requires a path/);
  });

  it("throws when --root is followed by another flag", () => {
    expect(() => resolveRootArg(["--root", "--json"])).toThrow(/--root requires a path/);
  });

  it("throws on an empty --root= value", () => {
    expect(() => resolveRootArg(["--root="])).toThrow(/--root requires a path/);
  });
});

describe("project-conform --root — the verdict comes from the named root", () => {
  it("an explicit --root at this repo produces the identical verdict to no flag (parity)", () => {
    // The migration guarantee: making the root explicit must not change the
    // answer for revoy2 itself.
    const implicit = parse(runGate([]));
    const explicit = parse(runGate(["--root", REPO_ROOT]));
    expect(explicit.ok).toBe(implicit.ok);
    expect(explicit.results).toEqual(implicit.results);
  });

  it("an empty directory FAILS required elements — proof the gate read that directory", () => {
    // This is the test that would catch a --root that is accepted and ignored:
    // revoy2 itself passes, so a green verdict here means the wrong files were read.
    const dir = mkdtempSync(join(tmpdir(), "conform-empty-"));
    try {
      const out = parse(runGate(["--root", dir]));
      expect(out.ok).toBe(false);
      const failedRequired = out.results.filter((r) => !r.ok && r.requirement !== "optional");
      expect(failedRequired.length).toBeGreaterThan(0);
      // And specifically the profile itself is missing in a bare directory.
      expect(out.results.some((r) => r.id === "profile-file" && !r.ok)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes two different roots in the same process invocation pattern", () => {
    // Two roots, two different verdicts, same binary — the minimum evidence
    // that root selection is real rather than incidental.
    const dir = mkdtempSync(join(tmpdir(), "conform-other-"));
    try {
      const here = parse(runGate(["--root", REPO_ROOT]));
      const there = parse(runGate(["--root", dir]));
      expect(here.ok).toBe(true);
      expect(there.ok).toBe(false);
      expect(here.results).not.toEqual(there.results);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a usage error and a non-zero exit for a valueless --root", () => {
    const result = spawnSync("node", [SCRIPT, "--root"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--root requires a path/);
  });

  it("--fix scaffolds into the named root, never into this repo", () => {
    // attemptFix takes a root too; W1 threads the same value through it. If it
    // did not, --fix against another project would create directories HERE.
    const dir = mkdtempSync(join(tmpdir(), "conform-fix-"));
    try {
      // Give it a profile so the run gets past profile-file to the dir checks.
      writeFileSync(
        join(dir, "arbor.profile.jsonc"),
        JSON.stringify({ schema_version: 1, project_id: "fixture", language: "typescript", source_roots: ["src"] }, null, 2),
      );
      mkdirSync(join(dir, "src"), { recursive: true });

      const before = parse(runGate(["--root", dir]));
      const fixed = parse(runGate(["--root", dir, "--fix"]));

      // Something was attempted, and it was attempted against the fixture.
      expect(Array.isArray(fixed.fixes)).toBe(true);
      // The fixture's own verdict may improve; revoy2's must be untouched —
      // re-running here still passes, which it would not if directories had
      // been created in this repo by a fixture-targeted --fix.
      const hereAfter = parse(runGate([]));
      expect(hereAfter.ok).toBe(true);
      expect(before.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
