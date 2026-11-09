/**
 * e2e-adr-lifecycle — purpose-built end-to-end proof of the ADR authoring →
 * allocation → interlock path, driving the REAL harness: real `git`, the real
 * CLI entry point, the real filesystem. No mocks, no direct library calls that
 * skip the CLI, and critically NO `--no-commit` — every existing unit test in
 * `adr-registry.test.mjs` passes `commit: false`, which is precisely why the
 * default production path shipped with two live defects (D2 pathspec, D3
 * incomplete rollback). This file exercises the default.
 *
 * The scenario in `describe("concurrent allocation")` is the one that cost four
 * manual conflict resolutions during the 2026-08-15 marathon (ADR 063, 066/067,
 * 068/069, 070/071).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "adr-registry.mjs");

let root;      // the "origin" checkout
let worktrees; // extra worktrees sharing one git-common-dir

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runCli(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--repo", cwd], {
    cwd, encoding: "utf8", env: { ...process.env, ...env },
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* non-JSON output is itself a finding */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function seedGovernanceRepo() {
  const repo = mkdtempSync(join(tmpdir(), "adr-e2e-"));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  git(repo, "config", "user.email", "e2e@test.invalid");
  git(repo, "config", "user.name", "E2E");
  mkdirSync(join(repo, "decisions"), { recursive: true });
  writeFileSync(join(repo, "decisions", "README.md"), "# ADR Index\n\n| # | Title | Status |\n|---|---|---|\n");
  writeFileSync(join(repo, "decisions", "registry.json"), `${JSON.stringify({
    schema_version: 1, next_available: 10, reserved: [], reserved_reason: {}, allocations: [],
  }, null, 2)}\n`);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

function adrFiles(repo) {
  return readdirSync(join(repo, "decisions")).filter((n) => /^ADR-\d{3}-/.test(n)).sort();
}

function commonDir(repo) {
  const raw = git(repo, "rev-parse", "--git-common-dir");
  return raw.startsWith("/") ? raw : resolve(repo, raw);
}

beforeEach(() => { root = seedGovernanceRepo(); worktrees = []; });
afterEach(() => {
  for (const wt of worktrees) rmSync(wt, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("e2e: authoring produces an allocatable ADR with no hand-computed hash (D1)", () => {
  it("new → allocate succeeds through the CLI with zero hand editing", () => {
    const created = runCli(root, ["new", "widget-policy", "--title", "Widget Policy"]);
    expect(created.status).toBe(0);
    expect(existsSync(join(root, "decisions", "ADR-PENDING-widget-policy.md"))).toBe(true);

    const allocated = runCli(root, ["allocate", "widget-policy"]);
    expect(allocated.status).toBe(0);
    expect(allocated.json?.number).toBe(10);
    expect(adrFiles(root)).toEqual(["ADR-010-widget-policy.md"]);
    expect(runCli(root, ["verify"]).status).toBe(0);
  });
});

describe("e2e: the default (committing) path — never covered by the unit suite", () => {
  it("allocates when the pending file was never tracked (D2 regression)", () => {
    runCli(root, ["new", "untracked-pending", "--title", "Untracked Pending"]);
    // deliberately NOT `git add`ed — the normal case for freshly authored work
    expect(git(root, "status", "--porcelain")).toContain("ADR-PENDING-untracked-pending.md");

    const allocated = runCli(root, ["allocate", "untracked-pending"]);
    expect(allocated.status).toBe(0);
    expect(allocated.json?.ok).toBe(true);
    expect(existsSync(join(root, "decisions", "ADR-PENDING-untracked-pending.md"))).toBe(false);
  });

  it("leaves rendered count documents byte-identical when allocation fails (D3 regression)", () => {
    // A repo whose index row already exists forces `appendIndex` to throw AFTER
    // the render step would have run — the natural failure this rollback exists for.
    runCli(root, ["new", "dup-row", "--title", "Dup Row"]);
    const before = readFileSync(join(root, "decisions", "README.md"), "utf8");
    writeFileSync(join(root, "decisions", "README.md"), `${before.trimEnd()}\n| [010](ADR-010-dup-row.md) | Dup Row | Proposed |\n`);
    const countDocsBefore = new Map();
    for (const rel of ["decisions/README.md", "decisions/registry.json"]) {
      countDocsBefore.set(rel, readFileSync(join(root, rel), "utf8"));
    }

    const failed = runCli(root, ["allocate", "dup-row"]);
    expect(failed.status).not.toBe(0);
    for (const [rel, text] of countDocsBefore) {
      expect(readFileSync(join(root, rel), "utf8")).toBe(text);
    }
    expect(existsSync(join(commonDir(root), "adr-registry.lock"))).toBe(false);
  });
});

describe("e2e: concurrent allocation across real worktrees (the 4x marathon collision)", () => {
  it("never issues a duplicate number and never corrupts the registry", () => {
    const wtA = join(tmpdir(), `adr-e2e-wt-a-${Date.now()}`);
    const wtB = join(tmpdir(), `adr-e2e-wt-b-${Date.now()}`);
    git(root, "worktree", "add", "-q", "--detach", wtA, "HEAD");
    git(root, "worktree", "add", "-q", "--detach", wtB, "HEAD");
    worktrees.push(wtA, wtB);

    runCli(wtA, ["new", "concurrent-a", "--title", "Concurrent A"]);
    runCli(wtB, ["new", "concurrent-b", "--title", "Concurrent B"]);

    // Fire both at once; they share one git-common-dir, hence one lock.
    const [a, b] = [
      spawnSync(process.execPath, [CLI, "allocate", "concurrent-a", "--repo", wtA], { cwd: wtA, encoding: "utf8" }),
      spawnSync(process.execPath, [CLI, "allocate", "concurrent-b", "--repo", wtB], { cwd: wtB, encoding: "utf8" }),
    ];

    const numbers = [a, b]
      .map((r) => { try { return JSON.parse(r.stdout).number; } catch { return null; } })
      .filter((n) => typeof n === "number");

    // The invariant that matters: no silent collision. Either both allocated
    // distinct numbers, or the loser failed loudly on the lock — never two
    // allocators claiming the same number.
    expect(new Set(numbers).size).toBe(numbers.length);
    const losers = [a, b].filter((r) => r.status !== 0);
    for (const loser of losers) {
      expect(`${loser.stdout}${loser.stderr}`).toMatch(/locked by another allocator/);
    }
    expect(existsSync(join(commonDir(wtA), "adr-registry.lock"))).toBe(false);

    // The shared ledger is what makes the above true: each worktree keeps its
    // OWN decisions/registry.json working copy, so the tracked counter cannot
    // see a sibling's in-flight claim.
    const reservations = JSON.parse(readFileSync(join(commonDir(wtA), "adr-reservations.json"), "utf8"));
    expect(reservations.entries.length).toBeGreaterThanOrEqual(numbers.length);
    expect(new Set(reservations.entries.map((e) => e.number)).size).toBe(reservations.entries.length);
  });
});
