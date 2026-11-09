#!/usr/bin/env node
/**
 * scripts/projection-lifecycle-gate.mjs — ADR-094 Decision §5's required
 * `gate:projection-lifecycle`, acceptance-blocking per the ADR.
 *
 * ADR-094 requires every operator-facing runtime projection to be carried
 * in a versioned `ProjectionLifecycle<T>` envelope
 * (`packages/arbor-mcp/src/projection-lifecycle.ts`) with freshness
 * budgets registered at a catalog
 * (`packages/arbor-mcp/src/projection-lifecycle-catalog.ts`) rather than
 * invented by renderers. This gate is the acceptance check Decision §5
 * names: it runs the fake-clock fixture suite as a real subprocess (never
 * re-implements the assertions here) and confirms the module is actually
 * exported for CLI/TUI/web adapters to reach.
 *
 * What it checks
 * ---------------
 *   1. The fixture test files pass under vitest:
 *        - projection-lifecycle.test.ts (Decision §5.1's closed-lifecycle
 *          states: never-fetched, loading, empty-ready, ready, stale-by-age,
 *          failed-after-success, unavailable, failed-without-value;
 *          Decision §5.2's retained-value-after-failure invariant;
 *          Decision §5.3's transport/cursor/resync states and bounded
 *          polling budget parity; Decision §5.4's manual refresh
 *          read-only-capability invariant; Decision §5.5's status-chrome
 *          priority classification separating renderer activity from
 *          transport/freshness/resync state; wall-clock anomaly handling)
 *        - projection-lifecycle-catalog.test.ts (Decision §5.6's catalog
 *          coverage of every representative projection class, and
 *          ADR-093's `CampaignRunStatusProjection` carried in the envelope
 *          as the first real domain consumer)
 *   2. `packages/arbor-mcp/src/index.ts` exports the envelope, catalog, and
 *      campaign-run-status wrapper symbols so an adapter can reach them
 *      without a private import path.
 *   3. The envelope module owns no domain-shaped fields (a light source
 *      scan for domain-producer field names that would indicate the
 *      envelope absorbing state it does not own, per the ADR's explicit
 *      "domain payloads stay owned by their canonical producers" boundary).
 *
 * Known, explicitly out-of-scope gap this gate does NOT claim to cover
 * (see the ADR-094 implementation report for the full boundary): Decision
 * §5.6's cross-surface TUI/web parity fixtures and Decision §3's live
 * status-chrome wiring require `packages/arbor-mcp/src/runtime.ts`,
 * `cli.ts`, and `packages/arbor-tui/**` — all explicitly owned by a
 * sibling lane (ADR-107) this tranche, not this one. This gate is honest
 * about checking only the envelope, catalog, and its first wrapped
 * consumer built this tranche; it does not claim ADR-094 is fully wired
 * into a live operator surface yet.
 *
 * Usage:
 *   bun scripts/projection-lifecycle-gate.mjs          human-readable report
 *   bun scripts/projection-lifecycle-gate.mjs --json   machine-readable report
 *
 * Wiring this lane could NOT do itself (package.json and
 * scripts/execution-profile.json are owned by the orchestrator this
 * tranche, not this lane) — see the ADR-094 implementation report for the
 * exact entries.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const REPO_ROOT = resolve(argValue(process.argv, "--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const TEST_FILES = [
  "packages/arbor-mcp/tests/projection-lifecycle.test.ts",
  "packages/arbor-mcp/tests/projection-lifecycle-catalog.test.ts",
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

function checkExports() {
  const source = readFileSync(resolve(REPO_ROOT, "packages/arbor-mcp/src/index.ts"), "utf8");
  // markProjectionResyncRequired, refreshProjection and
  // classifyProjectionStatusPriority were deleted in 1496dcca on the
  // 2026-10-01 operator decision; ADR-094 O3 records them as owed with O2's
  // consumer. Re-add them here when that consumer brings them back.
  const required = [
    "initialProjectionLifecycle",
    "resolveProjectionSuccess",
    "resolveProjectionFailure",
    "markProjectionUnavailable",
    "checkProjectionFreshness",
    "PROJECTION_FRESHNESS_CATALOG",
    "resolveProjectionFreshnessPolicy",
    "projectCampaignRunStatusLifecycle",
  ];
  const missing = required.filter((name) => !source.includes(name));
  return { ok: missing.length === 0, missing };
}

/**
 * Decision, opening paragraph: "this envelope owns only observation,
 * transport, freshness, and resynchronization facts" — it must never
 * declare fields shaped like domain state (campaign/task/approval/evidence
 * identifiers or outcomes) directly on `ProjectionLifecycle<T>` itself. This
 * is a narrow lexical check on the envelope's own interface body, not a
 * general ban on those words elsewhere in the file (comments reference them
 * legitimately).
 */
function checkEnvelopeDoesNotAbsorbDomainState() {
  const source = readFileSync(resolve(REPO_ROOT, "packages/arbor-mcp/src/projection-lifecycle.ts"), "utf8");
  const match = source.match(/export interface ProjectionLifecycle<T> \{([\s\S]*?)\n\}/);
  if (!match) return { ok: false, findings: ["could not locate `export interface ProjectionLifecycle<T> { ... }` to inspect"] };
  const body = match[1];
  const forbiddenFieldNames = ["campaign_id", "attempt_id", "task_id", "approval_id", "evidence_id", "outcome", "reason", "diagnostic_ref", "worker_liveness"];
  const findings = forbiddenFieldNames.filter((name) => new RegExp(`readonly ${name}[?:]`).test(body));
  return { ok: findings.length === 0, findings: findings.map((name) => `ProjectionLifecycle<T> declares a domain-shaped field \`${name}\` directly — domain state must live in \`value: T\` instead`) };
}

function main() {
  const json = process.argv.includes("--json");
  const fixtures = runFixtures();
  const exports = checkExports();
  const envelopeShape = checkEnvelopeDoesNotAbsorbDomainState();
  const ok = fixtures.ok && exports.ok && envelopeShape.ok;

  if (json) {
    process.stdout.write(`${JSON.stringify({ gate: "projection-lifecycle", ok, fixtures, exports, envelopeShape }, null, 2)}\n`);
  } else {
    console.log("projection-lifecycle gate (ADR-094 §5) — BLOCKING");
    console.log("");
    console.log(`  fixtures       ${fixtures.ok ? "PASS" : "FAIL"}  ${TEST_FILES.join(", ")}`);
    if (!fixtures.ok) console.log(fixtures.detail);
    console.log(`  exports        ${exports.ok ? "PASS" : "FAIL"}${exports.ok ? "" : `\n${exports.missing.map((m) => `    - missing export: ${m}`).join("\n")}`}`);
    console.log(`  envelope-shape ${envelopeShape.ok ? "PASS" : "FAIL"}${envelopeShape.ok ? "" : `\n${envelopeShape.findings.map((f) => `    - ${f}`).join("\n")}`}`);
    console.log("");
    console.log("Out of scope this tranche (see header): TUI/web cross-surface parity and live runtime wiring — owned by the ADR-107 lane's runtime.ts/cli.ts/arbor-tui this tranche.");
    console.log("");
    console.log(ok ? "PASS" : "FAIL");
  }
  process.exit(ok ? 0 : 1);
}

main();
