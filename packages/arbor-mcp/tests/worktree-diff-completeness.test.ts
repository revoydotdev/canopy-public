/**
 * `captureWorktreeDiff` must capture everything a specialist changed in a
 * worktree relative to HEAD — staged, unstaged, AND untracked files — and it
 * must do so deterministically regardless of the repo's/user's git config,
 * regardless of leaked git-discovery env vars from the parent process, and
 * without ever mutating the worktree's real index.
 *
 * Plain `git diff` (the old implementation) only shows unstaged-vs-index
 * changes: a specialist that only *creates* files handed the critic an empty
 * patch. This file drives the real fix through real temporary git repos and
 * real git, per revoy2's "test through the real surface" convention.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { captureWorktreeDiff } from "../src/opencode-executor.js";

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
}

function commitAll(dir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", message], { cwd: dir });
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("captureWorktreeDiff — completeness (untracked + staged)", () => {
  it("includes an untracked new file, with correct additions", async () => {
    const dir = tempDir("arbor-diff-untracked-");
    initRepo(dir);
    writeFileSync(join(dir, "tracked.txt"), "x\n");
    commitAll(dir, "initial");

    writeFileSync(join(dir, "brand-new.txt"), "line one\nline two\n");

    const diff = await captureWorktreeDiff(dir, 10_000);

    expect(diff.ok).toBe(true);
    expect(diff.paths).toEqual(["brand-new.txt"]);
    expect(diff.text).toContain("brand-new.txt");
    expect(diff.text).toContain("+line one");
    expect(diff.text).toContain("+line two");
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
  });

  it("includes a staged-only change", async () => {
    const dir = tempDir("arbor-diff-staged-");
    initRepo(dir);
    writeFileSync(join(dir, "file.txt"), "before\n");
    commitAll(dir, "initial");

    writeFileSync(join(dir, "file.txt"), "after\n");
    execFileSync("git", ["add", "file.txt"], { cwd: dir });

    const diff = await captureWorktreeDiff(dir, 10_000);

    expect(diff.ok).toBe(true);
    expect(diff.paths).toEqual(["file.txt"]);
    expect(diff.text).toContain("-before");
    expect(diff.text).toContain("+after");
    expect(diff.additions).toBeGreaterThan(0);
    expect(diff.deletions).toBeGreaterThan(0);
  });

  it("round-trips a path containing a space exactly", async () => {
    const dir = tempDir("arbor-diff-space-");
    initRepo(dir);
    writeFileSync(join(dir, "tracked.txt"), "x\n");
    commitAll(dir, "initial");

    const fileName = "file with space.txt";
    writeFileSync(join(dir, fileName), "hello\n");

    const diff = await captureWorktreeDiff(dir, 10_000);

    expect(diff.ok).toBe(true);
    expect(diff.paths).toEqual([fileName]);
    expect(diff.text).toContain(fileName);
  });

  it("is unaffected by hostile repo config (noprefix, color, external diff, relative)", async () => {
    const dir = tempDir("arbor-diff-hostile-");
    initRepo(dir);
    writeFileSync(join(dir, "file.txt"), "before\n");
    commitAll(dir, "initial");
    writeFileSync(join(dir, "file.txt"), "after\n");
    writeFileSync(join(dir, "brand-new.txt"), "new content\n");

    const baseline = await captureWorktreeDiff(dir, 10_000);

    // The garbage external-diff script must live OUTSIDE the repo — inside it,
    // `git add -A` would pick it up as an untracked file and its own contents
    // (which happen to mention the sentinel string) would contaminate both
    // the file set and the comparison against `baseline`.
    const scriptHome = tempDir("arbor-diff-hostile-script-");
    const garbageScript = join(scriptHome, "garbage-external-diff.sh");
    writeFileSync(garbageScript, "#!/bin/sh\necho GARBAGE-DIFF-OUTPUT\nexit 0\n", { mode: 0o755 });
    execFileSync("git", ["config", "diff.noprefix", "true"], { cwd: dir });
    execFileSync("git", ["config", "color.ui", "always"], { cwd: dir });
    execFileSync("git", ["config", "color.diff", "always"], { cwd: dir });
    execFileSync("git", ["config", "diff.external", garbageScript], { cwd: dir });
    execFileSync("git", ["config", "diff.relative", "true"], { cwd: dir });

    const hostile = await captureWorktreeDiff(dir, 10_000);

    expect(hostile.ok).toBe(true);
    expect(hostile.text).not.toContain("GARBAGE-DIFF-OUTPUT");
    expect(hostile.text).not.toMatch(/\x1b\[/); // no ANSI color codes
    expect(hostile).toEqual(baseline);
  });

  it("reports the worktree's own changes even when GIT_DIR points at a different repo", async () => {
    const dir = tempDir("arbor-diff-owntree-");
    initRepo(dir);
    writeFileSync(join(dir, "file.txt"), "before\n");
    commitAll(dir, "initial");
    writeFileSync(join(dir, "file.txt"), "after\n");

    const otherRepo = tempDir("arbor-diff-otherrepo-");
    initRepo(otherRepo);
    writeFileSync(join(otherRepo, "unrelated.txt"), "unrelated\n");
    commitAll(otherRepo, "unrelated initial");

    const savedGitDir = process.env.GIT_DIR;
    const savedGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(otherRepo, ".git");
    process.env.GIT_WORK_TREE = otherRepo;
    try {
      const diff = await captureWorktreeDiff(dir, 10_000);
      expect(diff.ok).toBe(true);
      expect(diff.paths).toEqual(["file.txt"]);
      expect(diff.text).toContain("+after");
      expect(diff.text).not.toContain("unrelated");
    } finally {
      if (savedGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedGitDir;
      if (savedGitWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = savedGitWorkTree;
    }
  });

  it("leaves the worktree's real index and status untouched", async () => {
    const dir = tempDir("arbor-diff-noindexmutation-");
    initRepo(dir);
    writeFileSync(join(dir, "tracked.txt"), "before\n");
    commitAll(dir, "initial");

    writeFileSync(join(dir, "tracked.txt"), "after\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir }); // stage one change, leave the other untracked

    const cachedBefore = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" });
    const statusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });

    const diff = await captureWorktreeDiff(dir, 10_000);
    expect(diff.ok).toBe(true);

    const cachedAfter = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" });
    const statusAfter = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });

    expect(cachedAfter).toBe(cachedBefore);
    expect(statusAfter).toBe(statusBefore);
  });

  it("includes a binary file change", async () => {
    const dir = tempDir("arbor-diff-binary-");
    initRepo(dir);
    writeFileSync(join(dir, "tracked.txt"), "x\n");
    commitAll(dir, "initial");

    const pngLikeBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]);
    writeFileSync(join(dir, "image.png"), pngLikeBytes);

    const diff = await captureWorktreeDiff(dir, 10_000);

    expect(diff.ok).toBe(true);
    expect(diff.paths).toEqual(["image.png"]);
    expect(diff.text.toLowerCase()).toContain("git binary patch");
  });
});

describe("captureWorktreeDiff — truncation honesty", () => {
  // captureProcess caps every stdout capture at MAX_DELTA_BYTES (1 MiB,
  // src/opencode-executor.ts). A patch that exceeds it must stay ok:true
  // (it is still a real, usable-if-incomplete patch) but say so explicitly,
  // and — because it comes from an independently-bounded capture — its
  // numstat-derived paths/additions/deletions must remain complete.
  it("appends a truncation marker to a patch that exceeds the capture cap, while paths/additions/deletions stay complete", async () => {
    const dir = tempDir("arbor-diff-patchcap-");
    initRepo(dir);
    writeFileSync(join(dir, "tracked.txt"), "x\n");
    commitAll(dir, "initial");

    // One line of "x\n" is 2 bytes; comfortably clear the 1 MiB cap with a
    // single new file so the numstat for this diff stays tiny (well under
    // the cap) while the patch text itself does not.
    const oversizeContent = "x\n".repeat(700_000); // ~1.34 MiB
    writeFileSync(join(dir, "big.txt"), oversizeContent);

    const diff = await captureWorktreeDiff(dir, 20_000);

    expect(diff.ok).toBe(true);
    expect(diff.paths).toEqual(["big.txt"]);
    expect(diff.additions).toBe(700_000);
    expect(diff.deletions).toBe(0);
    expect(diff.text).toMatch(/\[patch truncated by harness at \d+ bytes\]\s*$/);
  });

  // Driving a >1 MiB *numstat* (as opposed to patch) through real git needs
  // enough distinct changed paths that their `numstat -z` records alone
  // exceed the cap — the per-file record is short (`<n>\t<n>\t<path>\0`), so
  // this uses several thousand files with padded-but-legal filenames rather
  // of relying on file content size, which does not appear in numstat's path
  // column. This is the only one of the two truncation cases that is cheap
  // enough to drive through the real filesystem+git rather than needing an
  // exported test seam into captureProcess.
  it("reports ok: false when numstat itself exceeds the capture cap, rather than a partial path list", async () => {
    const dir = tempDir("arbor-diff-numstatcap-");
    initRepo(dir);
    writeFileSync(join(dir, "tracked.txt"), "x\n");
    commitAll(dir, "initial");

    // Each record is `1\t0\t<200-char path>\0` ≈ 205 bytes. 6,000 files
    // ≈ 1.23 MiB of numstat output, safely over the 1 MiB (1,048,576 byte)
    // cap even accounting for git's own per-record overhead.
    const nameWidth = 195; // + "-NNNN.txt" suffix keeps each name <= 255 bytes (NAME_MAX)
    const fileCount = 6_000;
    for (let i = 0; i < fileCount; i++) {
      const name = `${"f".repeat(nameWidth)}-${i}.txt`;
      writeFileSync(join(dir, name), "x\n");
    }

    const diff = await captureWorktreeDiff(dir, 60_000);

    expect(diff.ok).toBe(false);
    expect(diff.paths).toEqual([]);
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
  }, 60_000);
});
