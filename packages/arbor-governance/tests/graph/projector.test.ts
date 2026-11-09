import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { projectCitationGraph } from "../../src/graph/projector.js";
import { scanDecisionsCorpus } from "../../src/record/corpus.js";
import { classifyCorpusCitations } from "../../src/record/migrate.js";
import type { CitationFact } from "../../src/record/migrate.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DECISIONS_DIR = join(REPO_ROOT, "decisions");
const AT = "2026-08-05T00:00:00.000Z";

function resolvedFact(overrides: Partial<CitationFact> = {}): CitationFact {
  return {
    source_record_id: "revoy2:ADR-001",
    source_path: "decisions/ADR-001-x.md",
    citation_token: "ADR-002",
    cited_number: 2,
    found_in: ["context"],
    method: "derived",
    confidence: "medium",
    target: "revoy2:ADR-002",
    evidence: [{ kind: "code_location", ref: "decisions/ADR-001-x.md#ADR-002", producer: "test", at: AT }],
    reason: "test fixture",
    ...overrides,
  };
}

function unresolvedFact(overrides: Partial<CitationFact> = {}): CitationFact {
  return {
    source_record_id: "revoy2:ADR-001",
    source_path: "decisions/ADR-001-x.md",
    citation_token: "ADR-999",
    cited_number: 999,
    found_in: ["context"],
    method: "none",
    confidence: null,
    target: null,
    evidence: [],
    reason: "not local",
    ...overrides,
  };
}

describe("projectCitationGraph — pure, deterministic edge derivation", () => {
  it("turns a resolved citation fact into a DEPENDS_ON edge on the derived plane", () => {
    const result = projectCitationGraph([resolvedFact()], { at: AT });
    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0];
    expect(edge.source).toBe("revoy2:ADR-001");
    expect(edge.target).toBe("revoy2:ADR-002");
    expect(edge.type).toBe("DEPENDS_ON");
    expect(edge.plane).toBe("derived");
    expect(edge.discovery).toBe("derived");
    expect(edge.confidence).toBe("medium");
    expect(edge.valid_from).toBe(AT);
    expect(edge.valid_to).toBeNull();
    expect(edge.evidence).toHaveLength(1);
    expect(result.source_fact_count).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("drops unresolved citations (method: \"none\") — never guessed into an edge", () => {
    const result = projectCitationGraph([unresolvedFact()], { at: AT });
    expect(result.edges).toHaveLength(0);
    expect(result.source_fact_count).toBe(0);
  });

  it("mixed input: only resolved facts become edges", () => {
    const result = projectCitationGraph([resolvedFact(), unresolvedFact()], { at: AT });
    expect(result.edges).toHaveLength(1);
    expect(result.source_fact_count).toBe(1);
  });

  it("is deterministic and sorted by (source, target, type) via code-unit comparison, never localeCompare", () => {
    const facts = [
      resolvedFact({ source_record_id: "revoy2:ADR-010", target: "revoy2:ADR-002", citation_token: "ADR-002" }),
      resolvedFact({ source_record_id: "revoy2:ADR-001", target: "revoy2:ADR-020", citation_token: "ADR-020" }),
      resolvedFact({ source_record_id: "revoy2:ADR-001", target: "revoy2:ADR-002", citation_token: "ADR-002" }),
    ];
    const first = projectCitationGraph(facts, { at: AT });
    const second = projectCitationGraph([...facts].reverse(), { at: AT });
    expect(JSON.stringify(second.edges)).toBe(JSON.stringify(first.edges));
    expect(first.edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      "revoy2:ADR-001->revoy2:ADR-002",
      "revoy2:ADR-001->revoy2:ADR-020",
      "revoy2:ADR-010->revoy2:ADR-002",
    ]);
  });

  it("first_seen_event is a stable, non-ledger citation identity, not a trace_ ledger id", () => {
    const result = projectCitationGraph([resolvedFact()], { at: AT });
    expect(result.edges[0].first_seen_event).toBe("citation:revoy2:ADR-001#ADR-002");
    expect(result.edges[0].first_seen_event).not.toMatch(/^trace_/);
  });

  it("bounds output via max_edges and reports truncation, never a silent drop", () => {
    const facts = [
      resolvedFact({ target: "revoy2:ADR-002", citation_token: "ADR-002" }),
      resolvedFact({ target: "revoy2:ADR-003", citation_token: "ADR-003" }),
      resolvedFact({ target: "revoy2:ADR-004", citation_token: "ADR-004" }),
    ];
    const result = projectCitationGraph(facts, { at: AT, max_edges: 2 });
    expect(result.edges).toHaveLength(2);
    expect(result.source_fact_count).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("rejects a non-positive max_edges", () => {
    expect(() => projectCitationGraph([], { at: AT, max_edges: 0 })).toThrow(RangeError);
  });
});

describe("projectCitationGraph — wired into scanDecisionsCorpus, the real corpus (decisions/*.md)", () => {
  it("scanDecisionsCorpus surfaces a real, non-fabricated citation_graph consistent with its own citations report", () => {
    const scan = scanDecisionsCorpus(DECISIONS_DIR, { at: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    const resolvedFacts = scan.value.citations.facts.filter((fact) => fact.method !== "none");
    expect(scan.value.citation_graph).toHaveLength(resolvedFacts.length);
    expect(scan.value.citation_graph.length).toBeGreaterThan(0);
    for (const edge of scan.value.citation_graph) {
      expect(edge.type).toBe("DEPENDS_ON");
      expect(edge.plane).toBe("derived");
    }
  });

  it("re-deriving the same graph directly from classifyCorpusCitations matches what scanDecisionsCorpus already computed", () => {
    const scan = scanDecisionsCorpus(DECISIONS_DIR, { at: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    const citations = classifyCorpusCitations(scan.value.results, { at: AT });
    const rebuilt = projectCitationGraph(citations.facts, { at: AT });
    expect(JSON.stringify(rebuilt.edges)).toBe(JSON.stringify(scan.value.citation_graph));
  });
});
