import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "branch-accounting.mjs");

/**
 * Every case runs against a throwaway repository. Proving this gate FAILS
 * requires a branch holding a genuinely unaccounted commit, and creating one in
 * the real repository would add to the exact debris the gate exists to find —
 * in a checkout where a scope guard would then refuse to let it be deleted.
 */
let repo;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(message, file = "f.txt", body = message) {
  writeFileSync(join(repo, file), `${body}\n`, "utf8");
  git("add", file);
  git("commit", "-q", "-m", message);
}

/**
 * A commit whose tip is old enough to fall outside the 48h grace window (see
 * YOUNG_BRANCH_GRACE_MS in branch-accounting.mjs) — this is what an
 * ABANDONED branch looks like, as opposed to one still in active use. Every
 * pre-existing "this branch is a blocker" fixture in this file needs one of
 * these now that a freshly-made commit is presumed in-progress, not
 * abandoned.
 */
function oldCommit(message, file = "f.txt", body = message) {
  const old = "2000-01-01T00:00:00Z";
  writeFileSync(join(repo, file), `${body}\n`, "utf8");
  git("add", file);
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
  });
}

function runGate(dispositions) {
  const path = join(repo, "dispositions.json");
  writeFileSync(path, JSON.stringify(dispositions ?? { entries: [] }), "utf8");
  const result = spawnSync("node", [GATE, "--repo", repo, "--dispositions", path, "--json"], { encoding: "utf-8" });
  return { code: result.status, report: JSON.parse(result.stdout) };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "branch-accounting-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  commit("base");
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe("branch-accounting gate", () => {
  it("passes when every branch is contained in master", () => {
    git("branch", "pointer-only");
    const { code, report } = runGate();
    expect(code).toBe(0);
    expect(report.unaccounted).toEqual([]);
    expect(report.contained_branch_count).toBe(1);
  });

  it("FAILS on a branch holding a commit that exists nowhere else", () => {
    // The whole point: this commit has exactly one home. Backdated past the
    // 48h grace window so this reads as ABANDONED, not in-progress.
    git("checkout", "-q", "-b", "orphan-work");
    oldCommit("only copy of this work", "orphan.txt");
    git("checkout", "-q", "master");

    const { code, report } = runGate();
    expect(code).toBe(1);
    expect(report.blockers).toBe(1);
    expect(report.unaccounted).toHaveLength(1);
    expect(report.unaccounted[0].branch).toBe("orphan-work");
    expect(report.unaccounted[0].unique_commits).toBe(1);
    expect(report.unaccounted[0].subject).toBe("only copy of this work");
  });

  it("a dispositioned branch becomes an accounted ref for every other branch", () => {
    // This is what collapsed 307 unaccounted branches to 0 in the real repo:
    // the pointer branches hold nothing the feature branch does not.
    git("checkout", "-q", "-b", "feature");
    oldCommit("feature work", "feat.txt");
    git("branch", "pointer-a");
    git("branch", "pointer-b");
    git("checkout", "-q", "master");

    const undispositioned = runGate();
    expect(undispositioned.code).toBe(1);
    expect(undispositioned.report.unaccounted).toHaveLength(3);

    const dispositioned = runGate({
      entries: [{ branch: "feature", disposition: "in_review", reason: "under review", expires: "2999-01-01" }],
    });
    expect(dispositioned.code).toBe(0);
    expect(dispositioned.report.contained_branch_count).toBe(2);
  });

  it("an expired disposition is itself a blocker, and stops accounting for the branch", () => {
    git("checkout", "-q", "-b", "feature");
    oldCommit("feature work", "feat.txt");
    git("checkout", "-q", "master");

    const { code, report } = runGate({
      entries: [{ branch: "feature", disposition: "in_review", reason: "stale", expires: "2000-01-01" }],
    });
    expect(code).toBe(1);
    expect(report.expired_dispositions).toHaveLength(1);
    // Expiry must also REVOKE the accounting, not merely warn — otherwise an
    // expired entry keeps silently excusing the branch it no longer covers.
    expect(report.unaccounted.map((item) => item.branch)).toContain("feature");
  });

  it("an incomplete disposition is a blocker — no reason or expiry means no decision", () => {
    const { code, report } = runGate({ entries: [{ branch: "feature" }] });
    expect(code).toBe(1);
    expect(report.expired_dispositions[0].why).toMatch(/incomplete/);
  });

  it("an unparseable disposition file fails closed, never open", () => {
    // The permissive reading of a corrupt file is "nothing is dispositioned",
    // which would flag everything; the DANGEROUS reading is treating the
    // failure as "everything is fine". This asserts it is a blocker.
    git("checkout", "-q", "-b", "feature");
    commit("feature work", "feat.txt");
    git("checkout", "-q", "master");

    const path = join(repo, "broken.json");
    writeFileSync(path, "{ not json", "utf8");
    const result = spawnSync("node", [GATE, "--repo", repo, "--dispositions", path, "--json"], { encoding: "utf-8" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).disposition_error).toMatch(/unparseable/);
  });

  it("counts a branch once, not once per commit it uniquely holds", () => {
    git("checkout", "-q", "-b", "orphan-work");
    oldCommit("first", "a.txt");
    oldCommit("second", "b.txt");
    oldCommit("third", "c.txt");
    git("checkout", "-q", "master");

    const { report } = runGate();
    expect(report.unaccounted).toHaveLength(1);
    expect(report.unaccounted[0].unique_commits).toBe(3);
    expect(report.blockers).toBe(1);
  });
});

describe("branch-accounting gate — in-progress grace", () => {
  it("lists a branch with a fresh (under 48h) tip as in-progress, not a blocker", () => {
    // The exact trip: an agent mid-task cuts a branch and commits to it —
    // that is correct behaviour, not abandonment, and must not go red.
    git("checkout", "-q", "-b", "wip-branch");
    commit("work in progress", "wip.txt");
    git("checkout", "-q", "master");

    const { code, report } = runGate();
    expect(code).toBe(0);
    expect(report.blockers).toBe(0);
    expect(report.unaccounted).toEqual([]);
    expect(report.in_progress).toHaveLength(1);
    expect(report.in_progress[0].branch).toBe("wip-branch");
    expect(report.in_progress[0].reason).toMatch(/48h/);
  });

  it("lists a branch checked out in a worktree as in-progress regardless of age", () => {
    git("checkout", "-q", "-b", "worktree-branch");
    oldCommit("old but still checked out", "wt.txt");
    git("checkout", "-q", "master");
    const worktreeDir = join(repo, "..", `${join(repo).split("/").pop()}-wt`);
    git("worktree", "add", "-q", worktreeDir, "worktree-branch");
    try {
      const { code, report } = runGate();
      expect(code).toBe(0);
      expect(report.blockers).toBe(0);
      expect(report.unaccounted).toEqual([]);
      expect(report.in_progress).toHaveLength(1);
      expect(report.in_progress[0].branch).toBe("worktree-branch");
      expect(report.in_progress[0].reason).toMatch(/worktree/);
    } finally {
      git("worktree", "remove", "--force", worktreeDir);
    }
  });

  it("still FAILS an old, non-worktree branch — grace never excuses a genuinely abandoned branch", () => {
    git("checkout", "-q", "-b", "abandoned");
    oldCommit("stale work", "stale.txt");
    git("checkout", "-q", "master");

    const { code, report } = runGate();
    expect(code).toBe(1);
    expect(report.blockers).toBe(1);
    expect(report.unaccounted).toHaveLength(1);
    expect(report.unaccounted[0].branch).toBe("abandoned");
    expect(report.in_progress).toEqual([]);
  });
});
