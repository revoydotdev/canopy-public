#!/usr/bin/env node
/**
 * scripts/decisions-precommit-gate.mjs — the decisions interlock (fixes D4,
 * narrowly).
 *
 *   bun scripts/decisions-precommit-gate.mjs   (run by scripts/hooks/pre-commit)
 *
 * WHY THIS EXISTS. `scripts/adr-registry.mjs verify` already catches a broken
 * registry (duplicate numbers, missing allocation rows, un-reserved
 * cross-namespace citations, `next_available` collisions), but nothing ran it
 * at commit time — it was purely advisory, caught only by whoever next ran
 * the gate. This closes that gap for the one case that matters at commit
 * time: a commit that touches `decisions/` at all.
 *
 * DELIBERATELY NARROW, same posture as claim-ledger-precommit.mjs alongside
 * it. A commit that does not touch `decisions/` never even calls
 * `verifyRegistry` — zero added cost on every other commit.
 *
 * ESCAPE HATCH. `ARBOR_SKIP_DECISION_GATE=1` bypasses the block. A logged
 * bypass, never a silent one: it appends an audit line to
 * `.hook-liveness/invocations.jsonl` recording the timestamp, HEAD sha, and
 * the staged decisions/ paths, and prints a loud warning so the bypass is
 * visible in the commit's own terminal output, not just buried in a log file.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyRegistry } from "./lib/adr-registry.mjs";
import { evidenceTransactionReadStatus } from "./evidence-transaction.mjs";
import { assertGovernanceConsumerReady } from "./lib/governance-plan.mjs";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

// `--repo` is a fixture seam only (see `guard:canaries`): it points this gate's
// staged-path, bypass-log and registry reads at a throwaway repository so a
// canary can prove the gate is able to fail without the real one being touched.
// Absent the flag, behaviour is byte-identical to the previous constant.
const REPO_ROOT = resolve(argValue(process.argv, "--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));

function stagedPaths(repoRoot) {
  const out = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function headSha(repoRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    // No HEAD yet (first commit in a fresh repo) — nothing to cite.
    return null;
  }
}

function recordBypass(repoRoot, livenessLog, stagedDecisionPaths) {
  mkdirSync(dirname(livenessLog), { recursive: true });
  const record = {
    hook_id: "decisions-precommit-gate",
    at_epoch: Math.floor(Date.now() / 1000),
    bypass: true,
    head_sha: headSha(repoRoot),
    staged_decision_paths: stagedDecisionPaths,
  };
  appendFileSync(livenessLog, `${JSON.stringify(record)}\n`);
}

/**
 * The gate's decision, isolated from process.exit/CLI wiring so it is
 * testable against a real throwaway repo without a real commit. Exported for
 * scripts/tests/decisions-precommit-gate.test.mjs.
 */
export function runDecisionsGate({ repoRoot, livenessLog = join(repoRoot, ".hook-liveness", "invocations.jsonl"), env = process.env, log = console.error } = {}) {
  const staged = stagedPaths(repoRoot);
  const stagedDecisionPaths = staged.filter((path) => path.startsWith("decisions/"));
  if (stagedDecisionPaths.length === 0) return { ok: true, skipped: true };

  try {
    assertGovernanceConsumerReady({ consumer: "decisions-precommit-gate", evidenceStatus: evidenceTransactionReadStatus({ repo: repoRoot }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`decisions-precommit-gate: BLOCKED — consumer precondition failed: ${message}`);
    return { ok: false, errors: [message] };
  }

  if (env.ARBOR_SKIP_DECISION_GATE === "1") {
    recordBypass(repoRoot, livenessLog, stagedDecisionPaths);
    log("decisions-precommit-gate: ARBOR_SKIP_DECISION_GATE=1 — skipping `adr-registry.mjs verify`.");
    log("  This bypass was logged to .hook-liveness/invocations.jsonl (timestamp, HEAD sha, staged decisions/ paths).");
    return { ok: true, bypassed: true, staged_decision_paths: stagedDecisionPaths };
  }

  let result;
  try {
    result = verifyRegistry(repoRoot);
  } catch (error) {
    result = { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
  if (!result.ok) {
    log("");
    log("decisions-precommit-gate: BLOCKED — `adr-registry.mjs verify` failed for a commit touching decisions/.");
    for (const error of result.errors) log(`  - ${error}`);
    log("  Remedy: fix the registry above, or set ARBOR_SKIP_DECISION_GATE=1 to bypass (logged).");
    return { ok: false, errors: result.errors };
  }
  return { ok: true };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = runDecisionsGate({ repoRoot: REPO_ROOT }).ok ? 0 : 1;
}
