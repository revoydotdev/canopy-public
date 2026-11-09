import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installHook } from "../install-git-hooks.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOOK = join(REPO, "scripts/hooks/pre-push");
const temporary = [];

function temp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd, message, contents) {
  writeFileSync(join(cwd, "state.txt"), contents);
  git(cwd, ["add", "state.txt"]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function makeRepository(remoteName = "origin") {
  const repo = temp("revoy2-pre-push-test-");
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Hook Test"]);
  git(repo, ["remote", "add", remoteName, "https://example.test/revoy2.git"]);
  git(repo, ["config", "branch.master.remote", remoteName]);
  git(repo, ["config", "branch.master.merge", "refs/heads/master"]);
  mkdirSync(join(repo, "packages/example"), { recursive: true });
  writeFileSync(join(repo, "packages/example/tsconfig.json"), "{}\n");
  git(repo, ["add", "packages/example/tsconfig.json"]);
  commit(repo, "base", "base\n");
  const candidate = commit(repo, "candidate", "candidate\n");
  git(repo, ["checkout", "-b", "diverged", "HEAD~1"]);
  const current = commit(repo, "current", "current\n");
  return { repo, candidate, current };
}

function fakeBun(repo, log) {
  const bin = join(repo, "bin");
  mkdirSync(bin);
  const bun = join(bin, "bun");
writeFileSync(bun, `#!/bin/sh
printf '%s %s\\n' "$PWD" "$(git -C "$PWD" rev-parse HEAD)" >> "$REVOY2_PRE_PUSH_LOG"
if [ "${'$'}1 ${'$'}2" = "run build" ]; then
  printf 'emitted\\n' > packages/example/dist/output.js
  printf 'incremental\\n' > packages/example/tsconfig.tsbuildinfo
fi
if [ "${'$'}1" = scripts/docs-truth.mjs ]; then printf '{}\\n'; fi
`);
  chmodSync(bun, 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, REVOY2_PRE_PUSH_LOG: log };
}

function runHook(repo, env, stdin, args = ["origin", "https://example.test/revoy2.git"]) {
  return spawnSync("/bin/sh", [HOOK, ...args], {
    cwd: repo,
    // The hook enforces only inside a Canopy harness run (GOVERNED_RUN_ENV).
    env: { ...process.env, ARBOR_GOVERNED_RUN: "1", ...env },
    input: stdin,
    encoding: "utf8",
  });
}

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

describe("pre-push ref binding", () => {
  it("runs snapshot preparation and the declarative battery against the single candidate SHA, not a diverged checkout", () => {
    const { repo, candidate, current } = makeRepository("canopy");
    const log = join(repo, "bun-pwd.log");
    const result = runHook(
      repo,
      fakeBun(repo, log),
      `refs/heads/master ${candidate} refs/heads/master ${"0".repeat(40)}\n`,
      ["canopy", "https://example.test/revoy2.git"],
    );

    expect(result.status, result.stderr).toBe(0);
    const snapshots = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" "));
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    expect(new Set(snapshots.map(([path]) => path)).size).toBe(1);
    expect(new Set(snapshots.map(([, sha]) => sha))).toEqual(new Set([candidate]));
    expect(snapshots[0][0]).not.toBe(repo);
    expect(result.stdout).toContain("declarative revision-bound prepush profile");
    expect(current).not.toBe(candidate);
  });

  it("serializes on one lock in the common git dir when run from a linked worktree", () => {
    const { repo, candidate } = makeRepository("canopy");
    const linked = join(temp("revoy2-pre-push-linked-"), "wt");
    git(repo, ["worktree", "add", "--detach", linked, candidate]);
    // A linked worktree's .git is a file, not a directory.
    expect(statSync(join(linked, ".git")).isFile()).toBe(true);
    const log = join(repo, "bun-linked.log");
    const result = runHook(
      linked,
      fakeBun(repo, log),
      `refs/heads/master ${candidate} refs/heads/master ${"0".repeat(40)}\n`,
      ["canopy", "https://example.test/revoy2.git"],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(realpathSync(repo), ".git", "revoy2-prepush.lock"))).toBe(true);
  });

  it("accepts trunk-submit exact HEAD form only when it is the attached governed branch commit", () => {
    const { repo, candidate } = makeRepository("canopy");
    git(repo, ["checkout", "master"]);
    const log = join(repo, "bun-head.log");
    const result = runHook(
      repo,
      fakeBun(repo, log),
      `HEAD ${candidate} refs/heads/master ${"0".repeat(40)}\n`,
      ["canopy", "https://example.test/revoy2.git"],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(new Set(readFileSync(log, "utf8").match(/[0-9a-f]{40}/g))).toEqual(new Set([candidate]));
  });

  it("fails closed for two divergent ref updates", () => {
    const { repo, candidate, current } = makeRepository();
    const result = runHook(
      repo,
      {},
      `refs/heads/master ${candidate} refs/heads/master ${"0".repeat(40)}\nrefs/heads/diverged ${current} refs/heads/diverged ${"0".repeat(40)}\n`,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("multi-ref push");
  });

  it("is inert outside a Canopy harness run: no marker, no refusal, no battery", () => {
    const { repo, candidate, current } = makeRepository();
    const log = join(repo, "bun-ungoverned.log");
    const result = runHook(
      repo,
      { ...fakeBun(repo, log), ARBOR_GOVERNED_RUN: "" },
      `refs/heads/master ${candidate} refs/heads/master ${"0".repeat(40)}\nrefs/heads/diverged ${current} refs/heads/diverged ${"0".repeat(40)}\n`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(log)).toBe(false);
  });

  it("installs a stable launcher that invokes a newer checked-in hook source", () => {
    const repo = temp("revoy2-hook-launcher-test-");
    git(repo, ["init", "-b", "master"]);
    mkdirSync(join(repo, "scripts", "hooks"), { recursive: true });
    const source = join(repo, "scripts/hooks", "pre-push");
    writeFileSync(source, "#!/bin/sh\n# revoy2-pre-push-hook-marker\nprintf 'old\\n'\n");
    const hooks = join(repo, ".hooks");
    mkdirSync(hooks);
    const hook = { name: "pre-push", marker: "revoy2-pre-push-hook-marker" };

    expect(installHook(hooks, hook, repo)).toBe(true);
    writeFileSync(source, "#!/bin/sh\nprintf 'fresh\\n'\n");
    const launched = spawnSync(join(hooks, "pre-push"), [], { cwd: repo, encoding: "utf8" });

    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stdout).toBe("fresh\n");
  });

  it("refuses to overwrite a foreign hook", () => {
    const repo = temp("revoy2-hook-foreign-test-");
    mkdirSync(join(repo, "scripts", "hooks"), { recursive: true });
    writeFileSync(join(repo, "scripts", "hooks", "pre-push"), "#!/bin/sh\n# revoy2-pre-push-hook-marker\n");
    const hooks = join(repo, ".hooks");
    mkdirSync(hooks);
    const target = join(hooks, "pre-push");
    writeFileSync(target, "#!/bin/sh\nprintf foreign\\n\n");

    expect(installHook(hooks, { name: "pre-push", marker: "revoy2-pre-push-hook-marker" }, repo)).toBe(false);
    expect(readFileSync(target, "utf8")).toContain("foreign");
  });
});
