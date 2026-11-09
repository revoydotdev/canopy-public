#!/usr/bin/env node
/**
 * scripts/stop-guard-releases-gate.mjs — ADR-154: the breaker's own journal is
 * evidence, and something reads it.
 *
 * WHY THIS EXISTS. The native stop guard appends one line to
 * `releases.jsonl` every time it releases a blocked Stop. That journal is the
 * only record of how often the end condition is being walked past, and until
 * this gate existed nothing read it. It sat in the gitignored git common dir,
 * unaggregated, ungated. The numbers it held were not small: 76 releases, 40
 * of them on a single day, one session reaching a consecutive count of 43.
 * A ceiling reached forty times in a day is not a circuit breaker, it is the
 * door, and nobody could see it.
 *
 * WHAT BLOCKS, AND WHY ONLY THAT. Exactly one condition fails this gate: a
 * release record dated after the baseline that names no blocking gate and no
 * advisory gate. After ADR-154 that is structurally impossible — an unnameable
 * failure is handled before any state is written and records nothing — so a
 * post-baseline instance means the guard regressed. That is a real, mechanical
 * regression signal.
 *
 * The release RATE is deliberately reported and never blocked. Most releases
 * are genuine: a session met a red gate it had no authority to clear, which is
 * the case the breaker was built for. Failing a gate on that would punish the
 * session for the repository's state and produce exactly the bypass ADR-074
 * warns about. The rate is a governance signal for an operator to act on, not
 * a merge predicate.
 *
 * WHY THE BASELINE IS A TIMESTAMP AND NOT A COUNT. The 31 historical
 * empty-set records are the evidence that the defect was real. Pruning them to
 * satisfy a count would destroy that evidence; dating them lets the journal
 * stay append-only and intact while the gate still fails closed on anything
 * new. `scripts/stop-guard/baseline.json` may move the instant EARLIER as
 * history is genuinely pruned, never later.
 *
 * WHY IT IS NOT IN CI. The journal lives in the git common dir and is
 * gitignored, so it is per-machine and per-clone. A CI runner has no journal;
 * this gate there would read an empty file and print a clean result forever —
 * a check that cannot fail, reported as a check that passed. Its profile entry
 * records that as `local_history_only`, the same reason `gate:hook-liveness`
 * carries.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { releasesPath, resolveStateDir } from "./lib/stop-guard-state.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = resolvePath(REPO_ROOT, "scripts", "stop-guard", "baseline.json");

/** Trailing window, in days, that the reported release rate covers. */
export const REPORT_WINDOW_DAYS = 7;

export function readBaseline(path = BASELINE_PATH) {
  if (!existsSync(path)) {
    return { ok: false, error: `stop-guard baseline missing: ${path}` };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const through = Date.parse(parsed.empty_release_records_historical_through);
    if (!Number.isFinite(through)) {
      return { ok: false, error: "baseline empty_release_records_historical_through is not a parseable instant" };
    }
    return { ok: true, through, raw: parsed };
  } catch (error) {
    // An unreadable baseline is a blocker, never an empty default: defaulting
    // would silently relabel every historical record as a regression, or every
    // regression as history, depending on which way the default fell.
    return { ok: false, error: `stop-guard baseline is unreadable: ${String(error)}` };
  }
}

/** Parse the append-only journal. A malformed line is reported, never skipped. */
export function readReleases(journalPath) {
  if (!existsSync(journalPath)) return { ok: true, records: [], present: false };
  const records = [];
  const malformed = [];
  const text = readFileSync(journalPath, "utf-8");
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed.push(index + 1);
    }
  }
  return { ok: malformed.length === 0, records, present: true, malformed };
}

function isEmptySet(record) {
  return (record?.blocking_gates ?? []).length === 0 && (record?.advisory_red_gates ?? []).length === 0;
}

/**
 * The whole verdict as a pure function of the journal and the baseline, so the
 * blocking condition can be proven without a real breaker having ever run.
 */
export function auditReleases({ records, baselineThrough, now = Date.now(), windowDays = REPORT_WINDOW_DAYS }) {
  const problems = [];
  const regressions = [];
  for (const record of records) {
    if (!isEmptySet(record)) continue;
    const at = Date.parse(record.released_at);
    // An undated record cannot be placed relative to the baseline. Treat it as
    // a regression rather than as history: the safe direction is to report a
    // record we cannot vouch for, not to wave it through.
    if (!Number.isFinite(at) || at > baselineThrough) regressions.push(record);
  }
  if (regressions.length > 0) {
    problems.push(
      `${regressions.length} release record(s) after the baseline named no red gate at all. ` +
        "Under ADR-154 the breaker records nothing for an unnameable battery failure, so this " +
        "means the native stop guard has regressed.",
    );
  }

  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = records.filter((record) => {
    const at = Date.parse(record.released_at);
    return Number.isFinite(at) && at >= cutoff;
  });
  const byFingerprint = new Map();
  for (const record of records) {
    const key = record.fingerprint ?? "unknown";
    byFingerprint.set(key, (byFingerprint.get(key) ?? 0) + 1);
  }
  const consecutiveCounts = records
    .map((record) => record.consecutive_count)
    .filter((value) => Number.isFinite(value));

  return {
    ok: problems.length === 0,
    problems,
    regressions,
    summary: {
      total_releases: records.length,
      releases_in_window: inWindow.length,
      window_days: windowDays,
      max_consecutive_count: consecutiveCounts.length > 0 ? Math.max(...consecutiveCounts) : 0,
      distinct_fingerprints: byFingerprint.size,
      top_fingerprints: [...byFingerprint.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 5)
        .map(([fingerprint, count]) => ({ fingerprint: fingerprint.slice(0, 12), count })),
      historical_empty_releases: records.filter(isEmptySet).length - regressions.length,
    },
  };
}

function printRemedy() {
  console.error("");
  console.error("Remedy:");
  console.error("  A post-baseline release naming no gate means the breaker released on a battery");
  console.error("  that checked nothing. Confirm the native stop guard still handles the");
  console.error("  unnameable class before it reads or writes state:");
  console.error("");
  console.error("    bun run test -- packages/arbor-mcp/tests/hooks/stop-battery.test.ts");
  console.error("");
  console.error("  If the guard is intact and these records predate it, the baseline instant in");
  console.error("  scripts/stop-guard/baseline.json is wrong for this clone. It may only move");
  console.error("  EARLIER; moving it later would relabel a real regression as history.");
}

function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}

export function main(argv = process.argv.slice(2)) {
  const jsonOut = argv.includes("--json");
  // `--root` selects which tree's baseline is read and `--journal` which
  // release journal is audited; both are inert when absent, and both only
  // relocate INPUT. The verdict is still `auditReleases`' own return value.
  const repoRoot = resolvePath(argumentValue(argv, "--root") ?? REPO_ROOT);
  const baseline = readBaseline(resolvePath(repoRoot, "scripts", "stop-guard", "baseline.json"));
  if (!baseline.ok) {
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: baseline.error }, null, 2));
    else console.error(`gate:stop-guard-releases — ${baseline.error}`);
    return 1;
  }

  const journalPath = resolvePath(argumentValue(argv, "--journal") ?? releasesPath(resolveStateDir(repoRoot)));
  const journal = readReleases(journalPath);
  if (!journal.ok) {
    const detail = `releases.jsonl has ${journal.malformed.length} unparseable line(s): ${journal.malformed.join(", ")}`;
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
    else console.error(`gate:stop-guard-releases — ${detail}`);
    return 1;
  }

  const result = auditReleases({ records: journal.records, baselineThrough: baseline.through });

  if (jsonOut) {
    console.log(JSON.stringify({ ...result, journal: journalPath, journal_present: journal.present }, null, 2));
    return result.ok ? 0 : 1;
  }

  if (!journal.present) {
    console.log("gate:stop-guard-releases — no release journal on this clone yet (nothing to audit).");
    return 0;
  }

  const { summary } = result;
  console.log(
    `gate:stop-guard-releases — ${summary.total_releases} release(s) total, ` +
      `${summary.releases_in_window} in the last ${summary.window_days} day(s), ` +
      `max consecutive count ${summary.max_consecutive_count}, ` +
      `${summary.distinct_fingerprints} distinct fingerprint(s).`,
  );
  for (const { fingerprint, count } of summary.top_fingerprints) {
    console.log(`    ${fingerprint}  x${count}`);
  }
  console.log(
    "  Reported, not gated: a release means a session met a red gate it had no authority to",
  );
  console.log(
    "  clear. A high or rising rate is a governance signal for an operator, not a merge blocker.",
  );

  if (!result.ok) {
    for (const problem of result.problems) console.error(`gate:stop-guard-releases — ${problem}`);
    for (const record of result.regressions.slice(0, 5)) {
      console.error(`    ${record.released_at} session=${record.session_id} count=${record.consecutive_count}`);
    }
    printRemedy();
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
