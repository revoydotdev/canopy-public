/**
 * ADR-103's `defaultGitStatusRunner` spawns real `git`. Every other test in
 * this package injects a fake runner — correctly, so assertions stay
 * deterministic under concurrent agents — which left the actual spawn, its
 * timeout, and its non-zero-exit handling unexercised.
 *
 * These drive the real spawn, but never against this repository: ADR-078
 * forbids a test whose verdict ranges over live repo state, and git status
 * here moves under a sibling agent mid-run. Each case builds its own throwaway
 * git repo in a scratch dir, so the observed status is one this test created.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEnvironmentSnapshot } from "../src/environment-context.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scratchRepo(init: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-env-git-"));
  dirs.push(root);
  if (init) {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    run("init", "--initial-branch=trunk");
    run("config", "user.email", "test@example.invalid");
    run("config", "user.name", "test");
    writeFileSync(join(root, "seed.txt"), "seed\n", "utf8");
    run("add", "seed.txt");
    run("commit", "-m", "seed");
  }
  return root;
}

describe("resolveEnvironmentSnapshot against real git", () => {
  it("reads a real branch and clean state from a repository it created itself", () => {
    const snapshot = resolveEnvironmentSnapshot(scratchRepo(true));
    expect(snapshot.git).not.toBeNull();
    expect(snapshot.git!.branch).toBe("trunk");
    expect(snapshot.git!.dirty).toBe(false);
    expect(snapshot.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("observes a real uncommitted change as dirty", () => {
    const root = scratchRepo(true);
    writeFileSync(join(root, "seed.txt"), "changed\n", "utf8");
    expect(resolveEnvironmentSnapshot(root).git!.dirty).toBe(true);
  });

  it("renders git as explicitly absent outside a repository, rather than throwing or reusing a snapshot", () => {
    const snapshot = resolveEnvironmentSnapshot(scratchRepo(false));
    expect(snapshot.git).toBeNull();
    // The rest of the environment is still observed — a failed git read must
    // not take the whole block down with it.
    expect(snapshot.cwd).toBeTruthy();
    expect(snapshot.platform).toBeTruthy();
    expect(snapshot.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns absent git for a path that does not exist at all", () => {
    const snapshot = resolveEnvironmentSnapshot(join(tmpdir(), "arbor-env-git-does-not-exist-cafe"));
    expect(snapshot.git).toBeNull();
  });
});

describe("git status rendering edges", () => {
  it("renders a detached head, an upstream-less branch, and ahead/behind from real repositories", async () => {
    const { formatEnvironmentSnapshot, resolveEnvironmentSnapshot: resolve } =
      await import("../src/environment-context.js");

    // A fresh repo has a branch but no upstream: ahead_behind must render as
    // explicitly absent rather than as zero/zero, which would claim a
    // comparison that was never made.
    const fresh = resolve(scratchRepo(true));
    expect(fresh.git!.ahead_behind).toBeNull();
    expect(formatEnvironmentSnapshot(fresh)).toContain("(no upstream)");

    // A failed read renders the unavailable line, not a fabricated clean state.
    const notARepo = resolve(scratchRepo(false));
    expect(formatEnvironmentSnapshot(notARepo)).toContain("git: (unavailable");
  });

  it("reports a detached HEAD without inventing a branch name", () => {
    const root = scratchRepo(true);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "--detach", head], { cwd: root, stdio: "pipe" });
    const snapshot = resolveEnvironmentSnapshot(root);
    expect(snapshot.git).not.toBeNull();
    expect(snapshot.git!.branch).toBeNull();
  });
});
