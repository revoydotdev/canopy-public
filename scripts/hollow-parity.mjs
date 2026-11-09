#!/usr/bin/env node
/**
 * scripts/hollow-parity.mjs — T5.2 "gates that catch the Hollow shape"
 * (2026-08-23 remediation).
 *
 * The 2026-08-23 audit (audit/2026-08-23-99-report.md §3, 50-defects.md)
 * found that every existing wiring gate (reachability, completion-depth, the
 * VI observed plane) proves symbol EXISTENCE/EXECUTION, while the real
 * defects were wrong data tables, missing branches, wrong constants across
 * boundaries, defaults/orderings, and failures swallowed into success. This
 * script is the single new gate entry point for the deterministic checks
 * this lane could build against that shape:
 *
 *   1. Boundary-constant parity (TS-import-dependent — lives in
 *      packages/arbor-mcp/tests/boundary-parity.test.ts; run as a subprocess
 *      here so `bun scripts/hollow-parity.mjs` alone still proves it).
 *   3. Surface-scoped reachability: which of {CLI, TUI, Web, liveness probe,
 *      MCP-generic} actually produce each RUNTIME_CATALOG kind, failing when
 *      a supported kind is MCP-generic-only and undeclared in
 *      scripts/hollow-parity/api-only.json (WA-35).
 *   5. Branch-coverage signal: a non-failing REPORT of reachable production
 *      functions with uncovered if/switch branches (WA-12's shape), when
 *      coverage/coverage-final.json exists.
 *
 * T5.3 (2026-08-23 remediation) implements the two items T5.2 left
 * undone, against `.visual-intelligence/observed/outcomes.jsonl`
 * (scripts/vi-observe.mjs) and its scenario catalog
 * (scripts/observation/scenarios.json):
 *
 *   2. Outcome-aware observation: fails when a product-surface scenario
 *      (`run_class` tui/web/cli) produced a `validation` outcome —
 *      `--explain` lists each finding.
 *   4. Real-surface VI scenarios: fails when this lane's three real-surface
 *      scenarios (TUI keyboard, CLI stdio junior-tier, webui HTTP) did not
 *      each contribute observations, or when the CLI scenario did not
 *      record the `permission` outcome it exists to prove.
 *
 * Usage:
 *   bun scripts/hollow-parity.mjs             human-readable report
 *   bun scripts/hollow-parity.mjs --json      machine-readable report
 *   bun scripts/hollow-parity.mjs --explain   verbose per-finding detail
 *   bun scripts/hollow-parity-generate.mjs    regenerate the tracked projection
 *   bun scripts/hollow-parity.mjs --skip-vitest  skip the item-1 subprocess (fast local iteration on items 3/5 only)
 *
 * Wiring this lane could NOT do itself (gate-all.mjs/package.json are owned
 * by the orchestrator, not this lane): add
 *   "gate:hollow-parity": "bun scripts/hollow-parity.mjs"
 * to package.json's `scripts`, and an execution-profile.json entry — see
 * this lane's final report for the exact JSON block (the roster gate
 * refuses an unclassified gate, so this script cannot self-register).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRuntimeCatalog, parseLivenessProbedQueryKinds, loadTuiDispositionSurfaceKinds } from "./lib/hollow-parity/catalog.mjs";
import { computeCatalogSurfaces, mcpGenericOnlyKinds, evaluateApiOnlyAllowlist } from "./lib/hollow-parity/surfaces.mjs";
import { listUncoveredBranchFunctions, rankReachableUncoveredBranchFunctions, buildReachableIndex } from "./lib/hollow-parity/branch-coverage.mjs";
import { loadJsonlRows, buildScenarioRunClassIndex, productSurfaceValidationFindings, realSurfaceScenarioFindings } from "./lib/hollow-parity/outcomes.mjs";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const REPO_ROOT = resolve(argValue(process.argv, "--repo") ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));

function argFlag(args, name) {
  return args.includes(name);
}

function runItem1BoundaryParityVitest() {
  const testFile = "packages/arbor-mcp/tests/boundary-parity.test.ts";
  try {
    execFileSync(resolve(REPO_ROOT, "node_modules", ".bin", "vitest"), ["run", testFile], { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8" });
    return { ok: true, testFile, detail: "PASS" };
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
    return { ok: false, testFile, detail: output.slice(-4000) };
  }
}

function runItem3SurfaceScopedReachability() {
  const catalogPath = resolve(REPO_ROOT, "packages/arbor-mcp/src/runtime-catalog.ts");
  const livenessPath = resolve(REPO_ROOT, "packages/arbor-mcp/src/liveness.ts");
  const cliPath = resolve(REPO_ROOT, "packages/arbor-mcp/src/cli.ts");
  const webuiPath = resolve(REPO_ROOT, "packages/arbor-mcp/src/webui.ts");
  const dispositionsPath = resolve(REPO_ROOT, "scripts/tui-catalog-parity/dispositions.json");
  const apiOnlyPath = resolve(REPO_ROOT, "scripts/hollow-parity/api-only.json");
  const outputPath = resolve(REPO_ROOT, "scripts/hollow-parity/catalog-surfaces.json");

  // REPO_ROOT is the workspace root, which the shared parser needs in order to
  // follow the manifest out of arbor-mcp and into `@arbor/core`.
  const catalog = loadRuntimeCatalog(catalogPath, REPO_ROOT);
  const livenessProbedQueryKinds = parseLivenessProbedQueryKinds(readFileSync(livenessPath, "utf8"));
  const tuiKinds = loadTuiDispositionSurfaceKinds(dispositionsPath);
  const cliSource = readFileSync(cliPath, "utf8");
  const webuiSource = readFileSync(webuiPath, "utf8");

  const surfaces = computeCatalogSurfaces({ catalog, cliSource, webuiSource, tuiKinds, livenessProbedQueryKinds });
  const mcpOnly = mcpGenericOnlyKinds(catalog, surfaces);
  const apiOnlyDocument = JSON.parse(readFileSync(apiOnlyPath, "utf8"));
  const { findings, allowlisted, staleAllowlistEntries } = evaluateApiOnlyAllowlist(mcpOnly, apiOnlyDocument);

  return { catalog, surfaces, mcpOnly, findings, allowlisted, staleAllowlistEntries, outputPath };
}

export function buildCatalogSurfacesArtifact(catalog, surfaces) {
  return {
    schema_version: 1,
    generated_by: "scripts/hollow-parity-generate.mjs",
    note: "Committed artefact (T5.2/T5.3). Regenerate with `bun scripts/hollow-parity-generate.mjs`; do not hand-edit.",
    kinds: catalog.map((entry) => ({ kind: entry.kind, direction: entry.direction, supported: entry.supported, surfaces: surfaces[entry.kind] })),
  };
}

export function compareCatalogSurfacesArtifact(outputPath, expected) {
  const rendered = `${JSON.stringify(expected, null, 2)}\n`;
  try {
    const actual = readFileSync(outputPath, "utf8");
    return { ok: actual === rendered, status: actual === rendered ? "current" : "stale", outputPath };
  } catch (error) {
    return { ok: false, status: "unavailable", outputPath, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Items 2 and 4 (T5.3, 2026-08-23 remediation): outcome-aware observation +
 * real-surface VI scenarios, both against `.visual-intelligence/observed/`
 * and its scenario catalog. Absence of the observed store (no one has run
 * `bun run vi:observe` yet) is a real, honest "not run" state — not a
 * silent pass and not a hard failure of this gate, since the observed
 * store is a separately-run, expensive instrument (same convention as item
 * 5's coverage-final.json check above).
 */
function runItem2And4OutcomeAwareObservation() {
  const outcomesPath = resolve(REPO_ROOT, ".visual-intelligence/observed/outcomes.jsonl");
  const observationsPath = resolve(REPO_ROOT, ".visual-intelligence/observed/observations.jsonl");
  const catalogPath = resolve(REPO_ROOT, "scripts/observation/scenarios.json");
  if (!existsSync(outcomesPath) || !existsSync(observationsPath)) {
    return { status: "unavailable", reason: "no observed store — run `bun run vi:observe` first (items 2/4 are checks over its output, not a re-run of it)" };
  }
  const outcomeRows = loadJsonlRows(outcomesPath);
  const observationRows = loadJsonlRows(observationsPath);
  const scenarioRunClasses = buildScenarioRunClassIndex(JSON.parse(readFileSync(catalogPath, "utf8")));

  const item2Findings = productSurfaceValidationFindings(outcomeRows, scenarioRunClasses);
  // The three real-surface scenarios this lane added — see scripts/observation/scenarios.json.
  const item4ScenarioIds = { tui: "tui-real-stdin-scroll-and-select", cli: "cli-serve-junior-tier-denied-mutation", web: "webui-http-surface-9-routes" };
  const item4Findings = realSurfaceScenarioFindings(observationRows, outcomeRows, item4ScenarioIds);

  return { status: "available", item2Findings, item4Findings, item4ScenarioIds, outcomeCount: outcomeRows.length };
}

function runItem5BranchCoverageReport() {
  // A fail-closed override exists for hermetic fixtures and orchestration
  // sandboxes. Pointing it at absent or malformed evidence cannot create a
  // pass; it only makes the item explicitly unavailable or invalid.
  const coveragePath = process.env.REVOY2_HOLLOW_COVERAGE_PATH
    ? resolve(process.env.REVOY2_HOLLOW_COVERAGE_PATH)
    : resolve(REPO_ROOT, "coverage/coverage-final.json");
  if (!existsSync(coveragePath)) {
    return { status: "unavailable", reason: "coverage/coverage-final.json not found — run `bun run gate:coverage` first before hollow-parity can assess branch evidence" };
  }
  let reachableIndex;
  try {
    const reachabilityJson = execFileSync("bun", ["scripts/reachability.mjs", "--json"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(reachabilityJson);
    reachableIndex = buildReachableIndex(parsed.checklist ?? []);
  } catch (error) {
    return { status: "unavailable", reason: `could not run scripts/reachability.mjs --json: ${error.message}` };
  }
  const coverageFinal = JSON.parse(readFileSync(coveragePath, "utf8"));
  const isProductionSourceFile = (filePath) => {
    const normalized = filePath.split(REPO_ROOT + "/").pop() ?? filePath;
    return /^packages\/[^/]+\/src\/.*\.ts$/.test(normalized) && !normalized.includes("/tests/");
  };
  // Normalize coverage-final.json's (often absolute) file keys to
  // repo-relative paths matching reachability's `checklist[].file` shape.
  const normalizedCoverage = {};
  for (const [filePath, entry] of Object.entries(coverageFinal)) {
    const normalized = filePath.startsWith(REPO_ROOT) ? filePath.slice(REPO_ROOT.length + 1) : filePath;
    normalizedCoverage[normalized] = entry;
  }
  const candidates = listUncoveredBranchFunctions(normalizedCoverage, isProductionSourceFile);
  const ranked = rankReachableUncoveredBranchFunctions(candidates, reachableIndex, 50);
  return { status: "available", ranked };
}

function main(args) {
  const json = argFlag(args, "--json");
  const explain = argFlag(args, "--explain");
  const skipVitest = argFlag(args, "--skip-vitest");

  const item1 = skipVitest ? { ok: true, testFile: "packages/arbor-mcp/tests/boundary-parity.test.ts", detail: "SKIPPED (--skip-vitest)" } : runItem1BoundaryParityVitest();
  const item3 = runItem3SurfaceScopedReachability();
  const projection = compareCatalogSurfacesArtifact(item3.outputPath, buildCatalogSurfacesArtifact(item3.catalog, item3.surfaces));
  const item2and4 = runItem2And4OutcomeAwareObservation();
  const item5 = runItem5BranchCoverageReport();

  const blockers = [];
  if (!item1.ok) blockers.push(`item 1 (boundary-constant parity): ${item1.testFile} failed`);
  if (!projection.ok) blockers.push(`catalog-surfaces projection is ${projection.status} — run \`bun scripts/hollow-parity-generate.mjs\``);
  for (const kind of item3.findings) blockers.push(`item 3 (surface-scoped reachability): ${kind} is MCP-generic-only and not declared in scripts/hollow-parity/api-only.json`);
  if (item2and4.status === "available") {
    for (const finding of item2and4.item2Findings) blockers.push(`item 2 (outcome-aware observation): scenario '${finding.scenario}' produced a validation outcome for '${finding.kind}'`);
    for (const finding of item2and4.item4Findings) blockers.push(`item 4 (real-surface VI scenarios): ${finding}`);
  } else blockers.push(`items 2/4 observed evidence is unavailable: ${item2and4.reason}`);
  if (item5.status === "unavailable") blockers.push(`item 5 branch evidence is unavailable: ${item5.reason}`);

  const report = {
    ok: blockers.length === 0,
    blockers,
    item1_boundary_parity: item1,
    catalog_surfaces_projection: projection,
    item2_outcome_aware_observation: item2and4.status === "available"
      ? { implemented: true, status: "available", ok: item2and4.item2Findings.length === 0, outcome_count: item2and4.outcomeCount, findings: item2and4.item2Findings }
      : { implemented: true, status: "unavailable", reason: item2and4.reason },
    item3_surface_scoped_reachability: {
      total_kinds: item3.catalog.length,
      mcp_generic_only_supported_kinds: item3.mcpOnly.length,
      findings: item3.findings,
      allowlisted: item3.allowlisted,
      stale_allowlist_entries: item3.staleAllowlistEntries,
      artefact: item3.outputPath,
    },
    item4_real_surface_scenarios: item2and4.status === "available"
      ? { implemented: true, status: "available", ok: item2and4.item4Findings.length === 0, scenario_ids: item2and4.item4ScenarioIds, findings: item2and4.item4Findings }
      : { implemented: true, status: "unavailable", reason: item2and4.reason },
    item5_branch_coverage_report: item5,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("hollow-parity gate (T5.2/T5.3, 2026-08-23 remediation)");
    console.log(`  item 1 boundary-constant parity: ${item1.ok ? "PASS" : "FAIL"}${item1.ok ? "" : ` — ${item1.detail}`}`);
    console.log(`  catalog-surfaces projection: ${projection.ok ? "PASS" : projection.status.toUpperCase()}${projection.reason ? ` — ${projection.reason}` : ""}`);
    if (item2and4.status === "available") {
      console.log(`  item 2 outcome-aware observation: ${item2and4.item2Findings.length === 0 ? "PASS" : "FAIL"} (${item2and4.outcomeCount} outcome(s) observed, ${item2and4.item2Findings.length} product-surface validation finding(s))`);
      if (explain) for (const finding of item2and4.item2Findings) console.log(`    FINDING: scenario '${finding.scenario}' kind '${finding.kind}' — ${finding.summary}`);
    } else {
      console.log(`  item 2 outcome-aware observation: UNAVAILABLE — ${item2and4.reason}`);
    }
    console.log(`  item 3 surface-scoped reachability: ${item3.findings.length === 0 ? "PASS" : "FAIL"} (${item3.mcpOnly.length} MCP-generic-only of ${item3.catalog.length} kinds; ${item3.allowlisted.length} allowlisted, ${item3.findings.length} unlisted)`);
    if (item3.staleAllowlistEntries.length) console.log(`    stale api-only.json entries (no longer MCP-generic-only): ${item3.staleAllowlistEntries.join(", ")}`);
    if (explain) for (const kind of item3.findings) console.log(`    FINDING: ${kind} — no CLI/TUI/Web/liveness producer found`);
    if (item2and4.status === "available") {
      console.log(`  item 4 real-surface VI scenarios: ${item2and4.item4Findings.length === 0 ? "PASS" : "FAIL"}`);
      if (explain) for (const finding of item2and4.item4Findings) console.log(`    FINDING: ${finding}`);
    } else {
      console.log(`  item 4 real-surface VI scenarios: UNAVAILABLE — ${item2and4.reason}`);
    }
    if (item5.status === "available") {
      console.log(`  item 5 branch-coverage evidence: ${item5.ranked.length} reachable function(s) with uncovered if/switch branches (top ${Math.min(50, item5.ranked.length)} shown)`);
      for (const row of item5.ranked.slice(0, 50)) console.log(`    ${row.uncoveredBranches}/${row.totalBranches} uncovered  ${row.function}  (${row.file}:${row.line})`);
    } else {
      console.log(`  item 5 branch-coverage evidence: UNAVAILABLE — ${item5.reason}`);
    }
    console.log(report.ok ? "PASS" : `FAIL — ${blockers.length} blocker(s)`);
    for (const blocker of blockers) console.log(`  BLOCKER: ${blocker}`);
    if (item3.findings.length > 0) {
      // ADR-113: item 3's blockers are an operator verdict per D42, not a
      // mechanical fix — surface-scoped reachability is red by design until
      // each MCP-generic-only kind is dispositioned by a human (wire it to a
      // real surface, or record it as deliberately API-only). Naming a
      // command that itself clears this gate would be false: no command does.
      console.log("");
      console.log("  Remedy (item 3): this is an operator verdict per D42, not a mechanical fix. For each");
      console.log("  kind named above, either wire it to a real CLI/TUI/Web/liveness producer, or add a");
      console.log("  reviewed entry with a reason to scripts/hollow-parity/api-only.json (see");
      console.log("  audit/2026-08-23-50-defects.md WA-35 for the disposition list). If it is an owed");
      console.log("  decision, ask it natively (`bun run interview:pack` → AskUserQuestion or `arbor interview`)");
      console.log("  and record it with `bun run interview:record`.");
    }
  }

  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

export { main, runItem3SurfaceScopedReachability, runItem5BranchCoverageReport, runItem1BoundaryParityVitest };
