import { describe, expect, it, afterEach, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveRepositoryCounts } from "../../packages/arbor-governance/src/counts/derive.ts";
import { profileOrDefaults } from "../lib/project-profile.mjs";

/**
 * scripts/tests/vi-emit-source-roots.test.mjs — the acceptance test named by
 * Roadmap 23 §5 for the LAST unwired consumer of `@arbor/governance`'s
 * `source_roots` seam (commit 6948fc94): "a fixture project whose sources
 * live in `src/` rather than `packages/`, driven through the real
 * `vi-refresh --root <fixture>` pipeline, must have its symbols counted and
 * its graph populated."
 *
 * 6948fc94 made `buildIntentGraph` and `deriveRepositoryCounts` accept
 * `sourceRoots`/`source_roots` as options, but left every caller passing
 * nothing — so both still defaulted to the literal `"packages"` and a
 * `src/`-rooted project's citations and package/file counts were silently
 * indistinguishable from an empty project. `scripts/vi-emit.ts` and
 * `scripts/render-governance-counts.mjs` now read `profileOrDefaults(root)
 * .source_roots` and thread it through, closing that gap.
 *
 * This fixture's ONLY source root is `src/` (never `packages/`), with one
 * package (`widget`) containing one exported symbol AND a citation comment
 * naming the fixture's own ADR — so both halves of the roadmap's acceptance
 * test are covered by one fixture:
 *
 *   - "symbols counted" — `deriveRepositoryCounts` (as
 *     `render-governance-counts.mjs` now calls it) must report
 *     `packages: 1` / `src_files: 1`, not a false `0`.
 *   - "graph populated" — the real `vi-refresh --root <fixture>` pipeline
 *     (which runs `scripts/vi-emit.ts`) must emit a `justifies` edge from
 *     the fixture's own ADR record to `src/widget/src/index.ts`, proving
 *     `buildIntentGraph`'s citation scan walked `src/`, not `packages/`.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VI_REFRESH = join(REPO_ROOT, "scripts/vi-refresh.mjs");
const VI_EMIT_PATH = join(REPO_ROOT, "scripts/vi-emit.ts");
const REAL_TYPESCRIPT = join(REPO_ROOT, "node_modules/typescript");
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "vi-emit-source-roots-home-"));

/**
 * The "TEETH" test below used to `writeFileSync` a reverted copy of
 * `scripts/vi-emit.ts` directly over the LIVE file at REPO_ROOT for the
 * duration of a `bun vi-emit.ts` subprocess call, restoring the original in
 * a `finally`. That is the same live-mutation hazard fixed in
 * `docs-truth-registration-integrity-portability.test.mjs` (ADR-078 case
 * 1/2 hybrid) and `vi-decisions-dir-portability.test.mjs`: any concurrent
 * reader of `scripts/vi-emit.ts` during that window — another gate, a
 * sibling agent's own edit — would observe the reverted, temporarily broken
 * script, and a crash between the write and the `finally` would leave it
 * that way. Fixed the same way: a frozen `git worktree --detach` snapshot
 * at module load (the `gate-failure-modes.test.mjs` idiom), with the
 * mutation confined to that private copy. REPO_ROOT's own `scripts/` is
 * never written to.
 */
const SNAPSHOT_PARENT = mkdtempSync(join(dirname(REPO_ROOT), ".vi-emit-source-roots-snapshot-"));
const SNAPSHOT_DIR = join(SNAPSHOT_PARENT, "repo");
execFileSync("git", ["worktree", "add", "-q", "--detach", SNAPSHOT_DIR, "HEAD"], { cwd: REPO_ROOT });
execFileSync("cp", ["-al", join(REPO_ROOT, "node_modules"), join(SNAPSHOT_DIR, "node_modules")]);
const SNAPSHOT_VI_EMIT_PATH = join(SNAPSHOT_DIR, "scripts/vi-emit.ts");

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
  const dir = mkdtempSync(join(tmpdir(), "vi-emit-source-roots-"));
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "fixture@fixture.test");
  git(dir, "config", "user.name", "fixture");

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "hollowgate-fixture" }));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

  // The load-bearing part of this fixture: sources live under "src", not
  // "packages" — the exact layout Roadmap 23 §5 names.
  writeFileSync(
    join(dir, "arbor.profile.jsonc"),
    JSON.stringify(
      {
        schema_version: 1,
        project_id: "hollowgate",
        language: "typescript",
        source_roots: ["src"],
        governance: {
          decisions_dir: "decisions",
          evidence_stores: [".visual-intelligence"],
          arbor_dir: ".arbor",
          allowlist_path: "scripts/reachability/allowlist.json",
        },
      },
      null,
      2,
    ),
  );

  // One package under src/, one exported symbol, and a citation of the
  // fixture's own ADR — the citation is what proves the graph gets
  // populated: buildIntentGraph's scan must walk "src", not "packages", to
  // ever see this comment.
  const srcDir = join(dir, "src/widget/src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "index.ts"),
    "// Implements ADR-001\nexport function hollowgateOnlySymbol() { return 1; }\nhollowgateOnlySymbol();\n",
  );

  mkdirSync(join(dir, "scripts/reachability"), { recursive: true });
  writeFileSync(
    join(dir, "scripts/reachability/entry-points.json"),
    JSON.stringify({ entryPoints: [{ id: "widget", file: "src/widget/src/index.ts" }] }),
  );
  writeFileSync(join(dir, "scripts/reachability/allowlist.json"), JSON.stringify({ version: 1, entries: [] }));
  writeFileSync(
    join(dir, "scripts/reachability.mjs"),
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({ checklist: [] }));\n",
  );

  const decisionsDir = join(dir, "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(
    join(decisionsDir, "ADR-001-hollowgate-fixture-decision.md"),
    [
      "# ADR-001: Hollowgate Fixture Decision",
      "",
      "**Status:** Accepted",
      "**Date:** 2026-08-18",
      "",
      "## Context",
      "",
      "This record exists only inside the source-roots-portability fixture.",
      "",
      "## Decision",
      "",
      "Prove vi-emit.ts and render-governance-counts.mjs honor source_roots.",
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

function readNodes(fixtureDir) {
  return readFileSync(join(fixtureDir, ".visual-intelligence/graph/nodes.jsonl"), "utf-8")
    .split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

function readEdges(fixtureDir) {
  return readFileSync(join(fixtureDir, ".visual-intelligence/graph/edges.jsonl"), "utf-8")
    .split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

describe("vi-emit.ts / render-governance-counts.mjs — source_roots portability (Roadmap 23 B2, last consumer)", () => {
  it("a src/-rooted fixture has its symbols counted and its citation graph populated through the real vi-refresh --root pipeline", () => {
    fixture = buildFixture();

    // ---- "symbols counted" — the same profile-driven call
    // render-governance-counts.mjs now makes. ----
    const profile = profileOrDefaults(fixture);
    expect(profile.source_roots).toEqual(["src"]);
    const counts = deriveRepositoryCounts(fixture, {
      sourceRoots: profile.source_roots,
      decisionsDir: profile.governance.decisions_dir,
      allowlistPath: profile.governance.allowlist_path,
    });
    expect(counts.unmeasured).not.toContain("packages");
    expect(counts.packages).toBe(1);
    expect(counts.src_files).toBe(1);

    // A false zero — the exact defect this closes — is what the DEFAULT
    // options (no sourceRoots passed) would have produced for this layout.
    const unwired = deriveRepositoryCounts(fixture);
    expect(unwired.packages).toBe(0);
    expect(unwired.src_files).toBe(0);

    // ---- "graph populated" — the real six-step pipeline. ----
    const result = spawnSync(process.execPath, [VI_REFRESH, "--root", fixture], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, HOME: ISOLATED_HOME },
    });
    expect(result.status, `vi-refresh --root ${fixture} failed:\n${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("AGREE");

    const nodes = readNodes(fixture);
    const edges = readEdges(fixture);
    const adrNode = nodes.find((n) => n.kind === "record" && n.name === "ADR-001");
    expect(adrNode).toBeDefined();
    expect(adrNode.id).toBe("rec:hollowgate:ADR-001");

    const justifies = edges.find((e) => e.source === adrNode.id && e.relation === "justifies");
    expect(justifies, "no justifies edge — the src/ citation was not found").toBeDefined();
    expect(justifies.evidence_location).toContain("src/widget/src/index.ts");

    // The citation upgrades the record from an unwitnessed claim.
    expect(adrNode.implementation_status).toBe("implemented");
  }, 120_000);

  it("TEETH: reverting vi-emit.ts's root wiring makes the src/ citation come up MISSING", () => {
    fixture = buildFixture();

    const original = readFileSync(SNAPSHOT_VI_EMIT_PATH, "utf-8");
    try {
      // BOTH root options must come out, not just sourceRoots. Since
      // ADR-080 the citation scan is driven by `citationRoots`, which
      // DEFAULTS to sourceRoots — so stripping sourceRoots alone leaves
      // citationRoots still feeding the fixture's own ["src"] through and
      // the citation would still resolve, silently defanging this test.
      // That is not hypothetical: adding citationRoots to vi-emit.ts broke
      // this assertion, and the staleness guard below is what caught it.
      const reverted = original.replace(
        "const intent = buildIntentGraph(root, {\n    decisionsDir: profile.governance.decisions_dir,\n    sourceRoots: profile.source_roots,\n    // Separate from source_roots on purpose \u2014 see BuildIntentGraphOptions.\n    citationRoots: profile.citation_roots,\n  });",
        "const intent = buildIntentGraph(root, {\n    decisionsDir: profile.governance.decisions_dir,\n  });",
      );
      expect(reverted, "revert pattern did not match vi-emit.ts — test is stale").not.toBe(original);
      writeFileSync(SNAPSHOT_VI_EMIT_PATH, reverted);

      const result = spawnSync("bun", [SNAPSHOT_VI_EMIT_PATH, "--root", fixture], {
        cwd: SNAPSHOT_DIR,
        encoding: "utf-8",
        env: { ...process.env, HOME: ISOLATED_HOME },
      });
      expect(result.status, `vi-emit --root ${fixture} failed:\n${result.stdout}${result.stderr}`).toBe(0);

      const nodes = readNodes(fixture);
      const edges = readEdges(fixture);
      const adrNode = nodes.find((n) => n.kind === "record" && n.name === "ADR-001");
      expect(adrNode).toBeDefined();

      // With the seam reverted, buildIntentGraph falls back to its own
      // default sourceRoots (["packages"]) — this fixture has no packages/
      // directory at all, so the citation inside src/widget/src/index.ts is
      // never seen: no justifies edge, and the record stays an unwitnessed
      // "declared_only" claim even though the citing code is right there.
      const justifies = edges.find((e) => e.source === adrNode.id && e.relation === "justifies");
      expect(justifies).toBeUndefined();
      expect(adrNode.implementation_status).toBe("declared_only");
    } finally {
      writeFileSync(SNAPSHOT_VI_EMIT_PATH, original);
    }
  }, 60_000);
});
