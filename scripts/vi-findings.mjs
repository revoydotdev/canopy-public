#!/usr/bin/env node
/**
 * scripts/vi-findings.mjs — ADR-042 Half B: findings triage obligation.
 * Mirrors completion-depth.mjs's structure (gate + refresh modes) applied to
 * `.visual-intelligence/findings/findings.jsonl` instead of a self-owned
 * store.
 *
 *   bun scripts/vi-findings.mjs                    gate (bun run gate:vi-findings)
 *   bun scripts/vi-findings.mjs --explain           gate, plus the full strength/convergence rationale
 *   bun scripts/vi-findings.mjs --rewrite-ids       stabilize findings + rekey matching triage ids in place
 *   bun scripts/vi-findings.mjs --triage <id> --verdict <v> --reason "..." [--expires <ISO>]
 *   bun scripts/vi-findings.mjs --prune-orphans     remove triage rows whose finding id no
 *                                                    longer exists in findings.jsonl (B2 — a
 *                                                    deliberate, explicit act; gate only REPORTS
 *                                                    the orphan count, never prunes itself)
 *   ... --json  (gate mode only)
 *
 * THE PROBLEM THIS CLOSES. The vendored validator (vi-validate.mjs) writes
 * sequential ids (VI-0001) that are not stable across refreshes, and nothing
 * ever consumes findings/findings.jsonl — 42 findings emitted into silence,
 * exactly the unwitnessed_claim shape ADR-033 governs, produced by the tool
 * whose job is detecting that shape. This gives every finding a stable,
 * content-addressed identity (--rewrite-ids, via vi-finding-id.mjs — the ONE
 * authoritative id function, shared with vi-observed-compare.mjs so findings
 * born there never need rewriting) and a mandatory disposition (the gate
 * below), the same convention completion-depth.mjs already established for
 * its own store.
 *
 * WHAT A VERDICT DOES NOT MEAN. Recording `false_positive` or
 * `accepted_tradeoff` closes the GATE, not the underlying question. See the
 * gate's own PASS output.
 *
 * STABLE SUBJECT IDENTITY. A finding id identifies the detector's QUESTION
 * (category + normalized subject title), not the particular set of symbols
 * reported on one refresh. Including `affected_nodes` in the id made an
 * ordinary graph update create a replacement finding and strand the prior
 * human verdict as an orphan. `--rewrite-ids` therefore rekeys a triage row
 * when it can prove the row belongs to a rewritten finding, preserving that
 * row's complete evidence. Any conflicting rekey is refused: this mechanism
 * never guesses between two human decisions.
 *
 * SYMBOL-SET CARRY-FORWARD. A verdict is triaged for a finding's symbols
 * (`affected_nodes`), not for its content hash. The content hash also
 * captures cosmetic prose (record counts, catalog hashes, evidence text) —
 * graph or observation-catalog churn moves it constantly even when the
 * finding is about exactly the same symbols, and in one session that turned
 * 7 pending decisions into 70, twice, with nothing about the code changing.
 * So the reopen rule is narrower than "content changed": a triage row now
 * also records the finding's normalized symbol set (`affected_nodes`,
 * deduped and sorted so emission order never matters) at triage time. When
 * the gate finds a content-hash mismatch, it checks that recorded set
 * against the finding's CURRENT symbol set first:
 *   - same symbol set  -> the verdict CARRIES FORWARD. Not a violation, but
 *     never silent: the gate reports every carry explicitly, by finding id,
 *     so a reader can see drift happened even though no decision is owed.
 *   - different symbol set (a symbol entered or left) -> REOPENED. The
 *     verdict's subject changed, so it no longer speaks to the finding as it
 *     now stands.
 * This is deliberately narrower than "carry forward if nothing important
 * changed" — the operator declined that. Only the symbol set is a released
 * shield; every other kind of drift still reopens.
 *
 * BACKWARD COMPATIBILITY. Rows written before this change carry no
 * `symbol_set` field. Such a row falls back to today's hash-only behavior on
 * a mismatch (REOPENED) — it is never carried forward, because no human ever
 * captured which symbols the row was actually triaged against. Re-triage a
 * legacy row (`--triage`) once to opt it into carry-forward eligibility.
 *
 * EXPIRY IS NEVER EXTENDED BY A CARRY. Carrying a verdict forward is a
 * read-only computation the gate performs on every run — it never rewrites
 * `triage.jsonl` — so `triage_expires` keeps the deadline set at the last
 * real `--triage` call. The human re-examination schedule is untouched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findingContentHash, findingContentHashV1, stableFindingId } from "./vi-finding-id.mjs";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const REPO_ROOT = resolve(argValue("--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
/** Overridable so gate-failure-modes.test.mjs can build isolated fixture stores. */
const FINDINGS_DIR = process.env.REVOY2_VI_FINDINGS_DIR
  ? resolve(process.env.REVOY2_VI_FINDINGS_DIR)
  : join(REPO_ROOT, ".visual-intelligence", "findings");
const FINDINGS_PATH = join(FINDINGS_DIR, "findings.jsonl");
const TRIAGE_PATH = join(FINDINGS_DIR, "triage.jsonl");

const argv = process.argv.slice(2);
const REWRITE = argv.includes("--rewrite-ids");
const PRUNE_ORPHANS = argv.includes("--prune-orphans");
const REHASH = argv.includes("--rehash");
const JSON_OUT = argv.includes("--json");
const EXPLAIN = argv.includes("--explain");
const TRIAGE_INDEX = argv.indexOf("--triage");

const VALID_VERDICTS = new Set(["false_positive", "accepted_tradeoff", "fixed", "superseded"]);
const TRIAGE_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

function git(args) {
  try { return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim(); } catch { return "unknown"; }
}

function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * The finding's affected symbols, deduped and sorted — order of emission
 * must never affect whether two symbol sets compare equal.
 */
function normalizedSymbolSet(finding) {
  return [...new Set(finding.affected_nodes ?? [])].sort();
}

function sameSymbolSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Match a historical human verdict only where its identity is already proven.
 * A current id is authoritative. Otherwise, the recorded normalized symbol
 * set must identify exactly one current finding. In particular, several empty
 * sets are an ambiguity, never permission to apply one verdict to all of them.
 */
function triageRowMatch(row, findings) {
  const direct = findings.find((finding) => finding.id === row.finding_id);
  if (direct) return { kind: "direct", finding: direct };
  if (!Array.isArray(row.symbol_set)) return { kind: "orphan" };
  const recorded = normalizedSymbolSet({ affected_nodes: row.symbol_set });
  const candidates = findings.filter((finding) => sameSymbolSet(recorded, normalizedSymbolSet(finding)));
  if (candidates.length === 1) return { kind: "unique", finding: candidates[0] };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "orphan" };
}

function symbolSetDiff(recorded, current) {
  const recordedSet = new Set(recorded);
  const currentSet = new Set(current);
  return {
    added: current.filter((s) => !recordedSet.has(s)),
    removed: recorded.filter((s) => !currentSet.has(s)),
  };
}

/**
 * Directory-parameterized readers, so a caller with its own repo path (a
 * discharge predicate re-evaluating the gate for one finding against a
 * possibly-different checkout, or a fixture in a test) never has to go
 * through this module's own FINDINGS_DIR/env-var resolution to get the same
 * read behavior the CLI gate uses.
 */
export function readFindingsFromDir(findingsDir) {
  const path = join(findingsDir, "findings.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

export function readTriageFromDir(findingsDir) {
  const map = new Map();
  const path = join(findingsDir, "triage.jsonl");
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); map.set(row.finding_id, row); } catch { /* skip malformed line */ }
  }
  return map;
}

function readFindings() {
  return readFindingsFromDir(FINDINGS_DIR);
}

function writeFindings(findings) {
  mkdirSync(FINDINGS_DIR, { recursive: true });
  writeFileSync(FINDINGS_PATH, findings.length ? `${findings.map((f) => JSON.stringify(f)).join("\n")}\n` : "", "utf8");
}

function readTriage() {
  return readTriageFromDir(FINDINGS_DIR);
}

function writeTriage(map) {
  mkdirSync(FINDINGS_DIR, { recursive: true });
  const rows = [...map.values()].sort((a, b) => (a.finding_id < b.finding_id ? -1 : 1));
  writeFileSync(TRIAGE_PATH, rows.length ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n` : "", "utf8");
}

// ---------------------------------------------------------------------------
// --rewrite-ids
// ---------------------------------------------------------------------------

function rewriteIds() {
  const findings = readFindings();
  const rewritten = findings.map((f) => ({ ...f, id: stableFindingId(f) }));

  const seen = new Map();
  for (const f of rewritten) {
    const prior = seen.get(f.id);
    if (prior) {
      throw new Error(
        `vi-findings --rewrite-ids: id collision '${f.id}' between findings titled ` +
        `'${prior.title}' and '${f.title}' — two distinct findings must not share a stable id`,
      );
    }
    seen.set(f.id, f);
  }

  // Rekey a human verdict only with a complete chain of identity evidence:
  // either its source id is present in this snapshot (the original id
  // migration), or its persisted symbol set identifies exactly one current
  // finding. That latter global uniqueness is stricter than category + set:
  // it proves there is no target in ANY category. An addition, removal, or
  // multiple target findings never becomes a guess.
  const triage = readTriage();
  const migratedTriage = new Map();
  let triageRekeyed = 0;
  let ambiguousRows = 0;
  const oldToNew = [];
  const currentByOldId = new Map(findings.map((finding, index) => [finding.id, rewritten[index]]));
  for (const [oldId, row] of triage) {
    const source = currentByOldId.get(oldId);
    const match = source ? { kind: "direct", finding: source } : triageRowMatch(row, rewritten);
    if (match.kind === "ambiguous") {
      ambiguousRows += 1;
      migratedTriage.set(oldId, row);
      continue;
    }
    if (match.kind === "orphan") {
      migratedTriage.set(oldId, row);
      continue;
    }
    const newId = match.finding.id;
    const existing = migratedTriage.get(newId);
    if (existing && existing.finding_id !== oldId) {
      throw new Error(
        `vi-findings --rewrite-ids: triage rekey collision at '${newId}' from '${oldId}' and '${existing.finding_id}' — refusing to merge human verdicts`,
      );
    }
    if (oldId === newId) {
      migratedTriage.set(oldId, row);
      continue;
    }
    migratedTriage.set(newId, {
      ...row,
      finding_id: newId,
      prior_finding_ids: [...new Set([...(row.prior_finding_ids ?? []), oldId])].sort(),
    });
    triageRekeyed += 1;
    oldToNew.push([oldId, newId]);
  }

  writeFindings(rewritten);
  if (triageRekeyed > 0) writeTriage(migratedTriage);
  const changed = findings.filter((f, i) => f.id !== rewritten[i].id).length;
  console.log(`vi-findings --rewrite-ids — ${rewritten.length} finding(s), ${changed} id(s) changed, ${triageRekeyed} triage row(s) rekeyed`);
  for (const [oldId, newId] of oldToNew) console.log(`  ${oldId} -> ${newId}`);
  if (ambiguousRows > 0) {
    console.log(`  ${ambiguousRows} triage row(s) retained: their symbol set matches multiple current findings (human review required)`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// --triage
// ---------------------------------------------------------------------------

function triageOne() {
  const findingId = argv[TRIAGE_INDEX + 1];
  const verdict = flagValue("--verdict");
  const reason = flagValue("--reason");
  const expiresOverride = flagValue("--expires");
  if (!findingId || !verdict || !reason) {
    console.error("Usage: vi-findings.mjs --triage <finding_id> --verdict <false_positive|accepted_tradeoff|fixed|superseded> --reason \"...\" [--expires <ISO date>]");
    return 2;
  }
  if (!VALID_VERDICTS.has(verdict)) {
    console.error(`vi-findings --triage: invalid verdict '${verdict}' — must be one of ${[...VALID_VERDICTS].join(", ")}`);
    return 2;
  }
  const findings = readFindings();
  const finding = findings.find((f) => f.id === findingId);
  if (!finding) {
    console.error(`vi-findings --triage: no finding with id '${findingId}' in ${FINDINGS_PATH}`);
    return 2;
  }
  const triage = readTriage();
  const prior = triage.get(findingId);
  const today = new Date().toISOString().slice(0, 10);
  const rev = git(["rev-parse", "HEAD"]);
  const row = {
    finding_id: findingId,
    verdict,
    reason,
    first_seen: prior?.first_seen || rev,
    first_seen_date: prior?.first_seen_date || today,
    triage_expires: expiresOverride || prior?.triage_expires || new Date(Date.parse(prior?.first_seen_date || today) + TRIAGE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10),
    content_hash: findingContentHash(finding),
    symbol_set: normalizedSymbolSet(finding),
  };
  triage.set(findingId, row);
  writeTriage(triage);
  console.log(`vi-findings --triage — ${findingId}: ${verdict} (expires ${row.triage_expires})`);
  return 0;
}

// ---------------------------------------------------------------------------
// --prune-orphans
// ---------------------------------------------------------------------------

/**
 * Historical rows can remain after a finding genuinely disappears. Finding
 * ids no longer rotate on an `affected_nodes` change; `--rewrite-ids` also
 * rekeys a historical row when its exact normalized symbol set identifies one
 * current finding. This explicit operation is limited to rows with no possible
 * current match, rather than routine graph churn or an ambiguity a person must
 * resolve.
 *
 * Deliberately a separate, explicit act from `gate()` (which only REPORTS
 * the orphan count — see below): deletion and detection are different
 * authorities here, and a triage row records a human decision, so removing
 * one must never happen as a side effect of a routine gate run.
 */
/**
 * One-time migration for the count-normalization change, and deliberately
 * NOT a way to clear reopened verdicts in general.
 *
 * When the content-hash formula changed, every stored digest went stale at
 * once. From the stored value alone, "the formula moved" is indistinguishable
 * from "this finding's substance moved" — and rewriting both kinds would
 * silently carry a verdict forward over a body no human re-read, fabricating
 * exactly the decision this gate exists to prove.
 *
 * So a row is migrated only when it is PROVABLE that nothing but the formula
 * changed: the recorded digest must equal V1 of the finding's CURRENT body.
 * Anything else is left reopened, for a person.
 */
function rehashTriage() {
  const findings = new Map(readFindings().map((f) => [f.id, f]));
  const triage = readTriage();
  let migrated = 0;
  let genuinelyChanged = 0;
  let untouched = 0;
  for (const [id, row] of triage) {
    const finding = findings.get(id);
    if (!finding) { untouched += 1; continue; } // orphan — --prune-orphans owns that
    const current = findingContentHash(finding);
    if (row.content_hash === current) { untouched += 1; continue; }
    if (row.content_hash === findingContentHashV1(finding)) {
      triage.set(id, { ...row, content_hash: current });
      migrated += 1;
    } else {
      genuinelyChanged += 1;
    }
  }
  if (migrated > 0) writeTriage(triage);
  console.log(`vi-findings --rehash — ${migrated} row(s) migrated to the current formula`);
  console.log(`  ${genuinelyChanged} row(s) left REOPENED: their finding's substance changed, not just the formula`);
  console.log(`  ${untouched} row(s) already current or orphaned`);
  if (genuinelyChanged > 0) {
    console.log("");
    console.log("  The reopened rows are a real decision, not a migration artifact — re-triage them.");
  }
  return 0;
}

function pruneOrphans() {
  const findings = readFindings();
  const triage = readTriage();
  const before = triage.size;
  const orphanIds = [...triage.values()]
    .filter((row) => triageRowMatch(row, findings).kind === "orphan")
    .map((row) => row.finding_id);
  for (const id of orphanIds) triage.delete(id);
  writeTriage(triage);
  console.log(`vi-findings --prune-orphans — removed ${orphanIds.length} orphaned triage row(s) (${before} -> ${triage.size})`);
  return 0;
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

/**
 * The gate's per-finding decision, factored out so any other module that
 * needs to know "does THIS finding, as it stands right now, still need a
 * human triage decision" can ask the gate itself rather than re-deriving a
 * divergent copy of this rule. `discharge-catalog.mjs`'s `vi_triage.fix`
 * predicate is exactly such a caller: an interview answer of "fix" must
 * discharge when the gate itself would no longer flag the finding, not when
 * some narrower, separately-invented condition happens to hold.
 *
 * Returns `{ status: "violation", reason } | { status: "carried_forward",
 * symbolCount } | { status: "ok" }` — the same three outcomes `gate()`'s loop
 * body always computed, just returned instead of pushed onto module-local
 * arrays.
 */
export function evaluateFindingTriage(finding, row, today) {
  if (!row) return { status: "violation", reason: "untriaged — no disposition recorded" };
  if (!VALID_VERDICTS.has(row.verdict)) return { status: "violation", reason: `invalid verdict '${row.verdict}'` };
  if (row.triage_expires && row.triage_expires < today) {
    return { status: "violation", reason: `expired (triage_expires ${row.triage_expires}) — re-verify and re-triage` };
  }
  const currentHash = findingContentHash(finding);
  if (row.content_hash === currentHash) return { status: "ok" };

  // Content hash moved. Whether that reopens the verdict now turns on the
  // finding's SYMBOL SET, not the hash — see the file header.
  const currentSymbols = normalizedSymbolSet(finding);
  const hasRecordedSymbolSet = Array.isArray(row.symbol_set);
  if (hasRecordedSymbolSet && sameSymbolSet(row.symbol_set, currentSymbols)) {
    return { status: "carried_forward", symbolCount: currentSymbols.length };
  }

  if (!hasRecordedSymbolSet) {
    return {
      status: "violation",
      reason: `content changed since triage (recorded ${row.content_hash}, now ${currentHash}) — REOPENED, the prior verdict no longer applies ` +
        "(legacy triage row has no recorded symbol set — falling back to hash comparison; re-triage to opt into carry-forward)",
    };
  }

  const { added, removed } = symbolSetDiff(row.symbol_set, currentSymbols);

  // A set that only SHRANK still REOPENS. Carrying forward there would be a
  // real loosening of a trigger this gate's tests assert deliberately
  // ("REOPENS when the finding loses a symbol"), and a finding that lost
  // members may have changed substance in a way the recorded verdict never
  // considered. Narrowing the ask below is a messaging change; removing a
  // reopen trigger is an operator decision, not an implementation one.
  if (added.length === 0) {
    const lostParts = removed.length ? `lost ${removed.join(", ")}` : "symbol set changed";
    return {
      status: "violation",
      reason: `symbol set changed since triage (${lostParts}) — REOPENED, the prior verdict no longer applies`,
    };
  }

  // A set that GREW still needs a decision — a member nobody triaged is
  // exactly what this gate exists to surface. But the ask is narrowed to
  // the additions, and the operator is told their existing verdict still
  // stands for what they already decided. The blunt form ("the prior
  // verdict no longer applies") is what turns an 18-record finding into a
  // re-triage of 18 records because one unrelated record joined the set,
  // and a gate that asks for eighteen decisions to collect one gets
  // answered carelessly — the failure this repository's own interview
  // discipline names outright.
  const keptCount = currentSymbols.length - added.length;
  const removedNote = removed.length ? `; ${removed.length} no longer present` : "";
  return {
    status: "violation",
    reason: `${added.length} newly-affected symbol(s) have never been triaged: ${added.join(", ")} `
      + `(${keptCount} already-triaged symbol(s) keep the prior "${row.verdict}" verdict${removedNote}) `
      + "— decide about the new ones",
  };
}

/**
 * Whether finding `findingId`, read fresh from `repo`, still needs a human
 * triage decision by this gate's own pass condition. `false` covers two
 * distinct cases callers must not conflate: the finding is absent (nothing to
 * decide — that is `findingClosed`'s job to notice, not this function's), and
 * the finding is present but every current affected symbol is covered by a
 * non-expired recorded verdict whose content hash matches. Both are "no
 * decision owed"; only the second is this function's own determination.
 */
export function findingNeedsTriageDecision(repo, findingId, today = new Date().toISOString().slice(0, 10)) {
  const dir = join(repo, ".visual-intelligence", "findings");
  const finding = readFindingsFromDir(dir).find((f) => f.id === findingId);
  if (!finding) return false;
  const row = readTriageFromDir(dir).get(findingId);
  return evaluateFindingTriage(finding, row, today).status === "violation";
}

function gate() {
  const findings = readFindings();
  const triage = readTriage();
  const historicalRows = [...triage.values()].map((row) => ({ row, match: triageRowMatch(row, findings) }));
  const orphanedTriageIds = historicalRows.filter(({ match }) => match.kind === "orphan").map(({ row }) => row.finding_id);
  const ambiguousTriageIds = historicalRows.filter(({ match }) => match.kind === "ambiguous").map(({ row }) => row.finding_id);
  const today = new Date().toISOString().slice(0, 10);

  const violations = [];
  const carriedForward = [];
  for (const finding of findings) {
    const row = triage.get(finding.id);
    const result = evaluateFindingTriage(finding, row, today);
    if (result.status === "violation") violations.push({ finding, reason: result.reason });
    else if (result.status === "carried_forward") carriedForward.push({ finding, row, symbolCount: result.symbolCount });
  }

  const report = {
    ok: violations.length === 0,
    findings: findings.length,
    triaged: findings.length - violations.length,
    violations: violations.length,
    carried_forward: carriedForward.length,
    triage_window_days: TRIAGE_WINDOW_DAYS,
    orphaned_triage_rows: orphanedTriageIds.length,
    ambiguous_triage_rows: ambiguousTriageIds.length,
  };
  if (JSON_OUT) {
    console.log(JSON.stringify({
      ...report,
      violation_ids: violations.map((v) => v.finding.id),
      carried_forward_ids: carriedForward.map((c) => c.finding.id),
      orphaned_triage_ids: orphanedTriageIds,
      ambiguous_triage_ids: ambiguousTriageIds,
    }, null, 2));
    return report.ok ? 0 : 1;
  }

  // Default output: the count, one line per finding needing a decision (id +
  // title), and the --triage hint — not the full rationale. An agent hitting
  // this gate needs to see WHAT is owed before anything else; the 40-line
  // strength/convergence explanation buried that under noise on every run,
  // including the common case of a handful of findings. --explain prints it.
  console.log(`gate:vi-findings — ${findings.length} finding(s) in ${FINDINGS_PATH.replace(`${REPO_ROOT}/`, "")}`);
  console.log(`  triaged: ${report.triaged}   violations: ${violations.length}   carried forward: ${carriedForward.length}   orphaned triage rows: ${orphanedTriageIds.length}   ambiguous triage rows: ${ambiguousTriageIds.length}`);
  console.log("");
  for (const v of violations) {
    console.log(`  FAIL  ${v.finding.id}  ${v.finding.title}  — ${v.reason}`);
  }
  if (violations.length === 0) console.log("  (no violations)");
  if (carriedForward.length > 0) {
    console.log("");
    // Carried-forward findings are the UNCHANGED ones: a prior verdict still
    // stands because the finding's symbol set did not move. Listing every one
    // on every run is the same "cry wolf on the steady state" noise the default
    // output already trimmed for the rationale block, so collapse them to a
    // count by default and show the per-finding detail only under --explain.
    // (The actionable violations above are always listed in full — only the
    // unchanged carry-forwards collapse.)
    if (EXPLAIN) {
      for (const c of carriedForward) {
        console.log(`  CARRIED FORWARD  ${c.finding.id}  ${c.finding.title}  — verdict carried forward; content drifted but the symbol set is unchanged (${c.symbolCount} symbol(s))`);
      }
    } else {
      console.log(`  ${carriedForward.length} finding(s) carried forward on an unchanged symbol set (prior verdicts stand) — --explain to list them.`);
    }
  }
  if (orphanedTriageIds.length > 0) {
    console.log("");
    console.log(
      `  ${orphanedTriageIds.length} triage row(s) have no current exact symbol-set match ` +
      "— run `--prune-orphans` to remove those true orphans explicitly.",
    );
  }
  if (ambiguousTriageIds.length > 0) {
    console.log("");
    console.log(
      `  ${ambiguousTriageIds.length} triage row(s) match multiple current findings by symbol set and were retained ` +
      "without a verdict transfer — human review is required.",
    );
  }

  if (EXPLAIN) {
    console.log("");
    console.log("  Strength: this gate proves every committed finding carries a RECORDED HUMAN");
    console.log("  DECISION with a reason, an expiry, and a content hash tying it to the finding's");
    console.log("  current body. It does NOT prove the decision is correct, that a `false_positive`");
    console.log("  verdict is actually a false positive, or that an `accepted_tradeoff` remains an");
    console.log("  acceptable one over time — that is what the triage_expires deadline forces a human");
    console.log("  to re-examine, not what this gate itself can verify. A verdict never forces a fix.");
    console.log("");
    console.log("  Convergence: RED IS THIS GATE'S NORMAL STATE, and a red result is not a");
    console.log("  failure to fix. The detector requires a symbol be LOADED to be a candidate and");
    console.log("  only invocation removes it, so every scenario that drives deeper into the system");
    console.log("  loads more code than it invokes — closing candidates and creating candidates in");
    console.log("  roughly equal measure. Measured on 2026-08-19: widening the catalog from 20 to");
    console.log("  27 scenarios closed 31 symbols and surfaced 30 new ones, a net of -1. The count");
    console.log("  cannot be driven to zero by adding scenarios and is NOT a progress metric; the");
    console.log("  honest question is per-symbol, was THIS symbol observed.");
    console.log("");
    console.log("  What this list is FOR is the residue. What survives repeated scenario widening");
    console.log("  is the interesting set — error branches needing real failures, paths gated on");
    console.log("  credentials the sandbox withholds, and capabilities with no ingress at all.");
    console.log("  Every structurally-unreachable capability found so far came from asking why");
    console.log("  something could not be REACHED. None came from the count.");
  }
  console.log("");

  if (violations.length === 0) { console.log("PASS"); return 0; }
  console.log(`FAIL — ${violations.length} finding(s) need a triage decision (see \`--triage\`, or \`--explain\` for why red is expected)`);
  console.log("");
  // ADR-113: this is an operator verdict, not a mechanical fix — a model
  // triaging its own findings would fabricate the human decision this gate
  // exists to prove (see the "Strength" note above). The honest remedy names
  // the decision to be made and the exact command that records it, not a
  // command that clears the gate on its own.
  console.log("  Remedy: this is an operator verdict, not something a model can resolve on its own");
  console.log("  behalf. For each finding above, run:");
  console.log("");
  console.log("    bun scripts/vi-findings.mjs --triage <finding_id> --verdict <false_positive|accepted_tradeoff|fixed|superseded> --reason \"...\" [--expires <ISO date>]");
  return 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Guarded like completion-depth.mjs's own dispatch: importing this module (as
// discharge-catalog.mjs now does, for findingNeedsTriageDecision, and as
// tests do) must never run the CLI body or set process.exitCode as a side
// effect of module load.
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    if (TRIAGE_INDEX >= 0) process.exitCode = triageOne();
    else if (REWRITE) process.exitCode = rewriteIds();
    else if (PRUNE_ORPHANS) process.exitCode = pruneOrphans();
    else if (REHASH) process.exitCode = rehashTriage();
    else process.exitCode = gate();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
