import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeEntrypointReachability, buildAdjacency, reachableFrom, committedReachable, loadGraph, declaredRoots,
  isCitedByRule, matchesStructuralApproximation, definitelyDerived,
} from "../entrypoint-reachability.mjs";

/**
 * scripts/tests/entrypoint-reachability.test.mjs — the partition must be the
 * SAME walk the graph already recorded, split by seed.
 *
 * The whole module is a re-implementation of a walk that lives in vendored
 * code nobody may edit. That makes fidelity the only property worth
 * protecting: a per-root partition derived from a subtly different adjacency
 * rule would look completely plausible and be quietly wrong about which entry
 * point can reach what.
 *
 * So the load-bearing test is the self-check itself, run against the real
 * committed graph. Two mistakes were caught by it while this was written, and
 * neither was visible by reading:
 *   1. Seeding from the hand-authored manifest instead of the graph's own
 *      recorded roots — the manifest names a symbol in short form, the graph in
 *      fully-qualified form, so that seed silently contributed nothing.
 *   2. Traversing `reachable_from` edges, which the vendored walker cannot
 *      traverse because it emits them only after its own adjacency is built.
 */

/**
 * ADR-078 class C (live by design): these tests assert over the REAL graph
 * `.visual-intelligence/graph/`, which is gitignored and produced by
 * `vi:refresh`. A fresh clone or worktree has none, and `loadGraph` reads a
 * missing file as an empty list, so the SELF-CHECK would pass hollow (0 === 0)
 * and the rest would fail on a count of zero. Skip them, with the reason, when
 * the graph is absent rather than report either a false pass or a false fail.
 * The pure-function tests below need no graph and always run.
 */
const GRAPH_PRESENT = existsSync(new URL("../../.visual-intelligence/graph/nodes.jsonl", import.meta.url))
  && existsSync(new URL("../../.visual-intelligence/graph/edges.jsonl", import.meta.url));
const itLive = it.skipIf(!GRAPH_PRESENT);

describe("the per-root partition is faithful to the committed walk", () => {
  itLive("SELF-CHECK [live graph; skipped when .visual-intelligence/graph is absent]: the union of per-root closures equals the committed reachable set", () => {
    // If this fails, every per-root claim this module makes is derived from a
    // stale copy of someone else's algorithm and must not be acted on.
    const report = analyzeEntrypointReachability();
    expect(report.self_check.only_in_this_module).toEqual([]);
    expect(report.self_check.only_in_committed_graph).toEqual([]);
    expect(report.self_check.union_reachable).toBe(report.self_check.committed_reachable);
    expect(report.ok).toBe(true);
  });

  itLive("seeds come from the graph's own record, not the hand-authored manifest", () => {
    // The manifest and the graph disagree on how a library-export symbol is
    // addressed. Seeding from the manifest drops that root silently.
    const { nodes } = loadGraph();
    const recorded = nodes.find((n) => n.kind === "entrypoint")?.attributes?.roots ?? [];
    const seeded = declaredRoots().map((r) => r.node).sort();
    expect(seeded).toEqual([...recorded].sort());
    expect(seeded.some((s) => s.startsWith("sym:"))).toBe(true);
  });
});

describe("the adjacency rule mirrors the vendored walker", () => {
  const edge = (source, target, relation, attributes = {}) => ({ source, target, relation, attributes });

  it("excludes containment and test edges, as the extractor does", () => {
    const adjacency = buildAdjacency([
      edge("a", "b", "contains"),
      edge("a", "c", "tests"),
      edge("a", "d", "imports"),
    ]);
    expect(reachableFrom("a", adjacency)).toEqual(new Set(["a", "d"]));
  });

  it("excludes type-only imports — they erase at compile time", () => {
    const adjacency = buildAdjacency([edge("a", "b", "imports", { type_only: true })]);
    expect(reachableFrom("a", adjacency)).toEqual(new Set(["a"]));
  });

  it("TEETH: excludes reachable_from, the walker's OWN output", () => {
    // The vendored walker builds adjacency before emitting these, so it can
    // never traverse one. Reading the finished graph, this module can — and
    // walking them reaches the synthetic entrypoint node, which is exactly the
    // off-by-one the self-check caught.
    const adjacency = buildAdjacency([edge("a", "ep:synthetic", "reachable_from")]);
    expect(reachableFrom("a", adjacency)).toEqual(new Set(["a"]));
  });

  it("attributes an LSP lexical-scope local to the exact root that reaches its owner", () => {
    const adjacency = buildAdjacency([
      edge("root", "owner", "calls"),
      {
        source: "local",
        target: "ep:synthetic",
        relation: "reachable_from",
        evidence_type: "lsp_lexical_scope_reachability",
        attributes: { identity_mapping: "lexical_scope_owner", execution_scope_owner: "owner" },
      },
    ]);
    expect(reachableFrom("root", adjacency)).toEqual(new Set(["root", "owner", "local"]));
  });

  it("does not treat malformed or ordinary reachable_from edges as lexical support", () => {
    const adjacency = buildAdjacency([
      edge("local-a", "ep:synthetic", "reachable_from", { execution_scope_owner: "owner" }),
      {
        source: "local-b",
        target: "ep:synthetic",
        relation: "reachable_from",
        evidence_type: "lsp_lexical_scope_reachability",
        attributes: { identity_mapping: "different", execution_scope_owner: "owner" },
      },
    ]);
    expect(reachableFrom("owner", adjacency)).toEqual(new Set(["owner"]));
  });

  it("follows ordinary runtime relations transitively", () => {
    const adjacency = buildAdjacency([edge("a", "b", "imports"), edge("b", "c", "calls")]);
    expect(reachableFrom("a", adjacency)).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("the partition answers the question the union walk cannot", () => {
  itLive("reports, per node, WHICH roots reach it", () => {
    const report = analyzeEntrypointReachability();
    expect(report.roots.length).toBeGreaterThan(1);
    for (const entry of report.partial.slice(0, 50)) {
      expect(Array.isArray(entry.reachable_from)).toBe(true);
      expect(entry.reachable_from.length).toBeGreaterThan(0);
      // A node in `partial` is by definition not reached by every root.
      expect(entry.reachable_from.length).toBeLessThan(report.roots.length);
      expect(entry.missing_from.length).toBeGreaterThan(0);
    }
  });

  itLive("separates the eval-only surface from what the shipped CLI can run", () => {
    // The ADR-035 distinction, now decidable: code reachable only from the
    // eval harness is not code the production CLI can execute, even though the
    // union walk calls both "reachable".
    const report = analyzeEntrypointReachability();
    const notFromMcpCli = report.partial.filter((p) => !p.reachable_from.includes("arbor-mcp-cli"));
    expect(notFromMcpCli.length).toBeGreaterThan(0);
    expect(notFromMcpCli.some((p) => p.node.includes("packages/arbor-eval/"))).toBe(true);
  });

  it("committedReachable reads only definitely-derived reachable_from edges", () => {
    const set = committedReachable([
      { source: "a", target: "ep:x", relation: "reachable_from", evidence_location: "bfs from 75 declared roots" },
      { source: "b", target: "c", relation: "imports", evidence_location: "x.ts:3" },
    ]);
    expect(set).toEqual(new Set(["a"]));
  });
});

/**
 * todo 20 — the cited/derived rule's collinearity limitation, as executable
 * assertions. Every negative here was pre-registered in
 * `.omo/graph-remediation/evidence/todo-20-DECLARED-EXPECTED-SET.md` BEFORE
 * the consumer change was written, with its corpus figures stated independently
 * (133,087 edges; 110,472 cited + 22,615 derived; the approximation matches
 * 34,519 CITED edges as well as all 22,615 derived; 0 relation/shape
 * disagreements).
 *
 * The rule is NOT deleted. It is correct at this revision; its validation is
 * weaker than its correctness (X-09). What is asserted here is that the
 * STRUCTURAL approximation cannot be used to LABEL an edge derived.
 */
describe("cited/derived rule: the structural approximation is one-way only (CD-CD-01, CD-CD-04)", () => {
  it("N1 — a CITED edge matching the approximation is NOT marked derived (the QA-happy case)", () => {
    // Verbatim from the committed corpus: containment with a real path:line.
    const citedButStructural = {
      id: "edge:00004a92702716a5",
      source: "file:packages/arbor-mcp/tests/governance-projection.test.ts",
      target: "sym:@arbor/mcp::packages/arbor-mcp/tests/governance-projection.test.ts::empty",
      relation: "contains",
      evidence_location: "packages/arbor-mcp/tests/governance-projection.test.ts:497",
      confidence: "authoritative",
    };
    // It matches the approximation …
    expect(matchesStructuralApproximation(citedButStructural)).toBe(true);
    // … and the rule calls it CITED, not derived …
    expect(isCitedByRule(citedButStructural)).toBe(true);
    // … so the one-way screen must NOT report it as definitely derived.
    expect(definitelyDerived(citedButStructural)).toBe(false);
    // And it must not reach the consumer's committed set either.
    expect(committedReachable([{ ...citedButStructural, relation: "contains" }])).toEqual(new Set());
  });

  it("N2 — the screen and the rule are DIFFERENT predicates, not one renamed", () => {
    // Synthetic on purpose: the corpus has 0 reachable_from edges carrying a
    // path:line (structural_restatement.reachable_from_edges_carrying_path_line = 0),
    // so this divergence is real but unreachable from the corpus. It exists to
    // prove the conjunction is load-bearing rather than decorative.
    const reachableFromButCited = {
      source: "sym:x", target: "ep:set", relation: "reachable_from",
      evidence_location: "packages/a.ts:42",
    };
    expect(matchesStructuralApproximation(reachableFromButCited)).toBe(true);
    expect(isCitedByRule(reachableFromButCited)).toBe(true);
    expect(definitelyDerived(reachableFromButCited)).toBe(false);
    // The consumer's CLAIM is narrowed: the bare-relation version would count it.
    expect(committedReachable([reachableFromButCited])).toEqual(new Set());
  });

  it("N3 — the `file:` arm is load-bearing, not decoration", () => {
    // `pkg:` -> `sym:` containment: derived by the rule, but the approximation's
    // `file:` arm does not reach it, so the screen alone would miss it.
    const pkgToSymbol = {
      source: "pkg:@arbor/mcp", target: "sym:@arbor/mcp::src/a.ts::f",
      relation: "contains", evidence_location: "packages/arbor-mcp/src/a.ts",
    };
    expect(isCitedByRule(pkgToSymbol)).toBe(false);
    expect(matchesStructuralApproximation(pkgToSymbol)).toBe(false);
    expect(definitelyDerived(pkgToSymbol)).toBe(false);
  });

  it("N4 — a prose-evidence BFS edge IS definitely derived", () => {
    const bfs = {
      source: "sym:x", target: "ep:set", relation: "reachable_from",
      evidence_location: "bfs from 75 declared roots",
    };
    expect(isCitedByRule(bfs)).toBe(false);
    expect(matchesStructuralApproximation(bfs)).toBe(true);
    expect(definitelyDerived(bfs)).toBe(true);
  });

  it("confidence cannot substitute for the rule: every value spans both classes", () => {
    // The measurement that forced this todo. If confidence separated the
    // classes it would be a usable citation filter; it is not, so the
    // structural screen has nothing better to fall back on — which is exactly
    // why it must stay one-way. Corpus figures, restated as an invariant.
    const corpus = [
      { relation: "calls", evidence_location: "a.ts:1", confidence: "high" },
      { relation: "reachable_from", evidence_location: "bfs from 75 declared roots", confidence: "high" },
      { relation: "contains", evidence_location: "b.ts:2", confidence: "authoritative" },
      { relation: "contains", evidence_location: "packages/b.ts", confidence: "authoritative" },
      { relation: "tests", evidence_location: "c.ts:3", confidence: "medium" },
    ];
    for (const confidence of ["high", "authoritative"]) {
      expect(corpus.some((e) => e.confidence === confidence && isCitedByRule(e))).toBe(true);
      expect(corpus.some((e) => e.confidence === confidence && !isCitedByRule(e))).toBe(true);
    }
  });
});
