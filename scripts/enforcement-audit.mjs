#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadExecutionProfile } from "./enforcement-control-plane.mjs";

/**
 * Local battery measurements, merged UNDER the CI aggregate report.
 *
 * ADR-147 decision 9 promised this column would carry last measured costs with
 * no blank cells. Only CI ever produced a report, and it is gitignored with 30
 * day retention, so on a working clone every contract read `unmeasured`.
 * `gate-all.mjs` now writes what it measures to `measured-costs.json`, which is
 * local evidence and never authoritative: where CI has a figure, CI wins.
 */
export function gateContractRows(registry, report = null, localCosts = null) {
  const measured = new Map(Object.entries(localCosts?.gates ?? {}).map(([gate, entry]) => [gate, entry.duration_ms]));
  for (const gate of report?.gates ?? []) measured.set(gate.gate, gate.duration_ms);
  return Object.entries(registry.gates).sort(([left], [right]) => left.localeCompare(right)).map(([gate, contract]) => ({
    gate,
    effect: contract.effect,
    resource_class: contract.resource_class,
    mutability: contract.mutability,
    cost_class: contract.cost_class,
    timeout_ms: contract.timeout_ms,
    contexts: Object.entries(contract.contexts).filter(([, selected]) => selected).map(([context]) => context).join(",") || "operator-only",
    prerequisites: contract.prerequisites.join(",") || "none",
    last_duration_ms: measured.has(gate) ? measured.get(gate) : "unmeasured",
  }));
}

export function main() {
  const json = process.argv.includes("--json");
  const reportFlag = process.argv.indexOf("--report");
  const reportPath = resolve(reportFlag >= 0 ? process.argv[reportFlag + 1] : ".arbor/enforcement/aggregate-report.json");
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
  const localPath = resolve(".arbor/enforcement/measured-costs.json");
  let localCosts = null;
  try { localCosts = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : null; } catch { localCosts = null; }
  const rows = gateContractRows(loadExecutionProfile(), report, localCosts);
  if (json) console.log(JSON.stringify({ ok: true, report: report ? reportPath : null, local_costs: localCosts ? localPath : null, gates: rows }, null, 2));
  else console.table(rows);
  return 0;
}

if (import.meta.main) process.exitCode = main();
