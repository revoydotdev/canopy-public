/**
 * integration-check.test.ts — each rung of `checkIntegration` proven
 * positively against a real git repository (never a mock), plus the
 * documented fallbacks (plain unmerged -> not_integrated, bogus ref ->
 * unknown).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkIntegration } from "@arbor/campaign-support";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, args: string[]): string {
  const res = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arbor-integration-check-"));
  scratch.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["commit", "--allow-empty", "-qm", "root"]);
  return dir;
}

function commitFile(dir: string, name: string, content: string, message: string): string {
  writeFileSync(join(dir, name), content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

describe("checkIntegration", () => {
  it("same_commit: B and T are the same commit", () => {
    const dir = repo();
    const sha = git(dir, ["rev-parse", "HEAD"]);
    const result = checkIntegration({ cwd: dir, branch: sha, target: sha });
    expect(result).toEqual({ status: "integrated", rung: "same_commit", detail: expect.any(String) });
  });

  it("ancestor: B is a fast-forward ancestor of T", () => {
    const dir = repo();
    const base = git(dir, ["rev-parse", "HEAD"]);
    commitFile(dir, "a.txt", "a\n", "add a");
    const tip = git(dir, ["rev-parse", "HEAD"]);
    const result = checkIntegration({ cwd: dir, branch: base, target: tip });
    expect(result.status).toBe("integrated");
    expect((result as { rung: string }).rung).toBe("ancestor");
  });

  it("no_added_changes: B's content beyond the merge-base is identical to T's (a plain reset/rebase artifact)", () => {
    const dir = repo();
    commitFile(dir, "a.txt", "a\n", "add a");
    // T advances past base.
    const t = commitFile(dir, "b.txt", "b\n", "add b");
    // B is a NEW commit whose net content change over the merge-base (base)
    // is empty — e.g. a file added then reverted — so `T...B` is empty even
    // though B is not literally base and not an ancestor of T.
    writeFileSync(join(dir, "c.txt"), "c\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "add c"]);
    git(dir, ["rm", "-q", "c.txt"]);
    git(dir, ["commit", "-qm", "remove c"]);
    const b = git(dir, ["rev-parse", "HEAD"]);
    const result = checkIntegration({ cwd: dir, branch: b, target: t });
    expect(result.status).toBe("integrated");
    expect(["no_added_changes", "trees_match"]).toContain((result as { rung: string }).rung);
  });

  it("squash-merge where T later advanced on OTHER files -> merge_adds_nothing", () => {
    const dir = repo();
    // B branches off HEAD and adds feature.txt.
    git(dir, ["checkout", "-qb", "feature"]);
    commitFile(dir, "feature.txt", "feature\n", "add feature");
    const b = git(dir, ["rev-parse", "HEAD"]);

    // T (main) squash-merges B's content, then advances on an unrelated file.
    git(dir, ["checkout", "-q", "-"]);
    git(dir, ["merge", "--squash", "feature", "-q"]);
    git(dir, ["commit", "-qm", "squash-merge feature"]);
    commitFile(dir, "unrelated.txt", "unrelated\n", "unrelated change");
    const t = git(dir, ["rev-parse", "HEAD"]);

    const result = checkIntegration({ cwd: dir, branch: b, target: t });
    expect(result.status).toBe("integrated");
    expect((result as { rung: string }).rung).toBe("merge_adds_nothing");
  });

  it("squash-merge where T later modified the SAME lines -> patch_id_match", () => {
    const dir = repo();
    const base = git(dir, ["rev-parse", "HEAD"]);

    // B: a single commit that adds feature.txt.
    git(dir, ["checkout", "-qb", "feature"]);
    const b = commitFile(dir, "feature.txt", "feature content\n", "add feature");

    // T reapplies the IDENTICAL diff as its own commit (same patch-id as B),
    // as a squash-merge would, then modifies the SAME file further. Because
    // T's tip content for feature.txt now differs from B's, a three-way
    // merge of T and B conflicts on that file (both independently "added"
    // it, from T and B's shared root, with different final content) —
    // ruling out `merge_adds_nothing` — leaving `patch_id_match` as the only
    // rung that can still prove B's original diff is already on T.
    git(dir, ["checkout", "-q", "-"]);
    const diff = spawnSync("git", ["-C", dir, "diff", base, b], { encoding: "utf-8" }).stdout;
    const apply = spawnSync("git", ["apply"], { cwd: dir, input: diff, encoding: "utf-8" });
    expect(apply.status).toBe(0);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "reapply feature diff"]);
    writeFileSync(join(dir, "feature.txt"), "feature content, modified later\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "modify feature.txt further"]);
    const t = git(dir, ["rev-parse", "HEAD"]);

    const result = checkIntegration({ cwd: dir, branch: b, target: t });
    expect(result.status).toBe("integrated");
    expect((result as { rung: string }).rung).toBe("patch_id_match");
  });

  it("plain unmerged branch -> not_integrated", () => {
    const dir = repo();
    git(dir, ["checkout", "-qb", "feature"]);
    commitFile(dir, "feature.txt", "feature\n", "add feature");
    const b = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "-q", "-"]);
    commitFile(dir, "main-only.txt", "main\n", "unrelated main work");
    const t = git(dir, ["rev-parse", "HEAD"]);

    const result = checkIntegration({ cwd: dir, branch: b, target: t });
    expect(result.status).toBe("not_integrated");
  });

  it("bogus ref -> unknown", () => {
    const dir = repo();
    const t = git(dir, ["rev-parse", "HEAD"]);
    const result = checkIntegration({ cwd: dir, branch: "not-a-real-ref-xyz", target: t });
    expect(result.status).toBe("unknown");
  });
});
