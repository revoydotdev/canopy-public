#!/usr/bin/env node
/**
 * scripts/audit-reconcile.mjs — a defect row must not read as live forever.
 *
 * Usage:
 *   bun run audit:reconcile             # human report
 *   bun run audit:reconcile --json      # machine report (the pre-dispatch read)
 *
 * WHY THIS EXISTS. Root-caused 2026-08-24: `audit/2026-08-23-50-defects.md` is
 * a table of WA-numbered defect rows with NO status/closed column, so every
 * row reads as current forever — an agent scoping remediation reads it and
 * gets dispatched to "fix" a defect that already landed. The closure
 * information EXISTS but is unreachable from the table: fix commits already
 * cite WA-ids in their messages (`git log --grep WA-67` finds one), and
 * `audit/2026-08-23-60-canvas-register.md` carries a hand-written "WA
 * reconciliation at <commit>" paragraph naming which ids were verified
 * CLOSED or still OPEN in code — but nothing harvests either signal, the
 * paragraph is frozen prose pinned to one commit, and the table has no
 * backlink to it.
 *
 * WHAT THIS IS NOT. `gate:audit-disposition` (scripts/audit-disposition.mjs)
 * deliberately refuses to parse findings out of audit prose — its header
 * calls that "a lie dressed as rigour" because a regex over free-form
 * analysis produces a finding count that looks authoritative and tracks
 * nothing real. This script parses REGULAR pipe-table rows, not prose, but
 * the same honesty ceiling applies one level further in: nothing here ever
 * asserts a defect IS fixed. "A commit references this id" is evidence a fix
 * was ATTEMPTED, not proof the defect is gone — a commit message can lie,
 * cite the wrong id, or fix something else under the same id by coincidence.
 * Every status this script reports carries an explicit "VERIFY before
 * treating as live" instruction. It is advisory, derived evidence for an
 * agent about to be dispatched — never a blocking claim that a row is fixed,
 * and never wired into a gate for that reason (see the header note in
 * gate:audit-disposition for why a blocking gate must not make this claim).
 *
 * MECHANISM.
 *   1. Parse defect ids (WA-/X-/H-/G-) from every audit/*.md table row where
 *      the id is the row's OWN first cell (`^\| *WA-\d+ *\|`), never from an
 *      "origin" column that merely cites another id.
 *   2. For each id, run one `git log` since the earliest audit date that
 *      mentions it, and grep the id (word-bounded) out of the combined
 *      subject+body of every commit after that date.
 *   3. Cross-reference `audit/2026-08-23-60-canvas-register.md`'s hand-written
 *      "Verified CLOSED in code" / "Verified still OPEN" lists (comma/slash/
 *      range syntax, e.g. "WA-03,10,11" and "56-58").
 *   4. Emit one status per id, ordered by strength of signal: fix-committed
 *      (a later commit cites it — checked first because it is the freshest,
 *      most actionable signal for a dispatcher) > declared-open > declared-
 *      closed > unreconciled (no signal either way — the honest default).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");
const CANVAS_REGISTER = "audit/2026-08-23-60-canvas-register.md";
const RECONCILIATION_HEADING = "## WA reconciliation at";

/** A defect row's own id: the row's first cell, never a mention elsewhere. */
const ROW_ID = /^\|\s*\*{0,2}(WA|X|H|G)-(\d+)\*{0,2}\s*\|(.*)$/;

/** Audit filenames that carry a leading `YYYY-MM-DD-` wave date. */
const WAVE_DATE = /^(\d{4}-\d{2}-\d{2})-/;

function runGit(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Every id-bearing row in every audit/*.md file (top level only — audit/
 * subdirectories like features/ and logs/ are evidence dumps, not defect
 * registers). Duplicate ids across files (WA-01..07 appear in both
 * `10-machine-verdicts.md`, their source packet, and the consolidated
 * `50-defects.md`) keep the first description found once files are sorted
 * with any "defects" file first, since that is the consolidated register
 * this defect got mechanized for; every source file is still recorded.
 */
export function parseDefectRows(repo = REPO_ROOT) {
  const dir = join(repo, "audit");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort((a, b) => (/defects/i.test(a) === /defects/i.test(b) ? a.localeCompare(b) : /defects/i.test(a) ? -1 : 1));

  const byId = new Map();
  for (const name of files) {
    const path = `audit/${name}`;
    const dateMatch = WAVE_DATE.exec(name);
    const text = readFileSync(join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      const m = ROW_ID.exec(line);
      if (!m) continue;
      const id = `${m[1]}-${m[2]}`;
      const description = m[3]
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" — ")
        .slice(0, 240);
      if (!byId.has(id)) {
        byId.set(id, { id, path, wave_date: dateMatch?.[1] ?? null, description, sources: [path] });
      } else if (!byId.get(id).sources.includes(path)) {
        byId.get(id).sources.push(path);
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/**
 * Ids a token list like "WA-03,10,11" or "WA-01,04,05,06/50,07,...,56-58"
 * expands to. Comma and slash both separate distinct ids; a bare `n-m` of
 * pure digits (no letter prefix) is a RANGE under the last seen prefix — the
 * one syntax the source paragraph actually uses both ways, so both must be
 * handled: "WA-67/68" is two ids, "56-58" is three.
 */
export function expandIdList(text, defaultPrefix) {
  const ids = [];
  let lastPrefix = defaultPrefix;
  const tokens = text
    .split(",")
    .flatMap((t) => t.split("/"))
    .map((t) => t.trim().replace(/[.:;]+$/, ""))
    .filter(Boolean);
  for (const token of tokens) {
    const prefixed = /^([A-Za-z]+)-(\d+)$/.exec(token);
    const range = /^(\d+)-(\d+)$/.exec(token);
    const bare = /^\d+$/.exec(token);
    if (prefixed) {
      // Digits are kept exactly as written (no Number() normalization) so a
      // zero-padded id like "WA-03" matches the defect table's own "WA-03"
      // row instead of silently becoming "WA-3".
      lastPrefix = prefixed[1];
      ids.push(`${lastPrefix}-${prefixed[2]}`);
    } else if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n++) ids.push(`${lastPrefix}-${n}`);
    } else if (bare) {
      ids.push(`${lastPrefix}-${token}`);
    }
    // Anything else (stray backtick fragments, prose) is silently skipped —
    // this is a best-effort read of hand-written prose, not a grammar.
  }
  return ids;
}

/**
 * The canvas register's own "Verified CLOSED in code" / "Verified still
 * OPEN" / "Not re-verified this pass" declarations. Parenthetical asides are
 * stripped before sentence-splitting so an aside's own punctuation (file:line
 * refs, version numbers) cannot be mistaken for a sentence boundary.
 */
export function parseCanvasReconciliation(repo = REPO_ROOT) {
  const path = join(repo, CANVAS_REGISTER);
  const result = { closed: new Set(), open: new Set(), not_reverified: new Set(), found: false };
  if (!existsSync(path)) return result;
  const text = readFileSync(path, "utf8");
  if (!text.includes(RECONCILIATION_HEADING)) return result;
  result.found = true;
  const stripped = text.replace(/\([^)]*\)/g, "");

  const closedMatch = /Verified CLOSED in code:\s*([^.]*)\./.exec(stripped);
  if (closedMatch) for (const id of expandIdList(closedMatch[1], "WA")) result.closed.add(id);

  const openMatch = /Verified still OPEN:\s*([^.]*)\./.exec(stripped);
  if (openMatch) for (const id of expandIdList(openMatch[1], "WA")) result.open.add(id);

  const notReMatch = /Not re-verified this pass:\s*([^.]*)\./.exec(stripped);
  if (notReMatch) for (const id of expandIdList(notReMatch[1], "WA")) result.not_reverified.add(id);

  return result;
}

/**
 * Commits (subject+body) after `since`, whose message mentions `id` at a
 * word boundary — one `git log` covers every id, then each id filters it in
 * memory, rather than one `git log --grep` invocation per id.
 */
export function commitsSince(since, repo = REPO_ROOT) {
  if (!since) return [];
  let out;
  try {
    out = execFileSync(
      "git",
      ["log", `--since=${since}`, "--date=short", "--format=%H%x1f%ad%x1f%s%x1f%b%x1e"],
      { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    return [];
  }
  return out
    .split("\x1e")
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [hash, date, subject, body] = rec.split("\x1f");
      return { hash, date, subject, body: body ?? "" };
    });
}

function citesId(commit, id) {
  const boundary = new RegExp(`\\b${id}\\b`);
  return boundary.test(commit.subject) || boundary.test(commit.body);
}

export function reconcile({ repo = REPO_ROOT } = {}) {
  const rows = parseDefectRows(repo);
  const canvas = parseCanvasReconciliation(repo);
  const earliestDate = rows.map((r) => r.wave_date).filter(Boolean).sort()[0] ?? null;
  const allCommits = commitsSince(earliestDate, repo);

  const results = rows.map((row) => {
    const since = row.wave_date ?? earliestDate;
    const commits = allCommits
      .filter((c) => !since || c.date >= since)
      .filter((c) => citesId(c, row.id))
      .map((c) => ({ hash: c.hash.slice(0, 12), date: c.date, subject: c.subject }));

    const declaredClosed = canvas.closed.has(row.id);
    const declaredOpen = canvas.open.has(row.id);

    let status, label;
    if (commits.length > 0) {
      status = "fix-committed";
      label =
        `${commits.length} fix commit(s) reference this — VERIFY before treating as live` +
        (declaredOpen ? " (canvas register still lists this as OPEN — reconcile the contradiction directly)" : "");
    } else if (declaredClosed) {
      status = "declared-closed";
      label = "canvas register records this as verified CLOSED in code — VERIFY before treating as live";
    } else if (declaredOpen) {
      status = "declared-open";
      label = "canvas register records this as verified still OPEN — treat as live";
    } else {
      status = "unreconciled";
      label = "no commit or register signal found — status unknown, treat row as live until checked";
    }

    return {
      id: row.id,
      source: row.path,
      sources: row.sources,
      description: row.description,
      wave_date: row.wave_date,
      status,
      label,
      fix_commits: commits,
      register_declared_closed: declaredClosed,
      register_declared_open: declaredOpen,
      register_not_reverified: canvas.not_reverified.has(row.id),
    };
  });

  return {
    canvas_register_found: canvas.found,
    total: results.length,
    fix_committed: results.filter((r) => r.status === "fix-committed").length,
    declared_closed: results.filter((r) => r.status === "declared-closed").length,
    declared_open: results.filter((r) => r.status === "declared-open").length,
    unreconciled: results.filter((r) => r.status === "unreconciled").length,
    rows: results,
  };
}

export function main() {
  const report = reconcile();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log(`audit-reconcile — ${report.total} defect row(s) found under audit/\n`);
  console.log(`  fix-committed (VERIFY) : ${report.fix_committed}`);
  console.log(`  declared-closed (VERIFY): ${report.declared_closed}`);
  console.log(`  declared-open           : ${report.declared_open}`);
  console.log(`  unreconciled            : ${report.unreconciled}\n`);
  if (!report.canvas_register_found) {
    console.log(`  note: ${CANVAS_REGISTER}'s reconciliation paragraph was not found; register cross-check skipped.\n`);
  }

  for (const row of report.rows) {
    if (row.status === "unreconciled") continue;
    console.log(`  ${row.id}  [${row.status}]  ${row.label}`);
    for (const c of row.fix_commits) console.log(`      ${c.hash}  ${c.date}  ${c.subject}`);
  }

  console.log("\nThis is advisory, derived evidence — never proof a defect is gone. Run before");
  console.log("dispatching remediation for a specific row; verify the row directly before acting on it.");
  return 0;
}

if (resolvePath(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
