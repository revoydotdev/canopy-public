import { describe, expect, it, afterEach, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * scripts/tests/typecheck-tests-root.test.mjs — the `--root` seam for
 * scripts/typecheck-tests.mjs (ADR-073's named follow-up).
 *
 * typecheck-tests.mjs used to hardcode `packages/` under a `REPO_ROOT`
 * derived from `__dirname/..` with no override. It now walks
 * `profileOrDefaults(root).source_roots` and accepts `--root`.
 *
 * Per Roadmap 23 §5, "the flag is accepted" is not the property worth
 * proving. This file proves two things:
 *
 *   1. Parity: revoy2's own `--json` verdict is identical whether `--root`
 *      is implicit or passed explicitly.
 *   2. Real retargeting: a fixture project with its own
 *      `arbor.profile.jsonc` (`source_roots: ["libs"]`, not `packages`) and
 *      a package under `libs/widget` with a genuine type error in its
 *      `tests/` directory produces a verdict DERIVED FROM that fixture —
 *      the real `tsc` compiler, run against the fixture's own tree,
 *      reporting exactly that error — not revoy2's own real package set.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "typecheck-tests.mjs");
const REAL_TYPESCRIPT = join(REPO_ROOT, "node_modules", "typescript");

/**
 * typecheck-tests.mjs's default root is its own `__dirname/..`, and its scan
 * runs the real `tsc` across every source root's `tests/` config — the same
 * shape of full-tree walk `anti-stub.mjs` does (proven directly there:
 * adding one file under any `packages/*\/tests` changes the verdict). The
 * "implicit vs explicit --root" parity assertion below spawns that walk
 * TWICE, up to 180s apart, against this live, shared checkout — in a
 * repository whose normal mode is concurrent agents committing into it, any
 * source or test file touched anywhere between the two calls flips one
 * verdict but not the other, independent of whether `--root` actually
 * works. A `git worktree --detach` snapshot frozen once at module load, the
 * idiom `gate-failure-modes.test.mjs` already uses, gives both calls a
 * byte-for-byte identical tree without touching the shared checkout everyone
 * else is working in.
 */
const SNAPSHOT_PARENT = mkdtempSync(join(dirname(REPO_ROOT), ".typecheck-tests-root-snapshot-"));
const SNAPSHOT_DIR = join(SNAPSHOT_PARENT, "repo");
execFileSync("git", ["worktree", "add", "-q", "--detach", SNAPSHOT_DIR, "HEAD"], { cwd: REPO_ROOT });
execFileSync("cp", ["-al", join(REPO_ROOT, "node_modules"), join(SNAPSHOT_DIR, "node_modules")]);
const SNAPSHOT_SCRIPT = join(SNAPSHOT_DIR, "scripts", "typecheck-tests.mjs");

afterAll(() => {
  spawnSync("git", ["worktree", "remove", "--force", SNAPSHOT_DIR], { cwd: REPO_ROOT });
  rmSync(SNAPSHOT_PARENT, { recursive: true, force: true });
});

function runGate(args) {
  return spawnSync("node", [SNAPSHOT_SCRIPT, "--json", ...args], { cwd: SNAPSHOT_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function runCurrentGate(args) {
  return spawnSync("node", [SCRIPT, "--json", ...args], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

describe("typecheck-tests --root — argument parsing", () => {
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

describe("typecheck-tests --root — the verdict comes from the named root", () => {
  it("an explicit --root at this repo produces the byte-identical --json verdict to no flag (parity)", () => {
    const implicit = runGate([]);
    const explicit = runGate(["--root", SNAPSHOT_DIR]);
    expect(implicit.stdout).toBe(explicit.stdout);
    const parsed = JSON.parse(implicit.stdout);
    expect(parsed.results.length).toBeGreaterThan(0);
  }, 180_000);

  it('retargeting: a fixture with source_roots: ["libs"] is checked from ITS OWN tree, not revoy2\'s', () => {
    const dir = mkdtempSync(join(tmpdir(), "typecheck-tests-root-"));
    try {
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "Bundler", strict: false, skipLibCheck: true } }, null, 2),
      );
      writeFileSync(
        join(dir, "arbor.profile.jsonc"),
        JSON.stringify({ schema_version: 1, project_id: "fixture", language: "typescript", source_roots: ["libs"] }, null, 2),
      );

      const pkgDir = join(dir, "libs", "widget");
      mkdirSync(join(pkgDir, "src"), { recursive: true });
      mkdirSync(join(pkgDir, "tests"), { recursive: true });
      writeFileSync(join(pkgDir, "src", "index.ts"), "export function widgetOnlyHelper(): number {\n  return 1;\n}\n");
      // A genuine, fixture-only type error: calling with the wrong arity.
      writeFileSync(
        join(pkgDir, "tests", "index.test.ts"),
        "import { widgetOnlyHelper } from \"../src/index.js\";\n" +
        "widgetOnlyHelper(\"this repo's own real packages/* has no such call\");\n",
      );
      writeFileSync(
        join(pkgDir, "tsconfig.tests.json"),
        JSON.stringify({
          extends: "../../tsconfig.json",
          compilerOptions: { noEmit: true, rootDir: "." },
          include: ["src/**/*.ts", "tests/**/*.ts"],
        }, null, 2),
      );

      mkdirSync(join(dir, "node_modules"));
      symlinkSync(REAL_TYPESCRIPT, join(dir, "node_modules", "typescript"), "dir");
      mkdirSync(join(dir, "node_modules", ".bin"));
      symlinkSync(join(REAL_TYPESCRIPT, "bin", "tsc"), join(dir, "node_modules", ".bin", "tsc"));

      const result = runGate(["--root", dir]);
      const out = JSON.parse(result.stdout);

      // The load-bearing assertion: exactly the fixture's own package and
      // its own genuine type error — not revoy2's real ~13 packages.
      expect(out.results).toHaveLength(1);
      expect(out.results[0].package).toBe("widget");
      expect(out.results[0].config).toBe("libs/widget/tsconfig.tests.json");
      expect(out.results[0].ok).toBe(false);
      expect(out.results[0].errors.some((e) => e.includes("tests/index.test.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("fail-closed still applies at a foreign root: a package with no tsconfig.tests.json fails, not skips", () => {
    const dir = mkdtempSync(join(tmpdir(), "typecheck-tests-root-failclosed-"));
    try {
      writeFileSync(
        join(dir, "arbor.profile.jsonc"),
        JSON.stringify({ schema_version: 1, project_id: "fixture", language: "typescript", source_roots: ["libs"] }, null, 2),
      );
      mkdirSync(join(dir, "libs", "bare", "src"), { recursive: true });
      writeFileSync(join(dir, "libs", "bare", "src", "index.ts"), "export const x = 1;\n");

      const out = JSON.parse(runGate(["--root", dir]).stdout);
      expect(out.results).toHaveLength(1);
      expect(out.results[0].package).toBe("bare");
      expect(out.results[0].ok).toBe(false);
      expect(out.results[0].errors[0]).toMatch(/missing tsconfig\.tests\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the declared source roots contain no packages", () => {
    const dir = mkdtempSync(join(tmpdir(), "typecheck-tests-empty-census-"));
    try {
      writeFileSync(
        join(dir, "arbor.profile.jsonc"),
        JSON.stringify({ schema_version: 1, project_id: "empty", language: "typescript", source_roots: ["libs"] }, null, 2),
      );
      mkdirSync(join(dir, "libs"));
      const result = runCurrentGate(["--root", dir]);
      const out = JSON.parse(result.stdout);
      expect(result.status).not.toBe(0);
      expect(out.results).toEqual([expect.objectContaining({ package: "<source-root-census>", ok: false })]);
      expect(out.results[0].errors[0]).toMatch(/source-root census is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the configured TypeScript compiler cannot be spawned", () => {
    const dir = mkdtempSync(join(tmpdir(), "typecheck-tests-no-compiler-"));
    try {
      writeFileSync(join(dir, "arbor.profile.jsonc"), JSON.stringify({ schema_version: 1, project_id: "missing-tsc", language: "typescript", source_roots: ["libs"] }));
      const pkg = join(dir, "libs", "widget");
      mkdirSync(join(pkg, "src"), { recursive: true });
      writeFileSync(join(pkg, "tsconfig.tests.json"), JSON.stringify({ compilerOptions: { noEmit: true }, include: ["src/**/*.ts"] }));
      const result = runCurrentGate(["--root", dir]);
      const out = JSON.parse(result.stdout);
      expect(result.status).not.toBe(0);
      expect(out.results).toEqual([expect.objectContaining({ package: "widget", ok: false })]);
      expect(out.results[0].errors[0]).toMatch(/could not invoke TypeScript compiler/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
