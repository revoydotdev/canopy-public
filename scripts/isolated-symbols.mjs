#!/usr/bin/env node
/**
 * scripts/isolated-symbols.mjs — which nodes in the repository graph are
 * genuinely isolated, as opposed to merely swept into an always-true bucket.
 *
 * Usage:
 *   bun scripts/isolated-symbols.mjs                # human report
 *   bun scripts/isolated-symbols.mjs --json          # machine report
 *   bun scripts/isolated-symbols.mjs --max-size 10   # widen beyond singletons
 *
 * WHY THIS EXISTS. The vendored `isolated-components` query
 * (.claude/skills/repository-visual-intelligence/scripts/lib/queries.mjs) asks
 * for weakly-connected components with `having.contains_entrypoint: false`.
 * Component connectivity there is built over `runtimeEdges`, which excludes
 * `contains` and `reachable_from`. The graph has exactly one `entrypoint`
 * node, and the only edges that ever touch it are `reachable_from` edges — the
 * very relation excluded from connectivity. So the entrypoint node always ends
 * up alone in its own component, no component can ever "contain" it, and
 * `contains_entrypoint: false` matches every component unconditionally. That
 * query returns the whole graph (761 records, one component with 17,777+
 * members) and was correctly triaged false_positive as an aggregate — but real
 * small components (sizes 33, 27, 22, 12, 5, 2) and a long tail of singletons
 * were buried inside that always-true bucket and never examined. This is
 * decision item D18 in docs/proposals/operator-decisions-2026-08-19.md.
 *
 * This script asks the same underlying question honestly: it computes
 * connected components directly, ranks them by size, and reports the small
 * end without any predicate that can be vacuous by construction.
 *
 * CONNECTIVITY DEFINITION — what counts as "connected", and why it differs
 * from the vendored query in two deliberate ways:
 *
 *   1. `contains` is excluded, same as upstream. Every symbol/type node has
 *      exactly one inbound `contains` edge from the file that declares it.
 *      Including it would connect every symbol trivially to its file (and
 *      transitively to everything else the file touches), which erases the
 *      exact signal this script exists to find. This is not a new choice —
 *      it is the one part of the vendored exclusion that is correct.
 *
 *   2. `reachable_from` is excluded from CONNECTIVITY here too, but for a
 *      different, explained reason, not by unexamined inheritance from
 *      upstream. These edges do not represent "A talks to B" — every one of
 *      them points FROM a reached node TO the single synthetic `entrypoint`
 *      sentinel ("bfs from 5 declared roots"). Folding them into component
 *      connectivity would hub-and-spoke every reachable node into one giant
 *      star through that sentinel, which would just as surely swallow real
 *      small components as `contains` would — the same failure mode from a
 *      different edge. Instead, `reachable_from` is read back out as a
 *      per-node ANNOTATION (`reachable_from_entrypoint`) so a reader can tell
 *      "isolated AND never reached from an entrypoint" (highest suspicion)
 *      apart from "isolated island but the reachability walk touched it
 *      anyway" (extraction gap or dynamic dispatch, worth a second look).
 *
 *   3. Unlike the vendored `runtimeEdges`, this script does NOT drop
 *      `type_only` edges from connectivity. Upstream's reasoning ("a
 *      type-only cycle is not a runtime cycle") is sound for cycle detection,
 *      but wrong for isolation detection: a type used only in type positions
 *      is still USED, not dead. Dropping type_only edges here would manufacture
 *      false isolation for exactly the population (`type` kind nodes) this
 *      script spends the most effort examining. Verified on the real graph:
 *      604 edges carry `type_only: true` (584 `imports`, 20 `exports`); all
 *      are kept.
 *
 * Every other relation in the ontology (`references`, `calls`, `imports`,
 * `exports`, `extends`, `implements`, `instantiates`, `tests`, `justifies`,
 * `supersedes`) counts as connectivity, undirected, for this purpose: any of
 * them is real evidence that two nodes are not mutually unaware of each other.
 *
 * EXCLUSIONS — reasoned, not blanket, and each one is checked against the
 * real graph in the test suite:
 *
 *   - kind in {record, package, entrypoint}: out of scope, not silently
 *     wrong. ADR records (`record`), workspace packages (`package`), and the
 *     synthetic entrypoint sentinel are governance/structural nodes, not code
 *     symbols. Package nodes are singleton by construction under this
 *     definition (they relate to their files only via the excluded `contains`
 *     relation) — reporting them as "isolated" would just rediscover the
 *     `contains` exclusion, not a code-health finding. ADR isolation
 *     (declared_only with no justifying code) is a real question, but it is
 *     already the vendored `plane_difference` compute's job, not this
 *     script's.
 *
 *   - fixture-path nodes (path contains `/fixtures/` or `/__fixtures__/`):
 *     verified on the real graph — the only `test`-kind singleton components
 *     found are three files under
 *     `packages/arbor-governance/tests/obligation/fixtures/**`, deliberately
 *     isolated repo trees used as INPUT DATA to a test, not source meant to be
 *     reachable. Confirmed by reading the fixtures directly: they declare
 *     small standalone package trees for an ambiguity/re-export test case.
 *
 *   - `symbol`-kind nodes with `attributes.exported !== true`: this mirrors a
 *     finding the vendored query pack already documented and verified — a
 *     non-exported symbol cannot have an inbound edge from another module by
 *     construction (destructuring targets, local bindings: `id`, `before`,
 *     `previous_hash`). On this graph that is 282 of 285 symbol-kind
 *     singletons; sampling confirmed the pattern (single-word local bindings,
 *     no exported flag). The remaining 3 exported symbol singletons are ALL
 *     under the fixture paths above, so after both exclusions there are
 *     ZERO non-fixture, non-noise symbol-kind singletons on this graph.
 *
 * NOT excluded, deliberately, despite being tempting:
 *
 *   - `type`-kind nodes, even exported ones. 402 of 422 type-kind singletons
 *     are exported. Spot-checking one (`AttestationStatus` in
 *     packages/arbor-audit/src/attestation.ts) found it IS used — as a field
 *     type on the same line's neighboring interface, and re-exported through
 *     the package barrel `src/index.ts` via `export type { ... }`. Neither
 *     use produced a graph edge: the barrel re-export is recorded at FILE
 *     granularity only (`file → file`, not `file → type`), and same-file
 *     type-position field usage does not appear to produce a `references`
 *     edge at all in this extractor. That is a real extractor coverage gap,
 *     not evidence the type is dead — so these are reported, not excluded,
 *     with a best-effort `possible_extraction_gap` flag (a plain-text grep
 *     for the identifier elsewhere in the repo) so a human can tell which
 *     ones are worth a second look before spending time on any of them.
 *
 * If you are unsure whether a category is safe to exclude, this script's
 * policy is to report it with a caveat rather than drop it silently.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");
const GRAPH_DIR = join(REPO_ROOT, ".visual-intelligence", "graph");

/** Structural/derived relations that do not represent "A is aware of B". */
const NON_MEANINGFUL_RELATIONS = new Set(["contains", "reachable_from"]);

/** Node kinds this script does not judge — see header for why each one. */
const OUT_OF_SCOPE_KINDS = new Set(["record", "package", "entrypoint"]);

const FIXTURE_PATH_RX = /(^|\/)(fixtures|__fixtures__)\//;

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed));
  }
  return out;
}

export function readGraph(graphDir = GRAPH_DIR) {
  return {
    nodes: readJsonl(join(graphDir, "nodes.jsonl")),
    edges: readJsonl(join(graphDir, "edges.jsonl")),
  };
}

/** Union-find weakly-connected components over an undirected projection of `edges`. */
export function weaklyConnectedComponents(nodeIds, edges) {
  const parent = new Map([...nodeIds].map((n) => [n, n]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of edges) {
    if (parent.has(e.source) && parent.has(e.target)) union(e.source, e.target);
  }
  const groups = new Map();
  for (const n of [...nodeIds].sort()) {
    const r = find(n);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(n);
  }
  return [...groups.values()].sort((a, b) => a.length - b.length || (a[0] < b[0] ? -1 : 1));
}

export function isFixturePath(path) {
  return typeof path === "string" && FIXTURE_PATH_RX.test(path);
}

/** Reasoned, evidenced exclusion. Returns { excluded, reason } — never silent. */
export function classifyExclusion(node) {
  if (OUT_OF_SCOPE_KINDS.has(node.kind)) {
    return { excluded: true, reason: `kind '${node.kind}' is governance/structural, out of scope for code isolation` };
  }
  if (isFixturePath(node.repository_path)) {
    return { excluded: true, reason: "path under fixtures/ — deliberately isolated test input data" };
  }
  if (node.kind === "symbol" && node.attributes?.exported !== true) {
    return { excluded: true, reason: "non-exported symbol — cannot have a cross-module inbound edge by construction (destructuring target/local binding)" };
  }
  return { excluded: false, reason: null };
}

/** Why a node's inbound/outbound edges look the way they do, using ALL edges (incl. contains/reachable_from) for the explanation, not just the connectivity plane. */
function explainIsolation(node, allEdgesBySource, allEdgesByTarget) {
  const inboundAll = allEdgesByTarget.get(node.id) ?? [];
  const outboundAll = allEdgesBySource.get(node.id) ?? [];
  const inboundRelations = [...new Set(inboundAll.map((e) => e.relation))].sort();
  const outboundRelations = [...new Set(outboundAll.map((e) => e.relation))].sort();

  const onlyContainsInbound = inboundAll.length > 0 && inboundAll.every((e) => e.relation === "contains");
  let why;
  if (inboundAll.length === 0 && outboundAll.length === 0) {
    why = "no edges at all — not even a containing file/contains edge";
  } else if (onlyContainsInbound && outboundAll.length === 0) {
    why = "only inbound edge is 'contains' from its own file; no outbound edges and nothing else points to it";
  } else if (inboundAll.length === 0) {
    why = "no inbound edges of any kind; only outbound";
  } else if (outboundAll.length === 0) {
    why = "no outbound edges of any kind; only inbound";
  } else {
    why = "has non-meaningful edges (contains/reachable_from) only in the excluded relation set";
  }

  return { inbound_relations: inboundRelations, outbound_relations: outboundRelations, why };
}

/** Best-effort, non-authoritative textual grep for the identifier elsewhere in the repo, to flag possible extractor coverage gaps. Never used to exclude — only to caveat. */
function possibleExtractionGap(node, repoRoot) {
  const name = node.name;
  if (!name || name.length < 3 || !node.repository_path) return null;
  const abs = join(repoRoot, node.repository_path);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const rx = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  const hitsInOwnFile = (text.match(rx) ?? []).length;
  // >1 because the declaration itself is one hit.
  if (hitsInOwnFile > 1) {
    return `identifier appears ${hitsInOwnFile}x in its own declaring file — likely used in a position this extractor does not edge (e.g. same-file type-position reference)`;
  }
  return null;
}

export function analyzeIsolatedSymbols({ graphDir = GRAPH_DIR, repoRoot = REPO_ROOT, maxComponentSize = 1, checkExtractionGaps = true } = {}) {
  const graph = readGraph(graphDir);
  const { nodes, edges } = graph;

  if (nodes.length === 0) {
    return { ok: true, graph_present: false, total_nodes: 0, total_components: 0, giant_component_size: 0, components_reported: 0, excluded_count: 0, results: [] };
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nodeIds = new Set(nodes.map((n) => n.id));

  const meaningfulEdges = edges.filter(
    (e) => !NON_MEANINGFUL_RELATIONS.has(e.relation) && nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  const allEdgesBySource = new Map();
  const allEdgesByTarget = new Map();
  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    if (!allEdgesBySource.has(e.source)) allEdgesBySource.set(e.source, []);
    allEdgesBySource.get(e.source).push(e);
    if (!allEdgesByTarget.has(e.target)) allEdgesByTarget.set(e.target, []);
    allEdgesByTarget.get(e.target).push(e);
  }

  const reachableFromEntrypoint = new Set(
    edges.filter((e) => e.relation === "reachable_from").map((e) => e.source),
  );
  const hasEntrypoint = nodes.some((n) => n.kind === "entrypoint");

  const components = weaklyConnectedComponents(nodeIds, meaningfulEdges);
  const giantComponentSize = components.length ? components[components.length - 1].length : 0;

  let excludedCount = 0;
  const results = [];

  for (const comp of components) {
    if (comp.length > maxComponentSize) continue;
    for (const id of comp) {
      const node = byId.get(id);
      if (!node) continue;
      const { excluded } = classifyExclusion(node);
      if (excluded) {
        excludedCount++;
        continue;
      }
      const explanation = explainIsolation(node, allEdgesBySource, allEdgesByTarget);
      const gap = checkExtractionGaps ? possibleExtractionGap(node, repoRoot) : null;
      results.push({
        id: node.id,
        kind: node.kind,
        name: node.name,
        path: node.repository_path,
        exported: node.attributes?.exported === true,
        component_size: comp.length,
        why_isolated: explanation.why,
        inbound_relations: explanation.inbound_relations,
        outbound_relations: explanation.outbound_relations,
        reachable_from_entrypoint: hasEntrypoint ? reachableFromEntrypoint.has(node.id) : null,
        possible_extraction_gap: gap,
      });
    }
  }

  results.sort((a, b) => a.component_size - b.component_size || (a.id < b.id ? -1 : 1));

  return {
    ok: true,
    graph_present: true,
    total_nodes: nodes.length,
    total_components: components.length,
    giant_component_size: giantComponentSize,
    components_reported: results.length,
    excluded_count: excludedCount,
    results,
  };
}

function parseArgs(argv) {
  const json = argv.includes("--json");
  const idx = argv.indexOf("--max-size");
  const maxComponentSize = idx !== -1 && argv[idx + 1] ? Number(argv[idx + 1]) : 1;
  return { json, maxComponentSize };
}

export function main() {
  const { json, maxComponentSize } = parseArgs(process.argv.slice(2));
  const report = analyzeIsolatedSymbols({ maxComponentSize });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  if (!report.graph_present) {
    console.log("isolated-symbols — no graph found under .visual-intelligence/graph/");
    console.log("Nothing to analyze. This is not a clean bill of health — it means the graph has not been built.");
    return 0;
  }

  console.log(`isolated-symbols — ${report.total_nodes} nodes, ${report.total_components} connected component(s)`);
  console.log(`  giant component size : ${report.giant_component_size}`);
  console.log(`  reported (<= size ${maxComponentSize}) : ${report.components_reported}`);
  console.log(`  excluded (reasoned)  : ${report.excluded_count}\n`);

  if (report.results.length === 0) {
    console.log("No genuinely isolated nodes found after exclusions.");
    return 0;
  }

  for (const r of report.results) {
    console.log(`${r.id}`);
    console.log(`  kind=${r.kind} path=${r.path ?? "(none)"} exported=${r.exported} component_size=${r.component_size}`);
    console.log(`  why: ${r.why_isolated}`);
    console.log(`  inbound=[${r.inbound_relations.join(",")}] outbound=[${r.outbound_relations.join(",")}] reachable_from_entrypoint=${r.reachable_from_entrypoint}`);
    if (r.possible_extraction_gap) console.log(`  CAVEAT: ${r.possible_extraction_gap}`);
    console.log("");
  }

  return 0;
}

if (resolvePath(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
