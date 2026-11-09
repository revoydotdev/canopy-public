import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoDetectFile, resolveProof } from "../adr-proof.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "adr-proof.mjs");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("resolveProof — against the real repository (in-process, matches the gate's own resolver)", () => {
  it("resolves an exported symbol with an explicit --file and an existing, collected --test", () => {
    const result = resolveProof({
      symbol: "deriveRecordId",
      file: "packages/arbor-governance/src/obligation/parse.ts",
      roundtrip: "scripts/tests/adr-registry.test.mjs",
      repoRoot: REPO_ROOT,
    });
    expect(result.ok).toBe(true);
    expect(result.comment).toBe(
      "<!-- proof: symbol=deriveRecordId file=packages/arbor-governance/src/obligation/parse.ts roundtrip=scripts/tests/adr-registry.test.mjs -->",
    );
  });

  it("auto-detects the file when --file is omitted, for an unambiguous symbol", () => {
    const detected = autoDetectFile("RuntimePort", REPO_ROOT);
    expect(detected.ok).toBe(true);
    expect(detected.file).toBe("packages/arbor-tui/src/runtime-port.ts");
  });

  it("reports ambiguity when a symbol is exported/re-exported from multiple files (deriveRecordId is barrel-re-exported)", () => {
    const detected = autoDetectFile("deriveRecordId", REPO_ROOT);
    expect(detected.ok).toBe(false);
    expect(detected.reason).toMatch(/declared\/exported in \d+ files/);
  });

  // The ADR-088 case: a symbol name that exists in prose/commit messages but
  // is not actually exported anywhere — this is exactly what shipped wrong
  // and was only caught after allocation by gate:obligations.
  it("FAILS on a non-exported symbol (the ADR-088 case: validateAction was never exported)", () => {
    const result = resolveProof({
      symbol: "validateAction",
      file: "packages/arbor-mcp/src/task-composer-contracts.ts",
      roundtrip: "scripts/tests/adr-registry.test.mjs",
      repoRoot: REPO_ROOT,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not declared or exported/);
  });

  it("FAILS on a non-exported class name (the ADR-088 case: NativeRepositoryToolHost is not a real export)", () => {
    const result = resolveProof({
      symbol: "NativeRepositoryToolHost",
      repoRoot: REPO_ROOT,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not declared or exported anywhere/);
  });

  it("FAILS when the roundtrip test file does not exist", () => {
    const result = resolveProof({
      symbol: "deriveRecordId",
      file: "packages/arbor-governance/src/obligation/parse.ts",
      roundtrip: "scripts/tests/does-not-exist.test.mjs",
      repoRoot: REPO_ROOT,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/roundtrip:.*does not exist/);
  });

  it("FAILS when no --test is given at all — an obligation with no roundtrip cannot cite a resolving proof", () => {
    const result = resolveProof({
      symbol: "deriveRecordId",
      file: "packages/arbor-governance/src/obligation/parse.ts",
      repoRoot: REPO_ROOT,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/roundtrip: --test/);
  });
});

describe("resolveProof — against a disposable fixture repo", () => {
  let repo;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "adr-proof-"));
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
    mkdirSync(join(repo, "decisions"), { recursive: true });
    writeFileSync(join(repo, "decisions", "README.md"), "# ADR Index\n");
    // vitest.config.ts include glob is required for roundtrip resolution.
    writeFileSync(join(repo, "vitest.config.ts"), 'export default { test: { include: ["tests/**/*.test.ts"] } };\n');
    mkdirSync(join(repo, "packages", "widget", "src"), { recursive: true });
    writeFileSync(join(repo, "packages", "widget", "src", "index.ts"), "export function widgetize() {}\nfunction helper() {}\n");
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "tests", "widget.test.ts"), "// fixture\n");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("resolves a real top-level export against a collected roundtrip test", () => {
    const result = resolveProof({ symbol: "widgetize", file: "packages/widget/src/index.ts", roundtrip: "tests/widget.test.ts", repoRoot: repo });
    expect(result.ok).toBe(true);
    expect(result.comment).toBe("<!-- proof: symbol=widgetize file=packages/widget/src/index.ts roundtrip=tests/widget.test.ts -->");
  });

  it("FAILS on a symbol that exists in the file but is not exported (the exact ADR-088 shape)", () => {
    const result = resolveProof({ symbol: "helper", file: "packages/widget/src/index.ts", roundtrip: "tests/widget.test.ts", repoRoot: repo });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/symbol:.*not declared or exported/);
  });

  it("FAILS when a roundtrip file exists on disk but is not matched by any vitest include glob", () => {
    writeFileSync(join(repo, "tests", "widget.spec.ts"), "// not collected\n");
    const result = resolveProof({ symbol: "widgetize", file: "packages/widget/src/index.ts", roundtrip: "tests/widget.spec.ts", repoRoot: repo });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/roundtrip:.*not matched by any vitest/);
  });

  it("the CLI resolves the same result in --json mode with exit 0", () => {
    const result = spawnSync("bun", [CLI, "widgetize", "--file", "packages/widget/src/index.ts", "--test", "tests/widget.test.ts", "--repo", repo, "--json"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, symbol: "widgetize", file: "packages/widget/src/index.ts", roundtrip: "tests/widget.test.ts" });
  });

  it("the CLI exits non-zero and reports the reason for the ADR-088-shaped failure", () => {
    const result = spawnSync("bun", [CLI, "helper", "--file", "packages/widget/src/index.ts", "--test", "tests/widget.test.ts", "--repo", repo, "--json"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).ok).toBe(false);
  });
});
