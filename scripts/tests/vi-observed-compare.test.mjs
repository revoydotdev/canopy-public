import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

const TMP = [];
function fixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `revoy2-${prefix}-`));
  TMP.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

function runCompare({ env = {}, args = [] } = {}) {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "vi-observed-compare.mjs"), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const symbolNode = (id, file, attributes = {}) => ({
  id, kind: "symbol", name: id.split("::").pop(), repository_path: file, symbol: id.split("::").pop(), attributes,
});
const edge = (source, relation, target) => ({ id: `edge:${source}:${relation}:${target}`, source, relation, target });

/**
 * Build a minimal fixture graph + observed store, return their dirs.
 * `visibility` defaults to every fixture symbol being instrument-visible
 * under production — the pre-visibility tests' implicit assumption, made
 * explicit. Pass `visibility: []` to model a symbol the instrument cannot
 * see (a constant), or omit specific symbols.
 */
function buildFixture({ symbols, edges, observations, visibility, catalogHash = "abc123" }) {
  const graphDir = fixture("graph");
  writeFileSync(join(graphDir, "nodes.jsonl"), symbols.map((s) => JSON.stringify(s)).join("\n") + (symbols.length ? "\n" : ""));
  writeFileSync(join(graphDir, "edges.jsonl"), edges.map((e) => JSON.stringify(e)).join("\n") + (edges.length ? "\n" : ""));

  const observedDir = fixture("observed");
  writeFileSync(join(observedDir, "manifest.json"), JSON.stringify({ schema_version: 1, catalog_content_hash: catalogHash }));
  writeFileSync(join(observedDir, "observations.jsonl"), observations.map((o) => JSON.stringify(o)).join("\n") + (observations.length ? "\n" : ""));
  const vis = visibility ?? symbols.map((s) => ({ symbol_id: s.id, run_class: "production" }));
  writeFileSync(join(observedDir, "instrument-visibility.jsonl"), vis.map((v) => JSON.stringify(v)).join("\n") + (vis.length ? "\n" : ""));

  const findingsDir = fixture("findings");
  return { graphDir, observedDir, findingsDir };
}

/** An invoked sibling in the same file, so the file counts as exercised and hollow candidacy applies. */
function invokedSibling(file) {
  const sym = `sym:pkg::${file}::used`;
  return {
    symbol: symbolNode(sym, file),
    edges: [edge(sym, "reachable_from", "ep:root")],
    observation: { symbol_id: sym, scenario_id: "s1", run_class: "production", count: 1 },
  };
}

describe("vi-observed-compare.mjs", () => {
  it("reports typed absence and exits 0 when the observed store does not exist", () => {
    const { graphDir, findingsDir } = buildFixture({ symbols: [], edges: [], observations: [] });
    const missingObservedDir = fixture("missing-observed"); // created but we point elsewhere, deliberately absent
    rmSync(missingObservedDir, { recursive: true, force: true });
    const { code, out } = runCompare({
      env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: missingObservedDir, REVOY2_VI_FINDINGS_DIR: findingsDir },
    });
    expect(code).toBe(0);
    expect(out).toContain("absent");
  });

  it("FAILS loudly on a pre-visibility observed store (no instrument-visibility.jsonl)", () => {
    const { graphDir, observedDir, findingsDir } = buildFixture({ symbols: [], edges: [], observations: [] });
    rmSync(join(observedDir, "instrument-visibility.jsonl"));
    const { code, out } = runCompare({ env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    expect(code).toBe(1);
    expect(out).toContain("instrument-visibility");
  });

  it("emits a hollow_candidate for an uninvoked visible symbol in an otherwise-exercised file", () => {
    const sym = "sym:pkg::a.ts::foo";
    const sib = invokedSibling("a.ts");
    const { graphDir, observedDir, findingsDir } = buildFixture({
      symbols: [symbolNode(sym, "a.ts"), sib.symbol],
      edges: [edge(sym, "reachable_from", "ep:root"), edge("file:a.tests.ts", "tests", sym), ...sib.edges],
      observations: [sib.observation], // foo itself: never observed
    });
    const { code, out } = runCompare({ env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    expect(code).toBe(0);
    expect(out).toContain("1 hollow_candidate");
    const findings = readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const hollow = findings.find((f) => f.category === "hollow_candidate");
    expect(hollow.affected_nodes).toEqual([sym]);
    expect(hollow.observed_model).toContain("never invoked under the declared scenario catalog");
    expect(hollow.observed_model).not.toContain("dead"); // catalog-relative honesty, never "dead"
  });

  it("does NOT emit hollow_candidate for an instrument-INVISIBLE symbol (a constant) — no function range, no lead", () => {
    const sym = "sym:pkg::a.ts::SOME_CONSTANT";
    const sib = invokedSibling("a.ts");
    const { graphDir, observedDir, findingsDir } = buildFixture({
      symbols: [symbolNode(sym, "a.ts"), sib.symbol],
      edges: [edge(sym, "reachable_from", "ep:root"), edge("file:a.tests.ts", "tests", sym), ...sib.edges],
      observations: [sib.observation],
      // only the sibling is visible; the constant has no coverable range
      visibility: [{ symbol_id: sib.symbol.id, run_class: "production" }],
    });
    const { out } = runCompare({ env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    expect(out).toContain("0 hollow_candidate");
  });

  it("routes an uninvoked symbol in a WHOLLY-uninvoked file to the catalog-coverage advisory, not a human-verdict finding", () => {
    const sym = "sym:pkg::packages/arbor-demo/src/a.ts::foo";
    const { graphDir, observedDir, findingsDir } = buildFixture({
      symbols: [symbolNode(sym, "packages/arbor-demo/src/a.ts")],
      edges: [edge(sym, "reachable_from", "ep:root"), edge("file:a.tests.ts", "tests", sym)],
      observations: [], // the file never had any invocation
    });
    const { out } = runCompare({ env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    expect(out).toContain("0 hollow_candidate");
    expect(out).toContain("1 package(s) in catalog-coverage advisory (ADR-090, not triaged)");
    const findingsText = readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim();
    expect(findingsText).toBe("");
    const coverage = JSON.parse(readFileSync(join(observedDir, "catalog-coverage.json"), "utf8"));
    expect(coverage).toMatchObject({
      kind: "catalog_coverage_advisory",
      package_count: 1,
      packages: [{
        package: "arbor-demo",
        uninvoked_file_count: 1,
        uninvoked_symbol_count: 1,
        files: [{ file: "packages/arbor-demo/src/a.ts", uninvoked_symbol_count: 1 }],
      }],
    });
  });

  it("does NOT emit hollow_candidate for a symbol observed under a production scenario", () => {
    const sym = "sym:pkg::a.ts::foo";
    const { graphDir, observedDir, findingsDir } = buildFixture({
      symbols: [symbolNode(sym, "a.ts")],
      edges: [edge(sym, "reachable_from", "ep:root"), edge("file:a.tests.ts", "tests", sym)],
      observations: [{ symbol_id: sym, scenario_id: "s1", run_class: "production", count: 3 }],
    });
    const { out } = runCompare({ env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    expect(out).toContain("0 hollow_candidate");
  });

  it("does NOT emit hollow_candidate for an untested symbol, even if reachable, visible, and unobserved", () => {
    const sym = "sym:pkg::a.ts::foo";
    const sib = invokedSibling("a.ts");
    const { graphDir, observedDir, findingsDir } = buildFixture({
      symbols: [symbolNode(sym, "a.ts"), sib.symbol],
      edges: [edge(sym, "reachable_from", "ep:root"), ...sib.edges], // no 'tests' edge on foo
      observations: [sib.observation],
    });
    const { out } = runCompare({ env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    expect(out).toContain("0 hollow_candidate");
  });

  it("emits observed_unreachable for a symbol observed but not marked production-reachable", () => {
    const sym = "sym:pkg::a.ts::foo";
    const { graphDir, observedDir, findingsDir } = buildFixture({
      symbols: [symbolNode(sym, "a.ts")],
      edges: [], // no reachable_from edge at all
      observations: [{ symbol_id: sym, scenario_id: "s1", run_class: "production", count: 1 }],
    });
    const { out } = runCompare({ env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    expect(out).toContain("1 observed_unreachable");
  });

  it("reconciles a runtime-observed non-exported VariableDeclaration by direct execution evidence", () => {
    const sym = "sym:pkg::a.ts::localBinding";
    const { graphDir, observedDir, findingsDir } = buildFixture({
      symbols: [symbolNode(sym, "a.ts", { declaration: "VariableDeclaration", exported: false })],
      edges: [],
      observations: [{ symbol_id: sym, scenario_id: "s1", run_class: "production", count: 1 }],
    });
    const { code, out } = runCompare({ args: ["--json"], env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ observed_unreachable_findings: 0, observed_local_bindings_reconciled: 1 });
    expect(readFileSync(join(findingsDir, "findings.jsonl"), "utf8")).toBe("");
  });

  it("does not reconcile an exported variable merely because it was observed", () => {
    const sym = "sym:pkg::a.ts::exportedBinding";
    const { graphDir, observedDir, findingsDir } = buildFixture({
      symbols: [symbolNode(sym, "a.ts", { declaration: "VariableDeclaration", exported: true })],
      edges: [],
      observations: [{ symbol_id: sym, scenario_id: "s1", run_class: "production", count: 1 }],
    });
    const { out } = runCompare({ args: ["--json"], env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    expect(JSON.parse(out)).toMatchObject({ observed_unreachable_findings: 1, observed_local_bindings_reconciled: 0 });
  });

  it("does not reconcile another observed declaration kind", () => {
    const sym = "sym:pkg::a.ts::functionBinding";
    const { graphDir, observedDir, findingsDir } = buildFixture({
      symbols: [symbolNode(sym, "a.ts", { declaration: "FunctionDeclaration", exported: false })],
      edges: [],
      observations: [{ symbol_id: sym, scenario_id: "s1", run_class: "production", count: 1 }],
    });
    const { out } = runCompare({ args: ["--json"], env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    expect(JSON.parse(out)).toMatchObject({ observed_unreachable_findings: 1, observed_local_bindings_reconciled: 0 });
  });

  it("does not reconcile an unobserved local binding", () => {
    const sym = "sym:pkg::a.ts::localBinding";
    const sib = invokedSibling("a.ts");
    const { graphDir, observedDir, findingsDir } = buildFixture({
      symbols: [symbolNode(sym, "a.ts", { declaration: "VariableDeclaration", exported: false }), sib.symbol],
      edges: [edge(sym, "reachable_from", "ep:root"), edge("file:a.tests.ts", "tests", sym), ...sib.edges],
      observations: [sib.observation],
    });
    const { out } = runCompare({ args: ["--json"], env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    expect(JSON.parse(out)).toMatchObject({ hollow_candidate_findings: 1, observed_local_bindings_reconciled: 0 });
  });

  it("caps hollow_candidate findings at 50 files and emits one overflow finding stating the true total", () => {
    const symbols = [];
    const edges = [];
    const observations = [];
    for (let i = 0; i < 55; i++) {
      const file = `file${String(i).padStart(3, "0")}.ts`;
      const sym = `sym:pkg::${file}::foo`;
      symbols.push(symbolNode(sym, file));
      edges.push(edge(sym, "reachable_from", "ep:root"));
      edges.push(edge(`file:tests${i}.ts`, "tests", sym));
      const sib = invokedSibling(file);
      symbols.push(sib.symbol);
      edges.push(...sib.edges);
      observations.push(sib.observation);
    }
    const { graphDir, observedDir, findingsDir } = buildFixture({ symbols, edges, observations });
    const { out } = runCompare({ env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    expect(out).toContain("51 hollow_candidate"); // 50 capped + 1 overflow
    const findings = readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const hollow = findings.filter((f) => f.category === "hollow_candidate");
    expect(hollow.length).toBe(51);
    const overflow = hollow.find((f) => f.title.includes("overflow"));
    expect(overflow).toBeTruthy();
    expect(overflow.observed_model).toContain("55");
  });

  it("re-running replaces this script's own prior findings rather than accumulating duplicates, and keeps unrelated categories", () => {
    const sym = "sym:pkg::a.ts::foo";
    const sib = invokedSibling("a.ts");
    const { graphDir, observedDir, findingsDir } = buildFixture({
      symbols: [symbolNode(sym, "a.ts"), sib.symbol],
      edges: [edge(sym, "reachable_from", "ep:root"), edge("file:a.tests.ts", "tests", sym), ...sib.edges],
      observations: [sib.observation],
    });
    // Pre-seed an unrelated vendor-category finding that must survive the merge.
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(join(findingsDir, "findings.jsonl"), `${JSON.stringify({
      id: "VI-0001", category: "dead_code", title: "orphans-no-inbound: 1 record(s)", affected_nodes: [],
    })}\n`);

    runCompare({ env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });
    runCompare({ env: { REVOY2_VI_GRAPH_DIR: graphDir, REVOY2_VI_OBSERVED_DIR: observedDir, REVOY2_VI_FINDINGS_DIR: findingsDir } });

    const findings = readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const hollow = findings.filter((f) => f.category === "hollow_candidate");
    const vendor = findings.filter((f) => f.category === "dead_code");
    expect(hollow.length).toBe(1); // not doubled by the second run
    expect(vendor.length).toBe(1); // unrelated category preserved
  });
});
