import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `dev:install` is the only supported way to get `arbor` on PATH, so its
 * refusal branch is load-bearing: it must not clobber a real foreign command.
 * It also must not demand a manual `rm` for a link this repository left behind
 * when the checkout moved -- that is the shape a first-time operator actually
 * hits, and the remedy text must name the real cause.
 */
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = join(REPO_ROOT, "scripts", "install-dev-cli.mjs");
const LAUNCHER = join(REPO_ROOT, "packages", "arbor-mcp", "bin", "arbor-mcp.mjs");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "arbor-dev-install-"));
  return { root, binDir: join(root, "bin"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function install(binDir, ...extra) {
  return execFileSync("bun", [SCRIPT, "--bin-dir", binDir, ...extra], { encoding: "utf8" });
}

describe("install-dev-cli", () => {
  it("installs both launchers into an empty bin directory", () => {
    const { binDir, cleanup } = sandbox();
    try {
      install(binDir);
      for (const name of ["arbor", "arbor-mcp"]) {
        expect(readlinkSync(join(binDir, name))).toBe(LAUNCHER);
      }
    } finally { cleanup(); }
  });

  it("is idempotent when the links already point at this checkout", () => {
    const { binDir, cleanup } = sandbox();
    try {
      install(binDir);
      expect(() => install(binDir)).not.toThrow();
    } finally { cleanup(); }
  });

  it("replaces a dangling dev link left by a moved checkout, and says why", () => {
    const { root, binDir, cleanup } = sandbox();
    try {
      mkdirSync(binDir, { recursive: true });
      // What a renamed checkout leaves behind: right launcher filename, a path
      // that no longer exists.
      symlinkSync(join(root, "gone", "arbor-mcp.mjs"), join(binDir, "arbor"));
      expect(existsSync(join(binDir, "arbor"))).toBe(false);

      const out = install(binDir);
      expect(out).toContain("replacing stale dev link");
      expect(out).toContain("target no longer exists");
      expect(readlinkSync(join(binDir, "arbor"))).toBe(LAUNCHER);
    } finally { cleanup(); }
  });

  it("still refuses a live foreign command", () => {
    const { root, binDir, cleanup } = sandbox();
    try {
      mkdirSync(binDir, { recursive: true });
      const foreign = join(root, "other-arbor");
      writeFileSync(foreign, "#!/bin/sh\nexit 0\n");
      symlinkSync(foreign, join(binDir, "arbor"));

      expect(() => install(binDir)).toThrow(/refusing to replace it/);
      expect(readlinkSync(join(binDir, "arbor"))).toBe(foreign);
    } finally { cleanup(); }
  });

  it("still refuses a dangling link to some OTHER program", () => {
    const { root, binDir, cleanup } = sandbox();
    try {
      mkdirSync(binDir, { recursive: true });
      // Absence of a target is not evidence of ownership.
      symlinkSync(join(root, "gone", "some-other-tool"), join(binDir, "arbor"));

      expect(() => install(binDir)).toThrow(/refusing to replace it/);
      expect(existsSync(join(binDir, "arbor"))).toBe(false);
      expect(readlinkSync(join(binDir, "arbor"))).toBe(join(root, "gone", "some-other-tool"));
    } finally { cleanup(); }
  });
});
