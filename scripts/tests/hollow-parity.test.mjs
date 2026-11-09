import { describe, expect, it } from "vitest";
import { parseRuntimeCatalog, loadRuntimeCatalog, parseLivenessProbedQueryKinds, loadTuiDispositionSurfaceKinds, findLiteralKindReferences } from "../lib/hollow-parity/catalog.mjs";
import { computeCatalogSurfaces, mcpGenericOnlyKinds, evaluateApiOnlyAllowlist } from "../lib/hollow-parity/surfaces.mjs";
import { listUncoveredBranchFunctions, rankReachableUncoveredBranchFunctions, buildReachableIndex } from "../lib/hollow-parity/branch-coverage.mjs";
import { loadJsonlRows, buildScenarioRunClassIndex, productSurfaceValidationFindings, realSurfaceScenarioFindings } from "../lib/hollow-parity/outcomes.mjs";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE_SCRIPT = join(REPO_ROOT, "scripts", "hollow-parity.mjs");

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "hollow-parity-test-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("catalog.mjs: parseRuntimeCatalog", () => {
  it("[fixture] extracts kind/direction/supported from one-line entries and ignores malformed ones", () => {
    // Wrapped in a real `RUNTIME_CATALOG` declaration because the shared parser
    // is structural: it walks the declared array literal, so a bare fragment of
    // object literals (which the old line-scanning regex happened to accept) is
    // not a catalog source. The intent under test -- extract the three fields,
    // ignore comments and non-entries -- is unchanged.
    const source = [
      "export const RUNTIME_CATALOG = [",
      '  { kind: "a.b", direction: "command", capability: "x", idempotency: "required", supported: true },',
      '  { kind: "c.d", direction: "query", capability: "y", idempotency: "not_applicable", supported: false },',
      "  // not an entry",
      "  const notAnEntry = 1;",
      "] as const;",
    ].join("\n");
    expect(parseRuntimeCatalog(source)).toEqual([
      { kind: "a.b", direction: "command", supported: true, line: 2 },
      { kind: "c.d", direction: "query", supported: false, line: 3 },
    ]);
  });

  it("parses the real RUNTIME_CATALOG with at least 150 supported entries", () => {
    // `loadRuntimeCatalog`, not the pure `parseRuntimeCatalog`: the manifest
    // moved to `@arbor/core` and `arbor-mcp/src/runtime-catalog.ts` is now a
    // re-export alias, so parsing only that file finds no array literal. This
    // is the same blindness that had both catalog gates reporting 0 supported
    // entries, which is indistinguishable from "no drift" to a scanner.
    const entries = loadRuntimeCatalog(join(REPO_ROOT, "packages/arbor-mcp/src/runtime-catalog.ts"), REPO_ROOT);
    expect(entries.length).toBeGreaterThan(150);
    expect(entries.filter((e) => e.supported).length).toBeGreaterThan(140);
  });
});

describe("catalog.mjs: parseLivenessProbedQueryKinds", () => {
  it("[fixture] extracts only keys inside probePayloads(), not elsewhere in the file", () => {
    const source = [
      "const other = { \"decoy.kind\": {} };",
      "export function probePayloads(ctx) {",
      "  return {",
      '    "campaign.list": { limit: 10 },',
      '    "campaign.snapshot": { campaign_id },',
      "  };",
      "}",
    ].join("\n");
    expect(parseLivenessProbedQueryKinds(source)).toEqual(new Set(["campaign.list", "campaign.snapshot"]));
  });

  it("parses the real liveness.ts with a real, non-trivial set of probed query kinds", () => {
    const source = readFileSync(join(REPO_ROOT, "packages/arbor-mcp/src/liveness.ts"), "utf8");
    const kinds = parseLivenessProbedQueryKinds(source);
    expect(kinds.size).toBeGreaterThan(50);
    expect(kinds.has("campaign.list")).toBe(true);
  });
});

describe("catalog.mjs: loadTuiDispositionSurfaceKinds", () => {
  it("[fixture] counts only live_query/live_control, not authoring_required/detail_required/excluded", () => {
    const path = tmpFile("dispositions.json", JSON.stringify({
      entries: [
        { kind: "a.live_query", operator_visible: true, disposition: "live_query" },
        { kind: "b.live_control", operator_visible: true, disposition: "live_control" },
        { kind: "c.authoring", operator_visible: true, disposition: "authoring_required", reason: "needs a form" },
        { kind: "d.detail", operator_visible: true, disposition: "detail_required", reason: "needs a detail pane" },
        { kind: "e.excluded", operator_visible: false, disposition: "excluded", reason: "not surfaced" },
      ],
    }));
    expect(loadTuiDispositionSurfaceKinds(path)).toEqual(new Set(["a.live_query", "b.live_control"]));
  });

  it("loads the real dispositions.json with a real, non-trivial live surface set", () => {
    const kinds = loadTuiDispositionSurfaceKinds(join(REPO_ROOT, "scripts/tui-catalog-parity/dispositions.json"));
    expect(kinds.size).toBeGreaterThan(50);
    expect(kinds.has("tree.branch")).toBe(true); // a known live_control (branch node, 'b' key)
  });
});

describe("catalog.mjs: findLiteralKindReferences", () => {
  it("[fixture] finds a quoted literal and does not false-positive on a non-matching kind", () => {
    const source = "runtimeCommand('remote.control', {}); // scheduler.control not quoted here: schedulercontrol";
    expect(findLiteralKindReferences(source, ["remote.control", "scheduler.control", "ghost.kind"])).toEqual(new Set(["remote.control"]));
  });
});

describe("surfaces.mjs: computeCatalogSurfaces + mcpGenericOnlyKinds", () => {
  const catalog = [
    { kind: "wired.everywhere", direction: "command", supported: true },
    { kind: "mcp.only", direction: "command", supported: true },
    { kind: "unsupported.mcp.only", direction: "command", supported: false },
    { kind: "liveness.only", direction: "query", supported: true },
  ];
  const surfaceInput = {
    catalog,
    cliSource: `dispatch("wired.everywhere")`,
    webuiSource: `runtimeCommand('wired.everywhere', {})`,
    tuiKinds: new Set(["wired.everywhere"]),
    livenessProbedQueryKinds: new Set(["liveness.only"]),
  };

  it("[fixture] a kind wired.everywhere is not MCP-generic-only; mcp.only and liveness.only differ correctly", () => {
    const surfaces = computeCatalogSurfaces(surfaceInput);
    expect(surfaces["wired.everywhere"]).toEqual({ cli: true, tui: true, web: true, liveness: false, mcp_generic: true });
    expect(surfaces["mcp.only"]).toEqual({ cli: false, tui: false, web: false, liveness: false, mcp_generic: true });
    expect(surfaces["liveness.only"]).toEqual({ cli: false, tui: false, web: false, liveness: true, mcp_generic: true });
  });

  it("[fixture] mcpGenericOnlyKinds flags only supported, surfaceless kinds", () => {
    const surfaces = computeCatalogSurfaces(surfaceInput);
    // unsupported.mcp.only is excluded (supported: false); liveness.only has a liveness surface.
    expect(mcpGenericOnlyKinds(catalog, surfaces)).toEqual(["mcp.only"]);
  });

  it("[fixture] a command direction never gets a liveness surface even if probed keys happen to collide", () => {
    const input = { ...surfaceInput, livenessProbedQueryKinds: new Set(["mcp.only"]) };
    const surfaces = computeCatalogSurfaces({ ...input, catalog: [{ kind: "mcp.only", direction: "command", supported: true }] });
    expect(surfaces["mcp.only"].liveness).toBe(false); // liveness never probes commands (includeMutating defaults false)
  });
});

describe("surfaces.mjs: evaluateApiOnlyAllowlist", () => {
  it("[fixture] separates findings from allowlisted, and reports stale allowlist entries", () => {
    const result = evaluateApiOnlyAllowlist(
      ["orphan.kind", "documented.kind"],
      { entries: [{ kind: "documented.kind", reason: "reviewed and accepted" }, { kind: "no-longer-mcp-only.kind", reason: "..." }] },
    );
    expect(result.findings).toEqual(["orphan.kind"]);
    expect(result.allowlisted).toEqual([{ kind: "documented.kind", reason: "reviewed and accepted" }]);
    expect(result.staleAllowlistEntries).toEqual(["no-longer-mcp-only.kind"]);
  });

  it("[fixture] an allowlist entry with an empty reason does not suppress the finding", () => {
    const result = evaluateApiOnlyAllowlist(["orphan.kind"], { entries: [{ kind: "orphan.kind", reason: "   " }] });
    expect(result.findings).toEqual(["orphan.kind"]);
  });
});

describe("branch-coverage.mjs: listUncoveredBranchFunctions / rankReachableUncoveredBranchFunctions", () => {
  /**
   * Worked example: WA-12 (audit/2026-08-23-50-defects.md) — `deriveTerminalOutcome`'s
   * switch had no `cancelled` arm. Modeled as a synthetic coverage-final.json
   * fixture (istanbul/v8 shape): a function with a 3-branch switch where the
   * "cancelled" branch alternative has a hit count of 0.
   */
  function deriveTerminalOutcomeFixture(cancelledHitCount) {
    return {
      "packages/arbor-mcp/src/loop.ts": {
        fnMap: { "0": { name: "deriveTerminalOutcome", decl: { start: { line: 10 } }, loc: { start: { line: 10 }, end: { line: 20 } } } },
        f: { "0": 5 }, // the function itself is reached
        branchMap: {
          "0": { type: "switch", loc: { start: { line: 11 } }, locations: [{ start: { line: 12 } }, { start: { line: 13 } }, { start: { line: 14 } }] },
        },
        b: { "0": [3, 2, cancelledHitCount] }, // [completed, failed, cancelled]
      },
    };
  }

  it("[fixture] flags deriveTerminalOutcome's switch when the cancelled branch has zero hits", () => {
    const coverage = deriveTerminalOutcomeFixture(0);
    const candidates = listUncoveredBranchFunctions(coverage, () => true);
    expect(candidates).toEqual([{ file: "packages/arbor-mcp/src/loop.ts", function: "deriveTerminalOutcome", line: 10, uncoveredBranches: 1, totalBranches: 3 }]);
  });

  it("[fixture] does not flag deriveTerminalOutcome once every branch alternative (including cancelled) is hit", () => {
    const coverage = deriveTerminalOutcomeFixture(1);
    expect(listUncoveredBranchFunctions(coverage, () => true)).toEqual([]);
  });

  it("[fixture] excludes files the production-source predicate rejects", () => {
    const coverage = deriveTerminalOutcomeFixture(0);
    expect(listUncoveredBranchFunctions(coverage, () => false)).toEqual([]);
  });

  it("[fixture] excludes an anonymous function (no reachability identity to rank against) and an unreached function", () => {
    const coverage = {
      "packages/x/src/y.ts": {
        fnMap: {
          "0": { name: "", decl: { start: { line: 1 } }, loc: { start: { line: 1 }, end: { line: 5 } } },
          "1": { name: "unreachedNamed", decl: { start: { line: 6 } }, loc: { start: { line: 6 }, end: { line: 10 } } },
        },
        f: { "0": 4, "1": 0 },
        branchMap: {
          "0": { type: "if", loc: { start: { line: 2 } } },
          "1": { type: "if", loc: { start: { line: 7 } } },
        },
        b: { "0": [1, 0], "1": [0, 0] },
      },
    };
    expect(listUncoveredBranchFunctions(coverage, () => true)).toEqual([]);
  });

  it("[fixture] rankReachableUncoveredBranchFunctions keeps only reachability-proven functions, sorts descending, and caps at limit", () => {
    const candidates = [
      { file: "a.ts", function: "low", line: 1, uncoveredBranches: 1, totalBranches: 2 },
      { file: "b.ts", function: "high", line: 1, uncoveredBranches: 5, totalBranches: 6 },
      { file: "c.ts", function: "notReachable", line: 1, uncoveredBranches: 9, totalBranches: 9 },
    ];
    const reachableIndex = new Set(["a.ts::low", "b.ts::high"]);
    expect(rankReachableUncoveredBranchFunctions(candidates, reachableIndex, 1)).toEqual([
      { file: "b.ts", function: "high", line: 1, uncoveredBranches: 5, totalBranches: 6 },
    ]);
  });

  it("[fixture] buildReachableIndex only indexes reachable:true checklist rows", () => {
    const index = buildReachableIndex([
      { name: "reached", file: "a.ts", reachable: true },
      { name: "unreached", file: "a.ts", reachable: false },
    ]);
    expect(index.has("a.ts::reached")).toBe(true);
    expect(index.has("a.ts::unreached")).toBe(false);
  });
});

describe("outcomes.mjs: loadJsonlRows / buildScenarioRunClassIndex", () => {
  it("[fixture] a missing path is zero rows, not an error", () => {
    expect(loadJsonlRows(join(mkdtempSync(join(tmpdir(), "hollow-parity-test-")), "nope.jsonl"))).toEqual([]);
  });

  it("[fixture] parses real JSONL rows and skips blank lines", () => {
    const path = tmpFile("outcomes.jsonl", '{"a":1}\n\n{"a":2}\n');
    expect(loadJsonlRows(path)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("[fixture] indexes scenario.id -> scenario.run_class from a catalog document", () => {
    const index = buildScenarioRunClassIndex({ scenarios: [{ id: "a", run_class: "cli" }, { id: "b", run_class: "production" }] });
    expect(index.get("a")).toBe("cli");
    expect(index.get("b")).toBe("production");
    expect(index.has("ghost")).toBe(false);
  });
});

describe("outcomes.mjs: productSurfaceValidationFindings (item 2)", () => {
  it("[fixture] flags a validation outcome from a tui/web/cli scenario, and nothing else", () => {
    const outcomeRows = [
      { scenario: "a", kind: "k1", direction: "query", code: "validation", summary: "s1" }, // cli — flagged
      { scenario: "b", kind: "k2", direction: "command", code: "permission", summary: "s2" }, // cli, but not validation — not flagged
      { scenario: "c", kind: "k3", direction: "query", code: "validation", summary: "s3" }, // production — not a product surface, not flagged
      { scenario: "d", kind: "k4", direction: "command", code: "validation", summary: "s4" }, // web — flagged
    ];
    const scenarioRunClasses = new Map([["a", "cli"], ["b", "cli"], ["c", "production"], ["d", "web"]]);
    expect(productSurfaceValidationFindings(outcomeRows, scenarioRunClasses)).toEqual([
      { scenario: "a", kind: "k1", code: "validation", summary: "s1" },
      { scenario: "d", kind: "k4", code: "validation", summary: "s4" },
    ]);
  });

  it("[fixture] an unknown scenario (not in the run-class index) is never flagged", () => {
    const outcomeRows = [{ scenario: "ghost", kind: "k", direction: "query", code: "validation", summary: "s" }];
    expect(productSurfaceValidationFindings(outcomeRows, new Map())).toEqual([]);
  });
});

describe("outcomes.mjs: realSurfaceScenarioFindings (item 4)", () => {
  const scenarioIds = { tui: "tui-id", cli: "cli-id", web: "web-id" };

  it("[fixture] passes (empty findings) when every scenario has observations and the CLI scenario recorded exactly a permission outcome", () => {
    const observationRows = [
      { symbol_id: "s1", scenario_id: "tui-id" },
      { symbol_id: "s2", scenario_id: "cli-id" },
      { symbol_id: "s3", scenario_id: "web-id" },
    ];
    const outcomeRows = [{ scenario: "cli-id", kind: "k", direction: "command", code: "permission", summary: "denied" }];
    expect(realSurfaceScenarioFindings(observationRows, outcomeRows, scenarioIds)).toEqual([]);
  });

  it("[fixture] flags a scenario with zero observations", () => {
    const observationRows = [{ symbol_id: "s1", scenario_id: "tui-id" }, { symbol_id: "s2", scenario_id: "cli-id" }];
    const outcomeRows = [{ scenario: "cli-id", kind: "k", direction: "command", code: "permission", summary: "denied" }];
    const findings = realSurfaceScenarioFindings(observationRows, outcomeRows, scenarioIds);
    expect(findings.some((f) => f.includes("web-id") && f.includes("zero observations"))).toBe(true);
  });

  it("[fixture] flags a missing permission outcome for the CLI scenario", () => {
    const observationRows = [
      { symbol_id: "s1", scenario_id: "tui-id" }, { symbol_id: "s2", scenario_id: "cli-id" }, { symbol_id: "s3", scenario_id: "web-id" },
    ];
    const findings = realSurfaceScenarioFindings(observationRows, [], scenarioIds);
    expect(findings.some((f) => f.includes("did not record a 'permission' outcome"))).toBe(true);
  });

  it("[fixture] flags a validation outcome on the CLI scenario as a wrong-shape finding, even alongside a real permission outcome", () => {
    const observationRows = [
      { symbol_id: "s1", scenario_id: "tui-id" }, { symbol_id: "s2", scenario_id: "cli-id" }, { symbol_id: "s3", scenario_id: "web-id" },
    ];
    const outcomeRows = [
      { scenario: "cli-id", kind: "k", direction: "command", code: "permission", summary: "denied" },
      { scenario: "cli-id", kind: "other", direction: "query", code: "validation", summary: "malformed" },
    ];
    const findings = realSurfaceScenarioFindings(observationRows, outcomeRows, scenarioIds);
    expect(findings.some((f) => f.includes("recorded a 'validation' outcome"))).toBe(true);
  });
});

describe("hollow-parity gate authority boundaries", () => {
  it("derives the projection in memory and reports absent branch evidence as unavailable", () => {
    const projection = join(REPO_ROOT, "scripts", "hollow-parity", "catalog-surfaces.json");
    const absentCoverage = join(mkdtempSync(join(tmpdir(), "hollow-parity-no-coverage-")), "coverage-final.json");
    const before = readFileSync(projection, "utf8");
    const result = spawnSync("bun", [GATE_SCRIPT, "--json", "--skip-vitest"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, REVOY2_HOLLOW_COVERAGE_PATH: absentCoverage },
      maxBuffer: 64 * 1024 * 1024,
    });
    const report = JSON.parse(result.stdout);
    expect(readFileSync(projection, "utf8")).toBe(before);
    expect(report.catalog_surfaces_projection).toMatchObject({ ok: true, status: "current" });
    expect(report.item5_branch_coverage_report).toMatchObject({ status: "unavailable" });
    expect(report.blockers.join("\n")).toMatch(/branch evidence is unavailable/);
    expect(result.status).not.toBe(0);
  }, 60_000);
});
