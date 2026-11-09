#!/usr/bin/env node
/**
 * scripts/evidence-transaction-observability-gate.mjs — ADR-092 Decision §5's
 * required `gate:evidence-transaction-observability`.
 *
 * ADR-092 extends the evidence transaction lease (`scripts/evidence-
 * transaction.mjs`) with a durable, versioned lifecycle observation contract:
 * a closed phase vocabulary, a structured heartbeat, an armed/unarmed
 * deadline, a redacted child-process projection, and a terminal outcome
 * recorded before cleanup/release. This is the acceptance-blocking check
 * Decision §5 requires: it runs the isolated transaction fixture suite as a
 * real subprocess (never re-implements the assertions here), then performs a
 * handful of direct, fast structural checks the fixture suite does not
 * already cover as a single assertion (fresh-acquire schema shape, the
 * closed lifecycle-phase vocabulary, and this gate's own package.json /
 * execution-profile.json enrollment).
 *
 * Usage:
 *   bun scripts/evidence-transaction-observability-gate.mjs          human-readable report
 *   bun scripts/evidence-transaction-observability-gate.mjs --json   machine-readable report
 *   bun run gate:evidence-transaction-observability                  once package.json is wired
 *
 * Known, explicitly out-of-scope gap this gate does NOT claim to cover: the
 * ADR-092 Decision §4/§5 requirement that runtime/API, TUI, web, and
 * ADR-091's finalization progress projections all parse to the SAME semantic
 * status object as this gate's CLI/JSON output. That parity depends on
 * `packages/arbor-mcp/` (ADR-093's ownership this tranche) and
 * `scripts/finalize.mjs`/`scripts/enforcement-control-plane.mjs` (ADR-091/
 * 108's ownership this tranche) — files outside this gate's file ownership.
 * `evidenceTransactionStatus` is the single projection those consumers must
 * call; wiring them to it is follow-on work this gate cannot itself perform
 * or verify without touching files it does not own.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIFECYCLE_PHASES, TERMINAL_OUTCOMES, acquireEvidenceTransaction } from "./evidence-transaction.mjs";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

// `--repo` is a fixture seam only (see `guard:canaries`): it points this gate's
// fixture-suite cwd and its package.json / execution-profile.json enrollment
// reads at a throwaway root so a canary can prove the enrollment leg is able to
// fail. Absent the flag, behaviour is byte-identical to the previous constant.
const REPO_ROOT = resolve(argValue(process.argv, "--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const GATE_NAME = "gate:evidence-transaction-observability";
const TEST_FILES = [
  "scripts/tests/evidence-transaction-lifecycle.test.mjs",
  "scripts/tests/evidence-transaction-schema.test.mjs",
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

/**
 * A schema check the fixture suite exercises indirectly, made explicit here
 * as one direct assertion: a freshly acquired lease is schema_version 2,
 * carries the full lifecycle envelope (heartbeat sequence 1, all three
 * children pending, deadline unarmed, terminal null), and its `transition`
 * only accepts the closed phase vocabulary this file itself uses.
 */
function checkFreshAcquireShape() {
  const repo = mkdtempSync(join(tmpdir(), "revoy2-evtx-gate-shape-"));
  const findings = [];
  try {
    const runGit = (args) => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
      }
    };
    runGit(["init", "-q"]);
    runGit(["config", "user.email", "gate@example.invalid"]);
    runGit(["config", "user.name", "Gate"]);
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    runGit(["add", "."]);
    // A developer may have a global hooksPath (including revoy2's managed
    // launcher). This hermetic fixture is not a revoy2 checkout, so inherited
    // hooks must not decide whether its seed commit exists.
    runGit(["-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
    const lease = acquireEvidenceTransaction({ repo, transactionId: "gate-shape-tx" });
    try {
      if (lease.state.schema_version !== 2) findings.push(`fresh acquire schema_version is ${lease.state.schema_version}, expected 2`);
      if (lease.state.kind !== "revoy2.evidence_transaction_lifecycle") findings.push(`fresh acquire kind is ${JSON.stringify(lease.state.kind)}`);
      if (lease.state.lifecycle?.heartbeat?.sequence !== 1) findings.push("fresh acquire does not start heartbeat sequence at 1");
      if (lease.state.lifecycle?.deadline?.status !== "unarmed") findings.push("fresh acquire does not start with an unarmed deadline");
      if (lease.state.lifecycle?.terminal !== null) findings.push("fresh acquire does not start with a null terminal");
      for (const name of ["setup", "build", "producer"]) {
        if (lease.state.lifecycle?.children?.[name]?.status !== "pending") findings.push(`fresh acquire child "${name}" is not pending`);
      }
      if (!LIFECYCLE_PHASES.includes("acquired")) findings.push("LIFECYCLE_PHASES does not declare the initial acquired phase");
      for (const phase of ["snapshot_prepared", "dependency_install", "candidate_build", "producer_running", "normalizing_evidence", "atomic_publish", "completed", "failed", "timed_out", "cancelled"]) {
        if (!LIFECYCLE_PHASES.includes(phase)) findings.push(`LIFECYCLE_PHASES is missing required phase "${phase}"`);
      }
      for (const outcome of ["succeeded", "failed", "timed_out", "cancelled"]) {
        if (!TERMINAL_OUTCOMES.includes(outcome)) findings.push(`TERMINAL_OUTCOMES is missing required outcome "${outcome}"`);
      }
    } finally {
      lease.release();
    }
  } catch (error) {
    findings.push(`fresh-acquire probe threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Decision §5: "absence... or an unenrolled profile is blocking." This gate
 * must itself be reachable as `bun run gate:evidence-transaction-
 * observability` and selected as required in both prepush and CI. This is a
 * read-only check — package.json and execution-profile.json are the
 * orchestrator's files this tranche (see the file header), so a failing
 * result here names exactly the entries still owed, it does not add them.
 */
function checkEnrollment() {
  const findings = [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
  } catch (error) {
    return { ok: false, findings: [`could not read package.json: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const script = pkg.scripts?.[GATE_NAME];
  if (typeof script !== "string" || !script.includes("evidence-transaction-observability-gate.mjs")) {
    findings.push(`package.json "scripts" is missing a "${GATE_NAME}" entry pointing at scripts/evidence-transaction-observability-gate.mjs`);
  }
  let profile;
  try {
    profile = JSON.parse(readFileSync(resolve(REPO_ROOT, "scripts/execution-profile.json"), "utf8"));
  } catch (error) {
    return { ok: false, findings: [...findings, `could not read scripts/execution-profile.json: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const entry = profile.gates?.[GATE_NAME];
  if (!entry) {
    findings.push(`scripts/execution-profile.json "gates" is missing a "${GATE_NAME}" entry`);
  } else {
    if (entry.contexts?.prepush !== true) findings.push(`"${GATE_NAME}" is not selected in the prepush context`);
    if (entry.contexts?.ci !== true) findings.push(`"${GATE_NAME}" is not selected in the ci context`);
    if (entry.required !== true) findings.push(`"${GATE_NAME}" is not marked required`);
    if (entry.scope !== "self") findings.push(`"${GATE_NAME}" does not declare scope: "self" (ADR-108) — its subject, the evidence-refresh lock under .git/arbor/, exists only in this repository's own governed tree`);
  }
  return { ok: findings.length === 0, findings };
}

function main() {
  const json = process.argv.includes("--json");
  const fixtures = runFixtures();
  const shape = checkFreshAcquireShape();
  const enrollment = checkEnrollment();
  const ok = fixtures.ok && shape.ok && enrollment.ok;

  if (json) {
    process.stdout.write(`${JSON.stringify({ gate: "evidence-transaction-observability", ok, fixtures, shape, enrollment }, null, 2)}\n`);
  } else {
    console.log("evidence-transaction-observability gate (ADR-092 §5) — BLOCKING");
    console.log("");
    console.log(`  fixtures    ${fixtures.ok ? "PASS" : "FAIL"}  ${TEST_FILES.join(", ")}`);
    if (!fixtures.ok) console.log(fixtures.detail);
    console.log(`  shape       ${shape.ok ? "PASS" : "FAIL"}${shape.ok ? "" : `\n${shape.findings.map((f) => `    - ${f}`).join("\n")}`}`);
    console.log(`  enrollment  ${enrollment.ok ? "PASS" : "FAIL"}${enrollment.ok ? "" : `\n${enrollment.findings.map((f) => `    - ${f}`).join("\n")}`}`);
    console.log("");
    console.log(ok ? "PASS" : "FAIL");
  }
  process.exit(ok ? 0 : 1);
}

main();
