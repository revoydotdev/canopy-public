/**
 * documents.ts — derive the set of documents SUR-05 checks for count drift.
 *
 * The list used to be three hand-picked paths. That reproduced, one level up,
 * the exact defect this module family exists to catch: a fact about the
 * repository (which documents make counted claims) maintained by hand and
 * drifting the moment somebody added a document. A 2026-08-06 sweep found 57
 * drifted claims across 117 markdown files while the configured set was
 * checking three of them.
 *
 * So the set is derived from the repository on every call. Two categories are
 * excluded, and the reason each is excluded matters more than the list:
 *
 *   1. TEST FIXTURES (`packages/<pkg>/tests/**`). A fixture like
 *      `counts/fixtures/drifted-claims.md` is *deliberately* wrong — it is
 *      the input that proves the checker detects drift. Checking it would
 *      report its intended content as a defect and make the checker's own
 *      test suite unsatisfiable.
 *
 *   2. DATED LEDGERS (`HISTORICAL_LEDGER_PREFIXES`). An audit report records
 *      what was measured on the day it ran. Its numbers are evidence, not
 *      claims about today, and "correcting" them would falsify the record —
 *      the audit ledger is append-only for the same reason the evidence
 *      ledger is. These are excluded wholesale rather than line-marked
 *      because *every* number in them is historical by construction.
 *
 * A single historical line inside an otherwise-live document is a different
 * case, handled by `HISTORICAL_CLAIM_MARKER` in check.ts — see ROADMAP.md's
 * gap-register audit-condition line for the canonical example.
 *
 * Purity: a pure function of `repoRoot`'s on-disk content, matching
 * derive.ts's guarantee. No clock, no env, no network.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Roots scanned for counted claims. Source files are included because a claim
 * in a code comment drifts exactly like a claim in prose — `tools.ts` carried
 * a stale "~30 hand-written per-kind tools" for months. sur-05:historical (illustrative)
 */
export const COUNT_DRIFT_SCAN_ROOTS: readonly string[] = [
  ".",              // root-level *.md only (not recursive — see walk())
  "docs",
  "decisions",
  ".claude/skills",
  "packages",
];

/**
 * Path prefixes whose numbers are dated evidence rather than live claims.
 * Every entry is a report or ledger that records a measurement taken on a
 * specific date; rewriting those numbers would destroy the record.
 */
export const HISTORICAL_LEDGER_PREFIXES: readonly string[] = [
  "audit/",
  "docs/adr-governance-audit/",
  "docs/skunkworks/",
  "docs/first-principles-audit-report.md",
  "docs/ADR-completion-audit-review.md",
  "docs/full-harness-ownership-brief.md",
  "docs/clean-room-audit-report.md",
  "docs/clean-room-research-report.md",
  "docs/terminal-emulator-clean-room-report.md",
  "docs/review-package.md",
  "docs/tui-cockpit/phase-0-baseline.md",
];

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "coverage", ".visual-intelligence"]);

function isCheckableExtension(name: string): boolean {
  return name.endsWith(".md") || (name.endsWith(".ts") && !name.endsWith(".d.ts"));
}

/** A fixture is an input to a test, not a claim about the repository. */
function isTestFixture(repoRelative: string): boolean {
  const parts = repoRelative.split("/");
  return parts[0] === "packages" && parts.includes("tests");
}

function isHistoricalLedger(repoRelative: string): boolean {
  return HISTORICAL_LEDGER_PREFIXES.some(
    (prefix) => repoRelative === prefix || repoRelative.startsWith(prefix),
  );
}

function walk(repoRoot: string, dir: string, recursive: boolean, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries.sort()) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(dir, entry);

    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      if (recursive) walk(repoRoot, full, true, out);
      continue;
    }

    if (!isCheckableExtension(entry)) continue;
    const repoRelative = relative(repoRoot, full).split(sep).join("/");
    if (isTestFixture(repoRelative) || isHistoricalLedger(repoRelative)) continue;
    out.push(repoRelative);
  }
}

/**
 * Every document and source file whose counted claims should agree with the
 * live repository, sorted for determinism. Calling this twice against the
 * same checkout returns a deep-equal result.
 */
export function deriveCountDriftDocuments(repoRoot: string): string[] {
  const found: string[] = [];
  for (const root of COUNT_DRIFT_SCAN_ROOTS) {
    // "." contributes root-level files only; every other root is recursive.
    walk(repoRoot, root === "." ? repoRoot : join(repoRoot, root), root !== ".", found);
  }
  return [...new Set(found)].sort();
}
