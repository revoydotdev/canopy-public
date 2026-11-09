import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planBranches } from "../lib/conductor/graph.mjs";
import { mechanicalConflictResolution, resolveDiff3Text } from "../lib/conductor/conflicts.mjs";
import { landBranch } from "../lib/conductor/land.mjs";
import { regenerateStores } from "../lib/conductor/stores.mjs";
import { contentId } from "../lib/adr-registry.mjs";

let repo;
let scratch;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(path, text) {
  const absolute = join(repo, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text);
}

function commit(message, path, text) {
  write(path, text);
  git("add", "--", path);
  git("commit", "-q", "-m", message);
}

function command(code = 0) {
  return { command: process.execPath, args: ["-e", `process.exit(${code})`] };
}

function scriptCommand(source) {
  return { command: process.execPath, args: ["-e", source] };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "conductor-repo-"));
  scratch = mkdtempSync(join(tmpdir(), "conductor-scratch-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "conductor@test.invalid");
  git("config", "user.name", "Conductor Test");
  commit("base", "shared.ts", "export const value = 'base';\n");
});

afterEach(() => {
  try { git("rebase", "--abort"); } catch {}
  try { git("worktree", "prune"); } catch {}
  rmSync(scratch, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("integration conductor planning", () => {
  it("builds the conflict graph and topologically orders dependencies", () => {
    git("checkout", "-q", "-b", "feature/a");
    commit("a", "only-a.ts", "a\n");
    git("checkout", "-q", "master");
    git("checkout", "-q", "-b", "feature/b");
    commit("b", "shared.ts", "export const value = 'b';\n");
    git("checkout", "-q", "master");
    git("checkout", "-q", "-b", "feature/c");
    commit("c", "shared.ts", "export const value = 'c';\n");
    git("checkout", "-q", "master");

    const plan = planBranches({
      repo,
      trunk: "master",
      branches: ["feature/c", "feature/b", "feature/a"],
      dependencies: { "feature/c": ["feature/b"] },
    });
    expect(plan.conflicts.find((edge) => edge.left === "feature/c" && edge.right === "feature/b")?.weight).toBe(1);
    expect(plan.order.indexOf("feature/b")).toBeLessThan(plan.order.indexOf("feature/c"));
    expect(plan.order[0]).toBe("feature/a");
  });

  it("rejects a dependency cycle", () => {
    git("branch", "feature/a");
    git("branch", "feature/b");
    expect(() => planBranches({ repo, trunk: "master", branches: ["feature/a", "feature/b"], dependencies: { "feature/a": ["feature/b"], "feature/b": ["feature/a"] } })).toThrow(/cycle/);
  });
});

describe("mechanical conflict boundary", () => {
  it("unions import/export members but refuses an ordinary same-line edit", () => {
    expect(mechanicalConflictResolution({ base: "", ours: "export { alpha } from './x.js';", theirs: "export { beta } from './x.js';" })?.text)
      .toBe("export { alpha, beta } from './x.js';");
    expect(mechanicalConflictResolution({ base: "const n = 1", ours: "const n = 2", theirs: "const n = 3" })).toBeNull();
  });

  it("retains unresolved diff3 markers for semantic conflicts", () => {
    const result = resolveDiff3Text("<<<<<<< HEAD\nconst n = 2\n||||||| parent\nconst n = 1\n=======\nconst n = 3\n>>>>>>> branch\n");
    expect(result.semantic).toBe(true);
    expect(result.text).toContain("<<<<<<< HEAD");
  });
});

describe("isolated landing", () => {
  it("allocates a pending ADR after rebase and before landing", () => {
    write("decisions/README.md", "# ADR Index\n\n| # | Title | Status |\n|---|---|---|\n");
    write("decisions/registry.json", `${JSON.stringify({ schema_version: 1, next_available: 44, reserved: [45], reserved_reason: { 45: "external" }, allocations: [] }, null, 2)}\n`);
    git("add", "decisions");
    git("commit", "-q", "-m", "registry base");
    const revision = git("rev-parse", "HEAD");
    const id = contentId({ title: "Conductor Allocation", createdAt: "2026-08-12", authoringRevision: revision });
    git("checkout", "-q", "-b", "feature/pending-adr");
    commit("pending decision", "decisions/ADR-PENDING-conductor-allocation.md", `# ADR-PENDING: Conductor Allocation\n\n**Status:** Proposed\n**Date:** 2026-08-12\n**Authoring Revision:** ${revision}\n**Content ID:** ${id}\n`);
    git("checkout", "-q", "master");
    const result = landBranch({ repo, trunk: "master", branch: "feature/pending-adr", scratchRoot: scratch, verifyCommands: [command()] });
    expect(result.ok).toBe(true);
    expect(result.allocations.map((entry) => entry.number)).toEqual([44]);
    expect(git("show", "master:decisions/ADR-044-conductor-allocation.md")).toContain("# ADR-044: Conductor Allocation");
  });

  it("refuses a movable trunk ref as declared_base", () => {
    git("branch", "feature/invalid-base");
    expect(() => landBranch({ repo, trunk: "master", branch: "feature/invalid-base", declaredBase: "master", scratchRoot: scratch, verifyCommands: [command()] })).toThrow(/stable stacked-branch base/);
  });

  it("never advances trunk when an isolation command is red", () => {
    git("checkout", "-q", "-b", "feature/red");
    commit("red", "red.ts", "broken\n");
    git("checkout", "-q", "master");
    const before = git("rev-parse", "master");
    const result = landBranch({ repo, trunk: "master", branch: "feature/red", scratchRoot: scratch, verifyCommands: [command(7)] });
    expect(result.state).toBe("verification_failed");
    expect(git("rev-parse", "master")).toBe(before);
  });

  it("prepares a fresh isolation worktree before verification", () => {
    git("checkout", "-q", "-b", "feature/prepared");
    commit("feature", "prepared.ts", "prepared\n");
    git("checkout", "-q", "master");
    const marker = join(scratch, "dependency-ready");
    const result = landBranch({
      repo,
      trunk: "master",
      branch: "feature/prepared",
      scratchRoot: scratch,
      prepareCommands: [scriptCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`)],
      verifyCommands: [scriptCommand(`process.exit(require('node:fs').existsSync(${JSON.stringify(marker)}) ? 0 : 9)`)],
    });
    expect(result).toMatchObject({ ok: true, preparation: { ok: true }, verification: { ok: true } });
  });

  it("preserves reviewed merge ancestry when trunk is already an ancestor", () => {
    git("checkout", "-q", "-b", "feature/preserve-history");
    commit("primary feature", "primary.ts", "primary\n");
    git("checkout", "-q", "-b", "feature/preserve-side", "master");
    commit("side feature", "side.ts", "side\n");
    git("checkout", "-q", "feature/preserve-history");
    git("merge", "-q", "--no-ff", "-m", "merge reviewed side", "feature/preserve-side");
    const reviewedTip = git("rev-parse", "HEAD");
    git("checkout", "-q", "master");
    const result = landBranch({ repo, trunk: "master", branch: "feature/preserve-history", scratchRoot: scratch, verifyCommands: [command()] });
    expect(result.ok).toBe(true);
    expect(git("rev-parse", "master")).toBe(reviewedTip);
  });

  it("runs an ADR-attributed merge-critical property before isolation and refuses a red composition", () => {
    write("decisions/ADR-001-test.md", "# ADR-001: Test\n\n**Status:** Proposed\n**Date:** 2026-08-12\n");
    write("decisions/README.md", "# ADR Index\n\n| # | Title | Status |\n|---|---|---|\n| [001](ADR-001-test.md) | Test | Proposed |\n");
    write("tests/safety.test.mjs", "export {};\n");
    write("docs/merge-critical-properties.jsonc", JSON.stringify({ schema_version: 1, properties: [{
      property_id: "test.safety", adr: "ADR-001", statement: "the composed value stays safe",
      watch_globs: ["src/*.ts"], test_id: "tests/safety.test.mjs",
    }] }));
    git("add", "decisions", "docs", "tests");
    git("commit", "-q", "-m", "merge critical base");
    git("checkout", "-q", "-b", "feature/unsafe-composition");
    commit("unsafe edit", "src/value.ts", "export const safe = false;\n");
    git("checkout", "-q", "master");
    const before = git("rev-parse", "master");
    const seen = [];

    const result = landBranch({
      repo, trunk: "master", branch: "feature/unsafe-composition", scratchRoot: scratch,
      verifyCommands: [command()],
      hooks: {
        onMergeCriticalProperty: (message) => seen.push(message),
        runMergeCriticalTest: () => ({ status: 9, stdout: "", stderr: "property failed" }),
      },
    });

    expect(result).toMatchObject({ state: "merge_critical_failed", merge_critical: { state: "property_failed", selected: ["test.safety"] } });
    expect(seen).toEqual([expect.stringContaining("ADR-001")]);
    expect(git("rev-parse", "master")).toBe(before);
  });

  it("refuses same-commit ADR self-acceptance before merge-critical or isolation verification", () => {
    write("decisions/README.md", "# ADR Index\n\n| # | Title | Status |\n|---|---|---|\n");
    git("add", "decisions/README.md");
    git("commit", "-q", "-m", "decision index base");
    git("checkout", "-q", "-b", "feature/self-accepted-adr");
    write("decisions/ADR-999-self-accepted.md", "# ADR-999: Self accepted\n\n**Status:** Accepted\n**Date:** 2026-08-12\n\n## Decision\n\nBundled.\n");
    write("decisions/README.md", "# ADR Index\n\n| # | Title | Status |\n|---|---|---|\n| [999](ADR-999-self-accepted.md) | Self accepted | Accepted |\n");
    git("add", "decisions");
    git("commit", "-q", "-m", "self accept decision");
    git("checkout", "-q", "master");
    const before = git("rev-parse", "master");

    const result = landBranch({ repo, trunk: "master", branch: "feature/self-accepted-adr", scratchRoot: scratch, verifyCommands: [command()] });

    expect(result).toMatchObject({ state: "adr_acceptance_failed", acceptance: { violations: [{ code: "new_adr_not_proposed" }] } });
    expect(git("rev-parse", "master")).toBe(before);
  });

  it("discards feature-branch measurement snapshots before verification and landing", () => {
    commit("trunk evidence", ".determinism-baseline/manifest.json", "trunk snapshot\n");
    git("checkout", "-q", "-b", "feature/snapshot");
    commit("branch snapshot", ".determinism-baseline/manifest.json", "branch snapshot\n");
    commit("feature", "feature.ts", "feature\n");
    git("checkout", "-q", "master");
    const result = landBranch({ repo, trunk: "master", branch: "feature/snapshot", scratchRoot: scratch, verifyCommands: [command()] });
    expect(result.ok).toBe(true);
    expect(git("show", "master:.determinism-baseline/manifest.json")).toBe("trunk snapshot");
    expect(git("show", "master:feature.ts")).toBe("feature");
  });

  it("preserves branch measurements only when freshness is independently proven", () => {
    commit("trunk evidence", ".determinism-baseline/manifest.json", "trunk snapshot\n");
    git("checkout", "-q", "-b", "feature/fresh-snapshot");
    commit("fresh branch snapshot", ".determinism-baseline/manifest.json", "fresh branch snapshot\n");
    git("checkout", "-q", "master");
    const result = landBranch({
      repo,
      trunk: "master",
      branch: "feature/fresh-snapshot",
      scratchRoot: scratch,
      verifyCommands: [command()],
      hooks: { isMeasurementSnapshotFresh: () => true },
    });
    expect(result.ok).toBe(true);
    expect(git("show", "master:.determinism-baseline/manifest.json")).toBe("fresh branch snapshot");
  });

  it("refuses a same-line semantic conflict and leaves trunk untouched", () => {
    git("checkout", "-q", "-b", "feature/conflict");
    commit("feature edit", "shared.ts", "export const value = 'feature';\n");
    git("checkout", "-q", "master");
    commit("trunk edit", "shared.ts", "export const value = 'trunk';\n");
    const before = git("rev-parse", "master");
    const result = landBranch({ repo, trunk: "master", branch: "feature/conflict", scratchRoot: scratch, verifyCommands: [command()] });
    expect(result.state).toBe("semantic_conflict");
    expect(result.semantic_conflicts).toEqual(["shared.ts"]);
    expect(git("rev-parse", "master")).toBe(before);
  });

  it("resumes the conductor-owned detached rebase worktree after manual semantic resolution", () => {
    git("checkout", "-q", "-b", "feature/resume-conflict");
    commit("feature edit", "shared.ts", "export const value = 'feature';\n");
    git("checkout", "-q", "master");
    commit("trunk edit", "shared.ts", "export const value = 'trunk';\n");
    const first = landBranch({ repo, trunk: "master", branch: "feature/resume-conflict", scratchRoot: scratch, verifyCommands: [command()] });
    expect(first.state).toBe("semantic_conflict");
    writeFileSync(join(first.worktree, "shared.ts"), "export const value = 'resolved';\n");
    execFileSync("git", ["add", "shared.ts"], { cwd: first.worktree });
    const resumed = landBranch({ repo, trunk: "master", branch: "feature/resume-conflict", scratchRoot: scratch, acceptManualResolution: true, verifyCommands: [command()] });
    expect(resumed.ok).toBe(true);
    expect(git("show", "master:shared.ts")).toContain("resolved");
  });

  it("re-reads the advancing trunk for every branch", () => {
    git("checkout", "-q", "-b", "feature/first");
    commit("first", "first.ts", "first\n");
    git("checkout", "-q", "master");
    git("checkout", "-q", "-b", "feature/second");
    commit("second", "second.ts", "second\n");
    git("checkout", "-q", "master");
    const initial = git("rev-parse", "master");
    const first = landBranch({ repo, trunk: "master", branch: "feature/first", scratchRoot: scratch, verifyCommands: [command()] });
    expect(first.ok).toBe(true);
    const advanced = git("rev-parse", "master");
    expect(advanced).not.toBe(initial);
    const second = landBranch({ repo, trunk: "master", branch: "feature/second", scratchRoot: scratch, verifyCommands: [command()] });
    expect(second.ok).toBe(true);
    expect(second.previous_trunk_revision).toBe(advanced);
    expect(git("merge-base", "--is-ancestor", advanced, "master")).toBe("");
  });

  it("detects trunk movement after verification and refuses the stale fast-forward", () => {
    git("checkout", "-q", "-b", "feature/race");
    commit("feature", "feature.ts", "feature\n");
    git("checkout", "-q", "master");
    const result = landBranch({
      repo,
      trunk: "master",
      branch: "feature/race",
      scratchRoot: scratch,
      verifyCommands: [command()],
      hooks: { afterTrunkRead: () => commit("concurrent trunk", "concurrent.ts", "advanced\n") },
    });
    expect(result.state).toBe("trunk_moved");
    expect(git("show", "master:concurrent.ts")).toBe("advanced");
  });
});

describe("store regeneration", () => {
  it("stops on the first failed producer", () => {
    const markerPath = join(repo, ".git", "test-store-regeneration.json");
    const result = regenerateStores(repo, [
      { name: "first", ...command() },
      { name: "second", ...command(3) },
      { name: "never", ...command() },
    ], { markerPath });
    expect(result.ok).toBe(false);
    expect(result.results.map((entry) => entry.name)).toEqual(["first", "second"]);
    expect(result.marker).toBe(markerPath);
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({ phase: "failed", failed_producer: "second", status: 3 });
  });

  it("clears its marker only after producers and freshness validation succeed", () => {
    const markerPath = join(repo, ".git", "test-store-regeneration-success.json");
    const result = regenerateStores(repo, [{ name: "first", ...command() }], { markerPath });
    expect(result.ok).toBe(true);
    expect(result.marker).toBeNull();
    expect(existsSync(markerPath)).toBe(false);
  });
});
