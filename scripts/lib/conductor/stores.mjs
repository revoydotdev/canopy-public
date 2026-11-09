import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./git.mjs";
import { regenerationMarkerPath } from "../store-provenance.mjs";

export const STORE_REFRESH_COMMANDS = [
  { name: "claim-ledger", command: "bun", args: ["run", "claims:refresh"] },
  { name: "determinism-baseline", command: "bun", args: ["run", "determinism:refresh"] },
  { name: "completion-depth", command: "bun", args: ["run", "completion-depth:refresh"] },
  { name: "vi-observed", command: "bun", args: ["run", "vi:observe"] },
];

export function regenerateStores(repo, commands = STORE_REFRESH_COMMANDS, options = {}) {
  const marker = options.markerPath ?? regenerationMarkerPath(repo);
  const startedAt = new Date().toISOString();
  const writeMarker = (phase, extra = {}) => writeFileSync(
    marker,
    `${JSON.stringify({ pid: process.pid, started_at: startedAt, phase, ...extra })}\n`,
    { flag: existsSync(marker) ? "w" : "wx" },
  );
  writeMarker("producing");
  const results = [];
  try {
    for (const entry of commands) {
      const result = run(entry.command, entry.args, { cwd: repo, allowFailure: true, inherit: entry.inherit ?? true, env: entry.env });
      results.push({ name: entry.name, ok: result.ok, status: result.status, stdout: result.stdout, stderr: result.stderr });
      if (!result.ok) {
        writeMarker("failed", { failed_producer: entry.name, status: result.status });
        return { ok: false, results, marker };
      }
    }
    // The freshness gate must run without the marker: markers are globally
    // fail-closed, including for their owner. If validation fails, restore a
    // durable failed marker so an interrupted/invalid transaction cannot be
    // mistaken for trustworthy evidence.
    rmSync(marker, { force: true });
    const gate = existsSync(join(repo, "scripts", "store-freshness-gate.mjs"))
      ? run("bun", ["scripts/store-freshness-gate.mjs", "--json"], { cwd: repo, allowFailure: true })
      : { ok: true, status: 0, stdout: "", stderr: "" };
    if (!gate.ok) writeMarker("failed", { failed_gate: "store-freshness", status: gate.status });
    return { ok: gate.ok, results, marker: gate.ok ? null : marker, gate: { ok: gate.ok, status: gate.status, stdout: gate.stdout, stderr: gate.stderr } };
  } catch (error) {
    writeMarker("failed", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
