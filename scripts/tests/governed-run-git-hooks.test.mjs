import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The commit-time git hooks act only inside a Canopy harness run
 * (ARBOR_GOVERNED_RUN=1). These run each hook from a bare temporary
 * repository that carries none of this repository's scripts: governed, the
 * hook reaches for them and fails; ungoverned, it must exit 0 before touching
 * anything. pre-push is covered the same way in pre-push-ref-binding.test.mjs.
 */
const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "hooks");
const temporary = [];
afterEach(() => { while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true }); });

function emptyRepository() {
  const repo = mkdtempSync(join(tmpdir(), "governed-run-hooks-"));
  temporary.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "MSG"), "feat: touch something\n");
  return repo;
}

function run(hook, repo, governed) {
  const env = { ...process.env, ARBOR_GOVERNED_RUN: governed ? "1" : "" };
  return spawnSync("/bin/sh", [join(HOOKS, hook), join(repo, "MSG")], { cwd: repo, env, encoding: "utf8" });
}

describe("git hooks outside a Canopy harness run", () => {
  it("commit-msg is inert without the marker and enforces with it", () => {
    const repo = emptyRepository();
    expect(run("commit-msg", repo, false)).toMatchObject({ status: 0, stderr: "" });
    expect(run("commit-msg", repo, true).status).not.toBe(0);
  });

  it("pre-commit is inert without the marker", () => {
    const repo = emptyRepository();
    expect(run("pre-commit", repo, false)).toMatchObject({ status: 0, stderr: "" });
  });
});
