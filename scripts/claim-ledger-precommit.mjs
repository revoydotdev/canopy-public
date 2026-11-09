#!/usr/bin/env node
/**
 * scripts/claim-ledger-precommit.mjs — auto-refresh the claim ledger before
 * a commit pushes it over half its store-freshness-gate.mjs budget.
 *
 *   bun scripts/claim-ledger-precommit.mjs   (run by scripts/hooks/pre-commit)
 *
 * WHY THIS EXISTS. `.claim-ledger/`'s producer (`bun run claims:refresh`) is
 * manual, but `store-freshness-gate.mjs` enforces its staleness budget
 * automatically, inside the unit suite (`gate-failure-modes.test.mjs` asserts
 * it "exits 0 against the real, committed stores"). A manual producer with
 * automatic enforcement means whoever runs the suite next after a commit
 * burst pays for someone else's un-refreshed commits — observed twice on
 * 2026-08-11: completion-depth went 26/25 after a 27-commit tranche, then
 * claim-ledger went 12/10 after 4 cleanup commits.
 *
 * So: at commit time, when the store is trailing by MORE THAN HALF its
 * budget, refresh it and stage the result on the same commit — the person
 * whose commit pushed it over budget pays the (cheap, ~6s) refresh cost,
 * not whoever happens to run tests next. Below half, this is a no-op: an
 * ordinary commit must stay fast, and the budget already tolerates a normal
 * amount of lag between refreshes.
 *
 * DELIBERATELY NARROW. Only claim-ledger auto-refreshes here.
 * `completion-depth` and the determinism baseline stay manual — ADR-034
 * keeps the determinism baseline off the critical path because it is
 * expensive and flake-prone on a shared runner, and the same reasoning
 * extends to not silently running either of them on every commit.
 *
 * The budget is imported, never duplicated, from `lib/store-budgets.mjs` —
 * the same module `store-freshness-gate.mjs` reads it from — so this hook
 * and the gate it exists to stay ahead of can never disagree about what
 * "close to the budget" means.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLAIM_LEDGER_BUDGET_COMMITS } from "./lib/store-budgets.mjs";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

// `--repo` is a fixture seam only (see `guard:canaries`): it points this hook's
// git and store reads at a throwaway repository so a canary can prove the hook
// is able to fail without mutating the real one. Absent the flag, behaviour is
// byte-identical to the previous constant.
const REPO_ROOT = resolve(argValue(process.argv, "--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const STORE_DIR = process.env.REVOY2_CLAIM_LEDGER_DIR
  ? resolve(process.env.REVOY2_CLAIM_LEDGER_DIR)
  : join(REPO_ROOT, ".claim-ledger");

/**
 * The decision, isolated so it is testable without a real commit, a real
 * store, or a real git history. "More than half the budget" — not "at" the
 * budget — so the refresh lands well before store-freshness-gate.mjs would
 * ever fail, and a commit right at the threshold is still a no-op.
 */
export function shouldAutoRefresh(behindCommits, budget) {
  return behindCommits > budget / 2;
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
}

/**
 * How far the claim-ledger store trails HEAD, or `null` if that cannot be
 * determined from here. Anything unmeasurable is left to
 * `store-freshness-gate.mjs` to report at push/CI time — this hook's only
 * job is the fast, common case of "measurably behind by more than half the
 * budget", not a second copy of the gate's full validation.
 */
function commitsBehind(head) {
  const manifestPath = join(STORE_DIR, "manifest.json");
  if (!existsSync(manifestPath)) return null;

  let rev;
  try {
    rev = JSON.parse(readFileSync(manifestPath, "utf8")).scanned_up_to_revision;
  } catch {
    return null;
  }
  if (!rev) return null;

  try {
    git(["cat-file", "-e", `${rev}^{commit}`]);
    execFileSync("git", ["merge-base", "--is-ancestor", rev, head], { cwd: REPO_ROOT });
  } catch {
    return null;
  }

  return Number.parseInt(git(["rev-list", "--count", `${rev}..${head}`]), 10);
}

function main() {
  const head = git(["rev-parse", "HEAD"]);
  const behind = commitsBehind(head);
  if (behind === null || !shouldAutoRefresh(behind, CLAIM_LEDGER_BUDGET_COMMITS)) return 0;

  console.log(
    `[pre-commit] claim ledger ${behind} commit(s) behind HEAD (budget ${CLAIM_LEDGER_BUDGET_COMMITS}) — auto-refreshing`,
  );

  try {
    execFileSync("bun", ["run", "claims:refresh"], { cwd: REPO_ROOT, stdio: "inherit" });
  } catch (e) {
    console.error("[pre-commit] claim-ledger auto-refresh FAILED — commit aborted.");
    console.error(`  Run \`bun run claims:refresh\` by hand and investigate: ${e.message ?? e}`);
    return 1;
  }

  try {
    execFileSync("git", ["add", ".claim-ledger"], { cwd: REPO_ROOT, stdio: "inherit" });
  } catch (e) {
    console.error("[pre-commit] refresh succeeded but `git add .claim-ledger` FAILED — commit aborted.");
    console.error(`  Stage it manually and retry: ${e.message ?? e}`);
    return 1;
  }

  console.log("[pre-commit] claim ledger refreshed and staged");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
