import { describe, expect, it, afterEach, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * scripts/tests/vi-refresh-cross-contamination.test.mjs — the acceptance
 * test named by Roadmap 23 §5 for closing vi-emit.ts's honest boundary (the
 * last piece of ADR-073's eight-script follow-up).
 *
 * §5's own words: "That would produce a harness that *accepts* a second
 * project and quietly checks the wrong files — every gate green, every
 * guarantee void... A multi-project gate must prove it read the second
 * project's files, and the regression test for each migration is the only
 * thing that can establish it."
 *
 * So this does not merely assert `vi-refresh --root <fixture>` exits 0. It
 * builds a fixture project with its OWN distinct source symbol and its OWN
 * decisions/ ADR record — both named so they cannot be confused with
 * anything in revoy2's real tree — runs the FULL six-step pipeline against
 * it, and then asserts, symmetrically:
 *
 *   1. The fixture's graph contains the fixture's own symbol and ADR record.
 *   2. The fixture's graph does NOT contain revoy2's own real ADR corpus —
 *      naming an ADR-073 record (real, revoy2-only) and asserting its
 *      absence is the strongest form of this: if vi-emit.ts silently fell
 *      back to REPO_ROOT's decisions/, ADR-073 itself would appear in the
 *      fixture's exceptions/intent nodes.
 *   3. This checkout's own real `.visual-intelligence/graph` is
 *      byte-for-byte untouched by the run — proof the pipeline did not
 *      fall back to REPO_ROOT for ANY step, not just step 1.
 *
 * ADR-078 case 1: step 3's before/after compare used to run against
 * REPO_ROOT — the live, shared checkout — for up to 120s. Any concurrent,
 * unrelated `vi-refresh` run landing in that window (this repo's normal
 * operating mode) flips the comparison for a reason unrelated to what's
 * under test. Runs against a `git worktree --detach` snapshot frozen once
 * at module load instead (the `gate-failure-modes.test.mjs` idiom), so the
 * "own graph untouched" property is proven against a copy nothing else can
 * write into.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_TYPESCRIPT = join(REPO_ROOT, "node_modules/typescript");
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "vi-refresh-contamination-home-"));

const SNAPSHOT_PARENT = mkdtempSync(join(dirname(REPO_ROOT), ".vi-refresh-contamination-snapshot-"));
const SNAPSHOT_DIR = join(SNAPSHOT_PARENT, "repo");
execFileSync("git", ["worktree", "add", "-q", "--detach", SNAPSHOT_DIR, "HEAD"], { cwd: REPO_ROOT });
execFileSync("cp", ["-al", join(REPO_ROOT, "node_modules"), join(SNAPSHOT_DIR, "node_modules")]);
const SNAPSHOT_VI_REFRESH = join(SNAPSHOT_DIR, "scripts/vi-refresh.mjs");

afterAll(() => {
  spawnSync("git", ["worktree", "remove", "--force", SNAPSHOT_DIR], { cwd: REPO_ROOT });
  rmSync(SNAPSHOT_PARENT, { recursive: true, force: true });
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let fixture;

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), "vi-refresh-contamination-"));
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "fixture@fixture.test");
  git(dir, "config", "user.name", "fixture");

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "quillwort-fixture" }));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

  // Its own profile — a project_id that must show up as the graph's id
  // namespace instead of the literal "revoy2".
  writeFileSync(
    join(dir, "arbor.profile.jsonc"),
    JSON.stringify(
      {
        schema_version: 1,
        project_id: "quillwort",
        language: "typescript",
        source_roots: ["libs"],
        governance: {
          decisions_dir: "decisions",
          evidence_stores: [".visual-intelligence"],
          arbor_dir: ".arbor",
        },
      },
      null,
      2,
    ),
  );

  // Its own source tree, with a symbol name that exists ONLY here — never in
  // revoy2's real packages/*.
  const srcDir = join(dir, "libs/widget/src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "index.ts"),
    "export function quillwortOnlySymbol() { return 42; }\nquillwortOnlySymbol();\n",
  );

  // Its own entry-point declaration.
  mkdirSync(join(dir, "scripts/reachability"), { recursive: true });
  writeFileSync(
    join(dir, "scripts/reachability/entry-points.json"),
    JSON.stringify({ entryPoints: [{ id: "widget", file: "libs/widget/src/index.ts" }] }),
  );
  // Required by extractExceptions (@arbor/governance) — a project with no
  // allowlist at all is a FAILED emit, not an empty one; a genuinely
  // onboarding foreign project supplies this exactly like revoy2 does.
  writeFileSync(
    join(dir, "scripts/reachability/allowlist.json"),
    JSON.stringify({ version: 1, entries: [] }),
  );
  // Its own reachability gate — verify-against-gate.mjs (step 4) already
  // delegates to `<root>/scripts/reachability.mjs --json`; a trivial,
  // always-empty checklist is a legitimate (if minimal) implementation of
  // that contract and lets step 4 genuinely run against a foreign root
  // rather than being stopped short of it.
  writeFileSync(
    join(dir, "scripts/reachability.mjs"),
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({ checklist: [] }));\n",
  );

  // Its own decisions/ corpus — ONE ADR record, named so it cannot be
  // mistaken for anything in revoy2's real decisions/.
  const decisionsDir = join(dir, "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(
    join(decisionsDir, "ADR-001-quillwort-fixture-decision.md"),
    [
      "# ADR-001: Quillwort Fixture Decision",
      "",
      "**Status:** Accepted",
      "**Date:** 2026-08-18",
      "",
      "## Context",
      "",
      "This record exists only inside the cross-contamination test fixture.",
      "",
      "## Decision",
      "",
      "Prove vi-emit.ts derives its decisions corpus from --root, not REPO_ROOT.",
      "",
      "## Consequences",
      "",
      "None outside this fixture.",
      "",
    ].join("\n"),
  );

  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture base");

  mkdirSync(join(dir, "node_modules"));
  symlinkSync(REAL_TYPESCRIPT, join(dir, "node_modules/typescript"), "dir");
  return dir;
}

describe("vi-refresh --root — cross-contamination (Roadmap 23 §5 acceptance test)", () => {
  it("the fixture's graph carries the fixture's own data and none of revoy2's, and revoy2's own graph is untouched", () => {
    fixture = buildFixture();

    // ADR-169: `.visual-intelligence/graph/` is gitignored, never committed,
    // so a fresh `git worktree add --detach` snapshot legitimately starts
    // with no graph at all — nothing to read as a "before" state there.
    const repoGraphPath = join(SNAPSHOT_DIR, ".visual-intelligence/graph/nodes.jsonl");
    expect(existsSync(repoGraphPath)).toBe(false);
    const repoManifestBefore = readFileSync(join(SNAPSHOT_DIR, ".visual-intelligence/manifest.json"), "utf-8");

    const result = spawnSync(process.execPath, [SNAPSHOT_VI_REFRESH, "--root", fixture], {
      cwd: SNAPSHOT_DIR,
      encoding: "utf-8",
      env: { ...process.env, HOME: ISOLATED_HOME },
    });
    expect(result.status, `vi-refresh --root ${fixture} failed:\n${result.stdout}${result.stderr}`).toBe(0);

    // The honest-boundary stop must be GONE: the full six steps ran.
    expect(result.stdout).not.toContain("Steps 2-6");
    expect(result.stdout).toContain("2/6 intended plane");
    expect(result.stdout).toContain("4/6 cross-check");
    expect(result.stdout).toContain("5/6 validate");
    expect(result.stdout).toContain("5.5/6 stabilize finding ids");
    expect(result.stdout).toContain("6/6 rendered");
    expect(result.stdout).toContain("AGREE");

    const graphDir = join(fixture, ".visual-intelligence/graph");
    const nodes = readFileSync(join(graphDir, "nodes.jsonl"), "utf-8")
      .split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
    const exceptionsPath = join(fixture, ".visual-intelligence/exceptions/exceptions.jsonl");
    const manifest = JSON.parse(readFileSync(join(fixture, ".visual-intelligence/manifest.json"), "utf-8"));

    // ---- 1. POSITIVE: the fixture's own data is really there. ----
    expect(nodes.some((n) => n.name === "quillwortOnlySymbol")).toBe(true);
    const adrNode = nodes.find((n) => n.kind === "record" && n.name === "ADR-001");
    expect(adrNode).toBeDefined();
    expect(adrNode.qualified_name).toBe("Quillwort Fixture Decision");
    // The id namespace is the fixture's own declared project_id, never the
    // literal "revoy2" — proof the NS fallback isn't silently hardcoded.
    expect(adrNode.id).toBe("rec:quillwort:ADR-001");
    expect(adrNode.attributes.namespace).toBe("quillwort");
    expect(existsSync(exceptionsPath)).toBe(true); // the waiver store step actually ran

    // ---- 2. NEGATIVE: none of revoy2's own real governance corpus leaked
    // in. ADR-073 is a REAL, revoy2-only record (this very follow-up's own
    // originating ADR) — its presence here would be definitive proof of
    // exactly the §5 failure mode this test exists to catch. ----
    expect(nodes.some((n) => n.kind === "record" && n.name === "ADR-073")).toBe(false);
    expect(nodes.some((n) => typeof n.qualified_name === "string" && n.qualified_name.includes("Project Profile"))).toBe(false);
    // No revoy2 real source file (e.g. this very test file's own directory)
    // was treated as part of the fixture's citation-derived file nodes.
    expect(nodes.some((n) => n.kind === "file" && typeof n.repository_path === "string" && n.repository_path.startsWith("packages/"))).toBe(false);
    expect(manifest.extractors?.some((e) => e.name === "revoy2-extract-intent")).toBe(true); // the tool's own identity, not the data
    const manifestText = JSON.stringify(manifest);
    expect(manifestText).not.toContain("ADR-073");

    // ---- 3. The snapshot's own real graph is untouched: still never
    // created. A file that never exists is stronger evidence of correct
    // root-scoping than a byte-for-byte compare would be here. ----
    expect(existsSync(repoGraphPath)).toBe(false);
    const repoManifestAfter = readFileSync(join(SNAPSHOT_DIR, ".visual-intelligence/manifest.json"), "utf-8");
    expect(repoManifestAfter).toBe(repoManifestBefore);
  }, 120_000);
});
