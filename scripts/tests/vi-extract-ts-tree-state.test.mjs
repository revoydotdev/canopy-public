import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fix 1: `.visual-intelligence/`'s own output must never make vi-extract-ts
 * stamp `tree_state: "dirty"` on itself. Before the fix, any refresh run over
 * a previously-committed (or even just previously-run-but-uncommitted) graph
 * saw its own prior output sitting in `git status --porcelain` and marked the
 * whole tree dirty — which is exactly the shape behind the real
 * c4cd4fa (dirty) -> d897a43 ("stamp ... from clean tree") commit pair: a
 * pure-timestamp-churn commit whose only job was to re-run the extractor a
 * second time against a now-clean tree.
 *
 * This reproduces that shape directly: run the extractor twice over the same
 * fixture repo without committing between runs. The first run's uncommitted
 * output is exactly the dirt the second run's tree_state computation must
 * ignore.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTRACTOR = join(REPO_ROOT, ".claude/skills/repository-visual-intelligence/scripts/vi-extract-ts.mjs");
const REAL_TYPESCRIPT = join(REPO_ROOT, "node_modules/typescript");

let repo;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

function runExtractor() {
  const result = spawnSync(process.execPath, [
    EXTRACTOR, "--root", repo, "--include", "src/**",
  ], { cwd: repo, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`vi-extract-ts exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function manifestTreeState() {
  return JSON.parse(readFileSync(join(repo, ".visual-intelligence/manifest.json"), "utf-8")).tree_state;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "vi-extract-tree-state-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");

  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture" }));
  // node_modules must be ignored, or the symlinked `typescript` dependency
  // below reads as its own dirt and defeats the very thing this test isolates.
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/index.ts"), "export const a = 1;\n");

  git("add", "package.json", ".gitignore", "src");
  git("commit", "-q", "-m", "base");

  // vi-extract-ts resolves `typescript` from the target repo's own
  // package.json via createRequire; symlink the real one in rather than
  // installing a second copy.
  mkdirSync(join(repo, "node_modules"));
  symlinkSync(REAL_TYPESCRIPT, join(repo, "node_modules/typescript"), "dir");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("vi-extract-ts tree_state — excludes its own output", () => {
  it("stays clean when the only dirty paths are the extractor's own prior, uncommitted output", () => {
    runExtractor(); // writes .visual-intelligence/{graph,manifest.json} — uncommitted
    expect(existsSync(join(repo, ".visual-intelligence/manifest.json"))).toBe(true);

    // At this point `git status --porcelain` shows only untracked paths under
    // .visual-intelligence/ — exactly the dirt the fix must ignore.
    const dirtyPaths = git("status", "--porcelain");
    expect(dirtyPaths.split("\n").every((l) => !l.trim() || l.slice(3).startsWith(".visual-intelligence"))).toBe(true);

    runExtractor(); // the second run is where the pre-fix bug fired
    expect(manifestTreeState()).toBe("clean");
  });

  it("stays clean when its first dirty path is tracked and unstaged", () => {
    runExtractor();
    git("add", ".visual-intelligence");
    git("commit", "-q", "-m", "graph");

    runExtractor(); // creates tracked, unstaged output whose first status byte is a blank
    expect(git("status", "--porcelain")).toMatch(/^ M \.visual-intelligence\//);

    runExtractor();
    expect(manifestTreeState()).toBe("clean");
  });

  it("still reports dirty when a real, non-graph path is uncommitted", () => {
    runExtractor();
    // Genuine dirt outside .visual-intelligence/: an uncommitted source edit.
    writeFileSync(join(repo, "src/index.ts"), "export const a = 2;\n");

    runExtractor();
    expect(manifestTreeState()).toBe("dirty");
  });

  it("still reports dirty when a tracked .visual-intelligence path AND a real path are both dirty", () => {
    runExtractor();
    git("add", ".visual-intelligence");
    git("commit", "-q", "-m", "graph");
    writeFileSync(join(repo, "src/index.ts"), "export const a = 3;\n");

    runExtractor(); // manifest.json will also differ (generated_at), but src/index.ts is the real dirt
    expect(manifestTreeState()).toBe("dirty");
  });
});

describe("vi-extract-ts generation_mismatch — compares the prior manifest to the prior bytes", () => {
  const manifest = () => JSON.parse(readFileSync(join(repo, ".visual-intelligence/manifest.json"), "utf-8"));
  const mismatch = () => manifest().extraction_gaps.find((gap) => gap.reason === "generation_mismatch");

  it("records no gap when the source changed between two consistent runs", () => {
    runExtractor();
    writeFileSync(join(repo, "src/index.ts"), "export const a = 1;\nexport function b() { return a; }\n");
    runExtractor();
    // The counts moved because the code did; the prior manifest still
    // described the prior bytes, so nothing crossed a generation boundary.
    expect(mismatch()).toBeUndefined();
  });

  it("records the gap when the prior manifest did not describe the prior bytes", () => {
    runExtractor();
    const path = join(repo, ".visual-intelligence/manifest.json");
    const prior = manifest();
    writeFileSync(path, JSON.stringify({ ...prior, counts: { ...prior.counts, edges: prior.counts.edges + 7 } }));
    runExtractor();
    const gap = mismatch();
    expect(gap).toBeDefined();
    expect(gap.prior.edges).toBe(gap.prior_on_disk.edges + 7);
  });
});
