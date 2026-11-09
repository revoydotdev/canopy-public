/**
 * scripts/lib/hollow-parity/outcomes.mjs — items 2 and 4, outcome-aware
 * observation + real-surface scenarios (T5.3, 2026-08-23 remediation).
 *
 * Every existing wiring gate (including item 3's surface-scoped
 * reachability, T5.2) proves a catalog kind is EXISTS/REACHABLE from some
 * product surface. None of them prove that reaching it through a real
 * operator surface actually behaves — a scenario can execute a
 * `RuntimeCatalogRouter` dispatch end to end and still be silently rejected
 * (`ok:false`) without any gate noticing. `scripts/vi-observe.mjs` now
 * captures every such rejection into
 * `.visual-intelligence/observed/outcomes.jsonl` (see its own header
 * comment and `recordRouterOutcomeIfSinkConfigured` in runtime-catalog.ts);
 * this module turns that raw capture into the two gate-shaped checks
 * hollow-parity.mjs items 2 and 4 need, pure over already-loaded data so it
 * stays trivially fixture-testable — the same discipline as
 * catalog.mjs/surfaces.mjs/branch-coverage.mjs.
 */

import { existsSync, readFileSync } from "node:fs";

/** Parse a JSONL file into an array of records; a missing file is a real, valid "no rows" state, not an error. */
export function loadJsonlRows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

/** Map `scenario.id -> scenario.run_class` from a loaded vi-observe scenario catalog document. */
export function buildScenarioRunClassIndex(catalogDocument) {
  const index = new Map();
  for (const scenario of catalogDocument.scenarios ?? []) index.set(scenario.id, scenario.run_class);
  return index;
}

/**
 * Item 2: a "product-surface" scenario (`run_class` tui/web/cli — a real
 * operator-reachable surface, not merely a bare production/demo process
 * invocation) that produced a `validation` outcome is exactly the Hollow
 * shape this check exists to catch — a real surface handed the router a
 * request shape the router itself rejects as malformed, which no prior gate
 * (existence, reachability, execution-coverage) can see.
 *
 * @param {readonly {scenario:string, kind:string, direction:string, code:string, summary:string}[]} outcomeRows
 * @param {ReadonlyMap<string,string>} scenarioRunClasses
 * @returns {{scenario:string, kind:string, code:string, summary:string}[]}
 */
export function productSurfaceValidationFindings(outcomeRows, scenarioRunClasses) {
  const PRODUCT_SURFACE_RUN_CLASSES = new Set(["tui", "web", "cli"]);
  return outcomeRows
    .filter((row) => row.code === "validation" && PRODUCT_SURFACE_RUN_CLASSES.has(scenarioRunClasses.get(row.scenario)))
    .map((row) => ({ scenario: row.scenario, kind: row.kind, code: row.code, summary: row.summary }))
    .sort((a, b) => (a.scenario < b.scenario ? -1 : a.scenario > b.scenario ? 1 : (a.kind < b.kind ? -1 : 1)));
}

/**
 * Item 4: the three real-surface scenarios this lane added (TUI real
 * keyboard stdin, `arbor serve` stdio at the default junior tier, webui
 * over real HTTP) are not "done" merely by existing in the catalog and
 * exiting 0 — that shape (present, green, silently inert) is exactly what
 * WA-35/hollow-parity item 3 exists to catch for catalog kinds, and the
 * scenario catalog needs the same proof: each must have actually produced
 * dynamic coverage (`observations.jsonl` symbol_id rows tagged with its
 * scenario_id), and the CLI scenario specifically must have recorded a
 * `permission` outcome (the real junior-tier capability-tier denial it was
 * built to prove) and never a `validation` one (a different, wrong Hollow
 * finding that would mean the request itself was malformed, not merely
 * under-privileged).
 *
 * @param {readonly {symbol_id:string, scenario_id:string}[]} observationRows
 * @param {readonly {scenario:string, code:string}[]} outcomeRows
 * @param {{tui:string, web:string, cli:string}} scenarioIds
 * @returns {string[]} findings — empty means every check passed
 */
export function realSurfaceScenarioFindings(observationRows, outcomeRows, scenarioIds) {
  const findings = [];
  const observationCount = (scenarioId) => observationRows.filter((row) => row.scenario_id === scenarioId).length;
  for (const [surface, scenarioId] of Object.entries(scenarioIds)) {
    const count = observationCount(scenarioId);
    if (count === 0) findings.push(`${surface} scenario '${scenarioId}' contributed zero observations — the real-surface scenario ran but reached no covered symbol`);
  }
  const cliOutcomes = outcomeRows.filter((row) => row.scenario === scenarioIds.cli);
  if (!cliOutcomes.some((row) => row.code === "permission")) {
    findings.push(`cli scenario '${scenarioIds.cli}' did not record a 'permission' outcome — the junior-tier denial this scenario proves was not observed`);
  }
  if (cliOutcomes.some((row) => row.code === "validation")) {
    findings.push(`cli scenario '${scenarioIds.cli}' recorded a 'validation' outcome — expected only 'permission' (a capability-tier denial, not a malformed request)`);
  }
  return findings;
}
