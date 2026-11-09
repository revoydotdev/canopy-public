#!/usr/bin/env -S node
/**
 * scripts/gap-status-gate.ts — the gap-register status consistency gate
 * (SUR-06).
 *
 * Usage:
 *   bun scripts/gap-status-gate.ts          # human-readable report
 *   bun scripts/gap-status-gate.ts --json   # machine-readable report
 *   bun run gate:gap-status                 # wired via package.json
 *
 * WHY THIS EXISTS. ROADMAP.md's "Verified gap register" header note
 * documents that `gate:docs-truth` validates a row's citations, duplicate
 * IDs, and reachability claims, but explicitly does "not validate
 * gap-register rows" for STATUS drift — a row (or a mention of that row's
 * gap id elsewhere in the corpus) can describe a state the row itself no
 * longer holds, and nothing failed the build. Four rows drifted this way
 * for 8-12 commits before an audit caught them (G-02, G-09, G-17, G-30);
 * G-36 repeated the exact shape — ROADMAP.md marked it OPEN while
 * docs/release-readiness.md marked it closed and a passing test proved it
 * closed. This gate is the mechanism the register's own note names as the
 * remedy: `@arbor/governance`'s `checkGapStatusConsistency`
 * (packages/arbor-governance/src/gap-status/check.ts) compares every
 * G-NN status assertion found in ROADMAP.md's own prose, its own body's
 * cited docs/release-readiness.md, and audit/*.md against ROADMAP.md's
 * register rows, and fails on any contradiction.
 *
 * HONEST STRENGTH — read this before trusting a green run: this gate
 * proves the corpus does NOT CONTRADICT ITSELF about a gap's status. It
 * does NOT prove a register row's own status is CORRECT — ROADMAP.md's
 * register is trusted as ground truth here, and a row that is itself stale
 * with nothing elsewhere in the corpus contradicting it passes silently.
 * It also only recognizes a narrow, deliberately conservative set of
 * status-assertion phrasings (see mentions.ts's header) — missing a real
 * contradiction is the safe failure mode this gate accepts; inventing one
 * is not, and it does not.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkGapStatusConsistency,
  deriveGapStatusScanDocuments,
  parseGapRegister,
  GAP_REGISTER_DOCUMENT,
} from "@arbor/governance";

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * `--repo <path>` exists so this gate can be run against a fixture repository
 * rather than only its own checkout (branch-accounting.mjs sets the precedent).
 * Inert when absent: with no flag the root is exactly what it always was.
 */
function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}
const REPO_ROOT = resolvePath(argValue("--repo") ?? resolvePath(__dirname, ".."));
const JSON_OUTPUT = process.argv.includes("--json");
const AT = new Date().toISOString();

function main(): number {
  const roadmapText = readFileSync(resolvePath(REPO_ROOT, GAP_REGISTER_DOCUMENT), "utf8");
  const register = parseGapRegister(roadmapText);
  const documents = deriveGapStatusScanDocuments(REPO_ROOT);
  const findings = checkGapStatusConsistency(REPO_ROOT, documents, register, { at: AT });

  if (JSON_OUTPUT) {
    console.log(
      JSON.stringify(
        {
          ok: findings.length === 0,
          registerRowsChecked: register.rows.length,
          documentsScanned: documents.length,
          findings,
        },
        null,
        2,
      ),
    );
    return findings.length === 0 ? 0 : 1;
  }

  console.log(
    `gate:gap-status — ${register.rows.length} register row(s) in ${GAP_REGISTER_DOCUMENT}, ` +
      `${documents.length} document(s) scanned for status assertions`,
  );
  console.log("");
  if (findings.length > 0) {
    console.log(`${findings.length} contradiction(s):`);
    for (const finding of findings) console.log(`  - ${finding.detail}\n    ${finding.remediation}`);
    console.log("");
  }

  console.log(
    "  Strength: this gate proves the corpus does NOT CONTRADICT ITSELF about a gap's",
  );
  console.log(
    "  status. It does NOT prove a register row's own status is CORRECT — a stale row with",
  );
  console.log(
    "  nothing elsewhere in the corpus contradicting it passes silently. Detection is also",
  );
  console.log(
    "  deliberately narrow (see mentions.ts): a real contradiction phrased outside its",
  );
  console.log(
    "  recognized patterns is missed, not flagged — that is the accepted failure direction.",
  );
  console.log("");

  console.log(findings.length === 0 ? "PASS" : `FAIL — ${findings.length} status contradiction(s) found`);
  return findings.length === 0 ? 0 : 1;
}

process.exit(main());
