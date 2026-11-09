#!/usr/bin/env node
/**
 * scripts/branch-accounting.mjs — no commit may exist only on a branch nobody
 * has accounted for.
 *
 * Usage:
 *   bun scripts/branch-accounting.mjs           # human report, exits non-zero on a blocker
 *   bun scripts/branch-accounting.mjs --json    # machine-readable report
 *   bun run gate:branch-accounting
 *
 * WHY THIS EXISTS. A session-hygiene pass found 306 orphaned `arbor/*`
 * branches and 6 orphaned worktrees in this repository — against the 4-and-5
 * that had been reported all session. The campaign machinery cuts a branch and
 * a worktree per node and never reclaims them, so a few demo runs bury real
 * work in noise. The risk is not the noise: it is that a branch carrying the
 * ONLY copy of some commit becomes indistinguishable from 300 branches
 * carrying nothing, and then someone bulk-deletes the lot.
 *
 * WHAT "ACCOUNTED FOR" MEANS, PRECISELY. Naive checks get this wrong in both
 * directions, and both mistakes are expensive:
 *
 *   - `git branch --no-merged master` reports ALL 306 as unmerged, because they
 *     were cut from a feature branch rather than from master. Acting on that
 *     reads as mass data loss where there is none.
 *   - `git branch --merged <current>` reports them all as safe, which is true
 *     today and silently stops being true the moment someone commits on one.
 *
 * So this gate asks the only question that matters: **is there any commit
 * reachable from this branch that is reachable from NO accounted ref?** A ref
 * is accounted for if it is an integration branch (master/main) or carries a
 * dated disposition below. Everything else must answer for itself.
 *
 * REMEDIATION IS THE HUMAN'S, NOT THIS GATE'S. It reports and fails; it never
 * merges, deletes, or rewrites anything. Merging is the right disposition for
 * a branch holding unique work; DELETION is right for one holding none, and a
 * gate that merged on its own judgment would have produced 306 empty merge
 * commits on master the day it was written. Detection and remediation are
 * different authorities — the same separation `session-hygiene` enforces.
 *
 * CONSERVATIVE BIAS (stated, per ADR-117's direction): this gate errs toward
 * ACCUSING a branch it cannot prove is contained. A false "unaccounted" costs
 * someone a look and a disposition entry; a false "accounted" is how the only
 * copy of a commit gets deleted. Unlike registration-integrity's
 * false-LIVE-is-fine posture, here the irreversible outcome is on the
 * permissive side, so the bias inverts.
 */

import { execFileSync } from "node:child_process";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWaiverFile, validateWaiverEntry, isWaiverExpired } from "./lib/waiver-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// `--repo <path>` exists so this gate can be tested against a throwaway
// repository with a genuinely unaccounted branch. Without an injectable root
// the only way to prove it FAILS would be to create a stray branch in the real
// repo — adding to the exact debris it was written to find.
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}
const REPO_ROOT = resolvePath(argValue("--repo") ?? resolvePath(__dirname, ".."));
const JSON_OUTPUT = process.argv.includes("--json");
const DISPOSITIONS_PATH = argValue("--dispositions")
  ?? join(REPO_ROOT, "scripts", "branch-accounting", "dispositions.json");

/** Branches whose contents are, by definition, accounted for. */
const INTEGRATION_BRANCHES = ["master", "main"];

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Branches currently checked out in some worktree. They are never deletable —
 * git refuses — so suggesting it is noise at best and, for a reader who
 * reaches for `-D`, actively bad advice. Found when this gate proposed
 * deleting the three live wave4/* worktree branches right after a cleanup.
 */
function checkedOutBranches() {
  const out = git(["worktree", "list", "--porcelain"]);
  const branches = new Set();
  for (const line of out.split("\n")) {
    if (line.startsWith("branch refs/heads/")) branches.add(line.slice("branch refs/heads/".length));
  }
  return branches;
}

function localBranches() {
  const out = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  return out ? out.split("\n") : [];
}

function branchExists(name) {
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Commits reachable from `branch` but from none of `accountedRefs`.
 * Empty means every commit on the branch already lives somewhere accounted.
 */
export function uniqueCommits(branch, accountedRefs) {
  if (accountedRefs.length === 0) return git(["rev-list", branch]).split("\n").filter(Boolean);
  const out = git(["rev-list", branch, "--not", ...accountedRefs]);
  return out ? out.split("\n") : [];
}

/**
 * Grace window: a branch whose tip is still this fresh is presumed to be
 * someone's active work-in-progress, not something abandoned. 48h, not a
 * day and not a week — long enough to survive an overnight gap in a single
 * work session, short enough that it cannot become a place a real orphan
 * hides. Reported as `in-progress` (listed, never a blocker) rather than
 * silently dropped, so the branch stays visible without demanding a
 * disposition nobody can make yet — nobody knows on day one whether a
 * one-day-old branch will be merged, abandoned, or still running next week.
 */
const YOUNG_BRANCH_GRACE_MS = 48 * 60 * 60 * 1000;

/** Unix seconds -> ms of the branch tip's commit time, or null if unreadable. */
function tipCommitTimeMs(branch) {
  try {
    const seconds = Number.parseInt(git(["log", "-1", "--format=%ct", branch]), 10);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

// loadWaiverFile's fail-closed contract matches this gate's original
// loadDispositions() exactly: file missing -> empty store (no error); file
// present but unparseable/no `entries` array -> empty store PLUS a non-null
// error, which the caller must treat as a blocker (see `dispositionError`
// below) rather than as "nothing is dispositioned" (the permissive
// direction this gate has always refused).
const today = new Date().toISOString().slice(0, 10);
const { entries: dispositions, error: dispositionError } = loadWaiverFile(DISPOSITIONS_PATH);

const active = [];
const expired = [];
for (const entry of dispositions) {
  const { ok: validEntry, errors: entryErrors } = validateWaiverEntry(entry, "branch-accounting");
  if (!validEntry) {
    // "incomplete entry" wording preserved verbatim from this gate's prior
    // hand-rolled check (branch/reason/expires all required) — only the
    // validation itself now runs through the shared waiver-store validator.
    expired.push({ ...entry, why: `incomplete entry — ${entryErrors.join("; ")}` });
    continue;
  }
  if (isWaiverExpired(entry, "branch-accounting", today)) expired.push({ ...entry, why: `expired ${entry.expires}` });
  else active.push(entry);
}

const integration = INTEGRATION_BRANCHES.filter(branchExists);
const dispositioned = active.map((entry) => entry.branch).filter(branchExists);
const accountedRefs = [...integration, ...dispositioned];

const checkedOut = checkedOutBranches();
const unaccounted = [];
const inProgress = [];
const contained = [];
for (const branch of localBranches()) {
  if (accountedRefs.includes(branch)) continue;
  const unique = uniqueCommits(branch, accountedRefs);
  if (unique.length > 0) {
    const entry = {
      branch,
      unique_commits: unique.length,
      tip: unique[0],
      subject: (() => { try { return git(["log", "-1", "--format=%s", unique[0]]); } catch { return "?"; } })(),
    };
    const tipTimeMs = tipCommitTimeMs(branch);
    const isYoung = tipTimeMs !== null && Date.now() - tipTimeMs < YOUNG_BRANCH_GRACE_MS;
    const hasWorktree = checkedOut.has(branch);
    if (isYoung || hasWorktree) {
      inProgress.push({ ...entry, reason: hasWorktree ? "checked out in a worktree" : "tip commit is under 48h old" });
    } else {
      unaccounted.push(entry);
    }
  } else {
    contained.push(branch);
  }
}

const blockers = unaccounted.length + (dispositionError ? 1 : 0) + expired.length;

if (JSON_OUTPUT) {
  // `--json` is the mode meant for machines, so it must not be strictly less
  // informative than the text mode a human reads. It previously emitted only
  // `contained_branch_count` — a bare integer — while text mode printed the
  // branch names AND the exact `git branch -d` command. A CI job could learn
  // that N branches were safe to delete but not which ones.
  const deletable = contained.filter((branch) => !checkedOut.has(branch));
  const pinned = contained.filter((branch) => checkedOut.has(branch));
  console.log(JSON.stringify({
    integration_branches: integration,
    dispositioned_branches: dispositioned,
    expired_dispositions: expired,
    disposition_error: dispositionError,
    contained_branch_count: contained.length,
    contained_branches: contained,
    /** Contained and not checked out anywhere — safe to `git branch -d`. */
    deletable_branches: deletable,
    /** Contained but checked out in a worktree, so deletion would fail. */
    pinned_branches: pinned,
    checked_out_branches: [...checkedOut],
    in_progress: inProgress,
    unaccounted,
    blockers,
  }, null, 2));
} else {
  console.log(`branch-accounting gate — ${localBranches().length} local branch(es)\n`);
  console.log(`integration refs        : ${integration.join(", ") || "(none found)"}`);
  console.log(`dispositioned           : ${dispositioned.length}`);
  console.log(`fully contained         : ${contained.length}  (every commit lives on an accounted ref)`);
  console.log(`in progress             : ${inProgress.length}  (young or worktree-backed — listed, not a blocker)`);
  console.log(`UNACCOUNTED             : ${unaccounted.length}\n`);

  if (dispositionError) console.log(`BLOCKER: ${dispositionError}\n`);
  for (const entry of expired) {
    console.log(`BLOCKER: disposition for ${entry.branch ?? "(unnamed)"} — ${entry.why}`);
  }
  if (expired.length > 0) console.log("");

  for (const item of inProgress) {
    console.log(`in-progress: ${item.branch}  (${item.reason})`);
    console.log(`  ${item.unique_commits} commit(s) reachable from no accounted ref — not yet a blocker.\n`);
  }

  for (const item of unaccounted) {
    console.log(`BLOCKER: ${item.branch}`);
    console.log(`  ${item.unique_commits} commit(s) reachable from no accounted ref`);
    console.log(`  tip ${item.tip.slice(0, 12)}  ${item.subject}`);
    console.log(`  record a disposition — note this will add an interview obligation to`);
    console.log(`  gate:decision-queue (merge, cherry-pick, delete, or record it in`);
    console.log(`  scripts/branch-accounting/dispositions.json with a reason and an expiry).\n`);
  }

  const deletable = contained.filter((branch) => !checkedOut.has(branch));
  const pinned = contained.filter((branch) => checkedOut.has(branch));
  if (pinned.length > 0) {
    console.log(`${pinned.length} contained branch(es) are checked out in a worktree and cannot be deleted: ${pinned.join(", ")}\n`);
  }
  if (deletable.length > 0 && unaccounted.length === 0) {
    console.log(`The ${deletable.length} other contained branch(es) hold no unique commit and are safe to delete:`);
    console.log(`  git branch --merged <their base> | xargs -r git branch -d\n`);
  }
  console.log(blockers === 0 ? "PASS" : `FAIL — ${blockers} blocker(s)`);
}

process.exitCode = blockers > 0 ? 1 : 0;
