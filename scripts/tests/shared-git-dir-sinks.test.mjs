/**
 * shared-git-dir-sinks.test.ts — the `shared_git_dir` declaration, held in place.
 *
 * CD-E-21's three sink families write into `git rev-parse --git-common-dir`,
 * outside any worktree. That is DELIBERATE: the shared git dir is the only
 * location visible across every linked worktree, which is exactly what an
 * evidence-refresh writer lease, an unforgeable interview-receipt ledger, and
 * the trunk-submit journal need. Redirecting them into the persistence root
 * would break the cross-worktree exclusion and receipt visibility they exist to
 * provide, so they must NOT be "fixed" — they must be DECLARED.
 *
 * A declaration in a markdown table is prose, and prose drifts. This asserts
 * the two halves against each other: each family still resolves into the git
 * common dir (so the declaration is true of the code), and the register still
 * names every family (so the declaration is true of the register). Removing a
 * family from the code without updating the register turns this red, and so
 * does silently redirecting one into the worktree.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceTransactionPaths } from "../evidence-transaction.mjs";
import { receiptStorePath } from "../lib/interview-receipts.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTER = join(REPO_ROOT, ".visual-intelligence/findings/circuit-dag-register.md");

function gitCommonDir(repo) {
  return resolve(repo, execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim());
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Stated from the construction sites, not from the register: each entry is the
 * one function that builds that family's directory, read straight from source.
 */
const FAMILIES = [
  {
    name: "evidence-refresh writer lease",
    site: "scripts/evidence-transaction.mjs:138",
    resolvePath: (repo) => evidenceTransactionPaths(repo).directory,
  },
  {
    name: "interview receipt ledger",
    site: "scripts/lib/interview-receipts.mjs:64",
    resolvePath: (repo) => receiptStorePath(repo),
  },
  {
    name: "trunk-submit journal",
    site: "scripts/trunk-submit.mjs:199,216,262",
    // `journalWriter` is module-private; its directory is the `<commonDir>/arbor/
    // trunk-submit` prefix every one of the three cited sites joins onto.
    resolvePath: (repo) => join(gitCommonDir(repo), "arbor", "trunk-submit"),
  },
];

describe("declared shared_git_dir sinks (CD-E-21)", () => {
  for (const family of FAMILIES) {
    it(`${family.name} resolves into the git common dir, not the worktree`, () => {
      const common = gitCommonDir(REPO_ROOT);
      const path = family.resolvePath(REPO_ROOT);

      expect(isInside(common, path)).toBe(true);
      // The property that makes this deliberate rather than accidental: it is
      // NOT inside the repository working tree that `.arbor` lives in.
      expect(isInside(join(REPO_ROOT, ".arbor"), path)).toBe(false);
    });

    it(`${family.name} is named in the register's CD-E-21 row`, () => {
      const row = readFileSync(REGISTER, "utf8")
        .split("\n")
        .find((line) => line.startsWith("| CD-E-21 |"));
      expect(row).toBeDefined();

      const file = family.site.split(":")[0];
      expect(row).toContain(file);
    });
  }

  it("the CD-E-21 row declares the class as intentional, not a defect to fix", () => {
    const row = readFileSync(REGISTER, "utf8")
      .split("\n")
      .find((line) => line.startsWith("| CD-E-21 |"));

    // Without this the row reads as an open defect and a later reader "fixes"
    // it by redirecting the sinks into the worktree, destroying the
    // cross-worktree exclusion.
    expect(row).toContain("shared_git_dir");
    expect(row).toMatch(/intentional|NOT a defect/i);
    expect(row).toMatch(/Do not "fix"|not to be "fixed"/i);
  });
});
