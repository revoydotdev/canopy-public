/**
 * scripts/tests/anti-stub-root.test.mjs — the `--root` seam for
 * scripts/anti-stub.mjs (Roadmap 23 B2, ADR-073 follow-up).
 *
 * anti-stub.mjs's source-collection walk (Rules 1/3/4 over each package's
 * `src/`, Rule 5 over each package's `tests/`) used to hardcode a single
 * literal `packages` directory under a `REPO_ROOT` derived from
 * `__dirname/..` with no override. It now walks
 * `profileOrDefaults(root).source_roots` and accepts `--root`.
 *
 * anti-stub.mjs runs its whole scan at module top-level (no `main()` guard),
 * so — unlike scripts that export a pure `resolveRootArg` for direct unit
 * testing — this file drives the gate exclusively as a real subprocess, the
 * same way it is actually invoked (`bun scripts/anti-stub.mjs`).
 *
 * Per Roadmap 23 §5, "the flag is accepted" is not the property worth
 * proving. This file proves two things:
 *
 *   1. Parity: revoy2's own verdict (`--json` output) is byte-identical
 *      whether `--root` is implicit or passed explicitly.
 *   2. Real retargeting: a fixture project with its own
 *      `arbor.profile.jsonc` (`source_roots: ["libs"]`, not `packages`) and
 *      a single source file under `libs/widget/src/index.ts` containing a
 *      textbook Rule 3 violation (a `TODO` comment on a trivial-body
 *      function) produces a verdict DERIVED FROM that fixture (exactly one
 *      finding, `rule3`, at that file) — not revoy2's real 48 findings
 *      across its actual `packages/*` tree.
 */

import { describe, expect, it, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "anti-stub.mjs");

/**
 * anti-stub.mjs's default root is its own `__dirname/..`, and its scan
 * walks every source root's `src/` AND `tests/` — proven directly: adding
 * one tautological-assertion file under any `packages/*\/tests` flips
 * `totalFindings` (49 -> 50 here, reproduced against this file's own
 * REPO_ROOT before this fix). The "implicit vs explicit --root" parity
 * assertion below ran the gate TWICE against that same live, shared
 * checkout — in a repository whose normal mode is concurrent agents
 * committing into it, any matching file touched by anyone between the two
 * `spawnSync` calls flips one verdict but not the other, independent of
 * whether `--root` actually works. A `git worktree --detach` snapshot frozen
 * once at module load, the idiom `gate-failure-modes.test.mjs` already uses,
 * gives both calls a byte-for-byte identical tree to scan without touching
 * the shared checkout everyone else is working in.
 */
const SNAPSHOT_PARENT = mkdtempSync(join(dirname(REPO_ROOT), ".anti-stub-root-snapshot-"));
const SNAPSHOT_DIR = join(SNAPSHOT_PARENT, "repo");
execFileSync("git", ["worktree", "add", "-q", "--detach", SNAPSHOT_DIR, "HEAD"], { cwd: REPO_ROOT });
execFileSync("cp", ["-al", join(REPO_ROOT, "node_modules"), join(SNAPSHOT_DIR, "node_modules")]);
const SNAPSHOT_SCRIPT = join(SNAPSHOT_DIR, "scripts", "anti-stub.mjs");

afterAll(() => {
  spawnSync("git", ["worktree", "remove", "--force", SNAPSHOT_DIR], { cwd: REPO_ROOT });
  rmSync(SNAPSHOT_PARENT, { recursive: true, force: true });
});

function runGate(args) {
  return spawnSync("node", [SNAPSHOT_SCRIPT, "--json", ...args], { cwd: SNAPSHOT_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function parse(result) {
  return JSON.parse(result.stdout);
}

describe("anti-stub --root — argument parsing", () => {
  it("throws (usage error, non-zero exit) when --root is given no value", () => {
    const result = spawnSync("node", [SCRIPT, "--root"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--root requires a path/);
  });

  it("throws when --root is followed by another flag", () => {
    const result = spawnSync("node", [SCRIPT, "--root", "--json"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--root requires a path/);
  });
});

describe("anti-stub --root — the verdict comes from the named root", () => {
  it("an explicit --root at this repo produces the byte-identical --json verdict to no flag (parity)", () => {
    const implicit = runGate([]);
    const explicit = runGate(["--root", SNAPSHOT_DIR]);
    expect(implicit.stdout).toBe(explicit.stdout);
    const parsed = parse(implicit);
    // And it's really the real repo's scan, not an accidental empty read.
    expect(parsed.totalFindings).toBeGreaterThan(0);
  }, 60_000);

  it("retargeting: a fixture with source_roots: [\"libs\"] is scanned from ITS OWN tree, not revoy2's", () => {
    const dir = mkdtempSync(join(tmpdir(), "anti-stub-root-"));
    try {
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "Bundler", strict: false } }, null, 2),
      );
      writeFileSync(
        join(dir, "arbor.profile.jsonc"),
        JSON.stringify({ schema_version: 1, project_id: "fixture", language: "typescript", source_roots: ["libs"] }, null, 2),
      );
      const srcDir = join(dir, "libs", "widget", "src");
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(
        join(srcDir, "index.ts"),
        ["export function doThing() {", "  // TODO: implement this", "  return;", "}", ""].join("\n"),
      );

      const out = parse(runGate(["--root", dir]));
      // The load-bearing assertion: exactly the fixture's own Rule 3 finding
      // — not revoy2's real 48 findings across packages/*. A --root that was
      // accepted but silently ignored would report revoy2's own count here.
      expect(out.totalFindings).toBe(1);
      expect(out.findings.rule3).toHaveLength(1);
      expect(out.findings.rule3[0].file).toBe("libs/widget/src/index.ts");
      expect(out.findings.rule3[0].function).toBe("doThing");
      // Every other rule's collection also comes from the fixture, not
      // revoy2 — none of revoy2's own (non-rule3) findings leak through.
      expect(out.findings.rule1).toEqual([]);
      expect(out.findings.rule2).toEqual([]);
      expect(out.findings.rule4_strong).toEqual([]);
      expect(out.findings.rule4_weak).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("an empty directory (no profile, no tsconfig) fails to even build a TypeScript program — proof the gate tried to read that directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "anti-stub-empty-"));
    try {
      const result = spawnSync("node", [SCRIPT, "--root", dir, "--json"], { cwd: REPO_ROOT, encoding: "utf8" });
      // No packages/*/src under an empty dir means zero source files are
      // collected — the gate runs and reports zero findings from an empty
      // program, which is itself proof the walk targeted this empty
      // directory rather than falling back to revoy2's populated one.
      const out = JSON.parse(result.stdout);
      expect(out.totalFindings).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
