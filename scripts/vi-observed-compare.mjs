#!/usr/bin/env node
/**
 * scripts/vi-observed-compare.mjs — ADR-042 Half A4: derived-plane vs.
 * observed-plane comparison. Repo-owned (NOT part of the vendored
 * validator under .claude/skills/repository-visual-intelligence/scripts/).
 *
 *   bun scripts/vi-observed-compare.mjs [--json]
 *
 * Reads the graph (`.visual-intelligence/graph/`) and the observed store
 * (`.visual-intelligence/observed/`, produced by vi-observe.mjs) and emits
 * two finding categories into `.visual-intelligence/findings/findings.jsonl`,
 * shape-compatible with the vendored validator's own findings:
 *
 * ADR-090: `catalog_gap` is NO LONGER emitted as a per-finding record here.
 * It measures a property of the declared SCENARIO CATALOG (which packages the
 * catalog never drives), not a suspected code defect — its own body always
 * read "The catalog does not exercise these modules." Routing that
 * observation-completeness signal through gate:vi-findings demanded a recorded
 * human verdict (with expiry) per package for a coverage metric, flooding the
 * operator triage queue with leads about the catalog rather than the code
 * (e.g. "51 files in arbor-mcp never invoked" for heavily-used core files not
 * in the captured traces). It is now written to an advisory coverage artifact
 * (`.visual-intelligence/observed/catalog-coverage.json`) — preserved as a
 * signal for improving the scenario set, but not a per-package human-verdict
 * obligation. `catalog_gap` remains in OWNED_CATEGORIES only so any prior
 * run's catalog_gap findings are PURGED from the store on this run.
 *
 *   hollow_candidate      — production-reachable AND tested in the derived
 *                            plane, AND instrument-visible (a V8 function
 *                            range of a loaded production-scenario module
 *                            maps into the symbol — so the instrument CAN
 *                            see it), but zero observations across every
 *                            run_class:"production" scenario. A LEAD, not a
 *                            verdict — triaged under ADR-042 Half B
 *                            (gate:vi-findings).
 *   observed_unreachable  — observed at runtime under ANY scenario, but the
 *                            derived plane does not mark it production-
 *                            reachable. The extractor-gap cross-check: two
 *                            independent instruments (static reachability,
 *                            dynamic coverage) disagreeing is itself the
 *                            finding. A runtime-observed non-exported
 *                            VariableDeclaration is deliberately excluded:
 *                            it is a local binding inventory node, not a
 *                            separately callable unit. Its direct runtime
 *                            observation is the reachability evidence; the
 *                            count is reported rather than silently dropped.
 *
 * REACHABILITY AND "TESTED", AS THE GRAPH ACTUALLY RECORDS THEM (verified
 * against the committed store, not assumed): a `reachable_from` edge
 * (source = symbol, target = the single synthetic `ep:` node representing
 * the declared 4-root production entry-point set — verified there is
 * exactly one `ep:` node in this graph) is the reachability signal; a
 * `tests` edge (source = a `packages/*\/tests/**` file, target = symbol) is
 * the tested signal. Both already exist as first-class edge relations — no
 * derivation from `packages/*\/tests/**` file references was needed.
 *
 * BOUNDED, PER FILE (Commandment IX). One finding per source file carrying
 * the qualifying symbol list, capped at 50 per category — an unbounded
 * finding flood would defeat Half B's triage obligation. If a category
 * exceeds the cap, the first 50 files (sorted by path, deterministic) are
 * emitted and a final overflow finding states the true total.
 *
 * CATALOG-RELATIVE HONESTY. Every emitted finding body states "not observed
 * under the declared scenario catalog (hash ...)" — never "dead". The
 * catalog is a declared, finite instrument (ADR-042's Decision, point 4).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stableFindingId } from "./vi-finding-id.mjs";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const GRAPH_DIR = process.env.REVOY2_VI_GRAPH_DIR ? resolve(process.env.REVOY2_VI_GRAPH_DIR) : join(REPO_ROOT, ".visual-intelligence", "graph");
const OBSERVED_DIR = process.env.REVOY2_VI_OBSERVED_DIR ? resolve(process.env.REVOY2_VI_OBSERVED_DIR) : join(REPO_ROOT, ".visual-intelligence", "observed");
const FINDINGS_DIR = process.env.REVOY2_VI_FINDINGS_DIR ? resolve(process.env.REVOY2_VI_FINDINGS_DIR) : join(REPO_ROOT, ".visual-intelligence", "findings");
const FINDINGS_PATH = join(FINDINGS_DIR, "findings.jsonl");
// ADR-090: catalog-coverage advisory — where the demoted catalog_gap signal
// lands instead of the human-verdict findings store.
const CATALOG_COVERAGE_PATH = join(OBSERVED_DIR, "catalog-coverage.json");

const JSON_OUT = process.argv.includes("--json");
const CAP_PER_CATEGORY = 50;
const OWNED_CATEGORIES = new Set(["hollow_candidate", "observed_unreachable", "catalog_gap"]);

function readJsonlLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Graph: reachability + tested signals
// ---------------------------------------------------------------------------

function loadGraph() {
  const symbolsById = new Map();
  for (const line of readJsonlLines(join(GRAPH_DIR, "nodes.jsonl"))) {
    const record = JSON.parse(line);
    if (record.kind === "symbol") symbolsById.set(record.id, record);
  }

  const reachable = new Set();
  const tested = new Set();
  for (const line of readJsonlLines(join(GRAPH_DIR, "edges.jsonl"))) {
    const edge = JSON.parse(line);
    if (edge.relation === "reachable_from" && edge.target?.startsWith("ep:")) reachable.add(edge.source);
    else if (edge.relation === "tests") tested.add(edge.target);
  }

  let graphRevision = "unknown";
  const manifestPath = join(REPO_ROOT, ".visual-intelligence", "manifest.json");
  if (existsSync(manifestPath)) {
    try { graphRevision = JSON.parse(readFileSync(manifestPath, "utf8")).repo_revision ?? "unknown"; } catch { /* leave unknown */ }
  }

  return { symbolsById, reachable, tested, graphRevision };
}

// ---------------------------------------------------------------------------
// Observed store
// ---------------------------------------------------------------------------

/** Returns null if the observed plane has never been produced — a typed absence, not an error. */
function loadObserved() {
  const manifestPath = join(OBSERVED_DIR, "manifest.json");
  const observationsPath = join(OBSERVED_DIR, "observations.jsonl");
  if (!existsSync(manifestPath) || !existsSync(observationsPath)) return null;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bySymbol = new Map(); // symbol_id -> { total, productionTotal }
  for (const line of readJsonlLines(observationsPath)) {
    const row = JSON.parse(line);
    const entry = bySymbol.get(row.symbol_id) ?? { total: 0, productionTotal: 0 };
    entry.total += row.count;
    if (row.run_class === "production") entry.productionTotal += row.count;
    bySymbol.set(row.symbol_id, entry);
  }

  // Instrument visibility: symbols whose span encloses at least one V8
  // function range of a LOADED production-scenario script (invoked or not).
  // A symbol the instrument cannot ever see (an exported constant, a pure
  // type) must never become a hollow candidate — its permanent absence from
  // observations is a property of the instrument, not of the code. A store
  // without the visibility file predates this rule; regenerating it is cheap
  // and guessing is not an option.
  const visibilityPath = join(OBSERVED_DIR, "instrument-visibility.jsonl");
  if (!existsSync(visibilityPath)) {
    process.stderr.write(
      "vi-observed-compare: observed store has no instrument-visibility.jsonl (pre-visibility store) — re-run `bun run vi:observe` first\n",
    );
    process.exit(1);
  }
  const visibleProduction = new Set();
  for (const line of readJsonlLines(visibilityPath)) {
    const row = JSON.parse(line);
    if (row.run_class === "production") visibleProduction.add(row.symbol_id);
  }
  return { manifest, bySymbol, visibleProduction };
}

// ---------------------------------------------------------------------------
// Candidate derivation
// ---------------------------------------------------------------------------

function findCandidates(graph, observed) {
  // Files with at least one INVOKED production observation: the scenarios
  // demonstrably drive this module, so an uninvoked-but-visible symbol in it
  // is the true Hollow shape — dormant code inside an exercised module (the
  // `task_skills` shape). A file that loaded but never had ANY invocation is
  // a different lead entirely: the catalog does not drive that module, which
  // is a per-package catalog gap, not a per-symbol hollow suspicion. Folding
  // those into hollow findings buried the signal under 135 files of catalog
  // narrowness on the first full run.
  const invokedFiles = new Set();
  for (const [id, entry] of observed.bySymbol) {
    if (entry.productionTotal > 0) {
      const node = graph.symbolsById.get(id);
      if (node) invokedFiles.add(node.repository_path);
    }
  }

  const hollow = []; // { symbolId, file } — dormant symbol in an exercised file
  const catalogGapFiles = new Map(); // file -> uninvoked visible symbol count
  const observedUnreachable = [];
  const observedLocalBindings = [];
  for (const [id, node] of graph.symbolsById) {
    const isReachable = graph.reachable.has(id);
    const isTested = graph.tested.has(id);
    const obs = observed.bySymbol.get(id);
    const hasProductionObservation = (obs?.productionTotal ?? 0) > 0;
    const hasAnyObservation = (obs?.total ?? 0) > 0;

    // Candidacy requires instrument visibility: the coverage report proved a
    // function range of this symbol CAN be seen under a production scenario
    // (the module loaded), and it was still never invoked. Without this,
    // constants and never-loaded modules flood triage with leads the
    // instrument can never confirm.
    if (isReachable && isTested && observed.visibleProduction.has(id) && !hasProductionObservation) {
      if (invokedFiles.has(node.repository_path)) {
        hollow.push({ symbolId: id, file: node.repository_path });
      } else {
        catalogGapFiles.set(node.repository_path, (catalogGapFiles.get(node.repository_path) ?? 0) + 1);
      }
    }
    if (hasAnyObservation && !isReachable) {
      // A non-exported VariableDeclaration is a lexical/module-local binding,
      // which the immutable extractor inventories as a symbol but cannot give
      // an inbound call edge by construction. Runtime coverage is direct
      // evidence that its enclosing execution context ran, so reporting it as
      // statically unreachable would manufacture the D26 false positive. Do
      // not generalize this: exported variables and every other declaration
      // kind remain extractor-disagreement findings.
      if (node.attributes?.declaration === "VariableDeclaration" && node.attributes.exported !== true) {
        observedLocalBindings.push({ symbolId: id, file: node.repository_path });
      } else {
        observedUnreachable.push({ symbolId: id, file: node.repository_path });
      }
    }
  }
  return { hollow, catalogGapFiles, observedUnreachable, observedLocalBindings };
}

/**
 * ADR-090: the demoted catalog-coverage signal, as a deterministic advisory
 * artifact (NOT a per-finding record demanding an operator verdict). One entry
 * per PACKAGE the declared scenario catalog never drives: the module loaded
 * under a production scenario and nothing in it was ever invoked. This is a
 * property of the catalog's breadth, useful for improving the scenario set —
 * not a suspected defect in the code.
 */
export function buildCatalogCoverageReport(catalogGapFiles, { catalogHash, graphRevision }) {
  const MAX_FILES_LISTED = 20;
  const byPackage = new Map();
  for (const [file, count] of catalogGapFiles) {
    const m = file.match(/^packages\/([^/]+)\//);
    const pkg = m ? m[1] : "(outside packages/)";
    if (!byPackage.has(pkg)) byPackage.set(pkg, []);
    byPackage.get(pkg).push({ file, count });
  }
  const packages = [];
  for (const [pkg, files] of [...byPackage.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    files.sort((a, b) => (a.file < b.file ? -1 : 1));
    const totalSymbols = files.reduce((n, f) => n + f.count, 0);
    packages.push({
      package: pkg,
      uninvoked_file_count: files.length,
      uninvoked_symbol_count: totalSymbols,
      files_truncated: files.length > MAX_FILES_LISTED,
      files: files.slice(0, MAX_FILES_LISTED).map((f) => ({ file: f.file, uninvoked_symbol_count: f.count })),
    });
  }
  return {
    schema_version: 1,
    kind: "catalog_coverage_advisory",
    note:
      "ADVISORY (ADR-090): packages whose files loaded under a production scenario but had zero invocations. " +
      "A property of the declared scenario catalog's breadth, not a code defect — no per-finding verdict is required. " +
      "To close a gap, add a scenario that drives the package's real production path.",
    catalog_content_hash: catalogHash,
    graph_revision: graphRevision,
    package_count: packages.length,
    packages,
  };
}

function groupByFile(candidates) {
  const byFile = new Map();
  for (const c of candidates) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c.symbolId);
  }
  for (const ids of byFile.values()) ids.sort();
  return [...byFile.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

function buildFindings(category, candidates, { catalogHash, graphRevision, claim, expectedModel, observedModelPrefix, remediation }) {
  const groups = groupByFile(candidates);
  const emitted = groups.slice(0, CAP_PER_CATEGORY);
  const overflowCount = groups.length - emitted.length;

  const findings = emitted.map(([file, symbolIds]) => {
    const base = {
      severity: "medium",
      category,
      title: `${category.replace(/_/g, "-")}: ${symbolIds.length} symbol(s) in ${file}`,
      claim,
      affected_nodes: symbolIds,
      affected_edges: [],
      missing_edges: [],
      expected_model: expectedModel,
      observed_model: `${symbolIds.length} symbol(s) ${observedModelPrefix} (declared scenario catalog hash ${catalogHash}).`,
      evidence: symbolIds.map((locator) => ({ locator, excerpt: null, discovery: "observed" })),
      confidence: "medium",
      corroborating_heuristics: [],
      impact: `${observedModelPrefix} — a lead requiring triage, not a confirmed defect.`,
      likely_cause: null,
      remediation,
      validation_method: "bun scripts/vi-observed-compare.mjs --json",
      adr_refs: ["ADR-042"],
      owner: null,
      found_at_revision: graphRevision,
      status: "open",
      exception_id: null,
    };
    return { id: stableFindingId(base), ...base };
  });

  if (overflowCount > 0) {
    const base = {
      severity: "medium",
      category,
      title: `${category.replace(/_/g, "-")}-overflow: 1 record(s)`,
      claim: `Were there more than ${CAP_PER_CATEGORY} distinct files with ${category} candidates?`,
      affected_nodes: [],
      affected_edges: [],
      missing_edges: [],
      expected_model: `No more than ${CAP_PER_CATEGORY} files would carry ${category} candidates.`,
      observed_model: `${groups.length} file(s) total carried ${category} candidates; only the first ${CAP_PER_CATEGORY} (by path) were emitted as findings. An unbounded flood would defeat triage (ADR-042 Half B) — this overflow finding is the bound's own record.`,
      evidence: [],
      confidence: "high",
      corroborating_heuristics: [],
      impact: `${overflowCount} file(s) worth of ${category} candidates are not individually represented as findings.`,
      likely_cause: null,
      remediation: "Not a single fix — indicates the catalog or reachability set may need broadening before per-file triage is tractable.",
      validation_method: "bun scripts/vi-observed-compare.mjs --json",
      adr_refs: ["ADR-042"],
      owner: null,
      found_at_revision: graphRevision,
      status: "open",
      exception_id: null,
    };
    findings.push({ id: stableFindingId(base), ...base });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// B3 — repair vendored findings this script does not own the emission of.
//
// Both defects originate in .claude/skills/repository-visual-
// intelligence/scripts/vi-validate.mjs, which ADR-031 forbade editing when
// this was written (ADR-176 has since made it first-party). Repaired here,
// repo-side, as post-processing over findings this script merges anyway.
// ---------------------------------------------------------------------------

const NODE_ID_RE = /^(sym:|file:|rec:)/;

/**
 * B3a — `affected_nodes: []` on compute-shaped and record-shaped findings. The vendored
 * emitter (vi-validate.mjs:296-298) builds `affected_nodes` by filtering
 * hits for strings starting with `sym:`/`file:`. For `compute`-based
 * queries (isolated-components, any weakly_connected_components query) each
 * hit is a `{size, members}` OBJECT, so the filter strips everything —
 * e.g. vi:030d46b62f9f0364, a high-severity 753-record dead-code finding,
 * points at nothing. The node identities survive inside evidence[].locator
 * as embedded JSON (the same emitter falls back to `JSON.stringify(h)` for
 * evidence when a hit is not a string/id/node/edge). This recovers them
 * from that embedded JSON. Its same `sym:`/`file:` filter also strips direct
 * `rec:` hits from record queries such as `orphan-records`, leaving distinct
 * governance findings with identical empty subject sets. A direct evidence
 * locator is the canonical record identity in that case and is recovered too.
 *
 * The vendored emitter also caps evidence at the first 25 hits
 * (vi-validate.mjs's `hits.slice(0, 25)`), so recovery only ever sees that
 * sample — never the full record count — and says so explicitly.
 */
function recoverAffectedNodesFromEvidence(finding) {
  if ((finding.affected_nodes?.length ?? 0) > 0) return finding;
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) return finding;
  if ((finding.observed_model ?? "").includes("affected_nodes recovered from")) return finding; // already repaired

  const recovered = new Set();
  let parsedRecords = 0;
  for (const ev of finding.evidence) {
    if (typeof ev?.locator !== "string") continue;
    if (NODE_ID_RE.test(ev.locator)) {
      recovered.add(ev.locator);
      parsedRecords += 1;
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(ev.locator); } catch { continue; }
    if (!parsed || !Array.isArray(parsed.members)) continue;
    parsedRecords += 1;
    for (const m of parsed.members) {
      if (typeof m === "string" && NODE_ID_RE.test(m)) recovered.add(m);
    }
  }
  if (recovered.size === 0) return finding;

  const totalMatch = /(\d+) record\(s\)/.exec(finding.observed_model ?? finding.title ?? "");
  const total = totalMatch ? Number(totalMatch[1]) : null;
  const note =
    ` affected_nodes recovered from ${parsedRecords} evidence record(s)` +
    (total !== null && total > parsedRecords ? ` of ${total} total` : "") +
    ` embedded as compute-shaped hits or direct record locators (the vendored emitter's own evidence sample cap) — ` +
    `${recovered.size} distinct node identity(ies) extracted; records beyond the evidence sample are not represented.`;

  return { ...finding, affected_nodes: [...recovered].sort(), observed_model: `${finding.observed_model ?? ""}${note}` };
}

/**
 * B3b — silent truncation. The vendored emitter caps `affected_nodes` at
 * the first 100 hits (vi-validate.mjs:296) with no notice when the true
 * count (the "N record(s)" the title/observed_model already states)
 * exceeds it — e.g. unreachable-production matches 651 records but only
 * 100 node identities are ever visible, and a reader has no way to know 551
 * are missing. Mirrors this script's own overflow-notice convention
 * (`buildFindings`'s "; first N files listed").
 */
function annotateTruncation(finding) {
  const nodeCount = finding.affected_nodes?.length ?? 0;
  if (nodeCount === 0) return finding;
  if ((finding.observed_model ?? "").includes("node(s) listed")) return finding; // already repaired
  const totalMatch = /(\d+) record\(s\)/.exec(finding.title ?? finding.observed_model ?? "");
  const total = totalMatch ? Number(totalMatch[1]) : null;
  if (total === null || total <= nodeCount) return finding;

  const note = ` (first ${nodeCount} of ${total} node(s) listed; ${total - nodeCount} not represented in affected_nodes.)`;
  return { ...finding, observed_model: `${finding.observed_model ?? ""}${note}` };
}

/**
 * Applies both B3 repairs to every VENDOR-sourced finding (never to this
 * script's own OWNED_CATEGORIES, which never exhibit either shape). When a
 * repair actually changes `affected_nodes`, the finding's id is recomputed
 * — stableFindingId hashes affected_nodes, so a finding whose identity
 * previously encoded "points at nothing" legitimately gets a new,
 * accurate id once repaired.
 */
function repairVendoredFindings(findings) {
  let recoveredCount = 0;
  let truncatedCount = 0;
  const repaired = findings.map((f) => {
    if (OWNED_CATEGORIES.has(f.category)) return f;
    const before = f;
    let next = recoverAffectedNodesFromEvidence(f);
    if (next !== before) recoveredCount += 1;
    const beforeTruncate = next;
    next = annotateTruncation(next);
    if (next !== beforeTruncate) truncatedCount += 1;
    if (next.affected_nodes !== before.affected_nodes) next = { ...next, id: stableFindingId(next) };
    return next;
  });
  return { repaired, recoveredCount, truncatedCount };
}

// ---------------------------------------------------------------------------
// Merge into the findings store
// ---------------------------------------------------------------------------

function mergeIntoFindingsStore(newFindings, existing) {
  mkdirSync(FINDINGS_DIR, { recursive: true });
  // This script is authoritative for its own two categories: replace any
  // prior run's output for them entirely rather than accumulating duplicates
  // across re-runs (ids are already stable, so an unchanged finding round-
  // trips to the identical record).
  const kept = existing.filter((f) => !OWNED_CATEGORIES.has(f.category));
  const merged = [...kept, ...newFindings];
  writeFileSync(FINDINGS_PATH, merged.length ? `${merged.map((f) => JSON.stringify(f)).join("\n")}\n` : "", "utf8");
  return { keptCount: kept.length, totalCount: merged.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // B3 repair runs regardless of whether the observed plane exists — it is
  // pure post-processing over findings.jsonl this script already merges,
  // independent of the hollow/unreachable comparison below.
  const existingBeforeRepair = readJsonlLines(FINDINGS_PATH).map((l) => JSON.parse(l));
  const { repaired: existing, recoveredCount, truncatedCount } = repairVendoredFindings(existingBeforeRepair);

  const observed = loadObserved();
  if (!observed) {
    if (recoveredCount > 0 || truncatedCount > 0) {
      mkdirSync(FINDINGS_DIR, { recursive: true });
      writeFileSync(FINDINGS_PATH, existing.length ? `${existing.map((f) => JSON.stringify(f)).join("\n")}\n` : "", "utf8");
    }
    // Typed absence, never silent — matches ADR-042's own framing of the
    // observed plane's prior "UNAVAILABLE" state.
    console.log(
      "vi-observed-compare: .visual-intelligence/observed/ is absent — no comparison made (run `bun run vi:observe` first)." +
      (recoveredCount || truncatedCount ? ` (B3: repaired ${recoveredCount} compute-shaped, ${truncatedCount} truncated vendored finding(s))` : ""),
    );
    return 0;
  }

  const graph = loadGraph();
  const { hollow, catalogGapFiles, observedUnreachable, observedLocalBindings } = findCandidates(graph, observed);
  const catalogHash = observed.manifest.catalog_content_hash ?? "unknown";

  const hollowFindings = buildFindings("hollow_candidate", hollow, {
    catalogHash, graphRevision: graph.graphRevision,
    claim: "Is this file's production-reachable, tested, instrument-visible symbol set actually exercised under any run_class:\"production\" scenario in the declared catalog?",
    expectedModel: "Every production-reachable, tested, instrument-visible symbol would show at least one observation under a production-class scenario.",
    observedModelPrefix: "are production-reachable, tested, and instrument-visible (a coverable function range maps into the symbol under a loaded production-scenario module) yet never invoked under the declared scenario catalog",
    remediation: "Triage each symbol under gate:vi-findings: false_positive (the catalog doesn't yet exercise this real path), accepted_tradeoff, fixed, or superseded. A finding here is a lead, never a verdict.",
  });
  const unreachableFindings = buildFindings("observed_unreachable", observedUnreachable, {
    catalogHash, graphRevision: graph.graphRevision,
    claim: "Is every runtime-observed symbol in this file also marked production-reachable by the derived plane?",
    expectedModel: "Every runtime-observed symbol would already be marked production-reachable by the derived plane.",
    observedModelPrefix: "were observed executing under the declared scenario catalog but are not marked production-reachable by the derived plane (an extractor gap)",
    remediation: "Triage each symbol under gate:vi-findings: false_positive (a resolution artifact — e.g. dynamic dispatch the extractor cannot see), accepted_tradeoff, fixed, or superseded.",
  });

  // ADR-090: catalog_gap is routed to the advisory coverage artifact, NOT the
  // human-verdict findings store. It stays in OWNED_CATEGORIES so any prior
  // catalog_gap findings are purged from findings.jsonl by the merge below.
  const catalogCoverage = buildCatalogCoverageReport(catalogGapFiles, { catalogHash, graphRevision: graph.graphRevision });
  mkdirSync(OBSERVED_DIR, { recursive: true });
  writeFileSync(CATALOG_COVERAGE_PATH, `${JSON.stringify(catalogCoverage, null, 2)}\n`, "utf8");

  const allNew = [...hollowFindings, ...unreachableFindings];
  const { keptCount, totalCount } = mergeIntoFindingsStore(allNew, existing);

  const summary = {
    ok: true,
    hollow_candidate_findings: hollowFindings.length,
    observed_unreachable_findings: unreachableFindings.length,
    observed_local_bindings_reconciled: observedLocalBindings.length,
    catalog_coverage_gap_packages: catalogCoverage.package_count,
    findings_kept_from_other_categories: keptCount,
    findings_store_total: totalCount,
    catalog_content_hash: catalogHash,
    vendored_findings_recovered: recoveredCount,
    vendored_findings_truncation_annotated: truncatedCount,
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`vi-observed-compare — ${hollowFindings.length} hollow_candidate, ${unreachableFindings.length} observed_unreachable finding(s) merged; ${observedLocalBindings.length} runtime-observed local binding(s) reconciled by direct execution evidence; ${catalogCoverage.package_count} package(s) in catalog-coverage advisory (ADR-090, not triaged)`);
    console.log(`  findings store now carries ${totalCount} total record(s) (${keptCount} kept from other categories)`);
    if (recoveredCount || truncatedCount) {
      console.log(`  B3: repaired ${recoveredCount} compute-shaped and ${truncatedCount} truncated vendored finding(s)`);
    }
  }
  return 0;
}

// CLI entrypoint only — guarded so this module can be imported (e.g. by
// scripts/tests/vi-catalog-coverage.test.mjs) without running the comparison.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
