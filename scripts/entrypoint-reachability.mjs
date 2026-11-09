#!/usr/bin/env node
/**
 * scripts/entrypoint-reachability.mjs — reachable FROM WHAT, not merely reachable.
 *
 * Usage:
 *   bun scripts/entrypoint-reachability.mjs                 # human report
 *   bun scripts/entrypoint-reachability.mjs --json          # machine report
 *   bun scripts/entrypoint-reachability.mjs --verify        # self-check only
 *   bun run gate:entrypoint-reachability
 *
 * WHY THIS EXISTS. The committed graph answers "is this node reachable?" and
 * cannot answer "reachable from which entry point?". The vendored extractor
 * (.claude/skills/repository-visual-intelligence/scripts/vi-extract-ts.mjs,
 * around line 780) runs ONE breadth-first search seeded with the UNION of every
 * declared root, then emits a single `reachable_from` edge per reached node
 * pointing at one synthetic `entrypoint-set:<all roots joined>` node. A node
 * reachable from any root is therefore indistinguishable from a node reachable
 * from all of them.
 *
 * ADR-035 named this gap precisely, in the alternative it rejected: "the
 * graph's `reachable_from` cannot distinguish `demo.ts` (genuinely reachable
 * from `cli.ts`) from the production campaign path, which is the exact
 * distinction this needs. Solving it properly requires the per-entry-point
 * reachability the graph does not currently model." That was 2026-08-07. This
 * module is that missing model.
 *
 * WHAT IT CATCHES, AND — MEASURED — WHAT IT DOES NOT.
 *
 * It answers "reachable from A but not B" for the DECLARED ROOTS. On this
 * repository that separates 262 nodes reachable from neither CLI root's
 * production path (the eval-only surface, 191 of them reachable solely from
 * arbor-eval-cli) from the code the shipped CLI can actually run. That is
 * precisely the demo-versus-production distinction ADR-035 could not make.
 *
 * It does NOT catch the defect that prompted it, and saying otherwise would be
 * the overclaim this repository treats as worse than no mechanism. Checked
 * directly: `file:packages/arbor-mcp/src/a2a-bridge.ts` is reachable from
 * arbor-mcp-cli. The a2a gap is not a reachability fact at all — `serve` and
 * `remote-serve` are two branches INSIDE one root file, and one of them spreads
 * an options object the other omits. Distinguishing them needs composition/
 * dataflow analysis ("which options value reaches which router construction"),
 * which is a different capability from graph reachability and is not built here.
 *
 * The two existing detectors missed that same defect for their own structural
 * reasons, recorded so nobody re-litigates them:
 *
 *   - visual-intelligence DID flag the file, but only inside a 72-file
 *     `catalog_gap` aggregate triaged as "the observation catalog is narrow" —
 *     true of the bucket, false of the one file in it that was unreachable by
 *     construction rather than merely unexercised. An aggregation failure.
 *   - completion-depth is the store built for ADR-035's Hollow shape, but its
 *     predicate skips any guard having a production setter at all. A value set
 *     on three composition roots out of four satisfies it.
 *
 * WHY REPO-SIDE RATHER THAN IN THE EXTRACTOR. The BFS lives in the skill's
 * extractor, which ADR-031 forbade editing when this was written (ADR-176 has
 * since made it first-party and editable). So this reads the
 * committed graph and re-walks it per root, mirroring the vendored adjacency
 * rule exactly, then applying the first-party lexical-scope reachability
 * projection recorded by `vi-lsp-facts.mjs`.
 *
 * THAT MIRRORING IS THE RISK, so it is checked rather than assumed. `--verify`
 * (and every run) asserts that the UNION of the per-root sets equals the set
 * the vendored walker already committed as `reachable_from` edges. If the
 * vendored rule ever changes, this disagrees loudly instead of quietly
 * reporting a partition derived from a stale copy of someone else's algorithm.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");

/**
 * Mirrors vi-extract-ts.mjs's own exclusion set (`contains`, `tests`), plus
 * `reachable_from`.
 *
 * That third exclusion is not in the vendored list and is not a deviation: it
 * is required BECAUSE this walk runs later. The extractor builds its adjacency
 * before it emits any `reachable_from` edge, so it can never traverse one. This
 * module reads the finished graph, where those edges already exist and all
 * point at the synthetic entrypoint node — so walking them reaches that node
 * and the union came out exactly one larger than the committed set. The
 * vendored query engine excludes it for the same reason (queries.mjs's
 * NON_SUPPORTING is `{contains, reachable_from}`), which is the precedent.
 *
 * Found by the self-check rather than by reasoning, which is the argument for
 * having one.
 */
const NON_TRAVERSABLE = new Set(["contains", "tests", "reachable_from"]);

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function loadGraph(repo = REPO_ROOT) {
  const dir = join(repo, ".visual-intelligence", "graph");
  return { nodes: readJsonl(join(dir, "nodes.jsonl")), edges: readJsonl(join(dir, "edges.jsonl")) };
}

/**
 * The seeds the vendored walker ACTUALLY used, read off the synthetic
 * entrypoint node it wrote into the graph (`attributes.roots`), and labelled
 * from the hand-authored manifest where a label can be matched.
 *
 * Deriving the seeds from the manifest instead was the first attempt and it
 * was wrong: the manifest names a `library-export` symbol in short form
 * ("arborPlugin") while the graph addresses it as a fully-qualified node id
 * (`sym:@arbor/opencode::packages/arbor-opencode/src/plugin.ts::arborPlugin`).
 * The short form matches no node, so that seed contributed nothing and the
 * union came up 20 nodes short of the committed set. The self-check caught it,
 * which is the entire reason the self-check exists — a partition derived from
 * a seed list the real walk never used would have looked perfectly plausible.
 *
 * Reading the graph's own record keeps this module honest by construction:
 * the seeds cannot drift from the walk they are meant to split.
 */
export function declaredRoots(repo = REPO_ROOT) {
  const { nodes } = loadGraph(repo);
  const entrypointNode = nodes.find((n) => n.kind === "entrypoint");
  const seeds = entrypointNode?.attributes?.roots ?? [];

  // Labels are a convenience for the report, never the source of the seeds.
  const labels = new Map();
  const manifestPath = join(repo, "scripts", "reachability", "entry-points.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const entry of manifest.entryPoints ?? []) {
      if (entry?.file) labels.set(`file:${entry.file}`, entry.id);
      if (entry?.symbol && entry?.file) {
        for (const seed of seeds) {
          if (seed.startsWith("sym:") && seed.endsWith(`::${entry.symbol}`) && seed.includes(entry.file)) {
            labels.set(seed, `${entry.id}:${entry.symbol}`);
          }
        }
      }
    }
  }
  return seeds.map((node) => ({ id: labels.get(node) ?? node, node, kind: node.startsWith("sym:") ? "library-export" : "process-entry" }));
}

/**
 * Adjacency as the vendored walker builds it, plus the one first-party
 * reachability inheritance the finished graph adds afterward.
 *
 * A lexical projection is stored as `local --reachable_from--> entrypoint`
 * with its exact `execution_scope_owner`. Per-root attribution must reverse
 * that evidence into `owner -> local`; traversing the published edge itself
 * would incorrectly jump to the synthetic entrypoint set. No other
 * `reachable_from` edge is supporting adjacency.
 */
export function buildAdjacency(edges) {
  const adjacency = new Map();
  for (const e of edges) {
    if (
      e.relation === "reachable_from" &&
      e.evidence_type === "lsp_lexical_scope_reachability" &&
      e.attributes?.identity_mapping === "lexical_scope_owner" &&
      typeof e.attributes.execution_scope_owner === "string"
    ) {
      const owner = e.attributes.execution_scope_owner;
      if (!adjacency.has(owner)) adjacency.set(owner, []);
      adjacency.get(owner).push(e.source);
      continue;
    }
    if (NON_TRAVERSABLE.has(e.relation)) continue;
    if (e.attributes?.type_only === true) continue;
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    adjacency.get(e.source).push(e.target);
  }
  return adjacency;
}

/** Breadth-first closure from one seed, over that adjacency. */
export function reachableFrom(seed, adjacency) {
  const reached = new Set([seed]);
  const queue = [seed];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adjacency.get(cur) ?? []) {
      if (!reached.has(next)) { reached.add(next); queue.push(next); }
    }
  }
  return reached;
}

/**
 * Rule `CIRCUIT-DAG-1` — the cited/derived rule, stated here verbatim and NOT
 * to be weakened. An edge is *cited* if and only if its `evidence_location`
 * names a line; *derived* is the negation. There is no judgement in the rule.
 *
 * The rule is CORRECT at this revision: on the committed 133,087-edge corpus it
 * partitions every edge, 110,472 cited + 22,615 derived = 133,087 exactly.
 *
 * WHAT IT IS NOT IS INDEPENDENTLY VALIDATED. `CD-CD-01`: on this corpus the
 * rule is 100% collinear with the relation-side predicate
 * `source.startsWith("pkg:") || relation === "reachable_from"`, which never
 * inspects `evidence_location` at all — NOT ONE EDGE IN 133,087 disagrees. So
 * the rule partitions relations perfectly and discriminates NOTHING: the two
 * are different properties, and only the first has evidence here. Correctness
 * and validatedness are different properties (X-09); collapsing them would
 * either overstate the rule or discard a correct artifact. Neither is done
 * here: the rule stands, and its weaker validation is stated wherever it is
 * relied on.
 */
const CITED_EVIDENCE = /^(?<path>.+):(?<line>\d+)$/;

/** `CIRCUIT-DAG-1`, applied. `true` = cited, `false` = derived. */
export function isCitedByRule(edge) {
  return CITED_EVIDENCE.test(String(edge.evidence_location ?? ""));
}

/**
 * The renderer-side STRUCTURAL approximation:
 *
 *   relation === "reachable_from"
 *   || (relation === "contains" && an endpoint node-id starts with "file:")
 *
 * `CD-CD-04`: this matches ALL 22,615 derived edges with 0 exceptions (SOUND)
 * **and also 34,519 CITED edges** — package/symbol containment that carries a
 * real `path:line`. It is therefore INCOMPLETE: a one-way screen, never a
 * classifier.
 *
 * The name is the restriction. This predicate may only ever support the claim
 * "definitely derived". It must NEVER be the thing that decides an edge IS
 * derived — see `definitelyDerived`, which is the conjunction with the rule
 * and is what a consumer may act on.
 */
export function matchesStructuralApproximation(edge) {
  if (edge.relation === "reachable_from") return true;
  if (edge.relation !== "contains") return false;
  return String(edge.source ?? "").startsWith("file:") || String(edge.target ?? "").startsWith("file:");
}

/**
 * "DEFINITELY derived" — the only claim the structural approximation is
 * allowed to support, made so it is the ONLY claim it is asked for.
 *
 * = the rule says derived AND the structural screen agrees. Because the rule
 * is the binding half, an edge the approximation matches but the rule calls
 * cited is NOT returned: a `cited` edge matching the approximation is never
 * marked derived. That is the whole point of the conjunction.
 */
export function definitelyDerived(edge) {
  return matchesStructuralApproximation(edge) && !isCitedByRule(edge);
}

/**
 * The set the vendored walker already committed, for cross-checking.
 *
 * Restricted to `definitelyDerived` rather than a bare `relation` test, so a
 * `reachable_from` edge that carried a real `path:line` citation could not be
 * counted as inferred. There are 0 such edges in the corpus
 * (`structural_restatement.reachable_from_edges_carrying_path_line = 0`), so
 * this narrows the CLAIM, not the result — verified in the evidence file.
 */
export function committedReachable(edges) {
  const set = new Set();
  for (const e of edges) if (definitelyDerived(e) && e.relation === "reachable_from") set.add(e.source);
  return set;
}

/**
 * Per-root reachability, plus the partition that matters: which nodes are
 * reachable from EVERY root, and which from only SOME.
 */
export function analyzeEntrypointReachability({ repo = REPO_ROOT } = {}) {
  const { nodes, edges } = loadGraph(repo);
  const roots = declaredRoots(repo);
  const adjacency = buildAdjacency(edges);
  const knownNodes = new Set(nodes.map((n) => n.id));

  const perRoot = [];
  const rootsByNode = new Map();
  const missingRoots = [];
  for (const root of roots) {
    if (!knownNodes.has(root.node)) { missingRoots.push(root); continue; }
    const reached = reachableFrom(root.node, adjacency);
    perRoot.push({ ...root, reached_count: reached.size, reached });
    for (const id of reached) {
      if (!rootsByNode.has(id)) rootsByNode.set(id, new Set());
      rootsByNode.get(id).add(root.id);
    }
  }

  // Self-check against the vendored walker's own committed result. The union
  // of every per-root closure must equal what it recorded; a disagreement
  // means this module's mirrored adjacency rule has drifted from the real one
  // and every conclusion below would be derived from a stale algorithm.
  const committed = committedReachable(edges);
  const union = new Set(rootsByNode.keys());
  const onlyHere = [...union].filter((id) => !committed.has(id));
  const onlyThere = [...committed].filter((id) => !union.has(id));
  const agrees = onlyHere.length === 0 && onlyThere.length === 0;

  const rootCount = perRoot.length;
  const universal = [];
  const partial = [];
  for (const [id, from] of rootsByNode) {
    if (from.size === rootCount) universal.push(id);
    else partial.push({ node: id, reachable_from: [...from].sort(), missing_from: perRoot.map((r) => r.id).filter((r) => !from.has(r)) });
  }

  return {
    ok: agrees,
    roots: perRoot.map(({ reached, ...rest }) => rest),
    missing_roots: missingRoots,
    total_nodes: nodes.length,
    reachable_nodes: union.size,
    universal_count: universal.length,
    partial_count: partial.length,
    partial: partial.sort((a, b) => a.node.localeCompare(b.node)),
    self_check: {
      agrees,
      committed_reachable: committed.size,
      union_reachable: union.size,
      only_in_this_module: onlyHere.slice(0, 20),
      only_in_committed_graph: onlyThere.slice(0, 20),
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main() {
  // `--root` is a reporting seam only, inert when the flag is absent: it
  // selects which committed graph to walk, so `guard:canaries` can point this
  // gate at a fixture. The report is still `analyzeEntrypointReachability`'s
  // own return value, including its self-check.
  const rootIndex = process.argv.indexOf("--root");
  const repo = rootIndex >= 0 && process.argv[rootIndex + 1]
    ? resolvePath(process.argv[rootIndex + 1])
    : REPO_ROOT;
  const report = analyzeEntrypointReachability({ repo });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  console.log(`entrypoint-reachability — ${report.roots.length} declared root(s) over ${report.total_nodes} node(s)\n`);
  for (const root of report.roots) {
    console.log(`  ${String(root.reached_count).padStart(6)}  ${root.id}  (${root.node})`);
  }
  console.log("");

  if (report.missing_roots.length > 0) {
    console.log(`${report.missing_roots.length} declared root(s) are NOT in the graph — they cannot seed anything:`);
    for (const r of report.missing_roots) console.log(`  ${r.id}  ${r.node}`);
    console.log("");
  }

  console.log(`reachable from EVERY root : ${report.universal_count}`);
  console.log(`reachable from SOME only  : ${report.partial_count}   <-- the distinction the union walk cannot make\n`);

  if (!report.self_check.agrees) {
    console.log("SELF-CHECK FAILED — this module's adjacency rule disagrees with the committed graph.");
    console.log(`  committed reachable: ${report.self_check.committed_reachable}   union of per-root: ${report.self_check.union_reachable}`);
    console.log("  Every partition above is therefore derived from a stale copy of the vendored walk.");
    console.log("  Do not act on this report until the rule is re-mirrored.\n");
    console.log("FAIL");
    return 1;
  }

  console.log(`self-check: PASS — the union of per-root closures equals the ${report.self_check.committed_reachable} nodes`);
  console.log("  the vendored extractor committed, so this partition is the same walk, split by seed.\n");
  console.log("PASS");
  return 0;
}

if (resolvePath(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
