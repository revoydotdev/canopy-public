import { describe, expect, it, afterEach, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRootArg } from "../vi-refresh.mjs";

/**
 * scripts/tests/vi-refresh-root.test.mjs — the `--root` seam for
 * scripts/vi-refresh.mjs (ADR-073's named follow-up, the last of the eight
 * scripts).
 *
 * Per Roadmap 23 §5, "the flag is accepted" is not the property worth
 * proving. This file proves:
 *
 *   1. Argument parsing — same contract as project-conform.mjs's
 *      resolveRootArg (usage errors, absolute resolution).
 *   2. Parity — an explicit `--root <thisRepo>` composes the IDENTICAL
 *      step-1 (vi-extract-ts) invocation as no flag at all. Run via the
 *      copy-and-stub technique vi-refresh-force.test.mjs already
 *      established (real script, stubbed vendored extractor that records
 *      argv and exits — avoids the real six-step pipeline's network/bun
 *      cost while still observing the REAL composed argv).
 *   3. Real retargeting — the REAL, un-copied scripts/vi-refresh.mjs (this
 *      checkout's own REPO_ROOT and vendored tooling), pointed via --root
 *      at a genuine, differently-shaped git fixture (its own
 *      arbor.profile.jsonc declaring `source_roots: ["libs"]`, its own
 *      entry-points.json, its own TypeScript source), produces a derived
 *      plane DERIVED FROM THAT FIXTURE — evidenced by a graph node the
 *      fixture's tree actually contains and revoy2's real packages/* tree
 *      does not — and leaves this checkout's own real
 *      .visual-intelligence/graph untouched.
 *   4. The FULL six-step pipeline now genuinely runs for a foreign root —
 *      the boundary this file used to stop at (steps 2-6, because
 *      vi-emit.ts hardcoded THIS repository's own decisions/ corpus) is
 *      closed now that vi-emit.ts derives its decisions corpus, waiver
 *      input, and output paths from the same `--root` this file threads
 *      through. See scripts/tests/vi-refresh-cross-contamination.test.mjs
 *      for the dedicated, stronger Roadmap 23 §5 acceptance test (positive
 *      AND negative evidence: the fixture's own data is present, revoy2's
 *      real ADR corpus is absent). This file's own fixture is extended just
 *      enough (a `decisions/` dir, an empty waiver allowlist, a trivial
 *      `scripts/reachability.mjs`) for the full pipeline to complete
 *      end-to-end rather than fail on missing onboarding scaffolding.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VI_REFRESH = join(REPO_ROOT, "scripts/vi-refresh.mjs");
const REAL_TYPESCRIPT = join(REPO_ROOT, "node_modules/typescript");
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "vi-refresh-root-home-"));

/**
 * ADR-078 case 1: "real retargeting" below runs the REAL, un-copied
 * scripts/vi-refresh.mjs — which derives its own REPO_ROOT from its file
 * location, not from an argument — against this checkout's own
 * `.visual-intelligence/graph`, asserting it comes back byte-identical
 * after the run. Pointed at the live, shared checkout, that assertion is
 * hostage to any concurrent, unrelated `vi-refresh` run landing in the same
 * window (the test's own comment already names this risk). A frozen
 * `git worktree --detach` snapshot, run once at module load (the
 * `gate-failure-modes.test.mjs` idiom), gives this test a REPO_ROOT nothing
 * else writes into: the property under test — real retargeting leaves
 * REPO_ROOT's own graph alone — is proven the same way, just against a copy
 * nobody else can touch.
 */
const SNAPSHOT_PARENT = mkdtempSync(join(dirname(REPO_ROOT), ".vi-refresh-root-snapshot-"));
const SNAPSHOT_DIR = join(SNAPSHOT_PARENT, "repo");
execFileSync("git", ["worktree", "add", "-q", "--detach", SNAPSHOT_DIR, "HEAD"], { cwd: REPO_ROOT });
execFileSync("cp", ["-al", join(REPO_ROOT, "node_modules"), join(SNAPSHOT_DIR, "node_modules")]);
const SNAPSHOT_VI_REFRESH = join(SNAPSHOT_DIR, "scripts/vi-refresh.mjs");

afterAll(() => {
  spawnSync("git", ["worktree", "remove", "--force", SNAPSHOT_DIR], { cwd: REPO_ROOT });
  rmSync(SNAPSHOT_PARENT, { recursive: true, force: true });
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

describe("resolveRootArg — argument parsing", () => {
  it("falls back to the supplied default when --root is absent", () => {
    expect(resolveRootArg(["--check"], "/tmp/fallback")).toBe(resolve("/tmp/fallback"));
  });

  it("accepts the space-separated form and returns an absolute path", () => {
    expect(resolveRootArg(["--root", "/tmp/some-project"])).toBe(resolve("/tmp/some-project"));
  });

  it("accepts the --root=<path> form", () => {
    expect(resolveRootArg(["--root=/tmp/some-project"])).toBe(resolve("/tmp/some-project"));
  });

  it("throws when --root is given no value, rather than silently using this repo", () => {
    expect(() => resolveRootArg(["--root"])).toThrow(/--root requires a path/);
  });

  it("throws when --root is followed by another flag", () => {
    expect(() => resolveRootArg(["--root", "--check"])).toThrow(/--root requires a path/);
  });

  it("throws on an empty --root= value", () => {
    expect(() => resolveRootArg(["--root="])).toThrow(/--root requires a path/);
  });
});

// ---------------------------------------------------------------------------
// Parity — copy-and-stub technique from vi-refresh-force.test.mjs, so the
// composed step-1 argv can be observed without paying for the real six-step
// pipeline (network/bun-dependent).
// ---------------------------------------------------------------------------

let hostFixture;

afterEach(() => {
  if (hostFixture) rmSync(hostFixture, { recursive: true, force: true });
  hostFixture = undefined;
});

function buildHostFixture() {
  const dir = mkdtempSync(join(tmpdir(), "vi-refresh-root-parity-"));
  mkdirSync(join(dir, "scripts/reachability"), { recursive: true });
  mkdirSync(join(dir, "scripts/lib"), { recursive: true });
  mkdirSync(join(dir, ".claude/skills/repository-visual-intelligence/scripts"), { recursive: true });

  copyFileSync(VI_REFRESH, join(dir, "scripts/vi-refresh.mjs"));
  copyFileSync(join(REPO_ROOT, "scripts/lib/project-profile.mjs"), join(dir, "scripts/lib/project-profile.mjs"));
  copyFileSync(join(REPO_ROOT, "scripts/lib/vi-input-binding.mjs"), join(dir, "scripts/lib/vi-input-binding.mjs"));
  copyFileSync(join(REPO_ROOT, "scripts/evidence-transaction.mjs"), join(dir, "scripts/evidence-transaction.mjs"));
  copyFileSync(join(REPO_ROOT, "scripts/enforcement-control-plane.mjs"), join(dir, "scripts/enforcement-control-plane.mjs"));
  // ADR-091 gave enforcement-control-plane.mjs a real dependency on the shared
  // finalization progress reporter; the fixture copies it for the same reason
  // it copies every other real edge of the module graph.
  copyFileSync(join(REPO_ROOT, "scripts/finalization-progress.mjs"), join(dir, "scripts/finalization-progress.mjs"));
  copyFileSync(join(REPO_ROOT, "scripts/lib/governance-plan.mjs"), join(dir, "scripts/lib/governance-plan.mjs"));
  writeFileSync(join(dir, "scripts/reachability/entry-points.json"), "{}\n");

  const stub = join(dir, ".claude/skills/repository-visual-intelligence/scripts/vi-extract-ts.mjs");
  writeFileSync(
    stub,
    "#!/usr/bin/env node\n" +
    "import { writeFileSync } from \"node:fs\";\n" +
    "writeFileSync(process.env.RECORD_ARGV_TO, JSON.stringify(process.argv.slice(2)));\n" +
    "process.exit(1);\n",
  );
  chmodSync(stub, 0o755);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  return dir;
}

function receivedArgv(dir, args) {
  const recordFile = join(dir, "received-argv.json");
  const result = spawnSync(process.execPath, [join(dir, "scripts/vi-refresh.mjs"), ...args], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, RECORD_ARGV_TO: recordFile },
  });
  expect(existsSync(recordFile), `stub extractor never ran:\n${result.stdout}${result.stderr}`).toBe(true);
  return JSON.parse(readFileSync(recordFile, "utf-8"));
}

describe("vi-refresh --root — parity", () => {
  it("an explicit --root at the host's own location composes the identical step-1 argv as no flag", () => {
    hostFixture = buildHostFixture();
    const implicit = receivedArgv(hostFixture, []);
    const explicit = receivedArgv(hostFixture, ["--root", hostFixture]);
    expect(explicit).toEqual(implicit);
    // And it's really the derived-plane invocation, not an accidental no-op:
    // --include is composed from the (default) profile's source_roots.
    expect(implicit).toEqual(expect.arrayContaining(["--include", "packages/*/src/**,packages/*/tests/**"]));
  });
});

// ---------------------------------------------------------------------------
// Real retargeting + the honest boundary — the REAL, un-copied
// scripts/vi-refresh.mjs (this checkout's own REPO_ROOT and vendored
// tooling), pointed at a genuinely different fixture tree via --root.
// ---------------------------------------------------------------------------

let targetFixture;

afterEach(() => {
  if (targetFixture) rmSync(targetFixture, { recursive: true, force: true });
  targetFixture = undefined;
});

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function buildTargetFixture() {
  const dir = mkdtempSync(join(tmpdir(), "vi-refresh-root-target-"));
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(
    join(dir, "arbor.profile.jsonc"),
    JSON.stringify({ schema_version: 1, project_id: "fixture", language: "typescript", source_roots: ["libs"] }, null, 2),
  );

  const srcDir = join(dir, "libs/widget/src");
  mkdirSync(srcDir, { recursive: true });
  // A symbol name that does not exist anywhere in revoy2's real packages/*
  // tree — the load-bearing evidence that the derived plane came from THIS
  // fixture, not from revoy2's own real graph.
  writeFileSync(join(srcDir, "index.ts"), "export function fixtureOnlySymbol() { return 1; }\nfixtureOnlySymbol();\n");

  mkdirSync(join(dir, "scripts/reachability"), { recursive: true });
  writeFileSync(
    join(dir, "scripts/reachability/entry-points.json"),
    JSON.stringify({ entryPoints: [{ id: "widget", file: "libs/widget/src/index.ts" }] }),
  );
  // Required by extractExceptions (@arbor/governance, step 2) — onboarding
  // scaffolding a real foreign project supplies, not something vi-emit.ts
  // can default around.
  writeFileSync(join(dir, "scripts/reachability/allowlist.json"), JSON.stringify({ version: 1, entries: [] }));
  // Required for step 4 (verify-against-gate.mjs) to genuinely run against
  // this root rather than fail for lacking its own gate script.
  writeFileSync(join(dir, "scripts/reachability.mjs"), "#!/usr/bin/env node\nconsole.log(JSON.stringify({ checklist: [] }));\n");

  mkdirSync(join(dir, "decisions"), { recursive: true });

  git(dir, "add", "package.json", ".gitignore", "arbor.profile.jsonc", "libs", "scripts", "decisions");
  git(dir, "commit", "-q", "-m", "base");

  mkdirSync(join(dir, "node_modules"));
  symlinkSync(REAL_TYPESCRIPT, join(dir, "node_modules/typescript"), "dir");
  return dir;
}

describe("vi-refresh --root — real retargeting and the honest boundary", () => {
  it("derives INCLUDE from the fixture's own profile and extracts THAT tree's own symbol, leaving the snapshot's own real graph untouched", () => {
    targetFixture = buildTargetFixture();

    // ADR-169: `.visual-intelligence/graph/` is gitignored, never committed,
    // so a fresh `git worktree add --detach` snapshot legitimately starts
    // with no graph at all — there is nothing to read as a "before" state.
    const repoGraphPath = join(SNAPSHOT_DIR, ".visual-intelligence/graph/nodes.jsonl");
    expect(existsSync(repoGraphPath)).toBe(false);

    // Run the frozen snapshot's own copy of vi-refresh.mjs (not REPO_ROOT's
    // live one) so a concurrent, unrelated vi-refresh run in the shared
    // checkout cannot flip this test's verdict — see the module-level
    // comment for why.
    const result = spawnSync(process.execPath, [SNAPSHOT_VI_REFRESH, "--root", targetFixture], {
      cwd: SNAPSHOT_DIR,
      encoding: "utf-8",
      env: { ...process.env, HOME: ISOLATED_HOME },
    });
    expect(result.status, `vi-refresh --root ${targetFixture} failed:\n${result.stdout}${result.stderr}`).toBe(0);

    // 3. Real retargeting: the fixture's OWN graph contains a node for its
    // OWN, fixture-only symbol.
    const fixtureNodesPath = join(targetFixture, ".visual-intelligence/graph/nodes.jsonl");
    expect(existsSync(fixtureNodesPath)).toBe(true);
    const fixtureNodes = readFileSync(fixtureNodesPath, "utf-8")
      .split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
    expect(fixtureNodes.some((n) => n.name === "fixtureOnlySymbol")).toBe(true);

    // The snapshot's own REPO_ROOT graph still does not exist — proof the run
    // did not fall back to its dirname-derived REPO_ROOT despite --root
    // pointing elsewhere. A file that was never created is stronger evidence
    // of correct root-scoping than a byte-for-byte compare would be: it
    // cannot be satisfied by accident.
    expect(existsSync(repoGraphPath)).toBe(false);

    // 4. The boundary is closed: all six steps actually ran against the
    // fixture, not just step 1.
    expect(result.stdout).toContain("2/6 intended plane");
    expect(result.stdout).toContain("4/6 cross-check");
    expect(result.stdout).toContain("5/6 validate");
    expect(result.stdout).toContain("6/6 rendered");
    expect(result.stdout).not.toContain("Steps 2-6");
  }, 60_000);

  // ADR-169: `.visual-intelligence/graph/` is gitignored and never
  // committed, so `--check` must SUCCEED (not fail) when no prior local
  // graph exists — that is the ordinary state of a fresh clone/worktree, not
  // evidence of a defect. Before ADR-169 this returned exit 1 ("ABSENT"),
  // which meant every isolated pre-push candidate snapshot failed
  // gate:vi-prepush-policy's full-reproduction path unconditionally.
  it("--check succeeds with FIRST-GENERATION when .visual-intelligence does not exist at all, and leaves no trace", () => {
    targetFixture = buildTargetFixture();
    const graphPath = join(targetFixture, ".visual-intelligence/graph/nodes.jsonl");
    expect(existsSync(graphPath)).toBe(false);
    expect(existsSync(join(targetFixture, ".visual-intelligence"))).toBe(false);

    const result = spawnSync(process.execPath, [SNAPSHOT_VI_REFRESH, "--root", targetFixture, "--check"], {
      cwd: SNAPSHOT_DIR,
      encoding: "utf-8",
      env: { ...process.env, HOME: ISOLATED_HOME },
    });
    expect(result.status, `vi-refresh --root ${targetFixture} --check failed:\n${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FIRST-GENERATION");
    expect(result.stdout).not.toContain("ABSENT");

    // --check must leave no trace, first-generation or not.
    expect(existsSync(graphPath)).toBe(false);
  }, 60_000);

  // The actual, more common shape this repository hits: `.visual-intelligence/`
  // DOES exist and IS committed (manifest.json, findings/, observed/, etc.)
  // — only `graph/` itself is gitignored and absent, exactly as revoy2's own
  // real checkout now is (manifest.json stays committed; graph/ does not). A
  // first, narrower fix checked `existsSync(.visual-intelligence)` rather
  // than `existsSync(.visual-intelligence/graph)`, which is true here (the
  // parent exists) and so silently fell through to graphDigest() — which
  // returns an object with all-null VALUES for a missing graph, not the
  // literal `null` — comparing that against a freshly generated digest and
  // reporting DIFFERS on every single push, exactly what the real pre-push
  // hook's candidate worktree hit. A small fixture with only a committed
  // manifest.json (never the real ~36,000-node corpus) reproduces the same
  // shape without paying the real pipeline's LSP-bound cost.
  it("--check succeeds with FIRST-GENERATION when .visual-intelligence/manifest.json IS committed but graph/ is not (the real pre-push shape)", () => {
    targetFixture = buildTargetFixture();
    mkdirSync(join(targetFixture, ".visual-intelligence"), { recursive: true });
    writeFileSync(join(targetFixture, ".visual-intelligence/manifest.json"), JSON.stringify({ schema_version: 1 }));
    git(targetFixture, "add", ".visual-intelligence/manifest.json");
    git(targetFixture, "commit", "-q", "-m", "committed manifest, no graph");
    expect(existsSync(join(targetFixture, ".visual-intelligence", "manifest.json"))).toBe(true);
    expect(existsSync(join(targetFixture, ".visual-intelligence", "graph"))).toBe(false);

    const result = spawnSync(process.execPath, [SNAPSHOT_VI_REFRESH, "--root", targetFixture, "--check"], {
      cwd: SNAPSHOT_DIR,
      encoding: "utf-8",
      env: { ...process.env, HOME: ISOLATED_HOME },
    });
    expect(result.status, `vi-refresh --root ${targetFixture} --check failed:\n${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FIRST-GENERATION");
    expect(result.stdout).not.toContain("DIFFERS");
    expect(result.stdout).not.toContain("ABSENT");
    expect(existsSync(join(targetFixture, ".visual-intelligence", "graph"))).toBe(false);
  }, 60_000);
});
