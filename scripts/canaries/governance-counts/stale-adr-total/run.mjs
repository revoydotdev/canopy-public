// Canary driver. `guard-canaries.mjs` spawns with cwd = the real repository,
// so the gate under test is resolved from there rather than hardcoded and the
// fixture stays machine-independent. Only the reporting wrapper lives here;
// `renderGovernanceCounts` is the gate module's own exported body and returns
// the verdict.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { renderGovernanceCounts } = await import(
  pathToFileURL(join(process.cwd(), "scripts", "render-governance-counts.mjs")).href
);

const result = renderGovernanceCounts(process.argv[2], { check: true });
if (!result.ok) {
  console.error(`governance counts are stale in: ${result.changed.join(", ")}`);
  console.error("run `bun run governance:render`, stage the rendered files, and retry");
} else {
  console.log("governance counts already match derivation");
}
process.exit(result.ok ? 0 : 1);
