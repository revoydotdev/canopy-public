#!/usr/bin/env node
/**
 * scripts/interview-attestation-gate.mjs — gate:interview-attestation (ADR-158).
 *
 * WHY THIS EXISTS. `decisions/interviews.jsonl` is what silences
 * `gate:decision-queue`, and it was a plain JSONL file any agent could append
 * to. The interview skill named that weakness itself rather than hiding it:
 * "An agent can write that file. That is not a loophole to route around — it is
 * the reason this skill exists." Nothing checked it. This gate does.
 *
 * WHAT IT CHECKS. Every ledger record held after
 * `scripts/interview/baseline.json`'s date must match a receipt minted by
 * `recordInterviewAnswer`, by digest over the record's own content. A record
 * with no matching receipt was not written by the sanctioned recorder, and a
 * record whose content changed after it was recorded no longer matches the
 * receipt that attested to it. A record present in the ledger at a
 * remote-tracking ref's last FETCHED position is attested too
 * (`importedRecordDigests`): it was written in another clone and reached this
 * one through git, so this clone's lack of a receipt for it says nothing.
 *
 * WHAT IT DOES NOT CLAIM. It does not prove a human answered. It proves the
 * record came through the recorder on this machine. An agent that knows the
 * mechanism could write both halves; the point is that doing so is now a
 * deliberate, separate act against a git-internal store rather than one
 * invisible line in a file it edits all day. Detection, not prevention — and
 * the honest ceiling without a trusted third party.
 *
 * WHY IT IS NOT IN CI. The receipt store lives in the git common dir and is
 * per-clone. CI checks out a fresh clone with no receipts, and the commit
 * under test is not yet at any fetched remote position, so its own new
 * records would read as unattested and the gate would fail on a correct
 * change. That is the same `local_history_only` boundary
 * `gate:hook-liveness` and `gate:stop-guard-releases` carry, for the same
 * reason: a verdict computed where the evidence cannot exist is not a verdict.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { auditInterviewAttestation, importedRecordDigests, readInterviewReceipts, receiptStorePath } from "./lib/interview-receipts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// `--repo` is a fixture seam only (see `guard:canaries`). `readBaseline`,
// `readLedger` and `readInterviewReceipts` all already took their paths as
// parameters; this points the CLI's three call sites at a throwaway ledger and
// baseline — and, with `git_repo: true`, at the scratch repository's own git
// common dir, so the receipt store under test is that repo's and not this
// clone's. Absent the flag, unchanged.
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}
const REPO_ROOT = argValue("--repo") ? resolvePath(argValue("--repo")) : resolvePath(__dirname, "..");
const LEDGER = join(REPO_ROOT, "decisions", "interviews.jsonl");
const BASELINE = join(REPO_ROOT, "scripts", "interview", "baseline.json");

export function readBaseline(path = BASELINE) {
  if (!existsSync(path)) return { ok: false, error: `interview baseline missing: ${path}` };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const through = parsed.records_historical_through;
    if (typeof through !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(through)) {
      return { ok: false, error: "interview baseline records_historical_through must be an ISO date" };
    }
    return { ok: true, through, raw: parsed };
  } catch (error) {
    // Unreadable is a blocker, never a permissive default: defaulting either
    // grandfathers every fabrication or rejects every honest record.
    return { ok: false, error: `interview baseline is unreadable: ${String(error)}` };
  }
}

export function readLedger(path = LEDGER) {
  if (!existsSync(path)) return { ok: true, records: [], malformed: [] };
  const records = [];
  const malformed = [];
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (line.trim() === "") continue;
    try { records.push(JSON.parse(line)); } catch { malformed.push(index + 1); }
  }
  return { ok: malformed.length === 0, records, malformed };
}

function printRemedy(unattested) {
  console.error("");
  console.error("Remedy:");
  console.error("  Record interview answers through the recorder, which mints the receipt:");
  console.error("");
  console.error("    bun scripts/decision-queue.mjs --question-pack > pack.json");
  console.error("    (ask through the host's native question tool: AskUserQuestion, or `arbor interview`)");
  console.error("    bun run interview:record --pack pack.json --answers answers.json");
  console.error("");
  console.error("  Do not append to decisions/interviews.jsonl by hand. A hand-written record");
  console.error("  silences gate:decision-queue while proving nothing, which is the failure this");
  console.error("  gate exists to make visible.");
  console.error("");
  console.error("  If these records ARE genuine and predate the mechanism on this clone, the");
  console.error("  baseline date in scripts/interview/baseline.json is wrong here. It may only");
  console.error("  move EARLIER; moving it later would grandfather a fabrication.");
  void unattested;
}

export function main(argv = process.argv.slice(2)) {
  const jsonOut = argv.includes("--json");
  const baseline = readBaseline();
  if (!baseline.ok) {
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: baseline.error }, null, 2));
    else console.error(`gate:interview-attestation — ${baseline.error}`);
    return 1;
  }
  const ledger = readLedger();
  if (!ledger.ok) {
    const detail = `decisions/interviews.jsonl has ${ledger.malformed.length} unparseable line(s): ${ledger.malformed.join(", ")}`;
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
    else console.error(`gate:interview-attestation — ${detail}`);
    return 1;
  }
  const store = readInterviewReceipts(REPO_ROOT);
  if (!store.ok) {
    const detail = `receipt store has ${store.malformed.length} unparseable line(s): ${store.malformed.join(", ")}`;
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
    else console.error(`gate:interview-attestation — ${detail}`);
    return 1;
  }

  const imported = importedRecordDigests(REPO_ROOT);
  const result = auditInterviewAttestation({
    records: ledger.records, receipts: store.receipts, baselineThrough: baseline.through, imported: imported.digests,
  });

  if (jsonOut) {
    console.log(JSON.stringify({
      ...result, receipt_store: receiptStorePath(REPO_ROOT), baseline: baseline.through,
      imported_from: imported.refs.map(({ ref, commit }) => `${ref}@${commit.slice(0, 12)}`),
    }, null, 2));
    return result.ok ? 0 : 1;
  }

  const { summary } = result;
  console.log(
    `gate:interview-attestation — ${summary.total} record(s): ${summary.historical} historical ` +
      `(on or before ${baseline.through}), ${summary.attested} attested, ${summary.imported} imported ` +
      `(fetched from ${imported.refs.length} remote ref position(s)), ${summary.unattested} unattested.`,
  );
  console.log("  Proves the record came through the recorder on this machine, not that a human answered.");

  if (!result.ok) {
    console.error("");
    console.error(`gate:interview-attestation — ${summary.unattested} interview record(s) match no receipt:`);
    for (const item of result.unattested.slice(0, 8)) {
      console.error(`    line ${item.line}  held_at=${item.held_at ?? "(none)"}  covered=[${item.covered.join(", ")}]`);
      console.error(`      ${item.reason}`);
    }
    printRemedy(result.unattested);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
