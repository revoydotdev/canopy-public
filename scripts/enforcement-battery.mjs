#!/usr/bin/env node
import { runImmutableBattery } from "./enforcement-control-plane.mjs";

function value(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const context = value("--context", "ci");
const report = await runImmutableBattery({
  context,
  candidate: value("--candidate", "HEAD"),
  repo: value("--repo", process.cwd()),
  registryPath: value("--registry", undefined) ?? undefined,
  preparedSnapshotPath: value("--prepared-snapshot", undefined) ?? undefined,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
