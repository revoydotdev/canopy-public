import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeIsolatedSymbols,
  classifyExclusion,
  isFixturePath,
  weaklyConnectedComponents,
} from "../isolated-symbols.mjs";

/**
 * scripts/tests/isolated-symbols.test.mjs — the vendored isolated-components
 * query is vacuous by construction: it excludes `reachable_from` from
 * connectivity, the entrypoint node only ever touches `reachable_from` edges,
 * so `contains_entrypoint: false` matches every component including one with
 * 17,777 members. Real singletons were buried inside that always-true bucket
 * and never examined.
 *
 * The properties worth protecting, in order:
 *   1. A genuinely isolated node IS reported — no predicate that can go
 *      vacuous, ranked directly by component size.
 *   2. A connected node is NOT reported, through any counted relation.
 *   3. Each documented exclusion actually fires on the shape of node it
 *      claims to fire on, and nothing else.
 *   4. `type_only` edges still count as connectivity here (a deliberate
 *      deviation from the vendored `runtimeEdges`, which drops them) — a
 *      type used only in type positions is used, not dead.
 *   5. `reachable_from` edges never count as connectivity, even though they
 *      touch the node — they point at a synthetic sentinel, not at real
 *      code, and are surfaced only as an annotation.
 *   6. An empty or missing graph is handled, not crashed on.
 */

const dirs = [];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function writeJsonl(path, records) {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
}

function fixture({ nodes = [], edges = [], files = {} } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "isolated-symbols-repo-"));
  dirs.push(repoRoot);
  const graphDir = join(repoRoot, ".visual-intelligence", "graph");
  mkdirSync(graphDir, { recursive: true });
  writeJsonl(join(graphDir, "nodes.jsonl"), nodes);
  writeJsonl(join(graphDir, "edges.jsonl"), edges);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(repoRoot, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return { repoRoot, graphDir };
}

function symbolNode(id, { path, name, exported = true, kind = "symbol" } = {}) {
  return {
    id,
    kind,
    name: name ?? id,
    qualified_name: id,
    repository_path: path,
    attributes: { exported },
  };
}

function edge(source, target, relation, attributes = {}) {
  return { id: `edge:${source}->${target}:${relation}`, source, target, relation, direction: "directed", attributes };
}

describe("a genuinely isolated node is reported", () => {
  it("an exported symbol with zero meaningful edges shows up ranked by component size 1", () => {
    const { graphDir, repoRoot } = fixture({
      nodes: [symbolNode("sym:a", { path: "src/a.ts", name: "lonely" })],
      edges: [],
    });
    const report = analyzeIsolatedSymbols({ graphDir, repoRoot, checkExtractionGaps: false });
    expect(report.results.map((r) => r.id)).toEqual(["sym:a"]);
    expect(report.results[0].component_size).toBe(1);
  });

  it("explains why: only a 'contains' edge from its file and nothing else", () => {
    const { graphDir, repoRoot } = fixture({
      nodes: [
        { id: "file:a.ts", kind: "file", name: "a.ts", repository_path: "src/a.ts", attributes: {} },
        symbolNode("sym:a", { path: "src/a.ts", name: "lonely" }),
      ],
      edges: [edge("file:a.ts", "sym:a", "contains")],
    });
    const report = analyzeIsolatedSymbols({ graphDir, repoRoot, checkExtractionGaps: false });
    const found = report.results.find((r) => r.id === "sym:a");
    expect(found.why_isolated).toMatch(/only inbound edge is 'contains'/);
  });
});

describe("a connected node is not reported", () => {
  it("two symbols joined by a 'calls' edge are excluded from results", () => {
    const { graphDir, repoRoot } = fixture({
      nodes: [
        symbolNode("sym:caller", { path: "src/a.ts", name: "caller" }),
        symbolNode("sym:callee", { path: "src/b.ts", name: "callee" }),
      ],
      edges: [edge("sym:caller", "sym:callee", "calls")],
    });
    const report = analyzeIsolatedSymbols({ graphDir, repoRoot, checkExtractionGaps: false });
    expect(report.results).toEqual([]);
  });

  it("type_only edges still count as connectivity, unlike the vendored runtimeEdges", () => {
    const { graphDir, repoRoot } = fixture({
      nodes: [
        symbolNode("type:X", { path: "src/a.ts", name: "X", kind: "type" }),
        symbolNode("sym:usesX", { path: "src/b.ts", name: "usesX" }),
      ],
      edges: [edge("sym:usesX", "type:X", "references", { type_only: true })],
    });
    const report = analyzeIsolatedSymbols({ graphDir, repoRoot, checkExtractionGaps: false });
    expect(report.results.map((r) => r.id)).not.toContain("type:X");
  });

  it("reachable_from edges do NOT count as connectivity, even though they touch the node", () => {
    const { graphDir, repoRoot } = fixture({
      nodes: [
        { id: "ep:1", kind: "entrypoint", name: "entry", attributes: {} },
        symbolNode("sym:reached", { path: "src/a.ts", name: "reached" }),
      ],
      edges: [edge("sym:reached", "ep:1", "reachable_from")],
    });
    const report = analyzeIsolatedSymbols({ graphDir, repoRoot, checkExtractionGaps: false });
    const found = report.results.find((r) => r.id === "sym:reached");
    expect(found).toBeDefined();
    expect(found.reachable_from_entrypoint).toBe(true);
  });
});

describe("documented exclusions actually fire", () => {
  it("a non-exported symbol is excluded as a destructuring/local-binding noise pattern", () => {
    const node = symbolNode("sym:local", { path: "src/a.ts", name: "id", exported: false });
    const { excluded, reason } = classifyExclusion(node);
    expect(excluded).toBe(true);
    expect(reason).toMatch(/non-exported symbol/);
  });

  it("an exported symbol is NOT excluded by the non-exported rule", () => {
    const node = symbolNode("sym:pub", { path: "src/a.ts", name: "pub", exported: true });
    expect(classifyExclusion(node).excluded).toBe(false);
  });

  it("a fixture-path node is excluded regardless of kind", () => {
    const node = symbolNode("sym:fixture", {
      path: "packages/arbor-governance/tests/obligation/fixtures/repo/a.ts",
      name: "sharedName",
      exported: true,
    });
    const { excluded, reason } = classifyExclusion(node);
    expect(excluded).toBe(true);
    expect(reason).toMatch(/fixture/);
  });

  it("isFixturePath matches both fixtures/ and __fixtures__/", () => {
    expect(isFixturePath("a/fixtures/b.ts")).toBe(true);
    expect(isFixturePath("a/__fixtures__/b.ts")).toBe(true);
    expect(isFixturePath("a/fixturesnot/b.ts")).toBe(false);
    expect(isFixturePath(null)).toBe(false);
  });

  it("record, package, and entrypoint kinds are excluded as out of scope", () => {
    for (const kind of ["record", "package", "entrypoint"]) {
      const node = { id: `x:${kind}`, kind, name: kind, repository_path: null, attributes: {} };
      const { excluded, reason } = classifyExclusion(node);
      expect(excluded).toBe(true);
      expect(reason).toMatch(new RegExp(kind));
    }
  });

  it("end to end: an isolated non-exported symbol does not appear in the report", () => {
    const { graphDir, repoRoot } = fixture({
      nodes: [symbolNode("sym:destructured", { path: "src/a.ts", name: "id", exported: false })],
      edges: [],
    });
    const report = analyzeIsolatedSymbols({ graphDir, repoRoot, checkExtractionGaps: false });
    expect(report.results).toEqual([]);
    expect(report.excluded_count).toBe(1);
  });

  it("end to end: an isolated fixture-path node does not appear in the report", () => {
    const { graphDir, repoRoot } = fixture({
      nodes: [
        symbolNode("sym:fixture", {
          path: "packages/arbor-governance/tests/obligation/fixtures/repo/a.ts",
          name: "sharedName",
          exported: true,
        }),
      ],
      edges: [],
    });
    const report = analyzeIsolatedSymbols({ graphDir, repoRoot, checkExtractionGaps: false });
    expect(report.results).toEqual([]);
    expect(report.excluded_count).toBe(1);
  });
});

describe("an empty or missing graph is handled, not crashed on", () => {
  it("a missing graph directory returns a clean 'not present' report", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "isolated-symbols-empty-"));
    dirs.push(repoRoot);
    const report = analyzeIsolatedSymbols({ graphDir: join(repoRoot, "nope"), repoRoot });
    expect(report.ok).toBe(true);
    expect(report.graph_present).toBe(false);
    expect(report.results).toEqual([]);
  });

  it("an empty nodes.jsonl returns zero results, not an error", () => {
    const { graphDir, repoRoot } = fixture({ nodes: [], edges: [] });
    const report = analyzeIsolatedSymbols({ graphDir, repoRoot });
    expect(report.ok).toBe(true);
    expect(report.results).toEqual([]);
  });
});

describe("weaklyConnectedComponents is the raw primitive the report ranks by", () => {
  it("sorts components smallest-first", () => {
    const ids = new Set(["a", "b", "c", "d"]);
    const edges = [edge("a", "b", "calls")]; // {a,b} size 2, {c} size 1, {d} size 1
    const comps = weaklyConnectedComponents(ids, edges);
    expect(comps.map((c) => c.length)).toEqual([1, 1, 2]);
  });
});

describe("the canonical query pack retires the vacuous aggregate", () => {
  it("does not emit the vendored isolated-components predicate that can never discriminate", () => {
    const pack = JSON.parse(readFileSync(join(REPO_ROOT, ".visual-intelligence", "queries", "queries.json"), "utf8"));
    expect(pack.queries.map((query) => query.name)).not.toContain("isolated-components");
  });
});
