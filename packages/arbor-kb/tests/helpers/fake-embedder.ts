// Test double for `EmbeddingPort` (ADR-112). NOT the real vendored model —
// production wiring is `loadVendoredEmbeddingPort()` in
// packages/arbor-kb/src/retrieval.ts, which reads a locally-vendored,
// version-pinned asset this repository has not checked in yet. This double
// exists so ranking logic can be exercised deterministically without
// downloading or loading any real model, per the test-boundary rule for
// genuinely external/unshippable seams.
//
// It is a real (if intentionally small) deterministic embedding technique
// — character-trigram feature hashing, L2-normalized — not a canned
// lookup table of expected answers: given the same text it always produces
// the same vector, and short strings that share character trigrams (lexical
// overlap, not meaning) score higher than unrelated ones, which is what lets
// the lexical-topk ablation arm demonstrate a real recall difference against
// the exact-tag arm.
import type { EmbeddingPort } from "../../src/retrieval.js";

const DIMS = 32;

function hashTrigram(trigram: string): number {
  let h = 2166136261;
  for (let i = 0; i < trigram.length; i++) {
    h ^= trigram.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function embed(text: string): number[] {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const vector = new Array<number>(DIMS).fill(0);
  if (normalized.length === 0) return vector;
  const padded = `  ${normalized}  `;
  for (let i = 0; i < padded.length - 2; i++) {
    const trigram = padded.slice(i, i + 3);
    const bucket = hashTrigram(trigram) % DIMS;
    vector[bucket] += 1;
  }
  let sumSq = 0;
  for (const v of vector) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

/** A fresh deterministic test double, distinct from any other model key. */
export function makeFakeEmbeddingPort(model_key = "fake-trigram-embed@test"): EmbeddingPort {
  return Object.freeze({
    model_key,
    dims: DIMS,
    embed,
  });
}
