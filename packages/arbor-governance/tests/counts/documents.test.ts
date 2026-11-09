import { describe, expect, it } from "vitest";
import {
  deriveCountDriftDocuments,
  HISTORICAL_LEDGER_PREFIXES,
} from "../../src/counts/documents.js";

const REPO_ROOT = process.cwd();

describe("deriveCountDriftDocuments", () => {
  const documents = deriveCountDriftDocuments(REPO_ROOT);

  it("is deterministic — two calls against the same checkout are deep-equal and sorted", () => {
    expect(deriveCountDriftDocuments(REPO_ROOT)).toEqual(documents);
    expect([...documents].sort()).toEqual(documents);
  });

  it("contains no duplicates", () => {
    expect(new Set(documents).size).toBe(documents.length);
  });

  it("includes the live documentation that carried real drift", () => {
    for (const doc of [
      "README.md",
      "AGENTS.md",
      "ROADMAP.md",
      "handoff.md",
      "docs/release-readiness.md",
      "docs/operator-guide.md",
    ]) {
      expect(documents).toContain(doc);
    }
  });

  it("includes source files, because a claim in a code comment drifts too", () => {
    expect(documents).toContain("packages/arbor-mcp/src/tools.ts");
    expect(documents.some((d) => d.startsWith("packages/") && d.endsWith(".ts"))).toBe(true);
  });

  it("includes the decisions corpus", () => {
    expect(documents.some((d) => d.startsWith("decisions/ADR-"))).toBe(true);
  });

  it("excludes test fixtures — a deliberately-wrong fixture is an input, not a claim", () => {
    expect(documents.some((d) => d.includes("/tests/"))).toBe(false);
    expect(documents).not.toContain(
      "packages/arbor-governance/tests/counts/fixtures/drifted-claims.md",
    );
  });

  it("excludes every dated ledger prefix — their numbers are evidence, not claims", () => {
    for (const doc of documents) {
      for (const prefix of HISTORICAL_LEDGER_PREFIXES) {
        expect(doc.startsWith(prefix)).toBe(false);
      }
    }
    expect(documents.some((d) => d.startsWith("audit/"))).toBe(false);
  });

  it("excludes generated and vendored trees", () => {
    for (const doc of documents) {
      expect(doc).not.toContain("node_modules/");
      expect(doc).not.toContain("/dist/");
      expect(doc.endsWith(".d.ts")).toBe(false);
    }
  });

  it("scans only .md and .ts", () => {
    for (const doc of documents) {
      expect(doc.endsWith(".md") || doc.endsWith(".ts")).toBe(true);
    }
  });

  it("returns paths relative to the repo root, POSIX-separated", () => {
    for (const doc of documents) {
      expect(doc.startsWith("/")).toBe(false);
      expect(doc).not.toContain("\\");
    }
  });

  it("returns an empty set for a directory with nothing to scan, rather than throwing", () => {
    expect(deriveCountDriftDocuments("/nonexistent-path-for-this-test")).toEqual([]);
  });
});
