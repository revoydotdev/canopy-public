#!/usr/bin/env node
/**
 * scripts/campaign-run-status-gate.mjs — ADR-093 Decision §5's required
 * `gate:campaign-run-status`.
 *
 * ADR-093 authorizes one canonical, durable campaign-run execution-status
 * projection: `packages/arbor-mcp/src/campaign-run-attempt-index.ts` (the
 * one new durable record — attempt identity/lineage) and
 * `packages/arbor-mcp/src/campaign-run-status-projection.ts`
 * (`projectCampaignRunStatus`, the sole status constructor). This gate is
 * the acceptance-blocking check Decision §5 requires before the ADR may be
 * accepted: it runs the isolated, persistence-backed fixture suite as a
 * real subprocess (never re-implements the assertions here) and confirms
 * the projection is actually wired into `ArborRuntime` rather than merely
 * existing alongside it.
 *
 * What it checks:
 *   1. The three fixture/integration test files pass under vitest:
 *        - campaign-run-attempt-index.test.ts (attempt identity, ordinal
 *          uniqueness, idempotent replay, supersession admission rule,
 *          durable round-trip, corruption diagnostics)
 *        - campaign-run-status-projection.test.ts (queued vs started vs
 *          refused, progress/terminal/cancel-request state machine,
 *          restart reconciliation + preserved terminal-cancelled attempt,
 *          supersession without mutation, deterministic ordering,
 *          redaction)
 *        - campaign-run-status-runtime.test.ts (the real `ArborRuntime`
 *          surface: `runCampaignJob` appends the durable attempt before a
 *          run is observable, `getCampaignRunStatus` reads it back)
 *   2. `ArborRuntime` genuinely wires `campaignRunAttempts` and
 *      `getCampaignRunStatus` (registration-integrity spot check — a
 *      passing test suite that imports the module directly would not by
 *      itself prove the runtime's own composition root uses it).
 *   3. `packages/arbor-mcp/src/index.ts` exports the projector and index so
 *      a CLI/TUI/web adapter can reach them without a private import path.
 *
 * Known, explicitly out-of-scope gap this gate does NOT claim to cover
 * (see the ADR-093 implementation report for the full boundary): Decision
 * §2's `heartbeat` state (requires a `SupervisorTask` timestamp/sequence
 * extension owned by `packages/arbor-core/src/task-supervisor.ts`, a file
 * outside this tranche's ownership) and Decision §4's CLI/TUI/web parity
 * suite (those adapters are explicitly a later tranche's ownership per the
 * ADR-093 implementation brief). This gate is honest about checking only
 * what this tranche built; it does not claim ADR-093 is fully accepted.
 *
 * Usage:
 *   bun scripts/campaign-run-status-gate.mjs          human-readable report
 *   bun scripts/campaign-run-status-gate.mjs --json   machine-readable report
 *
 * Wiring this lane could NOT do itself (package.json and
 * scripts/execution-profile.json are owned by the orchestrator this
 * tranche, not this lane) — see the ADR-093 implementation report for the
 * exact entries.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `--repo <path>` exists so this gate can be run against a fixture repository
// rather than only its own checkout (branch-accounting.mjs sets the precedent).
// Inert when absent: with no flag the root is exactly what it always was.
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

const REPO_ROOT = resolve(argValue("--repo") ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const TEST_FILES = [
  "packages/arbor-mcp/tests/campaign-run-attempt-index.test.ts",
  "packages/arbor-mcp/tests/campaign-run-status-projection.test.ts",
  "packages/arbor-mcp/tests/campaign-run-status-runtime.test.ts",
];

function runFixtures() {
  try {
    const output = execFileSync("bunx", ["vitest", "run", ...TEST_FILES], { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8" });
    return { ok: true, detail: output.slice(-4000) };
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
    return { ok: false, detail: output.slice(-4000) };
  }
}

function checkRuntimeWiring() {
  const source = readFileSync(resolve(REPO_ROOT, "packages/arbor-mcp/src/runtime.ts"), "utf8");
  const findings = [];
  if (!source.includes("campaignRunAttempts: CampaignRunAttemptIndex")) findings.push("ArborRuntime does not declare a `campaignRunAttempts: CampaignRunAttemptIndex` field");
  if (!source.includes("new CampaignRunAttemptIndex(")) findings.push("ArborRuntime does not instantiate CampaignRunAttemptIndex");
  if (!source.includes("this.campaignRunAttempts.recordAttempt(")) findings.push("runCampaignJob does not record a durable attempt before dispatch");
  if (!source.includes("this.campaignRunAttempts.recordRefusal(")) findings.push("runCampaignJob does not record a durable refusal for its typed-absence paths");
  if (!source.includes("getCampaignRunStatus(")) findings.push("ArborRuntime does not expose a getCampaignRunStatus read method");
  if (!source.includes("projectCampaignRunStatus(")) findings.push("getCampaignRunStatus does not call the canonical projectCampaignRunStatus constructor");
  return { ok: findings.length === 0, findings };
}

function checkExports() {
  const source = readFileSync(resolve(REPO_ROOT, "packages/arbor-mcp/src/index.ts"), "utf8");
  const required = ["CampaignRunAttemptIndex", "projectCampaignRunStatus", "isTerminalSupervisorTaskState"];
  const missing = required.filter((name) => !source.includes(name));
  return { ok: missing.length === 0, missing };
}

function main() {
  const json = process.argv.includes("--json");
  const fixtures = runFixtures();
  const wiring = checkRuntimeWiring();
  const exports = checkExports();
  const ok = fixtures.ok && wiring.ok && exports.ok;

  if (json) {
    process.stdout.write(`${JSON.stringify({ gate: "campaign-run-status", ok, fixtures, wiring, exports }, null, 2)}\n`);
  } else {
    console.log("campaign-run-status gate (ADR-093 §5) — BLOCKING");
    console.log("");
    console.log(`  fixtures  ${fixtures.ok ? "PASS" : "FAIL"}  ${TEST_FILES.join(", ")}`);
    if (!fixtures.ok) console.log(fixtures.detail);
    console.log(`  wiring    ${wiring.ok ? "PASS" : "FAIL"}${wiring.ok ? "" : `\n${wiring.findings.map((f) => `    - ${f}`).join("\n")}`}`);
    console.log(`  exports   ${exports.ok ? "PASS" : "FAIL"}${exports.ok ? "" : `\n${exports.missing.map((m) => `    - missing export: ${m}`).join("\n")}`}`);
    console.log("");
    console.log(ok ? "PASS" : "FAIL");
  }
  process.exit(ok ? 0 : 1);
}

main();
