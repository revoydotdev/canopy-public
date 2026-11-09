#!/usr/bin/env node
/**
 * scripts/audit-disposition.mjs — an audit finding must become a tracked
 * commitment, not a paragraph in a transcript.
 *
 * Usage:
 *   bun scripts/audit-disposition.mjs                # human report
 *   bun scripts/audit-disposition.mjs --json         # machine report
 *   bun run gate:audit-disposition                   # blocking gate
 *
 * WHY THIS EXISTS. On 2026-08-19 the operator asked why an agent could stop
 * without interviewing them about outstanding audit results. The answer was
 * structural and worse than the question implied: `scripts/decision-queue.mjs`
 * reads six sources, and NONE of them is "an audit produced findings nobody
 * dispositioned". Five audits ran that day and their recommendations existed
 * only in a chat transcript — they would have evaporated at session end while
 * `gate:decision-queue` reported PASS.
 *
 * That is the failure the decision queue was built to prevent, one level up: a
 * mechanism that forces dispositions on RECORDED commitments, generating
 * unrecorded ones. The repository already had the pattern for fixing it —
 * `docs/proposals/operator-decisions-*.md`, which the queue does read, and
 * whose own 2026-08-18 header says "a decision of that weight should not live
 * only in a chat transcript." Nothing connected the two.
 *
 * WHAT THIS CHECKS. Every durable audit document under `audit/` must be
 * DISPOSITIONED: either an operator-decisions file records a decision arising
 * from it, or it is explicitly marked as needing none. The check is
 * deliberately weak on purpose — it verifies that someone ANSWERED for the
 * document, not that the answer was good. That is the same strength claim, and
 * the same ceiling, as `gate:vi-findings`' recorded-verdict requirement.
 *
 * WHY NOT PARSE FINDINGS OUT OF THE AUDIT PROSE. Because it would be a lie
 * dressed as rigour. Audit documents are free-form analysis; a regex over them
 * would produce a finding count that looks authoritative and tracks nothing
 * real. What is mechanically decidable is the far weaker question this gate
 * actually asks — has this document been answered for, yes or no — and the
 * gate says so rather than implying more.
 *
 * THE ESCAPE HATCH IS DELIBERATE AND DATED. A document can declare
 * `<!-- audit-disposition: none-required — <reason> -->` in its own text. Some
 * audits genuinely produce no decision: a census, a reference capture, a
 * root-cause note whose fix already landed. Forcing a decision record for those
 * would generate exactly the volume-without-signal that trains a reader to
 * skim, which is the one outcome that defeats a queue.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// `--repo` is a fixture seam only (see `guard:canaries`): it points this gate's
// `audit/` and `docs/proposals/` reads at a throwaway corpus so a canary can
// prove the gate is able to fail without the real one being mutated. Absent the
// flag, behaviour is byte-identical to the previous constant.
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}
const REPO_ROOT = argValue("--repo") ? resolvePath(argValue("--repo")) : resolvePath(__dirname, "..");

/** The marker a document uses to declare it needs no decision. */
const NONE_REQUIRED = /<!--\s*audit-disposition:\s*none-required\s*(?:—|--|-)?\s*([^>]*?)-->/i;

/** How a decisions file names the audit it arose from. */
const ARISES_FROM = /<!--\s*arises-from:\s*([^>]+?)\s*-->/gi;

export function auditDocuments(repo = REPO_ROOT) {
  const dir = join(repo, "audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), "utf8");
      const declared = NONE_REQUIRED.exec(text);
      return {
        path: `audit/${name}`,
        none_required: declared !== null,
        none_required_reason: declared?.[1]?.trim() ?? null,
      };
    });
}

/**
 * Audit paths any operator-decisions document declares it arose from. Declared
 * rather than inferred: guessing which decision answers which audit from prose
 * similarity would be the kind of unwitnessed claim this repository treats as
 * worse than none.
 */
export function dispositionedPaths(repo = REPO_ROOT) {
  const dir = join(repo, "docs", "proposals");
  const claimed = new Map();
  if (!existsSync(dir)) return claimed;
  for (const name of readdirSync(dir).sort()) {
    if (!/^operator-decisions-.*\.md$/.test(name)) continue;
    const text = readFileSync(join(dir, name), "utf8");
    for (const match of text.matchAll(ARISES_FROM)) {
      for (const path of match[1].split(/[,\s]+/).filter(Boolean)) {
        if (!claimed.has(path)) claimed.set(path, []);
        claimed.get(path).push(`docs/proposals/${name}`);
      }
    }
  }
  return claimed;
}

export function analyzeAuditDisposition({ repo = REPO_ROOT } = {}) {
  const documents = auditDocuments(repo);
  const claimed = dispositionedPaths(repo);

  const dispositioned = [];
  const noneRequired = [];
  const undispositioned = [];
  for (const doc of documents) {
    if (claimed.has(doc.path)) dispositioned.push({ ...doc, by: claimed.get(doc.path) });
    else if (doc.none_required) noneRequired.push(doc);
    else undispositioned.push(doc);
  }

  // A decisions file citing an audit document that does not exist is a broken
  // reference, and it points the wrong way: it makes a document look answered
  // for when nothing answers for it.
  const knownPaths = new Set(documents.map((d) => d.path));
  const dangling = [...claimed.entries()]
    .filter(([path]) => !knownPaths.has(path))
    .map(([path, by]) => ({ path, by }));

  return {
    ok: undispositioned.length === 0 && dangling.length === 0,
    total: documents.length,
    dispositioned,
    none_required: noneRequired,
    undispositioned,
    dangling,
  };
}

export function main() {
  const report = analyzeAuditDisposition();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  console.log(`audit-disposition — ${report.total} durable audit document(s)\n`);
  console.log(`  answered by a decision : ${report.dispositioned.length}`);
  console.log(`  declared none-required : ${report.none_required.length}`);
  console.log(`  UNDISPOSITIONED        : ${report.undispositioned.length}\n`);

  if (report.undispositioned.length > 0) {
    console.log("An audit ran and nobody answered for what it found:");
    for (const doc of report.undispositioned) console.log(`  ${doc.path}`);
    console.log("");
    console.log("  Either record a decision arising from it in a");
    console.log("  docs/proposals/operator-decisions-<date>.md file, marking the link with");
    console.log("    <!-- arises-from: audit/<file>.md -->");
    console.log("  so gate:decision-queue starts tracking it — or, if the document genuinely");
    console.log("  needs no decision (a census, a reference capture, a root cause already");
    console.log("  fixed), declare that in the document itself:");
    console.log("    <!-- audit-disposition: none-required — <reason> -->");
    console.log("");
    console.log("  Declaring none-required is a real answer and an honest one. Leaving a");
    console.log("  document undispositioned is what puts findings in a transcript and");
    console.log("  nowhere else.\n");
  }

  if (report.dangling.length > 0) {
    console.log("A decisions file cites an audit document that does not exist:");
    for (const d of report.dangling) console.log(`  ${d.path}  (cited by ${d.by.join(", ")})`);
    console.log("  This points the wrong way — it makes a document look answered for.\n");
  }

  console.log(report.ok ? "PASS" : "FAIL");
  return report.ok ? 0 : 1;
}

if (resolvePath(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
