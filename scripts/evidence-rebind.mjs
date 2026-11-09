#!/usr/bin/env node
/**
 * scripts/evidence-rebind.mjs — the post-source-commit producer chain,
 * mechanized (register item 11, 2026-08-24).
 *
 * WHY THIS EXISTS. Immediately after any commit that touches `packages/`,
 * the three automatic evidence stores are definitionally stale (their content hash
 * covers the changed source) and `scripts/tests/gate-failure-modes.test.mjs`'s
 * "the gates agree with themselves on a clean tree" block goes red with them
 * — it freezes HEAD into a snapshot worktree and asserts the freshness gate
 * exits 0 there, which it structurally cannot until the stores are rebound
 * and RE-COMMITTED. `arbor evidence refresh` (`native-tools/evidence-refresh.ts`)
 * already tolerates this red self-test mechanically for the one action it
 * gates (ADR-079's `SUITE_CHECK_EXCLUSIONS`: the failure is unclearable by
 * definition, so refusing would deadlock rather than protect). What was
 * missing was not a mechanism — it was a single command an agent would
 * actually find. Before this script existed, the sanctioned recovery lived
 * only in `runEvidenceRefresh`'s `remedy_commands` JSON array, which nothing
 * surfaces unless a caller already knows to look for it.
 *
 * This runs the four automatic producer steps, in the dependency order
 * `evidence-refresh.ts` enforces (graph before stores and observations before
 * their dependent projections):
 *
 *   1. vi:refresh              — regenerate the VI graph (constraint 3)
 *   2. vi:observe              — runtime observations (an input to 3 and 4)
 *   3. claims:refresh          — claim ledger
 *   4. completion-depth:refresh
 *
 * Determinism measurement is deliberately absent. ADR-034 keeps it manual
 * and off every critical path; invoke `captest bun run determinism:refresh`
 * only when the operator intentionally measures cited seams.
 *
 * FAIL-FAST, NOT BEST-EFFORT. A later producer can genuinely depend on an
 * earlier one's output (vi:observe reads the graph vi:refresh just wrote);
 * continuing past a failed step would refresh downstream stores against
 * known-bad upstream state and report success. Each step's exit code is
 * checked before the next runs.
 *
 * WHAT THIS DOES NOT DO. It never commits (constraint 2 — committing
 * refreshed evidence is the operator's authority, not a script's) and it
 * never guards the determinism-refresh-after-red-suite ordering the way
 * `evidence-refresh.ts` does (that guard exists to stop the transactional
 * refresh path from baking a genuinely-broken suite into the baseline as a
 * false flake). This automatic command deliberately cannot make a new
 * determinism measurement; that remains an explicit operator action.
 *
 * Usage:
 *   bun run evidence:rebind
 */
import { spawnSync } from "node:child_process";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Imported, never restated: the two must agree about what counts as evidence.
import { EVIDENCE_PATH_PREFIXES } from "./evidence-transaction.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

/** Mirrors the automatic evidence order in native-tools/evidence-refresh.ts, graph precheck first. */
export const REBIND_STEPS = Object.freeze([
  // `vi:observe` executes `packages/*/dist/**.js`, never the source the
  // session just committed. A stale dist observed a state no commit has:
  // on 2026-09-04 the close's rebind ran a two-day-old CLI that refused the
  // operator's provider with a rule the source no longer had.
  { label: "build:dist", argv: ["bun", "run", "build:dist"] },
  { label: "vi:refresh", argv: ["bun", "run", "vi:refresh"] },
  { label: "vi:observe", argv: ["bun", "run", "vi:observe"] },
  { label: "claims:refresh", argv: ["bun", "run", "claims:refresh"] },
  { label: "completion-depth:refresh", argv: ["bun", "run", "completion-depth:refresh"] },
]);

/**
 * Runs each step in order, stopping at the first failure. `run` is injectable
 * so the sequencing/fail-fast logic is testable without spawning real
 * producers (the expensive ones run real tests three times each).
 */
/**
 * Source paths this chain would silently fold into the evidence it produces.
 *
 * WHY THIS REFUSES RATHER THAN WARNS. This script's own header calls itself the
 * "post-source-commit producer chain" — it assumes the source is already
 * committed and only the evidence stores are stale. Nothing enforced that
 * assumption, and the failure it allows is not recoverable in place:
 *
 *   `vi:refresh` stamps the graph with the CURRENT tree's input identity. Run
 *   over dirty source, the graph describes a state no commit has, and
 *   `gate:vi-freshness` reports exactly that — "graph was built from a dirty
 *   working tree without a matching immutable evidence-transaction snapshot".
 *   Unlike `evidence:refresh-atomic` (scripts/evidence-transaction.mjs), this
 *   chain creates no such snapshot, so there is nothing for the gate to check
 *   the dirty build against. The only fix is to clean the tree and rebind
 *   again, at full cost.
 *
 * That is worse than an inconvenience when the dirty paths belong to someone
 * else. On 2026-08-29 a concurrent session's uncommitted ADR left this repo
 * with a graph bound to a tree no commit had, and the foreign changes were not
 * this agent's to commit or revert — so the binding could not be repaired in
 * that checkout at all. Refusing up front costs one message; discovering it
 * afterwards costs a full rebind and, with a sibling session in the tree, a
 * move to a separate worktree.
 *
 * Evidence paths are excluded because rewriting them is precisely this chain's
 * job. The prefix list is imported rather than restated so the two cannot drift.
 */
export function dirtySourcePaths(repo = REPO_ROOT, runner = defaultStatusRunner) {
  const out = runner(repo);
  if (out === null) return [];
  return out
    .split("\n")
    // The porcelain prefix is a fixed three columns (`XY `), so the path is
    // sliced from the RAW line. Trimming first eats the leading status column
    // on an unstaged change (" M path") and truncates every path by one char.
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim())
    // A rename reports "old -> new"; the destination is what would be measured.
    .map((path) => (path.includes(" -> ") ? path.split(" -> ").at(-1) : path))
    .map((path) => path.replace(/^"|"$/gu, ""))
    .filter((path) => !EVIDENCE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

function defaultStatusRunner(repo) {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "") : null;
}

export function runRebind(steps, run, log = (line) => process.stderr.write(`${line}\n`)) {
  for (const [index, step] of steps.entries()) {
    log(`[evidence:rebind] (${index + 1}/${steps.length}) ${step.label} — running \`${step.argv.join(" ")}\`...`);
    const result = run(step.argv);
    if (result.status !== 0) {
      log(`[evidence:rebind] FAILED at step ${index + 1}/${steps.length} (${step.label}), exit ${result.status}. Stopping — later producers depend on this one's output.`);
      return { ok: false, failed_step: step.label, exit_code: result.status ?? -1, completed: steps.slice(0, index).map((s) => s.label) };
    }
    log(`[evidence:rebind] (${index + 1}/${steps.length}) ${step.label} — ok.`);
  }
  log("[evidence:rebind] all automatic producers ok. Stores are refreshed in the working tree but NOT committed — " +
    "gate:store-freshness compares against COMMITTED bytes. Review and commit the generated evidence now. " +
    "Determinism measurement remains a separate manual operator action (ADR-034).");
  return { ok: true, failed_step: null, exit_code: 0, completed: steps.map((s) => s.label) };
}

if (import.meta.main) {
  const spawnRunner = (argv) => {
    const [command, ...rest] = argv;
    return spawnSync(command, rest, { cwd: REPO_ROOT, stdio: "inherit" });
  };
  const dirty = dirtySourcePaths();
  if (dirty.length > 0 && !process.argv.includes("--allow-dirty-source")) {
    const shown = dirty.slice(0, 12);
    process.stderr.write("[evidence:rebind] REFUSED — the source tree is dirty.\n\n");
    for (const path of shown) process.stderr.write(`  ${path}\n`);
    if (dirty.length > shown.length) process.stderr.write(`  … and ${dirty.length - shown.length} more\n`);
    process.stderr.write(
      "\nThis chain stamps the VI graph with the CURRENT tree's input identity and creates no\n" +
      "evidence-transaction snapshot, so a graph built here would describe a state no commit\n" +
      "has — gate:vi-freshness rejects exactly that, and the only fix is a full rebind on a\n" +
      "clean tree. Commit or stash the paths above first.\n\n" +
      "If they are not yours, another session shares this checkout: work from a worktree\n" +
      "instead (`bun scripts/session-worktree.mjs new <name>`) rather than committing them.\n\n" +
      "`--allow-dirty-source` overrides this, and produces evidence the freshness gate cannot check.\n",
    );
    process.exitCode = 1;
  } else {
    const result = runRebind(REBIND_STEPS, spawnRunner);
    process.exitCode = result.ok ? 0 : 1;
  }
}
