/**
 * scripts/tests/lockfile-check-root.test.mjs — the `--root` seam for
 * scripts/lockfile-check.mjs (Roadmap 23 B2, ADR-073 follow-up).
 *
 * This gate never hardcoded a `packages/` prefix in its comparison logic —
 * it already derives every workspace path from the root `package.json`'s
 * own `workspaces` array. What it DID hardcode was `REPO_ROOT` itself, via
 * `__dirname/..` with no override, so it could only ever check the checkout
 * it lives in. This test proves the fix the way Roadmap 23 §5 requires:
 * not merely that `--root` is accepted, but that the verdict is actually
 * derived from the named directory's own `package.json`/`bun.lock`.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRootArg } from "../lockfile-check.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "lockfile-check.mjs");

function runGate(args) {
  return spawnSync("node", [SCRIPT, "--json", ...args], { cwd: REPO_ROOT, encoding: "utf8" });
}

function parse(result) {
  return JSON.parse(result.stdout);
}

describe("resolveRootArg — argument parsing", () => {
  it("falls back to the supplied default when --root is absent", () => {
    expect(resolveRootArg(["--json"], "/tmp/fallback")).toBe(resolve("/tmp/fallback"));
  });

  it("accepts the --root=<path> form", () => {
    expect(resolveRootArg(["--root=/tmp/some-project"])).toBe(resolve("/tmp/some-project"));
  });

  it("throws when --root is given no value, rather than silently using this repo", () => {
    expect(() => resolveRootArg(["--root"])).toThrow(/--root requires a path/);
  });

  it("throws when --root is followed by another flag", () => {
    expect(() => resolveRootArg(["--root", "--json"])).toThrow(/--root requires a path/);
  });
});

describe("lockfile-check --root — the verdict comes from the named root", () => {
  it("an explicit --root at this repo produces the identical verdict to no flag (parity)", () => {
    const implicit = parse(runGate([]));
    const explicit = parse(runGate(["--root", REPO_ROOT]));
    expect(explicit.ok).toBe(implicit.ok);
    expect(explicit.targetsChecked).toBe(implicit.targetsChecked);
    expect(explicit.violations).toEqual(implicit.violations);
    // And it is really checking the real repo, not an accidental empty read.
    expect(implicit.ok).toBe(true);
    expect(implicit.targetsChecked).toBeGreaterThan(1);
  });

  it("retargeting: a fixture with a genuinely drifted workspace FAILS, derived from THAT fixture's files", () => {
    // A single-workspace fixture whose package.json declares a dependency
    // that bun.lock's corresponding workspace entry does not record — the
    // exact G-28 drift shape this gate exists to catch, reproduced in a
    // project revoy2 itself does not have drift in, so a script that
    // ignored --root and kept reading revoy2's own bun.lock would report
    // PASS here instead.
    const dir = mkdtempSync(join(tmpdir(), "lockfile-check-fixture-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "fixture-root", version: "1.0.0", workspaces: ["lib/widget"] }, null, 2),
      );
      mkdirSync(join(dir, "lib", "widget"), { recursive: true });
      writeFileSync(
        join(dir, "lib", "widget", "package.json"),
        JSON.stringify({ name: "widget", version: "1.0.0", dependencies: { leftpad: "^1.0.0" } }, null, 2),
      );
      // bun.lock's workspace entry for "lib/widget" omits the `dependencies`
      // field entirely — real drift.
      writeFileSync(
        join(dir, "bun.lock"),
        JSON.stringify({
          lockfileVersion: 1,
          workspaces: {
            "": { name: "fixture-root" },
            "lib/widget": { name: "widget", version: "1.0.0" },
          },
        }, null, 2),
      );

      const out = parse(runGate(["--root", dir]));
      expect(out.ok).toBe(false);
      expect(out.targetsChecked).toBe(2);
      expect(out.violations.some((v) => v.workspace === "lib/widget" && v.reason.includes("dependencies"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes two different roots in the same process invocation pattern", () => {
    const dir = mkdtempSync(join(tmpdir(), "lockfile-check-other-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "empty-fixture", version: "1.0.0" }, null, 2));
      writeFileSync(join(dir, "bun.lock"), JSON.stringify({ lockfileVersion: 1, workspaces: { "": { name: "empty-fixture" } } }, null, 2));

      const here = parse(runGate(["--root", REPO_ROOT]));
      const there = parse(runGate(["--root", dir]));
      expect(here.ok).toBe(true);
      expect(there.ok).toBe(true); // no workspaces declared, nothing to drift on
      expect(here.targetsChecked).not.toBe(there.targetsChecked);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a usage error and a non-zero exit for a valueless --root", () => {
    const result = spawnSync("node", [SCRIPT, "--root"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--root requires a path/);
  });
});
