import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// B3 — repair truncated and empty finding bodies produced by the skill's
// vi-validate.mjs (not editable under ADR-031 when written; first-party since
// ADR-176). Both defects
// are fixed repo-side in vi-observed-compare.mjs's own post-processing step,
// exercised here directly against findings.jsonl (no graph/observed store
// needed — the repair runs unconditionally, before the observed-plane
// comparison, and persists even when the observed store is absent).

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

function missingObservedDir() {
  const d = fixture("missing-observed");
  rmSync(d, { recursive: true, force: true }); // created then removed: deliberately absent
  return d;
}

/** Reproduces the real vi:030d46b62f9f0364 shape: a compute query hit ({size, members}) whose
 * affected_nodes filter strips everything, leaving the identities recoverable only from the
 * evidence[].locator JSON the vendored emitter falls back to. */
function computeShapedFinding(overrides = {}) {
  return {
    id: "VI-0001",
    severity: "high",
    category: "dead_code",
    title: "isolated-components: 753 record(s)",
    claim: "Which subgraphs have no path to any entrypoint?",
    affected_nodes: [],
    affected_edges: [],
    missing_edges: [],
    expected_model: "No record would match the query 'isolated-components'.",
    observed_model: "753 record(s) match.",
    evidence: [
      { locator: JSON.stringify({ size: 3, members: ["file:a.ts", "sym:pkg::a.ts::foo"] }), excerpt: null, discovery: "derived" },
      { locator: JSON.stringify({ size: 1, members: ["file:b.ts"] }), excerpt: null, discovery: "derived" },
    ],
    confidence: "high",
    corroborating_heuristics: [],
    impact: "x",
    likely_cause: null,
    remediation: "x",
    validation_method: "x",
    adr_refs: [],
    owner: null,
    found_at_revision: "abc123",
    status: "open",
    exception_id: null,
    ...overrides,
  };
}

/** A record query's direct `rec:` hits are valid node ids, but the vendored
 * emitter currently filters them out of affected_nodes alongside compute
 * objects. The evidence locator retains the exact subject identity. */
function recordShapedFinding(overrides = {}) {
  return computeShapedFinding({
    id: "VI-0003",
    category: "ownership_gap",
    title: "orphan-records: 2 record(s)",
    affected_nodes: [],
    evidence: [
      { locator: "rec:revoy2:ADR-009", excerpt: null, discovery: "derived" },
      { locator: "rec:revoy2:ADR-013", excerpt: null, discovery: "derived" },
    ],
    ...overrides,
  });
}

/** Reproduces the real vi:d9d7aa516a9cf9ce shape: a string-hit query whose affected_nodes is
 * silently capped at 100 while the title/observed_model still says the true, larger count. */
function truncatedFinding(overrides = {}) {
  const nodes = Array.from({ length: 5 }, (_, i) => `sym:pkg::f${i}.ts::x`); // fixture uses 5-of-9 to keep it small
  return {
    id: "VI-0002",
    severity: "high",
    category: "reachability_gap",
    title: "unreachable-production: 9 record(s)",
    claim: "Which production nodes have no path from any entrypoint?",
    affected_nodes: nodes,
    affected_edges: [],
    missing_edges: [],
    expected_model: "No record would match the query 'unreachable-production'.",
    observed_model: "9 record(s) match.",
    evidence: [],
    confidence: "high",
    corroborating_heuristics: [],
    impact: "x",
    likely_cause: null,
    remediation: "x",
    validation_method: "x",
    adr_refs: [],
    owner: null,
    found_at_revision: "abc123",
    status: "open",
    exception_id: null,
    ...overrides,
  };
}

describe("vi-observed-compare.mjs — B3a: recover affected_nodes from evidence (compute-shaped findings)", () => {
  it("recovers node identities embedded in evidence[].locator JSON when affected_nodes is empty", () => {
    const findingsDir = fixture("b3a-findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(join(findingsDir, "findings.jsonl"), `${JSON.stringify(computeShapedFinding())}\n`);

    const { code } = runCompare({
      env: { REVOY2_VI_GRAPH_DIR: fixture("b3a-graph"), REVOY2_VI_OBSERVED_DIR: missingObservedDir(), REVOY2_VI_FINDINGS_DIR: findingsDir },
    });
    expect(code).toBe(0);

    const findings = readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.affected_nodes).toEqual(["file:a.ts", "file:b.ts", "sym:pkg::a.ts::foo"]);
    expect(f.observed_model).toContain("affected_nodes recovered from");
    expect(f.observed_model).toContain("2 evidence record(s)");
    // The id must be recomputed to match the now-populated affected_nodes — a finding whose
    // content materially changed (from "points at nothing" to naming real nodes) must not keep
    // pretending its old id (which hashed an empty node list) still describes it.
    expect(f.id).not.toBe("VI-0001");
    expect(f.id).toMatch(/^vi:[0-9a-f]{16}$/);
  });

  it("recovers direct record identities so distinct governance findings do not share an empty subject set", () => {
    const findingsDir = fixture("b3a-record-findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(join(findingsDir, "findings.jsonl"), `${JSON.stringify(recordShapedFinding())}\n`);

    const { code } = runCompare({
      env: { REVOY2_VI_GRAPH_DIR: fixture("b3a-record-graph"), REVOY2_VI_OBSERVED_DIR: missingObservedDir(), REVOY2_VI_FINDINGS_DIR: findingsDir },
    });
    expect(code).toBe(0);

    const finding = JSON.parse(readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim());
    expect(finding.affected_nodes).toEqual(["rec:revoy2:ADR-009", "rec:revoy2:ADR-013"]);
    expect(finding.id).toMatch(/^vi:[0-9a-f]{16}$/);
    expect(finding.id).not.toBe("VI-0003");
  });

  it("does NOT touch a finding whose affected_nodes is already populated", () => {
    const findingsDir = fixture("b3a-noop");
    mkdirSync(findingsDir, { recursive: true });
    const normal = computeShapedFinding({ affected_nodes: ["file:already-here.ts"] });
    writeFileSync(join(findingsDir, "findings.jsonl"), `${JSON.stringify(normal)}\n`);

    runCompare({ env: { REVOY2_VI_GRAPH_DIR: fixture("g"), REVOY2_VI_OBSERVED_DIR: missingObservedDir(), REVOY2_VI_FINDINGS_DIR: findingsDir } });
    const f = JSON.parse(readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim());
    expect(f.affected_nodes).toEqual(["file:already-here.ts"]);
    expect(f.observed_model).not.toContain("recovered from");
  });

  it("is idempotent — a second run does not re-append the recovery notice or re-churn the id", () => {
    const findingsDir = fixture("b3a-idempotent");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(join(findingsDir, "findings.jsonl"), `${JSON.stringify(computeShapedFinding())}\n`);
    const env = { REVOY2_VI_GRAPH_DIR: fixture("g2"), REVOY2_VI_OBSERVED_DIR: missingObservedDir(), REVOY2_VI_FINDINGS_DIR: findingsDir };

    runCompare({ env });
    const first = JSON.parse(readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim());
    runCompare({ env });
    const second = JSON.parse(readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim());

    expect(second.id).toBe(first.id);
    expect(second.observed_model).toBe(first.observed_model);
  });

  it("leaves this script's OWNED categories (hollow_candidate etc.) alone even if shaped the same way", () => {
    const findingsDir = fixture("b3a-owned-untouched");
    mkdirSync(findingsDir, { recursive: true });
    const owned = computeShapedFinding({ category: "hollow_candidate", id: "vi:preexisting0000" });
    writeFileSync(join(findingsDir, "findings.jsonl"), `${JSON.stringify(owned)}\n`);

    runCompare({ env: { REVOY2_VI_GRAPH_DIR: fixture("g3"), REVOY2_VI_OBSERVED_DIR: missingObservedDir(), REVOY2_VI_FINDINGS_DIR: findingsDir } });
    const f = JSON.parse(readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim());
    expect(f.affected_nodes).toEqual([]); // untouched — B3 repair is vendor-scoped only
    expect(f.id).toBe("vi:preexisting0000");
  });
});

describe("vi-observed-compare.mjs — B3b: annotate silent truncation", () => {
  it("appends a truncation notice when affected_nodes is shorter than the stated record count", () => {
    const findingsDir = fixture("b3b-findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(join(findingsDir, "findings.jsonl"), `${JSON.stringify(truncatedFinding())}\n`);

    runCompare({
      env: { REVOY2_VI_GRAPH_DIR: fixture("b3b-graph"), REVOY2_VI_OBSERVED_DIR: missingObservedDir(), REVOY2_VI_FINDINGS_DIR: findingsDir },
    });
    const f = JSON.parse(readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim());
    expect(f.observed_model).toContain("first 5 of 9 node(s) listed");
    expect(f.observed_model).toContain("4 not represented");
  });

  it("does NOT annotate when affected_nodes already covers the full stated count", () => {
    const findingsDir = fixture("b3b-noop");
    mkdirSync(findingsDir, { recursive: true });
    const complete = truncatedFinding({
      title: "unreachable-production: 5 record(s)",
      observed_model: "5 record(s) match.",
    });
    writeFileSync(join(findingsDir, "findings.jsonl"), `${JSON.stringify(complete)}\n`);

    runCompare({ env: { REVOY2_VI_GRAPH_DIR: fixture("g4"), REVOY2_VI_OBSERVED_DIR: missingObservedDir(), REVOY2_VI_FINDINGS_DIR: findingsDir } });
    const f = JSON.parse(readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim());
    expect(f.observed_model).not.toContain("listed");
  });

  it("is idempotent — a second run does not double-append the notice", () => {
    const findingsDir = fixture("b3b-idempotent");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(join(findingsDir, "findings.jsonl"), `${JSON.stringify(truncatedFinding())}\n`);
    const env = { REVOY2_VI_GRAPH_DIR: fixture("g5"), REVOY2_VI_OBSERVED_DIR: missingObservedDir(), REVOY2_VI_FINDINGS_DIR: findingsDir };

    runCompare({ env });
    const first = JSON.parse(readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim());
    runCompare({ env });
    const second = JSON.parse(readFileSync(join(findingsDir, "findings.jsonl"), "utf8").trim());

    expect(second.observed_model).toBe(first.observed_model);
    expect((second.observed_model.match(/node\(s\) listed/g) ?? []).length).toBe(1);
  });
});
