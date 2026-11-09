import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkTrunkPreflight } from "../trunk-preflight.mjs";

let repo;
function git(...args) { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function write(path, text) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); }
function commit(message, path, text) { write(path, text); git("add", path); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); }
function contract(trunk, revision) { write(".arbor/integration.jsonc", `{\n // checked declaration\n "trunk_ref":"${trunk}",\n "trunk_head_at_declaration":"${revision}",\n "declared_at":"2026-08-12T00:00:00Z"\n}\n`); }
function handoff(branch, dependencies = "[]") { write("docs/roadmaps/handoffs/fixture.md", `# Handoff\n\nBranch: \`${branch}\`\n\ndepends_on: ${dependencies}\n`); }

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "trunk-preflight-"));
  git("init", "-q", "-b", "master");
  git("config", "user.name", "Preflight Test");
  git("config", "user.email", "preflight@test.invalid");
  commit("base", "base.txt", "base\n");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("trunk preflight", () => {
  it("refuses a fork from stale master with the named rebase remediation", () => {
    const base = git("rev-parse", "master");
    git("checkout", "-q", "-b", "feature/real-trunk");
    commit("advance trunk", "trunk.txt", "live\n");
    git("checkout", "-q", "master");
    contract("feature/real-trunk", base);
    const result = checkTrunkPreflight({ repo, candidate: "master" });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("rebase onto feature/real-trunk before continuing");
  });

  it("refuses a declaration revision outside live trunk history", () => {
    const base = git("rev-parse", "master");
    git("checkout", "-q", "-b", "side");
    const side = commit("side", "side.txt", "side\n");
    git("checkout", "-q", "master");
    contract("master", side);
    const result = checkTrunkPreflight({ repo, candidate: base });
    expect(result.failures.join("\n")).toContain("trunk_head_at_declaration is not an ancestor");
  });

  it("flags an undeclared stacked branch before rebase", () => {
    const base = git("rev-parse", "master");
    contract("master", base);
    git("checkout", "-q", "-b", "feature/a");
    commit("a", "a.txt", "a\n");
    git("checkout", "-q", "-b", "feature/b");
    commit("b", "b.txt", "b\n");
    git("checkout", "-q", "master");
    handoff("feature/b");
    const result = checkTrunkPreflight({ repo, candidate: "feature/b", handoffBranch: "feature/b" });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("from feature/a but does not declare it");

    handoff("feature/b", "[feature/a]");
    expect(checkTrunkPreflight({ repo, candidate: "feature/b", handoffBranch: "feature/b" }).ok).toBe(true);
  });

  it("requires an explicit depends_on field", () => {
    const base = git("rev-parse", "master");
    contract("master", base);
    write("docs/roadmaps/handoffs/fixture.md", "# Handoff\n\nBranch: `master`\n");
    expect(checkTrunkPreflight({ repo, candidate: "master", handoffBranch: "master" }).failures.join("\n")).toContain("must declare depends_on");
  });
});
