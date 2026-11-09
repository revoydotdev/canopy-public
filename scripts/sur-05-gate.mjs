#!/usr/bin/env node
/**
 * gate:sur-05 — run SUR-05's document count-drift check as a GATE.
 *
 * CD-D-12: this check lived only as an assertion inside
 * `packages/arbor-governance/tests/counts/check.test.ts`, so it was in no
 * `gate:*` script and in no context of `scripts/execution-profile.json`. A
 * check that runs only inside a unit test is a check that does not run, and
 * the proof is not theoretical: at the commit this gate was written against,
 * that assertion was RED — `derive.test.ts` expected `catalog_kinds` 163 and
 * received 0, because the manifest had moved behind a re-export alias — and
 * nothing outside the test runner noticed. Both failures were reachable by
 * `bun test` and invisible to `git push`.
 *
 * Every run prints the measured quantities and how many documents were scanned
 * before printing any verdict. A gate that reports "no drift" while having
 * observed nothing is `gate:hollow-parity`'s shape (CD-H-01) reproduced here,
 * so the empty-input case exits non-zero rather than green.
 *
 * Exit 0 = no drifted claim. Exit 1 = at least one drifted claim, or the scan
 * observed nothing it can stand behind.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCounts, findExemptedClaims } from "../packages/arbor-governance/src/counts/check.ts";
import { deriveRepositoryCounts } from "../packages/arbor-governance/src/counts/derive.ts";
import { deriveCountDriftDocuments } from "../packages/arbor-governance/src/counts/documents.ts";
import { profileOrDefaults } from "./lib/project-profile.mjs";

const AT = "1970-01-01T00:00:00.000Z";

export function runSur05(repoRoot, options = {}) {
  const profile = profileOrDefaults(repoRoot);
  const counts = deriveRepositoryCounts(repoRoot, {
    sourceRoots: profile.source_roots,
    decisionsDir: profile.governance.decisions_dir,
    allowlistPath: profile.governance.allowlist_path,
  });
  const documents = deriveCountDriftDocuments(repoRoot);
  const findings = checkCounts(repoRoot, documents, counts, { at: AT });
  const exempted = findExemptedClaims(repoRoot, documents);
  const unmeasured = counts.unmeasured.filter((quantity) => quantity !== "test_count");

  const blocking = [];
  if (documents.length === 0) blocking.push("the document walk returned nothing: SUR-05 would report PASS while observing no document at all");
  for (const quantity of unmeasured) {
    blocking.push(`${quantity} is unmeasured, so claims about it are unchecked — a source this gate could not read is not a source with a count of zero`);
  }

  return { counts, documents, findings, exempted, unmeasured, blocking, explain: options.explain === true };
}

function main(argv) {
  // `--root` is a reporting seam only, inert when the flag is absent: it
  // selects which tree the document claims are checked against, so
  // `guard:canaries` can point this gate at a fixture. The findings are still
  // `runSur05`'s own return value.
  const rootIndex = argv.indexOf("--root");
  const repoRoot = resolve(rootIndex >= 0 && argv[rootIndex + 1] ? argv[rootIndex + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."));
  const result = runSur05(repoRoot, { explain: argv.includes("--explain") });

  console.log(`sur-05: ${result.documents.length} documents scanned, ${result.findings.length} drifted claim(s), ${result.exempted.length} historical-marker exemption(s)`);
  for (const [quantity, value] of Object.entries(result.counts)) {
    if (quantity === "unmeasured") continue;
    console.log(`  ${quantity.padEnd(18)} ${value}`);
  }
  if (result.explain) {
    console.log("  exemptions (line carries sur-05:historical):");
    for (const e of result.exempted) console.log(`    ${e.document}:${e.line}`);
  }

  for (const problem of result.blocking) console.error(`sur-05: cannot certify: ${problem}`);
  for (const finding of result.findings) {
    console.error(`sur-05: ${finding.detail}`);
    console.error(`  -> ${finding.remediation}`);
  }

  if (result.blocking.length > 0 || result.findings.length > 0) {
    if (result.findings.length > 0 && result.blocking.length === 0) {
      console.error("sur-05: remedy per line above — correct the number, or mark a deliberately dated line with `sur-05:historical` and say why.");
    }
    return 1;
  }
  console.log("sur-05: no drifted count claims");
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
