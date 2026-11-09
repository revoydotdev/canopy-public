import { describe, expect, it } from "vitest";
import { buildCatalogCoverageReport } from "../vi-observed-compare.mjs";

/**
 * ADR-090: catalog_gap is demoted from a per-package human-verdict finding to
 * an advisory catalog-coverage signal. This proves the builder produces the
 * advisory shape (a property of the scenario catalog's breadth) and carries no
 * `catalog_gap` finding category — nothing here lands in the vi-findings
 * human-verdict store.
 */
describe("buildCatalogCoverageReport (ADR-090 catalog-gap demotion)", () => {
  const files = new Map([
    ["packages/arbor-mcp/src/a.ts", 3],
    ["packages/arbor-mcp/src/b.ts", 1],
    ["packages/arbor-core/src/c.ts", 2],
  ]);

  it("aggregates uninvoked files per package as an advisory, deterministically", () => {
    const report = buildCatalogCoverageReport(files, { catalogHash: "hash123", graphRevision: "revabc" });

    expect(report.kind).toBe("catalog_coverage_advisory");
    expect(report.schema_version).toBe(1);
    expect(report.catalog_content_hash).toBe("hash123");
    expect(report.graph_revision).toBe("revabc");
    expect(report.package_count).toBe(2);

    // Packages are sorted; arbor-core before arbor-mcp.
    expect(report.packages.map((p) => p.package)).toEqual(["arbor-core", "arbor-mcp"]);

    const mcp = report.packages.find((p) => p.package === "arbor-mcp");
    expect(mcp.uninvoked_file_count).toBe(2);
    expect(mcp.uninvoked_symbol_count).toBe(4);

    // The report is a coverage advisory, never a finding: no `category` field
    // and specifically never the demoted `catalog_gap` category.
    const json = JSON.stringify(report);
    expect(json).not.toContain("catalog_gap");
    expect(json).not.toContain("\"category\"");
  });

  it("produces an empty-but-valid advisory when the catalog drives everything", () => {
    const report = buildCatalogCoverageReport(new Map(), { catalogHash: "h", graphRevision: "r" });
    expect(report.package_count).toBe(0);
    expect(report.packages).toEqual([]);
  });
});
