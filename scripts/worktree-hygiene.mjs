#!/usr/bin/env node
/**
 * scripts/worktree-hygiene.mjs — proactive stranded-worktree sweep (G-XX).
 *
 * Usage:
 *   bun scripts/worktree-hygiene.mjs          # read-only human-readable report
 *   bun scripts/worktree-hygiene.mjs --json   # machine-readable report
 *   bun scripts/worktree-hygiene.mjs --prune  # explicit maintenance action
 *   bun run gate:worktree-hygiene             # wired via package.json, and
 *                                                 into scripts/hooks/pre-push
 *
 * WHY THIS EXISTS. A session-hygiene incident found a `prunable` worktree
 * registration (`git worktree list` shows a `gitdir` pointing at a path that
 * no longer exists) left behind after a test run under /tmp, plus a locked
 * `.claude/worktrees/*` entry a prior session assumed was safe to remove —
 * it wasn't; its `claude session <name> (pid N start M)` lock reason named a
 * PID that was, on inspection, still alive and actively working. Both classes
 * of stranded state accumulate silently between sessions in a box that runs
 * many concurrent worktrees against one shared repo.
 *
 * TWO DIFFERENT SAFETY LEVELS, ON PURPOSE:
 *
 *   1. `git worktree prune` — objectively safe, but still a write to shared
 *      Git administration. Git itself only removes a
 *      worktree's registration when the directory it points at is
 *      objectively gone; it never touches a worktree whose checkout still
 *      exists, locked or not. The gate reports these registrations; an
 *      operator must explicitly pass `--prune` to mutate them.
 *
 *   2. Locked worktrees whose lock reason names a PID that is no longer
 *      running — REPORTED, never auto-removed. This mirrors
 *      branch-accounting.mjs's established convention in this repo (ADR-117):
 *      detection and remediation are different authorities, because a false
 *      "safe to remove" costs a live session its work while a false "leave
 *      it" only costs someone a look. The incident this gate responds to is
 *      exactly a case where "looks obviously stale" was wrong — the PID was
 *      alive. A dead PID is objective, verifiable evidence a running process
 *      cannot fake; that is the one signal this gate acts as a *detector*
 *      for, and even then it only reports, never unlocks/removes.
 *
 * Exits 0 always — this is a hygiene report, not a correctness gate, so a
 * stray worktree elsewhere must never block an unrelated contributor's push.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `--repo <path>` exists so this gate can be tested against a throwaway repo
// rather than always acting on its own location (branch-accounting.mjs sets
// this precedent).
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}
const REPO_ROOT = resolvePath(argValue("--repo") ?? resolvePath(__dirname, ".."));
const jsonMode = process.argv.includes("--json");
const pruneMode = process.argv.includes("--prune");

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" });
}

function parseWorktrees(porcelain) {
  const entries = [];
  let current = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), locked: false, lockReason: null, prunable: false };
      entries.push(current);
    } else if (current && line === "locked") {
      current.locked = true;
    } else if (current && line.startsWith("locked ")) {
      current.locked = true;
      current.lockReason = line.slice("locked ".length);
    } else if (current && line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  return entries;
}

function extractPid(lockReason) {
  const match = /\(pid (\d+)\s/.exec(lockReason ?? "");
  return match ? Number(match[1]) : null;
}

function isPidAlive(pid) {
  if (process.platform === "linux") return existsSync(`/proc/${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const before = parseWorktrees(git(["worktree", "list", "--porcelain"]));
  const prunableBefore = before.filter((w) => w.prunable);

  if (pruneMode) {
    try {
      execFileSync("git", ["worktree", "prune", "-v"], { cwd: REPO_ROOT, encoding: "utf-8" });
    } catch {
      // Explicit maintenance still reports the pre-action census if prune
      // fails; this advisory command never converts housekeeping into a gate.
    }
  }

  const after = parseWorktrees(git(["worktree", "list", "--porcelain"]));
  const staleLocks = [];
  for (const w of after) {
    if (!w.locked) continue;
    const pid = extractPid(w.lockReason);
    if (pid === null) continue; // not our lock-reason convention; nothing to check
    if (!isPidAlive(pid)) {
      staleLocks.push({ path: w.path, lockReason: w.lockReason, pid });
    }
  }

  const report = {
    mode: pruneMode ? "maintenance" : "check",
    prunable_count: prunableBefore.length,
    prunable: prunableBefore.map((w) => w.path),
    pruned_count: pruneMode ? prunableBefore.length : 0,
    pruned: pruneMode ? prunableBefore.map((w) => w.path) : [],
    stale_locks: staleLocks,
  };

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  if (!pruneMode && report.prunable_count > 0) {
    console.log(`worktree-hygiene: ${report.prunable_count} orphaned worktree registration(s) can be pruned with \`bun scripts/worktree-hygiene.mjs --prune\`:`);
    for (const p of report.prunable) console.log(`  - ${p}`);
  } else if (report.pruned_count > 0) {
    console.log(`worktree-hygiene: pruned ${report.pruned_count} orphaned worktree registration(s):`);
    for (const p of report.pruned) console.log(`  - ${p}`);
  } else {
    console.log("worktree-hygiene: no orphaned worktree registrations detected.");
  }

  if (staleLocks.length > 0) {
    console.log("");
    console.log(`worktree-hygiene: ${staleLocks.length} locked worktree(s) name a PID that is no longer running — likely safe to unlock/remove, but this gate never does that automatically:`);
    for (const s of staleLocks) console.log(`  - ${s.path} (${s.lockReason})`);
    console.log("  Verify independently, then: git worktree unlock <path> && git worktree remove <path>");
  }
}

main();
