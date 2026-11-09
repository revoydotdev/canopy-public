// Canary driver. `guard-canaries.mjs` spawns with cwd = the real repository,
// so the gate under test is resolved from there rather than hardcoded and the
// fixture stays machine-independent. Only the reporting wrapper (print + exit
// code) lives here; every verdict is the gate module's own return value.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { runSur05 } = await import(pathToFileURL(join(process.cwd(), "scripts", "sur-05-gate.mjs")).href);

const result = runSur05(process.argv[2]);
console.log(`sur-05: ${result.documents.length} documents scanned, ${result.findings.length} drifted claim(s)`);
for (const problem of result.blocking) console.error(`sur-05: cannot certify: ${problem}`);
for (const finding of result.findings) console.error(`sur-05: ${finding.detail}`);
process.exit(result.blocking.length > 0 || result.findings.length > 0 ? 1 : 0);
