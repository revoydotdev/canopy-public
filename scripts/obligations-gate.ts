#!/usr/bin/env -S node
/**
 * scripts/obligations-gate.ts — the ADR obligation gate (POL-04 / M-B).
 *
 * `@arbor/governance` could already compute obligation coverage and emit
 * POL-04 ("accepted but declares zero obligations") and M-B ("a proof field
 * does not resolve") findings, and `governance.snapshot` surfaced them to the
 * TUI. Nothing ever failed a build on them. On 2026-08-07 that meant all 29
 * accepted ADRs carried a POL-04 finding — the corpus was fully ratified and
 * entirely unwitnessed — and the rule had fired 29 times without once being
 * acted on, which is how a gate stops being read.
 *
 * WHAT THIS GATES ON — read before trusting a green run here:
 *
 *   M-B is BLOCKING. A proof comment that names a symbol, file, or roundtrip
 *   that does not resolve is a false citation, and a false citation is worse
 *   than no citation: it converts "unverified" into "apparently verified".
 *
 *   M-C is BLOCKING for active Proposed and Accepted decisions. Draft records
 *   may still be authored, and Rejected or Superseded records remain truthful
 *   historical evidence without continuing to demand implementation.
 *
 *   POL-04 is REPORTED, with a floor. An accepted record declaring zero
 *   obligations is legacy debt, not a build break, so the gate fails only if
 *   the count RISES above the pinned floor below. That makes the ratchet
 *   one-way — a new accepted ADR cannot ship unwitnessed — without demanding
 *   that the entire historical corpus be retrofitted in one commit.
 *
 * THE HONEST CEILING, inherited from `obligation/proof.ts` and restated here
 * because this script is what a CI log shows: a resolving `roundtrip=` proves
 * a named test file EXISTS and IS COLLECTED by vitest. It does not prove the
 * test passes, and it does not prove the test exercises the obligation cited
 * against it. This gate therefore measures *citation integrity*, not
 * correctness. An active obligation with no proof comment is reported as M-C;
 * retired records are not forced to manufacture evidence for work the
 * repository explicitly rejected or superseded.
 */

import { buildObligationCoverageReport } from "@arbor/governance";
import { evidenceTransactionReadStatus } from "./evidence-transaction.mjs";
import { assertGovernanceConsumerReady } from "./lib/governance-plan.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Accepted records still declaring zero obligations. Ratchet only: lower it
 * as records gain obligations, never raise it to make room for a new one.
 */
const POL_04_FLOOR = 0;

const AT = new Date().toISOString();
// `--repo` is a fixture seam only (see `guard:canaries`). The report builder
// already accepted `repoRoot` (and `decisionsDir`); this CLI passed neither, so
// it could only ever describe this clone's own corpus. Absent the flag,
// unchanged.
const repoArgIndex = process.argv.indexOf("--repo");
const REPO_ROOT = repoArgIndex >= 0 && repoArgIndex + 1 < process.argv.length
  ? resolve(process.argv[repoArgIndex + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main(): number {
  try {
    assertGovernanceConsumerReady({ consumer: "obligations-gate", evidenceStatus: evidenceTransactionReadStatus({ repo: REPO_ROOT }) });
  } catch (error) {
    console.error(`obligations gate — FAILED consumer precondition: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const report = buildObligationCoverageReport({ at: AT, repoRoot: REPO_ROOT });
  if (!report.ok) {
    console.error(`obligations gate — FAILED to build report: ${report.error.message}`);
    return 1;
  }

  const { records, findings } = report.value;
  const pol04 = findings.filter((f) => f.rule_id === "POL-04");
  const mb = findings.filter((f) => f.rule_id === "M-B");
  const mc = findings.filter((f) => f.rule_id === "M-C");

  const declared = records.filter((r) => r.obligation_count > 0);
  const totalObligations = declared.reduce((n, r) => n + r.obligation_count, 0);
  const covered = declared.reduce((n, r) => n + r.obligations_with_resolving_proof, 0);

  console.log(`obligations gate — ${records.length} record(s) checked`);
  console.log(
    `  ${declared.length} declare an Obligations section, ` +
    `${totalObligations} obligation(s) total, ` +
    `${covered} with a resolving proof (citation integrity, not correctness)`,
  );
  console.log(`  POL-04 (accepted, zero obligations): ${pol04.length} — floor ${POL_04_FLOOR}`);
  console.log(`  M-B  (proof field does not resolve): ${mb.length} — BLOCKING`);
  console.log(`  M-C  (active obligation has no evidence or reason): ${mc.length} — BLOCKING`);

  for (const finding of mb) {
    console.log(`\n  [M-B] ${finding.severity} — ${finding.detail}`);
  }
  for (const finding of mc) {
    console.log(`\n  [M-C] ${finding.severity} — ${finding.detail}`);
  }
  if (pol04.length > 0) {
    console.log("");
    for (const finding of pol04) {
      const id = "record_id" in finding.subject ? finding.subject.record_id : "?";
      console.log(`  [POL-04] ${id} — accepted, zero obligations`);
    }
  }

  let failed = false;
  if (mb.length > 0 || mc.length > 0) {
    console.log(`\nFAIL — every obligation must carry either resolving evidence or an explicit unverifiable reason.`);
    failed = true;
  }
  if (pol04.length > POL_04_FLOOR) {
    console.log(
      `\nFAIL — ${pol04.length} accepted record(s) declare zero obligations, above the floor of ${POL_04_FLOOR}. ` +
      `Add an Obligations section, or lower the floor only if a record was legitimately retired.`,
    );
    failed = true;
  }

  if (!failed) console.log("\nPASS");
  return failed ? 1 : 0;
}

process.exit(main());
