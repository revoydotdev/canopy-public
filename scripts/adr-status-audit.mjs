#!/usr/bin/env node
/**
 * scripts/adr-status-audit.mjs — the status truth audit (gate:adr-status).
 *
 * WHY THIS EXISTS. Measured on 2026-08-15: 44 of 74 ADRs (030-073) have sat
 * `Proposed` since 2026-08-06 while describing shipped, gated, tested
 * behavior. Acceptance is a human verdict this repository requires as a
 * separate, deliberate act (a status-only commit, per the pre-commit rule,
 * with a proof triple per the `claim-guard` PreToolUse hook) — but nothing
 * ever pointed out WHICH records were overdue for that act. This script
 * derives the disagreement between a record's declared status and observable
 * reality, per record, with the specific evidence, so a human can act on it.
 * It is a detector, never an actor: it NEVER writes to a decision file and
 * NEVER flips a status, because acceptance is exactly the kind of claim this
 * repository's whole ADR-CLAIM effort exists to keep human-verdict-gated.
 *
 * REUSE, NOT REINVENTION. The `<!-- proof: symbol=… file=… roundtrip=… -->`
 * grammar and its resolution against the real working tree already exist in
 * `@arbor/governance` (`packages/arbor-governance/src/obligation/{parse,proof,
 * coverage,report}.ts`), consumed today by `scripts/obligations-gate.ts` and
 * `scripts/claim-ledger.ts`. This script calls the same
 * `buildObligationCoverageReport` rather than writing a second parser for the
 * same comment grammar — a second parser is exactly the kind of duplicated
 * knowledge that drifted the marker vocabulary in `claim-ledger.ts`'s own
 * incident log (ROADMAP.md's unvalidated `🟢`).
 *
 * WHAT "SUSPECT" MEANS HERE, PRECISELY. A record is `status_suspect` when its
 * declared status is NOT `Accepted` (i.e. `Proposed`, `Draft`, or anything
 * else) AND it has at least one obligation with a proof that FULLY RESOLVES —
 * meaning a cited symbol/file exists and a cited roundtrip test exists and is
 * collected by vitest. That is real, checkable evidence that implementation
 * and verification exist for at least part of what the record claims, while
 * the record itself still asserts "not yet decided". A record with zero
 * obligations, or obligations whose proofs do not resolve, is left
 * `status_consistent`: this script must never punish a record for being
 * honestly unimplemented, and must never flag a record on the strength of
 * commit-touch noise alone (see the `commits_since_authored` field below).
 *
 * WHY `commits_since_authored` IS REPORTED BUT NEVER A TRIGGER. The manifest
 * (B-3) asks whether an ADR's subject matter has been touched by commits
 * since it was authored, as one of three evidence dimensions. This script
 * computes it for the ADR's OWN file (edits to the record itself — the file
 * is the only truthful boundary available to this script; deriving which
 * OTHER files are "this ADR's subject matter" without a declared file list is
 * exactly `scripts/adr-trace.mjs`'s job, owned by a different workstream, and
 * duplicating its derivation here would be the same drift `claim-ledger.ts`
 * warns against). A file being edited proves only that someone touched it —
 * a typo fix, a status flip, a reformat — and using that alone as a suspicion
 * trigger would manufacture false positives on every routine copyedit. It is
 * included in the report as corroborating context for a human, never as a
 * classification input.
 *
 * WHY THIS GATE NOW FAILS ON A SUSPECT RECORD. It was written as a
 * report-only gate (always exit 0) because 44 known-suspect records already
 * existed and blocking on them would have failed every push on untriaged
 * legacy debt. That reasoning set a floor without saying so: the gate
 * reported the same PASS for a clean corpus and for a corpus where every
 * record's status lies, so `bun run guard:canaries` measured it UNPROVEN —
 * it passed a fixture it declares it must reject. The operator's decision
 * (arboretum-coordination-plane plan, todo 5) is that it either fails on its
 * failure paths or is re-declared advisory, not both, and the first branch
 * was taken. So `ok` is now `suspect.length === 0` and the exit code follows
 * it, exactly as `scripts/adr-citations.mjs` derives its `ok` from
 * `UNRESOLVABLE_CITATIONS_FLOOR`.
 *
 * WHICH FINDINGS DRIVE THE EXIT CODE. Only `status_suspect` does — that is
 * the one real violation this audit can derive (a declared status
 * contradicted by its own resolving proof). `commits_since_authored` and the
 * "would-be floor" figure below are ADVISORY context for a human, exactly
 * like `adr-citations.mjs`'s "Line-number citations (advisory ratchet, not
 * blocking)" line: they are printed, and they never reach the exit code. No
 * floor is declared here on purpose; a floor is the plan's Must-NOT.
 *
 * WHAT THIS COSTS RIGHT NOW. On the live corpus this gate is RED: the
 * suspect records are real records whose status is stale, and each one is a
 * separate human-acceptance act this repository deliberately does not
 * automate. It runs only in the `ci` execution context, so it does not
 * block `stop`, `precommit`, `prepush`, or `trunk_submit` locally.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { buildObligationCoverageReport } from "@arbor/governance";

const __dirname = dirname(fileURLToPath(import.meta.url));

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}
const REPO_ROOT = resolvePath(argValue("--repo") ?? resolvePath(__dirname, ".."));
const jsonMode = process.argv.includes("--json");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

const STATUS_LINE_RE = /^\*\*Status:\*\*\s*(.+)$/m;

function leadingWord(value) {
  return value.trim().toLowerCase().split(/[\s(]/)[0] ?? "";
}

/**
 * Commit count touching this exact file, split into before/after the file's
 * first commit ("authored"), and the authored date itself. `--follow` so a
 * rename (Proposed -> numbered allocation) does not break the trail. Returns
 * nulls when git has no history for the file at all (never happens for a
 * tracked file, but this must not throw on a fixture missing history).
 */
function fileHistory(repoRelativePath) {
  const log = git(["log", "--follow", "--format=%H %ad", "--date=short", "--", repoRelativePath]);
  if (!log) return { authored_at: null, commits_total: 0, commits_since_authored: 0 };
  const rows = log.split("\n").filter(Boolean);
  const commits_total = rows.length;
  // git log lists newest-first; the authoring commit is the last row.
  const authored_at = rows[rows.length - 1]?.split(" ")[1] ?? null;
  return { authored_at, commits_total, commits_since_authored: Math.max(0, commits_total - 1) };
}

/**
 * Derives the ADR number + slug from a `revoy2:ADR-NNN` record id, since the
 * governance package's ids are namespaced for cross-repo use but this
 * script's output is repo-local.
 */
function adrNumberFromRecordId(recordId) {
  const match = /ADR-(\d+)/.exec(recordId);
  return match ? Number(match[1]) : null;
}

function classify({ declaredStatus, obligationCount, obligationsWithResolvingProof }) {
  if (!declaredStatus) {
    return { classification: "status_consistent", reason: "no **Status:** line found — nothing to compare against reality" };
  }
  const leading = leadingWord(declaredStatus);
  if (leading === "accepted") {
    return { classification: "status_consistent", reason: `declared "${declaredStatus}"; acceptance is out of this audit's scope (see obligations-gate.ts's POL-04 for accepted-but-unwitnessed records)` };
  }
  // `superseded` is reachable only from `accepted` (record/status.ts): the
  // record WAS decided, and the work its proofs resolve to is expected to
  // exist. It is not "undecided", so a resolving proof contradicts nothing.
  // `rejected` stays in scope — it is reachable only from draft/proposed, so
  // resolving work under a rejected record is exactly the drift this flags.
  if (leading === "superseded") {
    return { classification: "status_consistent", reason: `declared "${declaredStatus}"; a superseded record was accepted before it was retired, so resolving proofs are expected` };
  }
  if (obligationCount > 0 && obligationsWithResolvingProof > 0) {
    return {
      classification: "status_suspect",
      reason: `declared "${declaredStatus}" but ${obligationsWithResolvingProof}/${obligationCount} obligation(s) have a resolving proof — a real, collected test exists for work this record still calls undecided`,
    };
  }
  return {
    classification: "status_consistent",
    reason: obligationCount === 0
      ? `declared "${declaredStatus}" and declares zero obligations — nothing yet exists to contradict it`
      : `declared "${declaredStatus}" and 0/${obligationCount} obligation(s) have a resolving proof — nothing yet exists to contradict it`,
  };
}

function main() {
  const at = new Date().toISOString();
  const report = buildObligationCoverageReport({ repoRoot: REPO_ROOT, at });
  if (!report.ok) {
    console.error(`adr-status-audit — FAILED to build obligation coverage report: ${report.error.message}`);
    process.exit(0); // report-only: a plumbing failure here must not block a push either
    return;
  }

  const rows = [];
  for (const record of report.value.records) {
    const number = adrNumberFromRecordId(record.record_id);
    const absPath = resolvePath(REPO_ROOT, record.source_path);
    let text = "";
    try {
      text = readFileSync(absPath, "utf-8");
    } catch {
      continue; // record's own source vanished mid-scan; skip rather than fabricate
    }
    const statusMatch = STATUS_LINE_RE.exec(text);
    const declaredStatus = statusMatch ? statusMatch[1].trim() : null;
    const history = fileHistory(record.source_path);
    const { classification, reason } = classify({
      declaredStatus,
      obligationCount: record.obligation_count,
      obligationsWithResolvingProof: record.obligations_with_resolving_proof,
    });
    rows.push({
      adr: number,
      record_id: record.record_id,
      source_path: record.source_path,
      declared_status: declaredStatus,
      obligation_count: record.obligation_count,
      obligations_with_resolving_proof: record.obligations_with_resolving_proof,
      authored_at: history.authored_at,
      commits_since_authored: history.commits_since_authored,
      classification,
      reason,
    });
  }
  rows.sort((a, b) => (a.adr ?? 0) - (b.adr ?? 0));

  const suspect = rows.filter((row) => row.classification === "status_suspect");
  // The one real violation this audit derives. No floor: see module header.
  const overFloor = suspect.length > 0;
  const outcome = {
    ok: !overFloor,
    blocking: true,
    checked: rows.length,
    suspect_count: suspect.length,
    overFloor,
    records: rows,
  };

  if (jsonMode) {
    console.log(JSON.stringify(outcome, null, 2));
    process.exitCode = outcome.ok ? 0 : 1;
    return;
  }

  console.log(`adr-status-audit — ${rows.length} record(s) checked, ${suspect.length} status_suspect`);
  // See scripts/guard-canaries.mjs: a gate that reports how much it observed
  // lets the profile turn an empty corpus into `unresolved`, not `passed`.
  console.log(`observed_count: ${rows.length}`);
  console.log("  Reports the declared-status-vs-reality disagreement; never writes a status, never accepts an ADR.");
  console.log(`  Current suspect count (no floor declared — every suspect record is a violation): ${suspect.length}`);
  if (suspect.length > 0) {
    console.log("");
    for (const row of suspect) {
      console.log(`  [status_suspect] ADR-${String(row.adr).padStart(3, "0")} (${row.source_path})`);
      console.log(`      ${row.reason}`);
      console.log(`      Remedy: either accept this record (status-only commit with a proof triple per the pre-commit rule) or remove the resolving proof from ${row.source_path} if the work it claims does not exist.`);
    }
    console.log(`\nFAIL — ${suspect.length} record(s) declare a non-Accepted status while carrying a resolving proof.`);
  }
  console.log(outcome.ok ? "\nPASS" : "\nFAIL");
  process.exitCode = outcome.ok ? 0 : 1;
}

main();
