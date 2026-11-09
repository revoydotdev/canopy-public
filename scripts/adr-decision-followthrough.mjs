#!/usr/bin/env node
/**
 * scripts/adr-decision-followthrough.mjs — gate:adr-decision-followthrough
 *
 * WHY THIS EXISTS (ADR-085). The decision queue is silenced when an interview
 * RECORDS a decision about a record ("coverage"). But coverage was never
 * reconciled against the record's actual status: an ADR could be interviewed,
 * decided "accept", and then sit at `Status: Proposed` forever, because
 * coverage — not acceptance — is what cleared the queue. `adr-status-audit.mjs`
 * says as much ("acceptance is out of this audit's scope"). So the system
 * proved an interview was HELD; it never proved a decided ADR was PROMOTED.
 *
 * This gate closes that gap. For every ADR the interview ledger covers (i.e.
 * a decision was recorded) that is NOT currently deferred into the future, the
 * ADR must have reached a TERMINAL status — Accepted, Rejected, Superseded, or
 * Retired. A decided ADR still at `Proposed`/`Draft` fails: coverage no longer
 * clears it. Direction does not matter (greenlight or redlight) — a recorded
 * decision that was never carried through to the record's status is the defect.
 *
 * It deliberately does NOT force a direction, re-open a terminal record, or
 * touch a record whose most recent interview deferred it (a deferral is a
 * considered "not yet", and `coverageIndex` already expires stale ones). It
 * never blocks the mere authoring of a Proposed ADR — only a DECIDED one that
 * was not promoted or rejected — so it cannot deadlock the pipeline the way a
 * hard block on un-interviewed proposed records would (see ADR-085 and the
 * decision-queue `flagged_proposed` bucket).
 *
 * Usage:
 *   bun scripts/adr-decision-followthrough.mjs           human report, exit 1 on any violation
 *   bun scripts/adr-decision-followthrough.mjs --json    machine-readable
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { coverageIndex, interviewAttestation, readInterviews, recordStatuses } from "./decision-queue.mjs";
import { evidenceTransactionReadStatus } from "./evidence-transaction.mjs";
import { assertGovernanceConsumerReady } from "./lib/governance-plan.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");

/** A record whose interview has been carried through has one of these statuses. */
const TERMINAL_STATUSES = new Set(["accepted", "rejected", "superseded", "retired"]);
const ADR_ID_RE = /^ADR-\d+$/;

export function decisionFollowthrough(repo = REPO_ROOT, today = new Date().toISOString().slice(0, 10)) {
  // ADR-158: this gate reads the same coverage that silences the queue, so it
  // must read it the same way — through the attestation predicate. Omitting it
  // (as this did) let a hand-appended ledger line both silence the queue and
  // assert here that an operator had decided, which is the one substitution
  // the interview skill exists to prevent. `isAttested` stays `null` on a
  // clone with no receipt store, so a fresh checkout is unaffected.
  const interviews = readInterviews(repo);
  const attestation = interviewAttestation(repo, interviews);
  const covered = coverageIndex(interviews, today, { isAttested: attestation.isAttested });
  const statuses = recordStatuses(repo);
  const violations = [];
  const deferred = [];
  const carried = [];
  for (const [id, entry] of covered) {
    if (!ADR_ID_RE.test(id)) continue; // only ADR records; hazards / operator-decision ids are not this gate's concern
    if (entry.deferred_to !== null) { deferred.push({ id, deferred_to: entry.deferred_to }); continue; }
    const status = statuses.get(id);
    if (status === undefined) continue; // covered an id with no ADR file on disk — an orphan, not a follow-through failure
    if (TERMINAL_STATUSES.has(status)) { carried.push({ id, status }); continue; }
    violations.push({ id, status });
  }
  return {
    ok: violations.length === 0,
    today,
    violations,
    deferred,
    carried,
  };
}

export function main() {
  // `--repo` is a fixture seam only (see `guard:canaries`). The exported
  // `decisionFollowthrough(repo)` already took the root as a parameter; this is
  // the CLI handing it one, so a canary can point the gate at a throwaway
  // interview ledger and corpus. Absent the flag, unchanged.
  const repoIndex = process.argv.indexOf("--repo");
  const repo = repoIndex >= 0 && repoIndex + 1 < process.argv.length
    ? resolvePath(process.argv[repoIndex + 1])
    : REPO_ROOT;
  try {
    assertGovernanceConsumerReady({ consumer: "adr-decision-followthrough", evidenceStatus: evidenceTransactionReadStatus({ repo }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) console.log(JSON.stringify({ ok: false, code: error && typeof error === "object" && "code" in error ? error.code : "consumer_precondition", error: message }, null, 2));
    else console.error(`gate:adr-decision-followthrough — FAILED consumer precondition: ${message}`);
    return 1;
  }
  const report = decisionFollowthrough(repo);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  console.log(`gate:adr-decision-followthrough — ${report.carried.length} decided ADR(s) carried through, ${report.deferred.length} actively deferred, ${report.violations.length} owed a promotion as of ${report.today}`);
  if (report.ok) {
    console.log("PASS — every ADR a recorded interview decided has reached a terminal status (or is still within a deferral).");
    return 0;
  }
  console.log("");
  for (const v of report.violations) {
    console.log(`  FAIL  ${v.id}  is still "${v.status}" but an interview already recorded a decision about it — coverage does not clear a Proposed record.`);
  }
  console.log("");
  console.log("  A recorded decision must be carried through to the record's Status:");
  console.log("    - greenlit  → edit the ADR to `Status: Accepted` (the separate status-only accept, ADR-059/072) and commit;");
  console.log("    - redlit    → `Status: Rejected` / `Superseded` / `Retired`;");
  console.log("    - not yet   → re-ask it natively (`bun run interview:pack` → AskUserQuestion or `arbor interview`) and record a dated deferral with `bun run interview:record`.");
  return 1;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
