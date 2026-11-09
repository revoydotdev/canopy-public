/**
 * ADR-112: `loadVendoredEmbeddingPort` is the real, locally-vendored embedder
 * seam. No model asset is checked into this repository yet, so the production
 * default path only ever takes its miss branch — which left the parse,
 * validation, and trigram-embedding logic entirely unexercised.
 *
 * These tests drive that logic through the loader's own `baseDir` parameter
 * against an asset written to a scratch directory. That is the real function
 * reading a real file off disk, not a double: only the asset's location is
 * substituted. What it does NOT prove is that any particular published model
 * drop is correct, or that a real model's weights produce useful rankings —
 * only that a well-formed asset loads and embeds deterministically, and that
 * every malformed shape is refused rather than half-accepted.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VENDORED_LEXICAL_MODEL, loadVendoredEmbeddingPort } from "../src/retrieval.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scratchWithAsset(body: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-kb-vendor-"));
  dirs.push(root);
  const assetPath = join(root, VENDORED_LEXICAL_MODEL.vendor_relative_path);
  mkdirSync(dirname(assetPath), { recursive: true });
  writeFileSync(assetPath, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return root;
}

/** A minimal but genuinely-shaped asset: real trigrams, real per-dimension weights. */
function validAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const dims = VENDORED_LEXICAL_MODEL.dims;
  const weight = (seed: number) => Array.from({ length: dims }, (_, d) => ((seed * 7 + d * 13) % 11) / 11);
  return {
    model_id: VENDORED_LEXICAL_MODEL.model_id,
    version: VENDORED_LEXICAL_MODEL.version,
    dims,
    trigram_weights: { " ca": weight(1), "cam": weight(2), "amp": weight(3), " re": weight(4), "ret": weight(5) },
    ...overrides,
  };
}

describe("loadVendoredEmbeddingPort — the real vendored-asset path", () => {
  it("loads a well-formed asset and reports the pinned model identity", () => {
    const port = loadVendoredEmbeddingPort(scratchWithAsset(validAsset()));
    expect(port).not.toBeNull();
    expect(port!.model_key).toBe(`${VENDORED_LEXICAL_MODEL.model_id}@${VENDORED_LEXICAL_MODEL.version}`);
    expect(port!.dims).toBe(VENDORED_LEXICAL_MODEL.dims);
  });

  it("embeds deterministically and L2-normalizes, so repeated ranking cannot drift", () => {
    const port = loadVendoredEmbeddingPort(scratchWithAsset(validAsset()))!;
    const a = port.embed("campaign retrieval");
    const b = port.embed("campaign retrieval");
    expect(a).toEqual(b);
    expect(a).toHaveLength(VENDORED_LEXICAL_MODEL.dims);
    const norm = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("treats whitespace as insignificant but distinguishes different text", () => {
    const port = loadVendoredEmbeddingPort(scratchWithAsset(validAsset()))!;
    expect(port.embed("  campaign   retrieval ")).toEqual(port.embed("campaign retrieval"));
    expect(port.embed("campaign")).not.toEqual(port.embed("retrieval"));
  });

  it("returns an all-zero vector for empty text rather than dividing by a zero norm", () => {
    const port = loadVendoredEmbeddingPort(scratchWithAsset(validAsset()))!;
    expect(port.embed("   ")).toEqual(new Array(VENDORED_LEXICAL_MODEL.dims).fill(0));
  });

  it("ignores trigrams the asset has no weight for instead of throwing", () => {
    const port = loadVendoredEmbeddingPort(scratchWithAsset(validAsset()))!;
    expect(() => port.embed("zzzzzz qqqqqq")).not.toThrow();
    expect(port.embed("zzzzzz qqqqqq")).toEqual(new Array(VENDORED_LEXICAL_MODEL.dims).fill(0));
  });

  it("refuses every malformed shape by returning null, never a half-built port", () => {
    expect(loadVendoredEmbeddingPort(mkdtempSync(join(tmpdir(), "arbor-kb-empty-")))).toBeNull();
    expect(loadVendoredEmbeddingPort(scratchWithAsset("{not json"))).toBeNull();
    expect(loadVendoredEmbeddingPort(scratchWithAsset(null))).toBeNull();
    expect(loadVendoredEmbeddingPort(scratchWithAsset(["not", "an", "object"]))).toBeNull();
    expect(loadVendoredEmbeddingPort(scratchWithAsset(validAsset({ model_id: "someone-elses-model" })))).toBeNull();
    expect(loadVendoredEmbeddingPort(scratchWithAsset(validAsset({ version: "v2" })))).toBeNull();
    expect(loadVendoredEmbeddingPort(scratchWithAsset(validAsset({ dims: 32 })))).toBeNull();
    expect(loadVendoredEmbeddingPort(scratchWithAsset(validAsset({ trigram_weights: null })))).toBeNull();
    expect(loadVendoredEmbeddingPort(scratchWithAsset(validAsset({ trigram_weights: "nope" })))).toBeNull();
  });
});
