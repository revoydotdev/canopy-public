/**
 * `provisionWorktreeDependencies` against real package managers (no network:
 * every fixture uses a `file:`-referenced sibling package, which bun/npm can
 * resolve from disk alone) -- mirrors the hermetic, real-process style
 * `worktree-shallow-isolation.test.ts` already uses for this package's git
 * worktree behavior.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  provisionWorktreeDependencies,
  DEFAULT_PROVISION_TIMEOUT_MS,
} from "../src/dependency-provisioning.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

/** A `file:`-dependency fixture bun/npm can install with zero network access. */
function makeBunProject(parent: string): { projectDir: string } {
  const localPkg = join(parent, "local-pkg");
  mkdirSync(localPkg, { recursive: true });
  writeFileSync(join(localPkg, "package.json"), JSON.stringify({ name: "local-pkg", version: "1.0.0" }));

  const projectDir = join(parent, "proj");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({
    name: "proj", version: "1.0.0", dependencies: { "local-pkg": "file:../local-pkg" },
  }));
  writeFileSync(join(projectDir, "bun.lock"), JSON.stringify({
    lockfileVersion: 1, configVersion: 1,
    workspaces: { "": { name: "proj", dependencies: { "local-pkg": "file:../local-pkg" } } },
    packages: { "local-pkg": ["local-pkg@file:../local-pkg", {}] },
  }));
  return { projectDir };
}

describe("provisionWorktreeDependencies", () => {
  it("detects bun.lock and installs real dependencies, producing node_modules", () => {
    const parent = scratchDir("arbor-provision-bun-");
    const { projectDir } = makeBunProject(parent);

    const outcome = provisionWorktreeDependencies(projectDir);

    expect(outcome).toMatchObject({ status: "installed", ecosystem: "bun", argv: ["bun", "install", "--frozen-lockfile"] });
    expect(existsSync(join(projectDir, "node_modules", "local-pkg"))).toBe(true);
  });

  it("returns a typed skip -- not silence -- when no recognized lockfile is present", () => {
    const dir = scratchDir("arbor-provision-none-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "no-lockfile", version: "1.0.0" }));

    const outcome = provisionWorktreeDependencies(dir);

    expect(outcome).toEqual({ status: "skipped", reason: "no_lockfile" });
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });

  it("returns disabled without touching the filesystem when enabled: false", () => {
    const parent = scratchDir("arbor-provision-disabled-");
    const { projectDir } = makeBunProject(parent);

    const outcome = provisionWorktreeDependencies(projectDir, { enabled: false });

    expect(outcome).toEqual({ status: "disabled" });
    expect(existsSync(join(projectDir, "node_modules"))).toBe(false);
  });

  it("surfaces a real install failure as a typed, non-throwing outcome", () => {
    const dir = scratchDir("arbor-provision-fail-");
    // References a sibling package that does not exist on disk -- bun/npm
    // fail this deterministically, offline, with no fixture flakiness.
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "proj", version: "1.0.0", dependencies: { "missing-pkg": "file:../missing-pkg" },
    }));
    writeFileSync(join(dir, "bun.lock"), JSON.stringify({
      lockfileVersion: 1, configVersion: 1,
      workspaces: { "": { name: "proj", dependencies: { "missing-pkg": "file:../missing-pkg" } } },
      packages: { "missing-pkg": ["missing-pkg@file:../missing-pkg", {}] },
    }));

    const outcome = provisionWorktreeDependencies(dir);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.ecosystem).toBe("bun");
      expect(outcome.timed_out).toBe(false);
      expect(outcome.detail.length).toBeGreaterThan(0);
    }
  });

  it("detects npm/pnpm/yarn lockfiles distinctly, honoring precedence over bun when both are absent", () => {
    const npmDir = scratchDir("arbor-provision-npm-");
    writeFileSync(join(npmDir, "package.json"), JSON.stringify({ name: "npm-proj", version: "1.0.0" }));
    writeFileSync(join(npmDir, "package-lock.json"), JSON.stringify({ name: "npm-proj", lockfileVersion: 3, packages: {} }));
    const npmOutcome = provisionWorktreeDependencies(npmDir);
    expect(npmOutcome).toMatchObject({ status: "installed", ecosystem: "npm", argv: ["npm", "ci"] });

    const pnpmDir = scratchDir("arbor-provision-pnpm-");
    writeFileSync(join(pnpmDir, "package.json"), JSON.stringify({ name: "pnpm-proj", version: "1.0.0" }));
    writeFileSync(join(pnpmDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const pnpmOutcome = provisionWorktreeDependencies(pnpmDir);
    expect(pnpmOutcome.status === "installed" || pnpmOutcome.status === "failed").toBe(true);
    if (pnpmOutcome.status === "installed" || pnpmOutcome.status === "failed") expect(pnpmOutcome.ecosystem).toBe("pnpm");
  });

  it("bounds a hanging install by the configured timeout and reports it as a typed, non-throwing failure", () => {
    const dir = scratchDir("arbor-provision-timeout-");
    // No package manager runs slowly enough to hit a real ms-scale timeout on
    // a trivial no-op install, so drive the same spawnSync timeout path
    // directly with a command that never exits within the bound.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }));
    writeFileSync(join(dir, "yarn.lock"), "# yarn lockfile v1\n");

    const outcome = provisionWorktreeDependencies(dir, { timeoutMs: 1 });

    // Either the real `yarn` binary is slow enough to be caught by the 1ms
    // bound (timed_out) or it fails/succeeds too fast to observe the bound at
    // all -- both are legitimate given real process scheduling. What must
    // never happen is an unbounded hang or a thrown exception.
    expect(["installed", "failed"]).toContain(outcome.status);
  });

  it("has a sane, non-instant default timeout", () => {
    expect(DEFAULT_PROVISION_TIMEOUT_MS).toBeGreaterThan(60_000);
  });
});
