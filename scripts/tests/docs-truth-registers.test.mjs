/**
 * D54 regression: the product-quality and decision declarations are not
 * decorative comments. A missing declaration must make the real docs-truth
 * CLI fail against a frozen worktree, without touching a concurrent checkout.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SNAPSHOT_PARENT = mkdtempSync(join(dirname(REPO_ROOT), ".docs-truth-register-snapshot-"));
const SNAPSHOT_DIR = join(SNAPSHOT_PARENT, "repo");
execFileSync("git", ["worktree", "add", "-q", "--detach", SNAPSHOT_DIR, "HEAD"], { cwd: REPO_ROOT });
execFileSync("cp", ["-al", join(REPO_ROOT, "node_modules"), join(SNAPSHOT_DIR, "node_modules")]);

afterAll(() => {
  execFileSync("git", ["worktree", "remove", "--force", SNAPSHOT_DIR], { cwd: REPO_ROOT });
  rmSync(SNAPSHOT_PARENT, { recursive: true, force: true });
});

function runDocsTruth() {
  return spawnSync("node", ["scripts/docs-truth.mjs", "--json"], {
    cwd: SNAPSHOT_DIR,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

describe("docs-truth D54 documentation registers", () => {
  it("fails closed when a required PQ status declaration is removed", () => {
    const qualityPath = join(SNAPSHOT_DIR, "docs/product-quality-audit-2026-08-20.md");
    const source = readFileSync(qualityPath, "utf-8");
    const marker = "<!-- docs-truth: register=pq id=PQ-08 state=open evidence=packages/arbor-mcp/src/tui.ts -->\n";
    expect(source).toContain(marker);
    writeFileSync(qualityPath, source.replace(marker, ""));

    const result = runDocsTruth();
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.violations).toContainEqual(expect.objectContaining({
      tranche: "Product-quality register",
      reason: expect.stringContaining("PQ-08 exactly once"),
    }));
  }, 60_000);
});
