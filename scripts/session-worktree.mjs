#!/usr/bin/env node
/**
 * scripts/session-worktree.mjs — give a session its own working tree.
 *
 * Usage:
 *   bun scripts/session-worktree.mjs new <name> [--from <ref>] [--no-build]
 *   bun scripts/session-worktree.mjs list
 *   bun scripts/session-worktree.mjs remove <name>
 *
 * WHY A WORKTREE AND NOT A BRANCH. Sessions sharing a checkout share one
 * WORKING TREE, and that is the thing that collides — not the branch. Two
 * agents on two branches in one checkout still overwrite each other's files,
 * and `git checkout -b` from a session-start hook is actively worse: it carries
 * whatever dirt is already there onto the new branch and yanks the tree out
 * from under whoever else is mid-edit. A branch isolates history; only a
 * worktree isolates the files.
 *
 * WHAT THIS EXISTS TO PREVENT, concretely. On 2026-08-29 two sessions shared
 * this checkout. One ran `evidence:rebind` while the other had an uncommitted
 * ADR in the tree; the graph was stamped with an input identity no commit had,
 * `gate:vi-freshness` rejected it, and the fix was unavailable in place because
 * the foreign changes were not the first agent's to commit or revert. The
 * repair was exactly this: a worktree, its own node_modules, a build, and a
 * rebind on a clean tree.
 *
 * THE TWO STEPS THAT ARE EASY TO MISS, and why they are done here:
 *
 *   1. `bun install` in the worktree. Without it, `node_modules/@arbor/*`
 *      resolves back into the SHARED checkout's packages, so the isolated tree
 *      silently analyses and tests the other session's source. That defeats the
 *      entire point while looking like it worked.
 *   2. `tsc --build`. `vi:observe` drives `packages/arbor-mcp/dist/cli.js`; a
 *      fresh worktree has no dist, so `evidence:rebind` fails at step 2 of 4
 *      after the graph step has already run.
 *
 * Both were learned by hitting them, in that order.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Beside the repo, not inside it: a nested worktree is walked by the gates' own file scans. */
const DEFAULT_ROOT = process.env.REVOY2_WORKTREE_ROOT ?? "/mnt/sda2/revoy2/worktrees";

function run(command, args, cwd = REPO_ROOT, inherit = true) {
  return spawnSync(command, args, { cwd, stdio: inherit ? "inherit" : "pipe", encoding: "utf8" });
}
function capture(command, args, cwd = REPO_ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "") : "";
}
function fail(message) {
  process.stderr.write(`session-worktree: ${message}\n`);
  process.exitCode = 1;
}

export function worktreePath(name, root = DEFAULT_ROOT) {
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(name)) return null;
  return join(root, name);
}

/** Every worktree git knows about, with the branch or detached head each holds. */
export function listWorktrees() {
  const out = capture("git", ["worktree", "list", "--porcelain"]);
  const entries = [];
  let current = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) { if (current.path) entries.push(current); current = { path: line.slice(9) }; }
    else if (line.startsWith("branch ")) current.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "detached") current.branch = "(detached)";
  }
  if (current.path) entries.push(current);
  return entries;
}

function create(name, fromRef, build) {
  const target = worktreePath(name);
  if (target === null) return fail(`"${name}" is not a usable worktree name (letters, digits, dot, dash, underscore)`);
  if (existsSync(target)) return fail(`${target} already exists — pick another name or remove it first`);

  // Detached deliberately: the branch this is cut from is usually checked out
  // in the shared checkout, and git refuses to check the same branch out twice.
  // Commit here, then fast-forward the branch from the other checkout.
  const added = run("git", ["worktree", "add", "--detach", target, fromRef]);
  if (added.status !== 0) return fail(`git worktree add failed for ${fromRef}`);

  const installed = run("bun", ["install"], target);
  if (installed.status !== 0) {
    return fail(`bun install failed in ${target} — WITHOUT it @arbor/* resolves back into the shared checkout, so do not use this worktree until it succeeds`);
  }

  if (build) {
    const built = run("npx", ["tsc", "--build"], target);
    if (built.status !== 0) {
      process.stderr.write("session-worktree: tsc --build failed; evidence:rebind will stop at vi:observe until a dist/ exists.\n");
    }
  }

  process.stdout.write(`\nsession-worktree: ready at ${target} (detached at ${fromRef})\n`);
  process.stdout.write(`  cd ${target}\n`);
  process.stdout.write("  # commit here, then from the shared checkout: git merge --ff-only <sha>\n");
  process.stdout.write(`  # when done: bun scripts/session-worktree.mjs remove ${name}\n`);
  return undefined;
}

function remove(name) {
  const target = worktreePath(name);
  if (target === null) return fail(`"${name}" is not a usable worktree name`);
  if (!existsSync(target)) return fail(`${target} does not exist`);
  const dirty = capture("git", ["status", "--porcelain"], target).trim();
  if (dirty !== "") {
    return fail(`${target} has uncommitted changes — commit them, or remove it by hand once you are sure:\n${dirty.split("\n").slice(0, 10).map((l) => `    ${l}`).join("\n")}`);
  }
  const removed = run("git", ["worktree", "remove", target]);
  if (removed.status !== 0) return fail(`git worktree remove failed for ${target}`);
  process.stdout.write(`session-worktree: removed ${target}\n`);
  return undefined;
}

if (import.meta.main) {
  const [action, name] = process.argv.slice(2);
  const flag = (f) => process.argv.includes(f);
  const value = (f, fallback) => { const i = process.argv.indexOf(f); return i < 0 ? fallback : (process.argv[i + 1] ?? fallback); };

  if (action === "list") {
    for (const entry of listWorktrees()) process.stdout.write(`${entry.branch ?? "?"}\t${entry.path}\n`);
  } else if (action === "new") {
    if (!name) fail("usage: session-worktree.mjs new <name> [--from <ref>] [--no-build]");
    else create(name, value("--from", "HEAD"), !flag("--no-build"));
  } else if (action === "remove") {
    if (!name) fail("usage: session-worktree.mjs remove <name>");
    else remove(name);
  } else {
    fail("usage: session-worktree.mjs <new|list|remove> [name] [--from <ref>] [--no-build]");
  }
}
