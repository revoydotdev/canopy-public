// ADR-112: ranked, bounded top-k retrieval in front of inject().
import { describe, it, expect } from "vitest";
import { KnowledgeBase } from "../src/kb.js";
import { SqliteKbStore } from "../src/sqlite.js";
import {
  DEFAULT_KB_INJECT_TOP_K,
  cosineSimilarity,
  loadVendoredEmbeddingPort,
  selectTopK,
} from "../src/retrieval.js";
import { makeFakeEmbeddingPort } from "./helpers/fake-embedder.js";
import type { CapabilityContext, Provenance } from "@arbor/core";

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" };
const criticCap: CapabilityContext = { tier: "critic" };
const specialistCap: CapabilityContext = { tier: "specialist" };

function seed(kb: KnowledgeBase | SqliteKbStore, count: number, tier: "specialist_visible" | "critic_only" = "critic_only") {
  for (let i = 0; i < count; i++) {
    kb.write({
      campaign_id: "camp1",
      type: "failure_mode",
      value: `failure number ${i} about connection timeout`,
      provenance: verifiedProv,
      as_of: `iter:${i}`,
      tier,
      failure_mode: `failure ${i}`,
      root_cause: `cause ${i}`,
      fix_template: `fix ${i}`,
      tags: ["scale"],
    });
  }
}

describe("O4 — inject() enforces a top_k ceiling on the critic path regardless of KB size", () => {
  it("KnowledgeBase: never exceeds the cap even with far more matching entries than the cap", () => {
    const kb = new KnowledgeBase(null); // no embedder -> exercises the bounded fallback path too
    seed(kb, 200);
    const result = kb.inject("investigate this failure", "camp1", criticCap, undefined, 10);
    const lines = result.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.length).toBe(10);
  });

  it("KnowledgeBase: applies the default cap when no topK is passed (matches existing call sites)", () => {
    const kb = new KnowledgeBase(null);
    seed(kb, 200);
    const result = kb.inject("investigate this failure", "camp1", criticCap);
    const lines = result.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines.length).toBe(DEFAULT_KB_INJECT_TOP_K);
  });

  it("SqliteKbStore: never exceeds the cap either, mirroring KnowledgeBase (backend parity)", () => {
    const store = new SqliteKbStore(":memory:", null);
    seed(store, 200);
    const result = store.inject("investigate this failure", "camp1", criticCap, undefined, 10);
    const lines = result.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines.length).toBe(10);
  });
});

describe("O4 — inject() enforces a top_k ceiling on the specialist path too", () => {
  it("caps specialist-visible failure_mode entries at topK", () => {
    const kb = new KnowledgeBase(null);
    seed(kb, 50, "specialist_visible");
    const result = kb.inject("investigate this failure", "camp1", specialistCap, undefined, 5);
    const lines = result.split("\n").filter((l) => l.startsWith("- Prior failure"));
    expect(lines.length).toBe(5);
  });
});

describe("Decision 4 — fallback to exact-tag/recency when the embedding model is unavailable", () => {
  it("degrades to bounded recency truncation, never an unranked unbounded dump, and never throws", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `kb_${i}`,
      campaign_id: "camp1",
      type: "failure_mode" as const,
      value: `v${i}`,
      provenance: verifiedProv,
      as_of: "iter:1",
      tier: "specialist_visible" as const,
      created_at: new Date(2026, 0, i + 1).toISOString(),
      tags: [],
    }));
    const selection = selectTopK(entries, "anything", { top_k: 2, embedder: null });
    expect(selection.mode).toBe("fallback_exact_tag");
    expect(selection.degraded_reason).not.toBeNull();
    expect(selection.entries).toHaveLength(2);
    // Most recent first (recency truncation, Decision 4).
    expect(selection.entries.map((e) => e.id)).toEqual(["kb_4", "kb_3"]);
  });

  it("loadVendoredEmbeddingPort returns null for a real repo checkout — no vendored asset has been committed yet", () => {
    // Real code path, genuinely exercised: reads the actual arbor-kb package
    // root and finds no vendor/embedding-model/model.json. This is the one
    // execution this tranche gives loadVendoredEmbeddingPort's miss branch;
    // its success branch (an actual model asset present) has never run.
    expect(loadVendoredEmbeddingPort()).toBeNull();
  });
});

describe("Decision 1 — determinism: identical top-k output across repeated runs on the same input", () => {
  it("stable ranking and tie-break for a fixed embedder and fixed entries", () => {
    const embedder = makeFakeEmbeddingPort();
    const entries = Array.from({ length: 30 }, (_, i) => ({
      id: `kb_${i.toString().padStart(2, "0")}`,
      campaign_id: "camp1",
      type: "failure_mode" as const,
      value: i % 3 === 0 ? "connection timeout to the database" : `unrelated note ${i}`,
      provenance: verifiedProv,
      as_of: "iter:1",
      tier: "specialist_visible" as const,
      created_at: new Date(2026, 0, 1).toISOString(),
      tags: [],
    }));

    const run1 = selectTopK(entries, "connection timeout database", { top_k: 5, embedder });
    const run2 = selectTopK(entries, "connection timeout database", { top_k: 5, embedder });
    expect(run1.entries.map((e) => e.id)).toEqual(run2.entries.map((e) => e.id));
    expect(run1.mode).toBe("lexical_trigram");
  });

  it("cosineSimilarity is exact and symmetric", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("ranks lexically overlapping entries above unrelated ones even without a shared exact tag", () => {
    const embedder = makeFakeEmbeddingPort();
    const entries = [
      { id: "kb_a", campaign_id: "c", type: "failure_mode" as const, value: "connection refused by remote host", provenance: verifiedProv, as_of: "iter:1", tier: "specialist_visible" as const, created_at: "2026-01-01T00:00:00.000Z", tags: [] },
      { id: "kb_b", campaign_id: "c", type: "failure_mode" as const, value: "unrelated formatting nitpick in docs", provenance: verifiedProv, as_of: "iter:1", tier: "specialist_visible" as const, created_at: "2026-01-01T00:00:00.000Z", tags: [] },
    ];
    const selection = selectTopK(entries, "connection refused host", { top_k: 1, embedder });
    expect(selection.entries.map((e) => e.id)).toEqual(["kb_a"]);
  });

  it("O5 (ADR-138) — the reported mode is the lexical value, never a semantic claim, for the trigram-ranked path", () => {
    // Pins the exact string so a future change that silently reintroduces a
    // "semantic" mode value (e.g. by shipping the vendored trigram table
    // under the old name) is caught here rather than discovered by an
    // operator trusting a false claim.
    const embedder = makeFakeEmbeddingPort();
    const entries = [
      { id: "kb_a", campaign_id: "c", type: "failure_mode" as const, value: "connection refused by remote host", provenance: verifiedProv, as_of: "iter:1", tier: "specialist_visible" as const, created_at: "2026-01-01T00:00:00.000Z", tags: [] },
    ];
    const selection = selectTopK(entries, "connection refused host", { top_k: 1, embedder });
    expect(selection.mode).toBe("lexical_trigram");
    expect(selection.mode).not.toBe("semantic");
  });
});
