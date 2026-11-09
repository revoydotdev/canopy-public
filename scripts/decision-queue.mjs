#!/usr/bin/env node
/**
 * scripts/decision-queue.mjs — a decision that is owed can never sit unasked.
 *
 * Usage:
 *   bun scripts/decision-queue.mjs                 # human report
 *   bun scripts/decision-queue.mjs --json          # machine report
 *   bun scripts/decision-queue.mjs --horizon 21    # widen the "due soon" window
 *   bun scripts/decision-queue.mjs --question-pack # owed items as a native-ask question pack
 *   bun run gate:decision-queue                    # blocking gate
 *
 * WHY THIS EXISTS. This repository is very good at RECORDING that a decision
 * is owed and very bad at being reminded of it. On 2026-08-18 an audit found
 * 8 records sitting at Status: Proposed (ADR-035 for 11 days), 4 of 6
 * operator decisions untouched since the day they were written, and ~120
 * dated waivers spread across five stores with five different formats and no
 * single place that shows them together. None had lapsed — but nothing in the
 * repository would have said so if one had, until the day a gate went red for
 * a reason nobody connected to a promise made weeks earlier.
 *
 * The failure mode is not that the deadlines are missing. Every store here
 * dates its exemptions, deliberately, and that discipline is real. The
 * failure mode is that a deadline nobody is scheduled to LOOK at is a
 * reminder with no recipient. The operator named it exactly: there must be a
 * mechanistic and enforced interview activation, so that a backlog of needed
 * decisions can never accumulate with the interview never initiated.
 *
 * WHAT THIS DERIVES. Never declares — every item is read out of the store
 * that already owns it:
 *   1. Proposed records          — decisions/ADR-*.md, with age from **Date:**
 *   2. Waiver stores             — via scripts/lib/waiver-store.mjs, the one
 *                                  primitive all three already share
 *   3. Visual-intelligence triage — .visual-intelligence/findings/triage.jsonl
 *   4. Completion-depth triage   — .completion-depth/findings.jsonl
 *   5. Operator decisions        — docs/proposals/operator-decisions-*.md
 *
 * THE ORPHAN CORRECTION, which is why item 3 is not a naive read. Finding ids
 * are content-addressed and rotate whenever a finding's node set shifts, so
 * triage.jsonl accumulates rows for findings that no longer exist — measured
 * at 61 orphans against 61 live findings on 2026-08-18, exactly 50%. Counting
 * triage.jsonl alone overstates live exposure by roughly 2x. This module
 * cross-checks every triage row against findings.jsonl and counts only rows
 * whose finding is still open. An inflated queue would train its reader to
 * ignore it, which is the one outcome that would defeat the whole mechanism.
 *
 * WHAT THIS GATE PROVES, AND WHAT IT DOES NOT. It proves an interview was
 * RECORDED covering each item that is due — the same strength claim, and the
 * same ceiling, as gate:vi-findings' recorded-verdict requirement. It cannot
 * prove a human answered thoughtfully, or at all; a ledger is bytes and bytes
 * can be written by anyone. The human-in-the-loop guarantee lives in the
 * host's native question tool: `--question-pack` (scripts/interview-pack.mjs)
 * turns this queue into a digested pack that Claude Code's AskUserQuestion or
 * arbor's native human-input port asks verbatim, and
 * `bun run interview:record` (scripts/interview-record.mjs) records the
 * operator's verbatim answers with a structured witness binding them to that
 * pack's digest and to the egress that carried them; after ADR-178's cutoff a
 * record without one covers nothing and blocks. Stated
 * plainly here because a gate that overclaims its own strength is the defect
 * this repository treats as worse than no gate at all.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve as resolvePath } from "node:path";
import { deriveQuestionPack } from "./interview-pack.mjs";
import { attestedRecordDigests, canonicalRecordDigest, importedRecordDigests, readInterviewReceipts } from "./lib/interview-receipts.mjs";
import { fileURLToPath } from "node:url";
import { loadWaiverFile } from "./lib/waiver-store.mjs";
import { auditInterviewWitnesses, dischargeCommitments, dischargeStoreAbsence, WITNESS_REQUIRED_AFTER } from "./lib/discharge-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");

/**
 * Days before an expiry at which an item first becomes visible to the queue
 * as UPCOMING — listed for awareness, never a blocker on its own. Widened
 * from a single 14-day "due soon" cutoff on 2026-08-23: a waiver with a full
 * week of runway still tripped the same red gate as one with two days left,
 * so a correctly-working agent that had just filed a well-formed, far-dated
 * waiver hit a blocking gate for it. Interviewing something with ten days of
 * headroom is not urgent; interviewing something with two days of headroom
 * is. See DEFAULT_DUE_SOON_DAYS for the threshold that actually blocks.
 */
export const DEFAULT_HORIZON_DAYS = 14;
/**
 * Days before an expiry at which an uninterviewed item becomes a BLOCKER
 * (`due_soon`). An item inside DEFAULT_HORIZON_DAYS but outside this window
 * is `upcoming`: listed in every report, counted in `total`, but never part
 * of `blocking` — the operator can see it coming without the gate demanding
 * an interview today. PINNED for the same reason DEFAULT_MAX_PROPOSED_AGE_DAYS
 * is: raising it to make the queue look shorter must be a visible, reviewed
 * edit to a named constant plus its test, not a quiet tolerance widening.
 */
export const DEFAULT_DUE_SOON_DAYS = 3;
/**
 * Days an undated decision — a Proposed record, or an open operator decision —
 * may sit before it must be interviewed.
 *
 * Lowered from 21 to 7 on 2026-08-19, at the operator's direction, after the
 * original figure was challenged for what it was: a number chosen the previous
 * day with no evidence behind it. At 21 days it let ADR-038 (11 days) and
 * ADR-061 (6 days) sit surfaced-but-silent while the queue reported PASS, and
 * it would have let twelve open operator decisions do the same.
 *
 * Seven days is not better-evidenced than twenty-one. It is a deliberate bias
 * toward asking too often rather than too rarely, on the reasoning that
 * interview fatigue is visible and self-correcting while a silently-aging
 * decision is neither. The grouping and dated-deferral valves exist to absorb
 * the extra volume.
 *
 * PINNED. `scripts/tests/decision-queue.test.mjs` asserts this exact value, so
 * raising it is a visible, reviewable edit to a named constant plus its test —
 * not a quiet flag change by an agent that found the queue inconvenient. That
 * is the whole point of pinning it: the skill already forbids widening the
 * horizon to make the queue look shorter, and prose does not enforce itself.
 */
export const DEFAULT_MAX_PROPOSED_AGE_DAYS = 7;

export const INTERVIEW_LEDGER_PATH = "decisions/interviews.jsonl";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A malformed row is itself a finding, but this module's job is to
      // report what is owed, not to police store syntax — the owning gate
      // does that. Skipping keeps one bad line from blinding the queue.
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Every record's leading status, by id. Read once so the queue never asks the
 * corpus the same question twice, and so the hazard check below can reason
 * about records that are NOT Proposed.
 */
/**
 * Record ids cited anywhere in a commitment's justification. Derived from the
 * FULL text, never the truncated summary: the summary is capped at 160 chars
 * for display, and the live ADR-041 instance had its citation sitting past
 * that cap — so scanning the summary silently found nothing while the
 * justification plainly named the record.
 */
function citedRecordIds(text) {
  return [...new Set([...(text ?? "").matchAll(/ADR-\d+/g)].map((m) => m[0]))];
}

export function recordStatuses(repo) {
  const dir = join(repo, "decisions");
  const statuses = new Map();
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return statuses;
  }
  for (const entry of entries.sort()) {
    if (!/^ADR-\d+-.+\.md$/.test(entry)) continue;
    const text = readFileSync(join(dir, entry), "utf8");
    const status = /^\*\*Status:\*\*\s*(.+)$/m.exec(text)?.[1]?.trim().toLowerCase() ?? "";
    const id = /^ADR-(\d+)/.exec(entry)?.[0] ?? entry;
    statuses.set(id, status.split(/[\s.,]/)[0] || "unknown");
  }
  return statuses;
}

/**
 * ADR-PENDING-<slug>.md filename shape, matching PENDING_PATTERN in
 * scripts/lib/adr-registry.mjs: a record scaffolded by `adr-registry.mjs new`
 * that has not yet been allocated a number.
 */
const PENDING_RECORD_RE = /^ADR-PENDING-([a-z0-9][a-z0-9-]*)\.md$/;
const NUMBERED_RECORD_RE = /^ADR-\d+-.+\.md$/;

/**
 * Records still at Proposed, with how long they have been there. Also
 * enumerates ADR-PENDING-<slug>.md (ADR-140): a record scaffolded by
 * `adr-registry.mjs new` carries no number until `allocate` runs, and the
 * queue must not wait for that authoring step to notice it — see ADR-140's
 * O1 for the 2026-08-27 case where eight such records sat invisible.
 *
 * A pending record's `id` is its slug (`ADR-PENDING-<slug>`), never a
 * synthesized number: inventing one here would collide with the allocator's
 * own ledger, and per ADR-140 Decision §3, a slug id and its later allocated
 * number are deliberately DIFFERENT coverage keys — an interview that covered
 * the slug does not automatically cover the number. `unallocated: true`
 * marks the item so the report can say why it has no citation identity yet
 * (ADR-140 Decision §4), rather than leaving a reader to infer the queue is
 * confused.
 */
export function proposedRecords(repo, today) {
  const dir = join(repo, "decisions");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries.sort()) {
    const pendingMatch = PENDING_RECORD_RE.exec(entry);
    const isNumbered = NUMBERED_RECORD_RE.test(entry);
    if (!pendingMatch && !isNumbered) continue;
    const text = readFileSync(join(dir, entry), "utf8");
    const status = /^\*\*Status:\*\*\s*(.+)$/m.exec(text)?.[1]?.trim().toLowerCase() ?? "";
    if (!status.startsWith("proposed")) continue;
    const date = /^\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/m.exec(text)?.[1] ?? null;
    const id = pendingMatch ? `ADR-PENDING-${pendingMatch[1]}` : (/^ADR-(\d+)/.exec(entry)?.[0] ?? entry);
    const title = /^#\s*(.+)$/m.exec(text)?.[1]?.trim() ?? entry;
    out.push({
      id,
      kind: "proposed_record",
      source: `decisions/${entry}`,
      due: null,
      authored: date,
      age_days: date ? daysBetween(date, today) : null,
      summary: title,
      ...(pendingMatch ? { unallocated: true } : {}),
    });
  }
  return out;
}

/**
 * The three stores that share the waiver primitive. Exported so
 * scripts/lib/discharge-catalog.mjs can recompute a waiver commitment's id
 * without re-deriving "what identifies a waiver entry" a second time.
 */
export const WAIVER_SOURCES = [
  { schema: "reachability", path: "scripts/reachability/allowlist.json", label: (e) => `${e.symbol ?? "?"} (${e.file ?? "?"})` },
  { schema: "branch-accounting", path: "scripts/branch-accounting/dispositions.json", label: (e) => e.branch ?? "?" },
  { schema: "anti-stub", path: "scripts/anti-stub/triage.json", label: (e) => `${e.rule ?? "?"} @ ${e.file ?? "?"}` },
];

export function waiverCommitments(repo) {
  const out = [];
  for (const source of WAIVER_SOURCES) {
    const { entries } = loadWaiverFile(join(repo, source.path));
    for (const entry of entries) {
      if (!entry?.expires || !DATE_RE.test(entry.expires)) continue;
      out.push({
        id: `${source.schema}:${source.label(entry)}`,
        kind: "waiver",
        source: source.path,
        due: entry.expires,
        age_days: null,
        summary: (entry.reason ?? "").split("\n")[0].slice(0, 160),
        cites: citedRecordIds(entry.reason),
      });
    }
  }
  return out;
}

/**
 * VI triage rows whose finding is STILL OPEN. Rows for findings that no
 * longer exist are orphans, not commitments — see this module's header for
 * why counting them would inflate the queue ~2x.
 */
export function visualIntelligenceCommitments(repo) {
  const findingsPath = join(repo, ".visual-intelligence/findings/findings.jsonl");
  const triagePath = join(repo, ".visual-intelligence/findings/triage.jsonl");
  const findings = readJsonl(findingsPath);
  const live = new Set(findings.map((f) => f.id));
  // A finding id is NOT stable: `vi-findings.mjs --rewrite-ids` rekeys a row
  // when its finding's id changes, and a triage row carries the `symbol_set`
  // it was recorded against precisely so it can survive that. Matching on the
  // id alone therefore counts a still-valid row as an orphan, and this module
  // then tells the operator to run `--prune-orphans` — which uses the symbol-set
  // rule, correctly finds nothing to prune, and leaves the operator_call
  // standing forever. Mirror `triageRowMatch`'s rule so the count this module
  // reports and the remedy it names agree on what an orphan is.
  const symbolKey = (nodes) => [...new Set(nodes ?? [])].sort().join("\u0000");
  const liveBySymbols = new Map();
  for (const finding of findings) {
    const key = symbolKey(finding.affected_nodes);
    liveBySymbols.set(key, (liveBySymbols.get(key) ?? 0) + 1);
  }
  const isOrphan = (row) => {
    if (live.has(row.finding_id)) return false;
    if (!Array.isArray(row.symbol_set)) return true;
    // Only a UNIQUE symbol-set match rescues the row; an ambiguous match is
    // not a re-identification, matching triageRowMatch's own distinction.
    return liveBySymbols.get(symbolKey(row.symbol_set)) !== 1;
  };
  const out = [];
  let orphans = 0;
  for (const row of readJsonl(triagePath)) {
    if (isOrphan(row)) {
      orphans += 1;
      continue;
    }
    if (!live.has(row.finding_id)) continue; // re-identified by symbols; its commitment rides the live finding
    if (row.verdict !== "accepted_tradeoff") continue; // a false_positive carries no future work
    if (!row.triage_expires || !DATE_RE.test(row.triage_expires)) continue;
    out.push({
      id: row.finding_id,
      kind: "vi_triage",
      source: ".visual-intelligence/findings/triage.jsonl",
      due: row.triage_expires,
      age_days: null,
      summary: (row.reason ?? "").split(".")[0].slice(0, 160),
      cites: citedRecordIds(row.reason),
    });
  }
  return { items: out, orphans };
}

export function completionDepthCommitments(repo) {
  const out = [];
  for (const row of readJsonl(join(repo, ".completion-depth/findings.jsonl"))) {
    if (row.verdict !== "accepted_tradeoff") continue;
    if (!row.triage_expires || !DATE_RE.test(row.triage_expires)) continue;
    out.push({
      id: row.id ?? `${row.guard_file}:${row.guard_line}`,
      kind: "completion_depth",
      source: ".completion-depth/findings.jsonl",
      due: row.triage_expires,
      age_days: null,
      summary: (row.verdict_reason ?? "").split(".")[0].slice(0, 160),
      cites: citedRecordIds(row.verdict_reason),
    });
  }
  return out;
}

/**
 * Operator decisions recorded as prose. These carry no expiry by
 * construction, so they are queued by AGE like a Proposed record — a
 * decision written down and never revisited is the exact backlog this
 * module exists to prevent.
 */
/**
 * Minimum age before a snapshot worktree counts as stranded. A frozen
 * fixture worktree (ADR-078) exists for the seconds a test runs; anything
 * still present hours later was left by a run that died. This is a
 * heuristic and is stated as one — `worktree-hygiene` deliberately refuses
 * to guess here, because a false "safe to remove" costs a live session its
 * work. The queue only ASKS; it never removes.
 */
const STRANDED_WORKTREE_MIN_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Decisions only the operator can make, which no deadline is attached to and
 * which therefore accrue silently. This is the class the queue existed to
 * catch and originally did not: a gate that REPORTS a state forever, while
 * nothing ever forces the disposition.
 *
 * The first instance was 63 orphaned visual-intelligence triage rows —
 * reported on every gate run for weeks, disposable only by a human, and
 * never once asked about. "The gate reports it, deleting is your call" is
 * exactly how a backlog forms when nobody is scheduled to make the call.
 *
 * These carry no expiry, so they are due IMMEDIATELY and stay due until an
 * interview records a disposition. An interview may defer with a date — that
 * is the pressure valve, and it is dated on purpose.
 *
 * Grouped, always: 63 orphaned rows are ONE decision (prune or retain), not
 * 63. A queue that asked 63 times would be answered once, carelessly.
 */
/**
 * The ids of every DATED commitment whose justification cites `recordId` —
 * the dependents a `hazard:<recordId>` groups. Only these three sources carry
 * `cites`; `deriveDecisionQueue` groups hazards over the same items, so this
 * cannot disagree with it. It deliberately does not call `deriveDecisionQueue`:
 * the hazard discharge predicates (scripts/lib/discharge-catalog.mjs) run
 * INSIDE that derivation, and re-entering it would recurse.
 */
export function datedCommitmentsCiting(repo, recordId) {
  return [...waiverCommitments(repo), ...visualIntelligenceCommitments(repo).items, ...completionDepthCommitments(repo)]
    .filter((item) => item.due && (item.cites ?? []).includes(recordId))
    .map((item) => item.id);
}

export function operatorCalls(repo) {
  const calls = [];

  // 1. Orphaned triage rows: a recorded human verdict whose finding no longer
  //    exists. Retaining them is defensible (git keeps the history either
  //    way); what is not defensible is never deciding.
  // Same rule as visualIntelligenceCommitments above, and for the same reason:
  // a finding id rotates, and a triage row's recorded symbol_set is what lets
  // it survive the rotation. Counting a re-identifiable row as an orphan told
  // the operator to run --prune-orphans, which uses the symbol-set rule, finds
  // nothing, and leaves this call standing every run forever.
  const orphanFindings = readJsonl(join(repo, ".visual-intelligence/findings/findings.jsonl"));
  const liveIds = new Set(orphanFindings.map((f) => f.id));
  const orphanSymbolKey = (nodes) => [...new Set(nodes ?? [])].sort().join("\u0000");
  const liveOrphanSymbols = new Map();
  for (const finding of orphanFindings) {
    const key = orphanSymbolKey(finding.affected_nodes);
    liveOrphanSymbols.set(key, (liveOrphanSymbols.get(key) ?? 0) + 1);
  }
  const orphans = readJsonl(join(repo, ".visual-intelligence/findings/triage.jsonl"))
    .filter((row) => {
      if (liveIds.has(row.finding_id)) return false;
      if (!Array.isArray(row.symbol_set)) return true;
      return liveOrphanSymbols.get(orphanSymbolKey(row.symbol_set)) !== 1;
    });
  if (orphans.length > 0) {
    calls.push({
      id: "operator-call:vi-triage-orphans",
      kind: "operator_call",
      source: ".visual-intelligence/findings/triage.jsonl",
      due: null,
      age_days: null,
      count: orphans.length,
      summary:
        `${orphans.length} triage row(s) reference a finding that no longer exists — prune them ` +
        `(\`bun scripts/vi-findings.mjs --prune-orphans\`) or record why they are retained`,
    });
  }

  // 2. Snapshot worktrees left behind by test runs. gate:worktree-hygiene
  //    passes on these by design: their registrations are not orphaned and
  //    they are not locked, so neither of its two detectors fires. Nothing
  //    else looks at them at all.
  try {
    const porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
    const stranded = [];
    const now = Date.now();
    for (const paragraph of porcelain.split(/\n\s*\n/)) {
      const path = /^worktree (.+)$/m.exec(paragraph)?.[1];
      if (!path || path === repo) continue;
      if (!/snapshot/.test(path)) continue;
      let ageMs = 0;
      try {
        ageMs = now - statSync(path).mtimeMs;
      } catch {
        continue; // gone from disk; worktree-hygiene's prune path owns that
      }
      if (ageMs >= STRANDED_WORKTREE_MIN_AGE_MS) stranded.push(path);
    }
    if (stranded.length > 0) {
      calls.push({
        id: "operator-call:stranded-worktrees",
        kind: "operator_call",
        source: "git worktree list",
        due: null,
        age_days: null,
        count: stranded.length,
        summary:
          `${stranded.length} snapshot worktree(s) older than 2h remain from interrupted test runs — ` +
          `gate:worktree-hygiene passes on them because they are neither pruneable nor locked`,
      });
    }
  } catch {
    // Not a git repo, or git unavailable: report nothing rather than guess.
  }

  return calls;
}

export function operatorDecisions(repo, today) {
  const dir = join(repo, "docs/proposals");
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^operator-decisions-.*\.md$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files.sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const dated = /operator-decisions-(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? null;
    for (const match of text.matchAll(/^##\s+(D\d+)\s*[—-]\s*(.+)$/gm)) {
      out.push({
        id: `${file.replace(/\.md$/, "")}:${match[1]}`,
        kind: "operator_decision",
        source: `docs/proposals/${file}`,
        due: null,
        authored: dated,
        age_days: dated ? daysBetween(dated, today) : null,
        summary: match[2].trim(),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interview ledger
// ---------------------------------------------------------------------------

/**
 * An interview record: `{ held_at, covered: [id...], outcomes: {id: text},
 * deferred_to: {id: ISO date} }`. An item is covered by an interview if that
 * interview names it AND any deferral it recorded has not itself expired —
 * a deferral is a decision with a shelf life, not an escape hatch.
 */
/**
 * Resolve which ledger records count as interviews: attested (ADR-158) and,
 * after ADR-178's cutoff, witnessed.
 *
 * ATTESTED means historical (on or before the baseline), matching a receipt in
 * this clone's store, or present in the ledger at a remote-tracking ref's last
 * fetched position (`importedRecordDigests`) — i.e. written in another clone
 * and carried here by git. The import path is what lets a fresh clone keep its
 * history: before it, a clone with no store treated every record as attested,
 * and recording its first interview flipped that off, so every earlier
 * post-baseline record stopped covering anything in one step.
 *
 * Inactive (every record counts) only when nothing could attest anything: no
 * baseline, or neither a receipt store nor a fetched remote ledger. That is a
 * fixture or a never-fetched, never-recorded repository, and
 * `gate:interview-attestation` is what reports it.
 *
 * WITNESSED means a record held after `WITNESS_REQUIRED_AFTER` carries a valid
 * `witness` (`auditInterviewWitnesses`). An unwitnessed one covers nothing and
 * is reported as `witness_violations`, which blocks — it is checked whenever a
 * baseline exists, receipts or not, because it reads only tracked content.
 */
export function interviewAttestation(repo, interviews) {
  let baselineThrough = null;
  try {
    baselineThrough = JSON.parse(readFileSync(join(repo, "scripts", "interview", "baseline.json"), "utf8")).records_historical_through ?? null;
  } catch { baselineThrough = null; }
  if (!baselineThrough) {
    return { active: false, isAttested: null, unattested: [], imported: 0, witnessViolations: [] };
  }
  const witnessViolations = auditInterviewWitnesses(interviews);
  const isWitnessed = (record) => auditInterviewWitnesses([record]).length === 0;
  let store = { present: false, receipts: [] };
  try { store = readInterviewReceipts(repo); } catch { store = { present: false, receipts: [] }; }
  const imported = importedRecordDigests(repo).digests;
  if (!store.present && imported.size === 0) {
    return { active: false, isAttested: witnessViolations.length ? isWitnessed : null, unattested: [], imported: 0, witnessViolations };
  }
  const digests = attestedRecordDigests({ receipts: store.receipts });
  const unattested = [];
  const isAttested = (record) => {
    if (!isWitnessed(record)) return false;
    const heldAt = record?.held_at ?? "";
    if (heldAt && heldAt <= baselineThrough) return true;
    const digest = canonicalRecordDigest(record);
    if (digests.has(digest) || imported.has(digest)) return true;
    unattested.push({ held_at: record?.held_at ?? null, covered: Array.isArray(record?.covered) ? record.covered : [] });
    return false;
  };
  return { active: true, isAttested, unattested, imported: imported.size, witnessViolations };
}

export function readInterviews(repo) {
  return readJsonl(join(repo, INTERVIEW_LEDGER_PATH));
}

/**
 * Preserve the identity of operator-decision rows across the one historical
 * spelling change in this ledger. Early interviews recorded the source path
 * (`docs/proposals/operator-decisions-YYYY-MM-DD:Dn`); the derived queue has
 * always owned the shorter file-stem identity
 * (`operator-decisions-YYYY-MM-DD:Dn`). Treating those as different asks the
 * operator to repeat a decision they already made.
 *
 * Keep this deliberately narrow. General path stripping would let unrelated
 * stores collide and would turn a compatibility repair into fuzzy identity.
 */
export function canonicalCoverageId(id) {
  if (typeof id !== "string") return id;
  const legacy = /^docs\/proposals\/(operator-decisions-[^/:]+)(?:\.md)?:((?:D)\d+)$/.exec(id);
  return legacy ? `${legacy[1]}:${legacy[2]}` : id;
}

/**
 * ADR-158: an interview record that cannot be traced to the recorder does not
 * cover anything. Coverage is what silences this queue, so accepting an
 * unattested record would let a hand-written line stand in for an operator
 * answer -- the exact substitution the interview skill warns about. `isAttested`
 * is injected rather than computed here so this stays a pure function and so a
 * caller with no receipt store (a fixture, an old test) keeps the prior
 * behaviour by omitting it.
 */
export function coverageIndex(interviews, today, { isAttested = null } = {}) {
  const covered = new Map(); // id -> { held_at, deferred_to|null }
  for (const record of interviews) {
    if (!Array.isArray(record?.covered)) continue;
    if (isAttested && !isAttested(record)) continue;
    for (const recordedId of record.covered) {
      const id = canonicalCoverageId(recordedId);
      const deferredTo = record.deferred_to?.[recordedId] ?? record.deferred_to?.[id] ?? null;
      const prior = covered.get(id);
      // Keep the most recent interview that still stands for this item.
      // `>=`, not `>`: the ledger is append-only, so when two interviews carry
      // the SAME held_at date the later-appended record is the more recent
      // decision and must win. With a strict `>` the earlier entry survived and
      // a same-day re-interview was silently ignored — the code contradicted
      // this comment, and an operator who reversed a morning deferral that
      // afternoon had their second answer discarded without a word.
      if (!prior || (record.held_at ?? "") >= (prior.held_at ?? "")) {
        covered.set(id, { held_at: record.held_at ?? null, deferred_to: deferredTo });
      }
    }
  }
  // A deferral that has itself run out no longer covers anything.
  for (const [id, entry] of covered) {
    if (entry.deferred_to && DATE_RE.test(entry.deferred_to) && entry.deferred_to < today) {
      covered.delete(id);
    }
  }
  return covered;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export function deriveDecisionQueue({
  repo = REPO_ROOT,
  today = new Date().toISOString().slice(0, 10),
  horizonDays = DEFAULT_HORIZON_DAYS,
  dueSoonDays = DEFAULT_DUE_SOON_DAYS,
  maxProposedAgeDays = DEFAULT_MAX_PROPOSED_AGE_DAYS,
} = {}) {
  const vi = visualIntelligenceCommitments(repo);
  // An unexplained absence of the discharge store is its own finding, NOT a
  // synthetic commitment item: an item is silenced by `covered.has(item.id)`
  // below, so a fake one would let a single interview covering its id switch the
  // whole "we cannot know what is owed" signal back off. This state has no id to
  // cover, and it is counted into `blocking` below.
  const dischargeAbsence = dischargeStoreAbsence(repo);
  const items = [
    ...proposedRecords(repo, today),
    ...waiverCommitments(repo),
    ...vi.items,
    ...completionDepthCommitments(repo),
    ...operatorDecisions(repo, today),
    ...operatorCalls(repo),
    // ADR-137: an interview answer's discharge obligation is a commitment
    // like any other — undischarged and past due, it lands in `lapsed` via
    // the exact same logic below, which is what makes it block at push.
    ...dischargeCommitments(repo),
  ];

  const interviews = readInterviews(repo);
  const attestation = interviewAttestation(repo, interviews);
  const covered = coverageIndex(interviews, today, { isAttested: attestation.isAttested });

  const lapsed = [];
  const dueSoon = [];
  const upcoming = [];
  const overAge = [];
  const flaggedProposed = [];
  const operatorCallsDue = [];

  for (const item of items) {
    item.covered = covered.has(item.id);
    // A discharge obligation is due on its interview's own date, so it is
    // lapsed from the next day and lapsed items ignore coverage. An unexpired
    // "defer with a date" answer for it therefore moves its due date, or the
    // deferral would protect it for less than a day. Expired deferrals are
    // already dropped by coverageIndex, which returns the original due date.
    const deferral = item.kind === "discharge_obligation" ? covered.get(item.id)?.deferred_to : null;
    if (deferral && DATE_RE.test(deferral) && deferral > (item.due ?? "")) item.due = deferral;
    if (item.due) {
      item.days_remaining = daysBetween(today, item.due);
      if (item.due < today) {
        lapsed.push(item);
      } else if (item.days_remaining !== null && !item.covered) {
        // Inside the due-soon window: blocks. Inside the wider horizon but
        // beyond due-soon: listed as upcoming, never blocks on its own — see
        // DEFAULT_DUE_SOON_DAYS for why the two thresholds are distinct.
        if (item.days_remaining <= dueSoonDays) dueSoon.push(item);
        else if (item.days_remaining <= horizonDays) upcoming.push(item);
      }
    } else if (item.kind === "operator_call") {
      // No expiry by construction: due immediately, and due until answered.
      if (!item.covered) operatorCallsDue.push(item);
    } else if (item.kind === "proposed_record") {
      // ADR-085: a Proposed ADR is surfaced from day 0 — the `maxProposedAgeDays`
      // grace is nullified for it (the SessionStart hook is the proactive forcing
      // function now) — but it does NOT block on its own. Blocking an
      // un-interviewed Proposed ADR would deadlock the pipeline: the record can
      // only be cleared by an operator interview, which this side (and any agent)
      // must not write, so a proposed ADR awaiting the operator (or a freshly
      // authored one) would make every push fail. The teeth live downstream in
      // gate:adr-decision-followthrough: once an interview RECORDS a decision,
      // coverage no longer clears a still-Proposed record — it must reach a
      // terminal status. Undecided proposed records are flagged, never blocking.
      if (!item.covered) flaggedProposed.push(item);
    } else if (item.age_days !== null && item.age_days > maxProposedAgeDays && !item.covered) {
      // An undated operator decision still ages on the grace clock and blocks
      // once past it. (The grace nullification above is scoped to proposed
      // ADRs, the case ADR-085 addresses; operator-decision aging is unchanged.)
      overAge.push(item);
    }
  }

  // A dated promise resting on a record that does not govern.
  //
  // This originally scanned only PROPOSED records, which left the worse case
  // invisible: rejecting ADR-041 removed it from that set, so four
  // reachability waivers expiring 2026-09-08 went on citing a record the
  // operator had just REJECTED, and the queue reported nothing. A waiver
  // resting on a rejected decision is not a weaker hazard than one resting on
  // an undated decision — it is a justification that has already been
  // withdrawn. So the test is now "does the cited record currently govern",
  // and only `accepted` does.
  //
  // Citations come from each item's `cites`, derived from its FULL
  // justification text. Scanning the display summary missed ADR-041 outright,
  // because the summary is capped at 160 characters and the citation sat past
  // the cap.
  //
  // Grouped BY the cited record: one record cited by nine waivers is one
  // decision to make, not nine. Listing it nine times would be the
  // volume-without-signal that trains a reader to skim past the queue.
  const statuses = recordStatuses(repo);
  const byRecord = new Map();
  for (const item of items) {
    if (!item.due) continue;
    for (const cited of item.cites ?? []) {
      const status = statuses.get(cited);
      if (!status || status === "accepted") continue;
      if (!byRecord.has(cited)) byRecord.set(cited, { cites: cited, status, dependents: [], earliest_due: null });
      const group = byRecord.get(cited);
      group.dependents.push(item.id);
      if (group.earliest_due === null || item.due < group.earliest_due) group.earliest_due = item.due;
    }
  }
  // Hazards are interviewable like anything else. They were not, at first:
  // `blocking` counted them unconditionally, so no interview could ever clear
  // one and the deferral valve — the thing that makes a considered "not yet" a
  // first-class answer — did not apply to the very class most likely to need
  // it. A hazard is keyed by the record it cites, since that record is the one
  // decision to make however many commitments rest on it.
  const hazards = [...byRecord.values()]
    .map((group) => ({
      ...group,
      id: `hazard:${group.cites}`,
      covered: covered.has(`hazard:${group.cites}`),
      detail:
        `${group.cites} is ${group.status.toUpperCase()} and does not govern, yet ` +
        `${group.dependents.length} dated commitment(s) rest on it — the earliest falls due ${group.earliest_due}`,
    }))
    .filter((group) => !group.covered);

  // `upcoming` and `flagged_proposed` are deliberately excluded — they are
  // visibility, not obligation (ADR-085: the SessionStart hook forces proposed
  // ADRs, gate:adr-decision-followthrough enforces the follow-through).
  // ADR-178: a record held after the cutoff with no valid witness was not
  // recorded through the native flow. It already covers nothing (above); it
  // also blocks, because a ledger line that silences nothing is still a line
  // someone wrote outside the recorder, and a gate that only ignored it would
  // let it sit there unexplained.
  const witnessViolations = attestation.witnessViolations ?? [];
  const blocking = lapsed.length + dueSoon.length + overAge.length + operatorCallsDue.length + hazards.length + (dischargeAbsence ? 1 : 0) + witnessViolations.length;
  return {
    ok: blocking === 0,
    today,
    horizon_days: horizonDays,
    due_soon_days: dueSoonDays,
    max_proposed_age_days: maxProposedAgeDays,
    total: items.length,
    orphaned_vi_triage_rows: vi.orphans,
    // Non-null means "what this store owed cannot be determined", which is a
    // blocking state distinct from every bucket above — none of which can hold it,
    // because each of them describes a commitment that is KNOWN to exist.
    discharge_store_absence: dischargeAbsence,
    lapsed,
    due_soon: dueSoon,
    upcoming,
    over_age: overAge,
    flagged_proposed: flaggedProposed,
    operator_calls: operatorCallsDue,
    hazards,
    witness_required_after: WITNESS_REQUIRED_AFTER,
    witness_violations: witnessViolations,
    items: items.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999")),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  const value = Number.parseInt(process.argv[index + 1], 10);
  return Number.isFinite(value) ? value : fallback;
}

/** `--repo` is a fixture seam only (see `guard:canaries`): every source above
 * already takes `repo` as a parameter, so pointing the CLI at a throwaway
 * corpus needed no change to any of them. Absent the flag, unchanged. */
function pathFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

export function main() {
  const report = deriveDecisionQueue({
    repo: resolvePath(pathFlag("--repo", REPO_ROOT)),
    horizonDays: flag("--horizon", DEFAULT_HORIZON_DAYS),
    dueSoonDays: flag("--due-soon", DEFAULT_DUE_SOON_DAYS),
    maxProposedAgeDays: flag("--max-proposed-age", DEFAULT_MAX_PROPOSED_AGE_DAYS),
  });

  if (process.argv.includes("--question-pack")) {
    // The egress form of this report: questions a native Q&A tool can ask.
    // Exit status still reflects the queue, so a caller can gate on it.
    console.log(JSON.stringify(deriveQuestionPack(report, { includeUpcoming: process.argv.includes("--include-upcoming") }), null, 2));
    return report.ok ? 0 : 1;
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  console.log(`decision-queue — ${report.total} open commitment(s) as of ${report.today}`);
  console.log(`  due-soon ${report.due_soon_days}d (blocks) · upcoming lookahead ${report.horizon_days}d (listed only) · max Proposed age ${report.max_proposed_age_days}d`);
  if (report.orphaned_vi_triage_rows > 0) {
    console.log(`  (${report.orphaned_vi_triage_rows} orphaned VI triage row(s) excluded — their findings no longer exist)`);
  }
  console.log("");

  const section = (title, rows, render) => {
    if (rows.length === 0) return;
    console.log(`${title} (${rows.length}):`);
    for (const row of rows) console.log(`  ${render(row)}`);
    console.log("");
  };

  section("LAPSED — a promise this repository has already broken", report.lapsed,
    (i) => `${i.due}  ${i.id}  [${i.kind}]  ${i.summary}`);
  section("DUE SOON and never interviewed", report.due_soon,
    (i) => `${i.due}  (${i.days_remaining}d)  ${i.id}  [${i.kind}]  ${i.summary}`);
  section("UPCOMING — not yet due, listed for awareness only", report.upcoming,
    (i) => `${i.due}  (${i.days_remaining}d)  ${i.id}  [${i.kind}]  ${i.summary}`);
  const unallocatedNote = (i) => (i.unallocated ? " (unallocated — no ADR number yet)" : "");
  section("PROPOSED too long with no interview", report.over_age,
    (i) => `${i.age_days}d  ${i.id}${unallocatedNote(i)}  ${i.summary}`);
  section("PROPOSED — awaiting a definitive green/redlight (flagged, not blocking; see gate:adr-decision-followthrough)", report.flagged_proposed ?? [],
    (i) => `${i.age_days ?? "?"}d  ${i.id}${unallocatedNote(i)}  ${i.summary}`);
  section("OPERATOR CALL — accruing with no deadline and no disposition", report.operator_calls,
    (i) => `${i.id}  (${i.count})  ${i.summary}`);
  section("HAZARD — a dated commitment resting on a record that does not govern", report.hazards,
    (h) => h.detail);
  section("UNKNOWN — a store this gate depends on is missing, so what it owed cannot be determined",
    report.discharge_store_absence ? [report.discharge_store_absence] : [],
    (s) => `${s.path} does not exist, yet ${s.interviews_after_required_from} interview(s) were held after ` +
      `${s.required_from} (latest ${s.latest_interview}). Obligations it recorded are UNKNOWN, not absent.`);

  section(`UNWITNESSED — an interview record held after ${report.witness_required_after} with no valid witness (ADR-178)`, report.witness_violations,
    (v) => `decisions/interviews.jsonl line ${v.line}  held_at=${v.held_at ?? "(none)"}  covered=[${v.covered.join(", ")}]  — ${v.errors.join("; ")}`);

  if (report.ok) {
    console.log("PASS — every commitment that is due has been interviewed.");
  } else if (report.witness_violations.length > 0) {
    console.log("FAIL — interview records after ADR-178's acceptance carry no valid witness, so they cover nothing.");
    console.log("");
    console.log("  A witness binds an answer to the question pack it answered and the native tool that");
    console.log("  carried it. Only the native recorder writes one. Re-ask each item it covered:");
    console.log("    bun scripts/decision-queue.mjs --question-pack > pack.json");
    console.log("    (AskUserQuestion in Claude Code; `arbor interview` on a terminal)");
    console.log("    bun run interview:record --pack pack.json --answers answers.json");
    console.log("");
    console.log("  Then remove the unwitnessed line in the same commit, naming why. Do NOT add a");
    console.log("  `witness` to it by hand: it would be a fabricated binding, and editing a recorded");
    console.log("  line also orphans it from its ADR-158 receipt.");
  } else if (report.discharge_store_absence) {
    const absence = report.discharge_store_absence;
    console.log("FAIL — a store this gate depends on is missing, so its obligations cannot be checked.");
    console.log("");
    console.log(`  ${absence.path} does not exist, yet ${absence.interviews_after_required_from} interview(s) were held`);
    console.log(`  after ${absence.required_from} (latest ${absence.latest_interview}). Interviews in that`);
    console.log("  window append to this store, so a missing file means its obligations are UNKNOWN,");
    console.log("  not none. This gate will not read a missing ledger as compliance.");
    console.log("");
    console.log("  Restore it:");
    console.log(`    git checkout -- ${absence.path}`);
    console.log("");
    console.log("  If this repository genuinely owes no discharge obligation, commit an");
    console.log(`  EMPTY ${absence.path} instead of leaving it absent:`);
    console.log("  an empty store is a valid, tracked state, satisfies this gate, and from");
    console.log("  then on its existence is enforced.");
    console.log("");
    console.log("  Do not hand-write obligation rows to silence this. A written row satisfies the gate");
    console.log("  without the underlying work being done — the failure this gate exists to prevent.");
  } else {
    console.log("FAIL — decisions are owed and no interview covers them.");
    console.log("");
    console.log("  Ask the operator through the host's native question tool, then record:");
    console.log("    bun scripts/decision-queue.mjs --question-pack > pack.json");
    console.log("    (ask each question verbatim: AskUserQuestion in Claude Code,");
    console.log("     the native human-input port inside a Canopy run)");
    console.log("    bun run interview:record --pack pack.json --answers answers.json");
    console.log("");
    console.log("  The ledger this gate reads is decisions/interviews.jsonl. Writing a");
    console.log("  record there without actually asking would satisfy the gate and defeat");
    console.log("  its entire purpose — the gate proves an interview was RECORDED, not");
    console.log("  that one was held. That distinction is the operator's to protect.");
  }
  return report.ok ? 0 : 1;
}

if (resolvePath(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
