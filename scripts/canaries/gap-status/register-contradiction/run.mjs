// Canary driver. `guard-canaries.mjs` spawns with cwd = the real repository,
// so the gate's own detection library is resolved from there — by path, not as
// a bare `@arbor/governance` specifier, because bare specifiers resolve
// against THIS file's location (the scratch), which has no node_modules.
// Only the reporting wrapper lives here; the findings are the library's own
// return value, and the gate script's `main` is that same wrapper with a root
// hardcoded to this checkout.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const {
  checkGapStatusConsistency,
  deriveGapStatusScanDocuments,
  parseGapRegister,
  GAP_REGISTER_DOCUMENT,
} = await import(pathToFileURL(join(process.cwd(), "packages/arbor-governance/src/index.ts")).href);

const root = process.argv[2];
const register = parseGapRegister(readFileSync(join(root, GAP_REGISTER_DOCUMENT), "utf8"));
const documents = deriveGapStatusScanDocuments(root);
const findings = checkGapStatusConsistency(root, documents, register, { at: "1970-01-01T00:00:00.000Z" });

console.log(`gate:gap-status — ${register.rows.length} register row(s), ${documents.length} document(s) scanned`);
for (const finding of findings) console.log(`  - ${finding.detail}\n    ${finding.remediation}`);
console.log(findings.length === 0 ? "PASS" : `FAIL — ${findings.length} status contradiction(s) found`);
process.exit(findings.length === 0 ? 0 : 1);
