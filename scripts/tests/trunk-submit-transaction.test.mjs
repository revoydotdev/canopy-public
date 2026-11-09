import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGED_HOOKS, managedLauncherSource } from "../install-git-hooks.mjs";
import { runTrunkSubmit } from "../trunk-submit.mjs";

const temporary = [];

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(repo, path, text) {
  const absolute = join(repo, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text, "utf8");
}

function commit(repo, message, path, text) {
  write(repo, path, text);
  git(repo, "add", path);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function installTrivialManagedHooks(repo) {
  for (const hook of MANAGED_HOOKS) {
    write(repo, `scripts/hooks/${hook.name}`, `#!/bin/sh\n# ${hook.marker}\nexit 0\n`);
    write(repo, `.git/hooks/${hook.name}`, managedLauncherSource(hook));
    chmodSync(join(repo, ".git", "hooks", hook.name), 0o755);
  }
}

function createSubmitFixture() {
  const parent = mkdtempSync(join(tmpdir(), "trunk-submit-transaction-"));
  temporary.push(parent);
  const remote = join(parent, "origin.git");
  const repo = join(parent, "repo");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  git(repo, "config", "user.name", "Trunk Submit Test");
  git(repo, "config", "user.email", "trunk-submit@test.invalid");
  git(repo, "config", "core.hooksPath", ".git/hooks");
  installTrivialManagedHooks(repo);
  write(repo, "package.json", "{\"scripts\":{}}\n");
  write(repo, "scripts/execution-profile.json", "{\"schema_version\":1,\"profile_version\":\"fixture-v1\",\"gates\":{}}\n");
  write(repo, "seed.txt", "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  const declared = git(repo, "rev-parse", "HEAD");
  write(repo, ".arbor/integration.jsonc", `{"trunk_ref":"master","trunk_head_at_declaration":"${declared}"}\n`);
  git(repo, "add", ".arbor/integration.jsonc");
  git(repo, "commit", "-q", "-m", "declare integration base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "master");
  return { parent, remote, repo };
}

function partialJournalId(repo) {
  const directory = join(repo, ".git", "arbor", "trunk-submit");
  return readdirSync(directory).find((name) => name.endsWith(".json"))?.slice(0, -5) ?? null;
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("trunk-submit transaction boundaries", () => {
  it("refuses to resume when an intervening commit changed the recorded checkpoint", () => {
    const { repo } = createSubmitFixture();
    expect(() => runTrunkSubmit(["--message", "force snapshot setup failure"], repo)).toThrow();
    const id = partialJournalId(repo);
    expect(id).not.toBeNull();

    commit(repo, "intervening", "intervening.txt", "not part of the original transaction\n");
    expect(() => runTrunkSubmit(["--resume", id], repo)).toThrow(/HEAD changed since its committed checkpoint/);
  });

  it("uses the fetched remote integration trunk rather than a stale local trunk ref", () => {
    const { parent, remote, repo } = createSubmitFixture();
    git(repo, "checkout", "-q", "-b", "feature/stale");
    git(repo, "push", "-q", "-u", "origin", "feature/stale");

    const other = join(parent, "other");
    execFileSync("git", ["clone", "-q", remote, other]);
    git(other, "config", "user.name", "Remote Advancer");
    git(other, "config", "user.email", "remote-advancer@test.invalid");
    commit(other, "advance remote trunk", "remote-only.txt", "remote advance\n");
    git(other, "push", "-q", "origin", "master");

    expect(() => runTrunkSubmit(["--message", "must reject stale trunk"], repo)).toThrow(/candidate .* is not based on live trunk master/);
  });

  it("removes a snapshot worktree when snapshot setup fails", () => {
    const { repo } = createSubmitFixture();
    expect(() => runTrunkSubmit(["--message", "force snapshot setup failure"], repo)).toThrow();
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("revoy2-trunk-submit-");
  });
});
