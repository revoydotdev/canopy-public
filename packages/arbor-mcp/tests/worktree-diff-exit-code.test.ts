/**
 * `captureWorktreeDiff` must distinguish "no changes" from "could not tell".
 *
 * Found by the G-09 coverage lane while testing an adjacent branch, and
 * deliberately left unfixed by it because the file was another lane's. The
 * `close` handler ignored `git diff`'s exit code, so running against a
 * directory that is not a git work tree — where git exits 128 with an empty
 * stdout — produced `{ok: true, text: "", paths: []}`. A caller cannot tell
 * that apart from a genuine empty diff, and the one real caller
 * (`opencode-executor.ts`'s success path, `hasWorktree && diff.ok`) would have
 * pushed a `loop.diff` devtools line asserting "no changes" on evidence it
 * never actually obtained.
 *
 * That is the absence-as-default shape ROADMAP's governing principle names:
 * a missing measurement is a typed failure, never a zero.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { captureWorktreeChanges, captureWorktreeDiff } from "../src/opencode-executor.js";

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("captureWorktreeChanges — bounded retry metadata", () => {
  it("classifies tracked, untracked, deleted, and renamed paths without retaining raw content", async () => {
    const dir = tempDir("arbor-change-metadata-");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
    writeFileSync(join(dir, "modified.txt"), "before\n");
    writeFileSync(join(dir, "deleted.txt"), "delete me\n");
    writeFileSync(join(dir, "rename-me.txt"), "rename me\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir });
    writeFileSync(join(dir, "modified.txt"), "secret changed content\n");
    writeFileSync(join(dir, "untracked.txt"), "secret untracked content\n");
    execFileSync("git", ["rm", "-q", "deleted.txt"], { cwd: dir });
    execFileSync("git", ["mv", "rename-me.txt", "renamed.txt"], { cwd: dir });

    const measurement = await captureWorktreeChanges(dir, 10_000);
    expect(measurement.ok).toBe(true);
    const changes = measurement.files;

    expect(changes.map(({ path, changeKind }) => [path, changeKind])).toEqual([
      ["deleted.txt", "deleted"],
      ["modified.txt", "modified"],
      ["renamed.txt", "renamed"],
      ["untracked.txt", "added"],
    ]);
    for (const change of changes) {
      expect(change.deltaDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(change.summary).toBe(`${change.changeKind} ${change.path}`);
      expect(JSON.stringify(change)).not.toContain("secret");
    }
  });

  it("returns no asserted changes when status cannot be measured", async () => {
    const dir = tempDir("arbor-change-not-repo-");
    expect(await captureWorktreeChanges(dir, 10_000)).toEqual({ ok: false, files: [] });
  });
});

describe("captureWorktreeDiff — a failed measurement is not an empty diff", () => {
  it("reports ok: false for a directory that is not a git work tree", async () => {
    const dir = tempDir("arbor-not-a-repo-");
    writeFileSync(join(dir, "file.txt"), "content\n");

    const diff = await captureWorktreeDiff(dir, 10_000);

    // The whole point: this used to be `ok: true` with an empty text, which
    // is indistinguishable from the genuine-empty case asserted below.
    expect(diff.ok).toBe(false);
  });

  it("reports ok: true with a genuinely empty diff for a clean repo", async () => {
    const dir = tempDir("arbor-clean-repo-");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
    writeFileSync(join(dir, "file.txt"), "content\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir });

    const diff = await captureWorktreeDiff(dir, 10_000);

    expect(diff.ok).toBe(true);
    expect(diff.text).toBe("");
    expect(diff.paths).toEqual([]);
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
  });

  it("reports a real diff for a repo with an uncommitted change", async () => {
    const dir = tempDir("arbor-dirty-repo-");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
    writeFileSync(join(dir, "file.txt"), "before\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir });
    writeFileSync(join(dir, "file.txt"), "after\n");

    const diff = await captureWorktreeDiff(dir, 10_000);

    expect(diff.ok).toBe(true);
    expect(diff.paths).toEqual(["file.txt"]);
    expect(diff.additions).toBeGreaterThan(0);
    expect(diff.deletions).toBeGreaterThan(0);
  });

  it("reports ok: false for a directory that does not exist at all", async () => {
    const dir = join(tempDir("arbor-missing-parent-"), "definitely-absent");
    // Deliberately not created — git cannot even chdir into it.
    const diff = await captureWorktreeDiff(dir, 10_000);
    expect(diff.ok).toBe(false);
  });

  it("distinguishes the two cases the old behaviour collapsed", async () => {
    const clean = tempDir("arbor-cmp-clean-");
    execFileSync("git", ["init", "-q"], { cwd: clean });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: clean });
    execFileSync("git", ["config", "user.name", "test"], { cwd: clean });
    writeFileSync(join(clean, "f.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: clean });
    execFileSync("git", ["commit", "-qm", "i"], { cwd: clean });

    const notRepo = tempDir("arbor-cmp-notrepo-");
    mkdirSync(join(notRepo, "sub"));

    const cleanDiff = await captureWorktreeDiff(clean, 10_000);
    const notRepoDiff = await captureWorktreeDiff(notRepo, 10_000);

    // Both produce empty text; only `ok` separates them. Before the fix both
    // reported ok: true and the caller had no way to tell them apart.
    expect(cleanDiff.text).toBe(notRepoDiff.text);
    expect(cleanDiff.ok).not.toBe(notRepoDiff.ok);
  });
});
