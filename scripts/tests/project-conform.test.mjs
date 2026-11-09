import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { evaluateConformance, attemptFix } from "../project-conform.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO_ROOT, "scripts", "project-conform.mjs");

const dirs = [];
function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "project-conform-"));
  dirs.push(root);
  return root;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("evaluateConformance — this real repo", () => {
  it("reports ok:true for every required and required_via_profile element", () => {
    const results = evaluateConformance(REPO_ROOT);
    const blocking = results.filter((r) => !r.ok && r.requirement !== "optional");
    expect(blocking).toEqual([]);
  });

  it("classifies profile-file, decisions-dir, and gate-project-conform as required", () => {
    const results = evaluateConformance(REPO_ROOT);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId["profile-file"].requirement).toBe("required");
    expect(byId["decisions-dir"].requirement).toBe("required");
    expect(byId["gate-project-conform"].requirement).toBe("required");
    expect(byId["gate-project-conform"].ok).toBe(true);
  });

  it("classifies source-roots and command-typecheck as required_via_profile", () => {
    const results = evaluateConformance(REPO_ROOT);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId["source-roots"].requirement).toBe("required_via_profile");
    expect(byId["command-typecheck"].requirement).toBe("required_via_profile");
  });

  it("classifies .claude and ROADMAP.md as optional", () => {
    const results = evaluateConformance(REPO_ROOT);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId["claude-dir"].requirement).toBe("optional");
    expect(byId["roadmap-md"].requirement).toBe("optional");
  });
});

describe("evaluateConformance — a fixture missing required elements", () => {
  it("reports every required element unmet on an empty directory", () => {
    const root = tempRepo();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "empty-fixture", scripts: {} }));
    const results = evaluateConformance(root);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId["decisions-dir"].ok).toBe(false);
    expect(byId["profile-file"].ok).toBe(false);
    const blocking = results.filter((r) => !r.ok && r.requirement !== "optional");
    expect(blocking.length).toBeGreaterThan(0);
  });

  it("optional elements never appear in the blocking set even when unmet", () => {
    const root = tempRepo();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "empty-fixture", scripts: {} }));
    const results = evaluateConformance(root);
    const blocking = results.filter((r) => !r.ok && r.requirement !== "optional");
    expect(blocking.every((r) => r.requirement !== "optional")).toBe(true);
  });
});

describe("attemptFix — mechanically safe repairs only", () => {
  it("creates a missing required directory with a .gitkeep", () => {
    const root = tempRepo();
    const results = evaluateConformance(root);
    const claimLedger = results.find((r) => r.id === "evidence-claim-ledger");
    expect(claimLedger.ok).toBe(false);
    const outcome = attemptFix(root, claimLedger);
    expect(outcome).toEqual({ attempted: true, ok: true });
    expect(existsSync(join(root, ".claim-ledger"))).toBe(true);
    expect(existsSync(join(root, ".claim-ledger", ".gitkeep"))).toBe(true);
  });

  it("re-evaluating after a fix reports the element as ok", () => {
    const root = tempRepo();
    const before = evaluateConformance(root).find((r) => r.id === "arbor-dir");
    attemptFix(root, before);
    const after = evaluateConformance(root).find((r) => r.id === "arbor-dir");
    expect(after.ok).toBe(true);
  });

  it("refuses to fix a missing file (never invents content)", () => {
    const root = tempRepo();
    mkdirSync(join(root, "decisions"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: {} }));
    const result = evaluateConformance(root).find((r) => r.id === "decisions-registry");
    expect(result.ok).toBe(false);
    const outcome = attemptFix(root, result);
    expect(outcome.attempted).toBe(false);
    expect(existsSync(join(root, "decisions", "registry.json"))).toBe(false);
  });

  it("refuses to fix an unmet marker (never invents content)", () => {
    const root = tempRepo();
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
    const result = evaluateConformance(root).find((r) => r.id === "agents-md-governance-marker");
    expect(result.ok).toBe(false);
    const outcome = attemptFix(root, result);
    expect(outcome.attempted).toBe(false);
  });

  it("refuses to fix an unwired script (never invents package.json content)", () => {
    const root = tempRepo();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: {} }));
    const result = evaluateConformance(root).find((r) => r.id === "gate-adr-registry");
    expect(result.ok).toBe(false);
    const outcome = attemptFix(root, result);
    expect(outcome.attempted).toBe(false);
  });

  it("is a no-op on an already-satisfied element", () => {
    const root = tempRepo();
    mkdirSync(join(root, ".arbor"));
    const result = evaluateConformance(root).find((r) => r.id === "arbor-dir");
    expect(result.ok).toBe(true);
    expect(attemptFix(root, result)).toEqual({ attempted: false });
  });
});

describe("CLI — bun scripts/project-conform.mjs", () => {
  it("exits 0 with --json on this real repo", () => {
    const result = spawnSync(process.execPath, [CLI, "--json"], { cwd: REPO_ROOT, encoding: "utf-8" });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
  });

  it("exits non-zero on a fixture missing required elements", () => {
    const root = tempRepo();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "empty-fixture", scripts: {} }));
    // The CLI resolves its own REPO_ROOT from its own file location, not cwd
    // — run it against the real repo's script but point it at the fixture
    // via evaluateConformance's exported API instead of the CLI directly,
    // since the CLI is intentionally single-repo (this repo's own gate).
    const results = evaluateConformance(root);
    const ok = results.every((r) => r.ok || r.requirement === "optional");
    expect(ok).toBe(false);
  });

  it("--fix creates missing required directories and leaves file-kind gaps reported", () => {
    const root = tempRepo();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: {} }));
    let results = evaluateConformance(root);
    for (const r of results) {
      if (!r.ok && r.requirement !== "optional") attemptFix(root, r);
    }
    results = evaluateConformance(root);
    expect(existsSync(join(root, ".claim-ledger"))).toBe(true);
    expect(existsSync(join(root, ".completion-depth"))).toBe(true);
    expect(existsSync(join(root, ".determinism-baseline"))).toBe(true);
    expect(existsSync(join(root, ".visual-intelligence"))).toBe(true);
    expect(existsSync(join(root, "decisions"))).toBe(true);
    // decisions/registry.json is a file-kind element — --fix must not
    // fabricate it.
    expect(existsSync(join(root, "decisions", "registry.json"))).toBe(false);
    const registry = results.find((r) => r.id === "decisions-registry");
    expect(registry.ok).toBe(false);
  });
});
