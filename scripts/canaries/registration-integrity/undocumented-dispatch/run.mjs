// Canary driver. `guard-canaries.mjs` spawns with cwd = the real repository,
// so the gate under test is resolved from there rather than hardcoded and the
// fixture stays machine-independent. Only the reporting wrapper lives here;
// `checkCliDispatch` is the gate module's own exported check and returns the
// violations.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { checkCliDispatch } = await import(
  pathToFileURL(join(process.cwd(), "scripts", "registration-integrity.mjs")).href
);

const { violations } = checkCliDispatch(readFileSync(process.argv[2], "utf8"));
for (const violation of violations) console.error(`VIOLATION ${violation.kind}: ${violation.reason}`);
console.log(violations.length === 0 ? "PASS" : `FAIL — ${violations.length} violation(s)`);
process.exit(violations.length === 0 ? 0 : 1);
